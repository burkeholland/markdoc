import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, listMarkdownFiles } from "@/server/github";

type Params = { params: Promise<{ owner: string; repo: string }> };

export const GET = handler(async (req: Request, { params }: Params) => {
  const user = await requireUser();
  const { owner, repo } = await params;
  const ref = new URL(req.url).searchParams.get("ref") || "HEAD";
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const files = await listMarkdownFiles(githubClient(token), owner, repo, ref);
  return json({ files });
});
