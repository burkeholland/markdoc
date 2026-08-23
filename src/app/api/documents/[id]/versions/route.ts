import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName } from "@/server/http";
import { addVersion, listVersions } from "@/server/documents";
import { readLiveText } from "@/server/livedoc";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id } = await params;
  await requireAccess(id, "view");
  const versions = await listVersions(id);
  return json({ versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) });
});

const createSchema = z.object({ title: z.string().trim().min(1).max(120) });

/** Name the current state as a version. */
export const POST = handler(async (req: Request, { params }: Params) => {
  const { id } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => createSchema.parse(d));
  const live = await readLiveText(id);
  const version = await addVersion({
    documentId: id,
    content: live.text,
    kind: "named",
    title: body.title,
    createdBy: user?.id,
    createdByName: actorName(user),
  });
  await recordActivity(id, activityActor(user!), "version.save", { number: version.number, title: body.title });
  return json({ version: { ...version, createdAt: version.createdAt.toISOString() } }, { status: 201 });
});

