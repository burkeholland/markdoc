import { createHash } from "node:crypto";
import { getAsset } from "@/server/assets";
import { findUnrenderable, UnrenderableDocumentError } from "@/editor/markdown/renderable";
import { type RenderedHeading } from "./render-markdown";
import { renderOffThread, RenderTimeoutError, RENDER_TIMEOUT_MS } from "./render-pool";

export type { RenderedHeading };

export interface RenderDocumentHtmlOptions {
  title: string;
  markdown: string;
  /** Origin (and optional base path) that relative `/api/assets/<id>` URLs are resolved against. */
  assetBaseUrl: string;
  /** Embed images stored as document assets as `data:` URIs so the file works offline. */
  inlineAssets?: boolean;
  /** Parse budget; the render is abandoned (worker terminated) and `UnrenderableDocumentError` thrown past it. */
  timeoutMs?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/**
 * Typography mirrors `.md-rich` in globals.css (block rhythm: see "Markdown prose rhythm" there); colours
 * are the light palette (Ink & teal). Headings use Fraunces like the app (display type in globals.css):
 * the `@import` fetches it when the reader is online; offline the stack falls through to a system serif,
 * so the export still reads as the same design.
 */
const STYLES = `
@import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,600,30&display=swap");
:root { color-scheme: light; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: #ffffff; color: #44403c;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
main {
  max-width: 820px; margin: 0 auto; padding: 48px 32px 96px;
  --md-space: 0.9em; --md-space-heading-after: 0.45em;
  --md-space-heading-before-h2: 1.6em; --md-space-heading-before-h3: 1.25em; --md-space-heading-before-h4: 1em;
}
/* No Tailwind preflight here: zero the UA margins first, then space blocks from the child side with margin-top only. */
h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, table, figure, hr { margin: 0; }
main > * + * { margin-top: var(--md-space); }
main > hr, main > hr + * { margin-top: calc(var(--md-space) * 1.75); }
h1, h2, h3, h4, h5, h6 { color: #1c1917; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; }
h1, h2, h3 {
  font-family: Fraunces, Georgia, "Times New Roman", serif; font-weight: 600; letter-spacing: -0.005em;
  font-variation-settings: "opsz" 36, "SOFT" 30;
}
h1 { font-size: 2em; margin-top: var(--md-space-heading-before-h2); }
h2 { font-size: 1.5em; margin-top: calc(var(--md-space-heading-before-h2) - 0.6em); padding-top: 0.6em; border-top: 1px solid #e7e5e4; }
h2:first-child { border-top: none; padding-top: 0; }
h3 { font-size: 1.25em; margin-top: var(--md-space-heading-before-h3); }
h4 { font-size: 1.05em; }
h5, h6 { font-size: 1em; color: #44403c; }
h4, h5, h6 { margin-top: var(--md-space-heading-before-h4); }
main > :is(h1, h2, h3, h4, h5, h6) + * { margin-top: var(--md-space-heading-after); }
main > :first-child { margin-top: 0; }
a { color: #0f766e; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.6em; }
li + li { margin-top: 0.25em; }
li > p + p, li > ul, li > ol { margin-top: 0.25em; }
li.task-list-item { list-style: none; margin-left: -1.6em; padding-left: 1.6em; position: relative; }
li.task-list-item > input[type="checkbox"] { position: absolute; left: 0; top: 0.35em; margin: 0; width: 1em; height: 1em; accent-color: #0f766e; }
li.task-list-item:has(> input:checked) { color: #57534e; }
blockquote { border-left: 3px solid #d6d3d1; color: #57534e; padding: 0.1em 0 0.1em 1.1em; }
pre {
  background: #f7f5f0; border: 1px solid #e7e5e4; border-radius: 10px; color: #1c1917;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em; line-height: 1.6; overflow-x: auto; padding: 14px 16px; white-space: pre;
}
pre code { background: transparent; border: none; font-size: inherit; padding: 0; color: inherit; }
code {
  background: #efece6; border-radius: 4px; color: #be185d; padding: 0.1em 0.35em; font-size: 0.875em;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
hr { border: none; border-top: 1px solid #e7e5e4; }
img { max-width: 100%; height: auto; border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #d6d3d1; padding: 6px 10px; vertical-align: top; text-align: left; }
th { background: #f7f5f0; font-weight: 600; color: #1c1917; }
del { color: #57534e; }
.hljs-comment, .hljs-quote { color: #57534e; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-name { color: #7c3aed; }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta .hljs-string { color: #047857; }
.hljs-number, .hljs-symbol, .hljs-bullet, .hljs-link, .hljs-variable, .hljs-template-variable { color: #b45309; }
.hljs-title, .hljs-section, .hljs-function .hljs-title, .hljs-title.function_, .hljs-title.class_ { color: #0f766e; }
.hljs-attr, .hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-selector-pseudo, .hljs-type, .hljs-built_in, .hljs-params { color: #0f766e; }
.hljs-deletion { color: #b91c1c; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
@media print {
  @page { margin: 0.75in; }
  body { font-size: 11pt; color: #1c1917; }
  main { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: underline; }
  pre, blockquote, table, img, figure { break-inside: avoid; page-break-inside: avoid; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  pre { white-space: pre-wrap; word-break: break-word; overflow: visible; }
}
`;

export interface RenderMarkdownBodyOptions {
  /** Origin (and optional base path) that relative `/api/assets/<id>` URLs are resolved against; "" keeps them relative. */
  assetBaseUrl: string;
  inlineAssets?: boolean;
  /** Parse budget; defaults to RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface RenderedMarkdownBody {
  /** Sanitized HTML fragment (rehype-sanitize ran before slug/highlight/asset rewriting). */
  html: string;
  headings: RenderedHeading[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the absolute asset URLs the worker produced with `data:` URIs. The fragment came out of
 * rehype-stringify, so `src` values are double-quoted and the ids are `[0-9a-z]+`: a plain string
 * replacement on the attribute is exact. Assets that no longer exist keep their URL, as before.
 */
async function inlineAssetUrls(html: string, base: string, assetIds: string[]): Promise<string> {
  if (assetIds.length === 0) return html;
  const prefix = base.replace(/\/+$/, "");
  const assets = await Promise.all(assetIds.map((id) => getAsset(id)));
  let out = html;
  assets.forEach((asset, i) => {
    if (!asset) return;
    const uri = `data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
    out = out.replace(new RegExp(`src="${escapeRegExp(`${prefix}/api/assets/${assetIds[i]}`)}"`, "g"), () => `src="${uri}"`);
  });
  return out;
}

/**
 * Render Markdown to a sanitized HTML fragment with the same pipeline the HTML export and
 * the reader page share: GFM, front matter stripped, rehype-sanitize, slug ids, hljs classes.
 *
 * Parsing happens on a worker thread behind a time-out, after a cheap guard on the text; a
 * document that is refused by either throws `UnrenderableDocumentError` (HTTP 422 in routes),
 * so one pathological document can never block the event loop for everyone else (#115).
 */
export async function renderMarkdownBody(markdown: string, { assetBaseUrl, inlineAssets = false, timeoutMs = RENDER_TIMEOUT_MS }: RenderMarkdownBodyOptions): Promise<RenderedMarkdownBody> {
  const reason = findUnrenderable(markdown);
  if (reason) throw new UnrenderableDocumentError(reason);
  let fragment;
  try {
    fragment = await renderOffThread(markdown, assetBaseUrl, timeoutMs);
  } catch (err) {
    if (err instanceof RenderTimeoutError) throw new UnrenderableDocumentError("timeout");
    throw err;
  }
  const html = inlineAssets ? await inlineAssetUrls(fragment.html, assetBaseUrl, fragment.assetIds) : fragment.html;
  return { html, headings: fragment.headings };
}

/** SHA-256 of the document text; the reader polls this to detect changes without diffing bodies. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Render a Markdoc document as a standalone HTML5 page: same GFM features the editor
 * supports, sanitized, with embedded styles and no external requests except images and the
 * heading font (an `@import` that degrades to a system serif offline).
 */
export async function renderDocumentHtml({ title, markdown, assetBaseUrl, inlineAssets = false, timeoutMs }: RenderDocumentHtmlOptions): Promise<string> {
  const { html } = await renderMarkdownBody(markdown, { assetBaseUrl, inlineAssets, timeoutMs });

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