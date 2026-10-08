/**
 * "Turn links to known sites into cards" (#2317): on unless this browser has stored "off".
 *
 * The setting governs only what Markdoc writes for a person: a known link pasted on an empty line of the
 * preview. On: a card. Off: the link stays text. A link that is typed stays a link either way, and so
 * does one that somebody chose to "Show as text": Enter never makes a card. It never
 * changes how a document is shown (the document says card or text, and everyone sees the same), and the
 * Insert entry "Video or post from a link" makes a card whatever the setting says.
 *
 * Stored per browser, beside the theme: there is no per-account settings table. A place that cannot read
 * the store (the embedded canvas in a browser that blocks its storage, the server) gets the default.
 */
export const LINK_CARDS_STORAGE_KEY = "markdoc:linkCards";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether Markdoc turns a known link into a card by itself. Only the exact value "off" turns it off. */
export function readLinkCardsSetting(): boolean {
  try {
    return storage()?.getItem(LINK_CARDS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();
let bound = false;

function emit() {
  for (const listener of listeners) listener();
}

/** Another tab changed the setting (or cleared the store): tell this tab's readers. */
function bindStorage() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("storage", (event) => {
    if (event.key === LINK_CARDS_STORAGE_KEY || event.key === null) emit();
  });
}

export function setLinkCardsSetting(on: boolean) {
  try {
    storage()?.setItem(LINK_CARDS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // A browser that refuses to store keeps the default; the switch shows what was read back.
  }
  emit();
}

/** Store shape for useSyncExternalStore. The server and the first client render show the default. */
export const linkCardsStore = {
  subscribe(listener: () => void) {
    bindStorage();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): boolean => readLinkCardsSetting(),
  getServerSnapshot: (): boolean => true,
};
