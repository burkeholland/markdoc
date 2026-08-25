import { handler, json, requireUser } from "@/server/http";

/** Who is calling: the user, and the agent (token name, scope, document restriction) if any. Handy for agents to introduce themselves. */
export const GET = handler(async () => {
  const user = await requireUser();
  return json({
    user: { id: user.id, login: user.login, name: user.name, image: user.image },
    agent: user.agent ?? null,
    scope: user.agent ? (user.scope ?? "full") : null,
    documentIds: user.agent ? (user.documentIds ?? null) : null,
  });
});
