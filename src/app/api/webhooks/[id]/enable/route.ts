import { handler, json, requireUser, HttpError } from "@/server/http";
import { enableWebhook, ownOriginKeys, startWebhookDispatcher, WebhookValidationError } from "@/server/webhooks";

type Params = { params: Promise<{ id: string }> };

/** Re-enable an owned disabled webhook without rotating its signing secret or sending a delivery. */
export const POST = handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "Webhooks can only be managed from a signed-in browser session");
  const { id } = await params;
  try {
    const webhook = await enableWebhook(user.id, id, ownOriginKeys(req.headers.get("host")));
    if (!webhook) throw new HttpError(404, "Webhook not found");
    startWebhookDispatcher();
    return json({ webhook });
  } catch (err) {
    if (err instanceof WebhookValidationError) throw new HttpError(400, err.message);
    throw err;
  }
});
