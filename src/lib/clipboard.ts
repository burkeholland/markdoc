/**
 * Copy `text` to the clipboard without ever throwing: `navigator.clipboard.writeText` where the page
 * is a secure context, else an off-screen textarea + `document.execCommand("copy")` (plain-HTTP LAN
 * origins have no `navigator.clipboard`). Resolves `true` when the text is on the clipboard.
 *
 * Call it synchronously from the click handler — the fallback needs the user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  };
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) return fallback();
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return fallback();
  }
}
