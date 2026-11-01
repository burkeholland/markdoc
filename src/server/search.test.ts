import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { searchDocumentsForUser, contentSnippet } = await import("./documents");
type SessionUser = import("./documents").SessionUser;

describe("searchDocumentsForUser", () => {
  let alice: SessionUser;
  let bob: SessionUser;

  beforeAll(async () => {
    const db = await getDb();
    const [a] = await db.insert(schema.users).values({ name: "Alice", login: "alice", email: "alice@example.com" }).returning();
    const [b] = await db.insert(schema.users).values({ name: "Bob", login: "bob", email: "bob@example.com" }).returning();
    alice = { id: a.id, login: "alice" };
    bob = { id: b.id, login: "bob" };

    const old = new Date("2024-01-01T00:00:00Z");
    const recent = new Date("2024-06-01T00:00:00Z");
    await db.insert(schema.documents).values([
      // Title hit, older.
      { id: "s-title", title: "Pelican migration notes", ownerId: a.id, content: "# Pelican migration notes\n\nNothing about birds in the body.", updatedAt: old },
      // Content hit only, more recent.
      {
        id: "s-body",
        title: "Weekly status",
        ownerId: a.id,
        content:
          "# Weekly status\n\nThe first paragraph talks about something else entirely and goes on for a while so the snippet has to be cut.\n\nLater on we mention the   PELICAN   project\nacross lines and then keep writing more and more text so that the tail is truncated as well.",
        updatedAt: recent,
      },
      // Bob's, shared with Alice: content hit.
      { id: "s-shared", title: "Bob's shared plan", ownerId: b.id, content: "# Bob's shared plan\n\nBring a pelican to the party.", updatedAt: old },
      // Bob's, private: must never show for Alice.
      { id: "s-private", title: "Bob's private pelican", ownerId: b.id, content: "# Secret\n\npelican pelican pelican", updatedAt: recent },
    ]);
    await db.insert(schema.collaborators).values({ documentId: "s-shared", login: "alice", role: "viewer", addedBy: b.id });
  });

  it("matches title or content, case-insensitively, only in documents the user can see", async () => {
    const hits = await searchDocumentsForUser(alice, "pelican");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("s-title");
    expect(ids).toContain("s-body");
    expect(ids).toContain("s-shared");
    expect(ids).not.toContain("s-private");
    expect(hits.find((h) => h.id === "s-shared")?.role).toBe("viewer");
  });

  it("ranks title matches before content matches, then by most recent", async () => {
    const hits = await searchDocumentsForUser(alice, "PELICAN");
    expect(hits.map((h) => h.id)).toEqual(["s-title", "s-body", "s-shared"]);
  });

  it("returns a snippet around the first content match with ellipses on truncated ends", async () => {
    const hits = await searchDocumentsForUser(alice, "pelican");
    const body = hits.find((h) => h.id === "s-body")!;
    expect(body.snippet).not.toBeNull();
    expect(body.snippet!.toLowerCase()).toContain("pelican");
    expect(body.snippet).toContain("the PELICAN project across lines");
    expect(body.snippet!.startsWith("…")).toBe(true);
    expect(body.snippet!.endsWith("…")).toBe(true);
    expect(body.snippet!.length).toBeLessThanOrEqual(140);

    const title = hits.find((h) => h.id === "s-title")!;
    expect(title.snippet).not.toBeNull(); // title text is also in the content's heading
    const titleOnly = await searchDocumentsForUser(alice, "migration notes");
    expect(titleOnly.map((h) => h.id)).toEqual(["s-title"]);
  });

  it("gives title-only matches a null snippet", async () => {
    const db = await getDb();
    await db.insert(schema.documents).values({ id: "s-title-only", title: "Flamingo roster", ownerId: alice.id, content: "# Roster\n\nNo birds here." });
    const hits = await searchDocumentsForUser(alice, "flamingo");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toBeNull();
  });

  it("returns nothing for queries shorter than two characters", async () => {
    expect(await searchDocumentsForUser(alice, "p")).toEqual([]);
    expect(await searchDocumentsForUser(alice, "  p  ")).toEqual([]);
    expect(await searchDocumentsForUser(alice, "")).toEqual([]);
  });

  it("treats LIKE wildcards literally", async () => {
    expect(await searchDocumentsForUser(alice, "%%")).toEqual([]);
    expect(await searchDocumentsForUser(alice, "__")).toEqual([]);
  });

  it("respects the limit", async () => {
    const hits = await searchDocumentsForUser(alice, "pelican", { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("s-title");
  });

  it("does not show Bob Alice's documents", async () => {
    const hits = await searchDocumentsForUser(bob, "pelican");
    expect(hits.map((h) => h.id).sort()).toEqual(["s-private", "s-shared"]);
  });
});

describe("contentSnippet", () => {
  it("returns the whole text without ellipses when it is short", () => {
    expect(contentSnippet("# Hi\n\nA  short\nnote about cats.", "cats")).toBe("Hi A short note about cats.");
  });

  it("returns readable snippets without Markdown block or inline syntax", () => {
    const markdown = [
      "# Meeting notes",
      "",
      "## Decisions",
      "",
      "- Revisit **mobile** layout with [the design team](https://example.test).",
      "",
      "```ts",
      "const plan = ready;",
      "```",
    ].join("\n");

    expect(contentSnippet(markdown, "revisit mobile")).toBe(
      "Meeting notes Decisions Revisit mobile layout with the design team. const plan = ready;",
    );
  });

  it("returns null when there is no match", () => {
    expect(contentSnippet("nothing here", "dogs")).toBeNull();
  });
});
