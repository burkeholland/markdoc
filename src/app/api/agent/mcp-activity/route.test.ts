import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

let requestHeaders = new Headers();
let sessionUser: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (sessionUser ? { user: sessionUser } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken, listApiTokens } = await import("@/server/tokens");
const { POST } = await import("./route");
const { GET: tokensGet } = await import("../../tokens/route");

/** Contract for burkeholland/markdoc-mcp: it reports tools/list (`list`) and tools/call (`call`) here with the agent's token. */
const bearer = (t: string) => ({ Authorization: ["Bearer", t].join(" ") });
const post = (headers: Record<string, string>, body: unknown) => {
  requestHeaders = new Headers({ "Content-Type": "application/json", ...headers });
  return POST(new Request("http://localhost/api/agent/mcp-activity", { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }));
};
let userId: string;

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Mia", login: "mia", email: "mia@example.com" }).returning();
  userId = user.id;
});

describe("POST /api/agent/mcp-activity", () => {
  it("list sets lastMcpSeenAt, call sets lastMcpCallAt, and GET /api/tokens exposes both", async () => {
    const fresh = await createApiToken(userId, "Checklist", 30);
    const row = async () => (await listApiTokens(userId)).find((t) => t.id === fresh.id)!;
    expect((await row()).lastMcpSeenAt).toBeNull();

    expect((await post(bearer(fresh.token), { kinds: ["list"] })).status).toBe(200);
    expect((await row()).lastMcpSeenAt).toBeInstanceOf(Date);
    expect((await row()).lastMcpCallAt).toBeNull();
    expect((await post(bearer(fresh.token), { kinds: ["call"] })).status).toBe(200);
    expect((await row()).lastMcpCallAt).toBeInstanceOf(Date);

    requestHeaders = new Headers();
    sessionUser = { id: userId, login: "mia", name: "Mia", image: null };
    try {
      const list = (await (await tokensGet(new Request("http://localhost/api/tokens"))).json()) as { tokens: { id: string; lastMcpSeenAt: string | null; lastMcpCallAt: string | null }[] };
      const dto = list.tokens.find((t) => t.id === fresh.id)!;
      expect(dto.lastMcpSeenAt).toMatch(/^\d{4}-/);
      expect(dto.lastMcpCallAt).toMatch(/^\d{4}-/);
    } finally {
      sessionUser = null;
    }
  });

  it("is 401 without a valid token, 403 for a browser session, 400 for unknown kinds", async () => {
    expect((await post({}, { kinds: ["list"] })).status).toBe(401);
    expect((await post(bearer("mdk_nope"), { kinds: ["list"] })).status).toBe(401);
    const { token } = await createApiToken(userId, "Bad body", 30);
    expect((await post(bearer(token), { kinds: ["other"] })).status).toBe(400);
    expect((await post(bearer(token), { kinds: [] })).status).toBe(400);
    sessionUser = { id: userId, login: "mia", name: "Mia", image: null };
    try {
      expect((await post({}, { kinds: ["list"] })).status).toBe(403);
    } finally {
      sessionUser = null;
    }
  });
});
