import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.MARKDOC_URL;

// Same stand-ins as the other API route tests: the caller is resolved through next-auth and
// `next/headers`. Here the token travels in `requestHeaders` so the real resolver sees it.
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken } = await import("@/server/tokens");
const { GET, POST } = await import("./route");
const { listToolNames } = await import("../../../../mcp/tools.mjs");

const URL_ = "http://192.168.0.10:3700/api/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
let token: string;

const call = (method: "GET" | "POST", init: { headers?: Record<string, string>; body?: unknown } = {}) => {
  const headers = new Headers({ host: "192.168.0.10:3700", ...(init.headers ?? {}) });
  requestHeaders = headers;
  const req = new Request(URL_, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return method === "GET" ? GET(req) : POST(req);
};
const rpc = (method: string, params: unknown = {}, id: number | null = 1) => ({ jsonrpc: "2.0", id, method, params });
const bearer = (t: string) => ({ Authorization: ["Bearer", t].join(" ") });

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Mia", login: "mia", email: "mia@example.com" }).returning();
  token = (await createApiToken(user.id, "Copilot CLI", 30)).token;
});

describe("/api/mcp", () => {
  it("GET without MCP headers answers a small JSON card (no auth needed)", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string; tools: number; docs: string };
    expect(body.name).toBe("markdoc");
    expect(body.tools).toBe(listToolNames().length);
    expect(body.tools).toBe(26);
    expect(body.docs).toContain("docs/agents");
  });

  it("POST without a token is 401 and says where to create one", async () => {
    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT }, body: rpc("tools/list") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; settings: string };
    expect(body.error).toContain("/settings");
    expect(body.settings).toBe("/settings#tokens");
  });

  it("POST with a revoked/unknown token is 401", async () => {
    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer("mdk_doesnotexist0000000000000000") }, body: rpc("tools/list") });
    expect(res.status).toBe(401);
  });

  it("POST tools/list round-trips JSON-RPC with the same tools as the stdio server", async () => {
    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(token) }, body: rpc("tools/list") });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { jsonrpc: string; id: number; result: { tools: { name: string; description: string; inputSchema: unknown }[] } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(listToolNames());
    expect(names).toContain("markdoc_whoami");
    expect(names).toContain("markdoc_read_document");
    expect(names).toContain("markdoc_presence");
    expect(names).toContain("markdoc_watch");
  });

  it("initialize advertises the markdoc server and its instructions", async () => {
    const params = { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } };
    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(token) }, body: rpc("initialize", params) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions?: string; capabilities: { tools?: unknown } } };
    expect(body.result.serverInfo.name).toBe("markdoc");
    expect(body.result.instructions).toContain("markdoc_suggest");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tool calls go back to this server's own origin with the caller's token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ user: { id: "u1", login: "mia", name: "Mia" }, agent: "Copilot CLI" }), { headers: { "Content-Type": "application/json" } });
    });
    try {
      const res = await call("POST", {
        headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(token) },
        body: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { content: { type: string; text: string }[]; isError?: boolean } };
      expect(body.result.isError).toBeFalsy();
      expect(body.result.content[0].text).toContain('via agent "Copilot CLI"');
      expect(seen).toEqual([{ url: "http://192.168.0.10:3700/api/me", auth: ["Bearer", token].join(" ") }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
