import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { getCollab } from "@/server/collab/registry";

export const dynamic = "force-dynamic";

const version = () => process.env.APP_VERSION ?? "dev";

/**
 * Health check for the container platform and for people.
 *
 * `GET /api/health` is the full check — one database round trip (`latencyMs`) plus the collaboration
 * server's counters — and what the Startup probe, the release runbook and the ops scripts wait on
 * (`ok:true, db:true`). `GET /api/health?probe=live` answers from the process alone and never touches the
 * database: it is the Liveness probe in `infra/main.bicep`. Liveness asks "is this process alive and
 * serving?", so a slow or restarting PostgreSQL must not make the platform kill a healthy replica; the
 * old probe was a 1 s-timeout database round trip and missed whenever the cold connection took longer.
 */
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("probe") === "live") {
    return Response.json({ ok: true, probe: "live", collab: !!getCollab(), version: version() });
  }
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
      version: version(),
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 503 });
  }
}
