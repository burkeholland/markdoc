import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decode } from "next-auth/jwt";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "embed-test-secret-embed-test-secret";
delete process.env.DATABASE_URL;
delete process.env.RATE_LIMIT;

let requestHeaders = new Headers();
let authSession: {
  user: {
    id: string;
    login: string;
    name: string;
    image: string | null;
    embedTokenId?: string;
    embedDocumentId?: string;
  };
} | null = null;
vi.mock("@/auth", () => ({ auth: async () => authSession }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const { getDb, schema } = await import("@/server/db");
const { createDocument } = await import("@/server/documents");
const { createApiToken } = await import("@/server/tokens");
const { revokeApiToken } = await import("@/server/tokens");
const { apiLimiter } = await import("@/server/rate-limit");
const handoffs = await import("@/server/embed-handoff");
const {
  EMBED_SESSION_COOKIE,
  EMBED_SESSION_MAX_AGE_S,
  SESSION_COOKIE,
  mintSessionCookie,
} = await import("@/server/session-cookie");
const { embeddedDocumentPath } = await import("@/server/http");
const { POST } = await import("./route");
const { POST: RENEW } = await import("@/app/api/embed/session/route");
const { GET } = await import("@/app/embed/[nonce]/route");
const { GET: GET_ME } = await import("@/app/api/me/route");
const { GET: GET_TOKENS } = await import("@/app/api/tokens/route");

const BASE = "http://localhost:3700";
const PARENT = "http://127.0.0.1:4749";
const context = (nonce: string) => ({ params: Promise.resolve({ nonce }) });
const frameRequest = (nonce: string, parent = PARENT) => new Request(`${BASE}/embed/${nonce}`, {
  headers: { "sec-fetch-dest": "iframe", referer: `${parent}/` },
});

async function create(token: string | null, documentId: string) {
  requestHeaders = token ? new Headers({ authorization: `Bearer ${token}` }) : new Headers();
  return POST(new Request(`${BASE}/api/embed/handoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ documentId, parentOrigin: PARENT }),
  }));
}

function nonceFrom(responseBody: { url: string }) {
  return new URL(responseBody.url).pathname.split("/").at(-1)!;
}

function cookieValue(response: Response, name: string) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  expect(cookie).toBeDefined();
  return decodeURIComponent(cookie!.slice(name.length + 1, cookie!.indexOf(";")));
}

let owner: { id: string; login: string };
let other: { id: string; login: string };
let documentId: string;
let token: string;
let tokenId: string;
let otherToken: string;

beforeAll(async () => {
  const db = await getDb();
  const [ownerRow] = await db.insert(schema.users).values({ name: "Embed owner", login: "embed-owner", email: "embed-owner@example.com" }).returning();
  const [otherRow] = await db.insert(schema.users).values({ name: "Other owner", login: "embed-other", email: "embed-other@example.com" }).returning();
  owner = { id: ownerRow.id, login: ownerRow.login! };
  other = { id: otherRow.id, login: otherRow.login! };
  documentId = (await createDocument({ ownerId: owner.id, title: "Canvas document", content: "# Canvas\n" })).id;
  const created = await createApiToken(owner.id, "Copilot app", { scope: "comment", documentIds: [documentId] });
  token = created.token;
  tokenId = created.id;
  otherToken = (await createApiToken(other.id, "Other Copilot app")).token;
});

beforeEach(() => {
  requestHeaders = new Headers();
  authSession = null;
  handoffs.resetHandoffs();
  apiLimiter.reset();
});

describe("canvas embed handoff", () => {
  it("requires a token and document access, and uses the normal write rate limit", async () => {
    expect((await create(null, documentId)).status).toBe(401);
    expect((await create(otherToken, documentId)).status).toBe(404);

    const response = await create(token, documentId);
    expect(response.status).toBe(201);
    expect(response.headers.get("X-RateLimit-Limit")).not.toBeNull();
    const body = (await response.json()) as {
      url: string;
      documentId: string;
      ttlMs: number;
      sessionTtlMs: number;
    };
    expect(body.documentId).toBe(documentId);
    expect(body.ttlMs).toBe(60_000);
    expect(body.sessionTtlMs).toBe(EMBED_SESSION_MAX_AGE_S * 1000);
    expect(new URL(body.url).origin).toBe(BASE);
  });

  it("sets an isolated embed cookie, redirects to embed mode, and spends the nonce once", async () => {
    const handoff = await create(token, documentId);
    const nonce = nonceFrom((await handoff.json()) as { url: string });

    const opened = await GET(frameRequest(nonce), context(nonce));
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(`${BASE}/d/${documentId}?embed=1`);
    expect(opened.headers.get("Cache-Control")).toBe("no-store");
    expect(opened.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    const encoded = cookieValue(opened, EMBED_SESSION_COOKIE);
    const payload = await decode({ token: encoded, secret: process.env.AUTH_SECRET!, salt: EMBED_SESSION_COOKIE });
    expect(payload).toMatchObject({
      sub: owner.id,
      login: owner.login,
      embedTokenId: tokenId,
      embedDocumentId: documentId,
      embedParentOrigin: PARENT,
    });

    requestHeaders = new Headers({ cookie: `${EMBED_SESSION_COOKIE}=${encodeURIComponent(encoded)}` });
    const identity = await GET_ME();
    expect(await identity.json()).toMatchObject({ agent: "Copilot app", scope: "comment", documentIds: [documentId] });
    expect((await GET_TOKENS(new Request(`${BASE}/api/tokens`))).status).toBe(403);
    expect(await embeddedDocumentPath(null)).toBe(`/d/${documentId}?embed=1`);

    const replay = await GET(frameRequest(nonce), context(nonce));
    expect(replay.status).toBe(410);
    expect(await replay.json()).toMatchObject({ reason: "used" });
  });

  it("refuses a nonce after 60 seconds", async () => {
    const { nonce } = handoffs.createHandoff(owner.id, documentId, tokenId, PARENT, Date.now() - handoffs.HANDOFF_TTL_MS - 1);
    const response = await GET(frameRequest(nonce), context(nonce));
    expect(response.status).toBe(410);
  });

  it("refuses a handoff when its API token has been revoked", async () => {
    const revocable = await createApiToken(owner.id, "Revoked Copilot app", { scope: "read", documentIds: [documentId] });
    const { nonce } = handoffs.createHandoff(owner.id, documentId, revocable.id, PARENT);
    expect(await revokeApiToken(owner.id, revocable.id)).toBe(true);
    const response = await GET(frameRequest(nonce), context(nonce));
    expect(response.status).toBe(410);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("requires the bound canvas frame without consuming the handoff", async () => {
    const handoff = await create(token, documentId);
    const nonce = nonceFrom((await handoff.json()) as { url: string });
    expect((await GET(new Request(`${BASE}/embed/${nonce}`), context(nonce))).status).toBe(403);
    expect((await GET(frameRequest(nonce, "http://attacker.example"), context(nonce))).status).toBe(410);
    expect((await GET(frameRequest(nonce), context(nonce))).status).toBe(302);
  });

  it("does not let an embed cookie replace a different primary session", async () => {
    const handoff = await create(token, documentId);
    const nonce = nonceFrom((await handoff.json()) as { url: string });
    const opened = await GET(frameRequest(nonce), context(nonce));
    const encoded = cookieValue(opened, EMBED_SESSION_COOKIE);
    requestHeaders = new Headers({ cookie: `${EMBED_SESSION_COOKIE}=${encodeURIComponent(encoded)}` });
    authSession = { user: { id: other.id, login: other.login, name: "Other owner", image: null } };
    expect(await (await GET_ME()).json()).toMatchObject({ user: { id: other.id }, agent: null });
    expect(await embeddedDocumentPath(other.id)).toBeNull();
  });

  it("renews a live embed session and refuses renewal after token revocation", async () => {
    const revocable = await createApiToken(owner.id, "Renewable Copilot app", {
      scope: "comment",
      documentIds: [documentId],
    });
    const { nonce } = handoffs.createHandoff(owner.id, documentId, revocable.id, PARENT);
    const opened = await GET(frameRequest(nonce), context(nonce));
    const encoded = cookieValue(opened, EMBED_SESSION_COOKIE);
    requestHeaders = new Headers({ cookie: `${EMBED_SESSION_COOKIE}=${encodeURIComponent(encoded)}` });
    const renewRequest = () => new Request(`${BASE}/api/embed/session`, {
      method: "POST",
      headers: { origin: BASE },
    });

    const renewed = await RENEW(renewRequest());
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ ttlMs: EMBED_SESSION_MAX_AGE_S * 1000 });
    expect(cookieValue(renewed, EMBED_SESSION_COOKIE)).not.toBe(encoded);

    expect(await revokeApiToken(owner.id, revocable.id)).toBe(true);
    const refused = await RENEW(renewRequest());
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ reason: "embed_access_revoked" });
  });

  it("refuses renewal once the dedicated embed session has expired", async () => {
    const cookie = await mintSessionCookie(
      {
        id: owner.id,
        login: owner.login,
        name: "Embed owner",
        image: null,
        embedTokenId: tokenId,
        embedDocumentId: documentId,
        embedParentOrigin: PARENT,
      },
      false,
      [process.env.AUTH_SECRET!],
      1,
    );
    requestHeaders = new Headers({ cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}` });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    try {
      const response = await RENEW(new Request(`${BASE}/api/embed/session`, {
        method: "POST",
        headers: { origin: BASE },
      }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "embed_session_expired" });
    } finally {
      vi.useRealTimers();
    }
  });
});
