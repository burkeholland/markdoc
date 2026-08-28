import { handler, json, requireAccess } from "@/server/http";
import { signCollabToken } from "@/server/collab/token";
import { recordDocumentOpen } from "@/server/documents";

type Params = { params: Promise<{ id: string }> };

/** Short-lived token that authorizes a WebSocket connection to the document. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { role, user } = await requireAccess(id, "view");
  // Every editor session starts here, so this doubles as "the user opened the document" for the dashboard's recents.
  if (user) await recordDocumentOpen(user.id, id).catch((err: unknown) => console.error("recordDocumentOpen failed", err));
  const token = await signCollabToken({
    userId: user?.id ?? `anon-${crypto.randomUUID().slice(0, 8)}`,
    docId: id,
    role,
    name: user?.name ?? user?.login ?? "Anonymous",
    login: user?.login ?? null,
    avatar: user?.image ?? null,
    tokenId: user?.tokenId,
    tokenScope: user?.scope,
    tokenExpiresAt: user?.tokenExpiresAt?.getTime() ?? null,
  });
  return json({ token, role });
});
