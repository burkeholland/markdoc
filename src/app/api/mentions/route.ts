import { handler, json, requireUser } from "@/server/http";
import { listUnreadMentions } from "@/server/mentions";

/** The current user's unread `@mentions`, newest first, with the document title. */
export const GET = handler(async () => {
  const user = await requireUser();
  if (!user.login) return json({ mentions: [] });
  const mentions = await listUnreadMentions(user.login);
  return json({ mentions: mentions.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) });
});
