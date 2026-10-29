import { readJsonResponse } from "@/lib/json-response";
import { looksBinary, notTextMessage } from "@/lib/import-sniff";

export interface ImportedDocument {
  id: string;
  title: string;
  warnings: string[];
}

/** A file the server could not import; `index` is its position in the `documents` array that was uploaded. */
export interface FailedImport {
  index: number;
  name: string;
  error: string;
}

export interface ImportBatch {
  documents: ImportedDocument[];
  /** Empty when every file was imported. */
  failed: FailedImport[];
}

/**
 * The most one import request may carry. Every request passes `src/proxy.ts`, where Next keeps only the
 * first 10 MB of a body, so the route refuses larger ones by their declared size and the client never sends one.
 */
export const MAX_IMPORT_REQUEST_BYTES = 10 * 1024 * 1024;
export const IMPORT_REQUEST_TOO_LARGE = "This upload is larger than 10 MB, the most one import can carry. Import fewer or smaller files and images.";
/** Room left in a request for multipart framing and field headers. */
const REQUEST_BUDGET = MAX_IMPORT_REQUEST_BYTES - 512 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function basename(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Images whose file name occurs in the document's text (raw or URL-encoded), case-insensitively. */
function referencedImages(text: string, images: File[]): File[] {
  const haystack = text.toLowerCase();
  return images.filter((img) => {
    const name = basename(img.name).toLowerCase();
    return name !== "" && (haystack.includes(name) || haystack.includes(encodeURIComponent(name).toLowerCase()));
  });
}

type Outcome = { document: ImportedDocument } | { error: unknown };

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Import failed";
}

async function postOne(file: File, images: File[], warnings: string[]): Promise<ImportedDocument> {
  const form = new FormData();
  form.append("files", file, file.name);
  for (const f of images) form.append("images", f, f.name);
  const res = await fetch("/api/import/file", { method: "POST", body: form, credentials: "same-origin" });
  const data = await readJsonResponse(res, {
    fallback: res.status === 413 ? IMPORT_REQUEST_TOO_LARGE : `Import failed (${res.status})`,
    emptyBody: {},
  }) as { documents?: ImportedDocument[]; failed?: FailedImport[] };
  const [failure] = data.failed ?? [];
  if (failure) throw new Error(failure.error);
  const [document] = data.documents ?? [];
  if (!document) throw new Error(`Import failed (${res.status})`);
  return warnings.length && Array.isArray(document.warnings) ? { ...document, warnings: [...warnings, ...document.warnings] } : document;
}

/** Check one document client-side, pick the images it references that fit in one request, and upload it. */
async function importOne(file: File, images: File[]): Promise<ImportedDocument> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`“${file.name}” is larger than 2 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (looksBinary(bytes)) throw new Error(notTextMessage(file.name));
  const text = new TextDecoder().decode(bytes);
  const warnings: string[] = [];
  const attached: File[] = [];
  let size = file.size;
  for (const img of referencedImages(text, images)) {
    if (img.size > MAX_IMAGE_BYTES) {
      warnings.push(`“${img.name}”: Images must be 5 MB or smaller`);
    } else if (size + img.size > REQUEST_BUDGET) {
      warnings.push(`“${img.name}” was not attached: this document's images together are larger than 9.5 MB`);
    } else {
      attached.push(img);
      size += img.size;
    }
  }
  return postOne(file, attached, warnings);
}

/**
 * Import files through `POST /api/import/file`, one request per document carrying only the images it references,
 * so no request passes the 10 MB the proxy allows and one bad file does not fail the others. Binary files and
 * files over 2 MB are refused before upload; images over 5 MB, or that do not fit with the document, become warnings.
 * `onProgress` is called as each file settles. Resolves with the created documents and the files that failed;
 * `documents` holds only the successes, in file order — use `failed[].index` to line them up with the upload.
 * A single file that could not be imported rejects with its error instead.
 */
export async function uploadImportBatch(
  documents: File[],
  images: File[] = [],
  onProgress?: (index: number, outcome: Outcome) => void,
): Promise<ImportBatch> {
  const created: ImportedDocument[] = [];
  const failed: FailedImport[] = [];
  let firstError: unknown;
  for (const [index, file] of documents.entries()) {
    let outcome: Outcome;
    try {
      const document = await importOne(file, images);
      created.push(document);
      outcome = { document };
    } catch (error) {
      firstError ??= error;
      failed.push({ index, name: file.name, error: errorText(error) });
      outcome = { error };
    }
    onProgress?.(index, outcome);
  }
  if (documents.length === 1 && failed.length === 1) throw firstError;
  return { documents: created, failed };
}

/** Upload files to `POST /api/import/file`; resolves with the created documents. */
export async function uploadImportFiles(documents: File[], images: File[] = []): Promise<ImportedDocument[]> {
  return (await uploadImportBatch(documents, images)).documents;
}
