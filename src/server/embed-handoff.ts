import { randomBytes } from "node:crypto";

/**
 * One-time handoff from an API token to a browser session, for embedding the editor in a host that
 * cannot complete GitHub OAuth itself (the Copilot app's canvas panel). `POST /api/embed/handoff`
 * (token) mints a nonce bound to the token's user and one document; `GET /embed/:nonce` spends it
 * within `HANDOFF_TTL_MS`, sets the normal session cookie for that user and redirects to the
 * document. State lives on `globalThis`: the route bundle and the custom server are separate module
 * graphs in one process (see agent-events.ts).
 */

export const HANDOFF_TTL_MS = 60_000;
/** Nonces are 32 random bytes, base64url: 43 characters, unguessable. */
export const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

export interface Handoff {
  userId: string;
  documentId: string;
  /** Epoch ms after which the nonce is refused. */
  expiresAt: number;
}

export type HandoffFailure = "unknown" | "expired" | "used";
export type ConsumeResult = { ok: true; handoff: Handoff } | { ok: false; reason: HandoffFailure };

interface Store {
  live: Map<string, Handoff>;
  /** Spent nonces kept until their original expiry so a replay can be told from garbage. */
  spent: Map<string, number>;
}
const g = globalThis as typeof globalThis & { __markdocEmbedHandoffs?: Store };
const store: Store = (g.__markdocEmbedHandoffs ??= { live: new Map(), spent: new Map() });

function sweep(now: number) {
  for (const [nonce, h] of store.live) if (h.expiresAt <= now) store.live.delete(nonce);
  for (const [nonce, expiresAt] of store.spent) if (expiresAt <= now) store.spent.delete(nonce);
}

/** Mint a nonce for `userId` to open `documentId`; valid once, for `ttlMs`. */
export function createHandoff(userId: string, documentId: string, now = Date.now(), ttlMs = HANDOFF_TTL_MS): { nonce: string; expiresAt: number } {
  sweep(now);
  const nonce = randomBytes(32).toString("base64url");
  const expiresAt = now + ttlMs;
  store.live.set(nonce, { userId, documentId, expiresAt });
  return { nonce, expiresAt };
}

/** Spend a nonce: the handoff exactly once, then `used`; `expired` after its TTL; `unknown` otherwise. */
export function consumeHandoff(nonce: string, now = Date.now()): ConsumeResult {
  sweep(now);
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: "unknown" };
  const handoff = store.live.get(nonce);
  if (handoff) {
    store.live.delete(nonce);
    if (handoff.expiresAt <= now) return { ok: false, reason: "expired" };
    store.spent.set(nonce, handoff.expiresAt);
    return { ok: true, handoff };
  }
  if (store.spent.has(nonce)) return { ok: false, reason: "used" };
  return { ok: false, reason: "unknown" };
}

/** Live nonces (tests). */
export function handoffCount(): number {
  return store.live.size;
}

/** Tests only. */
export function resetHandoffs() {
  store.live.clear();
  store.spent.clear();
}
