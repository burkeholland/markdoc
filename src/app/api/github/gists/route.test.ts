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
const refused = (status: number) => Object.assign(new Error("refused (test)"), { status });

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
  it.each([403, 404, 429])("a managed account that GitHub answers %i has none, not an error", async (status) => {
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(status));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gists: [] });
  });

  it("an ordinary account's refusal, and anyone's GitHub outage, are still unexpected errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    actor = ordinary;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(403));
    expect((await GET()).status).toBe(500);
    actor = managed;
    vi.mocked(listMarkdownGists).mockRejectedValueOnce(refused(502));
    expect((await GET()).status).toBe(500);
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
