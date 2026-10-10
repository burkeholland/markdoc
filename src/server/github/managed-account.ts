import { HttpError } from "@/server/http";
import { isManagedGithubLogin, MANAGED_ACCOUNT_GISTS_NOTE } from "@/lib/github-login";

/**
 * GitHub does not let a managed account (Enterprise Managed Users) create gists, and does not say so
 * when one tries: the refusal has been reported as a 403, a 404 and a rate-limit error. So any 4xx
 * GitHub gives a managed account's gist request becomes one `403 { error, code: "gists-unavailable" }`
 * that names the reason and what works instead. `null` for every other account and every other failure.
 */
export function managedAccountGistRefusal(user: { login: string | null }, error: unknown): HttpError | null {
  if (!isManagedGithubLogin(user.login)) return null;
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (typeof status !== "number" || status < 400 || status > 499) return null;
  return new HttpError(403, MANAGED_ACCOUNT_GISTS_NOTE, { code: "gists-unavailable" });
}
