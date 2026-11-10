import { z } from "zod";
import { handler, json, requireUser, HttpError } from "@/server/http";
import { getGitHubToken } from "@/server/documents";
import { githubClient, isGitHubMock, searchUsers } from "@/server/github";
import { GITHUB_LOGIN_MAX_LENGTH, GITHUB_LOGIN_PREFIX_RE } from "@/lib/github-login";

/**
 * A GitHub login prefix: 2–39 alphanumerics or hyphens, then for a managed account `_` and its short
 * code (the login charset; a single character is not worth a search-API call). A leading `@` (as
 * people type handles) is dropped first.
 */
const querySchema = z.object({
  q: z
    .string()
    .trim()
    .transform((s) => s.replace(/^@/, ""))
    .pipe(z.string().min(2).max(GITHUB_LOGIN_MAX_LENGTH).regex(GITHUB_LOGIN_PREFIX_RE, "A GitHub handle has only letters, digits and hyphens, plus _ and a short code for a managed account")),
});

/**
 * `GET /api/github/users?q=<prefix>`: up to 8 GitHub accounts whose login matches, for the Share
 * dialog's handle autocomplete: `{ users: [{ login, name, avatarUrl }], limited }`. Browser sessions
 * only: an API token gets 403 (a leaked token must not be able to search accounts through the
 * user's GitHub credentials). Rate limiting answers `limited: true` with no users; incomplete
 * GitHub searches answer 503. Neither is cached, so Retry can make a fresh request.
 * A session that signed in without GitHub has no token to search with: that is not a malformed
 * request, so it answers 200 `{ users: [], limited: false, reason: "no-github-token" }` and the
 * client stops asking for the life of the dialog (task #1481: every such share used to log 400s).
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  if (user.agent) throw new HttpError(403, "GitHub user search is only available from a signed-in browser session");
  const { q } = querySchema.parse({ q: new URL(req.url).searchParams.get("q") ?? undefined });
  // Under GITHUB_MOCK the fake needs no credentials (dev-login users have none).
  const token = isGitHubMock() ? "mock" : await getGitHubToken(user.id);
  if (!token) return json({ users: [], limited: false, reason: "no-github-token" }, { headers: { "Cache-Control": "private, max-age=60" } });
  const result = await searchUsers(githubClient(token), q);
  return json(result, { headers: { "Cache-Control": result.limited ? "no-store" : "private, max-age=60" } });
});
