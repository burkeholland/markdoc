import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer } from "../../../../mcp/tools.mjs";

/**
 * The REST write routes answer `2xx` + top-level `warnings: string[]` when the change landed but a follow-up
 * record (activity row, notification, request link, mentions, version) did not; the key is absent when nothing
 * failed. Every MCP write tool must say so in its **text** — the only part most clients show the model — and
 * keep the same array in `structuredContent.warnings` (#1304). Also covered here, from the docs sweep (#1212):
 * the folded request-thread reply of `markdoc_comment`, `markdoc_suggest` with `content: ""` / both inputs,
 * `markdoc_list_documents` with `trash` and `starred` together, and the input-schema bounds that mirror the
 * REST routes (so `tools/list` tells the model the cap instead of a 400 it has to decode). The REST routes are
 * faked with the bodies they produce (see the route tests for the real ones) and the tool results are read
 * through a real MCP client.
 */
type Call = { method: string; path: string; body: unknown };
const calls: Call[] = [];
/** The JSON body the next write route answers with; every test sets it right before the call. */
let nextBody: Record<string, unknown> = {};

const WARNINGS = ["activity-not-recorded", "notification-not-sent"];
const WARNING_TEXT = "Warnings: activity-not-recorded, notification-not-sent.";

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path: url.pathname, body });
  const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/documents" && method === "GET") return reply(200, { documents: [] });
  if (method === "PUT" || method === "PATCH" || method === "POST") return reply(200, nextBody);
  return reply(404, { error: "Not found" });
};

let client: Client;
type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (name: string, args: Record<string, unknown>, body?: Record<string, unknown>) => {
  if (body) nextBody = body;
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { ...res, text: res.content.map((c) => c.text).join("\n") };
};

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

const request = { id: "req-1", documentId: "doc-1", status: "done", mode: "suggest", instruction: "Tighten the intro", result: { suggestions: 2, comments: 1, summary: "Tightened it." } };
const review = { id: "rev-1", documentId: "doc-1", verdict: "comment", summary: "Fine.", commentIds: ["t1"] };

/**
 * One row per write-tool text: the tool call, the REST body it is answered with (without `warnings`), the REST
 * call it must make and the sentence it says. `urlLast` marks the one tool whose text keeps the document URL
 * after the warnings (`markdoc_complete_request`, unchanged wording from #1232).
 */
const WRITES: { name: string; tool: string; args: Record<string, unknown>; body: Record<string, unknown>; rest: { method: string; path: string }; says: string; urlLast?: boolean }[] = [
  {
    name: "markdoc_replace_content",
    tool: "markdoc_replace_content",
    args: { id: "doc-1", content: "# New\n" },
    body: { ok: true, changed: true, contentHash: "c".repeat(64) },
    rest: { method: "PUT", path: "/api/documents/doc-1/content" },
    says: `Document doc-1 updated (hash ${"c".repeat(64)}). http://markdoc.test/d/doc-1`,
  },
  {
    name: "markdoc_append",
    tool: "markdoc_append",
    args: { id: "doc-1", markdown: "\nMore.\n" },
    body: { ok: true, contentHash: "d".repeat(64) },
    rest: { method: "PATCH", path: "/api/documents/doc-1/content" },
    says: `Appended to doc-1 (hash ${"d".repeat(64)}). http://markdoc.test/d/doc-1`,
  },
  {
    name: "markdoc_suggest",
    tool: "markdoc_suggest",
    args: { id: "doc-1", edits: [{ find: "First.", replace: "First!" }] },
    body: { ok: true, suggestions: 2, suggestionIds: ["s1", "s2"], contentHash: "b".repeat(64) },
    rest: { method: "POST", path: "/api/documents/doc-1/suggest" },
    says: "Proposed 2 change(s) on doc-1. Reviewers can accept or reject them at http://markdoc.test/d/doc-1",
  },
  {
    name: "markdoc_comment add",
    tool: "markdoc_comment",
    args: { id: "doc-1", action: "add", quote: "First.", body: "Really?" },
    body: { id: "t2" },
    rest: { method: "POST", path: "/api/documents/doc-1/comments" },
    says: 'Commented on "First." (thread t2).',
  },
  {
    name: "markdoc_comment reply",
    tool: "markdoc_comment",
    args: { id: "doc-1", action: "reply", threadId: "t1", body: "Done." },
    body: { id: "r2" },
    rest: { method: "POST", path: "/api/documents/doc-1/comments" },
    says: "Replied to thread t1.",
  },
  {
    name: "markdoc_comment resolve",
    tool: "markdoc_comment",
    args: { id: "doc-1", action: "resolve", threadId: "t1" },
    body: { ok: true },
    rest: { method: "POST", path: "/api/documents/doc-1/comments" },
    says: "Thread t1 resolved.",
  },
  {
    name: "markdoc_comment reopen",
    tool: "markdoc_comment",
    args: { id: "doc-1", action: "reopen", threadId: "t1" },
    body: { ok: true },
    rest: { method: "POST", path: "/api/documents/doc-1/comments" },
    says: "Thread t1 reopened.",
  },
  {
    name: "markdoc_review",
    tool: "markdoc_review",
    args: { id: "doc-1", summary: "Fine.", comments: [{ quote: "First.", body: "Tighten this." }] },
    body: { review },
    rest: { method: "POST", path: "/api/documents/doc-1/reviews" },
    says: "Review rev-1 posted on doc-1: comment, 1 comment(s), 0 suggestion(s). People can accept them at http://markdoc.test/d/doc-1",
  },
  {
    name: "markdoc_review_suggestions accept",
    tool: "markdoc_review_suggestions",
    args: { id: "doc-1", action: "accept", suggestionId: "sug-1" },
    body: { ok: true, decided: 1, id: "sug-1" },
    rest: { method: "POST", path: "/api/documents/doc-1/suggestions" },
    says: "Accepted suggestion sug-1 on doc-1.",
  },
  {
    name: "markdoc_review_suggestions rejectAll",
    tool: "markdoc_review_suggestions",
    args: { id: "doc-1", action: "rejectAll" },
    body: { ok: true, decided: 2 },
    rest: { method: "POST", path: "/api/documents/doc-1/suggestions" },
    says: "Rejected 2 suggestion(s) on doc-1.",
  },
  {
    name: "markdoc_review_suggestions acceptAll with nothing pending",
    tool: "markdoc_review_suggestions",
    args: { id: "doc-1", action: "acceptAll" },
    body: { ok: true, decided: 0 },
    rest: { method: "POST", path: "/api/documents/doc-1/suggestions" },
    says: "Nothing to decide on doc-1 (0 pending).",
  },
  {
    name: "markdoc_publish",
    tool: "markdoc_publish",
    args: { id: "doc-1", message: "Publish" },
    body: { result: { url: "https://github.com/o/r/blob/main/a.md", commitSha: "c1", publishedAt: "2026-08-31T00:00:00.000Z", status: "in-sync" }, document: null },
    rest: { method: "POST", path: "/api/documents/doc-1/publish" },
    says: "Published. https://github.com/o/r/blob/main/a.md",
  },
  {
    name: "markdoc_publish already up to date",
    tool: "markdoc_publish",
    args: { id: "doc-1" },
    body: { result: { skipped: true, url: "https://github.com/o/r/blob/main/a.md", status: "in-sync" }, document: null },
    rest: { method: "POST", path: "/api/documents/doc-1/publish" },
    says: "Already up to date on GitHub.",
  },
  {
    name: "markdoc_pull",
    tool: "markdoc_pull",
    args: { id: "doc-1" },
    body: { result: { changed: true, url: "https://github.com/o/r/blob/main/a.md", status: "in-sync" }, document: null },
    rest: { method: "POST", path: "/api/documents/doc-1/pull" },
    says: "Pulled the latest version from GitHub.",
  },
  {
    name: "markdoc_complete_request",
    tool: "markdoc_complete_request",
    args: { documentId: "doc-1", requestId: "req-1", summary: "Tightened it." },
    body: { request, notified: false, alreadyDone: false },
    rest: { method: "POST", path: "/api/documents/doc-1/requests/req-1/complete" },
    says: "Request req-1 is done: 2 suggestion(s), 1 comment(s).",
    urlLast: true,
  },
];

describe("write tools surface the REST `warnings` in their text and structuredContent", () => {
  for (const w of WRITES) {
    it(`${w.name}: with warnings the text ends with them and structuredContent.warnings is the same array`, async () => {
      const res = await call(w.tool, w.args, { ...w.body, warnings: WARNINGS });
      expect(res.isError).toBeFalsy();
      expect(res.text).toContain(WARNING_TEXT);
      if (w.urlLast) expect(res.text).toMatch(/Warnings: activity-not-recorded, notification-not-sent\. http:\/\/markdoc\.test\/d\/doc-1$/);
      else expect(res.text).toMatch(/Warnings: activity-not-recorded, notification-not-sent\.$/);
      expect(res.text).toContain(w.says);
      expect(res.structuredContent?.warnings).toEqual(WARNINGS);
      expect(calls.at(-1)).toMatchObject(w.rest);
    });

    it(`${w.name}: without warnings the text has no "Warnings:" and structuredContent has no warnings key`, async () => {
      const res = await call(w.tool, w.args, w.body);
      expect(res.isError).toBeFalsy();
      expect(res.text).toContain(w.says);
      expect(res.text).not.toContain("Warnings:");
      expect(res.structuredContent).toBeDefined();
      expect(res.structuredContent).not.toHaveProperty("warnings");
    });
  }

  it("the warnings text is one sentence per call: a single code has no trailing comma", async () => {
    const res = await call("markdoc_append", { id: "doc-1", markdown: "x" }, { ok: true, contentHash: "d".repeat(64), warnings: ["version-not-saved"] });
    expect(res.text).toMatch(/\/d\/doc-1 Warnings: version-not-saved\.$/);
    expect(res.structuredContent?.warnings).toEqual(["version-not-saved"]);
  });

  it("an empty warnings array is treated as none", async () => {
    const res = await call("markdoc_append", { id: "doc-1", markdown: "x" }, { ok: true, contentHash: "d".repeat(64), warnings: [] });
    expect(res.text).not.toContain("Warnings:");
  });
});

describe("markdoc_comment add folded into a request thread", () => {
  it("says it replied into the request's thread when the route answers { id, threadId, folded: true }", async () => {
    const res = await call("markdoc_comment", { id: "doc-1", action: "add", quote: "First.", body: "Done.", requestId: "req-1" }, { id: "r1", threadId: "t1", folded: true });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("request thread t1");
    expect(res.text).toContain("reply r1");
    expect(res.text).toBe("Replied into request thread t1 (reply r1) — the request's own thread is where this comment belongs.");
    expect(res.structuredContent).toEqual({ id: "r1", threadId: "t1", folded: true });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/documents/doc-1/comments", body: { action: "add", quote: "First.", body: "Done.", requestId: "req-1" } });
  });

  it("a folded add with warnings carries them after the folded sentence", async () => {
    const res = await call("markdoc_comment", { id: "doc-1", action: "add", quote: "First.", body: "Done.", requestId: "req-1" }, { id: "r1", threadId: "t1", folded: true, warnings: ["request-not-attached"] });
    expect(res.text).toBe("Replied into request thread t1 (reply r1) — the request's own thread is where this comment belongs. Warnings: request-not-attached.");
    expect(res.structuredContent?.warnings).toEqual(["request-not-attached"]);
  });

  it("a plain add still says thread <id>", async () => {
    const res = await call("markdoc_comment", { id: "doc-1", action: "add", quote: "First.", body: "Really?" }, { id: "t2" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("thread t2");
    expect(res.text).not.toContain("request thread");
    expect(res.structuredContent).toEqual({ id: "t2" });
  });
});

describe("markdoc_suggest inputs", () => {
  it("content: \"\" is a legal body (it proposes deleting the text) and is sent as content: \"\"", async () => {
    const res = await call("markdoc_suggest", { id: "doc-1", content: "" }, { ok: true, suggestions: 1, suggestionIds: ["s1"], contentHash: "b".repeat(64) });
    expect(res.isError).toBeFalsy();
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/documents/doc-1/suggest", body: { content: "" } });
    expect(res.text).toContain("Proposed 1 change(s) on doc-1.");
  });

  it("content and edits together are refused before any request", async () => {
    const before = calls.length;
    const res = await call("markdoc_suggest", { id: "doc-1", content: "# New\n", edits: [{ find: "a", replace: "b" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Provide either `content` or `edits`, not both.");
    expect(calls.length).toBe(before);
  });

  it("neither content nor edits is refused before any request", async () => {
    const before = calls.length;
    const res = await call("markdoc_suggest", { id: "doc-1" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Provide `content` or `edits`.");
    expect(calls.length).toBe(before);

    const empty = await call("markdoc_suggest", { id: "doc-1", edits: [] });
    expect(empty.isError).toBe(true);
    expect(calls.length).toBe(before);
  });
});

describe("markdoc_list_documents", () => {
  it("trash and starred together are refused before any request", async () => {
    const before = calls.length;
    const res = await call("markdoc_list_documents", { trash: true, starred: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Provide either `trash` or `starred`, not both.");
    expect(calls.length).toBe(before);
  });

  it("either alone still lists", async () => {
    const trash = await call("markdoc_list_documents", { trash: true });
    expect(trash.isError).toBeFalsy();
    expect(trash.text).toBe("The trash is empty.");
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/documents" });
    const starred = await call("markdoc_list_documents", { starred: true });
    expect(starred.text).toBe("No starred documents.");
  });
});

describe("input schemas mirror the REST bounds", () => {
  type Schema = { properties?: Record<string, Schema>; items?: Schema; maxLength?: number; minLength?: number; maxItems?: number; minItems?: number; required?: string[] };
  let schemas: Record<string, Schema>;

  beforeAll(async () => {
    const { tools } = await client.listTools();
    schemas = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema as Schema]));
  });

  it("markdoc_suggest: edits 1–200 with a non-empty find, content ≤ 2 000 000 characters", () => {
    const p = schemas.markdoc_suggest.properties!;
    expect(p.edits.maxItems).toBe(200);
    expect(p.edits.minItems).toBe(1);
    expect(p.edits.items?.properties?.find.minLength).toBe(1);
    expect(p.content.maxLength).toBe(2_000_000);
  });

  it("markdoc_comment: quote 1–2000, body 1–5000, emoji 1–16", () => {
    const p = schemas.markdoc_comment.properties!;
    expect(p.body.maxLength).toBe(5000);
    expect(p.body.minLength).toBe(1);
    expect(p.quote.maxLength).toBe(2000);
    expect(p.quote.minLength).toBe(1);
    expect(p.emoji.maxLength).toBe(16);
    expect(p.emoji.minLength).toBe(1);
  });

  it("markdoc_review: 1–50 comments with quote 1–2000 and body 1–5000, summary ≤ 5000 and still required", () => {
    const p = schemas.markdoc_review.properties!;
    expect(p.comments.maxItems).toBe(50);
    expect(p.comments.minItems).toBe(1);
    expect(p.comments.items?.properties?.quote.maxLength).toBe(2000);
    expect(p.comments.items?.properties?.quote.minLength).toBe(1);
    expect(p.comments.items?.properties?.body.maxLength).toBe(5000);
    expect(p.comments.items?.properties?.body.minLength).toBe(1);
    expect(p.summary.maxLength).toBe(5000);
    expect(schemas.markdoc_review.required).toContain("summary");
  });

  it("markdoc_create_document: title ≤ 200 (DOCUMENT_TITLE_MAX), template ≤ 64, content ≤ 2 000 000", () => {
    const p = schemas.markdoc_create_document.properties!;
    expect(p.title.maxLength).toBe(200);
    expect(p.template.maxLength).toBe(64);
    expect(p.content.maxLength).toBe(2_000_000);
  });

  it("markdoc_import_text: content ≤ 2 000 000", () => {
    expect(schemas.markdoc_import_text.properties!.content.maxLength).toBe(2_000_000);
  });

  it("an over-long comment body is refused by the tool itself, naming the field and the cap, before any request", async () => {
    const before = calls.length;
    const res = await call("markdoc_comment", { id: "doc-1", action: "reply", threadId: "t1", body: "x".repeat(5001) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("5000");
    expect(res.text).toContain("body");
    expect(calls.length).toBe(before);
  });
});
