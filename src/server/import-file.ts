import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { customAlphabet } from "nanoid";
import { getDb, schema, type Tx } from "@/server/db";
import { addVersion, createDocument, setDocumentText } from "@/server/documents";
import { boundTitle } from "@/server/document-title";
import { AssetError, assetUrl, cleanAssetName, normalizeMime, sha256Hex, validateAsset, type PutAssetInput, type StoredAsset } from "@/server/assets";
import { IMPORT_EXTENSIONS_LIST, importFormatFor, type ImportFormat } from "@/lib/import-extensions";

// The extension map lives in `@/lib/import-extensions` (shared with the dashboard's import dialog);
// re-exported here so the route, the tests and the docs keep their `@/server/import-file` names.
export { IMPORT_EXTENSIONS, IMPORT_EXTENSIONS_LIST, fileExtension, importFormatFor, type ImportFormat } from "@/lib/import-extensions";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_FILES = 20;

/** Validation failure the caller should report to the client (`status` is an HTTP status code). */
export class ImportError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
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

/** Front matter `title`, else the first H1, else the file name without its extension; clipped to the document-title maximum. */
export function titleForImport(content: string, fileName: string): string {
  return boundTitle(frontMatterTitle(content) ?? firstHeading(content) ?? fileStem(fileName));
}

// GitHub-style sanitising plus `input` checkboxes so task lists survive the round trip.
const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  // Drop these with their text; the default only strips <script> and would keep "<title>" and CSS as prose.
  strip: [...(defaultSchema.strip ?? []), "style", "title", "head", "noscript", "template", "svg"],
  tagNames: [...(defaultSchema.tagNames ?? []), "input"],
  attributes: {
    ...defaultSchema.attributes,
    input: ["type", "checked", "disabled"],
    code: [["className", /^language-./]],
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

/**
 * Turn the raw text of one file into Markdown plus a title. Pure; no database access.
 * The title (explicit, front matter, first H1, `<title>` or file name — in that order) is clipped to
 * the document-title maximum; the content is kept whole, including the full heading.
 */
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
  const title = boundTitle(input.title?.trim() || frontMatterTitle(content) || firstHeading(content) || fallback || fileStem(input.name));
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

/** A file whose document could not be created. Nothing of it exists; sending it again is a clean start. */
export interface FailedImport {
  /** Position of the file in the request's `files` order — names can repeat within one batch. */
  index: number;
  name: string;
  /** Client-safe message: a validation message, else "Unexpected error" (the cause is in the server log). */
  error: string;
}

export interface ImportFilesResult {
  /** The created documents, in the order of the files that succeeded. */
  documents: ImportedDocument[];
  /** Files that were not imported; empty when every file was. */
  failed: FailedImport[];
}

/** Size/type/count checks shared by the route and the server function. Throws {@link ImportError}. */
export function validateImportFiles(files: { name: string; size: number }[]): void {
  if (files.length === 0) throw new ImportError(400, "No files to import");
  if (files.length > MAX_IMPORT_FILES) throw new ImportError(400, `Import at most ${MAX_IMPORT_FILES} files at a time`);
  for (const f of files) {
    if (!importFormatFor(f.name)) throw new ImportError(415, `“${f.name}”: ${IMPORT_EXTENSIONS_LIST}`);
    if (f.size > MAX_IMPORT_BYTES) throw new ImportError(413, `“${f.name}” is larger than 2 MB`);
  }
}

/**
 * Decode an uploaded file: UTF-16 when it starts with a `FF FE` / `FE FF` byte-order mark (Word's
 * "Unicode" text export, PowerShell's default redirection), UTF-8 otherwise. `TextDecoder` drops the
 * BOM itself. The result still containing U+0000 means the bytes were not text (a binary renamed
 * `.md`, UTF-16 without a BOM): Postgres `text` cannot store it, so it is refused as `415`.
 */
export function decodeImportBytes(name: string, bytes: Uint8Array): string {
  const encoding = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, { fatal: false }).decode(bytes);
  if (text.includes("\0")) throw new ImportError(415, `“${name}” is not a text file`);
  return text;
}

const assetNanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

/**
 * `putAsset` for a document that so far exists only inside `tx`: the store's validation, name cleaning
 * and same-bytes dedupe, written on the transaction. `putAsset` itself runs on the shared connection,
 * which cannot see the uncommitted document (`asset.document_id` is a foreign key) and, on PGlite,
 * would wait for the transaction's lock forever. `seen` dedupes by digest within the new document.
 */
async function putImportedAsset(tx: Tx, input: PutAssetInput, seen: Map<string, StoredAsset>): Promise<StoredAsset> {
  const mime = normalizeMime(input.mime);
  validateAsset({ mime, bytes: input.bytes });
  const hash = sha256Hex(input.bytes);
  const existing = seen.get(hash);
  if (existing) return existing;
  const id = assetNanoid();
  const name = cleanAssetName(input.name, mime);
  await tx.insert(schema.assets).values({ id, documentId: input.documentId, userId: input.userId, name, mime, size: input.bytes.byteLength, sha256: hash, data: input.bytes });
  const stored = { id, url: assetUrl(id), name, mime, size: input.bytes.byteLength };
  seen.set(hash, stored);
  return stored;
}

/**
 * Create one document from already-converted Markdown, attaching matching images as assets.
 * The row is created first because `asset.document_id` is a foreign key; once the asset URLs are
 * known the text is rewritten with {@link setDocumentText}, which writes `content` and `ystate`
 * together (the document cannot be open in an editor yet, so a fresh seed is safe). Row, assets,
 * rewritten text and version land in one transaction: a failure part-way used to leave a document
 * without its version or its rewritten text, which a re-import then duplicated (audit #1202 F10).
 */
async function createImported(ownerId: string, converted: ConvertedImport, images: ImportImageInput[], source: string): Promise<ImportedDocument> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const warnings = [...converted.warnings];
    const doc = await createDocument({ ownerId, title: converted.title, content: converted.content }, tx);
    let content = converted.content;

    const wanted = relativeImageNames(content);
    if (wanted.length) {
      const urls = new Map<string, string>();
      const seen = new Map<string, StoredAsset>();
      const byName = new Map(images.map((i) => [i.name.split(/[\\/]/).pop() ?? i.name, i]));
      const byLower = new Map(Array.from(byName, ([k, v]) => [k.toLowerCase(), v]));
      for (const name of wanted) {
        const image = byName.get(name) ?? byLower.get(name.toLowerCase());
        if (!image) continue;
        try {
          const asset = await putImportedAsset(tx, { documentId: doc.id, userId: ownerId, name: image.name, mime: image.mime, bytes: image.bytes }, seen);
          urls.set(name, asset.url);
        } catch (err) {
          // An unusable image (type, size, empty, scripted SVG) is refused before any statement runs, so the
          // transaction is intact and the image is a warning as before. A failed statement aborted it: rethrow.
          if (!(err instanceof AssetError)) throw err;
          warnings.push(`“${name}”: ${err.message}`);
        }
      }
      const rewritten = rewriteRelativeImages(content, urls);
      if (rewritten.missing.length) warnings.push(missingImagesWarning(rewritten.missing));
      if (rewritten.content !== content) {
        content = rewritten.content;
        await setDocumentText(doc.id, content, tx);
      }
    }

    await addVersion({ documentId: doc.id, content, kind: "import", createdBy: ownerId, title: `Imported from ${source}` }, tx);
    return { id: doc.id, title: doc.title, warnings };
  });
}

/** What the client may learn about a failed file: validation messages, never a driver's (it carries the SQL and its parameters). */
function failureMessage(err: unknown): string {
  return err instanceof ImportError || err instanceof AssetError ? err.message : "Unexpected error";
}

/**
 * Import uploaded files as new documents owned by `ownerId`. Images dropped alongside the files
 * become assets of whichever document references them by basename.
 *
 * Every file is validated and converted before any document is created, so a bad file rejects the
 * whole batch. Creation is then attempted for every file, each in its own transaction, and the outcome
 * reported per file: `documents` for the ones that exist, `failed` for the ones that do not — so the
 * caller sees what was imported instead of importing all of it again. When nothing was created the
 * first error propagates and the route answers non-2xx: nothing changed.
 */
export async function importFiles(input: { ownerId: string; files: ImportFileInput[]; images?: ImportImageInput[] }): Promise<ImportFilesResult> {
  validateImportFiles(input.files.map((f) => ({ name: f.name, size: f.bytes.byteLength })));
  const images = input.images ?? [];
  // Decode and convert every file before creating any document, so a binary third file does not leave the first two imported.
  const converted: { converted: ConvertedImport; source: string }[] = [];
  for (const file of input.files) {
    const format = importFormatFor(file.name)!;
    converted.push({
      converted: await convertImport({ name: file.name, text: decodeImportBytes(file.name, file.bytes), format }),
      source: file.name.split(/[\\/]/).pop() ?? file.name,
    });
  }
  const documents: ImportedDocument[] = [];
  const failed: FailedImport[] = [];
  let firstError: unknown;
  for (const [index, c] of converted.entries()) {
    try {
      documents.push(await createImported(input.ownerId, c.converted, images, c.source));
    } catch (err) {
      firstError ??= err;
      failed.push({ index, name: input.files[index].name, error: failureMessage(err) });
      console.error(`[import] creating the document for file ${index + 1} of ${converted.length} failed`, err);
    }
  }
  if (documents.length === 0 && failed.length > 0) throw firstError;
  return { documents, failed };
}

/** Import a string (Markdown, plain text or HTML) as one new document; used by the MCP tool. */
export async function importText(input: { ownerId: string; content: string; format: ImportFormat; title?: string | null }): Promise<ImportedDocument> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_IMPORT_BYTES) throw new ImportError(413, "Content is larger than 2 MB");
  if (input.content.includes("\0") || input.title?.includes("\0")) throw new ImportError(400, "Text may not contain NUL characters");
  const fallback = input.format === "html" ? "Imported page" : "Imported text";
  const converted = await convertImport({ name: fallback, text: input.content, format: input.format, title: input.title });
  return createImported(input.ownerId, converted, [], input.format === "html" ? "HTML" : input.format === "text" ? "text" : "Markdown");
}
