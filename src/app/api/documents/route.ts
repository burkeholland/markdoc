import { z } from "zod";
import { handler, json, readJson, requireUser } from "@/server/http";
import { createDocument, listDocumentsForUser } from "@/server/documents";

export const GET = handler(async () => {
  const user = await requireUser();
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
