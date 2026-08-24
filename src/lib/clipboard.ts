/**
 * Copy to the clipboard from a click handler, on any origin.
 *
 * `navigator.clipboard` only exists in secure contexts: on the LAN address (http://192.168.x.x:3000)
 * it is `undefined` and `navigator.clipboard.writeText(...)` throws (#993). `copyText` prefers the
 * async API and falls back to a hidden textarea + `document.execCommand("copy")`, which works on
 * insecure origins as long as it runs inside the user gesture. It never throws.
 *
 * Call it synchronously from the click handler (no `await` before it): when the API is absent the
 * fallback runs before `copyText` returns, while the activation is still live. When the API exists
 * but rejects, the fallback runs after one microtask hop, within the transient-activation window.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, document not focused, or an embedded/insecure context quirk: try the legacy path.
    }
  }
  return execCopy(text);
}

/** `true` when at least one copy path exists; a tooltip can say so before the click. */
export function canCopy(): boolean {
  if (typeof navigator === "undefined" || typeof document === "undefined") return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return true;
  return typeof document.execCommand === "function";
}

/** The legacy path: select the text in an off-screen textarea and `execCommand("copy")`. */
function execCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  let ok = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    textarea.remove();
    // Give focus back so the button keeps its focus ring and keyboard users stay where they were.
    if (active && typeof active.focus === "function" && active !== document.body) {
      try {
        active.focus({ preventScroll: true });
      } catch {
        // Detached or not focusable any more: nothing to restore.
      }
    }
  }
  return ok;
}

/** Shown on a copy button when both paths failed: the text is selected, the user finishes with the keyboard. */
export const COPY_FALLBACK_HINT = "Select & press Ctrl+C";

/**
 * Select the text of `el` so Ctrl+C copies it: `.select()` for inputs and textareas, a DOM range for
 * anything else (`<pre>`, `<code>`). Safe to call with `null`.
 */
export function selectContents(el: HTMLElement | null): void {
  if (!el) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus({ preventScroll: true });
    el.select();
    return;
  }
  const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!selection || typeof document.createRange !== "function") return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}
