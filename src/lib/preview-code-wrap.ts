/** Preview-only wrapping, remembered in this browser without changing any document. */
export const PREVIEW_CODE_WRAP_STORAGE_KEY = "markdoc:previewCodeWrap";

let current: boolean | undefined;
const listeners = new Set<() => void>();
let bound = false;

function emit() {
  for (const listener of listeners) listener();
}

function read(): boolean {
  if (current !== undefined) return current;
  try {
    current = typeof window !== "undefined" && window.localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY) === "on";
  } catch {
    current = false;
  }
  return current;
}

export function setPreviewCodeWrap(wrap: boolean) {
  current = wrap;
  try {
    window.localStorage.setItem(PREVIEW_CODE_WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch (error) {
    console.warn("Could not remember code wrapping in this browser; using it for this visit only.", error);
  }
  emit();
}

export const previewCodeWrapStore = {
  subscribe(listener: () => void) {
    if (!bound && typeof window !== "undefined") {
      bound = true;
      window.addEventListener("storage", (event) => {
        if (event.key === PREVIEW_CODE_WRAP_STORAGE_KEY || event.key === null) {
          current = undefined;
          emit();
        }
      });
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: read,
  getServerSnapshot: (): boolean => false,
};
