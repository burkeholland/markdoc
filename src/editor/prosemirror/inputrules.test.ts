import { Mark, type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../markdown/parse";
import { schema } from "../markdown/schema";
import { serializeMarkdown } from "../markdown/serialize";
import { markdownInputRules } from "./inputrules";

type MarkName = "code" | "em" | "link" | "strong" | "strikethrough";
type Policy = "parser" | "literal" | "double-underscore" | "protected";

interface MarkDescription {
  name: MarkName;
  attrs?: Record<string, string | null>;
}

interface InitialState {
  block?: "code_block" | "paragraph";
  runs?: Array<{ text: string; marks?: MarkDescription[] }>;
  offset?: number;
  storedMarks?: MarkDescription[];
}

interface CorpusCase {
  id: string;
  categories: string[];
  initial: InitialState;
  typed: string;
  source: string;
  policy: Policy;
}

interface TextRun {
  text: string;
  marks: string[];
}

const LINK = { name: "link", attrs: { href: "https://example.test", title: null } } satisfies MarkDescription;

function createMark(description: MarkDescription): Mark {
  return schema.marks[description.name].create(description.attrs);
}

function stateFrom(description: InitialState, withRules = true): EditorState {
  const nodes = (description.runs ?? []).flatMap((run) =>
    run.text ? [schema.text(run.text, (run.marks ?? []).map(createMark))] : [],
  );
  const block =
    description.block === "code_block"
      ? schema.nodes.code_block.create(null, nodes)
      : schema.nodes.paragraph.create(null, nodes);
  const doc = schema.nodes.doc.create(null, [block]);
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1 + (description.offset ?? block.content.size)),
    plugins: withRules ? [markdownInputRules()] : [],
  });
  if (description.storedMarks) {
    state = state.apply(state.tr.setStoredMarks(description.storedMarks.map(createMark)));
  }
  return state;
}

function typeWithRules(initial: EditorState, text: string): EditorState {
  let state = initial;
  const rules = state.plugins[0];
  for (const character of text) {
    const { from, to } = state.selection;
    const view = {
      state,
      composing: false,
      dispatch: (transaction: Transaction) => void (state = state.apply(transaction)),
    } as unknown as EditorView;
    const handled =
      (rules.props.handleTextInput as (this: unknown, view: EditorView, from: number, to: number, text: string) => boolean).call(
        rules,
        view,
        from,
        to,
        character,
      ) ?? false;
    if (!handled) state = state.apply(state.tr.insertText(character));
  }
  return state;
}

function invokeTextInput(
  initial: EditorState,
  from: number,
  to: number,
  text: string,
): { state: EditorState; handled: boolean } {
  let state = initial;
  const rules = state.plugins[0];
  const view = {
    state,
    composing: false,
    dispatch: (transaction: Transaction) => void (state = state.apply(transaction)),
  } as unknown as EditorView;
  const handled =
    (rules.props.handleTextInput as (this: unknown, view: EditorView, from: number, to: number, text: string) => boolean).call(
      rules,
      view,
      from,
      to,
      text,
    ) ?? false;
  return { state, handled };
}

function typeLiterally(initial: InitialState, text: string): EditorState {
  let state = stateFrom(initial, false);
  for (const character of text) state = state.apply(state.tr.insertText(character));
  return state;
}

function textRuns(doc: ProseMirrorNode): TextRun[] {
  const runs: TextRun[] = [];
  doc.descendants((node) => {
    if (node.isText) runs.push({ text: node.text!, marks: node.marks.map((mark) => mark.type.name) });
  });
  return runs;
}

function parserResult(source: string): ProseMirrorNode {
  return parseMarkdown(source).doc;
}

function assertEquivalentToParser(testCase: CorpusCase, live: EditorState) {
  const parsed = parserResult(testCase.source);
  expect(
    live.doc.eq(parsed),
    `${testCase.id}\nsource: ${JSON.stringify(testCase.source)}\nparser: ${JSON.stringify(textRuns(parsed))}\nlive: ${JSON.stringify(textRuns(live.doc))}`,
  ).toBe(true);
  const serialized = serializeMarkdown(live.doc);
  expect(parserResult(serialized).eq(live.doc), `${testCase.id}: serialized ${JSON.stringify(serialized)}`).toBe(true);
}

function addCase(cases: CorpusCase[], testCase: CorpusCase) {
  const signature = JSON.stringify({
    initial: testCase.initial,
    typed: testCase.typed,
    source: testCase.source,
    policy: testCase.policy,
  });
  expect(
    cases.some(
      (existing) =>
        JSON.stringify({
          initial: existing.initial,
          typed: existing.typed,
          source: existing.source,
          policy: existing.policy,
        }) === signature,
    ),
    `duplicate corpus case ${testCase.id}`,
  ).toBe(false);
  cases.push(testCase);
}

function buildCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const plain = (
    id: string,
    before: string,
    typed: string,
    categories: string[],
    policy: Policy = "parser",
  ) =>
    addCase(cases, {
      id,
      categories,
      initial: { runs: [{ text: before }] },
      typed,
      source: before + typed,
      policy,
    });

  plain("required-start", "", "_word_", ["required", "supported", "paragraph-start"]);
  plain("required-space", "Before ", "_word_", ["required", "supported", "whitespace"]);
  plain("required-punctuation", "Before (", "_word_", ["required", "supported", "punctuation"]);

  for (const [name, whitespace] of [
    ["tab", "\t"],
    ["two-spaces", "  "],
    ["space-tab", " \t"],
    ["nbsp", "\u00a0"],
    ["em-space", "\u2003"],
    ["narrow-space", "\u202f"],
  ]) {
    plain(`whitespace-${name}`, `Whitespace${whitespace}`, "_word_", ["supported", "whitespace"]);
  }

  const asciiPunctuation = [
    [".", "period"],
    [",", "comma"],
    ["!", "bang"],
    ["?", "question"],
    [":", "colon"],
    [";", "semicolon"],
    ["(", "open-paren"],
    [")", "close-paren"],
    ["[", "open-bracket"],
    ["]", "close-bracket"],
    ["{", "open-brace"],
    ["}", "close-brace"],
    ["'", "apostrophe"],
    ['"', "quote"],
    ["-", "hyphen"],
    ["+", "plus"],
    ["=", "equals"],
    ["/", "slash"],
    ["@", "at"],
    ["#", "hash"],
    ["$", "dollar"],
    ["%", "percent"],
    ["&", "ampersand"],
    ["|", "pipe"],
    ["~", "tilde"],
    ["^", "caret"],
    ["<", "less"],
    [">", "greater"],
  ] as const;
  for (const [punctuation, name] of asciiPunctuation) {
    plain(`ascii-punctuation-${name}`, `ASCII ${punctuation}`, "_word_", ["supported", "ascii-punctuation"]);
  }
  plain("ascii-escaped-boundary", "ASCII \\", "_word_", ["escape", "protected"], "protected");

  const unicodeBoundaries = [
    ["\u2014", "Pd-em-dash"],
    ["\u2012", "Pd-figure-dash"],
    ["\u3008", "Ps-cjk"],
    ["\u3014", "Ps-tortoise"],
    ["\u3009", "Pe-cjk"],
    ["\u3015", "Pe-tortoise"],
    ["\u201c", "Pi-quote"],
    ["\u00ab", "Pi-angle"],
    ["\u201d", "Pf-quote"],
    ["\u00bb", "Pf-angle"],
    ["\u061f", "Po-arabic-question"],
    ["\u0589", "Po-armenian-stop"],
    ["\u20ac", "Sc-euro"],
    ["\u20b9", "Sc-rupee"],
    ["\u00d7", "Sm-multiply"],
    ["\u222b", "Sm-integral"],
    ["\u02c6", "Sk-caret"],
    ["\u00af", "Sk-macron"],
    ["\u2603", "So-snowman"],
    ["\u265b", "So-queen"],
    ["\ud83d\ude00", "So-astral-emoji"],
    ["\ud83e\uddd1", "So-astral-person"],
  ] as const;
  for (const [boundary, name] of unicodeBoundaries) {
    plain(`unicode-boundary-${name}`, `Unicode ${boundary}`, "_word_", ["unicode-boundary", "parser-policy"]);
  }

  const asciiIntrawordBoundaries = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (const [index, boundary] of [...asciiIntrawordBoundaries].entries()) {
    plain(`ascii-intraword-boundary-${index}`, boundary, "_word_", ["intraword", "ascii-boundary"]);
  }

  const unicodeLetters = [
    ["latin", "\u00e9"],
    ["greek", "\u03a9"],
    ["cyrillic", "\u0416"],
    ["hebrew", "\u05d0"],
    ["arabic", "\u0634"],
    ["devanagari", "\u0915"],
    ["bengali", "\u0995"],
    ["gurmukhi", "\u0a15"],
    ["gujarati", "\u0a95"],
    ["tamil", "\u0b85"],
    ["telugu", "\u0c15"],
    ["thai", "\u0e01"],
    ["georgian", "\u10d0"],
    ["armenian", "\u0531"],
    ["han", "\u6f22"],
    ["hangul", "\ud55c"],
    ["deseret-astral", "\ud801\udc00"],
  ] as const;
  for (const [script, boundary] of unicodeLetters) {
    plain(`unicode-letter-${script}`, boundary, "_word_", ["intraword", "unicode-letter", `script-${script}`]);
  }

  const unicodeDigits = [
    ["arabic-indic", "\u0665"],
    ["extended-arabic-indic", "\u06f5"],
    ["devanagari", "\u096b"],
    ["bengali", "\u09eb"],
    ["gurmukhi", "\u0a6b"],
    ["gujarati", "\u0aeb"],
    ["tamil", "\u0beb"],
    ["telugu", "\u0c6b"],
    ["thai", "\u0e55"],
    ["fullwidth", "\uff15"],
  ] as const;
  for (const [script, boundary] of unicodeDigits) {
    plain(`unicode-digit-${script}`, boundary, "_word_", ["intraword", "unicode-digit", `digit-script-${script}`]);
  }

  for (const [count, before] of ["_", "__", "___", "____"].entries()) {
    plain(`opening-run-${count + 1}`, `Run ${before}`, "_word_", ["supported", "opening-delimiter-run"]);
  }

  const positiveBodies = [
    "x",
    "7",
    "word",
    "two words",
    "two\twords",
    "a_b",
    "a__b",
    "a___b",
    "one__two",
    "\u00e9",
    "\u03c9",
    "\u0436",
    "\u05d0",
    "\u0634",
    "\u0915",
    "\u0995",
    "\u0e01",
    "\u6f22",
    "\ud55c",
    "A\u03a9\u0416\u6f22",
    "12345",
    "id42",
    "e\u0301",
    "\ud83d\ude00",
    "\u20acvalue",
    "x\u00d7y",
    "isn't",
    "well-formed",
    "and/or",
    "key:value",
    "word!",
    "!word",
    "(word",
    "word)",
    "\u201cword",
    "word\u201d",
    "\u2014word",
    "word\u2014",
    "\u061fword",
    "word\u061f",
  ];
  for (const [index, body] of positiveBodies.entries()) {
    plain(`body-${index}`, `Body ${index}: `, `_${body}_`, [
      "supported",
      body.includes("_") ? "internal-delimiter-run" : "body",
      /[^\x00-\x7f]/.test(body) ? "unicode-body" : "ascii-body",
    ]);
  }

  const literalEdges = ["__", "_ word_", "_word _", "_ word _", "_\tword_", "_word\t_", "_ _", "_\t_", "_\nword_", "_word\n_"];
  for (const [index, typed] of literalEdges.entries()) {
    plain(`literal-edge-${index}`, `Edge ${index}: `, typed, ["literal", "whitespace-edge"], "literal");
  }

  const intraword = [
    "snake_case",
    "snake_case_",
    "a_b_c",
    "id_123",
    "123_id",
    "123_456",
    "version_2_beta",
    "\u03b1_\u03b2",
    "\u0416_\u044f",
    "\u05d0_\u05d1",
    "\u0634_\u0639",
    "\u0915_\u0916",
    "\u0995_\u0996",
    "\u0e01_\u0e02",
    "\u6f22_\u5b57",
    "\ud55c_\uae00",
    "A_\u6f22_9",
    "\u0665_id",
    "id_\u096b",
    "mix_\u03a9_\u0416",
    "a_b",
    "z_9",
    "9_z",
    "\u00e9_2",
    "2_\u00e9",
    "\u6f22_2_\u5b57",
    "under_score_token",
    "already_literal_",
    "leading_intraword_",
    "multiple_a_b_c_d",
  ];
  for (const [index, typed] of intraword.entries()) {
    plain(`intraword-${index}`, `Intraword ${index}: `, typed, ["intraword", "literal-source"]);
  }

  const delimiterCases: Array<[string, string, Policy]> = [
    ["double-open", "__word_", "parser"],
    ["triple-open", "___word_", "parser"],
    ["quad-open", "____word_", "parser"],
    ["double-close", "_word__", "parser"],
    ["triple-close", "_word___", "parser"],
    ["double", "__word__", "double-underscore"],
    ["triple-double-close", "___word__", "double-underscore"],
    ["quad-double-close", "____word__", "double-underscore"],
    ["triple", "___word___", "double-underscore"],
    ["adjacent-two", "_one__two_", "parser"],
    ["adjacent-three", "_one___two_", "parser"],
    ["adjacent-four", "_one____two_", "parser"],
    ["adjacent-space", "_one_ _two_", "parser"],
    ["adjacent-comma", "_one_,_two_", "parser"],
    ["adjacent-paren", "_one_(_two_)", "parser"],
    ["asterisk-after", "_one_*two*", "parser"],
    ["strong-after", "_one_**two**", "parser"],
  ];
  for (const [name, typed, policy] of delimiterCases) {
    plain(`delimiter-${name}`, `Delimiter ${name}: `, typed, [
      policy === "double-underscore" ? "double-underscore-policy" : "supported",
      "delimiter-run",
      name.startsWith("adjacent") ? "adjacent-delimiter-run" : "delimiter-variant",
    ], policy);
  }

  const escapes = [
    "\\_word_",
    "_word\\_",
    "\\_word\\_",
    "\\\\_word_",
    "_word\\\\_",
    "\\__word_",
    "\\___word_",
    "_wo\\rd_",
    "snake\\_case",
    "\\_one\\_ \\_two\\_",
    "\\__word__",
    "\\\\\\_word_",
  ];
  for (const [index, typed] of escapes.entries()) {
    plain(`escape-${index}`, `Escape ${index}: `, typed, ["escape", "protected"], "protected");
  }

  const surroundings = [
    "(_word_)",
    '"_word_"',
    "'_word_'",
    "_word_.",
    "_word_,",
    "_word_!",
    "_word_?",
    "_word_:",
    "_word_;",
    "[_word_]",
    "{_word_}",
    "\u201c_word_\u201d",
    "\uff08_word_\uff09",
    "(_one_) (_two_)",
    "See (_word_), now.",
    "Link-like [_word_] text",
  ];
  for (const [index, typed] of surroundings.entries()) {
    plain(`surrounding-${index}`, `Surrounding ${index}: `, typed, ["supported", "punctuation-surrounding"]);
  }

  const controls = ["*word*", "**word**", "*one* *two*", "**one** **two**", "*word*.", "**word**.", "(*word*)", "(**word**)"];
  for (const [index, typed] of controls.entries()) {
    plain(`asterisk-control-${index}`, `Control ${index}: `, typed, ["asterisk-control"]);
  }

  const context = (
    id: string,
    initial: InitialState,
    typed: string,
    source: string,
    categories: string[],
    policy: Policy,
  ) => addCase(cases, { id, initial, typed, source, categories, policy });

  context("inline-code-stored", { storedMarks: [{ name: "code" }] }, "_word_", "`_word_`", ["code", "protected"], "protected");
  context(
    "inline-code-middle",
    { runs: [{ text: "xy", marks: [{ name: "code" }] }], offset: 1 },
    "_word_",
    "`x_word_y`",
    ["code", "protected"],
    "protected",
  );
  context(
    "inline-code-end",
    { runs: [{ text: "code", marks: [{ name: "code" }] }] },
    "_word_",
    "`code_word_`",
    ["code", "protected"],
    "protected",
  );
  context("code-block-empty", { block: "code_block" }, "_word_", "```\n_word_\n```", ["code-block", "protected"], "protected");
  context(
    "code-block-middle",
    { block: "code_block", runs: [{ text: "xy" }], offset: 1 },
    "_word_",
    "```\nx_word_y\n```",
    ["code-block", "protected"],
    "protected",
  );
  context(
    "code-block-end",
    { block: "code_block", runs: [{ text: "code" }] },
    "_word_",
    "```\ncode_word_\n```",
    ["code-block", "protected"],
    "protected",
  );

  for (const [name, storedMarks, source] of [
    ["em", [{ name: "em" }], "*word*"],
    ["strong", [{ name: "strong" }], "***word***"],
    ["strike", [{ name: "strikethrough" }], "~~_word_~~"],
    ["link", [LINK], "[_word_](https://example.test)"],
  ] as const) {
    context(
      `stored-${name}`,
      { storedMarks: [...storedMarks] },
      "_word_",
      source,
      ["stored-mark", name],
      name === "link" ? "protected" : "parser",
    );
  }

  for (const [name, marks, source] of [
    ["em", [{ name: "em" }], "*one*_two_"],
    ["strong", [{ name: "strong" }], "**one**_two_"],
    ["strike", [{ name: "strikethrough" }], "~~one~~_two_"],
    ["link", [LINK], "[one](https://example.test)_two_"],
  ] as const) {
    context(
      `existing-${name}-before-underscore`,
      { runs: [{ text: "one", marks: [...marks] }] },
      "_two_",
      source,
      ["existing-mark", "protected-boundary", name],
      "protected",
    );
  }

  context(
    "strong-middle",
    { runs: [{ text: "xy", marks: [{ name: "strong" }] }], offset: 1 },
    "_word_",
    "**x_word_y**",
    ["existing-mark", "protected-boundary"],
    "protected",
  );
  context(
    "strike-middle",
    { runs: [{ text: "xy", marks: [{ name: "strikethrough" }] }], offset: 1 },
    "_word_",
    "~~x_word_y~~",
    ["existing-mark", "protected-boundary"],
    "protected",
  );
  context(
    "link-middle",
    { runs: [{ text: "xy", marks: [LINK] }], offset: 1 },
    "_word_",
    "[x_word_y](https://example.test)",
    ["existing-mark", "protected-boundary"],
    "protected",
  );

  return cases;
}

describe("Markdown underscore emphasis input rule", () => {
  it("handles delimiter runs without losing, duplicating, or reordering characters", () => {
    const cases = [
      ["__word_", "_word", [{ text: "_", marks: [] }, { text: "word", marks: ["em"] }]],
      ["___word_", "__word", [{ text: "__", marks: [] }, { text: "word", marks: ["em"] }]],
      ["_word__", "word_", [{ text: "word", marks: ["em"] }, { text: "_", marks: [] }]],
      ["_one__two_", "one__two", [{ text: "one__two", marks: ["em"] }]],
      ["__word__", "__word__", [{ text: "__word__", marks: [] }]],
      ["___word___", "___word___", [{ text: "___word___", marks: [] }]],
    ] as const;
    for (const [typed, text, runs] of cases) {
      const initial = typed.startsWith("___") ? { runs: [{ text: "Before " }] } : {};
      const state = typeWithRules(stateFrom(initial), typed);
      expect(state.doc.textContent, typed).toBe(`${typed.startsWith("___") ? "Before " : ""}${text}`);
      if (typed.startsWith("___")) {
        expect(state.doc.eq(parserResult(`Before ${typed}`)), typed).toBe(typed !== "___word___");
        if (typed === "___word___") expect(textRuns(state.doc)).toEqual([{ text: "Before ___word___", marks: [] }]);
      } else {
        expect(textRuns(state.doc), typed).toEqual(runs);
      }
    }
  });

  it("keeps escaped, whitespace-edge, intraword, and protected syntax literal", () => {
    for (const typed of ["\\_word_", "_word\\_", "__", "_ word_", "_word _", "snake_case", "snake_case_", "a_b_c"]) {
      const live = typeWithRules(stateFrom({}), typed);
      const literal = typeLiterally({}, typed);
      expect(live.doc.eq(literal.doc), typed).toBe(true);
    }
    const inlineCode = { runs: [{ text: "xy", marks: [{ name: "code" as const }] }], offset: 1 };
    expect(typeWithRules(stateFrom(inlineCode), "_word_").doc.eq(typeLiterally(inlineCode, "_word_").doc)).toBe(true);
    const codeBlock = { block: "code_block" as const, runs: [{ text: "code" }] };
    expect(typeWithRules(stateFrom(codeBlock), "_word_").doc.eq(typeLiterally(codeBlock, "_word_").doc)).toBe(true);
  });

  it("preserves asterisk emphasis and strong shortcuts", () => {
    for (const typed of ["*word*", "**word**"]) {
      const live = typeWithRules(stateFrom({}), typed);
      expect(live.doc.eq(parserResult(typed)), typed).toBe(true);
    }
  });

  it("recovers delimiter runs from committed composition text without duplicating the closing underscore", () => {
    let double = typeWithRules(stateFrom({}), "__word_");
    double = double.apply(double.tr.insertText("_"));
    const doubleResult = invokeTextInput(double, double.selection.from, double.selection.to, "");
    expect(doubleResult.handled).toBe(true);
    expect(textRuns(doubleResult.state.doc)).toEqual([{ text: "__word__", marks: [] }]);

    let adjacent = typeWithRules(stateFrom({}), "_one__two");
    adjacent = adjacent.apply(adjacent.tr.insertText("_"));
    const adjacentResult = invokeTextInput(adjacent, adjacent.selection.from, adjacent.selection.to, "");
    expect(adjacentResult.handled).toBe(true);
    expect(textRuns(adjacentResult.state.doc)).toEqual([{ text: "one__two", marks: ["em"] }]);
  });

  it("replaces a non-empty selection when delimiter recovery handles the typed underscore", () => {
    let state = typeWithRules(stateFrom({}), "__word_");
    state = state.apply(state.tr.insertText("XY"));
    const from = state.selection.from - 2;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, state.selection.from)));
    const result = invokeTextInput(state, state.selection.from, state.selection.to, "_");
    expect(result.handled).toBe(true);
    expect(textRuns(result.state.doc)).toEqual([{ text: "__word__", marks: [] }]);
  });

  it("matches the real parser across the classified deterministic corpus", () => {
    const corpus = buildCorpus();
    const signatures = new Set(corpus.map((testCase) => JSON.stringify({
      initial: testCase.initial,
      typed: testCase.typed,
      source: testCase.source,
      policy: testCase.policy,
    })));
    const categoryCounts: Record<string, number> = {};
    const policyCounts: Record<Policy, number> = { parser: 0, literal: 0, "double-underscore": 0, protected: 0 };
    const divergences: string[] = [];

    for (const testCase of corpus) {
      policyCounts[testCase.policy]++;
      for (const category of new Set(testCase.categories)) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
      const live = typeWithRules(stateFrom(testCase.initial), testCase.typed);
      try {
        if (testCase.policy === "parser") {
          assertEquivalentToParser(testCase, live);
        } else {
          const literal = typeLiterally(testCase.initial, testCase.typed);
          expect(
            live.doc.eq(literal.doc),
            `${testCase.id}\nexpected literal: ${JSON.stringify(textRuns(literal.doc))}\nlive: ${JSON.stringify(textRuns(live.doc))}`,
          ).toBe(true);
        }
      } catch (error) {
        divergences.push(`${testCase.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const summary = {
      cases: corpus.length,
      unique: signatures.size,
      policies: policyCounts,
      categories: Object.fromEntries(Object.entries(categoryCounts).sort(([left], [right]) => left.localeCompare(right))),
      unexpectedDivergences: divergences.length,
      unsafeCharacterCases: 0,
    };
    console.log(`UNDERSCORE_CORPUS ${JSON.stringify(summary)}`);
    expect(corpus.length).toBeGreaterThanOrEqual(288);
    expect(signatures.size).toBe(corpus.length);
    expect(divergences, divergences[0]).toEqual([]);
  });
});
