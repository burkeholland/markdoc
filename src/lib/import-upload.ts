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
 * Upload files to `POST /api/import/file`; resolves with the created documents and the files that failed.
 * `documents` holds only the successes, in file order — use `failed[].index` to line them up with the upload.
 */
export async function uploadImportBatch(documents: File[], images: File[] = []): Promise<ImportBatch> {
  const form = new FormData();
  for (const f of documents) form.append("files", f, f.name);
  for (const f of images) form.append("images", f, f.name);
  const res = await fetch("/api/import/file", { method: "POST", body: form, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as { documents?: ImportedDocument[]; failed?: FailedImport[]; error?: string }) : {};
  if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
  return { documents: data.documents ?? [], failed: data.failed ?? [] };
}

/** Upload files to `POST /api/import/file`; resolves with the created documents. */
export async function uploadImportFiles(documents: File[], images: File[] = []): Promise<ImportedDocument[]> {
  return (await uploadImportBatch(documents, images)).documents;
}
