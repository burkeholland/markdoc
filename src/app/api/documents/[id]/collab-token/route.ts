import { handler, json, requireAccess } from "@/server/http";
import { signCollabToken } from "@/server/collab/token";

type Params = { params: Promise<{ id: string }> };

/** Short-lived token that authorizes a WebSocket connection to the document. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { role, user } = await requireAccess(id, "view");
  const token = await signCollabToken({
    userId: user?.id ?? `anon-${crypto.randomUUID().slice(0, 8)}`,
    docId: id,
    role,
    name: user?.name ?? user?.login ?? "Anonymous",
    login: user?.login ?? null,
    avatar: user?.image ?? null,
  });
  return json({ token, role });
});
