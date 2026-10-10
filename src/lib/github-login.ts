/**
 * The shape of a GitHub login, for everything that reads a handle someone typed: sharing, the handle
 * search and `@` mentions.
 *
 * An ordinary account is letters, digits and hyphens. A managed account (Enterprise Managed Users: the
 * work accounts a company's identity provider creates) is the same followed by `_` and the enterprise's
 * short code, e.g. `mona-cat_octo`. GitHub allows at most 39 characters either way.
 */
export const GITHUB_LOGIN_MAX_LENGTH = 39;

/** The shape only: callers that report "too long" on its own check the length themselves. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9]+)?$/;

/** The start of a login as it is being typed: `mona-cat_` is one, on its way to `mona-cat_octo`. */
export const GITHUB_LOGIN_PREFIX_RE = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9]*)?$/;

export function isGithubLogin(value: string): boolean {
  return value.length <= GITHUB_LOGIN_MAX_LENGTH && GITHUB_LOGIN_RE.test(value);
}
