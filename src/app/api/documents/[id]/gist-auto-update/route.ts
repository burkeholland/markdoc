import { z } from "zod";
import { handler, json, readJson, requireAccess } from "@/server/http";
import { previewGistAutoUpdate } from "@/server/publish";
import { configureGistAutoUpdate, gistAutoUpdateStatus, retryGistAutoUpdate } from "@/server/gist-auto-update";

type Params = { params: Promise<{ id: string }> };
const schema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    acknowledgeRisk: z.literal(true),
    destination: z.object({
      gistId: z.string().min(1), filename: z.string().min(1), url: z.string().url(),
      visibility: z.enum(["public", "secret"]), owner: z.string().min(1),
    }).strict(),
  }).strict(),
]);

/** Explicit, owner-only destination check. Never runs on save, and never writes to GitHub. */
export const GET = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const result = new URL(req.url).searchParams.get("preview") === "1" ? await previewGistAutoUpdate(doc, user!) : await gistAutoUpdateStatus(doc);
  return json(result, { headers: { "Cache-Control": "no-store" } });
});

export const PATCH = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const settings = await readJson(req, (body) => schema.parse(body));
  return json(await configureGistAutoUpdate(doc, user!, settings));
});

export const POST = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  return json(await retryGistAutoUpdate(doc, user!));
});
