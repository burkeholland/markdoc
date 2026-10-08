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
import type { Element, Root as HastRoot } from "hast";
// The extension is required: in development Node loads the render worker straight from source.
import { cardLinkText, matchLinkCard, MAX_CARD_URL_LENGTH } from "../../editor/markdown/link-cards.ts";

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
 * Link cards (#2317), first half, before the Markdown becomes HTML: only here is the form still visible
 * (the bare link, not `<link>` or `[text](link)`). The rule is the editor's (`cardUrl` in
 * `src/editor/markdown/parse.ts`): a top-level paragraph whose text is one line that starts in the first
 * column and is exactly a link on the list. The paragraph is marked with that link. The mark is only a
 * hint: `rehypeLinkCards` asks the list again, after the sanitizer.
 */
const remarkMarkLinkCards: Plugin<[], Root> = function () {
  return (tree, file) => {
    const source = String(file.value);
    for (const node of tree.children) {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (node.type !== "paragraph" || from === undefined || to === undefined || node.position?.start.column !== 1 || to - from > MAX_CARD_URL_LENGTH) continue;
      const link = source.slice(from, to);
      if (matchLinkCard(link)) node.data = { ...node.data, hProperties: { dataLinkCard: link } };
    }
  };
};

const text = (value: string) => ({ type: "text" as const, value });

function element(tagName: string, properties: Element["properties"], children: Element["children"]): Element {
  return { type: "element", tagName, properties, children };
}

/**
 * Link cards, second half, after the sanitizer: a marked paragraph whose mark is a link on the list
 * becomes the card, built here from that link and nothing else. The card is Markdoc's own markup: what it
 * is, the link, and an empty box of the frame's size. There is no frame in the HTML; the page adds it in
 * the browser (`src/components/reader/link-cards.tsx`), from the same list. Raw HTML never gets here (it is
 * dropped before the sanitizer), and the mark is taken off everything that is not a card. Exported for
 * its test, which hands it trees the steps before it never produce.
 */
export const rehypeLinkCards: Plugin<[], HastRoot> = function () {
  const unmark = (node: HastRoot | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      delete child.properties.dataLinkCard;
      unmark(child);
    }
  };
  return (tree) => {
    tree.children.forEach((node, index) => {
      if (node.type !== "element") return;
      const link = node.properties.dataLinkCard;
      const card = node.tagName === "p" && typeof link === "string" ? matchLinkCard(link) : null;
      delete node.properties.dataLinkCard;
      unmark(node);
      if (!card || typeof link !== "string") return;
      const shown = cardLinkText(link);
      tree.children[index] = element("figure", { className: ["md-link-card"], dataLinkCard: link, dataProvider: card.provider, ariaLabel: `${card.label}: ${shown}` }, [
        element("figcaption", { className: ["md-link-card-header"] }, [
          element("span", { className: ["md-link-card-label"] }, [text(card.label)]),
          text(" "),
          element("a", { className: ["md-link-card-link"], href: link, target: "_blank", rel: ["noopener", "noreferrer"] }, [text(shown)]),
        ]),
        element("div", { className: ["md-link-card-frame"], dataKind: card.kind }, []),
      ]);
    });
  };
};

export interface ReaderHtmlOptions {
  /** Turn a known link alone on its line into a card (the reader page and the editor's stand-in; not the exports yet). */
  linkCards?: boolean;
}

/**
 * A processor that parses Markdown (`parse` gives the Markdown tree) and turns it into the sanitized HTML
 * tree the reader page renders (`run`); `.use()` more plugins to finish the page.
 */
export function readerHtml({ linkCards = false }: ReaderHtmlOptions = {}) {
  const none: Plugin<[], Root> = () => undefined;
  const noneAfter: Plugin<[], HastRoot> = () => undefined;
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(linkCards ? remarkMarkLinkCards : none)
    .use(remarkRehype, { handlers: { yaml: () => undefined, toml: () => undefined } })
    .use(rehypeSanitize, sanitizeSchema)
    .use(linkCards ? rehypeLinkCards : noneAfter);
}