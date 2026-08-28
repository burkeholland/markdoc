import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { TokenScope } from "@/server/db/schema";
import type { SessionUser } from "@/server/documents";
import { agentMentionSlug } from "@/editor/collab/mentions";

const TOKEN_PREFIX = "mdk_";
const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomSecret(length = 40): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function looksLikeApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length + 20;
}

export interface CreatedToken {
  id: string;
  name: string;
  prefix: string;
  /** The full secret. Shown once; never stored. */
  token: string;
  scope: TokenScope;
  documentIds: string[] | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "comment", "full"];
const SCOPE_RANK: Record<TokenScope, number> = { read: 0, comment: 1, full: 2 };

/** True when `scope` grants at least `minimum` (`read` < `comment` < `full`). */
export function scopeSatisfies(scope: TokenScope, minimum: TokenScope): boolean {
  return SCOPE_RANK[scope] >= SCOPE_RANK[minimum];
}

export interface CreateTokenOptions {
  expiresInDays?: number | null;
  /** Defaults to `full` so existing callers (and scripts) keep today's behaviour. */
  scope?: TokenScope;
  /** Restrict the token to these documents; null or omitted = all of the user's documents. */
  documentIds?: string[] | null;
}

export class AgentMentionConflictError extends Error {
  constructor() {
    super("Another active token has the same @mention name");
    this.name = "AgentMentionConflictError";
  }
}

function constraintName(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ("constraint" in current && typeof current.constraint === "string") return current.constraint;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export async function createApiToken(userId: string, name: string, options: number | null | CreateTokenOptions = {}): Promise<CreatedToken> {
  const opts: CreateTokenOptions = typeof options === "number" || options === null ? { expiresInDays: options } : options;
  if (Array.isArray(opts.documentIds) && opts.documentIds.length === 0) {
    throw new RangeError("documentIds must contain at least one document when provided");
  }
  const db = await getDb();
  await db
    .update(schema.apiTokens)
    .set({ mentionSlug: null })
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt), lt(schema.apiTokens.expiresAt, new Date())));
  const token = TOKEN_PREFIX + randomSecret();
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;
  const scope = opts.scope ?? "full";
  const documentIds = opts.documentIds ? Array.from(new Set(opts.documentIds)) : null;
  const normalizedName = name.trim().slice(0, 80) || "Token";
  let row: typeof schema.apiTokens.$inferSelect;
  try {
    [row] = await db
      .insert(schema.apiTokens)
      .values({ id: newId(), userId, name: normalizedName, mentionSlug: agentMentionSlug(normalizedName).toLowerCase(), prefix, tokenHash: hashToken(token), expiresAt, scope, documentIds })
      .returning();
  } catch (error) {
    if (constraintName(error) === "api_token_user_mention_slug_unique") throw new AgentMentionConflictError();
    throw error;
  }
  return { id: row.id, name: row.name, prefix: row.prefix, token, scope: row.scope, documentIds: row.documentIds, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export async function listApiTokens(userId: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      prefix: schema.apiTokens.prefix,
      scope: schema.apiTokens.scope,
      documentIds: schema.apiTokens.documentIds,
      createdAt: schema.apiTokens.createdAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      lastMcpSeenAt: schema.apiTokens.lastMcpSeenAt,
      lastMcpCallAt: schema.apiTokens.lastMcpCallAt,
      expiresAt: schema.apiTokens.expiresAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .orderBy(desc(schema.apiTokens.createdAt));
}

export type McpActivity = "list" | "call";

/**
 * Record that an MCP client used this token: `list` for `tools/list` (the client is connected and
 * discovered the tools), `call` for `tools/call` (permissions were granted and a tool ran). The
 * Settings checklist turns its steps green from these.
 */
export async function recordMcpActivity(tokenId: string, kind: McpActivity, now = new Date()): Promise<void> {
  const db = await getDb();
  await db
    .update(schema.apiTokens)
    .set(kind === "list" ? { lastMcpSeenAt: now } : { lastMcpCallAt: now })
    .where(eq(schema.apiTokens.id, tokenId));
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date(), mentionSlug: null })
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning();
  if (rows.length === 0) return false;
  const { disconnectCollabToken } = await import("@/server/collab/authorization");
  disconnectCollabToken(tokenId);
  return true;
}

export interface TokenActor extends SessionUser {
  /** Name of the token (agent) acting for the user. */
  agent: string;
  tokenId: string;
  scope: TokenScope;
  /** Documents the token is restricted to; null = all of the user's. */
  documentIds: string[] | null;
  expiresAt: Date | null;
}

const lastUsedWrites = new Map<string, number>();

type TokenWithUser = {
  token: typeof schema.apiTokens.$inferSelect;
  user: typeof schema.users.$inferSelect;
};

function resolvedActor(row: TokenWithUser): TokenActor | null {
  if (row.token.revokedAt) return null;
  if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) return null;
  return {
    id: row.user.id,
    login: row.user.login,
    name: row.user.name,
    image: row.user.image,
    agent: row.token.name,
    tokenId: row.token.id,
    scope: row.token.scope,
    documentIds: row.token.documentIds?.length ? row.token.documentIds : null,
    expiresAt: row.token.expiresAt,
  };
}

async function writeLastUsed(tokenId: string): Promise<void> {
  const db = await getDb();
  await db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, tokenId));
}

function noteTokenUse(tokenId: string): void {
  const last = lastUsedWrites.get(tokenId) ?? 0;
  if (Date.now() - last <= 60_000) return;
  lastUsedWrites.set(tokenId, Date.now());
  void writeLastUsed(tokenId).catch((error) => console.error("record API token use failed", error));
}

/** Resolve a bearer token to the user it belongs to. Returns null for unknown, expired or revoked tokens. */
export async function resolveApiToken(token: string): Promise<TokenActor | null> {
  if (!looksLikeApiToken(token)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.tokenHash, hashToken(token)));
  const actor = row ? resolvedActor(row) : null;
  if (actor) noteTokenUse(actor.tokenId);
  return actor;
}

/** Re-resolve an embedded session on every request so token revocation and expiry still take effect. */
export async function resolveApiTokenById(tokenId: string): Promise<TokenActor | null> {
  const db = await getDb();
  const [row] = await db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.id, tokenId));
  const actor = row ? resolvedActor(row) : null;
  if (actor) noteTokenUse(actor.tokenId);
  return actor;
}

/** A named mention must resolve to one active token, not every token whose display name has the same slug. */
export async function isAgentMentionUnique(userId: string, tokenId: string | null, name: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ id: schema.apiTokens.id, name: schema.apiTokens.name, expiresAt: schema.apiTokens.expiresAt })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
  const slug = agentMentionSlug(name).toLowerCase();
  return !rows.some((row) => row.id !== tokenId && (!row.expiresAt || row.expiresAt.getTime() >= Date.now()) && agentMentionSlug(row.name).toLowerCase() === slug);
}
