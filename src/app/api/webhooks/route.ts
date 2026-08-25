import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { createWebhook, listWebhooks, ownOriginKeys, startWebhookDispatcher, WebhookDocumentNotFoundError, WebhookValidationError, WEBHOOK_EVENTS } from "@/server/webhooks";

/** List your webhooks with their last delivery. Sessions only, like tokens: a leaked token must not see where events go. */
export const GET = handler(async () => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "Webhooks can only be managed from a signed-in browser session");
  startWebhookDispatcher();
  return json({ webhooks: await listWebhooks(user.id), events: WEBHOOK_EVENTS });
});

const createSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  events: z.array(z.string()).min(1).max(WEBHOOK_EVENTS.length * 2),
  documentIds: z.array(z.string().trim().min(1).max(64)).max(200).nullable().optional(),
});

/** Add a webhook. The HMAC secret is returned once. Sessions only. A URL at this server's own origin is refused (400); a `documentIds` entry you cannot see is `404 Document not found: <id>`, like `POST /api/tokens`. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "Webhooks can only be managed from a signed-in browser session");
  const body = await readJson(req, (d) => createSchema.parse(d));
  try {
    const webhook = await createWebhook(user, { url: body.url, events: body.events, documentIds: body.documentIds ?? null }, ownOriginKeys(req.headers.get("host")));
    startWebhookDispatcher();
    return json({ webhook }, { status: 201 });
  } catch (err) {
    if (err instanceof WebhookValidationError) throw new HttpError(400, err.message);
    if (err instanceof WebhookDocumentNotFoundError) throw new HttpError(err.status, err.message);
    throw err;
  }
});

export const dynamic = "force-dynamic";
