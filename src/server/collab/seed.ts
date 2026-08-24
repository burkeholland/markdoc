import * as Y from "yjs";
import { applyOps, diffOps } from "@/editor/sync/text-diff";

/**
 * Shared Y.Doc layout and the initial ("seed") state of a document.
 *
 * A document's text lives in `Y.Text(TEXT_KEY)` and its title in `Y.Map(META_KEY)`.
 * The database keeps both the plain Markdown (`content`) and the encoded Yjs state
 * (`ystate`). `ystate` is authoritative: it carries the CRDT ids that let every
 * client and every later server load merge the same text as the same text.
 *
 * Seeding a Y.Doc from plain `content` mints fresh ids for the whole text. Doing that
 * twice for the same row (two server loads of a row whose `ystate` is still null)
 * produces two unrelated inserts of the same Markdown, and any client that holds the
 * first seed in its IndexedDB mirror sees the document doubled when the second one
 * arrives. So the seed must be persisted as `ystate` the first (and only) time it is
 * minted: at creation ({@link encodeSeedState}) or, for older rows, on first load.
 */

export const TEXT_KEY = "content";
export const META_KEY = "meta";

/**
 * Populate a fresh Y.Doc from stored state or plain Markdown.
 * Returns true when the text had to be seeded from `content` (no usable `ystate`);
 * the caller must then persist `Y.encodeStateAsUpdate(doc)` so the seed is minted once.
 */
export function hydrateDoc(doc: Y.Doc, ystate: Uint8Array | null, content: string, title: string): boolean {
  let seeded = false;
  if (ystate && ystate.byteLength > 0) {
    Y.applyUpdate(doc, ystate);
  } else {
    doc.transact(() => {
      const text = doc.getText(TEXT_KEY);
      if (text.length === 0 && content) {
        text.insert(0, content);
        seeded = true;
      }
    });
  }
  const meta = doc.getMap(META_KEY);
  if (!meta.has("title")) meta.set("title", title);
  return seeded;
}

/** Encode the initial `ystate` for a brand-new row so it never has to be seeded on load. */
export function encodeSeedState(content: string, title: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    hydrateDoc(doc, null, content, title);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Whether `text` is exactly the seed twice — the shape a client produces when its
 * IndexedDB mirror of an older, never-persisted seed merges with the seed the server
 * minted for the same content. Both seeds are inserted at offset 0 with no origin, so the
 * CRDT concatenates them in either order and the result is `seed + seed`, optionally
 * with one newline between when the seed did not end with one. Nothing else qualifies.
 */
export function isDoubledSeed(text: string, seed: string): boolean {
  if (!seed || text.length <= seed.length) return false;
  if (text === seed + seed) return true;
  return !seed.endsWith("\n") && text === `${seed}\n${seed}`;
}

/**
 * If the document's text is the seed doubled (see {@link isDoubledSeed}), collapse it back
 * to the seed with the minimal set of deletions (the same path REST-side replacements take,
 * so collaborators' positions survive). Returns true when a correction was applied.
 * Runs inside a transaction with `origin` so Hocuspocus attributes and stores it like a local change.
 */
export function revertDoubledSeed(doc: Y.Doc, seed: string, origin?: unknown): boolean {
  const ytext = doc.getText(TEXT_KEY);
  const current = ytext.toString();
  if (!isDoubledSeed(current, seed)) return false;
  doc.transact(() => applyOps(ytext, diffOps(current, seed, 0)), origin);
  return ytext.toString() === seed;
}
