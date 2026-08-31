import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { getDb, schema } from "@/server/db";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

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

/** Reject SVG that could run script when rendered inline (`<script>`, `on*=` handlers, `javascript:` URLs). */
export function isUnsafeSvg(bytes: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return /<\s*script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript\s*:/i.test(text) || /<\s*foreignObject\b/i.test(text);
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

export function validateAsset(input: { mime: string; bytes: Uint8Array }): void {
  if (!ALLOWED_IMAGE_TYPES.has(input.mime)) throw new AssetError(415, "Only PNG, JPEG, GIF, WebP and SVG images can be uploaded");
  if (input.bytes.byteLength === 0) throw new AssetError(400, "The file is empty");
  if (input.bytes.byteLength > MAX_ASSET_BYTES) throw new AssetError(413, "Images must be 5 MB or smaller");
  if (input.mime === "image/svg+xml" && isUnsafeSvg(input.bytes)) throw new AssetError(400, "SVG images may not contain scripts or event handlers");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const dbStore: AssetStore = {
  async put(input) {
    const mime = normalizeMime(input.mime);
    validateAsset({ mime, bytes: input.bytes });
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
