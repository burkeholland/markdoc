// Task #698 measurement: how long the dashboard list and a document access check take against an
// in-memory PGlite holding the Burke-scale fixture (60 documents, the 12k-word hero doc first) with
// realistic `ystate` blobs — each document typed in character by character with edits, so the Yjs
// state carries tombstones. Reports the median and p90 of `listDocumentsForUser`, `listTrashForUser`,
// `searchDocumentsForUser` and `getDocumentAccess` on the hero and on a small document.
//
//   npx tsx scripts/perf-doc-selects.mts            (RUNS=40 to change the sample size)
process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "perf-probe-secret-perf-probe-secret";
delete process.env.DATABASE_URL;

import * as Y from "yjs";
import { MANY_DOCS, rng } from "../e2e/fixtures/burke-scale";
import { getDb, schema, closeDb } from "../src/server/db";
import { TEXT_KEY, META_KEY } from "../src/server/collab/seed";
import { getDocumentAccess, listDocumentsForUser, listTrashForUser, searchDocumentsForUser } from "../src/server/documents";

const RUNS = Number(process.env.RUNS) || 40;
const WARMUPS = 2;

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
const fmt = (ms: number) => ms.toFixed(ms < 10 ? 2 : 1).padStart(7);

/** A Yjs state for `content` as if typed in: character inserts plus a few hundred delete/retype edits. */
function editedState(content: string, title: string, seed: number): Uint8Array {
  const r = rng(seed);
  const doc = new Y.Doc();
  const text = doc.getText(TEXT_KEY);
  doc.getMap(META_KEY).set("title", title);
  // Type in chunks of 1–8 characters (one transaction each, like keystrokes arriving over a socket).
  for (let i = 0; i < content.length; ) {
    const n = Math.min(content.length - i, 1 + Math.floor(r() * 8));
    doc.transact(() => text.insert(i, content.slice(i, i + n)));
    i += n;
  }
  // Edits: delete a short run and type it back, leaving tombstones behind; more on longer documents.
  const edits = Math.min(600, Math.max(40, Math.floor(content.length / 40)));
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(r() * Math.max(1, content.length - 20));
    const len = 1 + Math.floor(r() * 12);
    const run = content.slice(at, at + len);
    doc.transact(() => text.delete(at, run.length));
    for (let k = 0; k < run.length; k++) doc.transact(() => text.insert(at + k, run[k]));
  }
  if (text.toString() !== content) throw new Error("edited state does not reproduce the content");
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

async function time(label: string, fn: () => Promise<unknown>) {
  for (let i = 0; i < WARMUPS; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  console.log(`${label.padEnd(36)} median ${fmt(quantile(samples, 0.5))} ms   p90 ${fmt(quantile(samples, 0.9))} ms   (n=${RUNS})`);
}

const db = await getDb();
const [owner] = await db.insert(schema.users).values({ name: "Burke", login: "burke", email: "burke-perf@example.com" }).returning();
const [peer] = await db.insert(schema.users).values({ name: "Peer", login: "burke-peer", email: "peer-perf@example.com" }).returning();
const user = { id: owner.id, login: "burke", name: "Burke" };

let bytes = { content: 0, ystate: 0, published: 0 };
let heroId = "";
let smallId = "";
const t0 = performance.now();
for (const spec of MANY_DOCS) {
  const id = `perf-${String(spec.index).padStart(2, "0")}`;
  const ystate = editedState(spec.content, spec.title, spec.index);
  // Every fourth document is linked to a repo with a slightly older published copy.
  const linked = spec.index % 4 === 0;
  const publishedContent = linked ? spec.content.replace("the", "a") : null;
  await db.insert(schema.documents).values({
    id,
    title: spec.title,
    ownerId: owner.id,
    content: spec.content,
    ystate,
    storage: linked ? "repo" : "local",
    repoOwner: linked ? "burkeholland" : null,
    repoName: linked ? "notes" : null,
    repoBranch: linked ? "main" : null,
    repoPath: linked ? `${id}.md` : null,
    publishedContent,
    publishedAt: linked ? new Date() : null,
    deletedAt: spec.trashed ? new Date() : null,
  });
  if (spec.starred) await db.insert(schema.stars).values({ documentId: id, userId: owner.id, starred: true });
  if (spec.sharedAs) await db.insert(schema.collaborators).values({ documentId: id, login: "burke-peer", role: spec.sharedAs, addedBy: owner.id });
  if (spec.index % 3 === 0) await db.insert(schema.recents).values({ documentId: id, userId: owner.id, openedAt: new Date(Date.now() - spec.index * 60_000) });
  bytes = { content: bytes.content + spec.content.length, ystate: bytes.ystate + ystate.byteLength, published: bytes.published + (publishedContent?.length ?? 0) };
  if (spec.index === 1) heroId = id;
  if (spec.size === "short" && !spec.trashed && !smallId) smallId = id;
}
console.log(`fixture: ${MANY_DOCS.length} documents, ${(bytes.content / 1024).toFixed(0)} KB content, ${(bytes.ystate / 1024).toFixed(0)} KB ystate, ${(bytes.published / 1024).toFixed(0)} KB publishedContent — built in ${(performance.now() - t0).toFixed(0)} ms`);
const hero = MANY_DOCS[0];
console.log(`hero: ${(hero.content.length / 1024).toFixed(0)} KB content, ${(editedState(hero.content, hero.title, 1).byteLength / 1024).toFixed(0)} KB ystate`);
console.log("");

const peerUser = { id: peer.id, login: "burke-peer", name: "Peer" };
await time("listDocumentsForUser (owner)", () => listDocumentsForUser(user));
await time("listDocumentsForUser (starred)", () => listDocumentsForUser(user, { starred: true }));
await time("listDocumentsForUser (collaborator)", () => listDocumentsForUser(peerUser));
await time("listTrashForUser", () => listTrashForUser(user));
await time("searchDocumentsForUser('release')", () => searchDocumentsForUser(user, "release"));
await time("getDocumentAccess(hero)", () => getDocumentAccess(heroId, user));
await time("getDocumentAccess(small doc)", () => getDocumentAccess(smallId, user));
await time("getDocumentAccess(hero, collaborator)", () => getDocumentAccess(heroId, peerUser));

await closeDb();
