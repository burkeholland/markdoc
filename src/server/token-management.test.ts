import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

vi.mock("@/server/collab/authorization", () => ({ disconnectCollabToken: vi.fn() }));

const { getDb, schema } = await import("@/server/db");
const {
  AgentMentionConflictError, ApiTokenExpiredError, createApiToken, hashToken, listApiTokens,
  replaceApiToken, resolveApiToken, resolveApiTokenById, revokeApiToken, setCollaboratorsMayAsk, updateApiToken,
} = await import("@/server/tokens");
const { disconnectCollabToken } = await import("@/server/collab/authorization");

let userId: string;
let otherId: string;
let sequence = 0;

beforeEach(async () => {
  vi.mocked(disconnectCollabToken).mockReset();
  const db = await getDb();
  const suffix = ++sequence;
  const users = await db.insert(schema.users).values([
    { name: "Token owner", login: `token-owner-${suffix}`, email: `token-owner-${suffix}@example.com` },
    { name: "Other owner", login: `other-owner-${suffix}`, email: `other-owner-${suffix}@example.com` },
  ]).returning();
  userId = users[0].id;
  otherId = users[1].id;
});

async function storedCredential(id: string) {
  const db = await getDb();
  const [row] = await db.select({
    tokenHash: schema.apiTokens.tokenHash,
    mentionSlug: schema.apiTokens.mentionSlug,
  }).from(schema.apiTokens).where(eq(schema.apiTokens.id, id));
  return row;
}

describe("token management metadata and rename", () => {
  it("lists only the owner's non-revoked tokens by default, including expired tokens, with opt-in history", async () => {
    const live = await createApiToken(userId, "Live");
    const expired = await createApiToken(userId, "Expired");
    const revoked = await createApiToken(userId, "Revoked");
    await createApiToken(otherId, "Other live");
    const otherRevoked = await createApiToken(otherId, "Other revoked");
    await revokeApiToken(otherId, otherRevoked.id);
    await revokeApiToken(userId, revoked.id);
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, expired.id));

    const current = await listApiTokens(userId);
    expect(current.map((item) => item.id).sort()).toEqual([live.id, expired.id].sort());
    expect(current.every((item) => item.revokedAt === null)).toBe(true);
    const history = await listApiTokens(userId, true);
    expect(history.map((item) => item.id).sort()).toEqual([live.id, expired.id, revoked.id].sort());
    expect(history.find((item) => item.id === revoked.id)?.revokedAt instanceof Date).toBe(true);
    for (const item of history) {
      expect(Object.keys(item).sort()).toEqual([
        "collaboratorsMayAsk", "createdAt", "documentIds", "expiresAt", "id",
        "lastMcpCallAt", "lastMcpSeenAt", "lastUsedAt", "name", "prefix", "revokedAt", "scope",
      ].sort());
      const serialized = JSON.stringify(item);
      expect([live, expired, revoked, otherRevoked].some((created) =>
        serialized.includes(created.token) || serialized.includes(hashToken(created.token)))).toBe(false);
    }
  });

  it("atomically renames and changes the owner switch without rotating or widening the credential", async () => {
    const created = await createApiToken(userId, "Original Agent", { scope: "comment", documentIds: ["doc-one"], expiresInDays: 7 });
    const before = await storedCredential(created.id);
    const renamed = await updateApiToken(userId, created.id, { name: "  Renamed Agent  ", collaboratorsMayAsk: true });
    expect(renamed?.name).toBe("Renamed Agent");
    expect(renamed?.id).toBe(created.id);
    expect(renamed?.collaboratorsMayAsk).toBe(true);
    expect(renamed?.scope).toBe("comment");
    expect(renamed?.documentIds).toEqual(["doc-one"]);
    expect(renamed?.expiresAt?.getTime()).toBe(created.expiresAt?.getTime());
    expect(renamed?.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(renamed?.revokedAt).toBeNull();
    expect(renamed?.prefix === created.prefix).toBe(true);
    expect(renamed !== null && !("token" in renamed) && !("tokenHash" in renamed)).toBe(true);
    const after = await storedCredential(created.id);
    expect(after.tokenHash === before.tokenHash && after.tokenHash === hashToken(created.token)).toBe(true);
    expect(after.mentionSlug).toBe("renamed-agent");
    expect((await resolveApiToken(created.token))?.agent === "Renamed Agent").toBe(true);
    expect((await resolveApiTokenById(created.id))?.agent).toBe("Renamed Agent");
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
    expect((await createApiToken(userId, "Original Agent")).name).toBe("Original Agent");
  });

  it("rejects normalized-name conflicts without changing the name, switch, or credential", async () => {
    const created = await createApiToken(userId, "Original");
    await createApiToken(userId, "Other Agent");
    await createApiToken(otherId, "Original");
    const rejected = await updateApiToken(userId, created.id, { name: "other-agent", collaboratorsMayAsk: true })
      .then(() => false, (error: unknown) => error instanceof AgentMentionConflictError);
    expect(rejected).toBe(true);
    const [unchanged] = (await listApiTokens(userId)).filter((item) => item.id === created.id);
    expect(unchanged.name).toBe("Original");
    expect(unchanged.collaboratorsMayAsk).toBe(false);
    expect((await storedCredential(created.id)).mentionSlug).toBe("original");
    expect((await resolveApiToken(created.token))?.tokenId === created.id).toBe(true);
  });

  it.each(["", "   ", "a".repeat(81), "bad\0name"])("rejects invalid rename case %# without truncation", async (name) => {
    const created = await createApiToken(userId, "Original");
    expect(await updateApiToken(userId, created.id, { name })
      .then(() => false, (error: unknown) => error instanceof RangeError)).toBe(true);
    expect((await resolveApiToken(created.token))?.agent === "Original").toBe(true);
  });

  it("releases expired mention names and never reserves a slug when renaming an expired token", async () => {
    const expired = await createApiToken(userId, "Reusable Agent");
    const active = await createApiToken(userId, "Current Agent");
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, expired.id));
    expect((await updateApiToken(userId, active.id, { name: "Reusable Agent" }))?.name).toBe("Reusable Agent");
    expect((await storedCredential(expired.id)).mentionSlug).toBeNull();
    expect((await updateApiToken(userId, expired.id, { name: "reusable-agent" }))?.name).toBe("reusable-agent");
    expect((await storedCredential(expired.id)).mentionSlug).toBeNull();
    expect((await storedCredential(active.id)).mentionSlug).toBe("reusable-agent");
    expect(await resolveApiToken(expired.token) === null).toBe(true);
    expect((await createApiToken(userId, "Current Agent")).name).toBe("Current Agent");
  });

  it("keeps existing owner-switch behavior and refuses changes or revocation by another owner", async () => {
    const created = await createApiToken(userId, "Switch");
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, created.id));
    const enabled = await setCollaboratorsMayAsk(userId, created.id, true);
    expect(enabled?.collaboratorsMayAsk).toBe(true);
    expect(enabled?.revokedAt).toBeNull();
    expect(enabled !== null && !("tokenHash" in enabled) && !("token" in enabled)).toBe(true);
    expect((await updateApiToken(userId, created.id, { collaboratorsMayAsk: false }))?.collaboratorsMayAsk).toBe(false);
    expect(await updateApiToken(otherId, created.id, { name: "Stolen" }) === null).toBe(true);
    expect(await setCollaboratorsMayAsk(otherId, created.id, true) === null).toBe(true);
    expect(await revokeApiToken(otherId, created.id)).toBe(false);
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
    expect(await revokeApiToken(userId, created.id)).toBe(true);
    expect(await revokeApiToken(userId, created.id)).toBe(false);
    expect(await updateApiToken(userId, created.id, { name: "Revived" }) === null).toBe(true);
    expect(await setCollaboratorsMayAsk(userId, created.id, true) === null).toBe(true);
    expect((await storedCredential(created.id)).mentionSlug).toBeNull();
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([created.id]);
  });
});

describe("atomic token replacement", () => {
  it.each(["read", "comment", "full"] as const)("preserves %s permissions, owner switch, and absolute expiry while invalidating the old identity", async (scope) => {
    const original = await createApiToken(userId, "Replacement Agent", { scope, documentIds: ["doc-one", "doc-two"], expiresInDays: 7 });
    await setCollaboratorsMayAsk(userId, original.id, true);
    const db = await getDb();
    const oldCreatedAt = new Date(Date.now() - 86_400_000);
    await db.update(schema.apiTokens).set({
      createdAt: oldCreatedAt, lastUsedAt: oldCreatedAt, lastMcpSeenAt: oldCreatedAt, lastMcpCallAt: oldCreatedAt,
    }).where(eq(schema.apiTokens.id, original.id));
    const replacement = await replaceApiToken(userId, original.id);
    expect(replacement !== null).toBe(true);
    expect(replacement!.id === original.id).toBe(false);
    expect(replacement!.token === original.token).toBe(false);
    expect(replacement!.name).toBe(original.name);
    expect(replacement!.scope).toBe(scope);
    expect(replacement!.documentIds).toEqual(["doc-one", "doc-two"]);
    expect(replacement!.collaboratorsMayAsk).toBe(true);
    expect(replacement!.expiresAt?.getTime()).toBe(original.expiresAt?.getTime());
    expect(replacement!.createdAt.getTime()).toBeGreaterThan(oldCreatedAt.getTime());
    expect(replacement!.revokedAt).toBeNull();
    const stored = await storedCredential(replacement!.id);
    expect(stored.tokenHash === hashToken(replacement!.token) && stored.tokenHash !== replacement!.token).toBe(true);
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect(await resolveApiTokenById(original.id) === null).toBe(true);
    const [active] = await listApiTokens(userId);
    expect(active.lastUsedAt).toBeNull();
    expect(active.lastMcpSeenAt).toBeNull();
    expect(active.lastMcpCallAt).toBeNull();
    const resolved = await resolveApiToken(replacement!.token);
    expect(resolved?.tokenId === replacement!.id).toBe(true);
    expect(resolved?.scope).toBe(scope);
    expect(resolved?.documentIds).toEqual(["doc-one", "doc-two"]);
    expect(resolved?.collaboratorsMayAsk).toBe(true);
    const history = await listApiTokens(userId, true);
    expect(history.length).toBe(2);
    expect(history.find((item) => item.id === original.id)?.revokedAt instanceof Date).toBe(true);
    expect((await storedCredential(original.id)).mentionSlug).toBeNull();
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it("preserves null expiry, unrestricted documents, and the disabled owner switch", async () => {
    const original = await createApiToken(userId, "Unrestricted");
    const replacement = await replaceApiToken(userId, original.id);
    expect(replacement !== null).toBe(true);
    expect(replacement!.expiresAt).toBeNull();
    expect(replacement!.documentIds).toBeNull();
    expect(replacement!.collaboratorsMayAsk).toBe(false);
  });

  it("refuses expired tokens without revoking them, and hides foreign, missing, or revoked tokens", async () => {
    const original = await createApiToken(userId, "Unchanged");
    expect(await replaceApiToken(otherId, original.id) === null).toBe(true);
    expect(await replaceApiToken(userId, "missing") === null).toBe(true);
    expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
    const db = await getDb();
    await db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, original.id));
    expect(await replaceApiToken(userId, original.id)
      .then(() => false, (error: unknown) => error instanceof ApiTokenExpiredError && /create a new token/i.test(error.message))).toBe(true);
    expect((await listApiTokens(userId))[0].revokedAt).toBeNull();
    expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
    await revokeApiToken(userId, original.id);
    expect(await replaceApiToken(userId, original.id) === null).toBe(true);
    expect((await listApiTokens(userId, true)).length).toBe(1);
  });

  it("rolls back revocation and slug release when replacement insertion fails", async () => {
    const original = await createApiToken(userId, "Rollback Agent");
    const before = await storedCredential(original.id);
    const db = await getDb();
    await db.execute(sql`create function token_management_fail_insert() returns trigger language plpgsql as $$
      begin raise exception 'Injected token insert failure'; end;
    $$`);
    try {
      await db.execute(sql`create trigger token_management_fail_insert before insert on api_token
        for each row execute function token_management_fail_insert()`);
      const failed = await replaceApiToken(userId, original.id).then(() => false, (error: unknown) =>
        error instanceof Error && error.message === "API token database write failed (SQLSTATE P0001)");
      expect(failed).toBe(true);
      expect((await resolveApiToken(original.token))?.tokenId === original.id).toBe(true);
      expect((await resolveApiTokenById(original.id))?.tokenId).toBe(original.id);
      const after = await storedCredential(original.id);
      expect(after.tokenHash === before.tokenHash).toBe(true);
      expect(after.mentionSlug).toBe(before.mentionSlug);
      const history = await listApiTokens(userId, true);
      expect(history.length).toBe(1);
      expect(history[0].revokedAt).toBeNull();
      expect(vi.mocked(disconnectCollabToken).mock.calls.length).toBe(0);
    } finally {
      await db.execute(sql`drop trigger if exists token_management_fail_insert on api_token`);
      await db.execute(sql`drop function token_management_fail_insert()`);
    }
    expect(await replaceApiToken(userId, original.id) !== null).toBe(true);
  });

  it("allows exactly one concurrent replacement of an old ID", async () => {
    const original = await createApiToken(userId, "Concurrent Agent");
    const results = await Promise.all([replaceApiToken(userId, original.id), replaceApiToken(userId, original.id)]);
    expect(results.filter((item) => item !== null).length).toBe(1);
    const winner = results.find((item) => item !== null)!;
    const active = await listApiTokens(userId);
    expect(active.map((item) => item.id)).toEqual([winner.id]);
    expect((await listApiTokens(userId, true)).length).toBe(2);
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect((await resolveApiToken(winner.token))?.tokenId === winner.id).toBe(true);
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it("serializes replacement with revocation without reviving a revoked ID", async () => {
    const original = await createApiToken(userId, "Revoke Race");
    const [replacement, revoked] = await Promise.all([
      replaceApiToken(userId, original.id), revokeApiToken(userId, original.id),
    ]);
    expect((replacement !== null) !== revoked).toBe(true);
    expect(await resolveApiToken(original.token) === null).toBe(true);
    expect(await resolveApiTokenById(original.id) === null).toBe(true);
    expect((await listApiTokens(userId)).length).toBe(replacement ? 1 : 0);
    expect(vi.mocked(disconnectCollabToken).mock.calls.map(([id]) => id)).toEqual([original.id]);
  });

  it("preserves the latest committed name and owner switch when replacement races an edit", async () => {
    const original = await createApiToken(userId, "Before Edit");
    const [replacement, edited] = await Promise.all([
      replaceApiToken(userId, original.id),
      updateApiToken(userId, original.id, { name: "After Edit", collaboratorsMayAsk: true }),
    ]);
    expect(replacement !== null).toBe(true);
    expect(replacement!.name).toBe(edited ? "After Edit" : "Before Edit");
    expect(replacement!.collaboratorsMayAsk).toBe(edited !== null);
    expect((await listApiTokens(userId)).map((item) => item.id)).toEqual([replacement!.id]);
    expect(await resolveApiToken(original.token) === null).toBe(true);
  });

  it.each(["create", "rename"] as const)("retains the reserved mention slug during a concurrent %s", async (operation) => {
    const original = await createApiToken(userId, "Reserved Agent");
    const contender = operation === "rename" ? await createApiToken(userId, "Contender") : null;
    const [replacement, conflict] = await Promise.all([
      replaceApiToken(userId, original.id),
      (contender
        ? updateApiToken(userId, contender.id, { name: "reserved-agent" })
        : createApiToken(userId, "reserved-agent"))
        .then(() => false, (error: unknown) => error instanceof AgentMentionConflictError),
    ]);
    expect(replacement !== null).toBe(true);
    expect(conflict).toBe(true);
    const active = await listApiTokens(userId);
    expect(active.length).toBe(contender ? 2 : 1);
    expect(active.filter((item) => item.name === original.name).map((item) => item.id)).toEqual([replacement!.id]);
    expect(await resolveApiToken(original.token) === null).toBe(true);
  });
});
