import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

/**
 * The API/MCP consistency sweep (#121): a route must not answer 2xx for something that did not
 * happen, must not return the wrong type, and must say what `docs/agents.md` says. One `describe`
 * per checkbox. `actor` stands in for the session; `bearer` makes the request carry a real API
 * token so the agent path (`user.agent`) is exercised.
 */
let actor: { id: string; login: string; name: string; image: null } | null = null;
let bearer: string | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(bearer ? { authorization: `Bearer ${bearer}` } : {}) }));

const { getDb, schema } = await import("@/server/db");
const { createDocument, deleteDocument, addVersion, listCollaborators } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { notify, NOTIFICATION_KINDS } = await import("@/server/notifications");
const version = await import("@/app/api/documents/[id]/versions/[vid]/route");
const restore = await import("@/app/api/documents/[id]/restore/route");
const collaborators = await import("@/app/api/documents/[id]/collaborators/route");
const comments = await import("@/app/api/documents/[id]/comments/route");
const tokens = await import("@/app/api/tokens/route");
const catchAll = await import("@/app/api/[...rest]/route");
const notifications = await import("@/app/api/notifications/route");
const activity = await import("@/app/api/documents/[id]/activity/route");

type Err = { error: string; issues?: { path: (string | number)[]; message: string }[] };

let eve: { id: string; login: string; name: string; image: null };
let docId: string;

const url = (path: string) => `http://localhost:3700${path}`;
const jsonReq = (path: string, method: string, body?: unknown) =>
  new Request(url(path), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Eve", login: "eve", email: "eve@example.com" }).returning();
  eve = { id: user.id, login: "eve", name: "Eve", image: null };
  actor = eve;
  docId = (await createDocument({ ownerId: user.id, title: "shape", content: "# shape\n\nAlpha.\n" })).id;
});

describe("DELETE /api/documents/:id/versions/:vid", () => {
  it("is 404 for a version that does not exist, like rename is", async () => {
    const del = await version.DELETE(jsonReq(`/api/documents/${docId}/versions/does-not-exist`, "DELETE"), params({ id: docId, vid: "does-not-exist" }));
    expect(del.status).toBe(404);
    expect(await del.json()).toEqual({ error: "Version not found" });

    const rename = await version.POST(jsonReq(`/api/documents/${docId}/versions/does-not-exist`, "POST", { action: "rename", title: "x" }), params({ id: docId, vid: "does-not-exist" }));
    expect(rename.status).toBe(404);
    expect(await rename.json()).toEqual({ error: "Version not found" });
  });

  it("still deletes a real version once (the second call is 404)", async () => {
    const v = await addVersion({ documentId: docId, content: "# shape\n\nOld.\n", kind: "named", title: "Old" });
    const first = await version.DELETE(jsonReq(`/api/documents/${docId}/versions/${v.id}`, "DELETE"), params({ id: docId, vid: v.id }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const second = await version.DELETE(jsonReq(`/api/documents/${docId}/versions/${v.id}`, "DELETE"), params({ id: docId, vid: v.id }));
    expect(second.status).toBe(404);
  });
});

describe("POST /api/documents/:id/restore", () => {
  it("is 409 for a document that is not in the trash, 200 once it is", async () => {
    const live = await restore.POST(jsonReq(`/api/documents/${docId}/restore`, "POST"), params({ id: docId }));
    expect(live.status).toBe(409);
    expect(await live.json()).toEqual({ error: "Document is not in the trash" });

    await deleteDocument(docId);
    const restored = await restore.POST(jsonReq(`/api/documents/${docId}/restore`, "POST"), params({ id: docId }));
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { ok: boolean; document: { id: string; deletedAt: string | null } };
    expect(body.ok).toBe(true);
    expect(body.document.id).toBe(docId);
    expect(body.document.deletedAt ?? null).toBeNull();

    expect((await restore.POST(jsonReq(`/api/documents/${docId}/restore`, "POST"), params({ id: docId }))).status).toBe(409);
  });
});

describe("POST /api/documents/:id/collaborators", () => {
  const add = (login: string, role = "viewer") => collaborators.POST(jsonReq(`/api/documents/${docId}/collaborators`, "POST", { login, role }), params({ id: docId }));

  it("answers 202 { pending: true } for a handle nobody has signed in with", async () => {
    const res = await add("zzz-nobody-ever");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, login: "zzz-nobody-ever", role: "viewer", pending: true });
    // The share is stored so it applies on first sign-in; the caller just knows it is pending.
    expect((await listCollaborators(docId)).map((c) => c.login)).toContain("zzz-nobody-ever");
  });

  it("answers 200 { pending: false } for a known user, case-insensitively", async () => {
    const db = await getDb();
    await db.insert(schema.users).values({ name: "Drew", login: "Drew", email: "drew@example.com" });
    const res = await add("@drew", "editor");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "drew", role: "editor", pending: false });
  });
});

describe("POST /api/documents/:id/comments { action: react }", () => {
  let threadId: string;
  const post = (body: unknown) => comments.POST(jsonReq(`/api/documents/${docId}/comments`, "POST", body), params({ id: docId }));

  beforeAll(async () => {
    const res = await post({ action: "add", quote: "Alpha", body: "Looks good" });
    expect(res.status).toBe(200);
    threadId = ((await res.json()) as { id: string }).id;
  });

  it("rejects anything that is not a single emoji with a zod issue on `emoji`", async () => {
    for (const emoji of ["not-an-emoji", "+1", ":thumbsup:", "👍👍", "a"]) {
      const res = await post({ action: "react", threadId, emoji });
      expect(res.status, emoji).toBe(400);
      const body = (await res.json()) as Err;
      expect(body.error).toBe("Invalid request");
      expect(body.issues?.[0]?.path).toEqual(["emoji"]);
      expect(body.issues?.[0]?.message).toContain("emoji");
    }
    const threads = (await (await comments.GET(jsonReq(`/api/documents/${docId}/comments`, "GET"), params({ id: docId }))).json()) as { comments: { id: string; reactions: Record<string, string[]> }[] };
    expect(threads.comments.find((t) => t.id === threadId)?.reactions).toEqual({});
  });

  it("accepts real emoji: plain, variation selector, skin tone, ZWJ sequence, keycap, flag", async () => {
    for (const emoji of ["👍", "❤️", "👍🏽", "👨‍👩‍👧", "1️⃣", "🇫🇷"]) {
      const res = await post({ action: "react", threadId, emoji });
      expect(res.status, emoji).toBe(200);
      expect(await res.json()).toEqual({ ok: true, reacted: true });
    }
  });
});

describe("GET /api/tokens", () => {
  it("is 403 with a token (session only, like POST and DELETE) and 200 with a session", async () => {
    const minted = await createApiToken(eve.id, "scout-mcp", 30);
    bearer = minted.token;
    try {
      const res = await tokens.GET();
      expect(res.status).toBe(403);
      const body = (await res.json()) as Err;
      expect(body.error).toMatch(/session/);
      expect(JSON.stringify(body)).not.toContain(minted.id);
    } finally {
      bearer = null;
    }
    const ok = await tokens.GET();
    expect(ok.status).toBe(200);
    const list = (await ok.json()) as { tokens: { id: string }[] };
    expect(list.tokens.map((t) => t.id)).toContain(minted.id);
  });
});

describe("unknown /api paths", () => {
  it("answer 404 JSON, not the HTML page, for every method", async () => {
    const methods = { GET: catchAll.GET, POST: catchAll.POST, PUT: catchAll.PUT, PATCH: catchAll.PATCH, DELETE: catchAll.DELETE, OPTIONS: catchAll.OPTIONS, HEAD: catchAll.HEAD };
    for (const [method, fn] of Object.entries(methods)) {
      const res = await fn(new Request(url(`/api/documents/${docId}/nope`), { method }));
      expect(res.status, method).toBe(404);
      expect(res.headers.get("content-type"), method).toContain("application/json");
      if (method !== "HEAD") expect(await res.json()).toEqual({ error: "Not found", path: `/api/documents/${docId}/nope` });
    }
  });
});

describe("limit caps", () => {
  it("GET /api/notifications?limit= outside 1–100 is 400 with the zod issue, valid values work", async () => {
    await notify({ userLogin: "eve", documentId: docId, kind: "share", actorLogin: "drew", actorName: "Drew", refId: `${docId}:eve`, snippet: "viewer" });
    for (const limit of ["100000", "0", "-1", "abc", "1.5"]) {
      const res = await notifications.GET(jsonReq(`/api/notifications?limit=${limit}`, "GET"));
      expect(res.status, limit).toBe(400);
      const body = (await res.json()) as Err;
      expect(body.error).toBe("Invalid request");
      expect(body.issues?.[0]?.path).toEqual(["limit"]);
    }
    const ok = await notifications.GET(jsonReq(`/api/notifications?limit=100&kind=share`, "GET"));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect((await notifications.GET(jsonReq(`/api/notifications`, "GET"))).status).toBe(200);
  });

  it("GET /api/notifications?kind= outside the documented kinds is 400, every real kind works", async () => {
    for (const kind of ["bogus", "mentions", "Share", "share,reply"]) {
      const res = await notifications.GET(jsonReq(`/api/notifications?kind=${kind}`, "GET"));
      expect(res.status, kind).toBe(400);
      const body = (await res.json()) as Err;
      expect(body.error).toBe("Invalid request");
      expect(body.issues?.[0]?.path).toEqual(["kind"]);
    }
    for (const kind of NOTIFICATION_KINDS) {
      const res = await notifications.GET(jsonReq(`/api/notifications?kind=${kind}`, "GET"));
      expect(res.status, kind).toBe(200);
      const { items } = (await res.json()) as { items: { kind: string }[] };
      for (const n of items) expect(n.kind).toBe(kind);
    }
    const mention = (await (await notifications.GET(jsonReq(`/api/notifications?kind=mention`, "GET"))).json()) as { items: unknown[] };
    expect(mention.items).toEqual([]);
  });

  it("GET /api/documents/:id/activity?limit= outside 1–200 is 400, valid values work", async () => {
    for (const limit of ["100000", "201", "0", "abc"]) {
      const res = await activity.GET(jsonReq(`/api/documents/${docId}/activity?limit=${limit}`, "GET"), params({ id: docId }));
      expect(res.status, limit).toBe(400);
      const body = (await res.json()) as Err;
      expect(body.error).toBe("Invalid request");
      expect(body.issues?.[0]?.path).toEqual(["limit"]);
    }
    expect((await activity.GET(jsonReq(`/api/documents/${docId}/activity?limit=200`, "GET"), params({ id: docId }))).status).toBe(200);
    expect((await activity.GET(jsonReq(`/api/documents/${docId}/activity`, "GET"), params({ id: docId }))).status).toBe(200);
  });
});
