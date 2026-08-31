import { Plugin, PluginKey, type PluginView, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import type { Root, RootContent } from "hast";
// Type-only, erased at build time: the runtime chunk arrives through the import() in ensureGrammars().
import type { Lowlight } from "./code-highlight-languages";
import { schema } from "../markdown/schema";

// Nothing here constructs highlight.js: its core and the 37 `common` grammars (≈ 171 kB together) only
// matter once a document shows a code block with a recognised language, so ensureGrammars() fetches
// them as one chunk (code-highlight-languages.ts, which owns the lowlight instance) on demand and the
// plugin redecorates when they arrive.

/** The 37 grammars of highlight.js' `common` set (= `Object.keys(common)` from lowlight); pinned by code-highlight.test.ts. */
export const COMMON_LANGUAGES: ReadonlySet<string> = new Set([
  "arduino",
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "graphql",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "less",
  "lua",
  "makefile",
  "markdown",
  "objectivec",
  "perl",
  "php",
  "php-template",
  "plaintext",
  "python",
  "python-repl",
  "r",
  "ruby",
  "rust",
  "scss",
  "shell",
  "sql",
  "swift",
  "typescript",
  "vbnet",
  "wasm",
  "xml",
  "yaml",
]);

/**
 * The aliases highlight.js itself declares on those grammars. `lowlight.registered()` accepted them
 * when the grammars were registered at import time, so normalizeLanguage keeps accepting them before
 * the lazy chunk has arrived. Pinned against highlight.js by code-highlight.test.ts.
 */
export const COMMON_LANGUAGE_ALIASES: ReadonlySet<string> = new Set([
  "ino", // arduino
  "sh", "zsh", // bash
  "h", // c
  "cc", "c++", "h++", "hpp", "hh", "hxx", "cxx", // cpp
  "cs", "c#", // csharp
  "patch", // diff
  "golang", // go
  "gql", // graphql
  "toml", // ini
  "jsp", // java
  "js", "jsx", "mjs", "cjs", // javascript
  "jsonc", "json5", // json
  "kt", "kts", // kotlin
  "pluto", // lua
  "mk", "mak", "make", // makefile
  "md", "mkdown", "mkd", // markdown
  "mm", "objc", "obj-c", "obj-c++", "objective-c++", // objectivec
  "pl", "pm", // perl
  "text", "txt", // plaintext
  "py", "gyp", "ipython", // python
  "pycon", // python-repl
  "rb", "gemspec", "podspec", "thor", "irb", // ruby
  "rs", // rust
  "console", "shellsession", // shell
  "ts", "tsx", "mts", "cts", // typescript
  "vb", // vbnet
  "html", "xhtml", "rss", "atom", "xjb", "xsd", "xsl", "plist", "wsf", "svg", // xml
  "yml", // yaml
]);

export const ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  ps1: "powershell",
  pwsh: "powershell",
  html: "xml",
  vue: "xml",
  svelte: "xml",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  dockerfile: "dockerfile",
};

/** Answers synchronously from the static lists above, so the label logic never waits for the chunk. */
export function normalizeLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase().split(/[\s{]/)[0];
  const name = ALIASES[key] ?? key;
  return COMMON_LANGUAGES.has(name) || COMMON_LANGUAGE_ALIASES.has(name) ? name : null;
}

const GRAMMARS_LOADED = "grammars-loaded";
/** After a failed chunk load, the next code-block change may try again once this much time has passed. */
const RETRY_DELAY_MS = 10_000;

let grammars: Promise<void> | null = null;
/** The chunk's instance once it has arrived; null until then, so nothing here ever constructs highlight.js. */
let lowlight: Lowlight | null = null;
let loaded = false;
const onLoaded = new Set<() => void>();

/**
 * Starts (once) the import of the highlighter chunk (highlight.js core + grammars) and keeps its
 * instance; resolves when highlightTokens can work. Safe to call from every highlight pass: calls after
 * the first return the same promise, and the promise never rejects (a failed load is retried on a later
 * call after RETRY_DELAY_MS).
 */
export function ensureGrammars(): Promise<void> {
  if (!grammars) {
    grammars = import("./code-highlight-languages")
      .then((chunk) => {
        lowlight = chunk.lowlight;
        loaded = true;
        for (const notify of [...onLoaded]) {
          try {
            notify();
          } catch (error) {
            console.error("[markdoc] code block redecoration after the grammar load failed", error);
          }
        }
      })
      .catch((error: unknown) => {
        console.warn("[markdoc] code block highlighting grammars did not load; retrying on the next code block change", error);
        setTimeout(() => {
          grammars = null;
        }, RETRY_DELAY_MS);
      });
  }
  return grammars;
}

/** True once the highlighter chunk has arrived (highlighting is possible). */
export function grammarsLoaded(): boolean {
  return loaded;
}

interface Token {
  from: number;
  to: number;
  classes: string;
}

function collect(nodes: RootContent[], offset: number, classes: string[], out: Token[]): number {
  for (const node of nodes) {
    if (node.type === "text") {
      if (classes.length) out.push({ from: offset, to: offset + node.value.length, classes: classes.join(" ") });
      offset += node.value.length;
    } else if (node.type === "element") {
      const cls = (node.properties?.className as string[] | undefined) ?? [];
      offset = collect(node.children as RootContent[], offset, [...classes, ...cls], out);
    }
  }
  return offset;
}

/** Tokens of `code` in `language`; `[]` until ensureGrammars() has resolved. */
export function highlightTokens(code: string, language: string): Token[] {
  if (!loaded || !lowlight) return [];
  const root: Root = lowlight.highlight(language, code);
  const tokens: Token[] = [];
  collect(root.children, 0, [], tokens);
  return tokens;
}

const key = new PluginKey<DecorationSet>("codeHighlight");

function highlightBlock(node: PMNode, pos: number): Decoration[] {
  const language = normalizeLanguage(node.attrs.language);
  if (!language) return [];
  if (!loaded) {
    // The first recognised block of the session pays for the chunk; the plugin view redecorates on arrival.
    void ensureGrammars();
    return [];
  }
  if (!node.textContent) return [];
  let tokens: Token[];
  try {
    tokens = highlightTokens(node.textContent, language);
  } catch {
    return [];
  }
  const base = pos + 1;
  return tokens.map((t) => Decoration.inline(base + t.from, base + t.to, { class: t.classes }));
}

function build(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.code_block) return true;
    decorations.push(...highlightBlock(node, pos));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Map the old decorations through the transaction and re-highlight only the code blocks it touched. */
function update(tr: Transaction, old: DecorationSet): DecorationSet {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      lo = Math.min(lo, rest.map(newStart, -1));
      hi = Math.max(hi, rest.map(newEnd, 1));
    });
  });
  let set = old.map(tr.mapping, tr.doc);
  if (lo > hi) return set;
  tr.doc.nodesBetween(lo, hi, (node, pos) => {
    if (node.type !== schema.nodes.code_block) return true;
    set = set.remove(set.find(pos, pos + node.nodeSize));
    const fresh = highlightBlock(node, pos);
    if (fresh.length) set = set.add(tr.doc, fresh);
    return false;
  });
  return set;
}

/** Re-runs the whole highlight pass once the grammar chunk lands, unless the view is gone by then. */
function redecorateWhenLoaded(view: EditorView): PluginView {
  let destroyed = false;
  const notify = () => {
    if (destroyed || view.isDestroyed) return;
    view.dispatch(view.state.tr.setMeta(key, GRAMMARS_LOADED));
  };
  if (!loaded) onLoaded.add(notify);
  return {
    destroy() {
      destroyed = true;
      onLoaded.delete(notify);
    },
  };
}

/** Syntax highlighting inside rich-editor code blocks (highlight.js core + grammars via lowlight, loaded lazily). */
export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, old) => {
        if (tr.getMeta(key) === GRAMMARS_LOADED) return build(tr.doc);
        return tr.docChanged ? update(tr, old) : old;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
    view: redecorateWhenLoaded,
  });
}
