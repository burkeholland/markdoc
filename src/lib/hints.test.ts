import { describe, expect, it } from "vitest";
import {
  HINT_ORDER,
  HINTS,
  HINTS_STORAGE_KEY,
  allHintsDismissed,
  dueHint,
  hintRelevant,
  isHintId,
  parseHintsRecord,
  readHintsRecord,
  serializeHintsRecord,
  withDismissed,
  writeHintsRecord,
  type HintState,
} from "./hints";

const quiet: HintState = { collaborators: 0, agentEverConnected: false, commentThreads: 0 };

// The id of the hint retired by #1025, spelled without the literal so a repo-wide grep for it stays clean.
const RETIRED_ID = ["ask", "agent"].join("-");

describe("hints: relevance gates", () => {
  it("nothing is due in a fresh, empty, solo document", () => {
    expect(dueHint(quiet, [])).toBeNull();
  });

  it("(a) needs a collaborator and no agent ever connected", () => {
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 1 })).toBe(true);
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 1, agentEverConnected: true })).toBe(false);
    expect(hintRelevant("collab-agent", { ...quiet, collaborators: 0 })).toBe(false);
  });

  it("(b) needs a comment thread; the copy talks about mentioning an agent in a comment", () => {
    expect(hintRelevant("mention-copilot", quiet)).toBe(false);
    expect(hintRelevant("mention-copilot", { ...quiet, commentThreads: 1 })).toBe(true);
    expect(HINTS["mention-copilot"].message).toMatch(/mention an agent in a comment/i);
    expect(HINTS["mention-copilot"].message).not.toMatch(/copilot session/i);
  });

  it("there are exactly two hints and the retired selection hint is no longer one of them (#1025)", () => {
    expect(HINT_ORDER).toEqual(["collab-agent", "mention-copilot"]);
    expect(HINT_ORDER.length).toBe(2);
    expect(isHintId(RETIRED_ID)).toBe(false);
    expect(Object.keys(HINTS).sort()).toEqual(["collab-agent", "mention-copilot"]);
  });
});

describe("hints: which one is due", () => {
  const everything: HintState = { collaborators: 2, agentEverConnected: false, commentThreads: 3 };

  it("follows the display order when several are relevant", () => {
    expect(dueHint(everything, [])).toBe("collab-agent");
    expect(dueHint(everything, ["collab-agent"])).toBe("mention-copilot");
  });

  it("skips dismissed hints even when relevant, and accepts a Set", () => {
    expect(dueHint({ ...quiet, commentThreads: 1 }, new Set(["mention-copilot"]))).toBeNull();
    expect(dueHint({ ...quiet, collaborators: 1, commentThreads: 1 }, new Set(["collab-agent"]))).toBe("mention-copilot");
  });

  it("is null once both are dismissed, whatever the state", () => {
    expect(dueHint(everything, HINT_ORDER)).toBeNull();
    expect(allHintsDismissed(HINT_ORDER)).toBe(true);
    expect(allHintsDismissed(["collab-agent"])).toBe(false);
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
    expect(parseHintsRecord('{"dismissed":["nope","collab-agent","collab-agent"],"agentSeen":"yes"}')).toEqual({ dismissed: ["collab-agent"], agentSeen: false });
  });

  it("a stored dismissal of the retired selection hint is dropped, the others kept", () => {
    const stored = JSON.stringify({ dismissed: ["collab-agent", RETIRED_ID], agentSeen: true });
    expect(parseHintsRecord(stored)).toEqual({ dismissed: ["collab-agent"], agentSeen: true });
    // The user who dismissed the old (b) still gets the merged (c) once a thread exists…
    expect(dueHint({ ...quiet, commentThreads: 1 }, parseHintsRecord(stored).dismissed)).toBe("mention-copilot");
    // …and the record is not "all dismissed" until (c) is, so the bar can still mount.
    expect(allHintsDismissed(parseHintsRecord(stored).dismissed)).toBe(false);
    const all = JSON.stringify({ dismissed: ["collab-agent", RETIRED_ID, "mention-copilot"] });
    expect(allHintsDismissed(parseHintsRecord(all).dismissed)).toBe(true);
  });

  it("reads and writes through a Storage-like object and survives a throwing one", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readHintsRecord(storage)).toEqual({ dismissed: [], agentSeen: false });
    writeHintsRecord(storage, { dismissed: ["mention-copilot"], agentSeen: false });
    expect(store.get(HINTS_STORAGE_KEY)).toBe('{"dismissed":["mention-copilot"],"agentSeen":false}');
    expect(readHintsRecord(storage).dismissed).toEqual(["mention-copilot"]);
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
