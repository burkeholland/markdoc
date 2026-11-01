import { handler, json, requireAccess, HttpError } from "@/server/http";
import { activityActor, recordActivity } from "@/server/activity";
import { warnTail } from "@/server/warnings";
import { VideoAssetError, completeVideoUpload } from "@/server/video-assets";

type Params = { params: Promise<{ id: string; uploadId: string }> };

export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id, uploadId } = await params;
  const { user } = await requireAccess(id, "edit");
  let asset;
  try {
    asset = await completeVideoUpload(id, uploadId);
  } catch (error) {
    if (error instanceof VideoAssetError) throw new HttpError(error.status, error.message);
    throw error;
  }
  const { tail } = warnTail("assets");
  if (user) await tail("activity-not-recorded", () => recordActivity(id, activityActor(user), "asset.upload", { name: asset.name.slice(0, 120), size: asset.size, kind: "video" }));
  return json({ ...asset, alt: asset.name.replace(/\.[a-z0-9]{2,5}$/i, "") }, { status: 201 });
});
