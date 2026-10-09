import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer, describeIssues } from "../../../../mcp/tools.mjs";

/**
 * What a model sees when a REST call behind a tool fails (#121): the zod `issues` of a 400 must
 * reach the tool error text (otherwise a 3 MB create is just "Invalid request"), and a 409 from
 * `restore` on a live document must be `isError`, never `Restored "…"`.
 */
const reply = (status: number, data: unknown, type = "application/json") => new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers: { "Content-Type": type } });

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (method === "POST" && url.pathname === "/api/documents") {
    const body = JSON.parse(String(init?.body)) as { content?: string; title?: string };
    if ((body.content ?? "").length > 2_000_000) {
      return reply(400, {
        error: "Invalid request",
        issues: [
          { code: "too_big", maximum: 2000000, path: ["content"], message: "Too big: expected string to have <=2000000 characters" },
          { code: "custom", path: ["title"], message: "second issue" },
        ],
      });
    }
    // The route trims the title and wants ≥ 1 character — a bound the tool's schema cannot know, so it is REST's 400 to explain.
    if (body.title !== undefined && !body.title.trim()) return reply(400, { error: "Invalid request", issues: [{ code: "too_small", minimum: 1, path: ["title"], message: "Too small: expected string to have >=1 characters" }] });
    return reply(201, { document: { id: "doc-1", title: "New", updatedAt: "2026-08-25T00:00:00.000Z" } });
  }
  if (method === "POST" && url.pathname === "/api/documents/live-1/restore") return reply(409, { error: "Document is not in the trash" });
  if (method === "POST" && url.pathname === "/api/documents/trashed-1/restore") return reply(200, { ok: true, document: { id: "trashed-1", title: "Back" } });
  if (url.pathname === "/api/documents/doc-1/content" && method === "GET") {
    return reply(200, { content: "# Plan\n\nFirst.\n", clean: "# Plan\n\nFirst.\n", title: "Plan", contentHash: "a".repeat(64), pendingSuggestions: 0, openComments: 0 });
  }
  if (url.pathname === "/api/documents/doc-1/content" && method === "PUT") {
    const body = JSON.parse(String(init?.body)) as { ifContentHash?: string };
    if (body.ifContentHash && body.ifContentHash !== "b".repeat(64)) {
      return reply(409, { error: "Document changed since you read it", contentHash: "b".repeat(64), diff: "@@ -1,3 +1,5 @@\n # Plan\n \n First.\n+\n+The human's new sentence.", truncated: false });
    }
    return reply(200, { ok: true, changed: true, contentHash: "c".repeat(64) });
  }
  if (url.pathname === "/api/documents/doc-1/content" && method === "PATCH") {
    const body = JSON.parse(String(init?.body)) as { append: string; ifContentHash?: string };
    if (body.ifContentHash && body.ifContentHash !== "b".repeat(64)) return reply(409, { error: "Document changed since you read it", contentHash: "b".repeat(64), diff: null, truncated: false });
    return reply(200, { ok: true, contentHash: "d".repeat(64) });
  }
  if (url.pathname === "/api/documents/doc-1/suggest" && method === "POST") {
    const body = JSON.parse(String(init?.body)) as { ifContentHash?: string };
    if (body.ifContentHash && body.ifContentHash !== "b".repeat(64)) return reply(409, { error: "Document changed since you read it", contentHash: "b".repeat(64), diff: null, truncated: false });
    return reply(200, { ok: true, suggestions: 2, suggestionIds: ["s1", "s2"], contentHash: "b".repeat(64) });
  }
  // Large writes take turns (#2341): the server has no place for this one right now.
  if (url.pathname === "/api/documents/busy-1/content" || url.pathname === "/api/documents/busy-1/suggest") {
    return new Response(JSON.stringify({ error: "You already have 2 document writes in progress. Wait for one to finish, then try again", retryAfter: 5 }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "5" } });
  }
  if (url.pathname === "/api/nope") return reply(404, "<!DOCTYPE html><html>not json</html>", "text/html");
  // A linked document whose GitHub file is over the 2 MB bound: sync, pull and a plain publish are 413s.
  if (url.pathname.startsWith("/api/documents/big-1/")) {
    const unreadable = {
      error: "The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB",
      status: "remote-unreadable",
      size: 3_801_362,
      limit: 2_097_152,
      remote: { sha: "4ce1359b", revision: "4ce1359b", url: "https://github.com/o/r/blob/main/big.md", updatedAt: null },
    };
    if (url.pathname.endsWith("/publish") && url.searchParams.get("force") === "1") {
      return reply(200, { result: { url: "https://github.com/o/r/blob/main/big.md", commitSha: "c1", publishedAt: "2026-08-27T00:00:00.000Z", status: "in-sync" }, document: null });
    }
    return reply(413, unreadable);
  }
  return reply(404, { error: "Not found" });
};

describe("describeIssues", () => {
  it("formats the first issue's path and message and counts the rest", () => {
    expect(describeIssues(undefined)).toBe("");
    expect(describeIssues([])).toBe("");
    expect(describeIssues([{ path: ["content"], message: "Too big" }])).toBe(" — content: Too big");
    expect(describeIssues([{ path: ["edits", 0, "find"], message: "Required" }, { path: [], message: "x" }])).toBe(" — edits.0.find: Required (+1 more)");
    expect(describeIssues([{ path: [], message: "Invalid discriminator" }])).toBe(" — body: Invalid discriminator");
  });
});

describe("createClient errors", () => {
  const client = createClient({ baseUrl: "http://markdoc.test", token: "mdk_test", fetch: fakeFetch });

  it("a 400 with zod issues says which field and why", async () => {
    const err = await client.post("/api/documents", { content: "x".repeat(2_000_001) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("POST /api/documents failed (400): Invalid request — content: Too big: expected string to have <=2000000 characters (+1 more)");
    expect((err as Error & { status: number }).status).toBe(400);
  });

  it("a non-JSON error body is reported as text, without a parse error", async () => {
    const err = (await client.get("/api/nope").catch((e: Error) => e)) as Error;
    expect(err.message).toContain("GET /api/nope failed (404): <!DOCTYPE html>");
  });
});

describe("tools over a real MCP client", () => {
  let mcp: Client;
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

  beforeAll(async () => {
    const server = createMarkdocServer(createClient({ baseUrl: "http://markdoc.test", token: "mdk_test", fetch: fakeFetch }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientTransport);
  });

  afterAll(async () => {
    await mcp.close();
  });

  it("markdoc_create_document with a 3 MB body is an error that names `content` and the cap — from the tool's own schema (the REST bound, #1304), before any request", async () => {
    const res = (await mcp.callTool({ name: "markdoc_create_document", arguments: { content: "x".repeat(3_000_000) } })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Input validation error");
    expect(text(res)).toContain("Too big: expected string to have <=2000000 characters at content");
  });

  it("a REST 400 with zod issues the tool could not foresee still names the field and why", async () => {
    const res = (await mcp.callTool({ name: "markdoc_create_document", arguments: { title: "   ", content: "# Hi\n" } })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("failed (400): Invalid request — title: Too small");
  });

  it("markdoc_restore_document on a live document is an error, not Restored", async () => {
    const live = (await mcp.callTool({ name: "markdoc_restore_document", arguments: { id: "live-1" } })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(live.isError).toBe(true);
    expect(text(live)).toContain("failed (409): Document is not in the trash");
    expect(text(live)).not.toContain("Restored");

    const trashed = (await mcp.callTool({ name: "markdoc_restore_document", arguments: { id: "trashed-1" } })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(trashed.isError).toBeFalsy();
    expect(text(trashed)).toContain('Restored "Back"');
  });

  type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> };

  it("markdoc_read_document puts the contentHash in the header line and structured content", async () => {
    const res = (await mcp.callTool({ name: "markdoc_read_document", arguments: { id: "doc-1" } })) as Result;
    expect(res.isError).toBeFalsy();
    expect(text(res).split("\n")[0]).toBe(`# Plan (id doc-1, hash ${"a".repeat(64)}) — 0 pending suggestion(s), 0 open comment(s)`);
    expect(res.structuredContent?.contentHash).toBe("a".repeat(64));
  });

  it("markdoc_replace_content with a stale ifContentHash is an error that says what changed; a current one succeeds", async () => {
    const stale = (await mcp.callTool({ name: "markdoc_replace_content", arguments: { id: "doc-1", content: "# Plan\n\nRewritten.\n", ifContentHash: "a".repeat(64) } })) as Result;
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("changed since you read it");
    expect(text(stale)).toContain("re-read and retry");
    expect(text(stale)).toContain("+The human's new sentence.");
    expect(text(stale)).toContain("b".repeat(64));
    expect(stale.structuredContent?.contentHash).toBe("b".repeat(64));

    const fresh = (await mcp.callTool({ name: "markdoc_replace_content", arguments: { id: "doc-1", content: "# Plan\n\nRewritten.\n", ifContentHash: "b".repeat(64) } })) as Result;
    expect(fresh.isError).toBeFalsy();
    expect(text(fresh)).toContain(`updated (hash ${"c".repeat(64)})`);
    expect(fresh.structuredContent?.contentHash).toBe("c".repeat(64));
  });

  it("a large write that is refused because the server is busy says so plainly: nothing was written, wait, send it again (#2341)", async () => {
    const want = "Nothing was written: You already have 2 document writes in progress. Wait for one to finish, then try again. Wait 5 seconds, then send the same call again.";
    for (const [name, args] of [
      ["markdoc_replace_content", { id: "busy-1", content: "# Large\n" }],
      ["markdoc_append", { id: "busy-1", markdown: "more" }],
      ["markdoc_suggest", { id: "busy-1", content: "# Large\n" }],
    ] as const) {
      const res = (await mcp.callTool({ name, arguments: args })) as Result;
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toBe(want);
      expect(res.structuredContent?.retryAfter, name).toBe(5);
    }
  });

  it("markdoc_append with a stale ifContentHash is an error that says to re-read; a current one (or none) appends", async () => {
    const stale = (await mcp.callTool({ name: "markdoc_append", arguments: { id: "doc-1", markdown: "\nLate paragraph.", ifContentHash: "a".repeat(64) } })) as Result;
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Document changed since you read it");
    expect(text(stale)).toContain("re-read and retry");
    expect(text(stale)).not.toContain("Appended");
    expect(stale.structuredContent?.contentHash).toBe("b".repeat(64));

    const fresh = (await mcp.callTool({ name: "markdoc_append", arguments: { id: "doc-1", markdown: "\nLate paragraph.", ifContentHash: "b".repeat(64) } })) as Result;
    expect(fresh.isError).toBeFalsy();
    expect(text(fresh)).toContain(`Appended to doc-1 (hash ${"d".repeat(64)})`);
    expect(fresh.structuredContent?.contentHash).toBe("d".repeat(64));

    const unconditional = (await mcp.callTool({ name: "markdoc_append", arguments: { id: "doc-1", markdown: "\nLate paragraph." } })) as Result;
    expect(unconditional.isError).toBeFalsy();
    expect(text(unconditional)).toContain("Appended to doc-1");
  });

  it("markdoc_suggest with a stale ifContentHash is an error even without a diff; a current one succeeds", async () => {
    const stale = (await mcp.callTool({ name: "markdoc_suggest", arguments: { id: "doc-1", edits: [{ find: "First", replace: "1st" }], ifContentHash: "a".repeat(64) } })) as Result;
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("changed since you read it");
    expect(text(stale)).toContain("re-read the document");

    const fresh = (await mcp.callTool({ name: "markdoc_suggest", arguments: { id: "doc-1", edits: [{ find: "First", replace: "1st" }], ifContentHash: "b".repeat(64) } })) as Result;
    expect(fresh.isError).toBeFalsy();
    expect(text(fresh)).toContain("Proposed 2 change(s)");
  });

  it("a GitHub file over the 2 MB bound is remote-unreadable: status answers, pull and plain publish are errors, force-publish goes through", async () => {
    const status = (await mcp.callTool({ name: "markdoc_sync_status", arguments: { id: "big-1" } })) as Result;
    expect(status.isError).toBeFalsy();
    expect(text(status)).toContain("remote-unreadable: The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB");
    expect(text(status)).toContain("force: true");
    expect(status.structuredContent?.status).toBe("remote-unreadable");
    expect(status.structuredContent?.size).toBe(3_801_362);

    const pull = (await mcp.callTool({ name: "markdoc_pull", arguments: { id: "big-1", force: true } })) as Result;
    expect(pull.isError).toBe(true);
    expect(text(pull)).toContain("failed (413): The file on GitHub is 3.63 MB");
    expect(text(pull)).toContain("cannot be compared or pulled");
    expect(text(pull)).not.toContain("Pulled");

    const publish = (await mcp.callTool({ name: "markdoc_publish", arguments: { id: "big-1" } })) as Result;
    expect(publish.isError).toBe(true);
    expect(text(publish)).toContain("failed (413): The file on GitHub is 3.63 MB");
    expect(text(publish)).toContain("force: true");

    const forced = (await mcp.callTool({ name: "markdoc_publish", arguments: { id: "big-1", force: true } })) as Result;
    expect(forced.isError).toBeFalsy();
    expect(text(forced)).toContain("Published.");
  });
});
