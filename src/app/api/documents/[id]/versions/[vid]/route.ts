import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError, actorName } from "@/server/http";
import { addVersion, getVersion } from "@/server/documents";
import { readLiveText, replaceLiveText } from "@/server/livedoc";
import { getDb, schema } from "@/server/db";
import { and, eq } from "drizzle-orm";
import { activityActor, recordActivity } from "@/server/activity";
import { warnTail } from "@/server/warnings";
import { WriteTurn } from "@/server/large-write";

type Params = { params: Promise<{ id: string; vid: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id, vid } = await params;
  await requireAccess(id, "view");
  const version = await getVersion(id, vid);
  if (!version) throw new HttpError(404, "Version not found");
  return json({ version: { ...version, createdAt: version.createdAt.toISOString() } });
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("rename"), title: z.string().trim().min(1).max(120) }),
]);

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id, vid } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => actionSchema.parse(d));
  const version = await getVersion(id, vid);
  if (!version) throw new HttpError(404, "Version not found");

  if (body.action === "rename") {
    const db = await getDb();
    await db
      .update(schema.versions)
      .set({ title: body.title, kind: version.kind === "auto" ? "named" : version.kind })
      .where(and(eq(schema.versions.documentId, id), eq(schema.versions.id, vid)));
    return json({ ok: true });
  }

  // A large version takes its turn like any large write (one at a time, two per user: see large-write.ts),
  // before the snapshot below, so that a refused restore leaves nothing behind.
  const write = await WriteTurn.begin(req, user!.id);
  try {
    await write.sized(version.content.length);
    write.assertWanted();
    // Restore: snapshot the current text first so nothing is lost, then replace. Both stay fatal: until the
    // replace lands nothing has changed, so a 500 here is honest.
    const live = await readLiveText(id);
    if (live.text !== version.content) {
      await addVersion({
        documentId: id,
        content: live.text,
        kind: "auto",
        title: "Before restore",
        createdBy: user?.id,
        createdByName: actorName(user),
      });
    }
    await replaceLiveText(
      id,
      {
        userId: user?.id ?? "system",
        docId: id,
        role: "owner",
        name: user?.name ?? user?.login ?? "User",
        login: user?.login ?? null,
        avatar: user?.image ?? null,
      },
      version.content,
    );
    // The restored text is live (broadcast to every editor, irrevocable): the "Restored version n" row or the activity
    // row failing here is logged and reported as a warning code on the 200 — `version` is null when the row could not
    // be saved — never a 500 while everyone already sees the restored text.
    const { tail, answer } = warnTail("version");
    let restored: Awaited<ReturnType<typeof addVersion>> | undefined;
    await tail("version-not-saved", async () => {
      restored = await addVersion({
        documentId: id,
        content: version.content,
        kind: "restore",
        title: `Restored version ${version.number}`,
        createdBy: user?.id,
        createdByName: actorName(user),
      });
    });
    await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "version.restore", { number: version.number, title: version.title }));
    return json(answer({ ok: true, version: restored ? { ...restored, createdAt: restored.createdAt.toISOString() } : null }));
  } finally {
    await write.end();
  }
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const { id, vid } = await params;
  await requireAccess(id, "edit");
  const db = await getDb();
  const deleted = await db
    .delete(schema.versions)
    .where(and(eq(schema.versions.documentId, id), eq(schema.versions.id, vid)))
    .returning();
  if (deleted.length === 0) throw new HttpError(404, "Version not found");
  return json({ ok: true });
});

