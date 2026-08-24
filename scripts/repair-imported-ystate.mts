/**
 * Repair documents whose `ystate` fell behind `content` because of the import bug fixed in
 * task #313 (between df5f0af and the fix, `import-file.ts` rewrote image paths to asset URLs in
 * `content` only, so the opened document still showed `![x](beach.jpg)` instead of `/api/assets/…`).
 *
 * A document qualifies when its latest version is `kind: "import"` AND the text decoded from
 * `ystate` differs from `content` (a null/empty `ystate` counts as different). For each one the
 * script re-seeds `ystate = encodeSeedState(content, title)`. Anything a user has edited since
 * import has `content` and `ystate` in step already (the collab server writes both) and is skipped.
 *
 *   npx tsx scripts/repair-imported-ystate.mts --dry-run      # list what would change
 *   npx tsx scripts/repair-imported-ystate.mts                # apply
 *   npx tsx scripts/repair-imported-ystate.mts --id <docId>   # one document only (with or without --dry-run)
 *
 * Connects the same way the server does: DATABASE_URL if set, else PGLITE_DATA_DIR (default
 * .data/pglite). PGlite is single-process — stop the server (or point PGLITE_DATA_DIR at its data
 * dir only while it is down) before running this without --dry-run; an open editor holding the old
 * seed would otherwise see the text doubled, because a fresh seed has new CRDT ids.
 */
import * as Y from "yjs";
import { desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { TEXT_KEY, encodeSeedState, hydrateDoc } from "@/server/collab/seed";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyId = (() => {
  const i = args.indexOf("--id");
  return i >= 0 ? args[i + 1] : undefined;
})();
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: npx tsx scripts/repair-imported-ystate.mts [--dry-run] [--id <documentId>]");
  process.exit(0);
}

function decodeText(ystate: Uint8Array | null, content: string, title: string): string {
  const doc = new Y.Doc();
  try {
    hydrateDoc(doc, ystate, content, title);
    return doc.getText(TEXT_KEY).toString();
  } finally {
    doc.destroy();
  }
}

function preview(s: string, n = 60): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
}

const db = await getDb();
const where = onlyId ? eq(schema.documents.id, onlyId) : isNull(schema.documents.deletedAt);
const docs = await db
  .select({ id: schema.documents.id, title: schema.documents.title, content: schema.documents.content, ystate: schema.documents.ystate })
  .from(schema.documents)
  .where(where);

let scanned = 0;
let candidates = 0;
let repaired = 0;
for (const doc of docs) {
  scanned++;
  const [latest] = await db
    .select({ kind: schema.versions.kind, number: schema.versions.number, title: schema.versions.title })
    .from(schema.versions)
    .where(eq(schema.versions.documentId, doc.id))
    .orderBy(desc(schema.versions.number))
    .limit(1);
  if (!latest || latest.kind !== "import") continue;

  // Seed decode: null ystate hydrates from content and would compare equal, so treat it as missing explicitly.
  const hasState = !!doc.ystate && doc.ystate.byteLength > 0;
  const shown = hasState ? decodeText(doc.ystate, doc.content, doc.title) : "";
  if (hasState && shown === doc.content) continue;

  candidates++;
  const why = hasState ? `ystate text differs (${shown.length} vs ${doc.content.length} chars)` : "ystate is empty";
  const assets = (doc.content.match(/\/api\/assets\//g) ?? []).length;
  console.log(`${dryRun ? "would repair" : "repairing"} ${doc.id}  "${preview(doc.title, 40)}"  v${latest.number} ${latest.title ?? "import"}  — ${why}; ${assets} asset URL${assets === 1 ? "" : "s"} in content`);
  if (hasState) console.log(`    ystate : ${preview(shown)}\n    content: ${preview(doc.content)}`);
  if (dryRun) continue;

  await db
    .update(schema.documents)
    .set({ ystate: encodeSeedState(doc.content, doc.title) })
    .where(eq(schema.documents.id, doc.id));
  repaired++;
}

console.log(`${scanned} document${scanned === 1 ? "" : "s"} scanned, ${candidates} out of step${dryRun ? ` (dry run — nothing written)` : `, ${repaired} repaired`}.`);
process.exit(0);
