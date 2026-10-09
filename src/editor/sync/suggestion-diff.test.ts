import { describe, expect, it } from "vitest";
import { diffSuggestionEdits, targetedSuggestionEdits, SuggestionPlanError } from "./suggestion-diff";
import type { EditInput } from "../collab/suggestions";
import { LONG_PASSAGE_PREFIX, LONG_PASSAGE_SUFFIX, REWRITE_AFTER, REWRITE_BEFORE, REWRITE_DOCUMENT, REWRITE_PREFIX, REWRITE_RESULT, UNPLANNABLE_PASSAGES } from "../collab/rewrite.test-fixture";

function apply(text: string, edits: EditInput[]): string {
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return text;
}

describe("agent suggestion granularity", () => {
  it("makes a shared-word paragraph rewrite one passage, not word islands", () => {
    const expected = [{ from: REWRITE_PREFIX.length, to: REWRITE_PREFIX.length + REWRITE_BEFORE.length, insert: REWRITE_AFTER }];
    expect(diffSuggestionEdits(REWRITE_DOCUMENT, REWRITE_RESULT)).toEqual(expected);
    expect(targetedSuggestionEdits(REWRITE_DOCUMENT, [{ find: REWRITE_BEFORE, replace: REWRITE_AFTER }])).toEqual(expected);
  });

  it("does not merge distant passages or independent targets in one paragraph", () => {
    const before = REWRITE_DOCUMENT + "\nAn untouched bridge.\n\n" + REWRITE_BEFORE;
    const after = REWRITE_RESULT + "\nAn untouched bridge.\n\n" + REWRITE_AFTER;
    const edits = diffSuggestionEdits(before, after);
    expect(edits).toHaveLength(2);
    expect(apply(before, edits)).toBe(after);
    const targeted = targetedSuggestionEdits("red blue yellow", [{ find: "red", replace: "pink" }, { find: "blue", replace: "green" }]);
    expect(targeted).toHaveLength(2);
    expect(apply("red blue yellow", targeted)).toBe("pink green yellow");
  });

  it.each([
    ["A smal typo.", "A small typo."],
    ["A quiet path.", "A very quiet path."],
    ["A very quiet path.", "A quiet path."],
    ["Repeated the the words.", "Repeated the words."],
    ["Caf\u00e9 \ud83c\udf31 grows.", "Caf\u00e9 \ud83c\udf33 grows."],
    ["e\u0301 grows.", "\u00e9 grows."],
    ["# Heading\n\n- one\n- two\n", "# Heading\n\n- revised one\n- revised two\n"],
    ["Before\n\n```ts\nconst x = 1;\nreturn x;\n```\n\nAfter\n", "Before\n\n```ts\nconst result = 2;\nreturn result;\n```\n\nAfter\n"],
    ["# H\r\n\r\nA bold **word** and `code`.\r\n", "# H\r\n\r\nA bright **phrase** and `sample`.\r\n"],
    ["before", ""],
    ["", "after"],
    ["same", "same"],
  ])("preserves exact Markdown and Unicode for %j -> %j", (before, after) => {
    expect(apply(before, diffSuggestionEdits(before, after))).toBe(after);
  });

  it("keeps small edits small", () => {
    expect(diffSuggestionEdits("A smal typo.", "A small typo.")).toEqual([{ from: 2, to: 6, insert: "small" }]);
    expect(diffSuggestionEdits("A quiet path.", "A very quiet path.")).toEqual([{ from: 2, to: 2, insert: "very " }]);
    expect(diffSuggestionEdits("A very quiet path.", "A quiet path.")).toEqual([{ from: 2, to: 7, insert: "" }]);
  });

  it("retains a single targeted passage identity even for two small separated changes", () => {
    const before = "The red shed stands beside the old bridge.";
    const after = "The blue shed stands beside the new bridge.";
    expect(diffSuggestionEdits(before, after)).toHaveLength(2);
    const edits = targetedSuggestionEdits(before, [{ find: before, replace: after }]);
    expect(edits).toEqual([{ from: 4, to: before.indexOf(" bridge"), insert: "blue shed stands beside the new" }]);
    expect(apply(before, edits)).toBe(after);
    const insertions = targetedSuggestionEdits("A shed and a bridge.", [{ find: "A shed and a bridge.", replace: "A blue shed and a new bridge." }]);
    expect(insertions).toHaveLength(1);
    expect(apply("A shed and a bridge.", insertions)).toBe("A blue shed and a new bridge.");
  });

  it("preserves find boundaries, all matches, later offsets, and literal replacement syntax", () => {
    const before = "alpha between alpha\n\nlast";
    const edits = targetedSuggestionEdits(before, [{ find: "alpha", replace: "$& $` $'", all: true }, { find: "last", replace: "ending" }]);
    expect(apply(before, edits)).toBe("$& $` $' between $& $` $'\n\nending");
    expect(edits).toHaveLength(3);
    expect(() => targetedSuggestionEdits(before, [{ find: "alpha", replace: "beta" }])).toThrow("occurs 2 times");
    expect(() => targetedSuggestionEdits(before, [{ find: "missing", replace: "beta" }])).toThrow("Text not found");
    expect(() => targetedSuggestionEdits("alpha", [{ find: "alpha", replace: "beta" }, { find: "beta", replace: "gamma" }])).toThrow("Overlapping replacements");
    expect(() => targetedSuggestionEdits("alpha", [{ find: "", replace: "beta" }])).toThrow("must not be empty");
  });

  it("preserves exact text through mixed block, line-ending and Unicode edits", () => {
    let seed = 2766;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const tokens = ["a", " repeated ", "\n", "\r\n", "\n\n", "**bold**", "- item", "`code`", "\ud83c\udf31", "e\u0301"];
    for (let sample = 0; sample < 200; sample++) {
      const before = Array.from({ length: 20 }, () => tokens[random(tokens.length)]).join("");
      const pieces = Array.from(before);
      pieces.splice(random(pieces.length + 1), random(4), ...Array.from(tokens[random(tokens.length)]));
      const after = pieces.join("");
      const edits = diffSuggestionEdits(before, after);
      expect(apply(before, edits), `sample ${sample}`).toBe(after);
      expect(edits.every((edit, index) => index === 0 || edits[index - 1].to <= edit.from)).toBe(true);
    }
  });

  it("bounds large-document work without swallowing surrounding paragraphs", () => {
    const before = "Untouched paragraph.\n\n".repeat(20_000) + REWRITE_BEFORE + "\n\nTail.";
    const after = "Untouched paragraph.\n\n".repeat(20_000) + REWRITE_AFTER + "\n\nTail.";
    const edits = diffSuggestionEdits(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0].to - edits[0].from).toBe(REWRITE_BEFORE.length);
    expect(apply(before, edits)).toBe(after);
  });

  it.each([
    ["x", "y"],
    ["old", "new"],
    ["", "x"],
    ["x", ""],
    ["s", "ll"],
    ["\ud83c\udf31", "\ud83c\udf33"],
    ["\ud800\udc00", "\ud801\udc00"],
    ["e\u0301", "\u00e9"],
  ])("keeps oversized single-line %j -> %j changes narrow and Unicode-safe", (oldMiddle, newMiddle) => {
    const before = LONG_PASSAGE_PREFIX + oldMiddle + LONG_PASSAGE_SUFFIX;
    const after = LONG_PASSAGE_PREFIX + newMiddle + LONG_PASSAGE_SUFFIX;
    const expected = [{ from: LONG_PASSAGE_PREFIX.length, to: LONG_PASSAGE_PREFIX.length + oldMiddle.length, insert: newMiddle }];
    const edits = diffSuggestionEdits(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0].to - edits[0].from).toBe(oldMiddle.length);
    expect(edits).toEqual(expected);
    expect(apply(before, edits)).toBe(after);
    const offset = REWRITE_PREFIX.length;
    const targeted = targetedSuggestionEdits(REWRITE_PREFIX + before, [{ find: before, replace: after }]);
    expect(targeted).toEqual(expected.map((edit) => ({ ...edit, from: edit.from + offset, to: edit.to + offset })));
    expect(diffSuggestionEdits(before, after, offset)).toEqual(targeted);
  });

  it.each([
    ["start", "", LONG_PASSAGE_SUFFIX.repeat(2)],
    ["end", LONG_PASSAGE_PREFIX.repeat(2), ""],
  ])("keeps oversized passage edits at the %s narrow", (_position, prefix, suffix) => {
    for (const [oldMiddle, newMiddle] of [["", "x"], ["x", ""], ["old", "new"]]) {
      const before = prefix + oldMiddle + suffix;
      const after = prefix + newMiddle + suffix;
      const edits = diffSuggestionEdits(before, after);
      expect(edits).toHaveLength(1);
      expect(edits[0].to - edits[0].from).toBe(oldMiddle.length);
      expect(edits).toEqual([{ from: prefix.length, to: prefix.length + oldMiddle.length, insert: newMiddle }]);
      expect(apply(before, edits)).toBe(after);
    }
  });

  it("retains independent edits and explicit target identity after narrowing an oversized passage", () => {
    const before = LONG_PASSAGE_PREFIX + "red shed beside the old bridge" + LONG_PASSAGE_SUFFIX;
    const after = LONG_PASSAGE_PREFIX + "blue shed beside the new bridge" + LONG_PASSAGE_SUFFIX;
    const edits = diffSuggestionEdits(before, after);
    expect(edits).toHaveLength(2);
    expect(edits.every((edit) => edit.to - edit.from === 3)).toBe(true);
    expect(apply(before, edits)).toBe(after);
    const targeted = targetedSuggestionEdits(before, [{ find: before, replace: after }]);
    expect(targeted).toHaveLength(1);
    expect(targeted[0].to - targeted[0].from).toBe("red shed beside the old".length);
    expect(apply(before, targeted)).toBe(after);
  });

  it("keeps a substantive rewrite coherent inside an oversized passage", () => {
    const before = LONG_PASSAGE_PREFIX + REWRITE_BEFORE + LONG_PASSAGE_SUFFIX;
    const after = LONG_PASSAGE_PREFIX + REWRITE_AFTER + LONG_PASSAGE_SUFFIX;
    const edits = diffSuggestionEdits(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0].from).toBe(LONG_PASSAGE_PREFIX.length);
    expect(edits[0].to).toBeLessThanOrEqual(before.length - LONG_PASSAGE_SUFFIX.length);
    expect(apply(before, edits)).toBe(after);
  });

  it.each(UNPLANNABLE_PASSAGES)("refuses $reason instead of broadening a replacement", ({ before, after }) => {
    for (const plan of [
      () => diffSuggestionEdits(before, after),
      () => targetedSuggestionEdits(before, [{ find: before, replace: after }]),
    ]) {
      expect(plan).toThrow(SuggestionPlanError);
      expect(plan).toThrow(expect.objectContaining({ status: 422, message: expect.stringContaining("too large to group safely") }));
    }
  });
});

/** The text while the edits are pending: each new text sits right before the text it replaces. */
function pending(text: string, edits: EditInput[]): string {
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.from);
  return text;
}

/** Cells per line, for the lines of each table in `text` (blank-line separated blocks whose second line is a delimiter row). */
function tableShapes(text: string): number[][] {
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((line) => line.trim()))
    .filter((rows) => rows.length > 1 && /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(rows[1].trim()) && rows[1].includes("|"))
    .map((rows) => rows.map((row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length));
}

describe("agent suggestions in a table", () => {
  const TABLE = "| Name | Owner | Status |\n| --- | --- | --- |\n| Alpha | Ann | Open |\n| Beta | Bob | Open |\n| Gamma | Cy | Blocked |";
  const DOC = `# Plan\n\n${TABLE}\n\nAfter.\n`;

  it("puts a rewritten row above the row it replaces, never on its line", () => {
    const edits = targetedSuggestionEdits(DOC, [{ find: "| Beta | Bob | Open |", replace: "| Beta program | Robert | Closed last week |" }]);
    expect(edits).toHaveLength(1);
    expect(pending(DOC, edits)).toBe(DOC.replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed last week |\n| Beta | Bob | Open |"));
    expect(apply(DOC, edits)).toBe(DOC.replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed last week |"));
    expect(tableShapes(pending(DOC, edits))).toEqual([[3, 3, 3, 3, 3, 3]]);
  });

  it("keeps a rewrite of several rows one suggestion: the new rows, then the old rows", () => {
    const after = DOC.replace("| Alpha | Ann | Open |", "| Alpha release | Annabel Lee | Done and shipped |")
      .replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed last week |")
      .replace("| Gamma | Cy | Blocked |", "| Gamma rays | Cyrus | Unblocked today |");
    const edits = diffSuggestionEdits(DOC, after);
    expect(edits).toHaveLength(1);
    expect(apply(DOC, edits)).toBe(after);
    expect(tableShapes(pending(DOC, edits))).toEqual([[3, 3, 3, 3, 3, 3, 3, 3]]);
    expect(pending(DOC, edits)).toContain("| Gamma rays | Cyrus | Unblocked today |\n| Alpha | Ann | Open |");
  });

  it("widens a change that crosses cells of one row to that row", () => {
    const edits = targetedSuggestionEdits(DOC, [{ find: "Bob | Open", replace: "Robert | Closed" }]);
    expect(edits).toHaveLength(1);
    expect(pending(DOC, edits)).toContain("| Beta | Robert | Closed |\n| Beta | Bob | Open |\n| Gamma");
    expect(apply(DOC, edits)).toBe(DOC.replace("Bob | Open", "Robert | Closed"));
  });

  it("leaves an edit inside one cell as small as it was", () => {
    const at = DOC.indexOf("Bob");
    expect(targetedSuggestionEdits(DOC, [{ find: "Bob", replace: "Robert" }])).toEqual([{ from: at, to: at + 3, insert: "Robert" }]);
    expect(diffSuggestionEdits(DOC, DOC.replace("Bob", "Robert"))).toEqual([{ from: at, to: at + 3, insert: "Robert" }]);
    const escaped = DOC.replace("Bob", "a \\| b");
    expect(diffSuggestionEdits(escaped, escaped.replace("a \\| b", "c \\| d")).every((edit) => edit.to - edit.from <= 1)).toBe(true);
  });

  it("makes two targets on one row one suggestion, not a conflict", () => {
    const edits = targetedSuggestionEdits(DOC, [{ find: "| Beta | Bob", replace: "| Beta program | Robert" }, { find: "Open |\n| Gamma", replace: "Closed |\n| Gamma" }]);
    expect(edits).toHaveLength(1);
    expect(apply(DOC, edits)).toBe(DOC.replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed |"));
    expect(tableShapes(pending(DOC, edits))).toEqual([[3, 3, 3, 3, 3, 3]]);
  });

  it("shows a table with a new header or other columns as its own table, above the old one", () => {
    const wider = "| Name | Owner | Status | Due |\n| --- | --- | --- | --- |\n| Alpha | Ann | Open | Mon |\n| Beta | Bob | Open | Tue |\n| Gamma | Cy | Blocked | Wed |";
    const renamed = TABLE.replace("| Name | Owner | Status |", "| Project | Lead | State |");
    for (const [replacement, shape] of [[wider, [4, 4, 4, 4, 4]], [renamed, [3, 3, 3, 3, 3]], [TABLE.replace("| --- | --- | --- |", "| :-: | --- | --: |"), [3, 3, 3, 3, 3]]] as const) {
      const edits = targetedSuggestionEdits(DOC, [{ find: TABLE, replace: replacement }]);
      expect(edits).toHaveLength(1);
      expect(pending(DOC, edits)).toBe(`# Plan\n\n${replacement}\n\n${TABLE}\n\nAfter.\n`);
      expect(apply(DOC, edits)).toBe(DOC.replace(TABLE, replacement));
      expect(tableShapes(pending(DOC, edits))).toEqual([shape, [3, 3, 3, 3, 3]]);
    }
  });

  it("keeps a table and the text it replaces (or that replaces it) as separate blocks", () => {
    const prose = "Alpha is Ann's, Beta is Bob's and Gamma is blocked on Cy.";
    const listed = `# Plan\n\n${prose}\n\nAfter.\n`;
    const toTable = diffSuggestionEdits(listed, DOC);
    expect(pending(listed, toTable)).toBe(`# Plan\n\n${TABLE}\n\n${prose}\n\nAfter.\n`);
    expect(apply(listed, toTable)).toBe(DOC);
    const toProse = diffSuggestionEdits(DOC, listed);
    expect(pending(DOC, toProse)).toBe(`# Plan\n\n${prose}\n\n${TABLE}\n\nAfter.\n`);
    expect(apply(DOC, toProse)).toBe(listed);
  });

  it("uses the blank line after a table that starts the document, and a table alone keeps its text exact", () => {
    const first = `${TABLE}\n\nAfter.\n`;
    const renamed = TABLE.replace("| Name | Owner | Status |", "| Project | Lead | State |");
    const edits = targetedSuggestionEdits(first, [{ find: TABLE, replace: renamed }]);
    expect(pending(first, edits)).toBe(`${renamed}\n\n${TABLE}\n\nAfter.\n`);
    expect(apply(first, edits)).toBe(`${renamed}\n\nAfter.\n`);
    for (const alone of [TABLE, `${TABLE}\n`]) {
      const only = targetedSuggestionEdits(alone, [{ find: TABLE, replace: renamed }]);
      expect(apply(alone, only)).toBe(alone.replace(TABLE, renamed));
    }
  });

  it("keeps rows whole with CRLF line endings and in the last row of the document", () => {
    const crlf = DOC.replace(/\n/g, "\r\n");
    const edits = targetedSuggestionEdits(crlf, [{ find: "| Beta | Bob | Open |", replace: "| Beta program | Robert | Closed |" }]);
    expect(pending(crlf, edits)).toBe(crlf.replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed |\r\n| Beta | Bob | Open |"));
    expect(apply(crlf, edits)).toBe(crlf.replace("| Beta | Bob | Open |", "| Beta program | Robert | Closed |"));
    const last = targetedSuggestionEdits(TABLE, [{ find: "| Gamma | Cy | Blocked |", replace: "| Gamma rays | Cyrus | Done |" }]);
    expect(pending(TABLE, last)).toBe(TABLE.replace("| Gamma | Cy | Blocked |", "| Gamma rays | Cyrus | Done |\n| Gamma | Cy | Blocked |"));
    expect(apply(TABLE, last)).toBe(TABLE.replace("| Gamma | Cy | Blocked |", "| Gamma rays | Cyrus | Done |"));
  });

  it("gives the exact text for random cell, row and column changes, with edits that do not overlap", () => {
    let seed = 2317;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const words = ["Alpha", "Bob", "Open", "x", "", "two words", "a \\| b", "Blocked"];
    const row = (cells: number) => `| ${Array.from({ length: cells }, () => words[random(words.length)]).join(" | ")} |`;
    const table = (rows: number, cells: number) => [row(cells), `| ${Array.from({ length: cells }, () => "---").join(" | ")} |`, ...Array.from({ length: rows }, () => row(cells))];
    for (let sample = 0; sample < 300; sample++) {
      const lines = table(1 + random(4), 2 + random(3));
      const changed = [...lines];
      for (let change = 1 + random(3); change > 0; change--) {
        const at = random(changed.length);
        if (random(5) === 0) changed.splice(at, random(2), row(2 + random(3)));
        else if (at !== 1) changed[at] = row(changed[at].split(" | ").length);
      }
      // Half of the samples have the table as the first block of the document.
      const skip = random(2) ? 0 : "Intro.\n\n".length;
      const wrap = (rows: string[]) => ["Intro.", "", ...rows, "", "Outro."].join("\n").slice(skip);
      const before = wrap(lines);
      const after = wrap(changed);
      for (const edits of [diffSuggestionEdits(before, after), before.includes(lines.join("\n")) && lines.join("\n") !== changed.join("\n") ? targetedSuggestionEdits(before, [{ find: lines.join("\n"), replace: changed.join("\n") }]) : []]) {
        if (!edits.length) continue;
        expect(apply(before, edits), `sample ${sample}`).toBe(after);
        expect(edits.every((edit, index) => index === 0 || edits[index - 1].to <= edit.from), `sample ${sample}`).toBe(true);
        // A replacement never glues its new text to the start of an old row.
        for (const edit of edits) {
          if (edit.to === edit.from || !edit.insert || !/\n|(?<!\\)\|/.test(edit.insert + before.slice(edit.from, edit.to))) continue;
          expect(/^\r?\n/.test(before.slice(edit.from, edit.to)) || /\n$/.test(edit.insert), `sample ${sample}: ${JSON.stringify(edit)}`).toBe(true);
        }
      }
    }
  });
});
