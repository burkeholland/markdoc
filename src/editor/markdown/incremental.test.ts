import { describe, expect, it } from "vitest";
import { parseMarkdown, type ParseResult } from "./parse";
import { reparseRange, textChangeSpan } from "./incremental";

const BLOCKS = [
  "# Title",
  "## Section",
  "### Sub section",
  "Plain paragraph with **bold**, *em*, `code` and a [link](https://example.com).",
  "Another paragraph\nwith a soft break and ~~strike~~.",
  "- one\n- two\n- three",
  "- [ ] todo\n- [x] done",
  "1. first\n2. second\n   - nested\n   - nested two",
  "> quoted text\n> continues",
  "```js\nconst x = 1;\n```",
  "~~~\nplain fence\n~~~",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "---",
  "Setext heading\n===",
  "<div>\nhtml block\n</div>",
  "    indented code",
  "Trailing paragraph with an ![image](https://example.com/i.png) inside.",
  "* star list\n\n* loose item",
];

const SNIPPETS = ["x", " ", "\n", "\n\n", "**", "`", "- ", "# ", "> ", "```", "|", "[", "]", "(", ")", "*", "\n- item", "\n\n## New", "~~~", "1. ", "<div>", "text with\nbreak", "---", "---\ntitle: t\n---\n"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

function randomDoc(rand: () => number): string {
  const count = 1 + Math.floor(rand() * 8);
  const parts: string[] = [];
  if (rand() < 0.15) parts.push("---\ntitle: Doc\ntags: [a, b]\n---");
  for (let i = 0; i < count; i++) parts.push(pick(rand, BLOCKS));
  return parts.join(pick(rand, ["\n\n", "\n\n", "\n\n\n", "\n"])) + pick(rand, ["", "\n", "\n\n"]);
}

function randomEdit(rand: () => number, text: string): string {
  const kind = rand();
  const pos = Math.floor(rand() * (text.length + 1));
  if (kind < 0.55) return text.slice(0, pos) + pick(rand, SNIPPETS) + text.slice(pos);
  if (kind < 0.85) {
    const len = 1 + Math.floor(rand() * 12);
    return text.slice(0, pos) + text.slice(Math.min(text.length, pos + len));
  }
  const len = 1 + Math.floor(rand() * 40);
  return text.slice(0, pos) + pick(rand, SNIPPETS) + text.slice(Math.min(text.length, pos + len));
}

function plain(result: ParseResult) {
  return {
    doc: result.doc.toJSON(),
    blocks: result.map.blocks,
    segments: result.map.segments,
    headings: result.headings,
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Math.floor(n);
}

// Default run is deterministic and quick; `npm run test:fuzz` sets FUZZ_DOCS=1500.
// Reproduce a reported failure with FUZZ_SEED=<seed> FUZZ_DOCS=<docs>.
const FUZZ_SEED = envInt("FUZZ_SEED", 42);
const FUZZ_DOCS = envInt("FUZZ_DOCS", 300);
const MIN_RATIO_SAMPLE = 200;

describe("reparseRange", () => {
  it(
    `matches a full parse for random edits (${FUZZ_DOCS} docs, seed ${FUZZ_SEED})`,
    () => {
      const rand = rng(FUZZ_SEED);
      let attempts = 0;
      let incremental = 0;
      try {
        for (let i = 0; i < FUZZ_DOCS; i++) {
          const oldText = randomDoc(rand);
          const prev = parseMarkdown(oldText);
          let text = oldText;
          let result = prev;
          for (let e = 0; e < 3; e++) {
            const next = randomEdit(rand, text);
            const span = textChangeSpan(text, next);
            if (!span) continue;
            attempts++;
            const full = parseMarkdown(next);
            const inc = reparseRange(result, text, next, span);
            if (inc) {
              incremental++;
              try {
                expect(plain(inc)).toEqual(plain(full));
              } catch (err) {
                console.error(`doc ${i} edit ${e}\nold:\n` + JSON.stringify(text) + "\nnew:\n" + JSON.stringify(next));
                throw err;
              }
            }
            text = next;
            result = inc ?? full;
          }
        }
        // Most ordinary edits must take the fast path. The ratio is statistical, so
        // only assert it once the sample is large enough to be meaningful.
        if (attempts >= MIN_RATIO_SAMPLE) expect(incremental / attempts).toBeGreaterThan(0.6);
      } catch (err) {
        console.error(`fuzz failed; reproduce with FUZZ_SEED=${FUZZ_SEED} FUZZ_DOCS=${FUZZ_DOCS}`);
        throw err;
      }
    },
    60_000,
  );

  it("reuses unchanged nodes", () => {
    const oldText = "# A\n\nintro\n\nfirst\n\n- x\n- y\n\nmid\n\nlast";
    const newText = "# A\n\nintro\n\nfirst!\n\n- x\n- y\n\nmid\n\nlast";
    const prev = parseMarkdown(oldText);
    const inc = reparseRange(prev, oldText, newText, textChangeSpan(oldText, newText)!);
    expect(inc).not.toBeNull();
    expect(inc!.doc.child(0)).toBe(prev.doc.child(0));
    expect(inc!.doc.child(4)).toBe(prev.doc.child(4));
    expect(inc!.doc.child(5)).toBe(prev.doc.child(5));
    expect(inc!.doc.child(2)).not.toBe(prev.doc.child(2));
    expect(inc!.doc.toJSON()).toEqual(parseMarkdown(newText).doc.toJSON());
  });

  it("recovers source positions for autolink literals found by the mdast transform", () => {
    const src = "a *b [c https://example.com d";
    const { map } = parseMarkdown(src);
    expect(map.segments.map((s) => [s.srcFrom, s.srcTo])).toEqual([
      [0, 8],
      [8, 27],
      [27, 29],
    ]);
    expect(map.srcToPm(10)).toBe(11);
    expect(map.pmToSrc(11)).toBe(10);
  });

  it("does not let an unclosed leading --- break list parsing", () => {
    const { doc } = parseMarkdown("---\n\n* a\n\n* b");
    expect(doc.child(0).type.name).toBe("horizontal_rule");
    expect(doc.child(1).type.name).toBe("bullet_list");
    expect(parseMarkdown("---\ntitle: x\n---\n\n* a").doc.child(0).type.name).toBe("frontmatter");
  });

  it("falls back when the document has reference definitions", () => {
    const oldText = "[link][ref]\n\nbody\n\n[ref]: https://example.com";
    const newText = "[link][ref]\n\nbody!\n\n[ref]: https://example.com";
    expect(reparseRange(parseMarkdown(oldText), oldText, newText, textChangeSpan(oldText, newText)!)).toBeNull();
  });

  it("computes change spans", () => {
    expect(textChangeSpan("abc", "abc")).toBeNull();
    expect(textChangeSpan("hello world", "hello brave world")).toEqual({ from: 6, oldTo: 6, newTo: 12 });
    expect(textChangeSpan("aaa", "aa")).toEqual({ from: 2, oldTo: 3, newTo: 2 });
    expect(textChangeSpan("", "x")).toEqual({ from: 0, oldTo: 0, newTo: 1 });
  });
});
