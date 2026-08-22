import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { createLowlight, common } from "lowlight";
import type { Root, RootContent } from "hast";
import { schema } from "../markdown/schema";

const lowlight = createLowlight(common);

const ALIASES: Record<string, string> = {
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

export function normalizeLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase().split(/[\s{]/)[0];
  const name = ALIASES[key] ?? key;
  return lowlight.registered(name) ? name : null;
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

export function highlightTokens(code: string, language: string): Token[] {
  const root: Root = lowlight.highlight(language, code);
  const tokens: Token[] = [];
  collect(root.children, 0, [], tokens);
  return tokens;
}

const key = new PluginKey<DecorationSet>("codeHighlight");

function build(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.code_block) return true;
    const language = normalizeLanguage(node.attrs.language);
    if (!language || !node.textContent) return false;
    let tokens: Token[];
    try {
      tokens = highlightTokens(node.textContent, language);
    } catch {
      return false;
    }
    const base = pos + 1;
    for (const t of tokens) decorations.push(Decoration.inline(base + t.from, base + t.to, { class: t.classes }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Syntax highlighting inside rich-editor code blocks (highlight.js grammars via lowlight). */
export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}
