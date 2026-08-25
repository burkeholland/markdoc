import { handler, json, requireUser, HttpError } from "@/server/http";
import { sendTestWebhook } from "@/server/webhooks";

type Params = { params: Promise<{ id: string }> };

/** "Send test": POST a `test` event to the webhook once (no retries) and report the response status. */
export const POST = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "Webhooks can only be managed from a signed-in browser session");
  const { id } = await params;
  const result = await sendTestWebhook(user.id, id);
  if (!result) throw new HttpError(404, "Webhook not found");
  return json({ delivery: result });
});
