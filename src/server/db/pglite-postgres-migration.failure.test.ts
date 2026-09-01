import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MigrationCommittedManifestError, migratePgliteSnapshot } from "../../../scripts/lib/pglite-postgres-migration";
import {
  createDestination,
  createMigrationFixture,
  MIGRATION_TEST_TIMEOUT_MS,
  type MigrationSnapshotFixture,
} from "./pglite-postgres-migration.fixture";

/**
 * Failure scenarios of the PGlite → PostgreSQL migration, both injected through `hooks.afterTable`: a failure
 * mid-replacement rolls the destination back to its previous state, and a manifest that cannot be published after
 * the destination commit is classified as `MigrationCommittedManifestError`. One of the three files task #1426 cut
 * `pglite-postgres-migration.test.ts` into (with `.data` and `.safety`) so the suite's longest file stops
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

  it("rolls replacement back to the previous state on failure", async () => {
    const destination = await createDestination(true);
    const manifestPath = path.join(root, "rollback-manifest.json");
    try {
      await destination.query(`INSERT INTO "user" (id, name) VALUES ('previous-user', 'Previous')`);
      await expect(
        migratePgliteSnapshot({
          sourceSnapshot: snapshot,
          sourceDataDir: path.join(root, "restore-rollback"),
          destination,
          manifestPath,
          replace: true,
          hooks: {
            afterTable(table) {
              if (table === "document") throw new Error("injected migration failure");
            },
          },
        }),
      ).rejects.toThrow("injected migration failure");
      const users = await destination.query<{ id: string }>(`SELECT id FROM "user" ORDER BY id`);
      expect(users.rows).toEqual([{ id: "previous-user" }]);
      const documents = await destination.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM document`);
      expect(documents.rows[0].count).toBe("0");
      await expect(fs.stat(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);

  it("classifies manifest publication failure after the destination commit", async () => {
    const destination = await createDestination(true);
    const manifestPath = path.join(root, "post-commit-manifest.json");
    try {
      await expect(
        migratePgliteSnapshot({
          sourceSnapshot: snapshot,
          sourceDataDir: path.join(root, "restore-post-commit-manifest"),
          destination,
          manifestPath,
          hooks: {
            async afterTable(table) {
              if (table === "document") await fs.writeFile(manifestPath, "publication blocker");
            },
          },
        }),
      ).rejects.toBeInstanceOf(MigrationCommittedManifestError);
      const documents = await destination.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM document`);
      expect(documents.rows[0].count).toBe("1");
      expect(await fs.readFile(manifestPath, "utf8")).toBe("publication blocker");
      expect((await fs.readdir(root)).filter((name) => name.includes(".pending-"))).toEqual([]);
    } finally {
      await destination.close();
    }
  }, MIGRATION_TEST_TIMEOUT_MS);
});
