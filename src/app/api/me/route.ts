import { handler, json, requireUser } from "@/server/http";

/** Who is calling: the user, and the agent (token name) if any. Handy for agents to introduce themselves. */
export const GET = handler(async () => {
  const user = await requireUser();
  return json({ user: { id: user.id, login: user.login, name: user.name, image: user.image }, agent: user.agent ?? null });
});
