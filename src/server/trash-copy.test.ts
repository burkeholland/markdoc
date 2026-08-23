import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Route tests resolve the caller through next-auth and `next/headers` (same stand-ins as star.test.ts).
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("@/server/db");
const { eq } = await import("drizzle-orm");
const {
  addVersion,
  createDocument,
  deleteDocument,
  duplicateDocument,
  getDocumentAccess,
  listCollaborators,
  listDocumentsForUser,
  listTrashForUser,
  listVersions,
  purgeDocument,
  purgeTrashOlderThan,
  restoreDocument,
  searchDocumentsForUser,
  upsertCollaborator,
} = await import("@/server/documents");
const { putAsset, getAsset } = await import("@/server/assets");
const { encodeSeedState } = await import("@/server/collab/seed");
const { DELETE, GET: GET_DOC } = await import("../app/api/documents/[id]/route");
const { POST: RESTORE } = await import("../app/api/documents/[id]/restore/route");
const { POST: DUPLICATE } = await import("../app/api/documents/[id]/duplicate/route");
const { POST: COPY_VERSION } = await import("../app/api/documents/[id]/versions/[vid]/copy/route");
const { POST: COLLAB_TOKEN } = await import("../app/api/documents/[id]/collab-token/route");
const { GET: GET_LIST } = await import("../app/api/documents/route");

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

let owner: Actor;
let viewer: Actor;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, path: string) => new Request(`http://localhost:3700${path}`, { method });
const as = async <T>(who: Actor | null, fn: () => Promise<T>) => {
  const saved = actor;
  actor = who;
  try {
    return await fn();
  } finally {
    actor = saved;
  }
};
const idsOf = (docs: { id: string }[]) => docs.map((d) => d.id);

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive-trash@example.com" }).returning();
  const [v] = await db.insert(schema.users).values({ name: "Vic", login: "vic", email: "vic-trash@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  viewer = { id: v.id, login: "vic", name: "Vic", image: null };
});

describe("duplicateDocument", () => {
  it("copies the text and referenced assets (URLs rewritten) into a new local document owned by the caller", async () => {
    const source = await createDocument({ ownerId: owner.id, title: "Plan", content: "# Plan\n\nplaceholder\n" });
    const asset = await putAsset({ documentId: source.id, userId: owner.id, name: "dot.png", mime: "image/png", bytes: PNG });
    const db = await getDb();
    const content = `# Plan\n\n![dot](${asset.url})\n\nBody text.\n`;
    // Rewriting the text behind the editor's back: keep `ystate` (the source of truth) in step.
    await db
      .update(schema.documents)
      .set({ content, ystate: encodeSeedState(content, "Plan"), storage: "repo", repoOwner: "o", repoName: "r", repoPath: "PLAN.md" })
      .where(eq(schema.documents.id, source.id));
    await upsertCollaborator(source.id, "vic", "viewer", owner.id);

    const copy = await duplicateDocument(source.id, viewer.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.ownerId).toBe(viewer.id);
    expect(copy.title).toBe("Copy of Plan");
    expect(copy.storage).toBe("local");
    expect(copy.repoOwner).toBeNull();
    expect(copy.deletedAt).toBeNull();

    // Asset URL rewritten to a new asset row that belongs to the copy and holds the same bytes.
    expect(copy.content).not.toContain(asset.url);
    const m = /\/api\/assets\/([0-9a-z]+)/.exec(copy.content);
    expect(m).not.toBeNull();
    const copied = await getAsset(m![1]);
    expect(copied).not.toBeNull();
    expect(copied!.documentId).toBe(copy.id);
    expect(Array.from(copied!.bytes)).toEqual(Array.from(PNG));
    expect(copy.content.replace(m![0], asset.url)).toBe(content);
    // The original asset still belongs to the source.
    expect((await getAsset(asset.id))!.documentId).toBe(source.id);

    expect(await listCollaborators(copy.id)).toEqual([]);
    const versions = await listVersions(copy.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ number: 1, title: "Copied from Plan" });
  });
});

describe("trash", () => {
  it("soft delete hides the document from list, search and access; restore brings it back", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Quarterly zebra report", content: "# Quarterly zebra report\n\nzebra body\n" });
    await upsertCollaborator(doc.id, "vic", "editor", owner.id);
    expect(idsOf(await listDocumentsForUser(owner))).toContain(doc.id);
    expect(idsOf(await listDocumentsForUser(viewer))).toContain(doc.id);

    await deleteDocument(doc.id);
    expect(idsOf(await listDocumentsForUser(owner))).not.toContain(doc.id);
    expect(idsOf(await listDocumentsForUser(viewer))).not.toContain(doc.id);
    expect(idsOf(await listDocumentsForUser(owner, { starred: true }))).not.toContain(doc.id);
    expect(idsOf(await searchDocumentsForUser(owner, "zebra"))).not.toContain(doc.id);
    expect(idsOf(await searchDocumentsForUser(viewer, "zebra"))).not.toContain(doc.id);
    expect(await getDocumentAccess(doc.id, owner)).toBeNull();
    expect(await getDocumentAccess(doc.id, viewer)).toBeNull();
    expect(await getDocumentAccess(doc.id, owner, { allowDeleted: true })).toMatchObject({ role: "owner" });
    expect(await getDocumentAccess(doc.id, viewer, { allowDeleted: true })).toMatchObject({ role: "editor" });

    const trash = await listTrashForUser(owner);
    expect(idsOf(trash)).toContain(doc.id);
    expect(trash.find((d) => d.id === doc.id)!.deletedAt).toBeInstanceOf(Date);
    // Only the owner sees it in their trash.
    expect(idsOf(await listTrashForUser(viewer))).not.toContain(doc.id);

    await restoreDocument(doc.id);
    expect(idsOf(await listDocumentsForUser(owner))).toContain(doc.id);
    expect(idsOf(await searchDocumentsForUser(viewer, "zebra"))).toContain(doc.id);
    expect(await getDocumentAccess(doc.id, viewer)).toMatchObject({ role: "editor" });
    expect(idsOf(await listTrashForUser(owner))).not.toContain(doc.id);
  });

  it("purge removes the document and its rows (versions, assets) for good", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Purgeable" });
    const asset = await putAsset({ documentId: doc.id, userId: owner.id, name: "dot.png", mime: "image/png", bytes: PNG });
    await deleteDocument(doc.id);
    await purgeDocument(doc.id);
    const db = await getDb();
    expect(await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id))).toEqual([]);
    expect(await db.select().from(schema.versions).where(eq(schema.versions.documentId, doc.id))).toEqual([]);
    expect(await getAsset(asset.id)).toBeNull();
    expect(await getDocumentAccess(doc.id, owner, { allowDeleted: true })).toBeNull();
  });

  it("purgeTrashOlderThan removes only documents trashed longer than the retention period", async () => {
    const old = await createDocument({ ownerId: owner.id, title: "Old trash" });
    const fresh = await createDocument({ ownerId: owner.id, title: "Fresh trash" });
    const live = await createDocument({ ownerId: owner.id, title: "Still live" });
    const now = new Date("2026-08-01T00:00:00Z");
    await deleteDocument(old.id, new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
    await deleteDocument(fresh.id, new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));

    expect(await purgeTrashOlderThan(30, now)).toBe(1);
    const trashIds = idsOf(await listTrashForUser(owner));
    expect(trashIds).not.toContain(old.id);
    expect(trashIds).toContain(fresh.id);
    expect(idsOf(await listDocumentsForUser(owner))).toContain(live.id);
    expect(await purgeTrashOlderThan(30, now)).toBe(0);
  });
});

describe("routes", () => {
  it("POST /duplicate: 201 for a viewer, 401 for anonymous", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Shared thing", content: "# Shared thing\n\ntext\n" });
    await upsertCollaborator(doc.id, "vic", "viewer", owner.id);
    const res = await as(viewer, () => DUPLICATE(req("POST", `/api/documents/${doc.id}/duplicate`), params(doc.id)));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.title).toBe("Copy of Shared thing");
    expect(body.id).toBeTruthy();
    expect((await getDocumentAccess(body.id, viewer))!.role).toBe("owner");
    expect(await getDocumentAccess(body.id, owner)).toBeNull();

    expect((await as(null, () => DUPLICATE(req("POST", `/api/documents/${doc.id}/duplicate`), params(doc.id)))).status).toBe(401);
  });

  it("POST /versions/:vid/copy: a viewer gets a 201 copy they own with that version's text; anon 401; trashed 404", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Versioned", content: "# Versioned\n\nlatest text\n" });
    await upsertCollaborator(doc.id, "vic", "viewer", owner.id);
    const v1 = await addVersion({ documentId: doc.id, content: "# Versioned\n\nfirst draft\n", kind: "named", title: "First", createdBy: owner.id });
    const vparams = { params: Promise.resolve({ id: doc.id, vid: v1.id }) };
    const path = `/api/documents/${doc.id}/versions/${v1.id}/copy`;

    const res = await as(viewer, () => COPY_VERSION(req("POST", path), vparams));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.title).toBe(`Copy of Versioned (v${v1.number})`);
    expect((await getDocumentAccess(body.id, viewer))!.role).toBe("owner");
    expect(await getDocumentAccess(body.id, owner)).toBeNull();
    const db = await getDb();
    const [copy] = await db.select().from(schema.documents).where(eq(schema.documents.id, body.id));
    expect(copy.content).toBe("# Versioned\n\nfirst draft\n");
    expect((await listVersions(body.id))[0]).toMatchObject({ number: 1, title: `Copied from v${v1.number} “First”` });

    expect((await as(null, () => COPY_VERSION(req("POST", path), vparams))).status).toBe(401);
    const missing = { params: Promise.resolve({ id: doc.id, vid: "nope" }) };
    expect((await as(viewer, () => COPY_VERSION(req("POST", path), missing))).status).toBe(404);

    await deleteDocument(doc.id);
    expect((await as(viewer, () => COPY_VERSION(req("POST", path), vparams))).status).toBe(404);
    expect((await as(owner, () => COPY_VERSION(req("POST", path), vparams))).status).toBe(404);
  });

  it("DELETE moves to the trash; GET ?trash=1 lists it; the document and its collab token are gone", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Trash me" });
    await upsertCollaborator(doc.id, "vic", "editor", owner.id);
    // Non-owners cannot trash.
    expect((await as(viewer, () => DELETE(req("DELETE", `/api/documents/${doc.id}`), params(doc.id)))).status).toBe(403);

    const del = await as(owner, () => DELETE(req("DELETE", `/api/documents/${doc.id}`), params(doc.id)));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, permanent: false });

    const trash = await as(owner, () => GET_LIST(req("GET", "/api/documents?trash=1")));
    const { documents } = (await trash.json()) as { documents: { id: string; deletedAt: string | null }[] };
    expect(idsOf(documents)).toContain(doc.id);
    expect(documents.find((d) => d.id === doc.id)!.deletedAt).toBeTruthy();
    const list = (await (await as(owner, () => GET_LIST(req("GET", "/api/documents")))).json()) as { documents: { id: string }[] };
    expect(idsOf(list.documents)).not.toContain(doc.id);

    expect((await as(owner, () => GET_DOC(req("GET", `/api/documents/${doc.id}`), params(doc.id)))).status).toBe(404);
    expect((await as(viewer, () => COLLAB_TOKEN(req("POST", `/api/documents/${doc.id}/collab-token`), params(doc.id)))).status).toBe(404);
    expect((await as(owner, () => COLLAB_TOKEN(req("POST", `/api/documents/${doc.id}/collab-token`), params(doc.id)))).status).toBe(404);
  });

  it("POST /restore and DELETE ?permanent=1 are owner-only (403 for collaborators)", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Owner only" });
    await upsertCollaborator(doc.id, "vic", "editor", owner.id);
    await as(owner, () => DELETE(req("DELETE", `/api/documents/${doc.id}`), params(doc.id)));

    expect((await as(viewer, () => RESTORE(req("POST", `/api/documents/${doc.id}/restore`), params(doc.id)))).status).toBe(403);
    expect((await as(viewer, () => DELETE(req("DELETE", `/api/documents/${doc.id}?permanent=1`), params(doc.id)))).status).toBe(403);
    expect((await as(null, () => RESTORE(req("POST", `/api/documents/${doc.id}/restore`), params(doc.id)))).status).toBe(401);

    const restored = await as(owner, () => RESTORE(req("POST", `/api/documents/${doc.id}/restore`), params(doc.id)));
    expect(restored.status).toBe(200);
    expect((await as(owner, () => GET_DOC(req("GET", `/api/documents/${doc.id}`), params(doc.id)))).status).toBe(200);

    await as(owner, () => DELETE(req("DELETE", `/api/documents/${doc.id}`), params(doc.id)));
    const purged = await as(owner, () => DELETE(req("DELETE", `/api/documents/${doc.id}?permanent=1`), params(doc.id)));
    expect(purged.status).toBe(200);
    expect(await purged.json()).toEqual({ ok: true, permanent: true });
    expect(await getDocumentAccess(doc.id, owner, { allowDeleted: true })).toBeNull();
  });
});
