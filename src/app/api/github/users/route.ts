import { z } from "zod";
import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, isGitHubMock, searchUsers } from "@/server/github";

/**
 * A GitHub login prefix: 2–39 alphanumerics or hyphens (the login charset; a single character is not
 * worth a search-API call). A leading `@` (as people type handles) is dropped first.
 */
const querySchema = z.object({
  q: z
    .string()
    .trim()
    .transform((s) => s.replace(/^@/, ""))
    .pipe(z.string().min(2).max(39).regex(/^[a-zA-Z0-9-]+$/, "A GitHub handle has only letters, digits and hyphens")),
});

/**
 * `GET /api/github/users?q=<prefix>`: up to 8 GitHub accounts whose login matches, for the Share
 * dialog's handle autocomplete: `{ users: [{ login, name, avatarUrl }], limited }`. Browser sessions
 * only: an API token gets 403 (a leaked token must not be able to search accounts through the
 * user's GitHub credentials). When GitHub rate-limits the search, `limited: true` with no users.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "GitHub user search is only available from a signed-in browser session");
  const { q } = querySchema.parse({ q: new URL(req.url).searchParams.get("q") ?? undefined });
  // Under GITHUB_MOCK the fake needs no credentials (dev-login users have none).
  const token = isGitHubMock() ? "mock" : await getGitHubToken(user.id);
  if (!token) throw new HttpError(400, "No GitHub token. Sign in with GitHub.");
  const result = await searchUsers(githubClient(token), q);
  return json(result, { headers: { "Cache-Control": "private, max-age=60" } });
});
