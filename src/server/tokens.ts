import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import type { SessionUser } from "@/server/documents";

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
  createdAt: Date;
  expiresAt: Date | null;
}

export async function createApiToken(userId: string, name: string, expiresInDays?: number | null): Promise<CreatedToken> {
  const db = await getDb();
  const token = TOKEN_PREFIX + randomSecret();
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
  const [row] = await db
    .insert(schema.apiTokens)
    .values({ id: newId(), userId, name: name.trim().slice(0, 80) || "Token", prefix, tokenHash: hashToken(token), expiresAt })
    .returning();
  return { id: row.id, name: row.name, prefix: row.prefix, token, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

export async function listApiTokens(userId: string) {
  const db = await getDb();
  return db
    .select({
      id: schema.apiTokens.id,
      name: schema.apiTokens.name,
      prefix: schema.apiTokens.prefix,
      createdAt: schema.apiTokens.createdAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      expiresAt: schema.apiTokens.expiresAt,
    })
    .from(schema.apiTokens)
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .orderBy(desc(schema.apiTokens.createdAt));
}

export async function revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiTokens.id, tokenId), eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt)))
    .returning();
  return rows.length > 0;
}

export interface TokenActor extends SessionUser {
  /** Name of the token (agent) acting for the user. */
  agent: string;
  tokenId: string;
}

const lastUsedWrites = new Map<string, number>();

/** Resolve a bearer token to the user it belongs to. Returns null for unknown, expired or revoked tokens. */
export async function resolveApiToken(token: string): Promise<TokenActor | null> {
  if (!looksLikeApiToken(token)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ token: schema.apiTokens, user: schema.users })
    .from(schema.apiTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiTokens.userId))
    .where(eq(schema.apiTokens.tokenHash, hashToken(token)));
  if (!row) return null;
  if (row.token.revokedAt) return null;
  if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) return null;
  // Record usage at most once a minute per token to keep the hot path cheap.
  const last = lastUsedWrites.get(row.token.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastUsedWrites.set(row.token.id, Date.now());
    void db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, row.token.id));
  }
  return {
    id: row.user.id,
    login: row.user.login,
    name: row.user.name,
    image: row.user.image,
    agent: row.token.name,
    tokenId: row.token.id,
  };
}

