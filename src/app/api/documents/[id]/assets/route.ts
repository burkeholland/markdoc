import { handler, json, requireAccess, HttpError } from "@/server/http";
import { AssetError, MAX_ASSET_BYTES, normalizeMime, putAsset } from "@/server/assets";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

interface Upload {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "");
}

/** Accept either a multipart form with a `file` field or a raw image body (`Content-Type: image/*`, `?name=`). */
async function readUpload(req: Request): Promise<Upload> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_ASSET_BYTES + 4096) throw new HttpError(413, "Images must be 5 MB or smaller");

  const contentType = normalizeMime(req.headers.get("content-type"));
  if (contentType === "multipart/form-data") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "Invalid multipart body");
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new HttpError(400, "Missing `file` field");
    const fileName = "name" in file && typeof file.name === "string" ? file.name : "";
    const name = (typeof form.get("name") === "string" && (form.get("name") as string)) || fileName || "image";
    return { name, mime: normalizeMime(file.type), bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  if (contentType.startsWith("image/")) {
    const name = new URL(req.url).searchParams.get("name") ?? "image";
    return { name, mime: contentType, bytes: new Uint8Array(await req.arrayBuffer()) };
  }

  throw new HttpError(415, "Send multipart/form-data with a `file` field, or an image body with an image/* Content-Type");
}

/** Upload an image for a document. Returns `{ id, url, name, mime, size }`; `url` is what goes in `![alt](url)`. */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const upload = await readUpload(req);
  try {
    const asset = await putAsset({ documentId: id, userId: user?.id ?? null, name: upload.name, mime: upload.mime, bytes: upload.bytes });
    if (user) await recordActivity(id, activityActor(user), "asset.upload", { name: upload.name.slice(0, 120), size: asset.size });
    return json({ ...asset, alt: stripExtension(upload.name) }, { status: 201 });
  } catch (err) {
    if (err instanceof AssetError) throw new HttpError(err.status, err.message);
    throw err;
  }
});
