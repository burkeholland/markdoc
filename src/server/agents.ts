import type * as Y from "yjs";
import { makeCollabUser, type CollabUser } from "@/editor/collab/shared";
import type { Actor } from "@/server/http";
import { META_KEY } from "@/server/collab/hocuspocus";
import { touchAgentPresence } from "@/server/agent-presence";

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

/** Record agent activity in the shared document so connected editors can show it. Also marks the agent present. */
export function recordAgentActivity(doc: Y.Doc, actor: Actor, action: string) {
  if (!actor.agent) return;
  const meta = doc.getMap(META_KEY);
  const activity: AgentActivity = { name: actor.agent, userName: actor.name ?? actor.login ?? "someone", action, at: Date.now() };
  meta.set("agentActivity", activity);
  // Live documents are Hocuspocus Documents and carry their id as `name`; a detached copy has nobody watching.
  const docId = (doc as Y.Doc & { name?: unknown }).name;
  if (typeof docId === "string") touchAgentPresence(docId, actor, PRESENCE_STATUS[action] ?? action);
}
