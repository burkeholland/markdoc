import { describe, expect, it } from "vitest";
import {
  HINT_ORDER,
  HINT_SELECTION_MIN,
  HINTS,
  HINTS_STORAGE_KEY,
  allHintsDismissed,
  dueHint,
  hintRelevant,
  parseHintsRecord,
  readHintsRecord,
  serializeHintsRecord,
  withDismissed,
  writeHintsRecord,
  type HintState,
} from "./hints";

const quiet: HintState = { collaborators: 0, agentEverConnected: false, selectionLength: 0, commentThreads: 0 };

describe("hints: relevance gates", () => {
  it("nothing is due in a fresh, empty, solo document", () => {
    expect(dueHint(quiet, [])).toBeNull();
  });

  it("(a) needs a collaborator and no agent ever connected", () => {
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 1 })).toBe(true);
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 1, agentEverConnected: true })).toBe(false);
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 0 })).toBe(false);
  });

  it(`(b) needs a selection of at least ${HINT_SELECTION_MIN} characters`, () => {
    expect(hintRelevant("ask-agent", { ...quiet, selectionLength: HINT_SELECTION_MIN - 1 })).toBe(false);
    expect(hintRelevant("ask-agent", { ...quiet, selectionLength: HINT_SELECTION_MIN })).toBe(true);
    expect(hintRelevant("ask-agent", { ...quiet, selectionLength: 500 })).toBe(true);
  });

  it("(c) needs a comment thread", () => {
    expect(hintRelevant("mention-copilot", quiet)).toBe(false);
    expect(hintRelevant("mention-copilot", { ...quiet, commentThreads: 1 })).toBe(true);
  });
});

describe("hints: which one is due", () => {
  const everything: HintState = { collaborators: 2, agentEverConnected: false, selectionLength: 40, commentThreads: 3 };

  it("follows the display order when several are relevant", () => {
    expect(dueHint(everything, [])).toBe("collab-agent");
    expect(dueHint(everything, ["collab-agent"])).toBe("ask-agent");
    expect(dueHint(everything, ["collab-agent", "ask-agent"])).toBe("mention-copilot");
  });

  it("skips dismissed hints even when relevant, and accepts a Set", () => {
    expect(dueHint({ ...quiet, selectionLength: 30 }, new Set(["ask-agent"]))).toBeNull();
    expect(dueHint({ ...quiet, selectionLength: 30, commentThreads: 1 }, new Set(["ask-agent"]))).toBe("mention-copilot");
  });

  it("is null once all three are dismissed, whatever the state", () => {
    expect(dueHint(everything, HINT_ORDER)).toBeNull();
    expect(allHintsDismissed(HINT_ORDER)).toBe(true);
    expect(allHintsDismissed(["collab-agent", "ask-agent"])).toBe(false);
    expect(allHintsDismissed([])).toBe(false);
  });

  it("every hint has copy and an action label", () => {
    for (const id of HINT_ORDER) {
      expect(HINTS[id].message.length).toBeGreaterThan(10);
      expect(HINTS[id].action.length).toBeGreaterThan(2);
    }
  });
});

describe("hints: storage record", () => {
  it("parses what it serializes, in display order, without duplicates", () => {
    const rec = withDismissed(withDismissed({ dismissed: ["mention-copilot"], agentSeen: true }, "collab-agent"), "collab-agent");
    const raw = serializeHintsRecord(rec);
    expect(JSON.parse(raw)).toEqual({ dismissed: ["collab-agent", "mention-copilot"], agentSeen: true });
    expect(parseHintsRecord(raw)).toEqual({ dismissed: ["collab-agent", "mention-copilot"], agentSeen: true });
  });

  it("tolerates garbage, unknown ids and missing fields", () => {
    expect(parseHintsRecord(null)).toEqual({ dismissed: [], agentSeen: false });
    expect(parseHintsRecord("")).toEqual({ dismissed: [], agentSeen: false });
    expect(parseHintsRecord("{not json")).toEqual({ dismissed: [], agentSeen: false });
    expect(parseHintsRecord("[]")).toEqual({ dismissed: [], agentSeen: false });
    expect(parseHintsRecord('{"dismissed":["nope","ask-agent","ask-agent"],"agentSeen":"yes"}')).toEqual({ dismissed: ["ask-agent"], agentSeen: false });
  });

  it("reads and writes through a Storage-like object and survives a throwing one", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readHintsRecord(storage)).toEqual({ dismissed: [], agentSeen: false });
    writeHintsRecord(storage, { dismissed: ["ask-agent"], agentSeen: false });
    expect(store.get(HINTS_STORAGE_KEY)).toBe('{"dismissed":["ask-agent"],"agentSeen":false}');
    expect(readHintsRecord(storage).dismissed).toEqual(["ask-agent"]);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readHintsRecord(broken)).toEqual({ dismissed: [], agentSeen: false });
    expect(() => writeHintsRecord(broken, { dismissed: [], agentSeen: true })).not.toThrow();
    expect(readHintsRecord(null)).toEqual({ dismissed: [], agentSeen: false });
  });
});
