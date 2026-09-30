/**
 * What the reader page renders: CommonMark with GFM and YAML/TOML front matter, turned into HTML without the
 * front matter and without any raw HTML, then sanitized. `render-markdown.ts` renders documents with it and
 * the link-preview text (`src/server/preview-text.ts`) is read from the same output, so a preview can only
 * show text the reader page shows.
 *
 * `render-markdown.ts` is also a worker entry and imports this file from there, so the same rules
 * apply here: packages only (no `@/` aliases), and only syntax Node can strip.
 */
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type { Root } from "mdast";

/** Same front matter tokenizer as the editor's parser, so `---` blocks are not rendered as text or rules. */
const remarkFrontmatter: Plugin<[], Root> = function () {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(frontmatter(["yaml", "toml"]));
  (data.fromMarkdownExtensions ??= []).push(frontmatterFromMarkdown(["yaml", "toml"]));
};

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "data*"],
    code: ["className"],
    pre: ["className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
};

/**
 * A processor that parses Markdown (`parse` gives the Markdown tree) and turns it into the sanitized HTML
 * tree the reader page renders (`run`); `.use()` more plugins to finish the page.
 */
export function readerHtml() {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkRehype, { handlers: { yaml: () => undefined, toml: () => undefined } })
    .use(rehypeSanitize, sanitizeSchema);
}
