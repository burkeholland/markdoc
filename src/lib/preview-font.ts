/**
 * The font of the rendered preview: one of four faces, stored per browser like the theme and the link-cards
 * switch. It only changes the preview's body text; the editor, the reader and exports keep their own fonts.
 * A place that cannot read the store gets the default.
 */
export const PREVIEW_FONT_STORAGE_KEY = "markdoc:previewFont";

export const PREVIEW_FONTS = [
  { id: "instrument-sans", label: "Instrument Sans" },
  { id: "inter", label: "Inter" },
  { id: "source-serif", label: "Source Serif 4" },
  { id: "plex-mono", label: "IBM Plex Mono" },
] as const;

export type PreviewFont = (typeof PREVIEW_FONTS)[number]["id"];
export const DEFAULT_PREVIEW_FONT: PreviewFont = "instrument-sans";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isPreviewFont(value: unknown): value is PreviewFont {
  return PREVIEW_FONTS.some((f) => f.id === value);
}

export function readPreviewFont(): PreviewFont {
  try {
    const value = storage()?.getItem(PREVIEW_FONT_STORAGE_KEY);
    return isPreviewFont(value) ? value : DEFAULT_PREVIEW_FONT;
  } catch {
    return DEFAULT_PREVIEW_FONT;
  }
}

const listeners = new Set<() => void>();
let bound = false;

function emit() {
  for (const listener of listeners) listener();
}

function bindStorage() {
  if (bound || typeof window === "undefined") return;
  bound = true;
  window.addEventListener("storage", (event) => {
    if (event.key === PREVIEW_FONT_STORAGE_KEY || event.key === null) emit();
  });
}

export function setPreviewFont(font: PreviewFont) {
  try {
    storage()?.setItem(PREVIEW_FONT_STORAGE_KEY, font);
  } catch {
    // A browser that refuses to store keeps the default; the select shows what was read back.
  }
  emit();
}

/** Store shape for useSyncExternalStore. The server and the first client render show the default. */
export const previewFontStore = {
  subscribe(listener: () => void) {
    bindStorage();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): PreviewFont => readPreviewFont(),
  getServerSnapshot: (): PreviewFont => DEFAULT_PREVIEW_FONT,
};
