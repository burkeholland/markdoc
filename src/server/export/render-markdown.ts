/**
 * The Markdown → sanitized HTML pipeline shared by the HTML/PDF export and the reader page. Its first
 * half, parsing to sanitizing, is `readerHtml` (`markdown-syntax.ts`), which link previews read too.
 *
 * This module doubles as a `worker_threads` entry (see `render-pool.ts`): when loaded off the
 * main thread it answers render requests, and link preview requests (`preview-text.ts`), over
 * `parentPort`. It must therefore stay free of database access and of `@/` path aliases, and use
 * only syntax Node can strip (it is started straight from this .ts file in development; the
 * production build bundles it with esbuild).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import type { Root as HastRoot, Element } from "hast";
// The extensions are required: in development Node loads this worker entry straight from source.
import { readerHtml } from "./markdown-syntax.ts";
import { previewText } from "../preview-text.ts";

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
  /** A known link alone on its line becomes a card (#2317); see `readerHtml`. */
  linkCards?: boolean;
}

export interface RenderedFragment {
  /** Sanitized HTML fragment (rehype-sanitize ran before slug/highlight/asset rewriting). */
  html: string;
  headings: RenderedHeading[];
  /** Ids of document assets referenced by `<img>` tags, in document order (deduplicated). */
  assetIds: string[];
}

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

function taskTextOf(node: Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element" && child.tagName !== "ul" && child.tagName !== "ol") out += taskTextOf(child);
  }
  return out;
}

function taskCheckboxOf(node: Element): Element | undefined {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "input" && child.properties?.type === "checkbox") return child;
    if (child.tagName !== "ul" && child.tagName !== "ol") {
      const checkbox = taskCheckboxOf(child);
      if (checkbox) return checkbox;
    }
  }
}

/** Give each read-only GFM task checkbox the visible text of its own list item. */
function rehypeLabelTaskCheckboxes(): (tree: HastRoot) => void {
  return (tree) => {
    visitElements(tree, (item) => {
      if (item.tagName !== "li" || !Array.isArray(item.properties?.className) || !item.properties.className.includes("task-list-item")) return;
      const checkbox = taskCheckboxOf(item);
      if (checkbox && checkbox.properties.ariaLabel === undefined) {
        checkbox.properties.ariaLabel = taskTextOf(item).replace(/\s+/g, " ").trim() || "Task";
      }
    });
  };
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
export async function renderMarkdownFragment(markdown: string, { assetBaseUrl, linkCards = false }: RenderFragmentOptions): Promise<RenderedFragment> {
  const headings: RenderedHeading[] = [];
  const assetIds: string[] = [];
  const file = await readerHtml({ linkCards })
    .use(() => rehypeLabelTaskCheckboxes())
    .use(rehypeSlug)
    .use(() => rehypeCollectHeadings(headings))
    .use(rehypeHighlight)
    .use(() => rehypeAssets(assetBaseUrl, assetIds))
    .use(rehypeStringify)
    .process(markdown);
  return { html: String(file), headings, assetIds };
}

/** A job for the worker: render `markdown`, or with `preview` find its link preview text (`previewText`). */
export type WorkerTask = { markdown: string; assetBaseUrl: string; linkCards?: boolean } | { markdown: string; preview: true };

export type WorkerRequest = WorkerTask & { id: number };

export type WorkerResponse = { id: number; ok: true; result: RenderedFragment | string } | { id: number; ok: false; error: string };

function runTask(task: WorkerTask): Promise<RenderedFragment | string> {
  if ("preview" in task) return new Promise((resolve) => resolve(previewText(task.markdown)));
  return renderMarkdownFragment(task.markdown, { assetBaseUrl: task.assetBaseUrl, linkCards: task.linkCards });
}

if (!isMainThread && parentPort && (workerData as { role?: string } | null)?.role === WORKER_ROLE) {
  const port = parentPort;
  port.on("message", (req: WorkerRequest) => {
    runTask(req).then(
      (result) => port.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse),
      (err: unknown) => port.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse),
    );
  });
}
