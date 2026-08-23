import { createHash } from "node:crypto";
import { unified, type Plugin } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type { Root as HastRoot, Element } from "hast";
import type { Root as MdastRoot } from "mdast";
import { getAsset } from "@/server/assets";

export interface RenderDocumentHtmlOptions {
  title: string;
  markdown: string;
  /** Origin (and optional base path) that relative `/api/assets/<id>` URLs are resolved against. */
  assetBaseUrl: string;
  /** Embed images stored as document assets as `data:` URIs so the file works offline. */
  inlineAssets?: boolean;
}

const ASSET_PATH = /^\/api\/assets\/([0-9a-z]+)$/i;

/** Same front matter tokenizer as the editor's parser, so `---` blocks are not rendered as text or rules. */
const remarkFrontmatter: Plugin<[], MdastRoot> = function () {
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

function visitElements(node: HastRoot | Element, fn: (el: Element) => void) {
  for (const child of node.children) {
    if (child.type === "element") {
      fn(child);
      visitElements(child, fn);
    }
  }
}

/** Rewrite asset image URLs to absolute (or embedded) form. Runs after sanitize so data: URIs are not stripped. */
function rehypeAssets(options: { assetBaseUrl: string; inlineAssets: boolean }): (tree: HastRoot) => Promise<void> {
  const base = options.assetBaseUrl.replace(/\/+$/, "");
  return async (tree) => {
    const images: Element[] = [];
    visitElements(tree, (el) => {
      if (el.tagName === "img" && typeof el.properties?.src === "string" && ASSET_PATH.test(el.properties.src)) images.push(el);
    });
    await Promise.all(
      images.map(async (el) => {
        const src = el.properties.src as string;
        const id = src.match(ASSET_PATH)![1];
        el.properties.src = base + src;
        if (!options.inlineAssets) return;
        const asset = await getAsset(id);
        if (!asset) return;
        el.properties.src = `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
      }),
    );
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Typography mirrors `.md-rich` in globals.css; colors are the same palette. */
const STYLES = `
:root { color-scheme: light; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: #ffffff; color: #374151;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
main { max-width: 820px; margin: 0 auto; padding: 48px 32px 96px; }
main > * + * { margin-top: 0.9em; }
h1, h2, h3, h4, h5, h6 { color: #111827; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; margin: 0; }
h1 { font-size: 2em; margin-top: 0.2em; }
h2 { font-size: 1.5em; margin-top: 1.4em; padding-top: 0.9em; border-top: 1px solid #e5e7eb; }
h2:first-child { border-top: none; padding-top: 0; }
h3 { font-size: 1.25em; margin-top: 1.3em; }
h4 { font-size: 1.05em; }
h5, h6 { font-size: 1em; color: #374151; }
p { margin: 0; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { margin: 0; padding-left: 1.6em; }
li + li { margin-top: 0.25em; }
li > p + p, li > ul, li > ol { margin-top: 0.25em; }
li.task-list-item { list-style: none; margin-left: -1.6em; padding-left: 1.6em; position: relative; }
li.task-list-item > input[type="checkbox"] { position: absolute; left: 0; top: 0.35em; margin: 0; width: 1em; height: 1em; accent-color: #2563eb; }
li.task-list-item:has(> input:checked) { color: #6b7280; }
blockquote { border-left: 3px solid #d1d5db; color: #6b7280; margin: 0; padding: 0.1em 0 0.1em 1.1em; }
pre {
  background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; color: #111827;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em; line-height: 1.6; overflow-x: auto; padding: 14px 16px; white-space: pre;
}
pre code { background: transparent; border: none; font-size: inherit; padding: 0; color: inherit; }
code {
  background: #f3f4f6; border-radius: 4px; color: #be185d; padding: 0.1em 0.35em; font-size: 0.875em;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.6em 0; }
img { max-width: 100%; height: auto; border-radius: 8px; }
table { border-collapse: collapse; width: 100%; margin: 0; }
th, td { border: 1px solid #d1d5db; padding: 6px 10px; vertical-align: top; text-align: left; }
th { background: #f9fafb; font-weight: 600; color: #111827; }
del { color: #6b7280; }
.hljs-comment, .hljs-quote { color: #6b7280; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-name { color: #7c3aed; }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: #047857; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-link, .hljs-variable, .hljs-template-variable { color: #b45309; }
.hljs-title, .hljs-section, .hljs-function .hljs-title, .hljs-title.function_, .hljs-title.class_ { color: #1d4ed8; }
.hljs-attr, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-selector-pseudo, .hljs-type, .hljs-built_in, .hljs-params { color: #0f766e; }
.hljs-deletion { color: #b91c1c; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
@media print {
  @page { margin: 0.75in; }
  body { font-size: 11pt; color: #111827; }
  main { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: underline; }
  pre, blockquote, table, img, figure { break-inside: avoid; page-break-inside: avoid; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  pre { white-space: pre-wrap; word-break: break-word; overflow: visible; }
}
`;

export interface RenderedHeading {
  /** The `id` attribute rehype-slug put on the heading element (the anchor target). */
  id: string;
  level: number;
  text: string;
}

export interface RenderMarkdownBodyOptions {
  /** Origin (and optional base path) that relative `/api/assets/<id>` URLs are resolved against; "" keeps them relative. */
  assetBaseUrl: string;
  inlineAssets?: boolean;
}

export interface RenderedMarkdownBody {
  /** Sanitized HTML fragment (rehype-sanitize ran before slug/highlight/asset rewriting). */
  html: string;
  headings: RenderedHeading[];
}

const HEADING_TAG = /^h([1-6])$/;

function textOf(node: Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += textOf(child);
  }
  return out;
}

/** Collect headings (after rehype-slug has assigned ids) into the sink. */
function rehypeCollectHeadings(sink: RenderedHeading[]): (tree: HastRoot) => void {
  return (tree) => {
    visitElements(tree, (el) => {
      const m = HEADING_TAG.exec(el.tagName);
      if (!m || typeof el.properties?.id !== "string") return;
      sink.push({ id: el.properties.id, level: Number(m[1]), text: textOf(el).trim() });
    });
  };
}

/**
 * Render Markdown to a sanitized HTML fragment with the same pipeline the HTML export and
 * the reader page share: GFM, front matter stripped, rehype-sanitize, slug ids, hljs classes.
 */
export async function renderMarkdownBody(markdown: string, { assetBaseUrl, inlineAssets = false }: RenderMarkdownBodyOptions): Promise<RenderedMarkdownBody> {
  const headings: RenderedHeading[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkRehype, { handlers: { yaml: () => undefined, toml: () => undefined } })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeSlug)
    .use(() => rehypeCollectHeadings(headings))
    .use(rehypeHighlight)
    .use(() => rehypeAssets({ assetBaseUrl, inlineAssets }))
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings };
}

/** SHA-256 of the document text; the reader polls this to detect changes without diffing bodies. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Render a Markdoc document as a standalone HTML5 page: same GFM features the editor
 * supports, sanitized, with embedded styles and no external requests except images.
 */
export async function renderDocumentHtml({ title, markdown, assetBaseUrl, inlineAssets = false }: RenderDocumentHtmlOptions): Promise<string> {
  const { html } = await renderMarkdownBody(markdown, { assetBaseUrl, inlineAssets });

  const safeTitle = escapeHtml(title || "Document");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Markdoc">
<title>${safeTitle}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="markdoc">
${html}
</main>
</body>
</html>
`;
}
