import { z } from "zod";
import { handler, json, requireAccess, HttpError } from "@/server/http";
import { listActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

/**
 * Who did what, when — newest first. `?before=<iso>` pages backwards (use the
 * `nextBefore` from the previous page); `?limit=` caps the page (default 50, max 200; anything else is a `400`).
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
  const { limit } = querySchema.parse({ limit: limitRaw || undefined });
  const page = await listActivity(id, { before, limit });
  return json(page);
});
