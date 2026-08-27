import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Task #698: listings and access checks must not drag `ystate` (and the other bulky columns) out of
// the database, while returning exactly what they returned when they selected every column.
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const { createDocument, deleteDocument, excerpt, EXCERPT_PREFIX_CHARS, getDocumentAccess, getPublishedContent, listDocumentsForUser, listTrashForUser, searchDocumentsForUser, updateDocument, upsertCollaborator } =
  await import("@/server/documents");
const { excerptOf, excerptOfPrefix } = await import("@/editor/stats");
const { publicDocument } = await import("@/server/dto");
const { replaceLiveText } = await import("@/server/livedoc");
const { LONG_DOC, MANY_DOCS, generateLongDoc, rng } = await import("../../e2e/fixtures/burke-scale");
type SessionUser = import("@/server/documents").SessionUser;

let alice: SessionUser;
let bob: SessionUser;
const contents = new Map<string, string>();

/** Documents whose first prose sits past the prefix a listing reads, or that have no prose at all. */
const EDGE_CASES: Record<string, string> = {
  empty: "",
  blankLines: "\n\n\n",
  headingsOnly: Array.from({ length: 80 }, (_, i) => `## Section ${i} of a long outline with nothing under it`).join("\n\n") + "\n",
  longFrontMatter: `---\n${Array.from({ length: 60 }, (_, i) => `key${i}: value number ${i} in a long front matter block`).join("\n")}\n---\n\nProse after the front matter.\n`,
  unclosedFrontMatter: `---\n${Array.from({ length: 60 }, (_, i) => `key${i}: still front matter`).join("\n")}\n`,
  longCodeFirst: `# Code first\n\n\`\`\`ts\n${Array.from({ length: 60 }, (_, i) => `const line${i} = "a fairly long line of code ${i}";`).join("\n")}\n\`\`\`\n\nThe first sentence after the code.\n`,
  oneLongLine: `# One line\n\n${"word ".repeat(400).trim()}\n`,
  oneLongLineNoNewline: `# One line\n\n${"word ".repeat(400).trim()}`,
  shortNoNewline: "# Title\n\nJust a sentence",
  exactlyPrefix: "",
  onePastPrefix: "",
  emoji: `# Emoji\n\n${"🙂 ".repeat(700)}and then text.\n`,
  emojiAtCut: "",
  crlf: "# CRLF\r\n\r\nFirst line.\r\n\r\n" + "Another line with some words in it.\r\n".repeat(60),
  imagesAndLinks: `# Media\n\n![alt one](./a.png) then [a link](https://x.y) and ![alt two](./b.png)\n\n${"More prose here. ".repeat(80)}\n`,
};
{
  const base = "# Exact\n\n";
  const body = (n: number) => "x".repeat(Math.max(0, n - base.length - 1)) + "\n";
  EDGE_CASES.exactlyPrefix = base + body(EXCERPT_PREFIX_CHARS);
  EDGE_CASES.onePastPrefix = base + body(EXCERPT_PREFIX_CHARS + 1);
  // An astral character straddling the boundary: `left()` counts characters, JS `length` code units.
  EDGE_CASES.emojiAtCut = base + "y".repeat(EXCERPT_PREFIX_CHARS - base.length - 1) + "😀 tail of the line\nnext line " + "z".repeat(300) + "\n";
  expect(EDGE_CASES.exactlyPrefix.length).toBe(EXCERPT_PREFIX_CHARS);
  expect(EDGE_CASES.onePastPrefix.length).toBe(EXCERPT_PREFIX_CHARS + 1);
}

beforeAll(async () => {
  const db = await getDb();
  const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice-lean@example.com" }).returning();
  const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob-lean@example.com" }).returning();
  alice = { id: a.id, login: "alice", name: "Alice" };
  bob = { id: b.id, login: "bob", name: "Bob" };
  // The Burke-scale list: hero doc first, the rest as the fixture shapes them (stars, trash, shares).
  for (const spec of MANY_DOCS) {
    const doc = await createDocument({ ownerId: alice.id, title: spec.title, content: spec.content });
    contents.set(doc.id, spec.content);
    if (spec.starred) await db.insert(schema.stars).values({ documentId: doc.id, userId: alice.id, starred: true });
    if (spec.sharedAs) await upsertCollaborator(doc.id, "bob", spec.sharedAs, alice.id);
    if (spec.trashed) await deleteDocument(doc.id);
  }
  for (const [name, content] of Object.entries(EDGE_CASES)) {
    const doc = await createDocument({ ownerId: alice.id, title: `edge ${name}`, content });
    contents.set(doc.id, content);
  }
}, 60_000);

/** Runs `fn` and returns the SQL text of every statement PGlite executed meanwhile. */
async function sqlOf(fn: () => Promise<unknown>): Promise<string[]> {
  const db = await getDb();
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => Promise<unknown> } }).$client;
  const spy = vi.spyOn(client, "query");
  try {
    await fn();
    return spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
}

describe("excerptOfPrefix agrees with excerptOf wherever it answers", () => {
  const cutsFor = (text: string, r: () => number) => {
    const cuts = new Set<number>([0, 1, 2, 10, 100, 500, 999, 1000, 1001, 1500, text.length - 1, text.length, text.length + 5]);
    for (let i = 0; i < 25; i++) cuts.add(Math.floor(r() * (text.length + 2)));
    return [...cuts].filter((n) => n >= 0);
  };

  it("on the Burke-scale documents and the edge cases, at many cut points", () => {
    const r = rng(698);
    const docs = [...MANY_DOCS.map((d) => d.content), ...Object.values(EDGE_CASES), generateLongDoc(7), generateLongDoc(8)];
    let answered = 0;
    let total = 0;
    for (const text of docs) {
      const expected = excerptOf(text, 160);
      for (const n of cutsFor(text, r)) {
        const truncated = text.length > n;
        const got = excerptOfPrefix(text.slice(0, n), truncated, 160);
        total++;
        if (got === null) continue;
        answered++;
        expect(got, `cut at ${n} of ${text.length}`).toBe(expected);
      }
    }
    expect(answered).toBeGreaterThan(total / 3);
  });

  it("answers from the whole text when nothing was cut", () => {
    for (const text of Object.values(EDGE_CASES)) expect(excerptOfPrefix(text, false)).toBe(excerptOf(text));
  });

  it("declines when the prose has not filled the excerpt yet, and when front matter is still open", () => {
    expect(excerptOfPrefix("# T\n\nShort prose.\n", true)).toBeNull();
    expect(excerptOfPrefix("---\ntitle: x\nmore: y\n", true)).toBeNull();
    expect(excerptOfPrefix("# T\n\n```\ncode\n", true)).toBeNull();
    expect(excerptOfPrefix(`# T\n\n${"word ".repeat(60)}\n`, true)).toBe(excerptOf(`# T\n\n${"word ".repeat(60)}\n`));
  });
});

describe("listings return the same summaries as a full read", () => {
  const check = (rows: { id: string; excerpt: string }[]) => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const content = contents.get(row.id);
      expect(content, row.id).toBeDefined();
      expect(row.excerpt, row.id).toBe(excerpt(content!));
    }
  };

  it("owner list, starred list, collaborator list and trash", async () => {
    const all = await listDocumentsForUser(alice);
    expect(all.length).toBe(MANY_DOCS.filter((d) => !d.trashed).length + Object.keys(EDGE_CASES).length);
    check(all);
    check(await listDocumentsForUser(alice, { starred: true }));
    check(await listDocumentsForUser(bob));
    const trash = await listTrashForUser(alice);
    expect(trash.length).toBe(MANY_DOCS.filter((d) => d.trashed).length);
    check(trash);
  });

  it("search, with the snippet cut from the full content", async () => {
    const hits = await searchDocumentsForUser(alice, "release");
    check(hits);
    expect(hits.some((h) => h.snippet !== null)).toBe(true);
  });

  it("reads the full content only for documents whose prefix is inconclusive", async () => {
    const all = await listDocumentsForUser(alice);
    const inconclusive = all.filter((row) => {
      const content = contents.get(row.id)!;
      const head = content.slice(0, EXCERPT_PREFIX_CHARS + 1);
      return excerptOfPrefix(head, content.length > EXCERPT_PREFIX_CHARS) === null;
    });
    expect(inconclusive.map((r) => r.title)).toEqual(expect.arrayContaining(["edge headingsOnly", "edge longFrontMatter", "edge longCodeFirst", "edge oneLongLine"]));
    // Most ordinary documents (a title and a paragraph) are decided from the prefix.
    expect(inconclusive.length).toBeLessThan(all.length / 4);
    const statements = await sqlOf(() => listDocumentsForUser(alice));
    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/^select "id", "content" from "document" where "document"."id" in \(/);
    // Bob's documents all decide from the prefix: one statement, no second read.
    expect(await sqlOf(() => listDocumentsForUser(bob))).toHaveLength(1);
  });
});

describe("the queries leave the bulky columns in the database", () => {
  const onlyBoundedContent = (sql: string) => {
    expect(sql).not.toContain('"ystate"');
    expect(sql).not.toContain("published_content");
    // `content` appears once, inside `left(content, n)` for the excerpt.
    expect(sql.match(/"content"/g) ?? []).toHaveLength(1);
    expect(sql).toMatch(/left\("document"\."content", \$\d+\)/);
  };

  it("listDocumentsForUser and listTrashForUser", async () => {
    for (const fn of [() => listDocumentsForUser(alice), () => listDocumentsForUser(alice, { starred: true }), () => listTrashForUser(alice)]) {
      const [listing] = await sqlOf(fn);
      onlyBoundedContent(listing);
    }
  });

  it("getDocumentAccess, with hasUnpublishedChanges compared in SQL", async () => {
    const heroId = [...contents.entries()].find(([, c]) => c === LONG_DOC)![0];
    for (const user of [alice, bob, null]) {
      const statements = await sqlOf(() => getDocumentAccess(heroId, user));
      const [access] = statements;
      expect(access).not.toContain('"ystate"');
      expect(access).toContain(`("storage" <> 'local' and "published_content" is distinct from "content")`);
      expect(access.match(/"content"/g)).toHaveLength(1);
      expect(access.match(/published_content/g)).toHaveLength(1);
      for (const other of statements.slice(1)) expect(other).not.toMatch(/from "document"/);
    }
  });

  it("searchDocumentsForUser filters and snips on content but reads no ystate or publishedContent", async () => {
    const [search] = await sqlOf(() => searchDocumentsForUser(alice, "release"));
    expect(search).not.toContain('"ystate"');
    expect(search).not.toContain("published_content");
    expect(search).toMatch(/"document"\."content" ilike/);
  });
});

describe("hasUnpublishedChanges from an access row", () => {
  const fullRow = async (id: string) => {
    const db = await getDb();
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
    return row;
  };
  const sameAsFullRow = async (id: string) => {
    const access = (await getDocumentAccess(id, alice))!;
    const fromAccess = publicDocument(access.doc);
    const fromRow = publicDocument(await fullRow(id));
    expect(fromAccess).toEqual(fromRow);
    return fromAccess.hasUnpublishedChanges;
  };

  it("is false for a local document whatever its columns hold", async () => {
    const doc = await createDocument({ ownerId: alice.id, title: "Local", content: "# Local\n\nText.\n" });
    expect(await sameAsFullRow(doc.id)).toBe(false);
    await updateDocument(doc.id, { publishedContent: "something else" });
    expect(await sameAsFullRow(doc.id)).toBe(false);
  });

  it("follows the published copy of a linked document through edits and publishes", async () => {
    const text = "# Linked\n\nFirst.\n";
    const doc = await createDocument({ ownerId: alice.id, title: "Linked", content: text });
    await updateDocument(doc.id, { storage: "repo", repoOwner: "o", repoName: "r", repoBranch: "main", repoPath: "doc.md" });
    // Linked but never published: null base is "different from" any content.
    expect(await sameAsFullRow(doc.id)).toBe(true);
    await updateDocument(doc.id, { publishedContent: text, publishedAt: new Date() });
    expect(await sameAsFullRow(doc.id)).toBe(false);
    const ctx = { userId: alice.id, docId: doc.id, role: "owner" as const, name: "Alice", login: "alice", avatar: null };
    await replaceLiveText(doc.id, ctx, text.replace("First.", "First, edited."));
    expect(await sameAsFullRow(doc.id)).toBe(true);
    await updateDocument(doc.id, { publishedContent: text.replace("First.", "First, edited."), publishedAt: new Date() });
    expect(await sameAsFullRow(doc.id)).toBe(false);
    expect(await getPublishedContent(doc.id)).toBe(text.replace("First.", "First, edited."));
    expect(await getPublishedContent("no-such-document")).toBeNull();
  });
});
