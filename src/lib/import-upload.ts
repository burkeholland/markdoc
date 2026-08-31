export interface ImportedDocument {
  id: string;
  title: string;
  warnings: string[];
}

/** Upload files to `POST /api/import/file`; resolves with the created documents. */
export async function uploadImportFiles(documents: File[], images: File[] = []): Promise<ImportedDocument[]> {
  const form = new FormData();
  for (const f of documents) form.append("files", f, f.name);
  for (const f of images) form.append("images", f, f.name);
  const res = await fetch("/api/import/file", { method: "POST", body: form, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as { documents?: ImportedDocument[]; error?: string }) : {};
  if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
  return data.documents ?? [];
}
