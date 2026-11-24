/**
 * Print daily, weekly and monthly active users, new sign-ups and new documents for each UTC day.
 * Active users come from `daily_usage`, which starts filling when this ships: earlier days show 0 active.
 *
 *   npm run usage:report                 # the last 30 days
 *   npm run usage:report -- --days 90    # the last 90 days
 *   npm run usage:report -- --json       # machine-readable
 *
 * Reads DATABASE_URL like the server (embedded PGlite in development when unset). Like the server, it
 * applies pending migrations on connect. Prints counts only, never user or document details.
 */
import { closeDb } from "@/server/db";
import { usageDay, usageReport } from "@/server/usage";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("usage: npm run usage:report -- [--days <n>] [--json]");
  process.exit(0);
}
const daysAt = argv.indexOf("--days");
const days = daysAt >= 0 ? Number(argv[daysAt + 1]) : 30;
if (!Number.isInteger(days) || days < 1 || days > 3660) {
  console.error("--days must be a whole number from 1 to 3660");
  process.exit(1);
}

const to = new Date();
const from = new Date(to.getTime() - (days - 1) * 86_400_000);
try {
  const rows = await usageReport(usageDay(from), usageDay(to));
  if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows.map((r) => ({ day: r.day, DAU: r.dau, WAU: r.wau, MAU: r.mau, "new users": r.newUsers, "new docs": r.newDocs })));
} finally {
  await closeDb();
}
