import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cleanTextWith, cleanToRawOffset, rawToCleanOffset, resolveCleanRange, SuggestionsModel, SUGGESTIONS_ORIGIN } from "./suggestions";
import { makeCollabUser } from "./shared";

// "AB[xx]CD[yy]EF": two pending insertions in the full text; the clean text is "ABCDEF".
const RAW = "ABxxCDyyEF";
const INSERTS = [
  { type: "insert" as const, from: 2, to: 4 },
  { type: "insert" as const, from: 6, to: 8 },
];

describe("clean ↔ raw offsets", () => {
  it("is the identity without pending suggestions", () => {
    for (const n of [0, 3, 10]) {
      expect(cleanToRawOffset(n, [])).toBe(n);
      expect(rawToCleanOffset(n, [])).toBe(n);
    }
    expect(cleanToRawOffset(-4, [])).toBe(0);
  });

  it("skips pending insertions, staying before one that merely touches the offset", () => {
    expect(cleanTextWith(RAW, INSERTS.map((s) => ({ ...s, id: "", anchor: { start: {}, end: {} }, authorId: "", authorName: "", createdAt: 0, text: "" })))).toBe("ABCDEF");
    expect(cleanToRawOffset(0, INSERTS)).toBe(0);
    expect(cleanToRawOffset(2, INSERTS)).toBe(2); // before "xx", not after
    expect(cleanToRawOffset(3, INSERTS)).toBe(5); // "D"
    expect(cleanToRawOffset(4, INSERTS)).toBe(6); // before "yy"
    expect(cleanToRawOffset(5, INSERTS)).toBe(9); // "F"
    expect(cleanToRawOffset(6, INSERTS)).toBe(10); // end
    // Deletions are still in the clean text and do not shift anything.
    expect(cleanToRawOffset(3, [{ type: "delete", from: 0, to: 2 }])).toBe(3);
  });

  it("maps raw offsets back, collapsing an insertion onto its start", () => {
    expect(rawToCleanOffset(2, INSERTS)).toBe(2);
    expect(rawToCleanOffset(3, INSERTS)).toBe(2);
    expect(rawToCleanOffset(4, INSERTS)).toBe(2);
    expect(rawToCleanOffset(5, INSERTS)).toBe(3);
    expect(rawToCleanOffset(9, INSERTS)).toBe(5);
    expect(rawToCleanOffset(10, INSERTS)).toBe(6);
    for (let c = 0; c <= 6; c++) expect(rawToCleanOffset(cleanToRawOffset(c, INSERTS), INSERTS)).toBe(c);
  });

  it("tolerates overlapping insertion records", () => {
    const overlapping = [
      { type: "insert" as const, from: 2, to: 4 },
      { type: "insert" as const, from: 3, to: 4 },
    ];
    expect(cleanToRawOffset(3, overlapping)).toBe(5);
    expect(rawToCleanOffset(5, overlapping)).toBe(3);
  });
});

describe("resolveCleanRange", () => {
  const clean = "ABCDEF";
  it("clamps offsets to the clean text and maps both ends", () => {
    expect(resolveCleanRange(clean, INSERTS, { from: 3, to: 5 })).toEqual({ clean: { from: 3, to: 5 }, raw: { from: 5, to: 9 } });
    expect(resolveCleanRange(clean, INSERTS, { from: 4, to: 2 })).toEqual({ clean: { from: 4, to: 4 }, raw: { from: 6, to: 6 } });
    expect(resolveCleanRange(clean, [], { from: 100, to: 200 })).toEqual({ clean: { from: 6, to: 6 }, raw: { from: 6, to: 6 } });
  });

  it("resolves an anchor to its first occurrence in the clean text, null when absent", () => {
    expect(resolveCleanRange(clean, INSERTS, { anchor: "DE" })).toEqual({ clean: { from: 3, to: 5 }, raw: { from: 5, to: 9 } });
    expect(resolveCleanRange("ab ab", [], { anchor: "ab" })).toEqual({ clean: { from: 0, to: 2 }, raw: { from: 0, to: 2 } });
    expect(resolveCleanRange(clean, INSERTS, { anchor: "xx" })).toBeNull(); // pending text is not in the clean text
    expect(resolveCleanRange(clean, INSERTS, { anchor: "" })).toBeNull();
  });

  it("agrees with a real SuggestionsModel", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "Hello world");
    const model = new SuggestionsModel(doc, ytext);
    const bot = makeCollabUser("agent:u:Bot", "Bot");
    doc.transact(() => {
      ytext.insert(5, " brave");
      model.recordInserted(5, 6, bot);
    }, SUGGESTIONS_ORIGIN);
    expect(ytext.toString()).toBe("Hello brave world");
    const list = model.list();
    const cleanText = cleanTextWith(ytext.toString(), list);
    expect(cleanText).toBe("Hello world");
    const r = resolveCleanRange(cleanText, list, { anchor: "world" });
    expect(r).toEqual({ clean: { from: 6, to: 11 }, raw: { from: 12, to: 17 } });
    expect(ytext.toString().slice(r!.raw.from, r!.raw.to)).toBe("world");
    model.destroy();
  });
});
