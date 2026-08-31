import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError } from "@/server/http";
import { createReview, listReviews } from "@/server/reviews";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  summary: z.string().trim().max(5000).default(""),
  verdict: z.enum(["approve", "request_changes", "comment"]).default("comment"),
  comments: z
    .array(
      z.object({
        quote: z.string().min(1).max(2000),
        body: z.string().trim().min(1).max(5000),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * Post a review: threads for every `{ quote, body }` (bodies may carry a ```suggestion block) plus a
 * review card. Atomic: one quote that does not anchor fails the whole request with 400 and creates nothing,
 * and a review row that cannot be written takes its threads back out before the 500. `201 { review, warnings? }`:
 * a mention, activity row or owner notification that fails after the review exists is a warning code, not a non-2xx.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user, role } = await requireAccess(id, "comment");
  if (!user) throw new HttpError(401, "Sign in required");
  const body = await readJson(req, (d) => schema.parse(d));
  return json(await createReview(id, user, role, body), { status: 201 });
});

/** Review cards on a document, newest first. */
export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  return json({ reviews: await listReviews(id) });
});
