import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownExtension } from "@lezer/markdown";
import { MAX_ATTENTION_MARKERS_PER_PARAGRAPH, MAX_LABEL_ENDS_PER_PARAGRAPH } from "../markdown/renderable";

/**
 * True when `text` (one paragraph's content) carries more link or emphasis markers than the inline
 * parser can resolve in reasonable time. Linear in the text.
 */
function isPathological(text: string): boolean {
  let labelEnds = 0;
  let attention = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 93 /* ] */) labelEnds++;
    else if (code === 42 /* * */ || code === 95 /* _ */) attention++;
  }
  return labelEnds > MAX_LABEL_ENDS_PER_PARAGRAPH || attention > MAX_ATTENTION_MARKERS_PER_PARAGRAPH;
}

/**
 * Attached to every paragraph; lezer collects the paragraph's lines itself (stopping at blank
 * lines, fences and other interrupting blocks), and at `finish` this decides whether the inline
 * parser may see the content.
 */
class PathologicalLeafParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    if (!isPathological(leaf.content)) return false;
    cx.addLeafElement(leaf, cx.elt("UnrenderableParagraph", leaf.start, leaf.start + leaf.content.length));
    return true;
  }
}

/**
 * Lezer Markdown extension for the code pane: a paragraph with thousands of `]` or `*`/`_` in it
 * (the #115 repro) takes the inline parser seconds per keystroke, so such a paragraph is emitted as
 * one opaque `UnrenderableParagraph` leaf and never inline-parsed. The same paragraph model as
 * `findUnrenderable`, which decides what the rich pane shows for it.
 */
export const pathologicalParagraphs: MarkdownExtension = {
  defineNodes: [{ name: "UnrenderableParagraph", block: true }],
  parseBlock: [
    {
      name: "UnrenderableParagraph",
      leaf(): LeafBlockParser | null {
        return new PathologicalLeafParser();
      },
    },
  ],
};