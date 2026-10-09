import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type User = { id: string; login: string; name: string; image: null };

let actor: User | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents")>();
  return { ...actual, addVersion: vi.fn(actual.addVersion) };
});
vi.mock("@/editor/sync/replace-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/sync/replace-plan")>();
  return { ...actual, replaceText: vi.fn(actual.replaceText) };
});
vi.mock("@/server/livedoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/livedoc")>();
  return { ...actual, mutateLiveDoc: vi.fn(actual.mutateLiveDoc) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, addVersion, getVersion, listVersions } = await import("@/server/documents");
const { replaceText } = await import("@/editor/sync/replace-plan");
const { mutateLiveDoc } = await import("@/server/livedoc");
const { contentHash } = await import("@/server/export/html");
const { createRequiredVersionIntent } = await import("@/server/required-version");
const { createCollabServer, hydrateDoc, shutdownCollab, TEXT_KEY } = await import("@/server/collab/hocuspocus");
const { registerCollab } = await import("@/server/collab/registry");
const content = await import("@/app/api/documents/[id]/content/route");

type ContentBody = { content: string; clean: string; contentHash: string };

describe("required version intent failure ownership", () => {
  let user: User;
  const collabServers: ReturnType<typeof createCollabServer>[] = [];

  beforeAll(async () => {
    const db = await getDb();
    const [row] = await db
      .insert(schema.users)
      .values({ name: "Original Actor", login: "required-version-actor", email: "required-version-actor@example.com" })
      .returning();
    user = { id: row.id, login: row.login!, name: row.name!, image: null };
    actor = user;
  });

  afterAll(async () => {
    for (const server of collabServers) await shutdownCollab(server);
  });

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const url = (id: string) => `http://localhost:3700/api/documents/${id}/content`;
  const call = (id: string, body: unknown) =>
    content.PUT(
      new Request(url(id), {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
      ctx(id),
    );
  const read = async (id: string) =>
    (await (await content.GET(new Request(url(id)), ctx(id))).json()) as ContentBody;
  const intents = async (id: string) => {
    const db = await getDb();
    return db.select().from(schema.requiredVersionIntents).where(eq(schema.requiredVersionIntents.documentId, id));
  };

  it("discards only its own intent when a stale precondition proves mutation never started", async () => {
    const doc = await createDocument({ ownerId: user.id, content: "# Before\n" });
    const response = await call(doc.id, {
      content: "# After\n",
      message: "Must not survive",
      ifContentHash: "0".repeat(64),
    });

    expect(response.status).toBe(409);
    expect(await intents(doc.id)).toEqual([]);
    expect((await read(doc.id)).clean).toBe("# Before\n");
  });

  it("discards its intent when opening the live document fails before the mutation callback", async () => {
    const doc = await createDocument({ ownerId: user.id, content: "# Before open failure\n" });
    const before = await read(doc.id);
    vi.mocked(mutateLiveDoc).mockRejectedValueOnce(new Error("injected open failure"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let response: Response;
    try {
      response = await call(doc.id, {
        content: "# Never applied\n",
        message: "Must be cleaned up",
        ifContentHash: before.contentHash,
      });
    } finally {
      errors.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unexpected error" });
    expect(await intents(doc.id)).toEqual([]);
    expect((await read(doc.id)).clean).toBe("# Before open failure\n");
  });

  it("preserves identity and blocks repeated retries when Yjs application may have partially run", async () => {
    const doc = await createDocument({ ownerId: user.id, content: "# Before\n" });
    const before = await read(doc.id);
    vi.mocked(replaceText).mockImplementationOnce((text) => {
      text.insert(text.length, "\npartial");
      throw new Error("injected Yjs apply failure");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let first: Response;
    try {
      first = await call(doc.id, {
        content: "# Intended\n",
        message: "Required identity",
        ifContentHash: before.contentHash,
      });
    } finally {
      errors.mockRestore();
    }
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({
      error: "The content mutation failed after it started and its required version state is unresolved",
      contentApplied: false,
      versionPending: true,
    });

    const [intent] = await intents(doc.id);
    expect(intent).toMatchObject({
      documentId: doc.id,
      content: "# Intended\n",
      contentHash: contentHash("# Intended\n"),
      kind: "named",
      title: "Required identity",
      createdBy: user.id,
      createdByName: "Original Actor",
      applied: false,
    });
    expect((await read(doc.id)).clean).toBe("# Before\n");

    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await call(doc.id, {
        content: "# Intended\n",
        message: "Required identity",
        ifContentHash: before.contentHash,
      });
      expect(retry.status).toBe(500);
      expect(await retry.json()).toEqual({
        error: "A previous content write has unresolved version history",
        contentApplied: false,
        contentHash: before.contentHash,
        versionPending: true,
      });
      expect((await intents(doc.id)).map((row) => row.versionId)).toEqual([intent.versionId]);
    }
  });

  it("does not let a competing request delete an intent it does not own", async () => {
    const doc = await createDocument({ ownerId: user.id, content: "# Current\n" });
    const existingId = await createRequiredVersionIntent({
      documentId: doc.id,
      content: "# Other target\n",
      contentHash: contentHash("# Other target\n"),
      kind: "named",
      title: "Other request",
      createdBy: user.id,
      createdByName: "Original Actor",
    });
    const current = await read(doc.id);

    const response = await call(doc.id, {
      content: "# Competing target\n",
      message: "Competing request",
      ifContentHash: current.contentHash,
    });

    expect(response.status).toBe(500);
    expect((await intents(doc.id)).map((row) => row.versionId)).toEqual([existingId]);
  });

  it("keeps the production-store intent after row persistence fails in auto-version, then finalizes it exactly once", async () => {
    const server = createCollabServer();
    collabServers.push(server);
    registerCollab(server);
    server.configuration.debounce = 0;
    server.configuration.maxDebounce = 0;

    const noOpDoc = await createDocument({ ownerId: user.id, content: "# Already current\n" });
    const noOpBefore = await read(noOpDoc.id);
    const noOp = await call(noOpDoc.id, {
      content: noOpBefore.clean,
      message: "No-op version",
      ifContentHash: noOpBefore.contentHash,
    });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toEqual({ ok: true, changed: false, contentHash: noOpBefore.contentHash });
    expect(await intents(noOpDoc.id)).toEqual([]);
    expect(await listVersions(noOpDoc.id)).toEqual([]);

    const doc = await createDocument({ ownerId: user.id, content: "# Before production store\n" });
    const before = await read(doc.id);
    const next = "# After production store\n";
    vi.mocked(addVersion).mockRejectedValueOnce(new Error("injected auto-version failure"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let first: Response;
    try {
      first = await call(doc.id, {
        content: next,
        message: "Required production version",
        ifContentHash: before.contentHash,
      });
    } finally {
      errors.mockRestore();
    }
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual({
      error: "The content may have been written, but its required version was not saved",
      contentApplied: true,
      contentHash: contentHash(next),
      versionPending: true,
    });

    const db = await getDb();
    const [stored] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(stored.content).toBe(next);
    const storedDoc = new Y.Doc();
    hydrateDoc(storedDoc, stored.ystate!, stored.content, stored.title);
    expect(storedDoc.getText(TEXT_KEY).toString()).toBe(next);
    storedDoc.destroy();

    const [pending] = await intents(doc.id);
    expect(pending).toMatchObject({
      content: next,
      contentHash: contentHash(next),
      kind: "named",
      title: "Required production version",
      createdBy: user.id,
      createdByName: "Original Actor",
      applied: false,
    });
    expect(await listVersions(doc.id)).toEqual([]);

    const afterFailure = await read(doc.id);
    expect(afterFailure.clean).toBe(next);
    expect(afterFailure.contentHash).toBe(contentHash(next));
    const retry = await call(doc.id, {
      content: next,
      message: "Required production version",
      ifContentHash: afterFailure.contentHash,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, changed: false, contentHash: afterFailure.contentHash });
    expect(await intents(doc.id)).toEqual([]);

    const versions = await listVersions(doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: pending.versionId,
      title: "Required production version",
      kind: "named",
      createdBy: user.id,
      createdByName: "Original Actor",
    });
    expect((await getVersion(doc.id, pending.versionId))?.content).toBe(next);

    const repeated = await call(doc.id, {
      content: next,
      message: "Required production version",
      ifContentHash: afterFailure.contentHash,
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ok: true, changed: false, contentHash: afterFailure.contentHash });
    expect(await listVersions(doc.id)).toHaveLength(1);
    expect(await intents(doc.id)).toEqual([]);
  });
});
