import { describe, expect, it, beforeAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
// This file sends more writes from one caller than the limiter allows in a minute (it is covered by its own tests).
process.env.RATE_LIMIT = "off";
delete process.env.DATABASE_URL;

// Same stand-ins as star.test.ts: the routes resolve the caller through next-auth and `next/headers`.
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
/** An API token's secret: the request then acts as that token, not as `actor`. */
let bearer: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(bearer ? { authorization: ["Bearer", bearer].join(" ") } : {}) }));
// Wrapped so a test can make the activity row or the share notification fail after the collaborator row is written.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return { ...actual, notifyShare: vi.fn(actual.notifyShare) };
});
// Wrapped so one test can make the primary write itself fail and check that it stays a 500, and so the
// route's first look at the collaborator row can be made to miss a row another request has just written.
vi.mock("@/server/documents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents")>();
  return { ...actual, addCollaborator: vi.fn(actual.addCollaborator), getCollaboratorRole: vi.fn(actual.getCollaboratorRole) };
});
// Wrapped to count it: this is what pauses and re-resolves a person's live connections.
vi.mock("@/server/collab/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/collab/authorization")>();
  return { ...actual, changeCollaboratorAccess: vi.fn(actual.changeCollaboratorAccess) };
});

const { getDb, schema } = await import("@/server/db");
const { addCollaborator, createDocument, getCollaboratorRole, listCollaborators, removeCollaborator, upsertCollaborator } = await import("@/server/documents");
const { recordActivity } = await import("@/server/activity");
const { notifyShare } = await import("@/server/notifications");
const { changeCollaboratorAccess } = await import("@/server/collab/authorization");
const { createApiToken } = await import("@/server/tokens");
const { isValidLogin } = await import("@/components/editor/collaborator-login-input");
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
const post = (body: unknown, id = docId) =>
  POST(
    new Request(`http://localhost:3700/api/documents/${id}/collaborators`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    params(id),
  );
const add = (login: string, role = "editor", extra: Record<string, unknown> = {}) => post({ login, role, ...extra });
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

    vi.mocked(addCollaborator).mockRejectedValueOnce(DB_FAILURE);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await add("pat", "viewer", { change: true });
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

/** Issue #2252. Counts are read from the database, so each test names exactly what a request wrote. */
type Role = "editor" | "commenter" | "viewer";
const ROLES: Role[] = ["editor", "commenter", "viewer"];
let serial = 0;
/** A login nobody has used in this file. */
const fresh = (base: string) => `${base}-${++serial}`;
/** A user row for the login: a share with them answers 200 instead of 202 pending. */
const signedIn = async (login: string): Promise<Actor> => {
  const db = await getDb();
  const [row] = await db.insert(schema.users).values({ name: login, login, email: `${login}@example.com` }).returning();
  return { id: row.id, login, name: login, image: null };
};
const roleOf = async (login: string, id = docId) => (await listCollaborators(id)).find((c) => c.login === login)?.role ?? null;
const rowsLike = async (login: string) => (await listCollaborators(docId)).filter((c) => c.login.toLowerCase() === login.toLowerCase()).length;
const addsFor = async (login: string) => (await shareActivity("share.add")).filter((a) => (a.detail as { login?: string }).login === login);
const transitions = () => vi.mocked(changeCollaboratorAccess).mock.calls.length;
/**
 * Everything a request could have written or touched for this login. `recorded` and `notified` count the
 * calls themselves (tests run one after the other): a second share notification for the same person and
 * document is dropped by its unique key, so the row count alone would not show a notification that was sent.
 */
const written = async (login: string) => ({
  role: await roleOf(login),
  rows: await rowsLike(login),
  activity: (await addsFor(login)).length,
  notifications: (await notificationsFor(login)).length,
  transitions: transitions(),
  recorded: vi.mocked(recordActivity).mock.calls.length,
  notified: vi.mocked(notifyShare).mock.calls.length,
});
const refusal = (login: string, role: Role) => ({
  error: `${login} already has access as ${role}. Send change: true to change the role.`,
  code: "already-collaborator",
  login,
  role,
});
/** Runs `fn` as another caller: a signed-in person, nobody, or (with `token`) an API token. */
const as = async <T>(who: Actor | null, fn: () => Promise<T>, token: string | null = null): Promise<T> => {
  actor = who;
  bearer = token;
  try {
    return await fn();
  } finally {
    actor = owner;
    bearer = null;
  }
};

describe("POST /api/documents/:id/collaborators: an add never changes a role (#2252)", () => {
  const cases = (["known", "pending"] as const).flatMap((who) => ROLES.flatMap((before) => ROLES.map((posted) => ({ who, before, posted }))));

  it.each(cases)("$who person who is $before, POST role $posted", async ({ who, before, posted }) => {
    const login = fresh(`matrix-${who}`);
    if (who === "known") await signedIn(login);
    const status = who === "known" ? 200 : 202;
    const pending = who === "pending";
    expect((await add(login, before)).status).toBe(status);
    const first = await written(login);
    expect(first).toMatchObject({ role: before, rows: 1, activity: 1, notifications: 1 });

    const again = await add(login, posted);
    if (posted === before) {
      // The same role: the first add's answer again, and nothing at all is written or touched.
      expect(again.status).toBe(status);
      expect(await again.json()).toEqual({ ok: true, login, role: before, pending });
    } else {
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual(refusal(login, before));
    }
    expect(await written(login)).toEqual(first);

    // `change: false` is the same as leaving it out.
    const explicitNo = await add(login, posted, { change: false });
    expect(explicitNo.status).toBe(posted === before ? status : 409);
    expect(await written(login)).toEqual(first);

    // Explicit intent: the role is set. A role that is already in place still writes nothing.
    const changed = await add(login, posted, { change: true });
    expect(changed.status).toBe(status);
    expect(await changed.json()).toEqual({ ok: true, login, role: posted, pending });
    const after = await written(login);
    if (posted === before) {
      expect(after).toEqual(first);
    } else {
      // As before #2252 for a role change: one more activity row, and the share notification is asked for
      // again but its row already exists (unique per person and document), so the person gets no second one.
      expect(after).toEqual({
        role: posted,
        rows: 1,
        activity: 2,
        notifications: 1,
        transitions: first.transitions + 1,
        recorded: first.recorded + 1,
        notified: first.notified + 1,
      });
      expect((await addsFor(login)).map((a) => a.detail)).toContainEqual({ login, role: posted });
      expect(vi.mocked(notifyShare).mock.calls.at(-1)?.slice(0, 3)).toEqual([docId, login, posted]);
    }

    // And once more with the flag: nothing left to change, nothing written.
    expect((await add(login, posted, { change: true })).status).toBe(status);
    expect(await written(login)).toEqual(after);
  });

  it("change: true for a login without access is an add (the call sets the role whether or not the person had access)", async () => {
    const login = fresh("change-adds");
    const res = await add(login, "commenter", { change: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, login, role: "commenter", pending: true });
    expect(await written(login)).toMatchObject({ role: "commenter", rows: 1, activity: 1, notifications: 1 });
  });

  it("a person removed after a refusal can be added again, as an add", async () => {
    const login = fresh("removed-between");
    await add(login, "viewer");
    expect((await add(login, "editor")).status).toBe(409);
    expect((await del(login)).status).toBe(200);

    const res = await add(login, "editor");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, login, role: "editor", pending: true });
    expect(await written(login)).toMatchObject({ role: "editor", rows: 1, activity: 2 });
  });

  it.each([["the string true", "true"], ["the number 1", 1], ["null", null], ["an object", {}]])("change must be a real boolean: %s is a 400 and nothing changes", async (_label, value) => {
    const login = fresh("strict-change");
    await add(login, "viewer");
    const before = await written(login);

    const res = await add(login, "editor", { change: value });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("Invalid request");
    expect(body.issues.map((issue) => issue.path)).toEqual([["change"]]);
    expect(await written(login)).toEqual(before);
  });

  it.each(["@Mixed-Name", "MIXED-NAME", "mixed-name", "  Mixed-name  ", "@mixed-NAME "])("%j is the stored person mixed-name on the add path and on the change path: never a second row", async (typed) => {
    await removeCollaborator(docId, "mixed-name");
    expect((await add("mixed-name", "viewer")).status).toBe(202);
    const before = await written("mixed-name");

    // Same role: found, nothing written.
    const same = await add(typed, "viewer");
    expect(same.status).toBe(202);
    expect(await same.json()).toEqual({ ok: true, login: "mixed-name", role: "viewer", pending: true });
    // Another role: refused for the stored person.
    const other = await add(typed, "editor");
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual(refusal("mixed-name", "viewer"));
    expect(await written("mixed-name")).toEqual(before);

    // With the flag: that one row changes.
    const changed = await add(typed, "editor", { change: true });
    expect(changed.status).toBe(202);
    expect(await changed.json()).toEqual({ ok: true, login: "mixed-name", role: "editor", pending: true });
    expect(await written("mixed-name")).toMatchObject({ role: "editor", rows: 1, activity: before.activity + 1 });
    const stored = (await listCollaborators(docId)).map((c) => c.login).filter((login) => login.trim().replace(/^@/, "").toLowerCase() === "mixed-name");
    expect(stored).toEqual(["mixed-name"]);
  });

  it("the owner is refused as before, with and without the flag", async () => {
    for (const extra of [{}, { change: true }]) {
      const res = await add("@Olive", "viewer", extra);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That is the owner" });
    }
    expect(await roleOf("olive")).toBeNull();
  });

  it("a refusal that is only found by the write itself (another request added the person first) is still a 409 that records nothing", async () => {
    const login = fresh("late-refusal");
    await add(login, "viewer");
    const before = await written(login);

    // The route's first look misses the row, as it does when the other request has not committed yet.
    vi.mocked(getCollaboratorRole).mockResolvedValueOnce(null);
    const res = await add(login, "editor");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(refusal(login, "viewer"));
    // The write was attempted (one transition) and decided against it: same role, no activity, no notification.
    expect(await written(login)).toEqual({ ...before, transitions: before.transitions + 1 });
  });

  it("the same role found only by the write itself answers as an add and records nothing", async () => {
    const login = fresh("late-same");
    await add(login, "viewer");
    const before = await written(login);

    vi.mocked(getCollaboratorRole).mockResolvedValueOnce(null);
    const res = await add(login, "viewer");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, login, role: "viewer", pending: true });
    expect(await written(login)).toEqual({ ...before, transitions: before.transitions + 1 });
  });

  it("two adds of the same new login with different roles at the same moment: one wins, the other is refused, never a silent change", async () => {
    for (let round = 0; round < 8; round += 1) {
      const login = fresh("race");
      const [first, second]: Role[] = round % 2 ? ["editor", "viewer"] : ["viewer", "editor"];
      const answers = await Promise.all([add(login, first), add(login, second)]);
      const statuses = answers.map((res) => res.status);
      expect([...statuses].sort()).toEqual([202, 409]);
      const winner = answers[statuses.indexOf(202)];
      const loser = answers[statuses.indexOf(409)];
      const won = ((await winner.json()) as { role: Role }).role;
      expect(await loser.json()).toEqual(refusal(login, won));
      // One row with the winner's role, recorded once and announced once: the loser wrote neither.
      expect(await written(login)).toMatchObject({ role: won, rows: 1, activity: 1, notifications: 1 });
      expect((await addsFor(login))[0].detail).toEqual({ login, role: won });
    }
  });

  it("two adds of the same new login with the same role at the same moment: both succeed, recorded once", async () => {
    const login = fresh("race-same");
    const answers = await Promise.all([add(login, "commenter"), add(login, "commenter")]);
    expect(answers.map((res) => res.status)).toEqual([202, 202]);
    expect(await written(login)).toMatchObject({ role: "commenter", rows: 1, activity: 1, notifications: 1 });
  });

  it("an add racing a change of the same person never undoes the change", async () => {
    const login = fresh("race-change");
    await add(login, "viewer");
    const answers = await Promise.all([add(login, "editor", { change: true }), add(login, "commenter")]);
    expect(answers.map((res) => res.status)).toEqual([202, 409]);
    expect(await written(login)).toMatchObject({ role: "editor", rows: 1, activity: 2 });
  });

  it("addCollaborator() decides and writes in one statement", async () => {
    const login = fresh("statement");
    const both = await Promise.all([addCollaborator(docId, login, "editor", owner.id), addCollaborator(docId, `@${login.toUpperCase()}`, "viewer", owner.id)]);
    expect(both.filter((r) => r.outcome === "written")).toHaveLength(1);
    const won = both[0].outcome === "written" ? "editor" : "viewer";
    expect(both.find((r) => r.outcome !== "written")).toEqual({ outcome: "refused", role: won });
    expect(await getCollaboratorRole(docId, ` @${login} `)).toBe(won);
    expect(await rowsLike(login)).toBe(1);

    expect(await addCollaborator(docId, login, won, owner.id)).toEqual({ outcome: "unchanged" });
    expect(await addCollaborator(docId, login, won, owner.id, { change: true })).toEqual({ outcome: "unchanged" });
    expect(await addCollaborator(docId, login, "commenter", owner.id, { change: true })).toEqual({ outcome: "written" });
    expect(await getCollaboratorRole(docId, login)).toBe("commenter");
    expect(await addCollaborator(docId, fresh("statement-new"), "viewer", owner.id, { change: true })).toEqual({ outcome: "written" });
    expect(await getCollaboratorRole(docId, "nobody-here")).toBeNull();
  });
});

describe("POST /api/documents/:id/collaborators: who may call it (#2252)", () => {
  let people: Record<Role, Actor>;
  let stranger: Actor;
  let target: string;

  beforeAll(async () => {
    people = { editor: await signedIn("perm-editor"), commenter: await signedIn("perm-commenter"), viewer: await signedIn("perm-viewer") };
    stranger = await signedIn("perm-stranger");
    for (const role of ROLES) await upsertCollaborator(docId, people[role].login, role, owner.id);
    target = "perm-target";
    await upsertCollaborator(docId, target, "viewer", owner.id);
  });

  const attempts = [
    { what: "add a new person", body: () => ({ login: "perm-new", role: "editor" }) },
    { what: "add a new person with the flag", body: () => ({ login: "perm-new", role: "editor", change: true }) },
    { what: "re-add a Viewer as Editor", body: () => ({ login: target, role: "editor" }) },
    { what: "change a Viewer to Editor with the flag", body: () => ({ login: target, role: "editor", change: true }) },
  ];

  it.each(ROLES.flatMap((role) => attempts.map((attempt) => ({ role, ...attempt }))))("a collaborating $role cannot $what: 403, nothing changes", async ({ role, body }) => {
    const before = await listCollaborators(docId);
    const activity = (await shareActivity("share.add")).length;
    const calls = transitions();

    const res = await as(people[role], () => post(body()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You do not have permission to do that" });
    expect(await listCollaborators(docId)).toEqual(before);
    expect(await shareActivity("share.add")).toHaveLength(activity);
    expect(transitions()).toBe(calls);
  });

  it.each(ROLES)("a collaborating %s cannot raise their own role with the flag", async (role) => {
    const res = await as(people[role], () => add(people[role].login, "editor", { change: true }));
    expect(res.status).toBe(403);
    expect(await roleOf(people[role].login)).toBe(role);
  });

  it.each(attempts)("a stranger gets 404 and a signed-out caller 401 when they try to $what", async ({ body }) => {
    const before = await listCollaborators(docId);
    expect((await as(stranger, () => post(body()))).status).toBe(404);
    expect((await as(null, () => post(body()))).status).toBe(401);
    expect(await listCollaborators(docId)).toEqual(before);
  });

  it("the owner's full-access token follows the same rule: 409 without the flag, the change with it", async () => {
    const token = (await createApiToken(owner.id, "Share agent")).token;
    const login = fresh("token-full");
    expect((await as(null, () => add(login, "viewer"), token)).status).toBe(202);
    const before = await written(login);

    const refused = await as(null, () => add(login, "editor"), token);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual(refusal(login, "viewer"));
    expect(await written(login)).toEqual(before);

    const changed = await as(null, () => add(login, "editor", { change: true }), token);
    expect(changed.status).toBe(202);
    expect(await written(login)).toMatchObject({ role: "editor", rows: 1, activity: before.activity + 1 });
  });

  it.each(["read", "comment"] as const)("the owner's %s-scoped token cannot call it at all, with or without the flag", async (scope) => {
    const token = (await createApiToken(owner.id, `Share ${scope} agent`, { scope })).token;
    const before = await listCollaborators(docId);
    for (const extra of [{}, { change: true }]) {
      const res = await as(null, () => add(target, "editor", extra), token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ scope, requiredScope: "full" });
    }
    expect(await listCollaborators(docId)).toEqual(before);
  });

  it("an editor's full-access token and a token restricted to another document change nothing", async () => {
    const editorToken = (await createApiToken(people.editor.id, "Editor agent")).token;
    const other = await createDocument({ ownerId: owner.id, title: "Other" });
    const elsewhere = (await createApiToken(owner.id, "Other doc agent", { documentIds: [other.id] })).token;
    const before = await listCollaborators(docId);

    expect((await as(null, () => add(target, "editor", { change: true }), editorToken)).status).toBe(403);
    expect((await as(null, () => add(target, "editor", { change: true }), elsewhere)).status).toBe(404);
    expect(await listCollaborators(docId)).toEqual(before);
  });
});

describe("POST /api/documents/:id/collaborators: the handle (#2252 item 2)", () => {
  const thirtyNine = `${"n".repeat(38)}x`;
  const forty = "f".repeat(40);
  const TOO_BIG = "Too big: expected string to have <=39 characters";
  const NOT_A_HANDLE = "Enter a GitHub handle";
  // What is typed, whether it is addable, and the stored login or the first validation message.
  const handles: [label: string, typed: string, stored: string | null, message: string | null][] = [
    ["empty", "", null, NOT_A_HANDLE],
    ["@ alone", "@", null, NOT_A_HANDLE],
    ["39 characters", thirtyNine, thirtyNine, null],
    ["@ + 39 characters", `@${thirtyNine}`, thirtyNine, null],
    ["40 characters", forty, null, TOO_BIG],
    ["@ + 40 characters", `@${forty}`, null, TOO_BIG],
    ["@@name", "@@name", null, NOT_A_HANDLE],
    ["a trailing space", "trailing-space ", "trailing-space", null],
    ["upper case", "UPPER-Case", "upper-case", null],
    ["a space after the @", "@ name", null, NOT_A_HANDLE],
    ["an underscore", "under_score", null, NOT_A_HANDLE],
  ];

  it.each(handles)("%s: the server and the dialog's Add button agree", async (_label, typed, stored, message) => {
    if (stored) await removeCollaborator(docId, stored);
    const res = await add(typed, "viewer");
    const body = (await res.json()) as { login?: string; error?: string; issues?: { message: string }[] };
    if (stored) {
      expect(res.status).toBe(202);
      expect(body.login).toBe(stored);
      expect(await rowsLike(stored)).toBe(1);
    } else {
      expect(res.status).toBe(400);
      expect(body.error).toBe("Invalid request");
      expect(body.issues?.[0]?.message).toBe(message);
    }
    // `isValidLogin` is what enables Add in the Share dialog: enabled exactly when the server accepts the handle.
    expect(isValidLogin(typed)).toBe(stored !== null);
  });

  it("@ + 40 characters is refused with exactly the message 40 characters get", async () => {
    const messages = await Promise.all([forty, `@${forty}`].map(async (typed) => ((await (await add(typed, "viewer")).json()) as { issues: { message: string }[] }).issues.map((issue) => issue.message)));
    expect(messages[1]).toEqual(messages[0]);
    expect(messages[0]).toEqual([TOO_BIG]);
  });
});