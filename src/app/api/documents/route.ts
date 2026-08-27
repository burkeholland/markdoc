import { z } from "zod";
import { handler, HttpError, json, NUL_MESSAGE, nulFree, readJson, requireCanCreateDocuments, requireUser, tokenAllowsDocument } from "@/server/http";
import { createDocument, DOCUMENT_TITLE_MAX, listDocumentsForUser, listTrashForUser, searchDocumentsForUser } from "@/server/documents";
import { applyTemplate, getTemplate } from "@/lib/templates";

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const querySchema = z.object({
  q: z.string().max(200).refine(nulFree, NUL_MESSAGE).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** `starred=1|true` lists only the caller's starred documents (ignored when searching). */
  starred: flag,
  /** `trash=1|true` lists the caller's own documents in the trash instead (with `deletedAt`). */
  trash: flag,
});

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const params = new URL(req.url).searchParams;
  const { q, limit, starred, trash } = querySchema.parse({
    q: params.get("q") ?? undefined,
    limit: params.get("limit") ?? undefined,
    starred: params.get("starred") ?? undefined,
    trash: params.get("trash") ?? undefined,
  });
  // A document-restricted token only ever sees its documents, in lists as in direct reads.
  const only = <T extends { id: string }>(docs: T[]) => docs.filter((d) => tokenAllowsDocument(user, d.id));
  if (trash) {
    const documents = only(await listTrashForUser(user));
    return json({ documents });
  }
  if (q !== undefined) {
    const documents = only(await searchDocumentsForUser(user, q, { limit }));
    return json({ documents, query: q });
  }
  const documents = only(await listDocumentsForUser(user, { starred }));
  return json({ documents });
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX).optional(),
  content: z.string().max(2_000_000).optional(),
  /** Template id (see GET /api/templates). Fills title/content unless `content` is given. */
  template: z.string().trim().min(1).max(64).optional(),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  requireCanCreateDocuments(user);
  const body = await readJson(req, (d) => createSchema.parse(d ?? {}));
  let title = body.title;
  let content = body.content;
  if (body.template !== undefined) {
    const template = getTemplate(body.template);
    if (!template) throw new HttpError(400, `Unknown template "${body.template}"`);
    const filled = applyTemplate(template, { user: user.login ?? user.name ?? "you" });
    title ??= filled.title;
    content ??= filled.content;
  }
  content ??= title ? `# ${title}\n\n` : undefined;
  const doc = await createDocument({ ownerId: user.id, title, content });
  return json({ document: { id: doc.id, title: doc.title } }, { status: 201 });
});
