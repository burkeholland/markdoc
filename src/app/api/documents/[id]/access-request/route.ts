import { getEffectiveDocumentAccess, handler, HttpError, json, requireUser } from "@/server/http";
import { notifyAccessRequest } from "@/server/notifications";

type Params = { params: Promise<{ id: string }> };

/**
 * Ask the owner of a document for access (issue #2400). The answer is the same `202 { requested: true }`
 * whether the document exists, is trashed, or the caller already has access, so it never reveals which
 * ids are real; the owner is notified only in the genuine case, at most once per requester.
 */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const user = await requireUser();
  if (user.tokenId || user.embedDocumentId) throw new HttpError(403, "Request access from a browser session");
  const access = await getEffectiveDocumentAccess(id, user);
  if (!access) await notifyAccessRequest(id, user);
  return json({ requested: true }, { status: 202 });
});
