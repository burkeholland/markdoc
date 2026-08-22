import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { getCollab } from "@/server/collab/registry";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe for the container platform. */
export async function GET() {
  const started = Date.now();
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    const collab = getCollab();
    return Response.json({
      ok: true,
      db: true,
      collab: !!collab,
      documentsLoaded: collab?.getDocumentsCount() ?? 0,
      connections: collab?.getConnectionsCount() ?? 0,
      latencyMs: Date.now() - started,
      version: process.env.APP_VERSION ?? "dev",
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
