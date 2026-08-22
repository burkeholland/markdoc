import { z } from "zod";
import { handler, json, readJson, requireUser } from "@/server/http";
import { createDocument, listDocumentsForUser, searchDocumentsForUser } from "@/server/documents";

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
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson(req, (d) => createSchema.parse(d ?? {}));
  const content = body.content ?? (body.title ? `# ${body.title}\n\n` : undefined);
  const doc = await createDocument({ ownerId: user.id, title: body.title, content });
  return json({ document: { id: doc.id, title: doc.title } }, { status: 201 });
});
