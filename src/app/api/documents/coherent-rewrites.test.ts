import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, createMarkdocServer } from "../../../../mcp/tools.mjs";
import { LONG_PASSAGE_PREFIX, LONG_PASSAGE_SUFFIX, REWRITE_AFTER, REWRITE_AUTHOR, REWRITE_BEFORE, REWRITE_DOCUMENT, REWRITE_PREFIX, REWRITE_RESULT, UNPLANNABLE_PASSAGES } from "@/editor/collab/rewrite.test-fixture";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { makeCollabUser } from "@/editor/collab/shared";
import type { Actor } from "@/server/http";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;
// Every call here is one signed-in user, so all of them share one bucket (#2323); this file is not about limits.
process.env.RATE_LIMIT = "off";

let actor: Actor;
vi.mock("@/auth", () => ({ auth: async () => ({ user: actor }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/http")>();
  return {
    ...actual,
    requireAccess: async (...args: Parameters<typeof actual.requireAccess>) => {
      const access = await actual.requireAccess(...args);
      return { ...access, user: { ...access.user!, agent: actor.agent } };
    },
  };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { readLiveDoc, mutateLiveDoc } = await import("@/server/livedoc");
const suggest = await import("./[id]/suggest/route");
const review = await import("./[id]/suggestions/route");
const content = await import("./[id]/content/route");

let client: Client;
let server: ReturnType<typeof createMarkdocServer>;
let docId: string;
const fetchRoutes: typeof fetch = async (input, init) => {
  const req = new Request(String(input), init);
  const path = new URL(req.url).pathname;
  const ctx = { params: Promise.resolve({ id: docId }) };
  if (path === `/api/documents/${docId}/suggest`) return suggest.POST(req, ctx);
  if (path === `/api/documents/${docId}/suggestions`) return req.method === "POST" ? review.POST(req, ctx) : review.GET(req, ctx);
  if (path === `/api/documents/${docId}/content`) return content.GET(req, ctx);
  throw new Error("Unexpected synthetic request");
};

beforeAll(async () => {
  const db = await getDb();
  const [owner] = await db.insert(schema.users).values({ name: "Garden Reviewer", login: "garden-reviewer", email: "garden@example.test" }).returning();
  actor = { id: owner.id, name: owner.name, login: owner.login, image: null, agent: REWRITE_AUTHOR };
  server = createMarkdocServer(createClient({ baseUrl: "http://synthetic.invalid", token: randomUUID(), fetch: fetchRoutes }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "synthetic-rewrite", version: "1" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

async function tool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { id: docId, ...args } });
  return result as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
}

const fresh = async (text = REWRITE_DOCUMENT) => {
  actor.agent = REWRITE_AUTHOR;
  docId = (await createDocument({ ownerId: actor.id, title: "Synthetic passage review", content: text })).id;
};
const read = async () => (await tool("markdoc_read_document", {})).structuredContent!;

describe("MCP -> real REST -> persisted tracked replacement", () => {
  it.each(["accept", "reject"] as const)("one MCP %s decides a whole shared-word rewrite", async (action) => {
    await fresh();
    const proposed = await tool("markdoc_suggest", { edits: [{ find: REWRITE_BEFORE, replace: REWRITE_AFTER }] });
    expect(proposed.isError).toBeFalsy();
    expect(proposed.structuredContent).toMatchObject({ suggestions: 1, suggestionIds: [expect.any(String)] });
    const [id] = proposed.structuredContent!.suggestionIds as string[];
    const listed = await tool("markdoc_suggestions", {});
    expect(listed.structuredContent).toMatchObject({ suggestions: [{ id, type: "replace", before: REWRITE_BEFORE, after: REWRITE_AFTER, author: REWRITE_AUTHOR, authorId: `agent:${actor.id}:${REWRITE_AUTHOR}`, outdated: false }] });
    expect(listed.content[0].text).toContain(JSON.stringify(REWRITE_BEFORE));
    expect(listed.content[0].text).toContain(JSON.stringify(REWRITE_AFTER));
    expect((await read()).pendingSuggestions).toBe(1);
    const stored = await readLiveDoc(docId, (doc) => {
      const model = new SuggestionsModel(doc, doc.getText("content"));
      try {
        return model.groups().map((group) => ({ id: group.id, runs: group.members.length }));
      } finally {
        model.destroy();
      }
    });
    expect(stored).toEqual([{ id, runs: 2 }]);
    const decided = await tool("markdoc_review_suggestions", { action, suggestionId: id });
    expect(decided.structuredContent).toMatchObject({ decided: 1, suggestionId: id });
    expect((await read()).content).toBe(action === "accept" ? REWRITE_RESULT : REWRITE_DOCUMENT);
    expect((await read()).pendingSuggestions).toBe(0);
    expect((await tool("markdoc_review_suggestions", { action, suggestionId: id })).isError).toBe(true);
  });

  it("full-content input preserves the same paragraph boundary", async () => {
    await fresh();
    expect((await tool("markdoc_suggest", { content: REWRITE_RESULT })).structuredContent).toMatchObject({ suggestions: 1 });
    const listed = (await tool("markdoc_suggestions", {})).structuredContent!.suggestions as { from: number; before: string; after: string }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ from: REWRITE_PREFIX.length, before: REWRITE_BEFORE, after: REWRITE_AFTER });
  });

  it("refuses overlapping pending ranges and a stale review without partial writes", async () => {
    await fresh();
    const proposed = await tool("markdoc_suggest", { content: REWRITE_RESULT });
    const [id] = proposed.structuredContent!.suggestionIds as string[];
    const before = (await read()).content;
    const overlap = await tool("markdoc_suggest", { edits: [{ find: "The opening", replace: "An opening" }, { find: REWRITE_BEFORE, replace: "Another rewrite." }] });
    expect(overlap.isError).toBe(true);
    expect((await read()).content).toBe(before);
    await mutateLiveDoc(docId, { userId: actor.id, docId, role: "editor", name: "Human", login: actor.login ?? null, avatar: null }, (doc) => {
      doc.getText("content").insert(REWRITE_PREFIX.length + 5, "HUMAN ");
    });
    const concurrent = (await read()).content;
    for (const action of ["accept", "reject"]) {
      const result = await tool("markdoc_review_suggestions", { action, suggestionId: id });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("overlaps a newer edit");
      expect((await read()).content).toBe(concurrent);
    }
  });

  it("keeps distinct actors and calls separate while rejecting only one", async () => {
    await fresh();
    const first = await tool("markdoc_suggest", { edits: [{ find: "opening", replace: "beginning" }] });
    actor.agent = "Other Garden Assistant";
    const second = await tool("markdoc_suggest", { edits: [{ find: "closing", replace: "ending" }] });
    const a = (first.structuredContent!.suggestionIds as string[])[0];
    const b = (second.structuredContent!.suggestionIds as string[])[0];
    expect(a).not.toBe(b);
    expect((await read()).pendingSuggestions).toBe(2);
    await tool("markdoc_review_suggestions", { action: "reject", suggestionId: a });
    expect((await read()).pendingSuggestions).toBe(1);
    await tool("markdoc_review_suggestions", { action: "accept", suggestionId: b });
    expect((await read()).content).toBe(REWRITE_DOCUMENT.replace("closing", "ending"));
  });

  it("keeps two targeted edits in one call independently reviewable", async () => {
    await fresh();
    const result = await tool("markdoc_suggest", { edits: [{ find: "opening", replace: "beginning" }, { find: "closing", replace: "ending" }] });
    expect(result.structuredContent).toMatchObject({ suggestions: 2 });
    const ids = result.structuredContent!.suggestionIds as string[];
    expect(ids).toHaveLength(2);
    await tool("markdoc_review_suggestions", { action: "accept", suggestionId: ids[0] });
    await tool("markdoc_review_suggestions", { action: "reject", suggestionId: ids[1] });
    expect((await read()).content).toBe(REWRITE_DOCUMENT.replace("opening", "beginning"));
  });

  it.each(["content", "targeted"] as const)("keeps an oversized single-line %s proposal narrow through real route decisions", async (mode) => {
    const before = LONG_PASSAGE_PREFIX + "\ud83c\udf31" + LONG_PASSAGE_SUFFIX;
    const after = LONG_PASSAGE_PREFIX + "\ud83c\udf33" + LONG_PASSAGE_SUFFIX;
    for (const action of ["accept", "reject"] as const) {
      await fresh(before);
      await mutateLiveDoc(docId, { userId: actor.id, docId, role: "editor", name: "Human", login: actor.login ?? null, avatar: null }, (doc) => {
        const model = new SuggestionsModel(doc, doc.getText("content"));
        try {
          model.applyEdit({ from: 2, to: 4, insert: "" }, makeCollabUser(actor.id, "Human"));
        } finally {
          model.destroy();
        }
      });
      const proposal = await tool("markdoc_suggest", mode === "content" ? { content: after } : { edits: [{ find: before, replace: after }] });
      expect(proposal.isError).toBeFalsy();
      expect(proposal.structuredContent).toMatchObject({ suggestions: 1 });
      const [id] = proposal.structuredContent!.suggestionIds as string[];
      const listed = (await tool("markdoc_suggestions", {})).structuredContent!.suggestions as { id: string; from: number; to: number; before: string; after: string }[];
      expect(listed).toHaveLength(2);
      expect(listed[1].from).toBe(LONG_PASSAGE_PREFIX.length);
      expect(listed[1].to - listed[1].from).toBe(4);
      expect(listed[1]).toMatchObject({ id, type: "replace", before: "\ud83c\udf31", after: "\ud83c\udf33", author: REWRITE_AUTHOR, outdated: false });
      await mutateLiveDoc(docId, { userId: actor.id, docId, role: "editor", name: "Human", login: actor.login ?? null, avatar: null }, (doc) => {
        doc.getText("content").insert(5, "Human note.");
      });
      const decided = await tool("markdoc_review_suggestions", { action, suggestionId: id });
      expect(decided.isError).toBeFalsy();
      expect(decided.structuredContent).toMatchObject({ decided: 1 });
      const expected = action === "accept" ? after : before;
      expect((await read()).content).toBe(expected.slice(0, 5) + "Human note." + expected.slice(5));
      expect((await read()).pendingSuggestions).toBe(1);
      expect((await tool("markdoc_suggestions", {})).structuredContent!.suggestions).toEqual([
        expect.objectContaining({ id: listed[0].id, authorId: actor.id, type: "delete", from: 2, to: 4, text: "LL", context: expect.stringContaining("Human note.") }),
      ]);
    }
  });

  it.each(UNPLANNABLE_PASSAGES)("returns 422 for $reason before any proposal mutation", async ({ before, after }) => {
    const prefix = "Candidate line.\n\n";
    await fresh(prefix + before);
    const original = await readLiveDoc(docId, (doc) => Y.encodeStateAsUpdate(doc));
    for (const body of [
      { content: prefix.replace("Candidate", "Revised") + after },
      { edits: [{ find: "Candidate", replace: "Revised" }, { find: before, replace: after }] },
    ]) {
      const response = await suggest.POST(new Request(`http://synthetic.invalid/api/documents/${docId}/suggest`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: docId }) });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("too large to group safely") });
      expect(await readLiveDoc(docId, (doc) => Y.encodeStateAsUpdate(doc))).toEqual(original);
      expect((await read()).content).toBe(prefix + before);
      expect((await read()).pendingSuggestions).toBe(0);
    }
  });
});
