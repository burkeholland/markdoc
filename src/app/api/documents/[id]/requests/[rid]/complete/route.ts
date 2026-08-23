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

/** Mark a request done. Records activity and notifies the requester. */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id, rid } = await params;
  const { user } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const text = await req.text();
  const body = text.trim() ? await readJson(new Request(req.url, { method: "POST", body: text, headers: req.headers }), (d) => schema.parse(d)) : {};
  const request = await completeRequest(id, rid, user, body);
  return json({ request });
});
