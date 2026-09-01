import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePgliteSnapshot } from "../../../scripts/lib/pglite-postgres-migration";
import {
  createDestination,
  createMigrationFixture,
  MIGRATION_TEST_TIMEOUT_MS,
  type MigrationSnapshotFixture,
} from "./pglite-postgres-migration.fixture";

/**
 * Safety scenarios of the PGlite → PostgreSQL migration: a non-empty destination is refused and left untouched,
 * and a second migration without `--replace` fails without losing a row. One of the three files task #1426 cut
 * `pglite-postgres-migration.test.ts` into (with `.data` and `.failure`) so the suite's longest file stops
 * setting its wall time — vitest runs files, not tests, in parallel. The tests moved verbatim; the snapshot they
 * migrate from comes from `createMigrationFixture()` in `pglite-postgres-migration.fixture.ts`.
 */

describe("PGlite to PostgreSQL migration", () => {
  let fixture: MigrationSnapshotFixture | undefined;
  let root: string;
  let snapshot: string;

  beforeAll(async () => {
    fixture = await createMigrationFixture();
    root = fixture.root;
    snapshot = fixture.snapshot;
  }, MIGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("refuses a non-empty destination without changing it", async () => {
    const destination = await createDestination(true);
    const manifestPath = path.join(root, "refusal-manifest.json");
    try {
      await destination.query(`INSERT INTO "user" (id, name) VALUES ('existing-user', 'Existing')`);
      await expect(
        migratePgliteSnapshot({
          sourceSnapshot: snapshot,
          sourceDataDir: path.join(root, "restore-refusal"),
          destination,
          manifestPath,
        }),
      ).rejects.toThrow(/Destination is not empty/);
      const users = await destination.query<{ id: string }>(`SELECT id FROM "user" ORDER BY id`);
      expect(users.rows).toEqual([{ id: "existing-user" }]);
      await expect(fs.stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);

  it("a second migration without --replace fails and preserves all rows", async () => {
    const destination = await createDestination(true);
    try {
      await migratePgliteSnapshot({
        sourceSnapshot: snapshot,
        sourceDataDir: path.join(root, "restore-first"),
        destination,
      });
      const before = await destination.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM document`);
      await expect(
        migratePgliteSnapshot({
          sourceSnapshot: snapshot,
          sourceDataDir: path.join(root, "restore-second"),
          destination,
        }),
      ).rejects.toThrow(/Destination is not empty/);
      const after = await destination.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM document`);
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);
});
