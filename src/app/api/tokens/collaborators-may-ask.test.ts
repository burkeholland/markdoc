import { describe, expect, it, beforeAll, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

/**
 * The owner switch behind addressed agent requests (#1296): `PATCH /api/tokens/:id { collaboratorsMayAsk }`
 * flips whether other users may address `@owner/slug`. Sessions only — a token cannot widen who may task
 * it — and only the caller's own live tokens. `GET /api/tokens` and `/api/me` (for the token) report it.
 */
type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createApiToken, revokeApiToken } = await import("@/server/tokens");
const { PATCH } = await import("@/app/api/tokens/[id]/route");
const { GET: GET_TOKENS } = await import("@/app/api/tokens/route");
const { GET: GET_ME } = await import("@/app/api/me/route");

type TokenDto = { id: string; name: string; collaboratorsMayAsk: boolean };

let olive: Actor;
let cam: Actor;
let copilotId: string;
let copilotSecret: string;
let camTokenId: string;

const url = (path: string) => `http://localhost:3700${path}`;
const jsonReq = (path: string, method: string, body?: unknown) =>
  new Request(url(path), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Run `fn` as `who`'s browser session, or as the bearer `token` when given (no session). */
const as = async <T>(who: Actor | null, token: string | null, fn: () => Promise<T>) => {
  const savedActor = actor;
  const savedHeaders = requestHeaders;
  actor = who;
  requestHeaders = token ? new Headers({ authorization: ["Bearer", token].join(" ") }) : new Headers();
  try {
    return await fn();
  } finally {
    actor = savedActor;
    requestHeaders = savedHeaders;
  }
};

beforeAll(async () => {
  const db = await getDb();
  const [o] = await db.insert(schema.users).values({ name: "Olive", login: "olive", email: "olive@example.com" }).returning();
  const [c] = await db.insert(schema.users).values({ name: "Cam", login: "cam", email: "cam@example.com" }).returning();
  olive = { id: o.id, login: "olive", name: "Olive", image: null };
  cam = { id: c.id, login: "cam", name: "Cam", image: null };
  const copilot = await createApiToken(olive.id, "Copilot");
  copilotId = copilot.id;
  copilotSecret = copilot.token;
  camTokenId = (await createApiToken(cam.id, "Cam bot")).id;
});

describe("PATCH /api/tokens/:id { collaboratorsMayAsk }", () => {
  it("is off by default and the owner can switch it on and off again from a browser session", async () => {
    const before = (await (await as(olive, null, () => GET_TOKENS())).json()) as { tokens: TokenDto[] };
    expect(before.tokens.find((t) => t.id === copilotId)?.collaboratorsMayAsk).toBe(false);

    const on = await as(olive, null, () => PATCH(jsonReq(`/api/tokens/${copilotId}`, "PATCH", { collaboratorsMayAsk: true }), params(copilotId)));
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { token: TokenDto & { createdAt: string } };
    expect(onBody.token).toMatchObject({ id: copilotId, name: "Copilot", collaboratorsMayAsk: true });
    expect(typeof onBody.token.createdAt).toBe("string");
    expect("tokenHash" in onBody.token).toBe(false);

    const listed = (await (await as(olive, null, () => GET_TOKENS())).json()) as { tokens: TokenDto[] };
    expect(listed.tokens.find((t) => t.id === copilotId)?.collaboratorsMayAsk).toBe(true);

    // The token itself learns about it through /api/me.
    const me = (await (await as(null, copilotSecret, () => GET_ME())).json()) as { agent: string; collaboratorsMayAsk: boolean | null };
    expect(me).toMatchObject({ agent: "Copilot", collaboratorsMayAsk: true });

    const off = await as(olive, null, () => PATCH(jsonReq(`/api/tokens/${copilotId}`, "PATCH", { collaboratorsMayAsk: false }), params(copilotId)));
    expect(off.status).toBe(200);
    expect(((await off.json()) as { token: TokenDto }).token.collaboratorsMayAsk).toBe(false);
    const meOff = (await (await as(null, copilotSecret, () => GET_ME())).json()) as { collaboratorsMayAsk: boolean | null };
    expect(meOff.collaboratorsMayAsk).toBe(false);
  });

  it("refuses a bearer token (403), another user's token (404), a revoked token (404) and a non-boolean body (400)", async () => {
    const bearer = await as(null, copilotSecret, () => PATCH(jsonReq(`/api/tokens/${copilotId}`, "PATCH", { collaboratorsMayAsk: true }), params(copilotId)));
    expect(bearer.status).toBe(403);
    expect(((await bearer.json()) as { error: string }).error).toMatch(/browser session/);

    const other = await as(cam, null, () => PATCH(jsonReq(`/api/tokens/${copilotId}`, "PATCH", { collaboratorsMayAsk: true }), params(copilotId)));
    expect(other.status).toBe(404);
    const stillOff = (await (await as(olive, null, () => GET_TOKENS())).json()) as { tokens: TokenDto[] };
    expect(stillOff.tokens.find((t) => t.id === copilotId)?.collaboratorsMayAsk).toBe(false);

    const bad = await as(olive, null, () => PATCH(jsonReq(`/api/tokens/${copilotId}`, "PATCH", { collaboratorsMayAsk: "yes" }), params(copilotId)));
    expect(bad.status).toBe(400);

    expect(await revokeApiToken(cam.id, camTokenId)).toBe(true);
    const revoked = await as(cam, null, () => PATCH(jsonReq(`/api/tokens/${camTokenId}`, "PATCH", { collaboratorsMayAsk: true }), params(camTokenId)));
    expect(revoked.status).toBe(404);

    // A person (no token) has no switch of their own: /api/me reports null.
    const me = (await (await as(olive, null, () => GET_ME())).json()) as { agent: string | null; collaboratorsMayAsk: boolean | null };
    expect(me).toMatchObject({ agent: null, collaboratorsMayAsk: null });
  });
});
