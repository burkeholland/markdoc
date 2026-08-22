import { handler, requireAccess, HttpError } from "@/server/http";
import { getAsset } from "@/server/assets";

type Params = { params: Promise<{ id: string }> };

/** Serve an uploaded image. Only people who can view the owning document (including via a shared link) get the bytes. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) throw new HttpError(404, "Asset not found");
  await requireAccess(asset.documentId, "view");
  const body = new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength) as Uint8Array<ArrayBuffer>;
  return new Response(body, {
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(asset.size),
      // Asset ids are unique per upload and bytes never change, so clients can cache aggressively (privately).
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // SVG is served as an image; the sandbox keeps any inline content from running in the app's origin.
      ...(asset.mime === "image/svg+xml" ? { "Content-Security-Policy": "sandbox; script-src 'none'" } : {}),
      "Content-Disposition": `inline; filename="${asset.name.replace(/[^\w.\- ]+/g, "")}"`,
    },
  });
});
