/**
 * Hands the reader's rendered body HTML from the server component to the client component's
 * server render without making it a prop (#2418). Props of a client component are written into
 * the page's RSC payload, so a 250 KB article was shipped twice: once as HTML and once again,
 * escaped, inside `self.__next_f` scripts. Both renders run in the same server process, so the
 * server component leaves the HTML here under a one-time key and the client component's server
 * render takes it. In the browser the store is always empty and hydration keeps the server's DOM.
 */
const STORE_KEY = Symbol.for("markdoc.readerBodyHandoff");
/** An entry nobody took (e.g. an RSC-only request) is dropped after this long. */
const TTL_MS = 60_000;

type Store = Map<string, { html: string; at: number }>;

function store(): Store {
  const g = globalThis as { [STORE_KEY]?: Store };
  return (g[STORE_KEY] ??= new Map());
}

export function stashReaderBody(html: string, now = Date.now()): string {
  const s = store();
  for (const [key, entry] of s) if (now - entry.at > TTL_MS) s.delete(key);
  const key = crypto.randomUUID();
  s.set(key, { html, at: now });
  return key;
}

/** The HTML stashed under `key`, once; `undefined` in the browser or when it was already taken. */
export function takeReaderBody(key: string): string | undefined {
  const s = store();
  const entry = s.get(key);
  s.delete(key);
  return entry?.html;
}
