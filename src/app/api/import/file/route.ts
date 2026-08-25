import { z } from "zod";
import { handler, json, readJson, requireCanCreateDocuments, requireUser, HttpError } from "@/server/http";
import { normalizeMime } from "@/server/assets";
import { ImportError, importFiles, importText, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, type ImportFileInput, type ImportImageInput } from "@/server/import-file";

const textSchema = z.object({
  title: z.string().trim().max(300).optional(),
  content: z.string(),
  format: z.enum(["markdown", "text", "html"]).default("markdown"),
});

async function readForm(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, "Invalid multipart body");
  }
}

function blobs(form: FormData, field: string): File[] {
  return form.getAll(field).filter((v): v is File => v instanceof Blob && "name" in v);
}

/**
 * Import local files as new documents: multipart `files` (.md/.markdown/.txt/.html/.htm, ≤ 2 MB each, ≤ 20)
 * plus optional `images` that the Markdown references by relative path. Returns `{ documents: [{ id, title, warnings }] }`.
 * A JSON body `{ title?, content, format: "markdown" | "text" | "html" }` imports one string instead (used by the MCP tool).
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  requireCanCreateDocuments(user, "import documents");
  const contentType = normalizeMime(req.headers.get("content-type"));
  try {
    if (contentType === "application/json") {
      const body = await readJson(req, (d) => textSchema.parse(d));
      const document = await importText({ ownerId: user.id, title: body.title, content: body.content, format: body.format });
      return json({ documents: [document] }, { status: 201 });
    }
    if (contentType !== "multipart/form-data") {
      throw new HttpError(415, "Send multipart/form-data with one or more `files` fields (and optional `images`), or JSON { title?, content, format }");
    }

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_IMPORT_FILES * MAX_IMPORT_BYTES + 20 * 5 * 1024 * 1024) throw new HttpError(413, "Upload too large");

    const form = await readForm(req);
    const fileBlobs = blobs(form, "files");
    if (fileBlobs.length === 0) throw new HttpError(400, "No files to import");
    if (fileBlobs.length > MAX_IMPORT_FILES) throw new HttpError(400, `Import at most ${MAX_IMPORT_FILES} files at a time`);

    const files: ImportFileInput[] = [];
    for (const f of fileBlobs) {
      if (f.size > MAX_IMPORT_BYTES) throw new HttpError(413, `“${f.name}” is larger than 2 MB`);
      files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    const images: ImportImageInput[] = [];
    for (const img of blobs(form, "images")) {
      images.push({ name: img.name, mime: normalizeMime(img.type), bytes: new Uint8Array(await img.arrayBuffer()) });
    }

    const documents = await importFiles({ ownerId: user.id, files, images });
    return json({ documents }, { status: 201 });
  } catch (err) {
    if (err instanceof ImportError) throw new HttpError(err.status, err.message);
    throw err;
  }
});
