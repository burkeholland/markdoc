import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer } from "../../../../mcp/tools.mjs";

/**
 * Addressed agent requests (#1296): `markdoc_list_requests` names the addressee of each request
 * (`for @login/slug (Name)`) and who claimed it (`Name @login`), and `markdoc_whoami` tells the token whether
 * other users may address requests to it. The REST routes are faked with the bodies they produce (the real ones
 * are covered by src/server/agent-requests-addressing.test.ts and src/app/api/tokens/collaborators-may-ask.test.ts).
 */
type Call = { method: string; path: string };
const calls: Call[] = [];
let nextRequests: Record<string, unknown>[] = [];
let nextMe: Record<string, unknown> = {};

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search });
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/agent/requests") return reply(200, { requests: nextRequests });
  if (url.pathname === "/api/me") return reply(200, nextMe);
  return reply(404, { error: "Not found" });
};

let client: Client;
type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
};

const request = (over: Record<string, unknown> = {}) => ({
  id: "req-1",
  documentId: "doc-1",
  documentTitle: "Shared",
  userId: "u-bob",
  userName: "Bob",
  userLogin: "bob",
  instruction: "Tighten the intro",
  selection: null,
  threadId: "t-1",
  agent: { login: "alice", slug: "copilot" },
  agentName: "Copilot",
  mode: "suggest",
  status: "open",
  claimedBy: null,
  claimedByLogin: null,
  result: null,
  createdAt: "2026-08-31T23:00:00.000Z",
  updatedAt: "2026-08-31T23:00:00.000Z",
  ...over,
});

beforeAll(async () => {
  const server = createMarkdocServer(createClient({ baseUrl: "http://markdoc.test", token: "mdk_test", fetch: fakeFetch }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("markdoc_list_requests with addressees", () => {
  it("names the addressee of each request and the login of whoever claimed it; unaddressed rows name nobody", async () => {
    nextRequests = [
      request(),
      request({ id: "req-2", status: "claimed", claimedBy: "Copilot", claimedByLogin: "alice", agent: { login: "alice", slug: "copilot" } }),
      request({ id: "req-3", userName: "Alice", userLogin: "alice", agent: null, agentName: null }),
    ];
    const res = await call("markdoc_list_requests", {});
    expect(res.isError).toBeFalsy();
    expect(calls.at(-1)).toEqual({ method: "GET", path: "/api/agent/requests" });
    const lines = res.text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[req-1] open · suggest · "Shared" (document doc-1) · from Bob · for @alice/copilot (Copilot) · 2026-08-31T23:00:00.000Z · thread t-1');
    expect(lines[1]).toContain("[req-2] claimed (Copilot @alice) · suggest");
    expect(lines[1]).toContain(" · for @alice/copilot (Copilot) · ");
    expect(lines[2]).toContain('[req-3] open · suggest · "Shared" (document doc-1) · from Alice · 2026-08-31T23:00:00.000Z');
    expect(lines[2]).not.toContain(" · for @");
    expect(res.structuredContent).toEqual({ requests: nextRequests });
  });

  it("passes status and limit through and says when there is nothing to do", async () => {
    nextRequests = [];
    const res = await call("markdoc_list_requests", { status: "claimed", limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(calls.at(-1)).toEqual({ method: "GET", path: "/api/agent/requests?status=claimed&limit=5" });
    expect(res.text).toBe("No claimed requests. Nothing to do right now.");
  });
});

describe("markdoc_whoami and the collaborators-may-ask switch", () => {
  const me = (collaboratorsMayAsk: boolean) => ({
    user: { id: "u-alice", login: "alice", name: "Alice", image: null },
    agent: "Copilot",
    agentMention: { slug: "copilot", unique: true },
    scope: "full",
    documentIds: null,
    collaboratorsMayAsk,
    webhooks: [],
  });

  it("says only the owner may ask when the switch is off, and that others may when it is on", async () => {
    nextMe = me(false);
    const locked = await call("markdoc_whoami");
    expect(locked.isError).toBeFalsy();
    expect(locked.text).toContain('Acting as Alice (alice) via agent "Copilot" with full scope.');
    expect(locked.text).toContain('Only its owner may address requests to it as @alice/copilot (the owner can switch "collaborators may ask" on with PATCH /api/tokens/:id).');

    nextMe = me(true);
    const open = await call("markdoc_whoami");
    expect(open.text).toContain('Other users may address requests to it as @alice/copilot (the owner switched "collaborators may ask" on).');
    expect(open.text).not.toContain("Only its owner");
    expect(open.structuredContent).toEqual(me(true));
  });
});
