import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";
import { IMAGE_TOO_LARGE_MESSAGE, MAX_IMAGE_BYTES } from "@/lib/image-limits";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export const MAX_ASSET_BYTES = MAX_IMAGE_BYTES;

export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/** Validation failure the caller should report to the client (status is an HTTP status code). */
export class AssetError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PutAssetInput {
  documentId: string;
  userId: string | null;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface StoredAsset {
  id: string;
  url: string;
  name: string;
  mime: string;
  size: number;
}

export interface AssetContent {
  mime: string;
  bytes: Uint8Array;
  size: number;
  documentId: string;
  name: string;
}

/**
 * Where asset bytes live. The database implementation is the only one today;
 * a blob-storage implementation can replace it later without touching callers.
 */
export interface AssetStore {
  put(input: PutAssetInput): Promise<StoredAsset>;
  get(id: string): Promise<AssetContent | null>;
  /** The asset only if it belongs to `documentId`; an id owned by another document is `null`, as if missing. */
  getForDocument(documentId: string, id: string): Promise<AssetContent | null>;
}

export function assetUrl(id: string): string {
  return `/api/assets/${id}`;
}

export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * The file as text: UTF-16 when it starts with a `FF FE` / `FE FF` byte-order mark, UTF-8 otherwise
 * (`TextDecoder` drops the mark itself). The script check reads this, so a UTF-16 SVG is checked as
 * the text a browser would parse, not as UTF-8 with a NUL between every letter.
 */
function decodeText(bytes: Uint8Array): string {
  const encoding = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

/** Reject SVG that could run script when rendered inline (`<script>`, `on*=` handlers, `javascript:` URLs). */
export function isUnsafeSvg(bytes: Uint8Array): boolean {
  const text = decodeText(bytes);
  return /<\s*script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript\s*:/i.test(text) || /<\s*foreignObject\b/i.test(text);
}

/** What a file is by its own bytes: one of the allowed image types, other markup (`xml`), or nothing we store (`null`). */
export type ContentType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml" | "xml" | null;

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (bytes.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** How many fill bytes may stand between a JPEG's start marker and its first marker segment. Real files have none or very few. */
const MAX_JPEG_FILL_BYTES = 16;
const XML_SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
/** Encodings an XML declaration may name. All keep ASCII as ASCII (or carry a byte-order mark), so the script check reads what a browser parses. */
const TEXT_ENCODINGS = new Set(["utf-8", "utf8", "utf-16", "us-ascii", "ascii", "iso-8859-1", "latin1", "windows-1252"]);

/**
 * The root element's name when `text` is markup (`<?xml …?>`, comments, a doctype and whitespace may come
 * first, as drawing tools write them), `""` for markup whose root cannot be read, `null` for anything else.
 * A linear scan with `indexOf`: no pattern here can run long on a 5 MB file.
 */
function markupRoot(text: string): string | null {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && XML_SPACE.has(text.charCodeAt(i))) i++;
  };
  skipSpace();
  if (text[i] !== "<") return null;
  for (;;) {
    skipSpace();
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) return "";
      const encoding = text.startsWith("<?xml", i) ? /\bencoding\s*=\s*["']([^"']*)["']/i.exec(text.slice(i, Math.min(end, i + 200)))?.[1] : undefined;
      if (encoding !== undefined && !TEXT_ENCODINGS.has(encoding.trim().toLowerCase())) return "";
      i = end + 2;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return "";
      i = end + 3;
    } else if (text.startsWith("<!DOCTYPE", i)) {
      // Up to the closing `>`, stepping over quoted strings and an internal subset in `[ … ]` (Illustrator writes one).
      let depth = 0;
      let quote = "";
      let end = -1;
      for (let j = i + 9; j < text.length; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === "<" && depth > 0 && j + 3 < text.length && (text[j + 1] === "?" || (text[j + 1] === "!" && text[j + 2] === "-" && text[j + 3] === "-"))) {
          // Inside the internal subset a comment or a processing instruction is one unit (four characters at the least): a quote or a bracket in it means nothing.
          const comment = text[j + 1] === "!";
          const close = text.indexOf(comment ? "-->" : "?>", j + (comment ? 4 : 2));
          if (close < 0) break;
          j = close + (comment ? 2 : 1);
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "[") depth++;
        else if (c === "]") depth = Math.max(0, depth - 1);
        else if (c === ">" && depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) return "";
      i = end + 1;
    } else break;
  }
  if (text[i] !== "<") return "";
  let end = i + 1;
  // Only the first few characters matter: no element this check knows has a long name.
  while (end < text.length && end - i <= 16 && /[A-Za-z0-9_:.-]/.test(text[end])) end++;
  // `svg:svg` (a prefixed root) is the same element.
  return text.slice(i + 1, end).split(":").pop() ?? "";
}

/**
 * What `bytes` are, from signatures and text only: no image library reads user bytes to decide this.
 * Each binary type must show its signature AND the first structure that follows it (PNG's `IHDR`, a JPEG
 * marker, GIF's first block, WebP's first chunk), so a signature glued in front of other content is not
 * taken for an image. Text counts as SVG only when its root element is `svg`.
 */
export function detectContentType(bytes: Uint8Array): ContentType {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    // The first chunk is always IHDR, 13 bytes long.
    return bytes.length >= 33 && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 && ascii(bytes, 12, "IHDR") ? "image/png" : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Start of image, then a marker segment (JFIF, Exif, a quantisation table, …): `FF` and a marker byte.
    // The standard allows fill bytes (more `FF`) before a marker and decoders skip them; so does this, up to a fixed few.
    let at = 2;
    while (at < 2 + MAX_JPEG_FILL_BYTES && bytes[at] === 0xff && bytes[at + 1] === 0xff) at++;
    return bytes[at] === 0xff && bytes[at + 1] >= 0xc0 && bytes[at + 1] <= 0xfe ? "image/jpeg" : null;
  }
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) {
    if (bytes.length < 14) return null;
    // Header (6), logical screen (7), the global colour table when flagged, then an extension, an image or the trailer.
    const next = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0);
    return bytes[next] === 0x21 || bytes[next] === 0x2c || bytes[next] === 0x3b ? "image/gif" : null;
  }
  if (ascii(bytes, 0, "RIFF")) {
    return bytes.length >= 20 && ascii(bytes, 8, "WEBP") && (ascii(bytes, 12, "VP8 ") || ascii(bytes, 12, "VP8L") || ascii(bytes, 12, "VP8X")) ? "image/webp" : null;
  }
  const text = decodeText(bytes);
  // Text never holds U+0000: this is a binary file (a gzip-compressed .svgz, UTF-16 without its mark, …).
  if (text.includes("\0")) return null;
  const root = markupRoot(text);
  if (root === null) return null;
  return root === "svg" ? "image/svg+xml" : "xml";
}

const TYPE_LABEL: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
  "image/svg+xml": "SVG",
};

/** The message for bytes that are not what the declared type says; it names what the content is when that is known. */
function mismatchMessage(declared: string, content: ContentType): string {
  const said = TYPE_LABEL[declared];
  if (content && content !== "xml") {
    return `This file was sent as ${said} but its content is ${TYPE_LABEL[content]}. Give it the matching file extension (${EXTENSION_BY_MIME[content]}) and upload it again`;
  }
  if (declared === "image/svg+xml") return "This file is not an SVG image: an SVG must be text with an <svg> root (compressed .svgz files are not accepted)";
  return `This file is not a ${said} image: its content does not match its type. Save it again as PNG, JPEG, GIF, WebP or SVG and upload that file`;
}

/** Replace characters that are awkward in Markdown / URLs and make sure the name carries a fitting extension. */
export function cleanAssetName(name: string, mime: string): string {
  const trimmed = name.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "image";
  const ext = EXTENSION_BY_MIME[mime];
  if (!ext) return trimmed;
  const lower = trimmed.toLowerCase();
  const hasExt = Object.values(EXTENSION_BY_MIME).some((e) => lower.endsWith(e)) || (ext === ".jpg" && lower.endsWith(".jpeg"));
  return hasExt ? trimmed : trimmed + ext;
}

const SVG_TYPE = "image/svg+xml";

/**
 * The type to store `bytes` under, or the refusal as an {@link AssetError}. The bytes decide what the file
 * is: a file that is one raster type but was sent as another (a PNG saved as `photo.jpg`, which browsers
 * show all the same) is stored as what it is, never as what it was called. SVG is different in kind, so an
 * SVG sent as a raster type, or the reverse, is refused; so are bytes that are no allowed type at all.
 * Whatever is SVG by its bytes is checked for scripts first, under any declared type, so that refusal names
 * the real problem. Other markup (a web page saved under an image name) is never an allowed type.
 */
export function assetTypeFor(input: { mime: string; bytes: Uint8Array }): string {
  if (!ALLOWED_IMAGE_TYPES.has(input.mime)) throw new AssetError(415, "Only PNG, JPEG, GIF, WebP and SVG images can be uploaded");
  if (input.bytes.byteLength === 0) throw new AssetError(400, "The file is empty");
  if (input.bytes.byteLength > MAX_ASSET_BYTES) throw new AssetError(413, IMAGE_TOO_LARGE_MESSAGE);
  const content = detectContentType(input.bytes);
  if (content === SVG_TYPE && isUnsafeSvg(input.bytes)) throw new AssetError(400, "SVG images may not contain scripts or event handlers");
  if (content === input.mime) return content;
  if (content && content !== "xml" && content !== SVG_TYPE && input.mime !== SVG_TYPE) return content;
  throw new AssetError(415, mismatchMessage(input.mime, content));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const dbStore: AssetStore = {
  async put(input) {
    const mime = assetTypeFor({ mime: normalizeMime(input.mime), bytes: input.bytes });
    const db = await getDb();
    const hash = sha256Hex(input.bytes);
    const name = cleanAssetName(input.name, mime);
    const sameBytes = () =>
      db
        .select({ id: schema.assets.id, name: schema.assets.name, mime: schema.assets.mime, size: schema.assets.size })
        .from(schema.assets)
        .where(and(eq(schema.assets.documentId, input.documentId), eq(schema.assets.sha256, hash)));

    const [existing] = await sameBytes();
    if (existing) return { ...existing, url: assetUrl(existing.id) };

    // Two uploads of the same bytes at once both pass the select above; the insert is `on conflict do nothing` on
    // `asset_document_sha_idx` (document_id, sha256) so the loser gets no unique violation, and the row for these
    // bytes — ours or the other upload's — is read back (four small columns; `returning` would echo the data too).
    await db
      .insert(schema.assets)
      .values({
        id: nanoid(),
        documentId: input.documentId,
        userId: input.userId,
        name,
        mime,
        size: input.bytes.byteLength,
        sha256: hash,
        data: input.bytes,
      })
      .onConflictDoNothing({ target: [schema.assets.documentId, schema.assets.sha256] });
    const [stored] = await sameBytes();
    // Only if the row vanished in between (the document deleted, cascading): the caller's asset does not exist.
    if (!stored) throw new Error(`asset ${hash} of document ${input.documentId} is gone right after its insert`);
    return { ...stored, url: assetUrl(stored.id) };
  },

  async get(id) {
    const db = await getDb();
    const [row] = await db.select().from(schema.assets).where(eq(schema.assets.id, id));
    if (!row) return null;
    return { mime: row.mime, bytes: row.data, size: row.size, documentId: row.documentId, name: row.name };
  },

  async getForDocument(documentId, id) {
    const db = await getDb();
    const [row] = await db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.id, id), eq(schema.assets.documentId, documentId)));
    if (!row) return null;
    return { mime: row.mime, bytes: row.data, size: row.size, documentId: row.documentId, name: row.name };
  },
};

let store: AssetStore = dbStore;

/** Swap the storage backend (for example Azure Blob); the database store is the default. */
export function setAssetStore(next: AssetStore): void {
  store = next;
}

/** Store an image for a document. Identical bytes within one document share a single asset, also when uploaded at the same time. */
export function putAsset(input: PutAssetInput): Promise<StoredAsset> {
  return store.put(input);
}

export function getAsset(id: string): Promise<AssetContent | null> {
  return store.get(id);
}

/**
 * Read an asset only if `documentId` owns it. Use this wherever access has been checked on the
 * document rather than on the asset (export inlining), so a Markdown body that names another
 * document's `/api/assets/<id>` cannot pull in bytes its author may not view.
 */
export function getDocumentAsset(documentId: string, id: string): Promise<AssetContent | null> {
  return store.getForDocument(documentId, id);
}
