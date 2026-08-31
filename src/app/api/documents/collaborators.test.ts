import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: the routes resolve the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can make the activity row or the share notification fail after the collaborator row is written.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return { ...actual, notifyShare: vi.fn(actual.notifyShare) };
});
// Wrapped so one test can make the primary write itself fail and check that it stays a 500.
vi.mock("@/server/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents")>();
  return { ...actual, upsertCollaborator: vi.fn(actual.upsertCollaborator) };
});

const { getDb, schema } = await import("@/server/db");
const { createDocument, listCollaborators, removeCollaborator, upsertCollaborator } = await import("@/server/documents");
const { recordActivity } = await import("@/server/activity");
const { notifyShare } = await import("@/server/notifications");
const { DELETE, POST } = await import("./[id]/collaborators/route");

let owner: Actor;
let docId: string;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (login: string) =>
  DELETE(
    new Request(`http://localhost:3700/api/documents/${docId}/collaborators`, {
      method: "DELETE",
      body: JSON.stringify({ login }),
      headers: { "Content-Type": "application/json" },
    }),
    params(docId),
  );
const add = (login: string, role = "editor") =>
  POST(
    new Request(`http://localhost:3700/api/documents/${docId}/collaborators`, {
      method: "POST",
      body: JSON.stringify({ login, role }),
      headers: { "Content-Type": "application/json" },
    }),
    params(docId),
  );
const shareActivity = async (action: "share.add" | "share.remove") => {
  const db = await getDb();
  return db
    .select()
    .from(schema.activity)
    .where(and(eq(schema.activity.documentId, docId), eq(schema.activity.action, action)));
};
const shareRemovals = () => shareActivity("share.remove");
const notificationsFor = async (login: string) => {
  const db = await getDb();
  return db.select().from(schema.notifications).where(eq(schema.notifications.userLogin, login));
};
/** Runs `fn` with console.error silenced; returns its result and the `[collaborators]`-prefixed lines it logged. */
const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[collaborators]")) };
  } finally {
    errors.mockRestore();
  }
};
const DB_FAILURE = new Error('Failed query: insert into "activity" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  owner = { id: o.id, login: "olive", name: "Olive", image: null };
  actor = owner;
  // Signed in before, so a share with them is a 200 (not a 202 pending).
  await db.insert(schema.users).values({ name: "Pat", login: "pat", email: "pat@example.com" });
  const doc = await createDocument({ ownerId: owner.id, title: "Shared" });
  docId = doc.id;
});

describe("removeCollaborator()", () => {
  it("reports whether a row was removed, normalizing case and a leading @", async () => {
    await upsertCollaborator(docId, "Helper", "viewer", owner.id);
    expect(await removeCollaborator(docId, "nobody")).toBe(false);
    expect(await removeCollaborator(docId, "@HELPER")).toBe(true);
    expect(await removeCollaborator(docId, "helper")).toBe(false);
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("helper");
  });
});

describe("DELETE /api/documents/:id/collaborators", () => {
  it("removes an existing collaborator once (200), then 404s without recording more activity", async () => {
    await upsertCollaborator(docId, "vic", "editor", owner.id);
    expect(await shareRemovals()).toHaveLength(0);

    const first = await del("vic");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("vic");
    const after = await shareRemovals();
    expect(after).toHaveLength(1);
    expect(after[0].detail).toEqual({ login: "vic" });

    const again = await del("vic");
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Collaborator not found" });
    expect(await shareRemovals()).toHaveLength(1);
    expect(await notificationsFor("vic")).toHaveLength(0);
  });

  it("returns 404 for a login that was never shared and records nothing", async () => {
    const before = (await shareRemovals()).length;
    const res = await del("never-shared");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Collaborator not found" });
    expect(await shareRemovals()).toHaveLength(before);
    expect(await notificationsFor("never-shared")).toHaveLength(0);
  });

  it("matches the stored login regardless of case and a leading @", async () => {
    await upsertCollaborator(docId, "Mixed-Case", "commenter", owner.id);
    const before = (await shareRemovals()).length;

    const res = await del("@MIXED-case");
    expect(res.status).toBe(200);
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("mixed-case");
    const after = await shareRemovals();
    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1].detail).toEqual({ login: "mixed-case" });

    expect((await del("mixed-case")).status).toBe(404);
    expect(await shareRemovals()).toHaveLength(before + 1);
  });

  it("still requires ownership (401 signed out, 404 for a stranger)", async () => {
    await upsertCollaborator(docId, "vic", "editor", owner.id);
    const db = await getDb();
    const [s] = await db.insert(schema.users).values({ name: "Sam", login: "sam", email: "sam@example.com" }).returning();
    const stranger: Actor = { id: s.id, login: "sam", name: "Sam", image: null };
    const before = (await shareRemovals()).length;

    actor = null;
    try {
      expect((await del("vic")).status).toBe(401);
    } finally {
      actor = owner;
    }
    actor = stranger;
    try {
      expect((await del("vic")).status).toBe(404);
    } finally {
      actor = owner;
    }
    expect((await listCollaborators(docId)).map((c) => c.login)).toContain("vic");
    expect(await shareRemovals()).toHaveLength(before);
  });
});

/**
 * `docs/agents.md` promises that a non-2xx status means nothing changed. The collaborator row is written
 * (inside `changeCollaboratorAccess`) before the activity row and the share notification; a failure there
 * used to answer 500 for a share that had already been granted or ended — and the retry of a removal then
 * answered `404 Collaborator not found` for a removal that did happen. Audit #1202 F15.
 */
describe("post-write failures on /api/documents/:id/collaborators are warnings on the 2xx", () => {
  it("POST: a normal share answers exactly { ok, login, role, pending } — no warnings key", async () => {
    const res = await add("pat", "viewer");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "pat", role: "viewer", pending: false });
    expect((await listCollaborators(docId)).find((c) => c.login === "pat")).toMatchObject({ role: "viewer" });
    expect(await shareActivity("share.add")).toHaveLength(1);
    expect(await notificationsFor("pat")).toHaveLength(1);
  });

  it("POST with recordActivity failing: 200, the collaborator row is present, warnings: [activity-not-recorded], the person is still notified", async () => {
    await removeCollaborator(docId, "pat");
    const db = await getDb();
    await db.delete(schema.notifications).where(eq(schema.notifications.userLogin, "pat"));
    const activityBefore = (await shareActivity("share.add")).length;

    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => add("pat", "editor"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, login: "pat", role: "editor", pending: false, warnings: ["activity-not-recorded"] });
    // The driver's message (statement + parameters) stays in the log, logged once under the route's code.
    expect(JSON.stringify(body)).not.toContain("Failed query");
    expect(logged).toEqual([["[collaborators] activity-not-recorded", expect.any(Error)]]);

    expect((await listCollaborators(docId)).find((c) => c.login === "pat")).toMatchObject({ role: "editor" });
    expect(await shareActivity("share.add")).toHaveLength(activityBefore);
    expect(await notificationsFor("pat")).toHaveLength(1);
  });

  it("POST with notifyShare failing: 200, the row and the activity are present, warnings: [notification-not-sent]", async () => {
    await removeCollaborator(docId, "pat");
    const db = await getDb();
    await db.delete(schema.notifications).where(eq(schema.notifications.userLogin, "pat"));
    const activityBefore = (await shareActivity("share.add")).length;

    vi.mocked(notifyShare).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => add("pat", "commenter"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "pat", role: "commenter", pending: false, warnings: ["notification-not-sent"] });
    expect(logged).toEqual([["[collaborators] notification-not-sent", expect.any(Error)]]);

    expect((await listCollaborators(docId)).find((c) => c.login === "pat")).toMatchObject({ role: "commenter" });
    const added = await shareActivity("share.add");
    expect(added).toHaveLength(activityBefore + 1);
    expect(added[added.length - 1].detail).toEqual({ login: "pat", role: "commenter" });
    expect(await notificationsFor("pat")).toHaveLength(0);
  });

  it("POST with both failing lists both codes, in write order", async () => {
    await removeCollaborator(docId, "pat");
    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    vi.mocked(notifyShare).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => add("pat", "viewer"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "pat", role: "viewer", pending: false, warnings: ["activity-not-recorded", "notification-not-sent"] });
    expect(logged).toEqual([
      ["[collaborators] activity-not-recorded", expect.any(Error)],
      ["[collaborators] notification-not-sent", expect.any(Error)],
    ]);
    expect((await listCollaborators(docId)).map((c) => c.login)).toContain("pat");
  });

  it("DELETE with recordActivity failing: 200 with the warning, the row is gone, and the retry is the honest 404", async () => {
    await upsertCollaborator(docId, "pat", "editor", owner.id);
    const before = (await shareRemovals()).length;

    vi.mocked(recordActivity).mockRejectedValueOnce(DB_FAILURE);
    const { result: res, logged } = await quietly(() => del("pat"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warnings: ["activity-not-recorded"] });
    expect(logged).toEqual([["[collaborators] activity-not-recorded", expect.any(Error)]]);
    expect((await listCollaborators(docId)).map((c) => c.login)).not.toContain("pat");
    expect(await shareRemovals()).toHaveLength(before);

    // Nothing left to remove: the 404 now describes the world correctly (the caller already got its 200).
    const again = await del("pat");
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "Collaborator not found" });
    expect(await shareRemovals()).toHaveLength(before);
  });

  it("a failing primary write is still a 500 with nothing recorded and nobody notified", async () => {
    await upsertCollaborator(docId, "pat", "editor", owner.id);
    const activityBefore = (await shareActivity("share.add")).length;
    const notificationsBefore = (await notificationsFor("pat")).length;

    vi.mocked(upsertCollaborator).mockRejectedValueOnce(DB_FAILURE);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await add("pat", "viewer");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Unexpected error" });
    } finally {
      errors.mockRestore();
    }
    expect((await listCollaborators(docId)).find((c) => c.login === "pat")).toMatchObject({ role: "editor" });
    expect(await shareActivity("share.add")).toHaveLength(activityBefore);
    expect(await notificationsFor("pat")).toHaveLength(notificationsBefore);
  });
});
