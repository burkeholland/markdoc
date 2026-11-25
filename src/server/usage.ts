import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { UsageKind } from "@/server/db/schema";

/** The UTC calendar day of `at`, as `YYYY-MM-DD`. */
export function usageDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The last day already written per user and kind, so busy users cost one write a day, not one per save. */
const written = new Map<string, string>();

/**
 * Note that a signed-in user was active today: opened a document, edited one, or used an agent token.
 * Stores only the user, the UTC day and the kind. Unknown ids (anonymous link visitors) are ignored.
 */
export async function recordUsage(userId: string, kind: UsageKind, at = new Date()): Promise<void> {
  if (userId.startsWith("anon-")) return;
  const day = usageDay(at);
  const key = `${userId}\u0000${kind}`;
  if (written.get(key) === day) return;
  written.set(key, day);
  try {
    const db = await getDb();
    await db
      .insert(schema.dailyUsage)
      .select(
        db
          .select({ userId: schema.users.id, day: sql<string>`${day}::date`.as("day"), kind: sql<UsageKind>`${kind}`.as("kind") })
          .from(schema.users)
          .where(eq(schema.users.id, userId)),
      )
      .onConflictDoNothing();
  } catch (error) {
    if (written.get(key) === day) written.delete(key);
    throw error;
  }
}

/** Fire-and-forget {@link recordUsage}: usage stats must never fail or slow the request that triggered them. */
export function noteUsage(userId: string, kind: UsageKind): void {
  void recordUsage(userId, kind).catch((error: unknown) => console.error("record usage failed", error));
}

export interface UsageDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Users active that day. */
  dau: number;
  /** Users active in the 7 days ending that day. */
  wau: number;
  /** Users active in the 30 days ending that day. */
  mau: number;
  /** Accounts created that day. */
  newUsers: number;
  /** Documents created that day, including ones since trashed. */
  newDocs: number;
}

/** Active users, sign-ups and new documents for each UTC day from `from` to `to` (inclusive, `YYYY-MM-DD`). */
export async function usageReport(from: string, to: string): Promise<UsageDay[]> {
  const db = await getDb();
  const result = await db.execute(sql`
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(distinct u.user_id)::int from daily_usage u where u.day = d.day) as dau,
      (select count(distinct u.user_id)::int from daily_usage u where u.day > d.day - 7 and u.day <= d.day) as wau,
      (select count(distinct u.user_id)::int from daily_usage u where u.day > d.day - 30 and u.day <= d.day) as mau,
      (select count(*)::int from "user" x where (x.created_at at time zone 'UTC')::date = d.day) as new_users,
      (select count(*)::int from document x where (x.created_at at time zone 'UTC')::date = d.day) as new_docs
    from (select generate_series(${from}::date, ${to}::date, interval '1 day')::date as day) d
    order by d.day`);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  return rows.map((row) => ({
    day: String(row.day),
    dau: Number(row.dau),
    wau: Number(row.wau),
    mau: Number(row.mau),
    newUsers: Number(row.new_users),
    newDocs: Number(row.new_docs),
  }));
}
