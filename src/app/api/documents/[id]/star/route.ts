import { handler, HttpError, json, requireAccess } from "@/server/http";
import { isStarred, starDocument, unstarDocument } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

/** Stars are personal: anyone who can see the document may star it, but only when signed in. */
async function requireStarrer(id: string) {
  const { user } = await requireAccess(id, "view");
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireStarrer(id);
  return json({ starred: await isStarred(user.id, id) });
});

export const PUT = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireStarrer(id);
  await starDocument(user.id, id);
  return json({ starred: true });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireStarrer(id);
  await unstarDocument(user.id, id);
  return json({ starred: false });
});
