import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
// The fake GitHub: dev users have no GitHub token, and the suite must not reach the network.
process.env.GITHUB_MOCK = "1";

// Same stand-ins as the other route tests: the caller is resolved through next-auth and `next/headers`;
// `bearer` makes the request carry a real API token so the agent path is exercised end to end.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let bearer: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(bearer ? { authorization: `Bearer ${bearer}` } : {}) }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken } = await import("@/server/tokens");
const { searchUsers, USER_SEARCH_LIMIT } = await import("@/server/github");
const { GET } = await import("./route");

type Body = { users: { login: string; name: string | null; avatarUrl: string }[]; limited: boolean; error?: string };

let owner: Actor;
const get = (query: string) => GET(new Request(`http://localhost:3700/api/github/users${query}`));

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  actor = owner;
});

afterAll(() => {
  delete process.env.GITHUB_MOCK;
});

describe("GET /api/github/users", () => {
  it("answers the mock's logins for a prefix, at most 8, with a private 60 s cache header", async () => {
    const res = await get("?q=oc");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    const body = (await res.json()) as Body;
    expect(body.limited).toBe(false);
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.users.length).toBeLessThanOrEqual(USER_SEARCH_LIMIT);
    for (const u of body.users) {
      expect(u.login.toLowerCase().startsWith("oc")).toBe(true);
      expect(u.name).toBeNull();
      expect(u.avatarUrl).toBe(`https://avatars.githubusercontent.com/${u.login}?s=40`);
    }
    expect(body.users.map((u) => u.login)).toContain("octocat");
  });

  it("narrows as the prefix grows and matches the login case-insensitively", async () => {
    const octoc = (await (await get("?q=octoc")).json()) as Body;
    expect(octoc.users.map((u) => u.login)).toEqual(["octocat"]);
    const upper = (await (await get("?q=MONA")).json()) as Body;
    expect(upper.users.map((u) => u.login)).toEqual(["monalisa"]);
    const none = (await (await get("?q=zzzz")).json()) as Body;
    expect(none).toEqual({ users: [], limited: false });
  });

  it("strips a leading @ and surrounding whitespace before searching", async () => {
    const body = (await (await get("?q=%20%40hub%20")).json()) as Body;
    expect(body.users.map((u) => u.login)).toEqual(["hubot"]);
  });

  it("rejects an empty, one-character, over-long or non-login prefix with 400", async () => {
    for (const q of ["", "a", "@", "@a", "bad!", "oct%20cat", "a".repeat(40), "o'neil", "%00oc", "oc/"]) {
      const res = await get(`?q=${q}`);
      expect(res.status, `q=${JSON.stringify(q)}`).toBe(400);
      expect(((await res.json()) as Body).error).toBe("Invalid request");
    }
    expect((await get("")).status).toBe(400);
    // Two characters is the shortest prefix searched; 39 is the longest GitHub login. Both are accepted.
    expect((await get("?q=oc")).status).toBe(200);
    expect((await get(`?q=${"a".repeat(39)}`)).status).toBe(200);
  });

  it("requires a signed-in browser session: anonymous 401, API token 403", async () => {
    actor = null;
    try {
      const res = await get("?q=oc");
      expect(res.status).toBe(401);
    } finally {
      actor = owner;
    }
    const token = await createApiToken(owner.id, "Copilot CLI");
    bearer = token.token;
    try {
      const res = await get("?q=oc");
      expect(res.status).toBe(403);
      expect(((await res.json()) as Body).error).toBe("GitHub user search is only available from a signed-in browser session");
    } finally {
      bearer = null;
    }
  });
});

describe("searchUsers()", () => {
  const octokitWith = (users: (q: string) => Promise<unknown>) => ({ search: { users: (params: { q: string }) => users(params.q) } }) as unknown as import("@octokit/rest").Octokit;

  it("reports a rate-limited search (403 / 429) as `limited` with no users instead of failing", async () => {
    process.env.GITHUB_MOCK = "0";
    try {
      for (const status of [403, 429]) {
        const octokit = octokitWith(() => Promise.reject(Object.assign(new Error("API rate limit exceeded"), { status })));
        expect(await searchUsers(octokit, "oct")).toEqual({ users: [], limited: true });
      }
      // Any other failure is still an error for the route's handler to report.
      const broken = octokitWith(() => Promise.reject(Object.assign(new Error("Service Unavailable"), { status: 503 })));
      await expect(searchUsers(broken, "oct")).rejects.toThrow("Service Unavailable");
    } finally {
      process.env.GITHUB_MOCK = "1";
    }
  });

  it("asks GitHub for user accounts by login, eight at a time, and maps the search result", async () => {
    process.env.GITHUB_MOCK = "0";
    try {
      let asked: { q: string; per_page?: number } | null = null;
      const octokit = {
        search: {
          users: async (params: { q: string; per_page?: number }) => {
            asked = params;
            return { data: { items: [{ login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4" }] } };
          },
        },
      } as unknown as import("@octokit/rest").Octokit;
      expect(await searchUsers(octokit, "octo")).toEqual({ users: [{ login: "octocat", name: null, avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4" }], limited: false });
      expect(asked).toEqual({ q: "octo in:login type:user", per_page: USER_SEARCH_LIMIT });
    } finally {
      process.env.GITHUB_MOCK = "1";
    }
  });
});
