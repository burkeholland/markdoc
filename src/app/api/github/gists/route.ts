import { handler, json, requireScope, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, listMarkdownGists } from "@/server/github";
import { managedAccountGistRefusal, managedAccountGistTransientFailure } from "@/server/github/managed-account";

export const GET = handler(async () => {
  const user = await requireUser();
  requireScope(user, "full", "browse GitHub");
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const gists = await listMarkdownGists(githubClient(token)).catch((error: unknown) => {
    // A managed account cannot have gists, and GitHub may refuse the question itself: the answer is none.
    if (managedAccountGistRefusal(user, error)) return [];
    throw managedAccountGistTransientFailure(user, error) ?? error;
  });
  return json({ gists });
});
