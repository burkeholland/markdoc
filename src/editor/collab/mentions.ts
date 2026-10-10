import { GITHUB_LOGIN_MAX_LENGTH } from "@/lib/github-login";

/**
 * `@login` mentions inside plain-text comment bodies.
 *
 * A mention is `@` followed by a GitHub-login-shaped token (`[A-Za-z0-9-]{1,39}`, or for a
 * managed account that plus `_` and its short code: `@mona-cat_octo`) that is not glued to a
 * preceding word character, so e-mail addresses such as `a@b.com` are left alone.
 *
 * Agents (API tokens) are mentioned as `@login/Agent-Name`: the login is the user the
 * token acts for (that is who the notification is keyed on, so the agent's watch sees
 * it), the slug after the slash names the token so the chip can show a bot badge.
 */

export type MentionPart = { type: "text"; value: string } | { type: "mention"; value: string; agent?: string };

// The login ends where a login cannot go on: `@bob_ ` is `bob`, but `@mona-cat_octo` is never cut down
// to `mona-cat` (another account) and neither is a token that only starts like a login (`@a_b_c`).
const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9-]{1,39}(?:_[A-Za-z0-9]{1,37})?)(?:\/([A-Za-z0-9-]{1,39}))?(?![A-Za-z0-9-]|_[A-Za-z0-9])/g;

/** Token name → the slug used after `@login/` (runs of anything else become `-`). */
export function agentMentionSlug(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
  return slug || "agent";
}

/** What goes after `@` to mention an agent: `<ownerLogin>/<slug>`. */
export function agentMentionLogin(ownerLogin: string, agentName: string): string {
  return `${ownerLogin}/${agentMentionSlug(agentName)}`;
}

/** An agent (API token) and, when known, the user it acts for — what `agentDisplayName` labels. */
export interface AgentOwnerRef {
  /** Token name ("Copilot CLI"). */
  name: string;
  /** Owner's login; null / undefined when unknown (a request row from before #1296), which reads as the bare name. */
  ownerLogin?: string | null;
  /** Owner's display name when known; the login stands in otherwise. */
  ownerName?: string | null;
}

/** `Burke's`, `Chris'` — the English possessive of a display name. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/**
 * How one viewer sees an agent's name: the bare token name for the viewer's own agent (or when nobody knows whose
 * it is), `Burke's Copilot CLI` for someone else's — the owner's display name, or their login when that is all
 * the caller has (docs/agents.md, UI conventions).
 */
export function agentDisplayName(agent: AgentOwnerRef, viewerLogin: string | null | undefined): string {
  const owner = agent.ownerLogin?.trim();
  if (!owner || (viewerLogin && owner.toLowerCase() === viewerLogin.trim().toLowerCase())) return agent.name;
  return `${possessive(agent.ownerName?.trim() || owner)} ${agent.name}`;
}

/** Split a body into text and mention parts. Mention values are the bare login (no `@`, no agent suffix). */
export function splitMentions(body: string): MentionPart[] {
  const parts: MentionPart[] = [];
  if (!body) return parts;
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body))) {
    // The two halves of a managed login are bounded separately above; together they still fit GitHub's limit.
    if (m[2].length > GITHUB_LOGIN_MAX_LENGTH) continue;
    const start = m.index + m[1].length;
    if (start > last) parts.push({ type: "text", value: body.slice(last, start) });
    parts.push(m[3] ? { type: "mention", value: m[2], agent: m[3] } : { type: "mention", value: m[2] });
    last = start + 1 + m[2].length + (m[3] ? 1 + m[3].length : 0);
  }
  if (last < body.length) parts.push({ type: "text", value: body.slice(last) });
  return parts;
}

/** Unique mentioned logins, lower-cased, in order of first appearance (an agent mention yields its owner's login). */
export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const p of splitMentions(body)) {
    if (p.type === "mention") seen.add(p.value.toLowerCase());
  }
  return Array.from(seen);
}

/** Mentioned agents: `{ login, agent }` per distinct `@login/agent`, logins lower-cased. */
export function parseAgentMentions(body: string): { login: string; agent: string }[] {
  const out: { login: string; agent: string }[] = [];
  const seen = new Set<string>();
  for (const p of splitMentions(body)) {
    if (p.type !== "mention" || !p.agent) continue;
    const key = `${p.value.toLowerCase()}/${p.agent.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ login: p.value.toLowerCase(), agent: p.agent });
  }
  return out;
}

/**
 * If the caret sits right after `@` + 0..n login characters (and the `@` starts a
 * word), return the token so a composer can offer suggestions.
 */
export function mentionTriggerAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^A-Za-z0-9_])@((?:[A-Za-z0-9-]{1,39}(?:_[A-Za-z0-9]{0,37})?)?(?:\/[A-Za-z0-9-]{0,39})?)$/.exec(before);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}
