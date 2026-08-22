import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, listBranches } from "@/server/github";

type Params = { params: Promise<{ owner: string; repo: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const user = await requireUser();
  const { owner, repo } = await params;
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const branches = await listBranches(githubClient(token), owner, repo);
  return json({ branches });
});
