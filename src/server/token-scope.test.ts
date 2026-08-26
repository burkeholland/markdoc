import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

/**
 * Scoped API tokens (#124): a token is never wider than its user, and can be narrower. `read` gets
 * the GET routes, watch and presence; `comment` adds comments, suggestions, reviews and requests;
 * `full` is the user's own access. A token restricted to some documents answers 404 for the rest.
 * Browser sessions (`actor` without a bearer) are untouched.
 */
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { requireAccess, requireScope, scopeError, HttpError } = await import("@/server/http");
const content = await import("@/app/api/documents/[id]/content/route");
const comments = await import("@/app/api/documents/[id]/comments/route");
const suggest = await import("@/app/api/documents/[id]/suggest/route");
const document = await import("@/app/api/documents/[id]/route");
const documents = await import("@/app/api/documents/route");
const presence = await import("@/app/api/agent/documents/[id]/presence/route");
const duplicate = await import("@/app/api/documents/[id]/duplicate/route");
const star = await import("@/app/api/documents/[id]/star/route");
const me = await import("@/app/api/me/route");
const tokens = await import("@/app/api/tokens/route");

type Err = { error: string; scope?: string; requiredScope?: string };

let owner: Actor;
let d1: string;
let d2: string;
let readToken: string;
let commentToken: string;
let fullToken: string;
let d1Token: string;

const url = (path: string) => `http://localhost:3700${path}`;
const jsonReq = (path: string, method: string, body?: unknown) =>
  new Request(url(path), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Run `fn` as the given bearer token (no session), or as the session when `token` is null. */
const as = async <T>(token: string | null, fn: () => Promise<T>) => {
  const saved = requestHeaders;
  requestHeaders = token ? new Headers({ authorization: ["Bearer", token].join(" ") }) : new Headers();
  try {
    return await fn();
  } finally {
    requestHeaders = saved;
  }
};

beforeAll(async () => {
  const db = await getDb();
  const [user] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  owner = { id: user.id, login: "olive", name: "Olive", image: null };
  actor = owner;
  d1 = (await createDocument({ ownerId: owner.id, title: "One", content: "# One\n\nAlpha beta gamma.\n" })).id;
  d2 = (await createDocument({ ownerId: owner.id, title: "Two", content: "# Two\n\nDelta.\n" })).id;
  readToken = (await createApiToken(owner.id, "Reader", { scope: "read" })).token;
  commentToken = (await createApiToken(owner.id, "Reviewer", { scope: "comment" })).token;
  fullToken = (await createApiToken(owner.id, "Copilot", { scope: "full" })).token;
  d1Token = (await createApiToken(owner.id, "One only", { scope: "full", documentIds: [d1] })).token;
});

describe("a read token", () => {
  it("reads content, the document card (as a viewer) and presence, but cannot comment, rewrite or delete", async () => {
    const read = await as(readToken, () => content.GET(jsonReq(`/api/documents/${d1}/content`, "GET"), params(d1)));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { content: string }).content).toContain("Alpha");

    const card = await as(readToken, () => document.GET(jsonReq(`/api/documents/${d1}`, "GET"), params(d1)));
    expect(card.status).toBe(200);
    expect(((await card.json()) as { role: string }).role).toBe("viewer");

    const seen = await as(readToken, () => presence.POST(jsonReq(`/api/agent/documents/${d1}/presence`, "POST", { state: "active", status: "reading" }), params(d1)));
    expect(seen.status).toBe(200);

    const comment = await as(readToken, () => comments.POST(jsonReq(`/api/documents/${d1}/comments`, "POST", { action: "add", quote: "Alpha", body: "Hm" }), params(d1)));
    expect(comment.status).toBe(403);
    expect(((await comment.json()) as Err).error).toBe("This token is read-scoped; create a comment or full-access token at /settings to comment and suggest");

    const rewrite = await as(readToken, () => content.PUT(jsonReq(`/api/documents/${d1}/content`, "PUT", { content: "# One\n\nRewritten.\n" }), params(d1)));
    expect(rewrite.status).toBe(403);
    expect((await rewrite.json()) as Err).toEqual({ error: "This token is read-scoped; create a full-access token at /settings to rewrite documents", scope: "read", requiredScope: "full" });

    const del = await as(readToken, () => document.DELETE(jsonReq(`/api/documents/${d1}`, "DELETE"), params(d1)));
    expect(del.status).toBe(403);

    const create = await as(readToken, () => documents.POST(jsonReq(`/api/documents`, "POST", { title: "Nope" })));
    expect(create.status).toBe(403);
    expect(((await create.json()) as Err).error).toMatch(/read-scoped.*create documents/);
    // Copying is creating; starring is a write.
    const copy = await as(readToken, () => duplicate.POST(jsonReq(`/api/documents/${d1}/duplicate`, "POST"), params(d1)));
    expect(copy.status).toBe(403);
    expect(((await copy.json()) as Err).error).toMatch(/read-scoped.*copy documents/);
    expect((await as(readToken, () => star.GET(jsonReq(`/api/documents/${d1}/star`, "GET"), params(d1)))).status).toBe(200);
    expect((await as(readToken, () => star.PUT(jsonReq(`/api/documents/${d1}/star`, "PUT"), params(d1)))).status).toBe(403);
    // Nothing changed.
    const after = await as(readToken, () => content.GET(jsonReq(`/api/documents/${d1}/content`, "GET"), params(d1)));
    expect(((await after.json()) as { content: string }).content).toContain("Alpha");
  });
});

describe("a comment token", () => {
  it("comments and suggests, but cannot rewrite", async () => {
    const comment = await as(commentToken, () => comments.POST(jsonReq(`/api/documents/${d1}/comments`, "POST", { action: "add", quote: "Alpha", body: "Consider beta first" }), params(d1)));
    expect(comment.status, await comment.clone().text()).toBe(200);

    const proposed = await as(commentToken, () => suggest.POST(jsonReq(`/api/documents/${d1}/suggest`, "POST", { edits: [{ find: "gamma", replace: "delta" }] }), params(d1)));
    expect(proposed.status, await proposed.clone().text()).toBe(200);
    expect(((await proposed.json()) as { suggestions: number }).suggestions).toBeGreaterThan(0);

    const rewrite = await as(commentToken, () => content.PUT(jsonReq(`/api/documents/${d1}/content`, "PUT", { content: "# One\n\nRewritten.\n" }), params(d1)));
    expect(rewrite.status).toBe(403);
    expect(((await rewrite.json()) as Err).error).toBe("This token is comment-scoped; create a full-access token at /settings to rewrite documents");

    // The card reports the effective role, not the owner's.
    const card = await as(commentToken, () => document.GET(jsonReq(`/api/documents/${d1}`, "GET"), params(d1)));
    expect(((await card.json()) as { role: string }).role).toBe("commenter");
  });
});

describe("a full token and the browser session", () => {
  it("keep today's access: rewrite works, the role is the user's", async () => {
    const rewrite = await as(fullToken, () => content.PUT(jsonReq(`/api/documents/${d2}/content`, "PUT", { content: "# Two\n\nDelta epsilon.\n" }), params(d2)));
    expect(rewrite.status, await rewrite.clone().text()).toBe(200);
    const card = await as(fullToken, () => document.GET(jsonReq(`/api/documents/${d2}`, "GET"), params(d2)));
    expect(((await card.json()) as { role: string }).role).toBe("owner");
    const session = await as(null, () => document.GET(jsonReq(`/api/documents/${d2}`, "GET"), params(d2)));
    expect(((await session.json()) as { role: string }).role).toBe("owner");
  });
});

describe("a token restricted to one document", () => {
  it("sees D1 and gets 404 on D2, in direct reads and in lists", async () => {
    const one = await as(d1Token, () => content.GET(jsonReq(`/api/documents/${d1}/content`, "GET"), params(d1)));
    expect(one.status).toBe(200);
    const two = await as(d1Token, () => content.GET(jsonReq(`/api/documents/${d2}/content`, "GET"), params(d2)));
    expect(two.status).toBe(404);
    expect(await two.json()).toEqual({ error: "Document not found" });
    const twoPut = await as(d1Token, () => content.PUT(jsonReq(`/api/documents/${d2}/content`, "PUT", { content: "x" }), params(d2)));
    expect(twoPut.status).toBe(404);

    const list = await as(d1Token, () => documents.GET(jsonReq(`/api/documents`, "GET")));
    const ids = ((await list.json()) as { documents: { id: string }[] }).documents.map((d) => d.id);
    expect(ids).toEqual([d1]);
    const search = await as(d1Token, () => documents.GET(jsonReq(`/api/documents?q=Two`, "GET")));
    expect(((await search.json()) as { documents: unknown[] }).documents).toEqual([]);

    // It cannot mint new documents either: they would be outside its list.
    const create = await as(d1Token, () => documents.POST(jsonReq(`/api/documents`, "POST", { title: "Three" })));
    expect(create.status).toBe(403);
    expect(((await create.json()) as Err).error).toMatch(/restricted to specific documents/);
    const copy = await as(d1Token, () => duplicate.POST(jsonReq(`/api/documents/${d1}/duplicate`, "POST"), params(d1)));
    expect(copy.status).toBe(403);
    expect((await as(commentToken, () => star.PUT(jsonReq(`/api/documents/${d1}/star`, "PUT"), params(d1)))).status).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("reports the token's scope and document restriction; null for a session", async () => {
    const who = (await (await as(d1Token, () => me.GET())).json()) as { agent: string; scope: string; documentIds: string[] | null };
    expect(who).toMatchObject({ agent: "One only", scope: "full", documentIds: [d1] });
    const reader = (await (await as(readToken, () => me.GET())).json()) as { scope: string; documentIds: string[] | null };
    expect(reader).toMatchObject({ scope: "read", documentIds: null });
    const session = (await (await as(null, () => me.GET())).json()) as { agent: null; scope: null; documentIds: null };
    expect(session).toMatchObject({ agent: null, scope: null, documentIds: null });
  });
});

describe("POST /api/tokens", () => {
  it.each([
    ["omitted", { name: "Plain omitted" }],
    ["null", { name: "Plain null", documentIds: null }],
  ])("treats %s documentIds as unrestricted", async (_case, requestBody) => {
    const response = await as(null, () => tokens.POST(jsonReq(`/api/tokens`, "POST", requestBody)));
    expect(response.status).toBe(201);
    expect((await response.json()) as { token: { scope: string; documentIds: null } }).toMatchObject({
      token: { scope: "full", documentIds: null },
    });
  });

  it("rejects explicitly empty documentIds with a clear 400", async () => {
    const response = await as(null, () => tokens.POST(jsonReq(`/api/tokens`, "POST", { name: "Empty restriction", documentIds: [] })));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; issues: { path: (string | number)[]; message: string }[] };
    expect(body.error).toBe("Invalid request");
    expect(body.issues).toContainEqual(
      expect.objectContaining({
        path: ["documentIds"],
        message: "Select at least one document when restricting a token",
      }),
    );
  });

  it("stores non-empty documentIds exactly, lists them back, and refuses documents the user cannot see", async () => {
    const created = await as(null, () => tokens.POST(jsonReq(`/api/tokens`, "POST", { name: "Scoped", scope: "comment", documentIds: [d1, d1] })));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: { id: string; scope: string; documentIds: string[] } };
    expect(body.token).toMatchObject({ scope: "comment", documentIds: [d1] });

    const bad = await as(null, () => tokens.POST(jsonReq(`/api/tokens`, "POST", { name: "Bad", scope: "admin" })));
    expect(bad.status).toBe(400);
    const unseen = await as(null, () => tokens.POST(jsonReq(`/api/tokens`, "POST", { name: "Unseen", documentIds: ["does-not-exist"] })));
    expect(unseen.status).toBe(404);

    const list = (await (await as(null, () => tokens.GET())).json()) as { tokens: { id: string; scope: string; documentIds: string[] | null }[] };
    expect(list.tokens.find((t) => t.id === body.token.id)).toMatchObject({ scope: "comment", documentIds: [d1] });
  });
});

describe("requireAccess / requireScope helpers", () => {
  it("cap the role to the scope and throw the scope error with a pointer to /settings", async () => {
    const capped = await as(readToken, () => requireAccess(d1, "view"));
    expect(capped.role).toBe("viewer");
    const full = await as(fullToken, () => requireAccess(d1, "own"));
    expect(full.role).toBe("owner");
    await expect(as(commentToken, () => requireAccess(d1, "own"))).rejects.toMatchObject({ status: 403 });
    await expect(as(d1Token, () => requireAccess(d2, "view"))).rejects.toMatchObject({ status: 404 });

    expect(() => requireScope({ id: "u", login: "u", scope: "read" }, "comment")).toThrow(HttpError);
    expect(() => requireScope({ id: "u", login: "u" }, "full")).not.toThrow();
    expect(scopeError("comment", "full").message).toBe("This token is comment-scoped; create a full-access token at /settings to rewrite documents");
    expect(scopeError("read", "full", "create documents").message).toBe("This token is read-scoped; create a full-access token at /settings to create documents");
  });
});
