import { agentMentionSlug } from "@/editor/collab/mentions";
import type { ApiTokenDto } from "@/lib/api";

type KeyLike = Pick<ApiTokenDto, "expiresAt" | "revokedAt">;

/** A key that still works: not revoked and not past its expiry. */
export function isActiveKey(key: KeyLike, now = Date.now()): boolean {
  if (key.revokedAt) return false;
  return !key.expiresAt || new Date(key.expiresAt).getTime() >= now;
}

/** The key can open this document: it covers every document, or it lists this one. */
export function keyReaches(key: Pick<ApiTokenDto, "documentIds">, documentId: string): boolean {
  return key.documentIds === null || key.documentIds.includes(documentId);
}

/** An agent has used this key: an MCP client listed the tools, or any authenticated request arrived (the Copilot app uses REST). */
export function hasConnected(key: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastUsedAt">): boolean {
  return Boolean(key.lastMcpSeenAt || key.lastUsedAt);
}

/** When an agent last used the key (ISO), or null if it never has. */
export function lastSeenAt(key: Pick<ApiTokenDto, "lastMcpSeenAt" | "lastUsedAt">): string | null {
  const times = [key.lastMcpSeenAt, key.lastUsedAt].filter((value): value is string => Boolean(value));
  if (times.length === 0) return null;
  return times.reduce((latest, value) => (new Date(value).getTime() > new Date(latest).getTime() ? value : latest));
}

/**
 * A key name whose @mention slug does not collide with an active key's: the server refuses two active
 * keys that mention the same way ("Copilot CLI" and "copilot cli"), so the default steps to "Copilot CLI 2".
 */
export function uniqueKeyName(base: string, keys: readonly (KeyLike & Pick<ApiTokenDto, "name">)[] | null, now = Date.now()): string {
  const taken = new Set((keys ?? []).filter((key) => isActiveKey(key, now)).map((key) => agentMentionSlug(key.name).toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(agentMentionSlug(name).toLowerCase())) return name;
  }
}
