import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { completeRequest } from "@/server/agent-requests";

type Params = { params: Promise<{ id: string; rid: string }> };

const schema = z
  .object({
    summary: z.string().trim().max(2000).optional(),
    suggestions: z.number().int().min(0).optional(),
    comments: z.number().int().min(0).optional(),
  })
  .default({});

/**
 * Mark a request done. `{ request, notified, alreadyDone, warnings? }`: the status and the activity row are
 * one write; the requester's `request.done` notification comes after it and, when it fails, is reported as
 * `warnings: ["notification-not-sent"]` on the 200 — the request is done either way. `notified` is whether
 * the requester holds the notification (false as well when they have no login to notify).
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id, rid } = await params;
  const { user } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const text = await req.text();
  const body = text.trim() ? await readJson(new Request(req.url, { method: "POST", body: text, headers: req.headers }), (d) => schema.parse(d)) : {};
  return json(await completeRequest(id, rid, user, body));
});
