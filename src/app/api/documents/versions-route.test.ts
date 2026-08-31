import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as content.test.ts: the routes resolve the caller through next-auth and
// `next/headers`, neither of which runs outside a Next request.
let actor: { id: string; login: string; name: string; image: null } | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity row, or the "Restored version" insert, fail after the change landed.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents")>();
  return { ...actual, addVersion: vi.fn(actual.addVersion) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, addVersion, listVersions } = await import("@/server/documents");
const { readLiveText } = await import("@/server/livedoc");
const { recordActivity } = await import("@/server/activity");
const versions = await import("@/app/api/documents/[id]/versions/route");
const version = await import("@/app/api/documents/[id]/versions/[vid]/route");
const activity = await import("@/app/api/documents/[id]/activity/route");

type User = { id: string; login: string; name: string; image: null };
type VersionDto = { id: string; number: number; title: string | null; kind: string; createdAt: string };
type SaveBody = { version: VersionDto; warnings?: string[] };
type RestoreBody = { ok: boolean; version: VersionDto | null; warnings?: string[] };

const TEXT = "# Plan\n\nFirst paragraph here.\n\nSecond paragraph.\n";
const OLD = "# Plan\n\nThe old text.\n";
const DB_FAILURE = new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');
const VERSION_COLLISION = new Error('duplicate key value violates unique constraint "version_doc_number_idx"');

/** Runs `fn` with console.error silenced; returns its result and the `[version…]`-prefixed lines it logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[version")) };
  } finally {
    errors.mockRestore();
  }
};

/**
 * `docs/agents.md` promises that a non-2xx status means nothing changed. Both version routes make their
 * change (the version row; the live text replaced and broadcast) and only then record activity — a
 * failure there used to answer 500 for a change that had happened, and the retry saved a second identical
 * named version. Audit #1202 F16 (named versions) and F8 (restore).
 */
describe("POST /api/documents/[id]/versions and /versions/[vid] restore: post-write failures are warnings on the 2xx", () => {
  let eve: User;
  let docId: string;

  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve-versions", email: "eve-versions@example.com" }).returning();
    eve = { id: user.id, login: "eve-versions", name: "Eve", image: null };
    actor = eve;
  });

  const post = (fn: (req: Request, ctx: { params: Promise<{ id: string; vid: string }> }) => Promise<Response>, path: string, body: unknown, vid = "") =>
    fn(new Request(`http://localhost:3700/api/documents/${docId}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), {
      params: Promise.resolve({ id: docId, vid }),
    });
  const activityActions = async () =>
    ((await (await activity.GET(new Request(`http://localhost:3700/api/documents/${docId}/activity`), { params: Promise.resolve({ id: docId }) })).json()) as { items: { action: string }[] }).items.map(
      (i) => i.action,
    );
  const freshDoc = async () => {
    const doc = await createDocument({ ownerId: eve.id, title: "Plan", content: TEXT });
    docId = doc.id;
  };

  it("a named version answers exactly 201 { version } — no warnings key — and records version.save", async () => {
    await freshDoc();
    const res = await post(versions.POST, "versions", { title: "Draft 1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SaveBody;
    expect(body).toEqual({ version: expect.objectContaining({ id: expect.any(String), number: 1, title: "Draft 1", kind: "named", createdAt: expect.any(String) }) });
    expect(await listVersions(docId)).toHaveLength(1);
    expect(await activityActions()).toEqual(["version.save"]);
  });

  it("recordActivity failing after the version row: 201 with the version, warnings: [activity-not-recorded], exactly one version row", async () => {
    await freshDoc();
    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => post(versions.POST, "versions", { title: "Draft 1" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as SaveBody;
    expect(body).toEqual({ version: expect.objectContaining({ id: expect.any(String), number: 1, title: "Draft 1", kind: "named" }), warnings: ["activity-not-recorded"] });
    // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
    expect(JSON.stringify(body)).not.toContain("Failed query");
    expect(logged).toEqual([["[versions] activity-not-recorded", expect.any(Error)]]);

    // One row — the caller got its 201 and has no reason to retry (a 500 made it save a second "Draft 1").
    const rows = await listVersions(docId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.version.id, title: "Draft 1", kind: "named" });
    expect(await activityActions()).toEqual([]);
  });

  it("a restore answers exactly 200 { ok, version } — no warnings key — with the snapshot and the restore rows", async () => {
    await freshDoc();
    const older = await addVersion({ documentId: docId, content: OLD, kind: "named", title: "Old" });
    const res = await post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.objectContaining({ id: expect.any(String), number: 3, kind: "restore", title: `Restored version ${older.number}` }) });
    expect((await readLiveText(docId)).text).toBe(OLD);
    expect((await listVersions(docId)).map((v) => [v.kind, v.title])).toEqual([
      ["restore", `Restored version ${older.number}`],
      ["auto", "Before restore"],
      ["named", "Old"],
    ]);
    expect(await activityActions()).toEqual(["version.restore"]);
  });

  it("restore with the 'Restored version' insert failing: 200, the live text is the version's, version: null, warnings: [version-not-saved], one 'Before restore' snapshot", async () => {
    await freshDoc();
    const older = await addVersion({ documentId: docId, content: OLD, kind: "named", title: "Old" });
    const actual = await vi.importActual<typeof import("@/server/documents")>("@/server/documents");
    // The pre-restore snapshot (kind `auto`) must land; only the "Restored version n" row collides.
    vi.mocked(addVersion).mockImplementation((input, tx) => (input.kind === "restore" ? Promise.reject(VERSION_COLLISION) : actual.addVersion(input, tx)));
    let res: Response;
    let logged: unknown[][];
    try {
      ({ result: res, logged } = await quietly(() => post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id)));
    } finally {
      vi.mocked(addVersion).mockImplementation(actual.addVersion);
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: null, warnings: ["version-not-saved"] });
    expect(logged).toEqual([["[version] version-not-saved", expect.any(Error)]]);

    expect((await readLiveText(docId)).text).toBe(OLD);
    const rows = await listVersions(docId);
    expect(rows.filter((v) => v.title === "Before restore")).toHaveLength(1);
    expect(rows.filter((v) => v.kind === "restore")).toHaveLength(0);
    expect(rows.map((v) => [v.kind, v.title])).toEqual([
      ["auto", "Before restore"],
      ["named", "Old"],
    ]);
    // The restore did happen, so it is in the feed.
    expect(await activityActions()).toEqual(["version.restore"]);
  });

  it("restore with recordActivity failing: 200 with the restore version and warnings: [activity-not-recorded]", async () => {
    await freshDoc();
    const older = await addVersion({ documentId: docId, content: OLD, kind: "named", title: "Old" });
    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.objectContaining({ kind: "restore", title: `Restored version ${older.number}` }), warnings: ["activity-not-recorded"] });
    expect(logged).toEqual([["[version] activity-not-recorded", expect.any(Error)]]);
    expect((await readLiveText(docId)).text).toBe(OLD);
    expect((await listVersions(docId)).map((v) => v.kind)).toEqual(["restore", "auto", "named"]);
    expect(await activityActions()).toEqual([]);
  });

  it("both tails failing on a restore list both codes, in write order", async () => {
    await freshDoc();
    const older = await addVersion({ documentId: docId, content: OLD, kind: "named", title: "Old" });
    const actual = await vi.importActual<typeof import("@/server/documents")>("@/server/documents");
    vi.mocked(addVersion).mockImplementation((input, tx) => (input.kind === "restore" ? Promise.reject(VERSION_COLLISION) : actual.addVersion(input, tx)));
    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    let res: Response;
    let logged: unknown[][];
    try {
      ({ result: res, logged } = await quietly(() => post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id)));
    } finally {
      vi.mocked(addVersion).mockImplementation(actual.addVersion);
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: null, warnings: ["version-not-saved", "activity-not-recorded"] });
    expect(logged).toEqual([
      ["[version] version-not-saved", expect.any(Error)],
      ["[version] activity-not-recorded", expect.any(Error)],
    ]);
    expect((await readLiveText(docId)).text).toBe(OLD);
  });

  it("the pre-restore snapshot failing is still a 500 and the live text is untouched (nothing changed)", async () => {
    await freshDoc();
    const older = await addVersion({ documentId: docId, content: OLD, kind: "named", title: "Old" });
    const actual = await vi.importActual<typeof import("@/server/documents")>("@/server/documents");
    vi.mocked(addVersion).mockImplementation((input, tx) => (input.title === "Before restore" ? Promise.reject(VERSION_COLLISION) : actual.addVersion(input, tx)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post(version.POST, `versions/${older.id}`, { action: "restore" }, older.id);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unexpected error" });
    } finally {
      errors.mockRestore();
      vi.mocked(addVersion).mockImplementation(actual.addVersion);
    }
    expect((await readLiveText(docId)).text).toBe(TEXT);
    expect((await listVersions(docId)).map((v) => v.title)).toEqual(["Old"]);
    expect(await activityActions()).toEqual([]);
  });
});
