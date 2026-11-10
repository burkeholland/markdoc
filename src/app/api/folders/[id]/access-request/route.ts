import { getFolderAccess } from "@/server/folders";
import { handler, HttpError, json, requireUser } from "@/server/http";
import { notifyFolderAccessRequest } from "@/server/notifications";

type Params = { params: Promise<{ id: string }> };

export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  if (user.tokenId || user.embedDocumentId) throw new HttpError(403, "Request access from a browser session");
  if (!(await getFolderAccess(id, user))) await notifyFolderAccessRequest(id, user);
  return json({ requested: true }, { status: 202 });
});
