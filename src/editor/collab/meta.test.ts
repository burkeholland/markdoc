import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getGoal, setGoal, GOAL_KEY } from "./meta";

function holder() {
  const ydoc = new Y.Doc();
  return { ydoc, meta: ydoc.getMap<unknown>("meta") };
}

describe("shared writing goal", () => {
  it("round-trips through the meta map and clears", () => {
    const h = holder();
    expect(getGoal(h)).toBeNull();
    setGoal(h, { kind: "words", mode: "min", value: 500, setBy: "alice", setAt: 1700000000000 });
    expect(getGoal(h)).toEqual({ kind: "words", mode: "min", value: 500, setBy: "alice", setAt: 1700000000000 });
    setGoal(h, null);
    expect(getGoal(h)).toBeNull();
    expect(h.meta.has(GOAL_KEY)).toBe(false);
  });

  it("ignores malformed values", () => {
    const h = holder();
    h.meta.set(GOAL_KEY, { kind: "pages", mode: "min", value: 3 });
    expect(getGoal(h)).toBeNull();
    h.meta.set(GOAL_KEY, { kind: "words", mode: "min", value: -3 });
    expect(getGoal(h)).toBeNull();
    h.meta.set(GOAL_KEY, "nope");
    expect(getGoal(h)).toBeNull();
  });

  it("reaches a second document after applying the update", () => {
    const a = holder();
    const b = holder();
    setGoal(a, { kind: "minutes", mode: "max", value: 4, setBy: null, setAt: 1 });
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(getGoal(b)).toEqual({ kind: "minutes", mode: "max", value: 4, setBy: null, setAt: 1 });
    setGoal(a, null);
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    expect(getGoal(b)).toBeNull();
  });
});
