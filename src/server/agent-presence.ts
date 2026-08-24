import * as Y from "yjs";
import { applyAwarenessUpdate, removeAwarenessStates, type Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { getCollab } from "@/server/collab/registry";
import { TEXT_KEY } from "@/server/collab/seed";
import { colorForUser, hashString, type RelativePositionJSON } from "@/editor/collab/shared";
import { cleanTextWith, rawToCleanOffset, resolveCleanRange, SuggestionsModel, type CleanRangeInput } from "@/editor/collab/suggestions";
import type { Actor } from "@/server/http";

/** An agent disappears from the document this long after its last heartbeat or write. */
export const AGENT_PRESENCE_TTL_MS = Number(process.env.AGENT_PRESENCE_TTL_MS ?? 90_000);
/** Clients drop awareness states not refreshed within 30 s (y-protocols); re-publish well inside that. */
export const AGENT_PRESENCE_REFRESH_MS = Number(process.env.AGENT_PRESENCE_REFRESH_MS ?? 12_000);
export const STATUS_MAX = 80;

export type AgentPresenceState = "active" | "idle" | "left";

/**
 * Where an agent is in the document: offsets in the clean Markdown (what `markdoc_read_document` with
 * `clean: true` returns) plus the same range as Yjs relative positions — the shape browsers publish as
 * `cursor.anchor` / `cursor.head`, so every pane draws it like any remote caret.
 */
export interface AgentCursor {
  from: number;
  to: number;
  anchor: RelativePositionJSON;
  head: RelativePositionJSON;
}

export interface AgentPresence {
  /** `agent:<userId>:<tokenName>` — the same id comments and suggestions by this agent carry. */
  id: string;
  name: string;
  userId: string;
  userName: string;
  /** Login of the user the token acts for (who `@login/<agent>` mentions resolve to). */
  userLogin: string | null;
  state: Exclude<AgentPresenceState, "left">;
  status: string | null;
  cursor: { from: number; to: number } | null;
  color: string;
  colorLight: string;
  /** Epoch ms of the last heartbeat or write. */
  lastSeen: number;
  expiresAt: number;
}

interface Entry extends Omit<AgentPresence, "cursor"> {
  cursor: AgentCursor | null;
  clientId: number;
  clock: number;
  /** Set by the presence API; implicit write marking never overrides it while it is fresh. */
  explicitStatusUntil: number;
}

/** Awareness update origin for everything the server publishes on behalf of agents. */
export const AGENT_AWARENESS_ORIGIN = { source: "agent" } as const;

// Shared between the custom server (Hocuspocus hooks) and the Next.js route bundle, which are separate
// module graphs in one process (see collab/registry.ts).
interface SharedState {
  byDoc: Map<string, Map<string, Entry>>;
  sweeper: ReturnType<typeof setInterval> | null;
}
const g = globalThis as typeof globalThis & { __markdocAgentPresence?: SharedState };
const shared: SharedState = (g.__markdocAgentPresence ??= { byDoc: new Map(), sweeper: null });
const byDoc = shared.byDoc;

export function agentPresenceId(actor: Pick<Actor, "id" | "agent">): string {
  return `agent:${actor.id}:${actor.agent}`;
}

/** A synthetic awareness client id for an agent: stable per agent, kept away from the low ids Yjs never uses. */
export function agentClientId(id: string): number {
  return (hashString(id) >>> 1) | 0x10000;
}

function liveAwareness(docId: string): Awareness | null {
  const doc = getCollab()?.documents.get(docId) as (Y.Doc & { awareness?: Awareness }) | undefined;
  return doc?.awareness ?? null;
}

function awarenessState(e: Entry) {
  return {
    user: {
      id: e.id,
      name: e.name,
      color: e.color,
      colorLight: e.colorLight,
      avatar: null,
      login: null,
      role: null,
      isAgent: true,
      status: e.status,
      agentState: e.state,
      userName: e.userName,
      userLogin: e.userLogin,
    },
    lastActive: e.state === "idle" ? e.lastSeen - 10 * 60 * 1000 : e.lastSeen,
    ...(e.cursor ? { cursor: { anchor: e.cursor.anchor, head: e.cursor.head } } : {}),
  };
}

/** y-protocols awareness update wire format for a single synthetic client. */
export function encodeAgentAwareness(clientId: number, clock: number, state: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, clientId);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  return encoding.toUint8Array(enc);
}

function publish(awareness: Awareness, e: Entry) {
  e.clock += 1;
  applyAwarenessUpdate(awareness, encodeAgentAwareness(e.clientId, e.clock, awarenessState(e)), AGENT_AWARENESS_ORIGIN);
}

function unpublish(awareness: Awareness, e: Entry) {
  if (awareness.getStates().has(e.clientId)) removeAwarenessStates(awareness, [e.clientId], AGENT_AWARENESS_ORIGIN);
}

function ensureSweeper() {
  if (shared.sweeper) return;
  shared.sweeper = setInterval(sweep, AGENT_PRESENCE_REFRESH_MS);
  shared.sweeper.unref?.();
}

/** Expire stale agents and re-publish live ones so client-side awareness timeouts never drop them. */
export function sweep(now = Date.now()) {
  for (const [docId, agents] of byDoc) {
    const awareness = liveAwareness(docId);
    for (const [key, e] of agents) {
      if (e.expiresAt <= now) {
        agents.delete(key);
        if (awareness) unpublish(awareness, e);
      } else if (awareness) {
        publish(awareness, e);
      }
    }
    if (agents.size === 0) byDoc.delete(docId);
  }
  if (byDoc.size === 0 && shared.sweeper) {
    clearInterval(shared.sweeper);
    shared.sweeper = null;
  }
}

export interface SetPresenceInput {
  state: AgentPresenceState;
  status?: string | null;
  /** Resolved with {@link resolveAgentCursor}; `null` clears the caret, `undefined` leaves it. */
  cursor?: AgentCursor | null;
}

function relativeRange(ytext: Y.Text, from: number, to: number): Pick<AgentCursor, "anchor" | "head"> {
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, from)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, to)),
  };
}

/**
 * Resolve clean-text offsets or an `anchor` quote to an {@link AgentCursor} against a document. Works on
 * the live document or a copy loaded from the database: relative positions name Yjs items, not indexes,
 * so they resolve in every replica. Returns null when the anchor text does not occur.
 */
export function resolveAgentCursor(doc: Y.Doc, input: CleanRangeInput): AgentCursor | null {
  const ytext = doc.getText(TEXT_KEY);
  const model = new SuggestionsModel(doc, ytext);
  try {
    const list = model.list();
    const clean = cleanTextWith(ytext.toString(), list);
    const range = resolveCleanRange(clean, list, input);
    if (!range) return null;
    return { from: range.clean.from, to: range.clean.to, ...relativeRange(ytext, range.raw.from, range.raw.to) };
  } finally {
    model.destroy();
  }
}

/** An {@link AgentCursor} for a range of the full text (what write routes know after applying an edit). */
export function agentCursorFromRaw(doc: Y.Doc, from: number, to: number): AgentCursor {
  const ytext = doc.getText(TEXT_KEY);
  const model = new SuggestionsModel(doc, ytext);
  try {
    const list = model.list();
    const len = ytext.length;
    const f = Math.min(Math.max(0, from), len);
    const t = Math.min(Math.max(f, to), len);
    return { from: rawToCleanOffset(f, list), to: rawToCleanOffset(t, list), ...relativeRange(ytext, f, t) };
  } finally {
    model.destroy();
  }
}

/** Explicit heartbeat from the presence API. Returns the agent's presence, or null after `left`. */
export function setAgentPresence(docId: string, actor: Actor, input: SetPresenceInput, now = Date.now()): AgentPresence | null {
  if (!actor.agent) return null;
  const id = agentPresenceId(actor);
  const agents = byDoc.get(docId);
  const existing = agents?.get(id);
  if (input.state === "left") {
    if (existing && agents) {
      agents.delete(id);
      const awareness = liveAwareness(docId);
      if (awareness) unpublish(awareness, existing);
      if (agents.size === 0) byDoc.delete(docId);
    }
    return null;
  }
  const entry = upsert(docId, actor, id, existing, now);
  entry.state = input.state;
  if (input.status !== undefined) {
    entry.status = input.status ? input.status.trim().slice(0, STATUS_MAX) || null : null;
    entry.explicitStatusUntil = now + AGENT_PRESENCE_TTL_MS;
  }
  if (input.cursor !== undefined) entry.cursor = input.cursor;
  const awareness = liveAwareness(docId);
  if (awareness) publish(awareness, entry);
  return toPresence(entry);
}

/**
 * Implicit marking from agent writes (replace, append, suggest, comment): the agent shows as active with a
 * verb status for the TTL, unless it set its own status through the presence API recently. A `cursor`
 * moves its caret to where it acted, so people watching see it "working there".
 */
export function touchAgentPresence(docId: string, actor: Actor, status: string, cursor?: AgentCursor | null, now = Date.now()): AgentPresence | null {
  if (!actor.agent) return null;
  const id = agentPresenceId(actor);
  const existing = byDoc.get(docId)?.get(id);
  const entry = upsert(docId, actor, id, existing, now);
  entry.state = "active";
  if (entry.explicitStatusUntil <= now) entry.status = status;
  if (cursor !== undefined) entry.cursor = cursor;
  const awareness = liveAwareness(docId);
  if (awareness) publish(awareness, entry);
  return toPresence(entry);
}

function upsert(docId: string, actor: Actor, id: string, existing: Entry | undefined, now: number): Entry {
  let agents = byDoc.get(docId);
  if (!agents) {
    agents = new Map();
    byDoc.set(docId, agents);
  }
  const entry: Entry = existing ?? {
    id,
    name: actor.agent!,
    userId: actor.id,
    userName: actor.name ?? actor.login ?? "someone",
    userLogin: actor.login ?? null,
    state: "active",
    status: null,
    cursor: null,
    ...colorForUser(id),
    lastSeen: now,
    expiresAt: now + AGENT_PRESENCE_TTL_MS,
    clientId: agentClientId(id),
    clock: 0,
    explicitStatusUntil: 0,
  };
  entry.lastSeen = now;
  entry.expiresAt = now + AGENT_PRESENCE_TTL_MS;
  agents.set(id, entry);
  ensureSweeper();
  return entry;
}

function toPresence(e: Entry): AgentPresence {
  return {
    id: e.id,
    name: e.name,
    userId: e.userId,
    userName: e.userName,
    userLogin: e.userLogin,
    state: e.state,
    status: e.status,
    cursor: e.cursor ? { from: e.cursor.from, to: e.cursor.to } : null,
    color: e.color,
    colorLight: e.colorLight,
    lastSeen: e.lastSeen,
    expiresAt: e.expiresAt,
  };
}

/** Agents currently present on a document (expired ones are dropped on read). */
export function listAgentPresence(docId: string, now = Date.now()): AgentPresence[] {
  const agents = byDoc.get(docId);
  if (!agents) return [];
  const out: AgentPresence[] = [];
  for (const [key, e] of agents) {
    if (e.expiresAt <= now) agents.delete(key);
    else out.push(toPresence(e));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Called when the collaboration server loads a document: agents that announced themselves before anyone
 * opened the document (or across a reload) are pushed into its awareness right away.
 */
export function publishAgentPresence(doc: Y.Doc, docId: string) {
  const awareness = (doc as Y.Doc & { awareness?: Awareness }).awareness;
  const agents = byDoc.get(docId);
  if (!awareness || !agents) return;
  const now = Date.now();
  for (const e of agents.values()) if (e.expiresAt > now) publish(awareness, e);
}

/** Tests only. */
export function resetAgentPresence() {
  byDoc.clear();
  if (shared.sweeper) clearInterval(shared.sweeper);
  shared.sweeper = null;
}
