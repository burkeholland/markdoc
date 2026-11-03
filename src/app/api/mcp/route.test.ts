import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeAll, vi } from "vitest";

import { hasConnected } from "@/lib/agent-keys";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.MARKDOC_URL;
delete process.env.MARKDOC_INTERNAL_URL;
process.env.PORT = "3700";

// Same stand-ins as the other API route tests: the caller is resolved through next-auth and
// `next/headers`. Here the token travels in `requestHeaders` so the real resolver sees it.
let requestHeaders = new Headers();
let sessionUser: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (sessionUser ? { user: sessionUser } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken, listApiTokens } = await import("@/server/tokens");
const { GET, POST, DELETE } = await import("./route");
const { mcpActivityIn } = await import("./activity");
const { listToolNames } = await import("../../../../mcp/tools.mjs");
const { mcpRestOrigin } = await import("@/server/mcp-origin");

const URL_ = "http://192.168.0.10:3700/api/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";
let token: string;
let userId: string;

const call = (method: "GET" | "POST" | "DELETE", init: { headers?: Record<string, string>; body?: unknown } = {}) => {
  const headers = new Headers({ host: "192.168.0.10:3700", ...(init.headers ?? {}) });
  requestHeaders = headers;
  const req = new Request(URL_, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  return method === "GET" ? GET(req) : method === "DELETE" ? DELETE(req) : POST(req);
};
const rpc = (method: string, params: unknown = {}, id: number | null = 1) => ({ jsonrpc: "2.0", id, method, params });
const bearer = (t: string) => ({ Authorization: ["Bearer", t].join(" ") });
const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Expected an IP listener"));
      else resolve(address.port);
    });
  });
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Mia", login: "mia", email: "mia@example.com" }).returning();
  userId = user.id;
  token = (await createApiToken(user.id, "Copilot CLI", 30)).token;
});

describe("/api/mcp records MCP activity on the token (Settings checklist)", () => {
  it("mcpActivityIn reads tools/list and tools/call from single and batched bodies, ignores the rest", async () => {
    const mk = (body: unknown, method = "POST") => new Request(URL_, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
    expect(await mcpActivityIn(mk(rpc("tools/list")))).toEqual(["list"]);
    expect(await mcpActivityIn(mk(rpc("tools/call", { name: "x" })))).toEqual(["call"]);
    expect(await mcpActivityIn(mk([rpc("initialize"), rpc("tools/list"), rpc("tools/call"), rpc("tools/list", {}, 2)]))).toEqual(["list", "call"]);
    expect(await mcpActivityIn(mk(rpc("initialize")))).toEqual([]);
    expect(await mcpActivityIn(mk(null, "GET"))).toEqual([]);
    expect(await mcpActivityIn(new Request(URL_, { method: "POST", body: "{not json" }))).toEqual([]);
  });

  it("a fresh token has neither timestamp; tools/list sets lastMcpSeenAt only; tools/call sets lastMcpCallAt", async () => {
    const fresh = await createApiToken(userId, "Checklist", 30);
    const before = (await listApiTokens(userId)).find((t) => t.id === fresh.id)!;
    expect(before.lastMcpSeenAt).toBeNull();
    expect(before.lastMcpCallAt).toBeNull();

    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(fresh.token) }, body: rpc("tools/list") });
    expect(res.status).toBe(200);
    let row = before;
    for (let i = 0; i < 40 && !row.lastMcpSeenAt; i++) {
      await new Promise((r) => setTimeout(r, 25));
      row = (await listApiTokens(userId)).find((t) => t.id === fresh.id)!;
    }
    expect(row.lastMcpSeenAt).toBeInstanceOf(Date);
    expect(row.lastMcpCallAt).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ user: { id: userId, login: "mia", name: "Mia" }, agent: "Checklist" }), { headers: { "Content-Type": "application/json" } }));
    try {
      const called = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(fresh.token) }, body: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }) });
      expect(called.status).toBe(200);
    } finally {
      fetchSpy.mockRestore();
    }
    for (let i = 0; i < 40 && !row.lastMcpCallAt; i++) {
      await new Promise((r) => setTimeout(r, 25));
      row = (await listApiTokens(userId)).find((t) => t.id === fresh.id)!;
    }
    expect(row.lastMcpCallAt).toBeInstanceOf(Date);
    // GET /api/tokens exposes both as ISO strings for the checklist (session only: tokens get 403).
    const { GET: tokensGet } = await import("../tokens/route");
    requestHeaders = new Headers(bearer(fresh.token));
    expect((await tokensGet(new Request("http://localhost:3700/api/tokens"))).status).toBe(403);
    requestHeaders = new Headers();
    sessionUser = { id: userId, login: "mia", name: "Mia", image: null };
    try {
      const list = (await (await tokensGet(new Request("http://localhost:3700/api/tokens"))).json()) as { tokens: { id: string; lastMcpSeenAt: string | null; lastMcpCallAt: string | null }[] };
      const dto = list.tokens.find((t) => t.id === fresh.id)!;
      expect(dto.lastMcpSeenAt).toMatch(/^\d{4}-/);
      expect(dto.lastMcpCallAt).toMatch(/^\d{4}-/);
    } finally {
      sessionUser = null;
    }
  });

  it("does not mark an authenticated tools/list request as connected when HTTP negotiation rejects it", async () => {
    const fresh = await createApiToken(userId, "Rejected client", 30);
    const res = await call("POST", {
      headers: { "Content-Type": "application/json", Accept: "application/json", ...bearer(fresh.token) },
      body: rpc("tools/list"),
    });
    expect(res.status).toBe(406);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = (await listApiTokens(userId)).find((t) => t.id === fresh.id)!;
    expect(row.lastMcpSeenAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();
    expect(hasConnected({
      lastMcpSeenAt: row.lastMcpSeenAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })).toBe(false);
  });
});

describe("/api/mcp", () => {
  it.each(["development", "production"] as const)("uses a loopback callback when canonical origins are absent in %s", (nodeEnv) => {
    expect(mcpRestOrigin({ NODE_ENV: nodeEnv, PORT: "3812" })).toBe("http://127.0.0.1:3812");
  });

  it("accepts configured http(s) origins and gives the internal origin precedence", () => {
    expect(mcpRestOrigin({ MARKDOC_URL: "https://public.example" })).toBe("https://public.example");
    expect(mcpRestOrigin({ MARKDOC_INTERNAL_URL: "http://markdoc.internal:8080", MARKDOC_URL: "https://public.example" })).toBe("http://markdoc.internal:8080");
  });

  it.each([
    ["MARKDOC_INTERNAL_URL", "file:///tmp/markdoc"],
    ["MARKDOC_INTERNAL_URL", "http://markdoc.internal/base"],
    ["MARKDOC_URL", "https://user@public.example"],
    ["MARKDOC_URL", "https://public.example?proxy=1"],
    ["MARKDOC_URL", "https://public.example#proxy"],
  ] as const)("rejects unsafe %s value %s", (variable, value) => {
    expect(() => mcpRestOrigin({ [variable]: value })).toThrow(new RegExp(`${variable} must be an http\\(s\\) origin`));
  });

  it("fails closed before fetch when a configured callback origin is invalid", async () => {
    process.env.MARKDOC_INTERNAL_URL = "http://trusted.example/not-an-origin";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call("POST", {
        headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, ...bearer(token) },
        body: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }),
      });
      expect(res.status).toBe(500);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      fetchSpy.mockRestore();
      delete process.env.MARKDOC_INTERNAL_URL;
    }
  });

  it("GET without MCP headers answers a small JSON card (no auth needed)", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string; tools: number; docs: string; auth: string };
    expect(body.name).toBe("markdoc");
    expect(body.tools).toBe(listToolNames().length);
    expect(body.tools).toBe(27);
    expect(body.docs).toContain("docs/agents");
    expect(body.auth).toContain("Authorization: Bearer <token>");
    expect(body.auth).toContain("AI agents → Create access key");
  });

  it("GET as an SSE stream and DELETE are 405 (stateless transport), with or without a token", async () => {
    for (const headers of [{ Accept: "text/event-stream" }, { Accept: "text/event-stream", ...bearer(token) }]) {
      const res = await call("GET", { headers });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
      expect(((await res.json()) as { error: string }).error).toBe("Method Not Allowed");
    }
    for (const headers of [{}, bearer(token)]) {
      const res = await call("DELETE", { headers });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
      expect(((await res.json()) as { error: string }).error).toBe("Method Not Allowed");
    }
  });

  it("POST without a token is 401 and says where to create one", async () => {
    const res = await call("POST", { headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT }, body: rpc("tools/list") });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; settings: string };
    expect(body.error).toContain("Authorization: Bearer <token> is required.");
    expect(body.error).toContain("AI agents → Create access key");
    expect(body.error).toContain("send it as Authorization: Bearer <token>");
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
    const body = (await res.json()) as { jsonrpc: string; id: number; result: { tools: { name: string; description: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }[] } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(listToolNames());
    expect(names).toContain("markdoc_whoami");
    expect(names).toContain("markdoc_read_document");
    expect(names).toContain("markdoc_presence");
    expect(names).toContain("markdoc_watch");
    // The HTTP transport carries the same annotations as stdio (see annotations.test.ts for the sets).
    for (const t of body.result.tools) {
      expect(typeof t.annotations?.readOnlyHint, `${t.name}.annotations`).toBe("boolean");
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    expect(body.result.tools.find((t) => t.name === "markdoc_read_document")?.annotations?.readOnlyHint).toBe(true);
    expect(body.result.tools.find((t) => t.name === "markdoc_suggest")?.annotations?.readOnlyHint).toBe(false);
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

  it("tool calls without canonical configuration use the loopback PORT with the caller's token", async () => {
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
      expect(seen).toEqual([{ url: "http://127.0.0.1:3700/api/me", auth: ["Bearer", token].join(" ") }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("host and forwarding headers cannot redirect read or write tools from the configured origin", async () => {
    process.env.MARKDOC_INTERNAL_URL = "https://markdoc.internal:8443";
    const seen: { url: string; method: string; auth: string | null }[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      const data = url.endsWith("/api/me")
        ? { user: { id: "u1", login: "mia", name: "Mia" }, agent: "Copilot CLI" }
        : { document: { id: "d1", title: "Trusted" } };
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    });
    const hostile = {
      Host: "ignored-host.invalid:9999",
      "X-Forwarded-Host": "public.example:9443",
      "X-Forwarded-Proto": "https",
      Forwarded: 'for=192.0.2.1;host="forwarded.invalid:8888";proto=http',
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      ...bearer(token),
    };
    try {
      const read = await call("POST", { headers: hostile, body: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }) });
      const write = await call("POST", {
        headers: hostile,
        body: rpc("tools/call", { name: "markdoc_create_document", arguments: { title: "Trusted", content: "# Trusted" } }),
      });
      expect(read.status).toBe(200);
      expect(write.status).toBe(200);
      const readBody = (await read.json()) as { result: { content: { text: string }[] } };
      const writeBody = (await write.json()) as { result: { content: { text: string }[]; structuredContent: { url: string } } };
      expect(readBody.result.content[0].text).toContain("Server: https://public.example:9443");
      expect(writeBody.result.content[0].text).toContain("https://public.example:9443/d/d1");
      expect(writeBody.result.structuredContent.url).toBe("https://public.example:9443/d/d1");
      expect(seen).toEqual([
        { url: "https://markdoc.internal:8443/api/me", method: "GET", auth: ["Bearer", token].join(" ") },
        { url: "https://markdoc.internal:8443/api/documents", method: "POST", auth: ["Bearer", token].join(" ") },
      ]);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.MARKDOC_INTERNAL_URL;
    }
  });

  it("sends no request to a hostile forwarded host through the real network stack", async () => {
    let captureRequests = 0;
    let trustedRequests = 0;
    const capture = createServer((_req, res) => {
      captureRequests++;
      res.writeHead(500).end();
    });
    const trusted = createServer((req, res) => {
      trustedRequests++;
      expect(req.url).toBe("/api/me");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user: { id: "u1", login: "mia", name: "Mia" }, agent: "Copilot CLI" }));
    });
    const [capturePort, trustedPort] = await Promise.all([listen(capture), listen(trusted)]);
    process.env.MARKDOC_INTERNAL_URL = `http://127.0.0.1:${trustedPort}`;
    try {
      const res = await call("POST", {
        headers: {
          Host: `127.0.0.1:${capturePort}`,
          "X-Forwarded-Host": `127.0.0.1:${capturePort}`,
          "X-Forwarded-Proto": "http",
          Forwarded: `for=192.0.2.1;host="127.0.0.1:${capturePort}";proto=http`,
          "Content-Type": "application/json",
          Accept: MCP_ACCEPT,
          ...bearer(token),
        },
        body: rpc("tools/call", { name: "markdoc_whoami", arguments: {} }),
      });
      expect(res.status).toBe(200);
      expect(trustedRequests).toBe(1);
      expect(captureRequests).toBe(0);
    } finally {
      delete process.env.MARKDOC_INTERNAL_URL;
      await Promise.all([close(capture), close(trusted)]);
    }
  });
});
