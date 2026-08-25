import { Schema, type NodeSpec, type MarkSpec, type DOMOutputSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

/**
 * ProseMirror schema for GitHub Flavored Markdown.
 *
 * The schema is deliberately lossless with respect to the Markdown constructs
 * we care about (headings, lists, task items, tables, code, links, images,
 * HTML blocks, link definitions, front matter, footnotes) so that a document
 * can be parsed into the rich editor and serialized back to Markdown without
 * losing information.
 */

const tables = tableNodes({
  tableGroup: "block",
  cellContent: "inline*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM(dom) {
        return (dom as HTMLElement).style.textAlign || null;
      },
      setDOMAttr(value, attrs) {
        if (value) attrs.style = `text-align: ${value}`;
      },
    },
  },
});

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },

  heading: {
    attrs: { level: { default: 1 } },
    content: "inline*",
    group: "block",
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  code_block: {
    attrs: { language: { default: null }, meta: { default: null } },
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => ({
          language: (dom as HTMLElement).getAttribute("data-language") || null,
        }),
      },
    ],
    toDOM: (node) =>
      [
        "pre",
        { "data-language": node.attrs.language ?? "", class: "md-code-block" },
        ["code", 0],
      ] as DOMOutputSpec,
  },

  bullet_list: {
    attrs: { bullet: { default: "-" }, tight: { default: true } },
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: (node) => ["ul", { "data-tight": node.attrs.tight ? "true" : "false" }, 0],
  },

  ordered_list: {
    attrs: { start: { default: 1 }, tight: { default: true }, delimiter: { default: "." } },
    content: "list_item+",
    group: "block",
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({
          start: (dom as HTMLElement).hasAttribute("start")
            ? Number((dom as HTMLElement).getAttribute("start"))
            : 1,
        }),
      },
    ],
    toDOM: (node) =>
      [
        "ol",
        {
          start: node.attrs.start === 1 ? undefined : node.attrs.start,
          "data-tight": node.attrs.tight ? "true" : "false",
        },
        0,
      ] as DOMOutputSpec,
  },

  list_item: {
    attrs: { checked: { default: null } },
    content: "paragraph block*",
    defining: true,
    parseDOM: [
      {
        tag: "li",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const checked = el.getAttribute("data-checked");
          return { checked: checked === null ? null : checked === "true" };
        },
      },
    ],
    toDOM: (node) => {
      const attrs: Record<string, string> = {};
      if (node.attrs.checked !== null) {
        attrs["data-checked"] = node.attrs.checked ? "true" : "false";
        attrs.class = "md-task-item";
      }
      return ["li", attrs, 0];
    },
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },

  /** Raw block-level HTML, kept verbatim. */
  html_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    toDOM: () => ["pre", { class: "md-html-block" }, ["code", 0]],
  },

  /** YAML front matter at the top of the document. */
  frontmatter: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    toDOM: () => ["pre", { class: "md-frontmatter" }, ["code", 0]],
  },

  /**
   * A block the parser refused to render (see `renderable.ts`): its Markdown source is kept
   * verbatim in `src` so it round-trips, and the rich pane shows a placeholder.
   */
  unrenderable: {
    attrs: { src: {} },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: () => ["div", { class: "md-unrenderable", contenteditable: "false", "data-testid": "unrenderable-block" }, "This section cannot be rendered"],
  },

  /** `[label]: url "title"` reference definition. */
  link_definition: {
    attrs: { label: {}, url: {}, title: { default: null } },
    group: "block",
    atom: true,
    selectable: true,
    toDOM: (node) => [
      "div",
      { class: "md-link-definition", contenteditable: "false" },
      `[${node.attrs.label}]: ${node.attrs.url}${node.attrs.title ? ` "${node.attrs.title}"` : ""}`,
    ],
  },

  footnote_definition: {
    attrs: { label: {} },
    content: "block+",
    group: "block",
    defining: true,
    toDOM: (node) => ["div", { class: "md-footnote-definition", "data-label": node.attrs.label }, 0],
  },

  ...tables,

  text: { group: "inline" },

  image: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: { src: {}, alt: { default: null }, title: { default: null } },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          return { src: el.getAttribute("src"), alt: el.getAttribute("alt"), title: el.getAttribute("title") };
        },
      },
    ],
    toDOM: (node) => ["img", { src: node.attrs.src, alt: node.attrs.alt ?? "", title: node.attrs.title ?? undefined }],
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  html_inline: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: { html: {} },
    toDOM: (node) => ["span", { class: "md-html-inline", contenteditable: "false" }, node.attrs.html],
  },

  footnote_reference: {
    inline: true,
    group: "inline",
    atom: true,
    attrs: { label: {} },
    toDOM: (node) => ["sup", { class: "md-footnote-ref", contenteditable: "false" }, `[${node.attrs.label}]`],
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({
          href: (dom as HTMLElement).getAttribute("href"),
          title: (dom as HTMLElement).getAttribute("title"),
        }),
      },
    ],
    toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title ?? undefined, rel: "noopener" }, 0],
  },
  em: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: () => ["em", 0],
  },
  strong: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b", getAttrs: (node) => (node as HTMLElement).style.fontWeight !== "normal" && null },
      { style: "font-weight", getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value as string) && null },
    ],
    toDOM: () => ["strong", 0],
  },
  strikethrough: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
    toDOM: () => ["s", 0],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", { class: "md-inline-code" }, 0],
  },
};

export const schema = new Schema({ nodes, marks });

export type MarkdownSchema = typeof schema;
