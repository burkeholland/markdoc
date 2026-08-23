// Restore a PGlite data directory from a tarball produced by GET /api/admin/backup
// (PGlite's `dumpDataDir('gzip')`). Uses PGlite's own `loadDataDir` loader, so the on-disk
// layout is exactly what the engine expects — no hand-rolled tar extraction.
//
//   node scripts/live/restore-data.mjs --tar <markdoc-pglite.tar.gz> --data-dir <empty dir>
//
// The target directory must not exist or must be empty (restore-data.ps1 moves the old one aside).
// Prints one JSON line {documents, users, dataDir} on success and exits 0; non-zero on any failure.
// Never run this against a data dir a server has open: PGlite is single-process.

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const tar = arg("--tar");
const dataDir = arg("--data-dir");
if (!tar || !dataDir || process.argv.includes("--help")) {
  console.error("usage: node scripts/live/restore-data.mjs --tar <file.tar.gz> --data-dir <dir>");
  process.exit(2);
}

const tarPath = path.resolve(tar);
const target = path.resolve(dataDir);
if (!fs.existsSync(tarPath)) {
  console.error(`tarball not found: ${tarPath}`);
  process.exit(1);
}
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`refusing to restore into a non-empty directory: ${target}`);
  process.exit(1);
}
fs.mkdirSync(target, { recursive: true });

const bytes = fs.readFileSync(tarPath);
if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
  console.error(`not a gzip file: ${tarPath}`);
  process.exit(1);
}

const db = new PGlite(target, { loadDataDir: new Blob([bytes], { type: "application/gzip" }) });
await db.waitReady;
const docs = await db.query('select count(*)::int as n from "document" where deleted_at is null');
const users = await db.query('select count(*)::int as n from "user"');
await db.close();
console.log(JSON.stringify({ documents: docs.rows[0].n, users: users.rows[0].n, dataDir: target }));
