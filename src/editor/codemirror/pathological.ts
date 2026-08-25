import type { BlockContext, Line, MarkdownExtension } from "@lezer/markdown";
import { MAX_ATTENTION_MARKERS_PER_PARAGRAPH, MAX_LABEL_ENDS_PER_PARAGRAPH } from "../markdown/renderable";

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function count(text: string, from: number, c: { labelEnds: number; attention: number }) {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 93 /* ] */) c.labelEnds++;
    else if (code === 42 /* * */ || code === 95 /* _ */) c.attention++;
  }
}

function over(c: { labelEnds: number; attention: number }): boolean {
  return c.labelEnds > MAX_LABEL_ENDS_PER_PARAGRAPH || c.attention > MAX_ATTENTION_MARKERS_PER_PARAGRAPH;
}

/**
 * True when the paragraph starting at `line` (this line plus the non-blank, non-fence lines after
 * it) carries more link or emphasis markers than the inline parser can resolve in reasonable time.
 * Reads ahead chunk by chunk, so the cost is linear in the paragraph.
 */
function isPathologicalParagraph(cx: BlockContext, line: Line): boolean {
  const c = { labelEnds: 0, attention: 0 };
  count(line.text, line.pos, c);
  if (over(c)) return true;
  const input = cx.input;
  let pos = cx.lineStart + line.text.length + 1;
  let carry = "";
  while (pos < input.length || carry) {
    let nl = carry.indexOf("\n");
    while (nl === -1 && pos < input.length) {
      const chunk = input.chunk(pos);
      if (!chunk.length) break;
      carry += chunk;
      pos += chunk.length;
      nl = carry.indexOf("\n");
    }
    const text = nl === -1 ? carry : carry.slice(0, nl);
    carry = nl === -1 ? "" : carry.slice(nl + 1);
    if (text.trim() === "" || FENCE_RE.test(text)) return false;
    count(text, 0, c);
    if (over(c)) return true;
    if (nl === -1) break;
  }
  return false;
}

/**
 * Lezer Markdown extension for the code pane: a paragraph with thousands of `]` or `*`/`_` in it
 * (the #115 repro) takes the inline parser seconds per keystroke, so such a paragraph is taken as
 * one opaque `UnrenderableParagraph` leaf and never inline-parsed. The same paragraph model as
 * `findUnrenderable`, which decides what the rich pane shows for it.
 */
export const pathologicalParagraphs: MarkdownExtension = {
  defineNodes: [{ name: "UnrenderableParagraph", block: true }],
  parseBlock: [
    {
      name: "UnrenderableParagraph",
      parse(cx, line) {
        if (!isPathologicalParagraph(cx, line)) return false;
        const start = cx.lineStart + line.pos;
        while (cx.nextLine()) {
          if (line.text.trim() === "" || FENCE_RE.test(line.text.slice(line.pos))) break;
        }
        cx.addElement(cx.elt("UnrenderableParagraph", start, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};
