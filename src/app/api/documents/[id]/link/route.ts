import { z } from "zod";
import { handler, json, readJson, requireAccess } from "@/server/http";
import { linkDocument } from "@/server/publish";
import { publicDocument } from "@/server/dto";
import { warnTail } from "@/server/warnings";

type Params = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("storage", [
  z.object({ storage: z.literal("local") }),
  z.object({
    storage: z.literal("gist"),
    gistId: z.string().trim().min(1).optional(),
    filename: z.string().trim().max(200).optional(),
    isPublic: z.boolean().optional(),
    description: z.string().trim().max(500).optional(),
  }),
  z.object({
    storage: z.literal("repo"),
    owner: z.string().trim().min(1),
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1),
    path: z.string().trim().min(1).max(500),
  }),
]);

/**
 * Link (or unlink) the document to a gist or repository file. `200 { document, warnings? }`: for a
 * new gist, `warnings: ["version-not-saved"]` when the gist was created and the link written but the
 * version row failed; absent otherwise.
 */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { doc, user } = await requireAccess(id, "own");
  const body = await readJson(req, (d) => schema.parse(d));
  const { warnings, ...updated } = await linkDocument(doc, user!, body);
  return json(warnTail("link", warnings).answer({ document: publicDocument(updated) }));
});
