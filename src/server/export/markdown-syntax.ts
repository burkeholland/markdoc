/**
 * The Markdown syntax the reader page renders: CommonMark with GFM and YAML/TOML front matter.
 * `render-markdown.ts` renders with it and the link-preview text (`src/server/preview-text.ts`)
 * reads with it, so a preview leaves out exactly what the reader page does not show as prose.
 *
 * `render-markdown.ts` is also a worker entry and imports this file from there, so the same rules
 * apply here: packages only (no `@/` aliases), and only syntax Node can strip.
 */
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type { Root } from "mdast";

/** Same front matter tokenizer as the editor's parser, so `---` blocks are not rendered as text or rules. */
const remarkFrontmatter: Plugin<[], Root> = function () {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(frontmatter(["yaml", "toml"]));
  (data.fromMarkdownExtensions ??= []).push(frontmatterFromMarkdown(["yaml", "toml"]));
};

/** A processor that parses Markdown into the tree the reader page renders; `.use()` more plugins to render it. */
export function readerMarkdown() {
  return unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
}
