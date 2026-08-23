import { parseMdast } from "./parse";
import type * as Md from "mdast";

export interface LintIssue {
  line: number;
  column: number;
  offset: number;
  message: string;
  rule: string;
  severity: "warning" | "error";
}

type Position = NonNullable<Md.Node["position"]>;

function visit(node: Md.Node, fn: (node: Md.Node, parent: Md.Parent | null) => void, parent: Md.Parent | null = null) {
  fn(node, parent);
  const children = (node as Md.Parent).children;
  if (children) for (const child of children) visit(child, fn, node as Md.Parent);
}

function toText(node: Md.Node): string {
  if ("value" in node && typeof (node as { value?: unknown }).value === "string") return (node as { value: string }).value;
  const children = (node as Md.Parent).children;
  return children ? children.map(toText).join("") : "";
}

/**
 * A small, fast Markdown linter for the status bar. It focuses on problems
 * that are easy to introduce while editing and that break rendering or
 * navigation: heading structure, broken references, unbalanced fences.
 */
export function lintMarkdown(src: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const tree = parseMdast(src);
  const definitions = new Set<string>();
  const footnotes = new Set<string>();
  const headings: { depth: number; text: string; pos: Position }[] = [];

  visit(tree, (node) => {
    if (node.type === "definition") definitions.add((node as Md.Definition).identifier);
    if (node.type === "footnoteDefinition") footnotes.add((node as Md.FootnoteDefinition).identifier);
  });

  const push = (pos: Position | undefined, rule: string, message: string, severity: LintIssue["severity"] = "warning") => {
    issues.push({
      line: pos?.start.line ?? 1,
      column: pos?.start.column ?? 1,
      offset: pos?.start.offset ?? 0,
      message,
      rule,
      severity,
    });
  };

  visit(tree, (node) => {
    const pos = node.position as Position | undefined;
    switch (node.type) {
      case "heading": {
        const h = node as Md.Heading;
        const text = toText(h).trim();
        if (!text) push(pos, "empty-heading", "Heading has no text");
        headings.push({ depth: h.depth, text, pos: pos! });
        break;
      }
      case "linkReference": {
        const ref = node as Md.LinkReference;
        if (!definitions.has(ref.identifier)) push(pos, "undefined-reference", `No definition for [${ref.label ?? ref.identifier}]`);
        break;
      }
      case "imageReference": {
        const ref = node as Md.ImageReference;
        if (!definitions.has(ref.identifier)) push(pos, "undefined-reference", `No definition for image [${ref.label ?? ref.identifier}]`);
        break;
      }
      case "text": {
        // An undefined reference is parsed as plain text; detect `[text][label]` patterns.
        const text = (node as Md.Text).value;
        const re = /\[([^\[\]\n]+)\]\[([^\[\]\n]*)\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const label = (m[2] || m[1]).trim().toLowerCase().replace(/\s+/g, " ");
          if (!definitions.has(label)) {
            const start = (pos?.start.offset ?? 0) + m.index;
            const before = src.slice(0, start);
            const line = before.split("\n").length;
            const column = start - before.lastIndexOf("\n");
            issues.push({ line, column, offset: start, message: `No definition for [${m[2] || m[1]}]`, rule: "undefined-reference", severity: "warning" });
          }
        }
        break;
      }
      case "footnoteReference": {
        const ref = node as Md.FootnoteReference;
        if (!footnotes.has(ref.identifier)) push(pos, "undefined-footnote", `No footnote [^${ref.label ?? ref.identifier}]`);
        break;
      }
      case "link": {
        const link = node as Md.Link;
        if (!link.url || link.url === "#") push(pos, "empty-link", "Link has no URL");
        else if (/\s/.test(link.url)) push(pos, "link-space", "Link URL contains whitespace");
        break;
      }
      case "image": {
        const img = node as Md.Image;
        if (!img.alt) push(pos, "image-alt", "Image has no alt text");
        break;
      }
      case "code": {
        const code = node as Md.Code;
        if (pos) {
          const raw = src.slice(pos.start.offset ?? 0, pos.end.offset ?? 0);
          const opening = /^\s*(`{3,}|~{3,})/.exec(raw);
          if (opening) {
            const fence = opening[1];
            const closing = raw.trimEnd().endsWith(fence);
            if (!closing) push(pos, "unclosed-fence", "Code fence is never closed", "error");
          }
        }
        void code;
        break;
      }
      case "table": {
        const table = node as Md.Table;
        const cols = table.children[0]?.children.length ?? 0;
        table.children.forEach((row) => {
          if (row.children.length !== cols) push(row.position as Position, "table-columns", `Row has ${row.children.length} cells, header has ${cols}`);
        });
        break;
      }
    }
  });

  // Heading structure.
  let prevDepth = 0;
  const seen = new Map<string, number>();
  for (const h of headings) {
    if (prevDepth && h.depth > prevDepth + 1) {
      push(h.pos, "heading-increment", `Heading level jumps from h${prevDepth} to h${h.depth}`);
    }
    prevDepth = h.depth;
    const key = h.text.toLowerCase();
    if (key) {
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count === 2) push(h.pos, "duplicate-heading", `Duplicate heading "${h.text}"`);
    }
  }
  const h1s = headings.filter((h) => h.depth === 1);
  if (h1s.length > 1) push(h1s[1].pos, "multiple-h1", "More than one top-level heading");

  // Trailing whitespace (excluding intentional two-space hard breaks) and leftover merge-conflict markers.
  const lines = src.split("\n");
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (/^(<{7}|>{7})(\s|$)|^={7}$/.test(line)) {
      const side = line.startsWith("<") ? "start" : line.startsWith(">") ? "end" : "separator";
      issues.push({ line: i + 1, column: 1, offset, message: `Merge conflict ${side} marker — resolve and remove it`, rule: "merge-conflict", severity: "error" });
    }
    if (!inFence && /[ \t]$/.test(line) && !/ {2}$/.test(line) && line.trim() !== "") {
      issues.push({ line: i + 1, column: line.length, offset: offset + line.length - 1, message: "Trailing whitespace", rule: "trailing-space", severity: "warning" });
    }
    offset += line.length + 1;
  }

  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

