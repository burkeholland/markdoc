/**
 * Once-only hints for the agent/collaboration features, shown in a slim bar under the editor
 * toolbar (src/components/editor/hint-bar.tsx). This module is the pure part: which hint is due
 * given the document state and what the user has dismissed, plus the codec for the `localStorage`
 * record. No DOM, no React — unit-tested in hints.test.ts.
 *
 * There used to be a third hint (selection ≥ 20 characters → the old agent request dialog); #1025 folded it
 * into `mention-copilot`, and #1075 removed the dialog: a comment that @-mentions an agent is the request.
 * A stored dismissal of the retired id is dropped by `parseHintsRecord` (unknown ids are filtered).
 */

export type HintId = "collab-agent" | "mention-copilot";

/** Display order doubles as priority: the first due, undismissed hint wins. */
export const HINT_ORDER: readonly HintId[] = ["collab-agent", "mention-copilot"];

export interface HintCopy {
  message: string;
  /** Label of the action button (opens the agent dialog / a document comment with `@` typed). */
  action: string;
}

export const HINTS: Record<HintId, HintCopy> = {
  "collab-agent": { message: "An AI agent can work in this doc with you", action: "Connect an agent" },
  "mention-copilot": { message: "Mention an agent in a comment and it answers in the thread", action: "Write a comment" },
};

/** `localStorage` key for the record below. */
export const HINTS_STORAGE_KEY = "markdoc:hints";

/** Viewports narrower than this (phones) never show the bar: there is no room under the toolbar. */
export const HINTS_MIN_WIDTH = 768;

/** What the bar knows about the open document and the user; every gate is derived from this. */
export interface HintState {
  /** People (not agents) with access besides the local user — collaborators on the share list or present now. */
  collaborators: number;
  /** An agent (API token) has ever been seen by this user: in presence here, or a token that was used. */
  agentEverConnected: boolean;
  /** Comment threads in the document (open or resolved). */
  commentThreads: number;
}

export interface HintsRecord {
  dismissed: HintId[];
  /** Remembered so hint (a) stays quiet after an agent was seen once, even in a doc without one. */
  agentSeen: boolean;
}

export const EMPTY_HINTS_RECORD: HintsRecord = { dismissed: [], agentSeen: false };

export function isHintId(value: unknown): value is HintId {
  return typeof value === "string" && (HINT_ORDER as readonly string[]).includes(value);
}

/** Is the hint relevant right now? Relevance is independent of what was dismissed. */
export function hintRelevant(id: HintId, state: HintState): boolean {
  switch (id) {
    case "collab-agent":
      return state.collaborators >= 1 && !state.agentEverConnected;
    case "mention-copilot":
      return state.commentThreads >= 1;
  }
}

/** The hint to show: the first relevant one the user has not dismissed, or null. */
export function dueHint(state: HintState, dismissed: ReadonlySet<HintId> | readonly HintId[]): HintId | null {
  const gone = dismissed instanceof Set ? dismissed : new Set(dismissed);
  for (const id of HINT_ORDER) {
    if (!gone.has(id) && hintRelevant(id, state)) return id;
  }
  return null;
}

/** True once every hint has been dismissed: the bar never mounts again. */
export function allHintsDismissed(dismissed: ReadonlySet<HintId> | readonly HintId[]): boolean {
  const gone = dismissed instanceof Set ? dismissed : new Set(dismissed);
  return HINT_ORDER.every((id) => gone.has(id));
}

/** Parse the stored record; anything malformed yields the empty record (never throws). */
export function parseHintsRecord(raw: string | null | undefined): HintsRecord {
  if (!raw) return EMPTY_HINTS_RECORD;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_HINTS_RECORD;
    const obj = parsed as { dismissed?: unknown; agentSeen?: unknown };
    const dismissed = Array.isArray(obj.dismissed) ? obj.dismissed.filter(isHintId) : [];
    return { dismissed: Array.from(new Set(dismissed)), agentSeen: obj.agentSeen === true };
  } catch {
    return EMPTY_HINTS_RECORD;
  }
}

export function serializeHintsRecord(record: HintsRecord): string {
  return JSON.stringify({ dismissed: HINT_ORDER.filter((id) => record.dismissed.includes(id)), agentSeen: record.agentSeen });
}

export function withDismissed(record: HintsRecord, id: HintId): HintsRecord {
  return record.dismissed.includes(id) ? record : { ...record, dismissed: [...record.dismissed, id] };
}

export function readHintsRecord(storage: Pick<Storage, "getItem"> | null | undefined): HintsRecord {
  try {
    return parseHintsRecord(storage?.getItem(HINTS_STORAGE_KEY));
  } catch {
    return EMPTY_HINTS_RECORD;
  }
}

export function writeHintsRecord(storage: Pick<Storage, "setItem"> | null | undefined, record: HintsRecord): void {
  try {
    storage?.setItem(HINTS_STORAGE_KEY, serializeHintsRecord(record));
  } catch {
    // Storage unavailable (private mode, quota): the hint still goes away for this page.
  }
}
