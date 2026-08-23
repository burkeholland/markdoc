import { handler, json, requireAccess, HttpError } from "@/server/http";
import { listActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

/**
 * Who did what, when — newest first. `?before=<iso>` pages backwards (use the
 * `nextBefore` from the previous page); `?limit=` caps the page (default 50, max 200).
 */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  let before: Date | null = null;
  if (beforeRaw) {
    before = new Date(beforeRaw);
    if (Number.isNaN(before.getTime())) throw new HttpError(400, "Invalid `before` timestamp");
  }
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new HttpError(400, "Invalid `limit`");
  const page = await listActivity(id, { before, limit });
  return json(page);
});
