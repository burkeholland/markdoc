import type * as Y from "yjs";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { makeCollabUser, type CollabUser } from "@/editor/collab/shared";
import { agentMentionLogin, agentMentionSlug } from "@/editor/collab/mentions";
import type { Actor } from "@/server/http";
import { META_KEY } from "@/server/collab/hocuspocus";
import { agentCursorFromRaw, listAgentPresence, touchAgentPresence } from "@/server/agent-presence";

/**
 * Identity used for comments and suggestions created through the API.
 * Agents get their own identity (named after the token) so that humans can
 * tell the agent's proposals apart from their own edits and review them.
 */
export function collabIdentity(actor: Actor): CollabUser {
  if (actor.agent) {
    return makeCollabUser(`agent:${actor.id}:${actor.agent}`, actor.agent, null, actor.login);
  }
  return makeCollabUser(actor.id, actor.name ?? actor.login ?? "User", actor.image, actor.login);
}

export interface AgentActivity {
  /** Agent (token) name. */
  name: string;
  /** The human the agent acts for. */
  userName: string;
  /** What happened: "edited", "suggested", "commented". */
  action: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Status shown on the agent's presence avatar while it works (see agent-presence.ts). */
const PRESENCE_STATUS: Record<string, string> = { edited: "editing", suggested: "suggesting", commented: "commenting", reacted: "commenting", reviewed: "reviewing suggestions" };

/**
 * Record agent activity in the shared document so connected editors can show it. Also marks the agent
 * present; `at` (a range of the full text) moves its caret to where it acted.
 */
export function recordAgentActivity(doc: Y.Doc, actor: Actor, action: string, at?: { from: number; to: number }) {
  if (!actor.agent) return;
  const meta = doc.getMap(META_KEY);
  const activity: AgentActivity = { name: actor.agent, userName: actor.name ?? actor.login ?? "someone", action, at: Date.now() };
  meta.set("agentActivity", activity);
  // Live documents are Hocuspocus Documents and carry their id as `name`; a detached copy has nobody watching.
  const docId = (doc as Y.Doc & { name?: unknown }).name;
  if (typeof docId === "string") touchAgentPresence(docId, actor, PRESENCE_STATUS[action] ?? action, at ? agentCursorFromRaw(doc, at.from, at.to) : undefined);
}

/** An agent people can @-mention from a document: present now, or active here in the last 30 days. */
export interface MentionableAgent {
  /** Token name ("Copilot CLI"). */
  name: string;
  /** What follows `@` in a comment: `<ownerLogin>/<slug>`. */
  login: string;
  ownerLogin: string;
  ownerName: string | null;
  /** Present in the document right now (else it only acted here recently). */
  present: boolean;
  /** The owner lets other users address requests to this agent (false when no live token answers to it). */
  collaboratorsMayAsk: boolean;
}

export const RECENT_AGENT_DAYS = 30;

/**
 * Agents worth offering in the @-mention picker: those present on the document plus distinct agents with
 * activity rows here in the last 30 days (token owner resolved through the user table). Agents whose
 * owner has no login cannot be mentioned and are skipped. `collaboratorsMayAsk` comes from the owner's
 * live token with that mention slug.
 */
export async function listMentionableAgents(docId: string, now = new Date()): Promise<MentionableAgent[]> {
  const out = new Map<string, MentionableAgent & { ownerId: string }>();
  for (const p of listAgentPresence(docId, now.getTime())) {
    if (!p.userLogin) continue;
    out.set(p.id, { name: p.name, login: agentMentionLogin(p.userLogin, p.name), ownerLogin: p.userLogin, ownerName: p.userName, present: true, collaboratorsMayAsk: false, ownerId: p.userId });
  }
  const db = await getDb();
  const since = new Date(now.getTime() - RECENT_AGENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .selectDistinct({ actorId: schema.activity.actorId, actorName: schema.activity.actorName })
    .from(schema.activity)
    .where(and(eq(schema.activity.documentId, docId), eq(schema.activity.actorKind, "agent"), gt(schema.activity.createdAt, since)));
  const userIds = new Set<string>();
  const recent: { id: string; userId: string; name: string }[] = [];
  for (const row of rows) {
    // actorId is `agent:<userId>:<tokenName>`; the token name may itself contain colons.
    const m = /^agent:([^:]+):(.+)$/.exec(row.actorId ?? "");
    if (!m || out.has(row.actorId!)) continue;
    userIds.add(m[1]);
    recent.push({ id: row.actorId!, userId: m[1], name: m[2] || row.actorName });
  }
  if (recent.length > 0) {
    const users = await db.select({ id: schema.users.id, login: schema.users.login, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, [...userIds]));
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const r of recent) {
      const u = byId.get(r.userId);
      if (!u?.login || out.has(r.id)) continue;
      out.set(r.id, { name: r.name, login: agentMentionLogin(u.login, r.name), ownerLogin: u.login, ownerName: u.name ?? null, present: false, collaboratorsMayAsk: false, ownerId: r.userId });
    }
  }
  const agents = [...out.values()];
  if (agents.length > 0) {
    const tokens = await db
      .select({ userId: schema.apiTokens.userId, mentionSlug: schema.apiTokens.mentionSlug, collaboratorsMayAsk: schema.apiTokens.collaboratorsMayAsk })
      .from(schema.apiTokens)
      .where(and(inArray(schema.apiTokens.userId, [...new Set(agents.map((a) => a.ownerId))]), isNull(schema.apiTokens.revokedAt), or(isNull(schema.apiTokens.expiresAt), gt(schema.apiTokens.expiresAt, now))));
    const switches = new Map(tokens.filter((t) => t.mentionSlug).map((t) => [`${t.userId}/${t.mentionSlug}`, t.collaboratorsMayAsk]));
    for (const a of agents) a.collaboratorsMayAsk = switches.get(`${a.ownerId}/${agentMentionSlug(a.name).toLowerCase()}`) ?? false;
  }
  return agents
    .sort((a, b) => Number(b.present) - Number(a.present) || a.name.localeCompare(b.name))
    .map(({ ownerId: _ownerId, ...agent }) => agent);
}
