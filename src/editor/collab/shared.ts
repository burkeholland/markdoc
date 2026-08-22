import * as Y from "yjs";

export interface CollabUser {
  id: string;
  name: string;
  color: string;
  colorLight: string;
  avatar?: string | null;
}

/** Palette tuned for legibility on white (Google Docs-like). */
export const USER_COLORS = [
  "#2563eb",
  "#db2777",
  "#16a34a",
  "#ea580c",
  "#7c3aed",
  "#0891b2",
  "#ca8a04",
  "#dc2626",
  "#4f46e5",
  "#059669",
];

export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function colorForUser(id: string): { color: string; colorLight: string } {
  const color = USER_COLORS[hashString(id) % USER_COLORS.length];
  return { color, colorLight: color + "33" };
}

export function makeCollabUser(id: string, name: string, avatar?: string | null): CollabUser {
  return { id, name, avatar: avatar ?? null, ...colorForUser(id) };
}

export type RelativePositionJSON = ReturnType<typeof Y.relativePositionToJSON>;

/** Serializable anchor for a range of the Markdown text that survives concurrent edits. */
export interface TextAnchor {
  start: RelativePositionJSON;
  end: RelativePositionJSON;
}

export function createAnchor(ytext: Y.Text, from: number, to: number): TextAnchor {
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, to, -1)),
  };
}

export function resolveAnchor(ytext: Y.Text, anchor: TextAnchor): { from: number; to: number } | null {
  const doc = ytext.doc;
  if (!doc) return null;
  const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), doc);
  const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), doc);
  if (!start || !end || start.type !== ytext || end.type !== ytext) return null;
  const from = Math.min(start.index, end.index);
  const to = Math.max(start.index, end.index);
  return { from, to };
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
