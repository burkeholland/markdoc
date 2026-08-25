import { z } from "zod";
import { handler, json, readJson, requireScope, requireUser, HttpError } from "@/server/http";
import { createDocument, getGitHubToken, titleFromContent } from "@/server/documents";
import { githubClient, readGistFile, readRepoFile } from "@/server/github";

const schema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("gist"), gistId: z.string().trim().min(1), filename: z.string().trim().optional() }),
  z.object({
    source: z.literal("repo"),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1),
    path: z.string().trim().min(1),
  }),
]);

/** Create a document backed by an existing gist or repository file. */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  requireScope(user, "full", "import documents");
  const body = await readJson(req, (d) => schema.parse(d));
  const token = await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const octokit = githubClient(token);

  if (body.source === "gist") {
    const file = await readGistFile(octokit, body.gistId, body.filename);
    const doc = await createDocument({
      ownerId: user.id,
      title: titleFromContent(file.content, file.description || file.filename.replace(/\.(md|markdown)$/i, "")),
      content: file.content,
      storage: "gist",
      gistId: file.gistId,
      gistFile: file.filename,
    });
    return json({ document: { id: doc.id, title: doc.title } }, { status: 201 });
  }

  const file = await readRepoFile(octokit, body.owner, body.repo, body.path, body.branch);
  const base = body.path.split("/").pop()!.replace(/\.(md|markdown|mdx)$/i, "");
  const doc = await createDocument({
    ownerId: user.id,
    title: titleFromContent(file.content, base),
    content: file.content,
    storage: "repo",
    repoOwner: body.owner,
    repoName: body.repo,
    repoBranch: body.branch,
    repoPath: body.path,
    githubSha: file.sha,
  });
  return json({ document: { id: doc.id, title: doc.title } }, { status: 201 });
});
