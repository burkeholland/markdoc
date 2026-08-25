import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer } from "../../../../mcp/tools.mjs";

/**
 * `markdoc_review_suggestions` must not say "done" when nothing was decided: a model that forgot
 * `suggestionId` or mistyped it would otherwise believe the human's suggestion was applied. `acceptAll` /
 * `rejectAll` with nothing pending is the one exception: an idempotent no-op that answers plain success
 * with `decided: 0`, so a "make sure nothing is pending" call is not a failure to retry. The
 * REST route is faked here with the answers it gives (see documents/suggestions.test.ts for the
 * real ones), and the tool result is read through a real MCP client so `isError` is what a model sees.
 */
type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
const pendingIds = new Set(["sug-1", "sug-2"]);

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (!url.pathname.endsWith("/suggestions") || init?.method !== "POST") return reply(404, { error: "Not found" });
  const { action, id } = body as { action: string; id?: string };
  if (action === "accept" || action === "reject") {
    if (!id) return reply(400, { error: "`id` is required for accept/reject" });
    if (!pendingIds.has(id)) return reply(404, { error: "Suggestion not found" });
    pendingIds.delete(id);
    return reply(200, { ok: true, decided: 1, id });
  }
  const decided = pendingIds.size;
  pendingIds.clear();
  return reply(200, { ok: true, decided });
};

let client: Client;
const review = async (args: Record<string, unknown>) => {
  const res = (await client.callTool({ name: "markdoc_review_suggestions", arguments: { id: "doc-1", ...args } })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
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

describe("markdoc_review_suggestions", () => {
  it("accept without suggestionId is an error and never reaches the server", async () => {
    const before = calls.length;
    const res = await review({ action: "accept" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("`suggestionId` is required");
    expect(calls.length).toBe(before);
  });

  it("accept with an unknown suggestionId surfaces the 404 as an error", async () => {
    const res = await review({ action: "accept", suggestionId: "bogus" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Suggestion not found");
    expect(res.text).not.toContain("done");
    expect(pendingIds.size).toBe(2);
  });

  it("reject with an unknown suggestionId surfaces the 404 as an error", async () => {
    const res = await review({ action: "reject", suggestionId: "bogus" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Suggestion not found");
    expect(pendingIds.size).toBe(2);
  });

  it("a valid suggestionId is decided and the answer names it", async () => {
    const res = await review({ action: "accept", suggestionId: "sug-1" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Accepted suggestion sug-1 on doc-1.");
    expect(res.structuredContent).toEqual({ ok: true, action: "accept", decided: 1, suggestionId: "sug-1" });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/documents/doc-1/suggestions", body: { action: "accept", id: "sug-1" } });
    expect(pendingIds.has("sug-1")).toBe(false);
  });

  it("rejectAll reports the count, and a second rejectAll with nothing pending is a plain no-op success", async () => {
    const res = await review({ action: "rejectAll" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Rejected 1 suggestion(s) on doc-1.");
    expect(res.structuredContent).toEqual({ ok: true, action: "rejectAll", decided: 1 });
    expect(calls.at(-1)?.body).toEqual({ action: "rejectAll" });

    const nothing = await review({ action: "rejectAll" });
    expect(nothing.isError).toBeFalsy();
    expect(nothing.text).toBe("Nothing to decide on doc-1 (0 pending).");
    expect(nothing.structuredContent).toEqual({ ok: true, action: "rejectAll", decided: 0 });
  });

  it("acceptAll with nothing pending is the same idempotent no-op", async () => {
    const res = await review({ action: "acceptAll" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toBe("Nothing to decide on doc-1 (0 pending).");
    expect(res.structuredContent).toEqual({ ok: true, action: "acceptAll", decided: 0 });
  });
});
