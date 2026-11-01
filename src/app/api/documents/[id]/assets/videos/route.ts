import { handler, json, requireAccess, HttpError } from "@/server/http";
import { VideoAssetError, beginVideoUpload } from "@/server/video-assets";

type Params = { params: Promise<{ id: string }> };

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid video upload details");
  const input = body as { name?: unknown; mime?: unknown; size?: unknown };
  if (typeof input.name !== "string" || typeof input.mime !== "string" || typeof input.size !== "number") {
    throw new HttpError(400, "Video upload requires a name, MIME type and size");
  }
  try {
    return json(await beginVideoUpload({ documentId: id, userId: user?.id ?? null, name: input.name, mime: input.mime, size: input.size }), { status: 201 });
  } catch (error) {
    if (error instanceof VideoAssetError) throw new HttpError(error.status, error.message);
    throw error;
  }
});
