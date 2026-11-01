import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { deleteAccount, isDemoAccount, requireBrowserSession } from "@/server/account";
import { VideoAssetError } from "@/server/video-assets";
import { activeWebhooksFor, startWebhookDispatcher } from "@/server/webhooks";
import { agentMentionSlug } from "@/editor/collab/mentions";
import { isAgentMentionUnique } from "@/server/tokens";

/**
 * Who is calling: the user, the agent (token name, scope, document restriction, whether other users may
 * address requests to it) if any, and the user's active webhooks (url + events, never the secret) so an
 * unattended agent knows events are also pushed somewhere.
 */
export const GET = handler(async () => {
  const user = await requireUser();
  const webhooks = await activeWebhooksFor(user.id);
  const agentMention = user.agent
    ? {
        slug: agentMentionSlug(user.agent),
        unique: await isAgentMentionUnique(user.id, user.tokenId ?? null, user.agent),
      }
    : null;
  if (webhooks.length > 0) startWebhookDispatcher();
  return json({
    user: { id: user.id, login: user.login, name: user.name, image: user.image },
    agent: user.agent ?? null,
    agentMention,
    scope: user.agent ? (user.scope ?? "full") : null,
    documentIds: user.agent ? (user.documentIds ?? null) : null,
    collaboratorsMayAsk: user.agent ? (user.collaboratorsMayAsk ?? false) : null,
    webhooks,
  });
});

function parseConfirmation(data: unknown): string {
  const confirm = data && typeof data === "object" ? (data as { confirm?: unknown }).confirm : undefined;
  if (typeof confirm !== "string") throw new HttpError(400, "Type your login to confirm");
  return confirm.trim();
}

/** Delete the signed-in account and everything it owns. Body: `{ "confirm": "<login>" }`. */
export const DELETE = handler(async (req: Request) => {
  const user = await requireUser();
  requireBrowserSession(user, "delete an account");
  const confirm = await readJson(req, parseConfirmation);
  const expected = user.login ?? "";
  if (!expected || confirm.toLowerCase() !== expected.toLowerCase()) throw new HttpError(400, "Confirmation does not match your login");
  if (isDemoAccount(user.login)) throw new HttpError(403, "The shared demo account cannot be deleted");
  try {
    await deleteAccount({ id: user.id, login: user.login });
  } catch (error) {
    if (error instanceof VideoAssetError) throw new HttpError(error.status, error.message);
    throw error;
  }
  return json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
});
