import * as Y from "yjs";

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
