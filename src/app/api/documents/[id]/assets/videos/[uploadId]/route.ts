import { handler, json, requireAccess, HttpError } from "@/server/http";
import { VideoAssetError, cancelVideoUpload } from "@/server/video-assets";

type Params = { params: Promise<{ id: string; uploadId: string }> };

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const { id, uploadId } = await params;
  await requireAccess(id, "edit");
  try {
    await cancelVideoUpload(id, uploadId);
  } catch (error) {
    if (error instanceof VideoAssetError) throw new HttpError(error.status, error.message);
    throw error;
  }
  return json({ ok: true });
});
