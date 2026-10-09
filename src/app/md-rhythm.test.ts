import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRules } from "./css-layers.helpers";

/**
 * Vertical-rhythm guard for the rendered-Markdown surfaces (task #346, Burke #1057). Block spacing in
 * `.md-rich` (rich editor) and `.reader-body` (reader view) comes from one child-side, margin-top-only
 * system: `> * + *` gets `--md-space`, the first block after a heading gets `--md-space-heading-after`,
 * headings take their own margin-top per level. A `.md-rich p { margin: 0 }` beats the sibling rule on
 * specificity and glues headings, paragraphs and tables together again — that is what this test catches.
 * The one exception is a picture inside a top-level paragraph, which keeps a margin-bottom (Burke #2348,
 * see "space below a picture" below).
 * The HTML export (src/server/export/html.ts) mirrors the same system by hand and is checked below too.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");
const exportTs = readFileSync(path.resolve(__dirname, "..", "server", "export", "html.ts"), "utf8");

const SURFACES = [".md-rich", ".reader-body"] as const;
/** Direct-child blocks whose spacing must come from the sibling rules only. */
const BLOCKS = ["p", "table", "pre", "blockquote", "ul", "ol", "hr", "img", "figure", "h1", "h2", "h3", "h4", "h5", "h6"] as const;

const TOKENS = ["--md-space", "--md-space-heading-after", "--md-space-heading-before-h2", "--md-space-heading-before-h3", "--md-space-heading-before-h4"];

const rules = parseRules(css);
const selectorRules = rules.filter((r) => !r.prelude.startsWith("@") && !r.parents.some((p) => /^@media\b/.test(p)));

/** Split a selector list on top-level commas only (`:is(h1, h2)` stays whole). */
function subjects(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, " "));
}
const declares = (body: string, prop: string) => new RegExp(`(^|[\\s;])${prop}\\s*:`).test(body);

/**
 * Margins set directly on `<surface> <block>` (descendant or direct child) that are not part of the
 * rhythm: any `margin` / `margin-bottom` / `margin-block*`, or a `margin-top` whose value does not come
 * from a `--md-space*` token (headings and `> hr` take their margin-top from the tokens).
 */
function blockMarginOffenders(surface: string, list: ReturnType<typeof parseRules> = selectorRules): string[] {
  const blockSelector = new RegExp(`^${surface.replace(".", "\\.")} (?:> )?(${BLOCKS.join("|")})$`);
  const out: string[] = [];
  for (const r of list) {
    const hit = subjects(r.prelude).filter((s) => blockSelector.test(s));
    if (!hit.length) continue;
    for (const prop of ["margin", "margin-bottom", "margin-block", "margin-block-start", "margin-block-end"]) {
      if (declares(r.body, prop)) out.push(`line ${r.line}: ${hit.join(", ")} { ${prop} }`);
    }
    const top = /(?:^|[\s;])margin-top\s*:\s*([^;]+)/.exec(r.body)?.[1];
    if (top && !/var\(--md-space/.test(top)) out.push(`line ${r.line}: ${hit.join(", ")} { margin-top: ${top.trim()} }`);
  }
  return out;
}

const hasRule = (selector: string, prop: string, value: RegExp) =>
  selectorRules.some((r) => subjects(r.prelude).includes(selector) && value.test(r.body.match(new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([^;]+)`))?.[1] ?? ""));

describe.each(SURFACES)("%s vertical rhythm", (surface) => {
  it("defines the spacing tokens", () => {
    const tokenRule = selectorRules.find((r) => subjects(r.prelude).includes(surface) && declares(r.body, "--md-space"));
    expect(tokenRule, `${surface} { --md-space … } is missing`).toBeDefined();
    for (const token of TOKENS) expect(tokenRule!.body, `${token} missing on ${surface}`).toContain(`${token}:`);
  });

  it("spaces sibling blocks from the child side with margin-top", () => {
    expect(hasRule(`${surface} > * + *`, "margin-top", /^var\(--md-space\)$/)).toBe(true);
  });

  it("tightens the first block after a heading (also h2 + h3)", () => {
    expect(hasRule(`${surface} > :is(h1, h2, h3, h4, h5, h6) + *`, "margin-top", /^var\(--md-space-heading-after\)$/)).toBe(true);
  });

  it("starts the document without a gap", () => {
    expect(hasRule(`${surface} > :first-child`, "margin-top", /^0$/)).toBe(true);
  });

  it("gives headings their own margin-top per level, from the tokens", () => {
    expect(hasRule(`${surface} h2`, "margin-top", /--md-space-heading-before-h2/)).toBe(true);
    expect(hasRule(`${surface} h3`, "margin-top", /^var\(--md-space-heading-before-h3\)$/)).toBe(true);
    expect(hasRule(`${surface} h4`, "margin-top", /^var\(--md-space-heading-before-h4\)$/)).toBe(true);
  });

  it("never sets margin on a block element outside the rhythm rules", () => {
    const offenders = blockMarginOffenders(surface);
    expect(offenders, `block elements with their own margin (spacing must come from the sibling rules):\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("space below a picture (Burke #2348)", () => {
  // The one bottom margin in the system: words after a picture in the same paragraph are a text node,
  // out of reach of the child-side rules. e2e/preview-rhythm.spec.ts measures the result in a browser.
  it("a picture in a top-level paragraph keeps one block space below itself, from the token, on both surfaces", () => {
    expect(hasRule(":is(.md-rich, .reader-body) > p > img", "margin-bottom", /^var\(--md-space\)$/)).toBe(true);
    expect(hasRule(":is(.md-rich, .reader-body) > p > a > img", "margin-bottom", /^var\(--md-space\)$/)).toBe(true);
  });

  it("gives the margin up when a line break already follows the picture, and never puts it on ProseMirror's separator", () => {
    expect(hasRule(":is(.md-rich, .reader-body) > p img:has(+ br)", "margin-bottom", /^0$/)).toBe(true);
    expect(hasRule(":is(.md-rich, .reader-body) > p > a:has(+ br) > img:last-child", "margin-bottom", /^0$/)).toBe(true);
    expect(hasRule(".md-rich > p img:is(.ProseMirror-separator, :has(+ .ProseMirror-separator))", "margin-bottom", /^0$/)).toBe(true);
  });

  it("gives the margin up when another person's caret sits right after a picture that ends its paragraph", () => {
    expect(hasRule(".md-rich > p img:has(+ .md-remote-caret[data-after-picture])", "margin-bottom", /^0$/)).toBe(true);
    expect(hasRule(".md-rich > p > a:has(+ .md-remote-caret[data-after-picture]) > img", "margin-bottom", /^0$/)).toBe(true);
  });

  it("is the only margin-bottom on a picture: nothing for a picture in a list item, a quote or a table cell", () => {
    const others = selectorRules.filter((r) => declares(r.body, "margin-bottom") && subjects(r.prelude).some((s) => /(^|[\s>])img\b/.test(s) && /\.(md-rich|reader-body)\b/.test(s)));
    expect(others.flatMap((r) => subjects(r.prelude))).toEqual([
      ":is(.md-rich, .reader-body) > p > img",
      ":is(.md-rich, .reader-body) > p > a > img",
      ":is(.md-rich, .reader-body) > p img:has(+ br)",
      ":is(.md-rich, .reader-body) > p > a:has(+ br) > img:last-child",
      ".md-rich > p img:is(.ProseMirror-separator, :has(+ .ProseMirror-separator))",
      ".md-rich > p img:has(+ .md-remote-caret[data-after-picture])",
      ".md-rich > p > a:has(+ .md-remote-caret[data-after-picture]) > img",
    ]);
  });
});

describe("the gap cursor does not move the blocks around it", () => {
  // ProseMirror puts the gap cursor's element among the document's blocks (before a table that starts
  // the document, for one). As a block of its own it pushed that table down by one block space on a
  // click beside it; e2e/table-layout.spec.ts measures the table in a browser.
  it("is out of the flow, and shown only while the editor has the focus", () => {
    expect(hasRule(".md-rich .ProseMirror-gapcursor", "position", /^absolute$/)).toBe(true);
    expect(hasRule(".md-rich .ProseMirror-gapcursor", "display", /^none$/)).toBe(true);
    expect(hasRule(".md-rich.ProseMirror-focused .ProseMirror-gapcursor", "display", /^block$/)).toBe(true);
  });

  it("leaves the block after it the space that block has without the cursor", () => {
    expect(hasRule(".md-rich > .ProseMirror-gapcursor:first-child + *", "margin-top", /^0$/)).toBe(true);
    expect(hasRule(".md-rich > hr + .ProseMirror-gapcursor + *", "margin-top", /^calc\(var\(--md-space\) \* 1\.75\)$/)).toBe(true);
  });
});

describe("HTML export mirrors the rhythm", () => {
  const styles = exportTs.slice(exportTs.indexOf("const STYLES = `") + "const STYLES = `".length, exportTs.indexOf("`;", exportTs.indexOf("const STYLES = `")));

  it("defines the same tokens on <main> and the same three rules", () => {
    for (const token of TOKENS) expect(styles).toContain(`${token}:`);
    expect(styles).toMatch(/main > \* \+ \* \{ margin-top: var\(--md-space\); \}/);
    expect(styles).toMatch(/main > :is\(h1, h2, h3, h4, h5, h6\) \+ \* \{ margin-top: var\(--md-space-heading-after\); \}/);
    expect(styles).toMatch(/main > :first-child \{ margin-top: 0; \}/);
  });

  it("does not zero a block's margin after the sibling rule", () => {
    const siblingAt = styles.indexOf("main > * + *");
    const after = styles.slice(siblingAt);
    // Only the UA reset before the sibling rule may say `margin: 0` for a block; nested-only rules (li, input) are fine.
    const offenders = after.split("\n").filter((l) => /^(p|table|pre|blockquote|ul|ol|hr|img|figure|h[1-6])\b[^{]*\{[^}]*\bmargin: 0\b/.test(l.trim()));
    expect(offenders).toEqual([]);
  });
});

describe("rhythm guard self-check", () => {
  it("catches `.md-rich p { margin: 0 }`, `table { margin: 0 }` and a literal heading margin, not nested or token margins", () => {
    const sample = [
      ".md-rich > * + * { margin-top: var(--md-space); }",
      ".md-rich p { margin: 0; }",
      ".md-rich table { width: 100%; margin: 0; }",
      ".md-rich li > p { margin: 0; }",
      ".md-rich h3 { margin-top: var(--md-space-heading-before-h3); }",
      ".md-rich h2 { margin-top: 1.4em; }",
      ".md-rich > hr { margin-top: calc(var(--md-space) * 1.75); }",
    ].join("\n");
    const parsed = parseRules(sample);
    expect(blockMarginOffenders(".md-rich", parsed)).toEqual([
      "line 2: .md-rich p { margin }",
      "line 3: .md-rich table { margin }",
      "line 6: .md-rich h2 { margin-top: 1.4em }",
    ]);
  });
});
