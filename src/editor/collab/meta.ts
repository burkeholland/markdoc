import type * as Y from "yjs";
import type { WritingGoal } from "../stats";

/** The subset of a collaboration session the meta helpers need (also satisfied by a bare Y.Doc wrapper). */
export interface MetaHolder {
  ydoc: Y.Doc;
  meta: Y.Map<unknown>;
}

export const GOAL_KEY = "goal";

/** Origin for writes to the shared meta map made by these helpers (not tracked by undo). */
export const META_ORIGIN = { name: "meta" };

function isGoal(v: unknown): v is WritingGoal {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  return (
    (g.kind === "words" || g.kind === "minutes") &&
    (g.mode === "min" || g.mode === "max") &&
    typeof g.value === "number" &&
    Number.isFinite(g.value) &&
    g.value > 0
  );
}

/** The document's shared writing goal, or null when none is set (or the stored value is malformed). */
export function getGoal(holder: MetaHolder): WritingGoal | null {
  const v = holder.meta.get(GOAL_KEY);
  if (!isGoal(v)) return null;
  return {
    kind: v.kind,
    mode: v.mode,
    value: Math.round(v.value),
    setBy: typeof v.setBy === "string" ? v.setBy : null,
    setAt: typeof v.setAt === "number" ? v.setAt : 0,
  };
}

/** Set or clear (null) the shared writing goal; every connected client sees it live. */
export function setGoal(holder: MetaHolder, goal: WritingGoal | null): void {
  holder.ydoc.transact(() => {
    if (goal) holder.meta.set(GOAL_KEY, { ...goal });
    else holder.meta.delete(GOAL_KEY);
  }, META_ORIGIN);
}
