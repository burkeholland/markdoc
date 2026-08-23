/**
 * Inline Markdown for comment bodies: **bold**, *italic*, `code`, [links](url),
 * bare http(s) URLs, `@login` chips, line breaks and paragraphs. Nothing else
 * (no headings, lists, images or HTML) — everything unknown is plain text.
 *
 * A tiny hand-written tokenizer over the body; output is React elements, never
 * HTML strings, so escaping is React's job and no `dangerouslySetInnerHTML` is used.
 */
import { createElement, Fragment, type ReactNode } from "react";
import { splitMentions } from "./mentions";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "mention"; login: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "br" };

/** A paragraph is a list of inline nodes; `br` separates soft lines. */
export type CommentDoc = InlineNode[][];

const SAFE_URL_RE = /^(https?:\/\/|mailto:)/i;
const BARE_URL_RE = /^https?:\/\/[^\s<>]+/i;
const LINK_RE = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const ESCAPABLE = "\\`*[]()";

/** Only http(s) and mailto links are rendered; anything else (javascript:, data:, relative) is dropped. */
export function isSafeUrl(url: string): boolean {
  return SAFE_URL_RE.test(url.trim());
}

/** Trailing punctuation is rarely part of a pasted URL ("see https://x.y/z."). */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0 && ".,;:!?'\"".includes(url[end - 1])) end--;
  // A closing paren only belongs to the URL when it balances an opening one.
  while (end > 0 && url[end - 1] === ")" && (url.slice(0, end).split("(").length - 1) < (url.slice(0, end).split(")").length - 1)) end--;
  return url.slice(0, end);
}

function textNodes(text: string): InlineNode[] {
  if (!text) return [];
  return splitMentions(text).map((p) => (p.type === "mention" ? { type: "mention", login: p.value } : { type: "text", value: p.value }));
}

/** Find the closing `marker` after `from` whose content is non-empty and does not start with whitespace. */
function closing(src: string, marker: string, from: number): number {
  if (/\s/.test(src[from] ?? "")) return -1;
  let j = src.indexOf(marker, from + 1);
  while (j !== -1 && /\s/.test(src[j - 1])) j = src.indexOf(marker, j + 1);
  return j;
}

export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(...textNodes(buf));
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i + 1) {
        flush();
        out.push({ type: "code", value: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const j = closing(src, "**", i + 2);
      if (j !== -1) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, j)) });
        i = j + 2;
        continue;
      }
    }
    if (ch === "*") {
      const j = closing(src, "*", i + 1);
      if (j !== -1) {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, j)) });
        i = j + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK_RE.exec(src.slice(i));
      if (m) {
        flush();
        const children = parseInline(m[1]);
        if (isSafeUrl(m[2])) out.push({ type: "link", href: m[2], children });
        else out.push(...children);
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]))) {
      const m = BARE_URL_RE.exec(src.slice(i));
      if (m) {
        const href = trimUrl(m[0]);
        flush();
        out.push({ type: "link", href, children: [{ type: "text", value: href }] });
        i += href.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Blank lines separate paragraphs; single newlines become `br` nodes. */
export function parseCommentBody(body: string): CommentDoc {
  const paragraphs = body.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/);
  return paragraphs.map((para) => {
    const nodes: InlineNode[] = [];
    para.split("\n").forEach((line, idx) => {
      if (idx > 0) nodes.push({ type: "br" });
      nodes.push(...parseInline(line));
    });
    return nodes;
  });
}

function renderNodes(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.value;
      case "br":
        return createElement("br", { key: i });
      case "mention":
        return createElement("span", { key: i, className: "mention-chip rounded bg-accent-soft px-1 font-medium text-accent", title: n.login, "data-testid": "mention-chip" }, `@${n.login}`);
      case "code":
        return createElement("code", { key: i, className: "comment-code" }, n.value);
      case "strong":
        return createElement("strong", { key: i }, ...renderNodes(n.children));
      case "em":
        return createElement("em", { key: i }, ...renderNodes(n.children));
      case "link":
        return createElement("a", { key: i, href: n.href, target: "_blank", rel: "noopener noreferrer", className: "comment-link" }, ...renderNodes(n.children));
    }
  });
}

/**
 * Render a comment body. Returns one `<p>` per paragraph (so wrap it in a block element,
 * not another `<p>`); an empty body renders nothing.
 */
export function renderCommentBody(body: string): ReactNode {
  const doc = parseCommentBody(body);
  if (doc.length === 1 && doc[0].length === 0) return null;
  return createElement(
    Fragment,
    null,
    ...doc.map((para, i) => createElement("p", { key: i, className: "comment-paragraph" }, ...renderNodes(para))),
  );
}

/** Result of a composer shortcut: the new text and the selection to restore. */
export interface WrapResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Wrap the textarea selection in `marker` (e.g. `**`), or unwrap it when it is
 * already wrapped. With an empty selection the markers are inserted and the caret
 * sits between them.
 */
export function wrapSelection(value: string, start: number, end: number, marker: string): WrapResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const before = value.slice(0, from);
  const sel = value.slice(from, to);
  const after = value.slice(to);
  const n = marker.length;
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return { value: before.slice(0, -n) + sel + after.slice(n), selectionStart: from - n, selectionEnd: to - n };
  }
  if (sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= 2 * n) {
    return { value: before + sel.slice(n, -n) + after, selectionStart: from, selectionEnd: to - 2 * n };
  }
  return { value: before + marker + sel + marker + after, selectionStart: from + n, selectionEnd: to + n };
}

/** Turn the selection into `[selection](url)` with the caret inside the empty parentheses. */
export function wrapLink(value: string, start: number, end: number): WrapResult {
  const [from, to] = start <= end ? [start, end] : [end, start];
  const sel = value.slice(from, to);
  const next = value.slice(0, from) + `[${sel}](` + ")" + value.slice(to);
  const caret = from + sel.length + 3;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}
