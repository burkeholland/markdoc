import { count, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { handler, HttpError } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Hot backup of the embedded PGlite database, for `scripts/live/snapshot-data.ps1`.
 *
 * Gated by `BACKUP_TOKEN` (a random secret in `.env.local`), sent as `Authorization: Bearer <token>`
 * or `X-Backup-Token`; it is not tied to a user because the snapshot job runs unattended. 503 when
 * the variable is unset, 501 when the server uses a real Postgres (`DATABASE_URL`) — use pg_dump there.
 *
 * `?meta=1` returns only `{ documents, users }` as JSON (used to verify a restore).
 * Otherwise the body is PGlite's `dumpDataDir('gzip')`: a gzipped tar of PGDATA, the same blob its
 * `loadDataDir` option accepts. A `CHECKPOINT` first flushes dirty pages so the copy needs no WAL
 * replay; the tar walk itself is synchronous inside the single PGlite process, so no query can
 * interleave and the copy is consistent without stopping the server.
 */
export const GET = handler(async (req: Request) => {
  const expected = process.env.BACKUP_TOKEN;
  if (!expected) throw new HttpError(503, "Backups are disabled: BACKUP_TOKEN is not set");
  if (!tokenMatches(req, expected)) throw new HttpError(401, "Backup token required");
  if (process.env.DATABASE_URL) throw new HttpError(501, "Hot backup is only available for the embedded PGlite database");

  const db = await getDb();
  const client = (db as { $client?: unknown }).$client as PgliteLike | undefined;
  if (!client || typeof client.dumpDataDir !== "function") throw new HttpError(501, "Database client cannot dump its data directory");

  const [{ n: documents }] = await db.select({ n: count() }).from(schema.documents).where(isNull(schema.documents.deletedAt));
  const [{ n: users }] = await db.select({ n: count() }).from(schema.users);

  if (new URL(req.url).searchParams.get("meta") === "1") {
    return Response.json({ documents, users });
  }

  await db.execute(sql`checkpoint`);
  const blob = await client.dumpDataDir("gzip");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": 'attachment; filename="markdoc-pglite.tar.gz"',
      "Cache-Control": "no-store",
      "X-Markdoc-Documents": String(documents),
      "X-Markdoc-Users": String(users),
    },
  });
});

interface PgliteLike {
  dumpDataDir(compression?: "none" | "gzip" | "auto"): Promise<Blob>;
}

function tokenMatches(req: Request, expected: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = req.headers.get("x-backup-token")?.trim() ?? "";
  return constantTimeEqual(bearer, expected) || constantTimeEqual(header, expected);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
