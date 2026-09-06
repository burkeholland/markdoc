import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as suggestions.test.ts: the routes resolve the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request. `actor` is swapped to play two users.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so one test can make the version insert fail like a `(document_id, number)` collision would.
vi.mock("@/server/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents")>();
  return { ...actual, addVersion: vi.fn(actual.addVersion) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, addVersion, listVersions } = await import("@/server/documents");
const content = await import("@/app/api/documents/[id]/content/route");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const suggestions = await import("@/app/api/documents/[id]/suggestions/route");

type User = { id: string; login: string; name: string; image: null };
type ContentBody = { content: string; clean: string; contentHash: string };
type Conflict = { error: string; contentHash: string; diff: string | null; truncated: boolean };

/**
 * Optimistic concurrency for agent writes (#123): a write that carries the hash it read must be
 * refused — with a diff of what moved — when someone edited the document in between, and land
 * normally when the hash is current.
 */
describe("ifContentHash / If-Match on PUT /content, PATCH /content and POST /suggest", () => {
  let agent: User;
  let human: User;
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [a] = await db.insert(schema.users).values({ name: "Agent", login: "agent-ifmatch", email: "agent-ifmatch@example.com" }).returning();
    const [h] = await db.insert(schema.users).values({ name: "Human", login: "human-ifmatch", email: "human-ifmatch@example.com" }).returning();
    agent = { id: a.id, login: "agent-ifmatch", name: "Agent", image: null };
    human = { id: h.id, login: "human-ifmatch", name: "Human", image: null };
  });

  const ctx = () => ({ params: Promise.resolve({ id: docId }) });
  const url = (path = "content") => `http://localhost:3700/api/documents/${docId}/${path}`;
  const call = (fn: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, method: string, body: unknown, path = "content", headers: Record<string, string> = {}) =>
    fn(new Request(url(path), { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } }), ctx());
  const read = async () => (await (await content.GET(new Request(url()), ctx())).json()) as ContentBody;

  /** A fresh two-paragraph document owned by the human, shared with the agent as an editor. */
  const freshDoc = async () => {
    const db = await getDb();
    const doc = await createDocument({ ownerId: human.id, title: "Plan", content: "# Plan\n\nFirst paragraph here.\n\nSecond paragraph.\n" });
    docId = doc.id;
    await db.insert(schema.collaborators).values({ documentId: doc.id, login: agent.login, role: "editor", addedBy: human.id });
  };

  it("a stale hash is a 409 with the current hash and a diff of what moved; nothing is written", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1, clean: seen } = await read();
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    actor = human;
    const appended = await call(content.PATCH, "PATCH", { append: "The human's new sentence." });
    expect(appended.status).toBe(200);

    actor = agent;
    const stale = await call(content.PUT, "PUT", { content: seen.replace("Second paragraph.", "Second paragraph, rewritten by the agent."), ifContentHash: h1 });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as Conflict;
    expect(body.error).toBe("Document changed since you read it");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.contentHash).not.toBe(h1);
    expect(body.diff).toContain("+The human's new sentence.");
    expect(body.truncated).toBe(false);

    const after = await read();
    expect(after.clean).toContain("The human's new sentence.");
    expect(after.clean).not.toContain("rewritten by the agent");
    expect(after.contentHash).toBe(body.contentHash);
  });

  it("the current hash lets the write through and the response carries the new hash", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1, clean } = await read();
    const res = await call(content.PUT, "PUT", { content: clean.replace("Second paragraph.", "Second paragraph, rewritten."), ifContentHash: h1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean; contentHash: string };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.contentHash).not.toBe(h1);
    expect((await read()).contentHash).toBe(body.contentHash);

    // Retrying with the returned hash works: the 200 hash is the one to carry forward.
    const again = await call(content.PUT, "PUT", { content: clean.replace("Second paragraph.", "Second paragraph, rewritten twice."), ifContentHash: body.contentHash });
    expect(again.status).toBe(200);
  });

  /**
   * The text is live the moment the diff is applied, so a version row that cannot be written afterwards
   * (a `(document_id, number)` collision with the collab auto-version or another agent) must not turn into a
   * 500: the agent would have no hash, and its same-content retry with the hash it read would be a 409.
   */
  it("a version that cannot be saved is a warning on the 200, not a 500: the text is live, the hash is returned and the same-hash retry is a no-op", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1, clean } = await read();
    const versionsBefore = (await listVersions(docId)).length;
    const next = clean.replace("Second paragraph.", "Second paragraph, versioned by the agent.");

    vi.mocked(addVersion).mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "versions_document_id_number_idx"'));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let res: Response;
    let logged: unknown[][];
    try {
      res = await call(content.PUT, "PUT", { content: next, message: "Agent rewrite", ifContentHash: h1 });
      logged = errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[content]"));
    } finally {
      errors.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; changed: boolean; contentHash: string; warnings?: string[] };
    expect(body).toEqual({ ok: true, changed: true, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), warnings: ["version-not-saved"] });
    expect(body.contentHash).not.toBe(h1);
    expect(logged).toEqual([["[content] version-not-saved", expect.any(Error)]]);

    const after = await read();
    expect(after.clean).toBe(next);
    expect(after.contentHash).toBe(body.contentHash);
    expect((await listVersions(docId)).length).toBe(versionsBefore);

    // The retry an agent makes with the hash it was given lands as a no-op — not the 409 a 500 would have led to.
    const retry = await call(content.PUT, "PUT", { content: next, message: "Agent rewrite", ifContentHash: body.contentHash });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, changed: false, contentHash: body.contentHash });
    expect((await listVersions(docId)).length).toBe(versionsBefore);

    // A version that saves normally still does, without warnings.
    const named = await call(content.PUT, "PUT", { content: next + "\nClosing line.\n", message: "Second rewrite", ifContentHash: body.contentHash });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ ok: true, changed: true, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await listVersions(docId)).map((v) => v.title)).toContain("Second rewrite");
  });

  it("If-Match header (quoted) works like the body field; a weak W/ tag never matches (RFC 9110)", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1, clean } = await read();

    actor = human;
    await call(content.PATCH, "PATCH", { append: "Typed meanwhile." });

    actor = agent;
    const stale = await call(content.PUT, "PUT", { content: clean }, "content", { "If-Match": `"${h1}"` });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as Conflict).diff).toContain("+Typed meanwhile.");

    const { contentHash: h2, clean: clean2 } = await read();
    const weak = await call(content.PUT, "PUT", { content: clean + "\nAgent line.\n" }, "content", { "If-Match": `W/"${h2}"` });
    expect(weak.status).toBe(409);
    const weakBody = (await weak.json()) as Conflict;
    expect(weakBody.error).toBe("Document changed since you read it");
    expect(weakBody.contentHash).toBe(h2);
    expect((await read()).clean).toBe(clean2);

    const strong = await call(content.PUT, "PUT", { content: clean + "\nAgent line.\n" }, "content", { "If-Match": `"${h2}"` });
    expect(strong.status).toBe(200);

    // `*` is the RFC's "any current representation": unconditional.
    const any = await call(content.PUT, "PUT", { content: clean + "\nAnother line.\n" }, "content", { "If-Match": "*" });
    expect(any.status).toBe(200);
  });

  it("without a hash the write is unconditional, as before", async () => {
    await freshDoc();
    actor = agent;
    const { clean } = await read();
    actor = human;
    await call(content.PATCH, "PATCH", { append: "Typed meanwhile." });
    actor = agent;
    const res = await call(content.PUT, "PUT", { content: clean + "\nAgent line.\n" });
    expect(res.status).toBe(200);
    expect((await read()).clean).not.toContain("Typed meanwhile.");
  });

  it("a malformed hash is a mismatch: 409 with the current hash (so the retry loop works), never a write", async () => {
    await freshDoc();
    actor = agent;
    const { clean, contentHash } = await read();
    for (const bad of ["e20e7c25", "deadbeef", "not a hash at all"]) {
      const res = await call(content.PUT, "PUT", { content: clean + "\nx\n", ifContentHash: bad });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Conflict;
      expect(body.error).toBe("Document changed since you read it");
      expect(body.contentHash).toBe(contentHash);
      expect(body.diff).toBeNull();
      expect((await read()).clean).toBe(clean);
    }
    const header = await call(content.PUT, "PUT", { content: clean + "\nx\n" }, "content", { "If-Match": '"deadbeef"' });
    expect(header.status).toBe(409);
    expect(((await header.json()) as Conflict).contentHash).toBe(contentHash);
    expect((await read()).clean).toBe(clean);
  });

  it("PATCH /content honours ifContentHash / If-Match like PUT: stale → 409 and nothing appended, current → 200 with the new hash", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1 } = await read();

    actor = human;
    await call(content.PATCH, "PATCH", { append: "The human's new sentence." });

    actor = agent;
    const stale = await call(content.PATCH, "PATCH", { append: "\nstale append", ifContentHash: h1 });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as Conflict;
    expect(body.error).toBe("Document changed since you read it");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.contentHash).not.toBe(h1);
    expect(body.diff).toContain("+The human's new sentence.");
    let after = await read();
    expect(after.clean).not.toContain("stale append");
    expect(after.contentHash).toBe(body.contentHash);

    // The header form and a stale header + stale body together are refused the same way.
    const staleHeader = await call(content.PATCH, "PATCH", { append: "\nstale append", ifContentHash: "deadbeef" }, "content", { "If-Match": '"deadbeef"' });
    expect(staleHeader.status).toBe(409);
    expect(((await staleHeader.json()) as Conflict).contentHash).toBe(body.contentHash);
    expect((await read()).clean).not.toContain("stale append");

    const weak = await call(content.PATCH, "PATCH", { append: "\nweak append" }, "content", { "If-Match": `W/"${body.contentHash}"` });
    expect(weak.status).toBe(409);
    expect((await read()).clean).not.toContain("weak append");

    const fresh = await call(content.PATCH, "PATCH", { append: "Agent's paragraph.", ifContentHash: body.contentHash });
    expect(fresh.status).toBe(200);
    const ok = (await fresh.json()) as { ok: boolean; contentHash: string };
    expect(ok.ok).toBe(true);
    expect(ok.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.contentHash).not.toBe(body.contentHash);
    after = await read();
    expect(after.clean).toContain("The human's new sentence.");
    expect(after.clean).toContain("Agent's paragraph.");
    expect(after.contentHash).toBe(ok.contentHash);

    const viaHeader = await call(content.PATCH, "PATCH", { append: "Second paragraph from the agent." }, "content", { "If-Match": `"${ok.contentHash}"` });
    expect(viaHeader.status).toBe(200);
    expect((await read()).clean).toContain("Second paragraph from the agent.");
  });

  it("PATCH /content without a hash stays unconditional", async () => {
    await freshDoc();
    actor = agent;
    const before = await read();
    const res = await call(content.PATCH, "PATCH", { append: "Unconditional." });
    expect(res.status).toBe(200);
    const after = await read();
    expect(after.clean).toContain("Unconditional.");
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("POST /suggest honours the hash too and returns it on success", async () => {
    await freshDoc();
    actor = agent;
    const { contentHash: h1, clean } = await read();

    actor = human;
    await call(content.PATCH, "PATCH", { append: "Human addition." });

    actor = agent;
    const stale = await call(suggest.POST, "POST", { content: clean.replace("First", "1st"), ifContentHash: h1 }, "suggest");
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as Conflict;
    expect(body.diff).toContain("+Human addition.");
    const pending = (await (await suggestions.GET(new Request(url("suggestions")), ctx())).json()) as { suggestions: unknown[] };
    expect(pending.suggestions.length).toBe(0);

    const fresh = await call(suggest.POST, "POST", { edits: [{ find: "First", replace: "1st" }], ifContentHash: body.contentHash }, "suggest");
    expect(fresh.status).toBe(200);
    const ok = (await fresh.json()) as { suggestions: number; contentHash: string };
    expect(ok.suggestions).toBe(1);
    // Pending suggestions do not move the clean-text hash.
    expect(ok.contentHash).toBe(body.contentHash);
  });
});
