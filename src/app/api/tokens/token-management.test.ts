import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { inspect } from "node:util";
import type { CreatedToken } from "@/server/tokens";
import { coordinationPostgresFixtureUrl } from "@/server/db/postgres-test-fixture";

const postgresFixture = coordinationPostgresFixtureUrl();
process.env.PGLITE_DATA_DIR = "memory://";
process.env.RATE_LIMIT = "off";
if (postgresFixture) process.env.DATABASE_URL = postgresFixture;
else delete process.env.DATABASE_URL;

type Actor = { id: string; login: string; name: string; image: null };
let actor: Actor | null = null;
let requestHeaders = new Headers();
vi.mock("@/auth", () => ({ auth: async () => actor ? { user: actor } : null }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/server/session-cookie", () => ({ decodeEmbedSession: async () => null }));
vi.mock("@/server/collab/authorization", () => ({ disconnectCollabToken: vi.fn() }));

const { closeDb, getDb, schema } = await import("@/server/db");
const {
  createApiToken, hashToken, listApiTokens, resolveApiToken, resolveApiTokenById, revokeApiToken, setCollaboratorsMayAsk,
} = await import("@/server/tokens");
const collection = await import("@/app/api/tokens/route");
const item = await import("@/app/api/tokens/[id]/route");
const replacement = await import("@/app/api/tokens/[id]/replace/route");
const { disconnectCollabToken } = await import("@/server/collab/authorization");

type TokenDto = Omit<CreatedToken, "token" | "createdAt" | "expiresAt" | "revokedAt"> & {
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastMcpSeenAt: string | null;
  lastMcpCallAt: string | null;
};
type CreatedDto = Omit<TokenDto, "lastUsedAt" | "lastMcpSeenAt" | "lastMcpCallAt"> & { token: string };

let owner: Actor;
let other: Actor;
let original: CreatedToken;
let sequence = 0;
let errorLog: MockInstance<typeof console.error>;
let expectedErrorLogs = 0;

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3700${path}`, {
  method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
const tokenPath = () => `/api/tokens/${original.id}`;

function expectResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

function expectMetadata(token: TokenDto, credentials: { token: string }[] = [original]) {
  expect(Object.keys(token).sort()).toEqual([
    "collaboratorsMayAsk", "createdAt", "documentIds", "expiresAt", "id",
    "lastMcpCallAt", "lastMcpSeenAt", "lastUsedAt", "name", "prefix", "revokedAt", "scope",
  ].sort());
  const serialized = JSON.stringify(token);
  expect(credentials.some((created) => serialized.includes(created.token) || serialized.includes(hashToken(created.token)))).toBe(false);
  expect(typeof token.createdAt).toBe("string");
  expect(Number.isFinite(Date.parse(token.createdAt))).toBe(true);
}

beforeEach(async () => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expectedErrorLogs = 0;
  vi.mocked(disconnectCollabToken).mockReset();
  requestHeaders = new Headers();
  const db = await getDb();
  const suffix = ++sequence;
  const users = await db.insert(schema.users).values([
    { login: `api-token-owner-${suffix}`, name: "Owner", email: `api-token-owner-${suffix}@example.com` },
    { login: `api-token-other-${suffix}`, name: "Other", email: `api-token-other-${suffix}@example.com` },
  ]).returning();
  owner = { id: users[0].id, login: users[0].login!, name: users[0].name!, image: null };
  other = { id: users[1].id, login: users[1].login!, name: users[1].name!, image: null };
  actor = owner;
  original = await createApiToken(owner.id, "Original Agent", { scope: "comment", documentIds: ["doc-one"], expiresInDays: 7 });
});

afterEach(async () => {
  try {
    expect(errorLog.mock.calls.length).toBe(expectedErrorLogs);
  } finally {
    vi.restoreAllMocks();
    if (postgresFixture && owner && other) {
      const db = await getDb();
      await db.delete(schema.users).where(inArray(schema.users.id, [owner.id, other.id]));
    }
  }
});
afterAll(async () => { if (postgresFixture) await closeDb(); });

describe("token collection and metadata", () => {
  it("keeps default GET behavior and exposes only the owner's history on explicit opt-in", async () => {
    const expired = await createApiToken(owner.id, "Expired");
    const revoked = await createApiToken(owner.id, "Revoked");
    const foreign = await createApiToken(other.id, "Foreign");
    const foreignRevoked = await createApiToken(other.id, "Foreign revoked");
    await revokeApiToken(owner.id, revoked.id);
    await revokeApiToken(other.id, foreignRevoked.id);
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, expired.id));

    const defaultResponse = await collection.GET(request("/api/tokens"));
    expectResponse(defaultResponse, 200);
    const current = (await defaultResponse.json() as { tokens: TokenDto[] }).tokens;
    expect(current.map((token) => token.id).sort()).toEqual([original.id, expired.id].sort());
    expect(current.every((token) => token.revokedAt === null)).toBe(true);
    const response = await collection.GET(request(`/api/tokens?includeRevoked=true&userId=${other.id}`));
    expectResponse(response, 200);
    const history = (await response.json() as { tokens: TokenDto[] }).tokens;
    expect(history.map((token) => token.id).sort()).toEqual([original.id, expired.id, revoked.id].sort());
    expect(typeof history.find((token) => token.id === revoked.id)?.revokedAt).toBe("string");
    expect(Number.isFinite(Date.parse(history.find((token) => token.id === revoked.id)!.revokedAt!))).toBe(true);
    for (const token of [...current, ...history]) expectMetadata(token, [original, expired, revoked, foreign, foreignRevoked]);
    for (const value of ["false", "1"]) {
      const response = await collection.GET(request(`/api/tokens?includeRevoked=${value}`));
      expectResponse(response, 200);
      const body = await response.json() as { tokens: TokenDto[] };
      expect(body.tokens.some((token) => token.id === revoked.id)).toBe(false);
    }
  });

  it("marks creation responses no-store and returns the new raw token only at creation", async () => {
    const response = await collection.POST(request("/api/tokens", "POST", { name: "  Browser Created  ", scope: "read" }));
    expectResponse(response, 201);
    const created = (await response.json() as { token: CreatedDto }).token;
    expect(created.name).toBe("Browser Created");
    expect(created.scope).toBe("read");
    expect(created.revokedAt).toBeNull();
    expect(typeof created.createdAt).toBe("string");
    expect(created.expiresAt).toBeNull();
    expect("tokenHash" in created).toBe(false);
    expect((await resolveApiToken(created.token))?.tokenId === created.id).toBe(true);
    const listed = (await (await collection.GET(request("/api/tokens"))).json() as { tokens: TokenDto[] }).tokens;
    for (const token of listed) expectMetadata(token, [original, created]);
  });
});

describe("PATCH token metadata", () => {
  it("trims a combined name/switch update while retaining the raw credential, scope, documents, and expiry", async () => {
    const response = await item.PATCH(request(tokenPath(), "PATCH", { name: "  Renamed Agent  ", collaboratorsMayAsk: true }), params(original.id));
    expectResponse(response, 200);
    const token = (await response.json() as { token: TokenDto }).token;
    expectMetadata(token);
    expect(token.id).toBe(original.id);
    expect(token.name).toBe("Renamed Agent");
    expect(token.collaboratorsMayAsk).toBe(true);
    expect(token.scope).toBe(original.scope);
    expect(token.documentIds).toEqual(original.documentIds);
    expect(token.expiresAt).toBe(original.expiresAt!.toISOString());
    expect(token.createdAt).toBe(original.createdAt.toISOString());
    expect(token.revokedAt).toBeNull();
    expect(token.prefix === original.prefix).toBe(true);
    expect((await resolveApiToken(original.token))?.agent === token.name).toBe(true);
    const db = await getDb();
    const [row] = await db.select({ tokenHash: schema.apiTokens.tokenHash }).from(schema.apiTokens).where(eq(schema.apiTokens.id, original.id));
    expect(row.tokenHash === hashToken(original.token)).toBe(true);
  });

  it("accepts either field alone and does not truncate a valid 80-character display name", async () => {
    const response = await item.PATCH(request(tokenPath(), "PATCH", { name: "n".repeat(80) }), params(original.id));
    expectResponse(response, 200);
    expect((await response.json() as { token: TokenDto }).token.name).toBe("n".repeat(80));
    const enabled = await item.PATCH(request(tokenPath(), "PATCH", { collaboratorsMayAsk: true }), params(original.id));
    expectResponse(enabled, 200);
    const token = (await enabled.json() as { token: TokenDto }).token;
    expectMetadata(token);
    expect(token.collaboratorsMayAsk).toBe(true);
    expect(token.name.length).toBe(80);
  });

  it.each([
    ["empty object", {}],
    ["blank name", { name: " \t " }],
    ["too long", { name: "n".repeat(81) }],
    ["null name", { name: null }],
    ["numeric name", { name: 42 }],
    ["NUL", { name: "bad\0name" }],
    ["non-boolean switch", { collaboratorsMayAsk: "yes" }],
    ["scope change", { name: "Valid", scope: "full" }],
    ["document change", { name: "Valid", documentIds: null }],
    ["owner change", { name: "Valid", userId: "another-owner" }],
    ["credential change", { name: "Valid", token: "not-a-credential" }],
    ["hash change", { name: "Valid", tokenHash: "not-a-hash" }],
    ["prefix change", { name: "Valid", prefix: "not-a-prefix" }],
    ["expiry change", { name: "Valid", expiresAt: null }],
    ["revocation change", { name: "Valid", revokedAt: null }],
    ["array", []],
    ["null", null],
  ])("rejects %s with no mutation", async (_label, body) => {
    const response = await item.PATCH(request(tokenPath(), "PATCH", body), params(original.id));
    expectResponse(response, 400);
    expect((await resolveApiToken(original.token))?.agent === original.name).toBe(true);
    const [unchanged] = await listApiTokens(owner.id);
    expect(unchanged.name).toBe(original.name);
    expect(unchanged.collaboratorsMayAsk).toBe(false);
  });

  it("returns a useful plain 409 for normalized mention conflicts without partially toggling the switch", async () => {
    await createApiToken(owner.id, "Distinct Agent");
    const response = await item.PATCH(request(tokenPath(), "PATCH", { name: "distinct-agent", collaboratorsMayAsk: true }), params(original.id));
    expectResponse(response, 409);
    expect((await response.json() as { error: string }).error === "Another active token has the same @mention name; choose a distinct token name").toBe(true);
    const unchanged = (await listApiTokens(owner.id)).find((token) => token.id === original.id)!;
    expect(unchanged.name).toBe(original.name);
    expect(unchanged.collaboratorsMayAsk).toBe(false);
  });
});

describe("browser-only token management authorization", () => {
  it.each(["signed-out", "bearer"] as const)("rejects %s listing, creation, rename, replacement, and revocation", async (mode) => {
    actor = mode === "bearer" ? owner : null;
    requestHeaders = mode === "bearer" ? new Headers({ authorization: `Bearer ${original.token}` }) : new Headers();
    const operations = [
      () => collection.GET(request("/api/tokens")),
      () => collection.GET(request("/api/tokens?includeRevoked=true")),
      () => collection.POST(request("/api/tokens", "POST", { name: "Unauthorized" })),
      () => item.PATCH(request(tokenPath(), "PATCH", { name: "Unauthorized" }), params(original.id)),
      () => replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id)),
      () => item.DELETE(request(tokenPath(), "DELETE"), params(original.id)),
    ];
    for (const operation of operations) expectResponse(await operation(), mode === "bearer" ? 403 : 401);
    expect((await listApiTokens(owner.id)).map((token) => token.id)).toEqual([original.id]);
    expect((await resolveApiToken(original.token))?.agent === original.name).toBe(true);
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
  });

  it("hides other owners' and missing token IDs from rename, replacement, and revocation", async () => {
    actor = other;
    for (const id of [original.id, "missing"]) {
      expectResponse(await item.PATCH(request(`/api/tokens/${id}`, "PATCH", { name: "Unauthorized" }), params(id)), 404);
      expectResponse(await replacement.POST(request(`/api/tokens/${id}/replace`, "POST", { confirm: true }), params(id)), 404);
      expectResponse(await item.DELETE(request(`/api/tokens/${id}`, "DELETE"), params(id)), 404);
    }
    const response = await collection.GET(request("/api/tokens?includeRevoked=true"));
    expectResponse(response, 200);
    expect((await response.json() as { tokens: TokenDto[] }).tokens.length).toBe(0);
    expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
  });
});

describe("POST token replacement and DELETE", () => {
  it("returns a new credential once, preserves restrictions and expiry, and retires both uses of the old identity", async () => {
    await setCollaboratorsMayAsk(owner.id, original.id, true);
    const response = await replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id));
    expectResponse(response, 201);
    const created = (await response.json() as { token: CreatedDto }).token;
    expect(created.id === original.id).toBe(false);
    expect(created.token === original.token).toBe(false);
    expect("tokenHash" in created).toBe(false);
    expect(created.name).toBe(original.name);
    expect(created.scope).toBe(original.scope);
    expect(created.documentIds).toEqual(original.documentIds);
    expect(created.collaboratorsMayAsk).toBe(true);
    expect(created.createdAt === new Date(created.createdAt).toISOString()).toBe(true);
    expect(created.expiresAt).toBe(original.expiresAt!.toISOString());
    expect(created.revokedAt).toBeNull();
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect(await resolveApiTokenById(original.id) === null).toBe(true);
    expect((await resolveApiToken(created.token))?.tokenId === created.id).toBe(true);
    const current = (await (await collection.GET(request("/api/tokens"))).json() as { tokens: TokenDto[] }).tokens;
    expect(current.map((token) => token.id)).toEqual([created.id]);
    const history = (await (await collection.GET(request("/api/tokens?includeRevoked=true"))).json() as { tokens: TokenDto[] }).tokens;
    expect(history.length).toBe(2);
    expect(typeof history.find((token) => token.id === original.id)?.revokedAt).toBe("string");
    for (const token of [...current, ...history]) expectMetadata(token, [original, created]);
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it.each([
    ["missing body", undefined],
    ["missing confirmation", {}],
    ["false", { confirm: false }],
    ["string", { confirm: "true" }],
    ["null", null],
    ["array", [{ confirm: true }]],
    ["extra name", { confirm: true, name: "New name" }],
    ["extra expiry", { confirm: true, expiresInDays: 30 }],
    ["extra permissions", { confirm: true, scope: "full" }],
    ["extra documents", { confirm: true, documentIds: null }],
    ["extra switch", { confirm: true, collaboratorsMayAsk: true }],
  ])("requires exactly {confirm:true}: %s", async (_label, body) => {
    const response = await replacement.POST(request(`${tokenPath()}/replace`, "POST", body), params(original.id));
    expectResponse(response, 400);
    expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
    expect((await listApiTokens(owner.id, true)).length).toBe(1);
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
  });

  it("returns create-new-token guidance for expired tokens, and 404 for revoked tokens", async () => {
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, original.id));
    const expired = await replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id));
    expectResponse(expired, 409);
    expect((await expired.json() as { error: string }).error === "Expired tokens cannot be replaced; create a new token instead").toBe(true);
    expect((await listApiTokens(owner.id))[0].revokedAt).toBeNull();
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
    expectResponse(await item.DELETE(request(tokenPath(), "DELETE"), params(original.id)), 200);
    expectResponse(await replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id)), 404);
    expectResponse(await item.PATCH(request(tokenPath(), "PATCH", { name: "Revived" }), params(original.id)), 404);
    expectResponse(await item.DELETE(request(tokenPath(), "DELETE"), params(original.id)), 404);
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it("rolls back a failed insert, reports the failure, and never logs credential-bearing driver errors", async () => {
    const db = await getDb();
    await db.execute(sql`create function token_route_fail_insert() returns trigger language plpgsql as $$
      begin raise exception 'Injected token insert failure'; end;
    $$`);
    try {
      await db.execute(sql`create trigger token_route_fail_insert before insert on api_token
        for each row execute function token_route_fail_insert()`);
      expectedErrorLogs = 2;
      const failed = await replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id));
      expectResponse(failed, 500);
      expect((await failed.json() as { error: string }).error === "Unexpected error").toBe(true);
      const createFailed = await collection.POST(request("/api/tokens", "POST", { name: "Failed Creation" }));
      expectResponse(createFailed, 500);
      expect((await createFailed.json() as { error: string }).error === "Unexpected error").toBe(true);
      expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
      expect((await resolveApiTokenById(original.id))?.tokenId).toBe(original.id);
      expect((await listApiTokens(owner.id, true)).length).toBe(1);
      expect((await listApiTokens(owner.id))[0].revokedAt).toBeNull();
      expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
      const logged = errorLog.mock.calls.flat().map((value) => inspect(value)).join("\n");
      expect(logged.includes("SQLSTATE P0001")).toBe(true);
      expect(logged.includes("mdk_") || /\b[a-f0-9]{64}\b/.test(logged)).toBe(false);
    } finally {
      await db.execute(sql`drop trigger if exists token_route_fail_insert on api_token`);
      await db.execute(sql`drop function token_route_fail_insert()`);
    }
  });

  it("returns one success and one 404 for concurrent replacements, with one active successor", async () => {
    const responses = await Promise.all([
      replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id)),
      replacement.POST(request(`${tokenPath()}/replace`, "POST", { confirm: true }), params(original.id)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 404]);
    for (const response of responses) expect(response.headers.get("Cache-Control")).toBe("no-store");
    const created = (await responses.find((response) => response.status === 201)!.json() as { token: CreatedDto }).token;
    expect((await listApiTokens(owner.id)).map((token) => token.id)).toEqual([created.id]);
    expect((await listApiTokens(owner.id, true)).length).toBe(2);
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect((await resolveApiToken(created.token))?.tokenId === created.id).toBe(true);
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it("lets only the owner revoke a live token and keeps a safe historical metadata row", async () => {
    actor = other;
    expectResponse(await item.DELETE(request(tokenPath(), "DELETE"), params(original.id)), 404);
    expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
    actor = owner;
    const response = await item.DELETE(request(tokenPath(), "DELETE"), params(original.id));
    expectResponse(response, 200);
    const body = await response.json() as { ok: boolean };
    expect(Object.keys(body)).toEqual(["ok"]);
    expect(body.ok === true).toBe(true);
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect(await resolveApiTokenById(original.id) === null).toBe(true);
    expect((await listApiTokens(owner.id)).length).toBe(0);
    const history = (await (await collection.GET(request("/api/tokens?includeRevoked=true"))).json() as { tokens: TokenDto[] }).tokens;
    expect(history.map((token) => token.id)).toEqual([original.id]);
    expectMetadata(history[0]);
    expect(typeof history[0].revokedAt).toBe("string");
  });
});
