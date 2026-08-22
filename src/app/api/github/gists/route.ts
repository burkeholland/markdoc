import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, listMarkdownGists } from "@/server/github";

export const GET = handler(async () => {
  const user = await requireUser();
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const gists = await listMarkdownGists(githubClient(token));
  return json({ gists });
});
