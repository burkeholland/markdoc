import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { addVersion, createDocument, updateDocument } from "@/server/documents";
import { AssetError, normalizeMime, putAsset } from "@/server/assets";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_FILES = 20;

export type ImportFormat = "markdown" | "text" | "html";

const FORMAT_BY_EXTENSION: Record<string, ImportFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkd": "markdown",
  ".txt": "text",
  ".text": "text",
  ".html": "html",
  ".htm": "html",
};

export const IMPORT_EXTENSIONS = Object.keys(FORMAT_BY_EXTENSION);

/** Validation failure the caller should report to the client (`status` is an HTTP status code). */
export class ImportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function fileExtension(name: string): string {
  const m = /(\.[a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** `markdown`, `text` or `html` from a file name, or `null` for anything Markdoc cannot import. */
export function importFormatFor(name: string): ImportFormat | null {
  return FORMAT_BY_EXTENSION[fileExtension(name)] ?? null;
}

export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.[a-z0-9]+$/i, "").trim() || "Untitled";
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** The `---` block at the top of the text, or null. Returns the span so the body can be searched separately. */
function frontMatterSpan(content: string): { from: number; to: number; body: string } | null {
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(content);
  if (!m) return null;
  return { from: 0, to: m[0].length, body: m[1] };
}

/** `title:` from YAML front matter (quotes stripped), or null. */
export function frontMatterTitle(content: string): string | null {
  const fm = frontMatterSpan(content);
  if (!fm) return null;
  const line = /^title[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(fm.body);
  if (!line) return null;
  const raw = line[1].trim();
  const unquoted = /^(['"])(.*)\1$/.exec(raw);
  const title = (unquoted ? unquoted[2] : raw).trim();
  return title || null;
}

/** First ATX H1 outside front matter and fenced code, with inline markup stripped. */
export function firstHeading(content: string): string | null {
  const fm = frontMatterSpan(content);
  const body = fm ? content.slice(fm.to) : content;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].replace(/[*_`]/g, "").trim() || null;
  }
  return null;
}

/** Front matter `title`, else the first H1, else the file name without its extension. */
export function titleForImport(content: string, fileName: string): string {
  return frontMatterTitle(content) ?? firstHeading(content) ?? fileStem(fileName);
}

// GitHub-style sanitising plus `input` checkboxes so task lists survive the round trip.
const sanitizeSchema = {
  ...defaultSchema,
  // Drop these with their text; the default only strips <script> and would keep "<title>" and CSS as prose.
  strip: [...(defaultSchema.strip ?? []), "style", "title", "head", "noscript", "template", "svg"],
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    input: ["type", "checked", "disabled"],
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
  },
};

const htmlProcessor = unified()
  .use(rehypeParse, { fragment: false })
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", fences: true, rule: "-", emphasis: "_", strong: "*", listItemIndent: "one" });

/** Best-effort HTML → GFM Markdown. Scripts, styles and event handlers are dropped before conversion. */
export async function htmlToMarkdown(html: string): Promise<string> {
  const file = await htmlProcessor.process(html);
  return String(file).replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function htmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text = m?.[1].replace(/\s+/g, " ").trim();
  return text || null;
}

export interface ConvertedImport {
  title: string;
  content: string;
  warnings: string[];
}

/** Turn the raw text of one file into Markdown plus a title. Pure; no database access. */
export async function convertImport(input: { name: string; text: string; format: ImportFormat; title?: string | null }): Promise<ConvertedImport> {
  const warnings: string[] = [];
  const text = normalizeLineEndings(input.text);
  let content: string;
  let fallback: string | null = null;
  if (input.format === "html") {
    content = await htmlToMarkdown(text);
    fallback = htmlTitle(text);
    if (!content.trim()) warnings.push("The HTML had no readable content");
  } else {
    content = text.endsWith("\n") ? text : text + "\n";
  }
  const title = input.title?.trim() || frontMatterTitle(content) || firstHeading(content) || fallback || fileStem(input.name);
  return { title, content, warnings };
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)((?:\s+("[^"]*"|'[^']*'|\([^)]*\)))?)\s*\)/g;

export function isRelativeImagePath(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false; // http:, https:, data:, mailto:…
  if (p.startsWith("/") || p.startsWith("#")) return false;
  return true;
}

export function imageBasename(path: string): string {
  const bare = path.replace(/^<|>$/g, "").split(/[?#]/)[0];
  const last = bare.split(/[\\/]/).pop() ?? bare;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Rewrite `![alt](relative/path.png)` to the asset URL whose file name matches the path's basename.
 * Unmatched relative paths are left alone and reported in `missing` (deduplicated, in order).
 */
export function rewriteRelativeImages(content: string, urls: Map<string, string>): { content: string; missing: string[] } {
  const missing: string[] = [];
  const lower = new Map(Array.from(urls, ([k, v]) => [k.toLowerCase(), v]));
  const out = content.replace(IMAGE_RE, (whole, alt: string, target: string, titlePart: string) => {
    if (!isRelativeImagePath(target)) return whole;
    const base = imageBasename(target);
    const url = urls.get(base) ?? lower.get(base.toLowerCase());
    if (!url) {
      if (!missing.includes(base)) missing.push(base);
      return whole;
    }
    return `![${alt}](${url}${titlePart ?? ""})`;
  });
  return { content: out, missing };
}

/** Relative image basenames referenced by the Markdown, in order, deduplicated. */
export function relativeImageNames(content: string): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(IMAGE_RE)) {
    if (!isRelativeImagePath(m[2])) continue;
    const base = imageBasename(m[2]);
    if (!names.includes(base)) names.push(base);
  }
  return names;
}

export function missingImagesWarning(missing: string[]): string {
  const shown = missing.slice(0, 5).join(", ");
  const more = missing.length > 5 ? `, +${missing.length - 5} more` : "";
  return `${missing.length} image${missing.length === 1 ? "" : "s"} not found: ${shown}${more}`;
}

export interface ImportFileInput {
  name: string;
  bytes: Uint8Array;
}

export interface ImportImageInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ImportedDocument {
  id: string;
  title: string;
  warnings: string[];
}

/** Size/type/count checks shared by the route and the server function. Throws {@link ImportError}. */
export function validateImportFiles(files: { name: string; size: number }[]): void {
  if (files.length === 0) throw new ImportError(400, "No files to import");
  if (files.length > MAX_IMPORT_FILES) throw new ImportError(400, `Import at most ${MAX_IMPORT_FILES} files at a time`);
  for (const f of files) {
    if (!importFormatFor(f.name)) throw new ImportError(415, `“${f.name}”: only .md, .markdown, .txt, .html and .htm files can be imported`);
    if (f.size > MAX_IMPORT_BYTES) throw new ImportError(413, `“${f.name}” is larger than 2 MB`);
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Create one document from already-converted Markdown, attaching matching images as assets. */
async function createImported(ownerId: string, converted: ConvertedImport, images: ImportImageInput[], source: string): Promise<ImportedDocument> {
  const warnings = [...converted.warnings];
  const doc = await createDocument({ ownerId, title: converted.title, content: converted.content });
  let content = converted.content;

  const wanted = relativeImageNames(content);
  if (wanted.length) {
    const urls = new Map<string, string>();
    const byName = new Map(images.map((i) => [i.name.split(/[\\/]/).pop() ?? i.name, i]));
    const byLower = new Map(Array.from(byName, ([k, v]) => [k.toLowerCase(), v]));
    for (const name of wanted) {
      const image = byName.get(name) ?? byLower.get(name.toLowerCase());
      if (!image) continue;
      try {
        const asset = await putAsset({ documentId: doc.id, userId: ownerId, name: image.name, mime: normalizeMime(image.mime), bytes: image.bytes });
        urls.set(name, asset.url);
      } catch (err) {
        warnings.push(`“${name}”: ${err instanceof AssetError ? err.message : "could not be uploaded"}`);
      }
    }
    const rewritten = rewriteRelativeImages(content, urls);
    if (rewritten.missing.length) warnings.push(missingImagesWarning(rewritten.missing));
    if (rewritten.content !== content) {
      content = rewritten.content;
      await updateDocument(doc.id, { content });
    }
  }

  await addVersion({ documentId: doc.id, content, kind: "import", createdBy: ownerId, title: `Imported from ${source}` });
  return { id: doc.id, title: doc.title, warnings };
}

/**
 * Import uploaded files as new documents owned by `ownerId`. Images dropped alongside the files
 * become assets of whichever document references them by basename.
 */
export async function importFiles(input: { ownerId: string; files: ImportFileInput[]; images?: ImportImageInput[] }): Promise<ImportedDocument[]> {
  validateImportFiles(input.files.map((f) => ({ name: f.name, size: f.bytes.byteLength })));
  const images = input.images ?? [];
  const out: ImportedDocument[] = [];
  for (const file of input.files) {
    const format = importFormatFor(file.name)!;
    const converted = await convertImport({ name: file.name, text: decode(file.bytes), format });
    out.push(await createImported(input.ownerId, converted, images, file.name.split(/[\\/]/).pop() ?? file.name));
  }
  return out;
}

/** Import a string (Markdown, plain text or HTML) as one new document; used by the MCP tool. */
export async function importText(input: { ownerId: string; content: string; format: ImportFormat; title?: string | null }): Promise<ImportedDocument> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_IMPORT_BYTES) throw new ImportError(413, "Content is larger than 2 MB");
  const fallback = input.format === "html" ? "Imported page" : "Imported text";
  const converted = await convertImport({ name: fallback, text: input.content, format: input.format, title: input.title });
  return createImported(input.ownerId, converted, [], input.format === "html" ? "HTML" : input.format === "text" ? "text" : "Markdown");
}
