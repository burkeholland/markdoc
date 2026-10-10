import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/github", () => ({ githubClient: () => ({}), listMarkdownGists: vi.fn() }));
vi.mock("@/server/documents", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/documents")>()), getGitHubToken: async () => "token" }));

const { getDb, schema } = await import("@/server/db");
const { listMarkdownGists } = await import("@/server/github");
const { GET } = await import("./route");

const GIST = { id: "g1", description: null, public: false, updatedAt: "2026-10-01T00:00:00Z", htmlUrl: "https://gist.github.com/g1", files: [{ filename: "notes.md", language: "Markdown", size: 12 }] };
const refused = (status: number, headers?: Record<string, string>) =>
  Object.assign(new Error("refused (test)"), { status, response: headers ? { headers } : undefined });

let ordinary: Actor;
let managed: Actor;

beforeAll(async () => {
  const db = await getDb();
  const [o, m] = await db
    .insert(schema.users)
    .values([
      { name: "Olive", login: "olive", email: "olive-gists@example.com" },
      { name: "Mona", login: "mona-cat_octo", email: "mona-gists@example.com" },
    ])
    .returning();
  ordinary = { id: o.id, login: "olive", name: "Olive", image: null };
  managed = { id: m.id, login: "mona-cat_octo", name: "Mona", image: null };
});

afterEach(() => {
  actor = null;
  vi.mocked(listMarkdownGists).mockReset();
  vi.restoreAllMocks();
});

describe("GET /api/github/gists", () => {
  it("answers the account's Markdown gists", async () => {
    actor = ordinary;
    vi.mocked(listMarkdownGists).mockResolvedValueOnce([GIST]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gists: [GIST] });
  });

  // A managed account (Enterprise Managed Users) cannot have gists; GitHub may refuse the question itself.
  it.each([403, 404])("a managed account that GitHub answers %i has none, not an error", async (status) => {
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(status));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gists: [] });
  });

  it("preserves a 401 as lost GitHub access instead of hiding it as an empty list", async () => {
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(401));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "GitHub access was lost. Sign in with GitHub." });
  });

  it("preserves a 429 and GitHub's retry metadata instead of hiding it as an empty list", async () => {
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(
      refused(429, { "retry-after": "23", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791676800" }),
    );
    const res = await GET();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "GitHub is rate limiting requests. Try again later.", retryAfter: 23 });
    expect(res.headers.get("Retry-After")).toBe("23");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1791676800");
  });

  it("an ordinary account's refusal, an unknown managed-account 4xx, and anyone's GitHub outage are still unexpected errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    actor = ordinary;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(403));
    expect((await GET()).status).toBe(500);
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(400));
    expect((await GET()).status).toBe(500);
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(502));
    expect((await GET()).status).toBe(500);
    expect(errors).toHaveBeenCalledTimes(3);
  });
});
