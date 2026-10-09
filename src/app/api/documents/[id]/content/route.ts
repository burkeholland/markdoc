import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName, HttpError, ValidationError } from "@/server/http";
import { readLiveText, mutateLiveDoc, cleanTextOf, readPrecondition, assertContentUnchanged, ifContentHashSchema, MAX_TEXT_CHARS } from "@/server/livedoc";
import { replaceText } from "@/editor/sync/replace-plan";
import { recordAgentActivity } from "@/server/agents";
import { activityActor, recordEdit } from "@/server/activity";
import { TEXT_KEY } from "@/server/collab/hocuspocus";
import { contentHash } from "@/server/export/html";
import { rememberCleanText } from "@/server/agent-events";
import { computeStats } from "@/editor/stats";
import { WriteTurn } from "@/server/large-write";
import {
  createRequiredVersionIntent,
  discardRequiredVersionIntent,
  finalizeRequiredVersionIntent,
  markRequiredVersionApplied,
} from "@/server/required-version";

type Params = { params: Promise<{ id: string }> };

/** Current Markdown of the document (with and without pending suggestions), for agents and scripts. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const live = await readLiveText(id);
  return json({
    content: live.text,
    clean: live.clean,
    title: live.title,
    /**
     * SHA-256 of `clean`; the reader view polls this to detect changes cheaply, and a writer sends it
     * back as `ifContentHash` / `If-Match`. Remembered so a 409 can show what moved since this read.
     */
    contentHash: rememberCleanText(id, live.clean),
    pendingSuggestions: live.pendingSuggestions,
    openComments: live.openComments,
    /** Prose statistics of `clean`: words, characters, sentences, paragraphs, headings, reading/speaking minutes. */
    stats: computeStats(live.clean),
  });
});

const putSchema = z.object({
  content: z.string().max(2_000_000),
  /** Optional version title recorded with the change. */
  message: z.string().trim().max(200).optional(),
  /** `contentHash` from `GET /content`; the write is refused with 409 when the document moved since (also as `If-Match`). */
  ifContentHash: ifContentHashSchema,
});

/**
 * Replace the whole document with new Markdown. The change is applied to the live document as
 * edits that leave unchanged lines and words in place (`replaceText`), so collaborators see it as
 * a normal edit and keep their carets and comments there; the edits are planned in bounded time
 * whatever the two texts are (#2341). With `ifContentHash` (or `If-Match`), the write only lands
 * when the clean text still hashes to that value; otherwise 409 with the current hash and a diff.
 */
export const PUT = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  // Every whole-document replacement takes a turn, regardless of size.
  const write = await WriteTurn.begin(req, user!.id);
  try {
    await write.force();
    const body = await readJson(req, (d) => putSchema.parse(d));
    const expected = readPrecondition(req, body);
    const before = await readLiveText(id);
    const beforeHash = contentHash(before.clean);
    await finalizeRequiredVersionIntent(id, beforeHash);
    const requiresVersion = Boolean(body.message || user!.agent);
    const targetHash = contentHash(body.content);
    let intentId: string | null = null;
    if (requiresVersion) {
      intentId = await createRequiredVersionIntent({
        documentId: id,
        content: body.content,
        contentHash: targetHash,
        kind: body.message ? "named" : "auto",
        title: body.message ?? (user!.agent ? `Edited by ${user!.agent}` : null),
        createdBy: user!.id,
        createdByName: actorName(user),
      });
    }
    let changed = false;
    let chars = 0;
    let at: { from: number; to: number } | undefined;
    let hashAfter = "";
    // A caller that left while its large write waited or was read: nothing is written for it.
    write.assertWanted();
    try {
      await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
        assertContentUnchanged(id, doc, expected);
        const ops = replaceText(doc.getText(TEXT_KEY), body.content);
        if (ops.length) {
          changed = true;
          chars = ops.reduce((n, op) => n + op.deleteCount + (op.insert?.length ?? 0), 0);
          const end = ops[0].index + (ops[0].insert?.length ?? 0);
          at = { from: end, to: end };
        }
        recordAgentActivity(doc, user!, "edited", at);
        hashAfter = contentHash(cleanTextOf(doc));
      });
    } catch (err) {
      if (intentId) await discardRequiredVersionIntent(id, intentId);
      throw err;
    }
    if (changed) void recordEdit(id, activityActor(user!), chars).catch((err) => console.error("[activity] edit failed", err));
    if (intentId && !changed) {
      await discardRequiredVersionIntent(id, intentId);
      intentId = null;
    }
    if (intentId) {
      // A 200 acknowledges both the live text and its audit version. Keep the turn until the version is durable;
      // if it cannot be recorded, fail the request explicitly instead of returning success for an incomplete write.
      try {
        await markRequiredVersionApplied(id, intentId);
        await finalizeRequiredVersionIntent(id, hashAfter);
      } catch (err) {
        if (err instanceof HttpError && err.details?.versionPending === true) throw err;
        throw new HttpError(500, "The content was written, but its required version was not saved", {
          contentApplied: true,
          contentHash: hashAfter,
          versionPending: true,
        });
      }
    }
    return json({ ok: true, changed, contentHash: hashAfter });
  } finally {
    await write.end();
  }
});

const patchSchema = z.object({
  /** Text to append at the end of the document (a blank line is inserted before it when needed). */
  append: z.string().max(500_000),
  /** `contentHash` from `GET /content`; the append is refused with 409 when the document moved since (also as `If-Match`). */
  ifContentHash: ifContentHashSchema,
});

/**
 * Append Markdown to the end of the document. With `ifContentHash` (or `If-Match`) the append only
 * lands when the clean text still hashes to that value — the same 409 as `PUT` otherwise. The text may not
 * grow past `MAX_TEXT_CHARS` this way: `400` with a `too_big` issue, as `PUT` answers a text that is too long.
 */
export const PATCH = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const write = await WriteTurn.begin(req, user!.id);
  try {
    const body = await readJson(req, (d) => patchSchema.parse(d));
    await write.sized(body.append.length);
    const expected = readPrecondition(req, body);
    let hashAfter = "";
    write.assertWanted();
    await mutateLiveDoc(id, { userId: user!.id, docId: id, role: "editor", name: actorName(user) ?? "User", login: user!.login, avatar: user!.image ?? null }, (doc) => {
      assertContentUnchanged(id, doc, expected);
      const ytext = doc.getText(TEXT_KEY);
      const current = ytext.toString();
      const separator = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
      // An append may not take the text past what `PUT` accepts for a whole text; the answer is the one `PUT` gives (#2341).
      if (current.length + separator.length + body.append.length > MAX_TEXT_CHARS) {
        throw new ValidationError([{ code: "too_big", path: ["append"], message: `Too big: expected the document to have <=${MAX_TEXT_CHARS} characters after the append` }]);
      }
      ytext.insert(ytext.length, separator + body.append);
      recordAgentActivity(doc, user!, "edited", { from: ytext.length, to: ytext.length });
      hashAfter = contentHash(cleanTextOf(doc));
    });
    void recordEdit(id, activityActor(user!), body.append.length).catch((err) => console.error("[activity] edit failed", err));
    return json({ ok: true, contentHash: hashAfter });
  } finally {
    await write.end();
  }
});
