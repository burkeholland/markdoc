import { renderMarkdownBody, type RenderedMarkdownBody } from "./html";

/**
 * Reader bodies by content hash (#2418). The reader page is dynamic and a 42k-word document took
 * ~300 ms to render on every view; the output depends only on the text, so repeat views of an
 * unchanged document reuse it. Small and least-recently-used: a handful of hot documents is the case.
 */
const MAX_ENTRIES = 16;
const MAX_TOTAL_CHARS = 8_000_000;

const cache = new Map<string, Promise<RenderedMarkdownBody>>();
const sizes = new Map<string, number>();
let total = 0;

function evict(key: string) {
  cache.delete(key);
  total -= sizes.get(key) ?? 0;
  sizes.delete(key);
}

export function renderReaderBody(markdown: string, hash: string): Promise<RenderedMarkdownBody> {
  const hit = cache.get(hash);
  if (hit) {
    cache.delete(hash);
    cache.set(hash, hit);
    return hit;
  }
  const pending = renderMarkdownBody(markdown, { assetBaseUrl: "", linkCards: true, videoPlayback: true });
  cache.set(hash, pending);
  pending.then(
    (body) => {
      if (cache.get(hash) !== pending) return;
      const size = body.html.length;
      if (size > MAX_TOTAL_CHARS / 2) return evict(hash);
      sizes.set(hash, size);
      total += size;
      for (const key of cache.keys()) {
        if (cache.size <= MAX_ENTRIES && total <= MAX_TOTAL_CHARS) break;
        if (key !== hash) evict(key);
      }
    },
    () => {
      if (cache.get(hash) === pending) evict(hash);
    },
  );
  return pending;
}

/** For tests. */
export function clearReaderBodyCache() {
  cache.clear();
  sizes.clear();
  total = 0;
}
