import { z } from "zod";
import { handler, json, readJson, requireAccess, HttpError, actorName } from "@/server/http";
import { addVersion, getVersion } from "@/server/documents";
import { readLiveText, replaceLiveText } from "@/server/livedoc";
import { getDb, schema } from "@/server/db";
import { and, eq } from "drizzle-orm";
import { activityActor, recordActivity } from "@/server/activity";

type Params = { params: Promise<{ id: string; vid: string }> };

export const GET = handler(async (_req: Request, { params }: Params) => {
  const { id, vid } = await params;
  await requireAccess(id, "view");
  const version = await getVersion(id, vid);
  if (!version) throw new HttpError(404, "Version not found");
  return json({ version: { ...version, createdAt: version.createdAt.toISOString() } });
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("rename"), title: z.string().trim().min(1).max(120) }),
]);

export const POST = handler(async (req: Request, { params }: Params) => {
  const { id, vid } = await params;
  const { user } = await requireAccess(id, "edit");
  const body = await readJson(req, (d) => actionSchema.parse(d));
  const version = await getVersion(id, vid);
  if (!version) throw new HttpError(404, "Version not found");

  if (body.action === "rename") {
    const db = await getDb();
    await db
      .update(schema.versions)
      .set({ title: body.title, kind: version.kind === "auto" ? "named" : version.kind })
      .where(and(eq(schema.versions.documentId, id), eq(schema.versions.id, vid)));
    return json({ ok: true });
  }

  // Restore: snapshot the current text first so nothing is lost, then replace.
  const live = await readLiveText(id);
  if (live.text !== version.content) {
    await addVersion({
      documentId: id,
      content: live.text,
      kind: "auto",
      title: "Before restore",
      createdBy: user?.id,
      createdByName: actorName(user),
    });
  }
  await replaceLiveText(
    id,
    {
      userId: user?.id ?? "system",
      docId: id,
      role: "owner",
      name: user?.name ?? user?.login ?? "User",
      login: user?.login ?? null,
      avatar: user?.image ?? null,
    },
    version.content,
  );
  const restored = await addVersion({
    documentId: id,
    content: version.content,
    kind: "restore",
    title: `Restored version ${version.number}`,
    createdBy: user?.id,
    createdByName: actorName(user),
  });
  await recordActivity(id, activityActor(user!), "version.restore", { number: version.number, title: version.title });
  return json({ ok: true, version: { ...restored, createdAt: restored.createdAt.toISOString() } });
});

export const DELETE = handler(async (_req: Request, { params }: Params) => {
  const { id, vid } = await params;
  await requireAccess(id, "edit");
  const db = await getDb();
  await db.delete(schema.versions).where(and(eq(schema.versions.documentId, id), eq(schema.versions.id, vid)));
  return json({ ok: true });
});

