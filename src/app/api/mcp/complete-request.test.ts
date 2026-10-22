import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer } from "@/lib/mcp-tools.mjs";

/**
 * `markdoc_complete_request` must say only what the server did (#1232, audit #1202 Q5): the REST route answers
 * `{ request, notified, alreadyDone, warnings? }` and the tool's sentence is derived from those flags rather
 * than assumed. `markdoc_comment` resolve/reopen passes the route's body through as `structuredContent` so a
 * `warnings` array is not lost, and (since #1304) says it in the text too. The REST routes are faked with the bodies they produce (see
 * src/server/agent-requests.test.ts and comments-api.test.ts for the real ones) and the tool result is read
 * through a real MCP client.
 */
type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
let nextCompleteBody: Record<string, unknown> = {};
let nextCommentBody: Record<string, unknown> = { ok: true };

const request = (over: Record<string, unknown> = {}) => ({
  id: "req-1",
  documentId: "doc-1",
  status: "done",
  mode: "suggest",
  instruction: "Tighten the intro",
  result: { suggestions: 2, comments: 1, summary: "Tightened it." },
  ...over,
});

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname.endsWith("/complete") && init?.method === "POST") return reply(200, nextCompleteBody);
  if (url.pathname.endsWith("/comments") && init?.method === "POST") return reply(200, nextCommentBody);
  return reply(404, { error: "Not found" });
};

let client: Client;
type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
};
const complete = (body: Record<string, unknown>) => {
  nextCompleteBody = body;
  return call("markdoc_complete_request", { documentId: "doc-1", requestId: "req-1", summary: "Tightened it." });
};

beforeAll(async () => {
  const server = createMarkdocServer(createClient({ baseUrl: "http://markdoc.test", token: "mdk_test", fetch: fakeFetch }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
});

describe("markdoc_complete_request", () => {
  it("says the requester has been notified only when the route says so, and hands the whole body back", async () => {
    const body = { request: request(), notified: true, alreadyDone: false };
    const res = await complete(body);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Request req-1 is done: 2 suggestion(s), 1 comment(s). The requester has been notified.");
    expect(res.text).not.toContain("Warnings");
    expect(res.text).not.toContain("Already completed");
    expect(res.structuredContent).toEqual(body);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/documents/doc-1/requests/req-1/complete", body: { summary: "Tightened it." } });
  });

  it("a requester with no account to notify is said so, not 'notified'", async () => {
    const res = await complete({ request: request(), notified: false, alreadyDone: false });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("The requester was not notified (no account to notify).");
    expect(res.text).not.toContain("has been notified");
    expect(res.text).not.toContain("Warnings");
  });

  it("a notification that could not be written is named as the reason and listed under Warnings", async () => {
    const body = { request: request(), notified: false, alreadyDone: false, warnings: ["notification-not-sent"] };
    const res = await complete(body);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("The requester was not notified (the notification could not be written).");
    expect(res.text).toContain("Warnings: notification-not-sent.");
    expect(res.structuredContent).toEqual(body);
  });

  it("a request that was already done is reported as such (the retry after a crash), with the notification state", async () => {
    const again = await complete({ request: request(), notified: true, alreadyDone: true });
    expect(again.text).toContain("Already completed earlier; notification re-sent if it was missing.");
    expect(again.text).not.toContain("was not notified");

    const nobody = await complete({ request: request({ result: null }), notified: false, alreadyDone: true });
    expect(nobody.text).toContain("Request req-1 is done: 0 suggestion(s), 0 comment(s). Already completed earlier; notification re-sent if it was missing. The requester was not notified (no account to notify).");
  });
});

describe("markdoc_comment resolve/reopen", () => {
  it("passes the route's body (with its warnings) through as structuredContent and names them in the text", async () => {
    nextCommentBody = { ok: true, warnings: ["activity-not-recorded"] };
    const res = await call("markdoc_comment", { id: "doc-1", action: "resolve", threadId: "t1" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Thread t1 resolved. Warnings: activity-not-recorded.");
    expect(res.structuredContent).toEqual({ ok: true, warnings: ["activity-not-recorded"] });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/documents/doc-1/comments", body: { action: "resolve", threadId: "t1", resolved: true } });

    nextCommentBody = { ok: true };
    const plain = await call("markdoc_comment", { id: "doc-1", action: "reopen", threadId: "t1" });
    expect(plain.text).toBe("Thread t1 reopened.");
    expect(plain.structuredContent).toEqual({ ok: true });
  });
});
