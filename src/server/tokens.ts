import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema, type Db, type Tx } from "@/server/db";
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
  collaboratorsMayAsk: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const createdTokenFields = {
  id: schema.apiTokens.id,
  name: schema.apiTokens.name,
  prefix: schema.apiTokens.prefix,
  scope: schema.apiTokens.scope,
  documentIds: schema.apiTokens.documentIds,
  collaboratorsMayAsk: schema.apiTokens.collaboratorsMayAsk,
  createdAt: schema.apiTokens.createdAt,
  expiresAt: schema.apiTokens.expiresAt,
  revokedAt: schema.apiTokens.revokedAt,
};

const tokenMetadataFields = {
  ...createdTokenFields,
  lastUsedAt: schema.apiTokens.lastUsedAt,
  lastMcpSeenAt: schema.apiTokens.lastMcpSeenAt,
  lastMcpCallAt: schema.apiTokens.lastMcpCallAt,
};

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

export class ApiTokenExpiredError extends Error {
  constructor() {
    super("Expired tokens cannot be replaced; create a new token instead");
    this.name = "ApiTokenExpiredError";
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

function rethrowTokenWriteError(error: unknown): never {
  if (constraintName(error) === "api_token_user_mention_slug_unique") throw new AgentMentionConflictError();
  if (error && typeof error === "object" && "query" in error && typeof error.query === "string" && "params" in error && Array.isArray(error.params)) {
    // The shared DB can come from another bundle. Recognize query errors structurally and omit credential-bearing causes.
    const cause = "cause" in error ? error.cause : null;
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : null;
    throw new Error(`API token database write failed${code ? ` (SQLSTATE ${code})` : ""}`);
  }
  throw error;
}

function generateToken() {
  const token = TOKEN_PREFIX + randomSecret();
  return { token, id: newId(), prefix: token.slice(0, TOKEN_PREFIX.length + 6), tokenHash: hashToken(token) };
}

async function releaseExpiredMentionSlugs(db: Db | Tx, userId: string) {
  await db
    .update(schema.apiTokens)
    .set({ mentionSlug: null })
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt), lt(schema.apiTokens.expiresAt, sql`clock_timestamp()`)));
}

export async function createApiToken(userId: string, name: string, options: number | null | CreateTokenOptions = {}): Promise<CreatedToken> {
  const opts: CreateTokenOptions = typeof options === "number" || options === null ? { expiresInDays: options } : options;
  if (Array.isArray(opts.documentIds) && opts.documentIds.length === 0) {
    throw new RangeError("documentIds must contain at least one document when provided");
  }
  const db = await getDb();
  await releaseExpiredMentionSlugs(db, userId);
  const { token, ...credential } = generateToken();
  const expiresAt = opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;
  const scope = opts.scope ?? "full";
  const documentIds = opts.documentIds ? Array.from(new Set(opts.documentIds)) : null;
  const normalizedName = name.trim().slice(0, 80) || "Token";
  try {
    const [row] = await db
      .insert(schema.apiTokens)
      .values({ ...credential, userId, name: normalizedName, mentionSlug: agentMentionSlug(normalizedName).toLowerCase(), expiresAt, scope, documentIds })
      .returning();
    return { ...createdTokenMetadata(row), token };
  } catch (error) {
    rethrowTokenWriteError(error);
  }
}

export async function listApiTokens(userId: string, includeRevoked = false) {
  const db = await getDb();
  return db
    .select(tokenMetadataFields)
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), includeRevoked ? undefined : isNull(schema.apiTokens.revokedAt)))
    .orderBy(desc(schema.apiTokens.createdAt));
}

export type ApiTokenListItem = Awaited<ReturnType<typeof listApiTokens>>[number];

// Both database drivers share the argumentless returning overload; project out credentials here.
function createdTokenMetadata(row: Omit<CreatedToken, "token">): Omit<CreatedToken, "token"> {
  const { id, name, prefix, scope, documentIds, collaboratorsMayAsk, createdAt, expiresAt, revokedAt } = row;
  return { id, name, prefix, scope, documentIds, collaboratorsMayAsk, createdAt, expiresAt, revokedAt };
}

function tokenMetadata(row: ApiTokenListItem): ApiTokenListItem {
  return {
    ...createdTokenMetadata(row),
    lastUsedAt: row.lastUsedAt,
    lastMcpSeenAt: row.lastMcpSeenAt,
    lastMcpCallAt: row.lastMcpCallAt,
  };
}

export function serializeApiTokenMetadata(token: ApiTokenListItem) {
  return {
    ...tokenMetadata(token),
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    lastMcpSeenAt: token.lastMcpSeenAt?.toISOString() ?? null,
    lastMcpCallAt: token.lastMcpCallAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Flip the owner switch that lets other users address requests to this agent (`@owner/slug`). Returns the
 * token as `listApiTokens` lists it, or null when `tokenId` is not one of the user's live tokens.
 */
export async function setCollaboratorsMayAsk(userId: string, tokenId: string, value: boolean): Promise<ApiTokenListItem | null> {
  const db = await getDb();
  const [row] = await db
    .update(schema.apiTokens)
    .set({ collaboratorsMayAsk: value })
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning();
  return row ? tokenMetadata(row) : null;
}

export interface UpdateTokenOptions {
  name?: string;
  collaboratorsMayAsk?: boolean;
}

/** Rename and/or change the owner switch without changing the credential or its permissions. */
export async function updateApiToken(userId: string, tokenId: string, updates: UpdateTokenOptions): Promise<ApiTokenListItem | null> {
  const name = updates.name?.trim();
  if (name === undefined) {
    if (updates.collaboratorsMayAsk === undefined) throw new RangeError("Provide a token name or collaboratorsMayAsk");
    return setCollaboratorsMayAsk(userId, tokenId, updates.collaboratorsMayAsk);
  }
  if (!name || name.length > 80 || name.includes("\0")) throw new RangeError("Token name must contain 1–80 characters and no NUL characters");
  const db = await getDb();
  try {
    return await db.transaction(async (tx) => {
      await releaseExpiredMentionSlugs(tx, userId);
      const [row] = await tx
        .update(schema.apiTokens)
        .set({
          name,
          mentionSlug: sql`case when ${schema.apiTokens.expiresAt} < clock_timestamp() then null else ${agentMentionSlug(name).toLowerCase()} end`,
          ...(updates.collaboratorsMayAsk === undefined ? {} : { collaboratorsMayAsk: updates.collaboratorsMayAsk }),
        })
        .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
        .returning();
      return row ? tokenMetadata(row) : null;
    });
  } catch (error) {
    rethrowTokenWriteError(error);
  }
}

/** Exchange a live token for a new identity and credential, retaining its exact access and expiry. */
export async function replaceApiToken(userId: string, tokenId: string): Promise<CreatedToken | null> {
  const db = await getDb();
  const { token, ...credential } = generateToken();
  let created: CreatedToken | null;
  try {
    created = await db.transaction(async (tx) => {
      // The conditional write locks the old row and returns the latest name/settings after competing writes.
      const [old] = await tx
        .update(schema.apiTokens)
        .set({ revokedAt: new Date(), mentionSlug: null })
        .where(and(
          eq(schema.apiTokens.id, tokenId),
          eq(schema.apiTokens.userId, userId),
          isNull(schema.apiTokens.revokedAt),
          or(isNull(schema.apiTokens.expiresAt), gte(schema.apiTokens.expiresAt, sql`clock_timestamp()`)),
        ))
        .returning();
      if (!old) {
        const [expired] = await tx
          .select({ id: schema.apiTokens.id })
          .from(schema.apiTokens)
          .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)));
        if (expired) throw new ApiTokenExpiredError();
        return null;
      }
      const [replacement] = await tx
        .insert(schema.apiTokens)
        .values({
          ...credential,
          userId,
          name: old.name,
          mentionSlug: agentMentionSlug(old.name).toLowerCase(),
          scope: old.scope,
          documentIds: old.documentIds,
          collaboratorsMayAsk: old.collaboratorsMayAsk,
          expiresAt: old.expiresAt,
        })
        .returning();
      return { ...createdTokenMetadata(replacement), token };
    });
  } catch (error) {
    rethrowTokenWriteError(error);
  }
  if (created) {
    const { disconnectCollabToken } = await import("@/server/collab/authorization");
    disconnectCollabToken(tokenId);
  }
  return created;
}

export type McpActivity = "list" | "call";

/**
 * Record that an MCP client used this token: `list` for `tools/list` (the client is connected and
 * discovered the tools), `call` for `tools/call` (permissions were granted and a tool ran).
 * These timestamps distinguish tool discovery from actual tool use in token metadata.
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
  /** Owner switch: other users may address requests to this agent. */
  collaboratorsMayAsk: boolean;
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
    collaboratorsMayAsk: row.token.collaboratorsMayAsk,
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
