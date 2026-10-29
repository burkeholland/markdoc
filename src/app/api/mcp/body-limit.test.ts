import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;
delete process.env.MARKDOC_URL;
delete process.env.MARKDOC_INTERNAL_URL;
process.env.PORT = "3700";

let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken } = await import("@/server/tokens");
const { POST } = await import("./route");
const { MCP_MAX_REQUEST_BODY_BYTES } = await import("@/server/mcp-body");

/** The tools' own bound on a document's text (mcp/tools.mjs, the REST routes). */
const MAX_CHARACTERS = 2_000_000;
const URL_ = "http://127.0.0.1:3700/api/mcp";
let token: string;

const headers = () => new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: ["Bearer", token].join(" ") });
const post = (body: BodyInit, init: RequestInit = {}) => {
  const h = headers();
  requestHeaders = h;
  return POST(new Request(URL_, { method: "POST", headers: h, body, ...init }));
};
const rpc = (method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
/** A tools/list request padded with JSON whitespace to exactly `size` bytes. */
const paddedTo = (size: number) => {
  const core = rpc("tools/list");
  return core.slice(0, -1) + " ".repeat(size - bytes(core)) + "}";
};

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Mia", login: "mia", email: "mia@example.com" }).returning();
  token = (await createApiToken(user.id, "Copilot CLI", 30)).token;
});

describe("/api/mcp request body bound (#2289)", () => {
  it.each([
    ["ASCII", "a"],
    ["a three-byte script (CJK)", "漢"],
  ])("creates and replaces a document at the tools' 2,000,000-character limit in %s", async (_name, ch) => {
    const content = ch.repeat(MAX_CHARACTERS);
    const sent: number[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push((JSON.parse(String(init?.body)) as { content: string }).content.length);
      return new Response(JSON.stringify({ document: { id: "d1", title: "Big" }, changed: true, contentHash: "h" }), { headers: { "Content-Type": "application/json" } });
    });
    try {
      for (const [name, args] of [
        ["markdoc_create_document", { title: "Big", content }],
        ["markdoc_replace_content", { id: "d1", content }],
      ] as const) {
        const body = rpc("tools/call", { name, arguments: args });
        expect(bytes(body)).toBeLessThanOrEqual(MCP_MAX_REQUEST_BODY_BYTES);
        const res = await post(body);
        expect(res.status).toBe(200);
        const json = (await res.json()) as { result: { isError?: boolean } };
        expect(json.result.isError).toBeFalsy();
      }
      expect(sent).toEqual([MAX_CHARACTERS, MAX_CHARACTERS]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts a body of exactly the bound", async () => {
    const body = paddedTo(MCP_MAX_REQUEST_BODY_BYTES);
    expect(bytes(body)).toBe(MCP_MAX_REQUEST_BODY_BYTES);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0);
  });

  it("refuses one byte more with a 413 that says what was too big, and keeps serving", async () => {
    const res = await post(paddedTo(MCP_MAX_REQUEST_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };
    expect(json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    expect(json.error.message).toContain("MCP request body is over 8,388,608 bytes (8 MiB)");
    expect(json.error.message).toContain("2,000,000 characters");

    const after = await post(rpc("tools/list"));
    expect(after.status).toBe(200);
  });

  it("stops reading a streamed body without Content-Length soon after the bound", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // An endless body: the route must give up, not buffer it all.
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await post(stream, { duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("8,388,608 bytes");
    // The read stops within a few chunks of the bound (the stream may have queued a couple ahead).
    expect(pulled).toBeLessThan(MCP_MAX_REQUEST_BODY_BYTES + 4 * chunk.byteLength);
  });
});
