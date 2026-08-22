import { describe, expect, it, beforeAll } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("./db");
const { createApiToken, listApiTokens, revokeApiToken, resolveApiToken, looksLikeApiToken, hashToken } = await import("./tokens");

describe("api tokens", () => {
  let userId: string;
  beforeAll(async () => {
    const db = await getDb();
    const [user] = await db.insert(schema.users).values({ name: "Tok", login: "tok", email: "tok@example.com" }).returning();
    userId = user.id;
  });

  it("creates tokens that resolve to their user and agent name", async () => {
    const created = await createApiToken(userId, "GitHub Copilot CLI", 30);
    expect(created.token.startsWith("mdk_")).toBe(true);
    expect(looksLikeApiToken(created.token)).toBe(true);
    expect(created.prefix).toBe(created.token.slice(0, 10));
    const actor = await resolveApiToken(created.token);
    expect(actor).toMatchObject({ id: userId, login: "tok", agent: "GitHub Copilot CLI", tokenId: created.id });
    const list = await listApiTokens(userId);
    expect(list.map((t) => t.name)).toContain("GitHub Copilot CLI");
    // Only the hash is stored.
    const db = await getDb();
    const rows = await db.select().from(schema.apiTokens);
    expect(rows.every((r) => r.tokenHash !== created.token)).toBe(true);
    expect(rows.some((r) => r.tokenHash === hashToken(created.token))).toBe(true);
  });

  it("rejects unknown, revoked and expired tokens", async () => {
    expect(await resolveApiToken("mdk_" + "x".repeat(40))).toBeNull();
    expect(await resolveApiToken("not-a-token")).toBeNull();
    const t = await createApiToken(userId, "temp");
    expect(await resolveApiToken(t.token)).not.toBeNull();
    expect(await revokeApiToken(userId, t.id)).toBe(true);
    expect(await resolveApiToken(t.token)).toBeNull();
    expect(await revokeApiToken(userId, t.id)).toBe(false);
    const expired = await createApiToken(userId, "old", 1);
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, expired.id));
    expect(await resolveApiToken(expired.token)).toBeNull();
  });
});
