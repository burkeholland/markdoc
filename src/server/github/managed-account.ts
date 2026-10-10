import { HttpError } from "@/server/http";
import { isManagedGithubLogin, MANAGED_ACCOUNT_GISTS_NOTE } from "@/lib/github-login";

const STABLE_GIST_REFUSALS = new Set([403, 404, 422]);

/**
 * GitHub does not let a managed account (Enterprise Managed Users) create gists, and does not say so
 * when one tries: the refusal has been reported as a 403, a 404 and a validation error. Those stable
 * 4xx refusals become one `403 { error, code: "gists-unavailable" }` that names the reason and what
 * works instead. Authentication failures and rate limits stay transient. `null` for every other
 * account and every other failure.
 */
export function managedAccountGistRefusal(user: { login: string | null }, error: unknown): HttpError | null {
  if (!isManagedGithubLogin(user.login)) return null;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (typeof status !== "number" || !STABLE_GIST_REFUSALS.has(status)) return null;
  return new HttpError(403, MANAGED_ACCOUNT_GISTS_NOTE, { code: "gists-unavailable" });
}

const RATE_LIMIT_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource", "x-ratelimit-used"] as const;

/** Preserve the reauthentication and retry semantics of transient GitHub failures for managed accounts. */
export function managedAccountGistTransientFailure(user: { login: string | null }, error: unknown): HttpError | null {
  if (!isManagedGithubLogin(user.login)) return null;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (status === 401) return new HttpError(401, "GitHub access was lost. Sign in with GitHub.");
  if (status !== 429) return null;

  const source = (error as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  const headers = Object.fromEntries(
    RATE_LIMIT_HEADERS.flatMap((name) => {
      const value = source?.[name];
      return typeof value === "string" || typeof value === "number" ? [[name, String(value)]] : [];
    }),
  );
  const retryAfter = Number(headers["retry-after"]);
  return new HttpError(
    429,
    "GitHub is rate limiting requests. Try again later.",
    Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : undefined,
    Object.keys(headers).length ? headers : undefined,
  );
}
