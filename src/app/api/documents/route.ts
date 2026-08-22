import { z } from "zod";
import { handler, HttpError, json, readJson, requireUser } from "@/server/http";
import { createDocument, listDocumentsForUser, searchDocumentsForUser } from "@/server/documents";
import { applyTemplate, getTemplate } from "@/lib/templates";

const querySchema = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });

export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const params = new URL(req.url).searchParams;
  const { q, limit } = querySchema.parse({ q: params.get("q") ?? undefined, limit: params.get("limit") ?? undefined });
  if (q !== undefined) {
    const documents = await searchDocumentsForUser(user, q, { limit });
    return json({ documents, query: q });
  }
  const documents = await listDocumentsForUser(user);
  return json({ documents });
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(2_000_000).optional(),
  /** Template id (see GET /api/templates). Fills title/content unless `content` is given. */
  template: z.string().trim().min(1).max(64).optional(),
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
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
