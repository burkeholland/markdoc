import { describe, expect, it } from "vitest";
import { GITHUB_LOGIN_PREFIX_RE, GITHUB_LOGIN_RE, isGithubLogin } from "./github-login";

describe("isGithubLogin()", () => {
  it("accepts an ordinary login: letters, digits and hyphens, up to 39 characters", () => {
    for (const login of ["a", "octocat", "Octo-Cat", "a1-b2", "d--b", "x--", "-abc", "a".repeat(39)]) {
      expect(isGithubLogin(login), login).toBe(true);
    }
  });

  it("accepts a managed account's login: the handle, one underscore, the enterprise short code", () => {
    for (const login of ["mona-cat_octo", "Mona_Octo", "a_b", `${"a".repeat(30)}_${"b".repeat(8)}`]) {
      expect(isGithubLogin(login), login).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const login of ["", "_octo", "mona_", "mona__octo", "a_b_c", "mona_oc-to", "bad name", "bad!", "a.b", "a@b", "a".repeat(40), `${"a".repeat(31)}_${"b".repeat(8)}`]) {
      expect(isGithubLogin(login), login).toBe(false);
    }
  });
});

describe("GITHUB_LOGIN_RE and GITHUB_LOGIN_PREFIX_RE", () => {
  it("the shape alone does not measure the length", () => {
    expect(GITHUB_LOGIN_RE.test("a".repeat(40))).toBe(true);
  });

  it("a prefix may stop right after the underscore, a login may not", () => {
    expect(GITHUB_LOGIN_PREFIX_RE.test("mona-cat_")).toBe(true);
    expect(GITHUB_LOGIN_RE.test("mona-cat_")).toBe(false);
    for (const prefix of ["mo", "mona-cat_oc", "mona-cat_octo"]) expect(GITHUB_LOGIN_PREFIX_RE.test(prefix), prefix).toBe(true);
    for (const prefix of ["", "_oc", "mona__", "mona_oc_", "mona cat"]) expect(GITHUB_LOGIN_PREFIX_RE.test(prefix), prefix).toBe(false);
  });
});
