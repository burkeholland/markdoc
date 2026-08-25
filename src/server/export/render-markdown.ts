/**
 * The Markdown → sanitized HTML pipeline shared by the HTML/PDF export and the reader page.
 *
 * This module doubles as a `worker_threads` entry (see `render-pool.ts`): when loaded off the
 * main thread it answers render requests over `parentPort`. It must therefore stay free of
 * database access and of `@/` path aliases, and use only syntax Node can strip (it is started
 * straight from this .ts file in development; the production build bundles it with esbuild).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
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

export const WORKER_ROLE = "markdoc-markdown-render";

export const ASSET_PATH = /^\/api\/assets\/([0-9a-z]+)$/i;

export interface RenderedHeading {
  /** The `id` attribute rehype-slug put on the heading element (the anchor target). */
  id: string;
  level: number;
  text: string;
}

export interface RenderFragmentOptions {
  /** Origin (and optional base path) that relative `/api/assets/<id>` URLs are resolved against; "" keeps them relative. */
  assetBaseUrl: string;
}

export interface RenderedFragment {
  /** Sanitized HTML fragment (rehype-sanitize ran before slug/highlight/asset rewriting). */
  html: string;
  headings: RenderedHeading[];
  /** Ids of document assets referenced by `<img>` tags, in document order (deduplicated). */
  assetIds: string[];
}

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

/** Rewrite asset image URLs to absolute form and collect their ids. Runs after sanitize. */
function rehypeAssets(base: string, sink: string[]): (tree: HastRoot) => void {
  const prefix = base.replace(/\/+$/, "");
  return (tree) => {
    visitElements(tree, (el) => {
      if (el.tagName !== "img" || typeof el.properties?.src !== "string") return;
      const m = ASSET_PATH.exec(el.properties.src);
      if (!m) return;
      el.properties.src = prefix + el.properties.src;
      if (!sink.includes(m[1])) sink.push(m[1]);
    });
  };
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
 * Render Markdown to a sanitized HTML fragment: GFM, front matter stripped, rehype-sanitize,
 * slug ids, hljs classes, asset URLs made absolute. CPU-bound and synchronous apart from the
 * unified plumbing; callers on the server go through `render-pool.ts` instead.
 */
export async function renderMarkdownFragment(markdown: string, { assetBaseUrl }: RenderFragmentOptions): Promise<RenderedFragment> {
  const headings: RenderedHeading[] = [];
  const assetIds: string[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkRehype, { handlers: { yaml: () => undefined, toml: () => undefined } })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeSlug)
    .use(() => rehypeCollectHeadings(headings))
    .use(rehypeHighlight)
    .use(() => rehypeAssets(assetBaseUrl, assetIds))
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings, assetIds };
}

export interface WorkerRequest {
  id: number;
  markdown: string;
  assetBaseUrl: string;
}

export type WorkerResponse = { id: number; ok: true; result: RenderedFragment } | { id: number; ok: false; error: string };

if (!isMainThread && parentPort && (workerData as { role?: string } | null)?.role === WORKER_ROLE) {
  const port = parentPort;
  port.on("message", (req: WorkerRequest) => {
    renderMarkdownFragment(req.markdown, { assetBaseUrl: req.assetBaseUrl }).then(
      (result) => port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse),
      (err: unknown) => port.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse),
    );
  });
}
