/** Explicitly opted-in tests migrate a disposable loopback database, never an inherited DATABASE_URL. */
export function coordinationPostgresFixtureUrl(): string | undefined {
  if (process.env.MARKDOC_PG_COORDINATION_TESTS !== "1") return undefined;
  const value = process.env.MARKDOC_PG_INTEGRATION_URL;
  if (!value || !URL.canParse(value)) throw new Error("A disposable loopback PostgreSQL fixture URL is required");
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port || url.pathname.length < 2 ||
    !["require", "no-verify"].includes(url.searchParams.get("sslmode") ?? "")
  ) throw new Error("The PostgreSQL fixture must use an explicit loopback port, database, and TLS");
  return value;
}
