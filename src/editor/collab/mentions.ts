/**
 * `@login` mentions inside plain-text comment bodies.
 *
 * A mention is `@` followed by a GitHub-login-shaped token (`[A-Za-z0-9-]{1,39}`)
 * that is not glued to a preceding word character, so e-mail addresses such as
 * `a@b.com` are left alone.
 */

export type MentionPart = { type: "text" | "mention"; value: string };

export const MENTION_LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9-]{1,39})(?![A-Za-z0-9-])/g;

/** Split a body into text and mention parts. Mention values are the bare login (no `@`). */
export function splitMentions(body: string): MentionPart[] {
  const parts: MentionPart[] = [];
  if (!body) return parts;
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body))) {
    const start = m.index + m[1].length;
    if (start > last) parts.push({ type: "text", value: body.slice(last, start) });
    parts.push({ type: "mention", value: m[2] });
    last = start + 1 + m[2].length;
  }
  if (last < body.length) parts.push({ type: "text", value: body.slice(last) });
  return parts;
}

/** Unique mentioned logins, lower-cased, in order of first appearance. */
export function parseMentions(body: string): string[] {
  const seen = new Set<string>();
  for (const p of splitMentions(body)) {
    if (p.type === "mention") seen.add(p.value.toLowerCase());
  }
  return Array.from(seen);
}

/**
 * If the caret sits right after `@` + 0..n login characters (and the `@` starts a
 * word), return the token so a composer can offer suggestions.
 */
export function mentionTriggerAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^A-Za-z0-9_])@([A-Za-z0-9-]{0,39})$/.exec(before);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}
