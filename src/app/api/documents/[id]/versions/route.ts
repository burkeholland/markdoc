import { z } from "zod";
import { handler, json, readJson, requireAccess, actorName } from "@/server/http";
import { addVersion, listVersions } from "@/server/documents";
import { readLiveText } from "@/server/livedoc";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string }> };

/** Post-write side effect that can fail without taking the version back: reported as `warnings` on the 201 (see docs/agents.md). */
type Warning = "activity-not-recorded";

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
  // The version row is saved: an activity row that fails here is logged and reported as a warning code on the 201,
  // never a 500 that would make the caller save a second identical version on retry.
  const failed: Warning[] = [];
  const tail = async (code: Warning, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[versions] ${code}`, err);
      failed.push(code);
      return false;
    }
  };
  await tail("activity-not-recorded", () => recordActivity(id, activityActor(user!), "version.save", { number: version.number, title: body.title }));
  const result = { version: { ...version, createdAt: version.createdAt.toISOString() } };
  return json(failed.length ? { ...result, warnings: failed } : result, { status: 201 });
});

