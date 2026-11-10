import { z } from "zod";
import { GITHUB_LOGIN_MAX_LENGTH, GITHUB_LOGIN_RE } from "@/lib/github-login";
import { folderAccessExceptions, getFolderForOwner } from "@/server/folders";
import { handler, HttpError, json, requireUser } from "@/server/http";

const querySchema = z.object({
  login: z.string().trim().transform((value) => value.replace(/^@/, "").toLowerCase())
    .pipe(z.string().max(GITHUB_LOGIN_MAX_LENGTH).regex(GITHUB_LOGIN_RE)),
  role: z.enum(["viewer", "commenter", "editor"]),
});

export const GET = handler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireUser();
  if (user.documentIds?.length) throw new HttpError(403, "This token is restricted to other documents");
  if (user.scope && user.scope !== "full") throw new HttpError(403, "This token may not inspect folder sharing");
  const folder = await getFolderForOwner(id, user.id);
  if (!folder) throw new HttpError(404, "No such folder");
  const query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const exceptions = await folderAccessExceptions(folder, [query]);
  return json({ login: query.login, role: query.role, exceptions: exceptions[query.login] }, { headers: { "Cache-Control": "no-store" } });
});
