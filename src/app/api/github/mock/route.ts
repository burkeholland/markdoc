import { z } from "zod";
import { handler, json, readJson, requireUser, HttpError } from "@/server/http";
import { isGitHubMock, mockGetGist, mockGetRepoFile, mockReset, mockSetGistFile, mockSetRepoFile } from "@/server/github/mock";

const schema = z.union([
  z.object({
    kind: z.literal("repo"),
    owner: z.string(),
    repo: z.string(),
    branch: z.string().default("main"),
    path: z.string(),
    content: z.string(),
    /** Bytes the fake GitHub reports for the file; over 2 MB it behaves like a 1–100 MB file (sha known, text unreadable). */
    size: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal("gist"), gistId: z.string(), filename: z.string(), content: z.string() }),
  z.object({ kind: z.literal("reset") }),
]);

function guard() {
  if (!isGitHubMock()) throw new HttpError(404, "Not found");
}

/** Test-only (GITHUB_MOCK=1): edit the fake GitHub so a spec can play "someone else committed". */
export const POST = handler(async (req: Request) => {
  guard();
  await requireUser();
  const body = await readJson(req, (d) => schema.parse(d));
  if (body.kind === "reset") {
    mockReset();
    return json({ ok: true });
  }
  if (body.kind === "repo") {
    const file = mockSetRepoFile(body.owner, body.repo, body.branch, body.path, body.content, body.size);
    return json({ sha: file.sha });
  }
  const gist = mockSetGistFile(body.gistId, body.filename, body.content);
  return json({ revision: gist.revision });
});

export const GET = handler(async (req: Request) => {
  guard();
  await requireUser();
  const q = new URL(req.url).searchParams;
  if (q.get("gistId")) {
    const gist = mockGetGist(q.get("gistId")!);
    return json({ content: gist?.files.get(q.get("filename") ?? "") ?? null, revision: gist?.revision ?? null });
  }
  const file = mockGetRepoFile(q.get("owner") ?? "", q.get("repo") ?? "", q.get("branch") ?? "main", q.get("path") ?? "");
  return json({ content: file?.content ?? null, sha: file?.sha ?? null });
});