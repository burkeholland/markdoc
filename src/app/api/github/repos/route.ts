import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, listRepos } from "@/server/github";

export const GET = handler(async () => {
  const user = await requireUser();
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const repos = await listRepos(githubClient(token));
  return json({ repos });
});
