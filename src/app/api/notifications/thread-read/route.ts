import { z } from "zod";
import { handler, json, readJson, requireUser } from "@/server/http";
import { markRefsRead } from "@/server/notifications";

const schema = z.object({ documentId: z.string().min(1), refIds: z.array(z.string().min(1)).max(500) });

/**
 * Mark read every unread notification of the current user about any of `refIds` in a document —
 * used when a comment thread is opened (the thread id plus its reply ids). Returns how many changed.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await readJson(req, (d) => schema.parse(d));
  if (!user.login) return json({ ok: true, count: 0 });
  const count = await markRefsRead(user.login, body.documentId, body.refIds);
  return json({ ok: true, count });
});
