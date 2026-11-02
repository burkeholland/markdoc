import { handler, json, requireAccess, HttpError } from "@/server/http";
import { VIDEO_CHUNK_BYTES } from "@/lib/video-limits";
import { VideoAssetError, putVideoUploadChunk } from "@/server/video-assets";

type Params = { params: Promise<{ id: string; uploadId: string; index: string }> };

async function readChunk(req: Request): Promise<Uint8Array> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > VIDEO_CHUNK_BYTES) throw new HttpError(413, "Video upload chunks must be 4 MB or smaller");
  if (!req.body) throw new HttpError(400, "Video upload chunk is missing");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VIDEO_CHUNK_BYTES) throw new HttpError(413, "Video upload chunks must be 4 MB or smaller");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const PUT = handler(async (req: Request, { params }: Params) => {
  const { id, uploadId, index: rawIndex } = await params;
  await requireAccess(id, "edit");
  if (!/^\d{1,2}$/.test(rawIndex)) throw new HttpError(400, "Invalid video upload chunk index");
  const bytes = await readChunk(req);
  try {
    await putVideoUploadChunk({ documentId: id, uploadId, index: Number(rawIndex), bytes });
  } catch (error) {
    if (error instanceof VideoAssetError) throw new HttpError(error.status, error.message);
    throw error;
  }
  return json({ ok: true });
});
