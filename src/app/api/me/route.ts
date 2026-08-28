import { handler, json, requireUser } from "@/server/http";
import { activeWebhooksFor, startWebhookDispatcher } from "@/server/webhooks";
import { agentMentionSlug } from "@/editor/collab/mentions";
import { isAgentMentionUnique } from "@/server/tokens";

/**
 * Who is calling: the user, the agent (token name, scope, document restriction) if any, and the user's
 * active webhooks (url + events, never the secret) so an unattended agent knows events are also pushed somewhere.
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
    webhooks,
  });
});
