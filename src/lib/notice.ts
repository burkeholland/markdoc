/**
 * One-shot message handed from one page to the next (e.g. "Moved to trash" shown on the dashboard
 * after leaving the editor). Kept in sessionStorage so it survives the client-side navigation and
 * is consumed by the first page that reads it.
 */
const KEY = "markdoc:notice";

export type NoticeKind = "info" | "success" | "error";

export interface PendingNotice {
  message: string;
  kind: NoticeKind;
}

export function setPendingNotice(message: string, kind: NoticeKind = "info"): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ message, kind }));
  } catch {
    // storage unavailable: the notice is simply not shown
  }
}

export function takePendingNotice(): PendingNotice | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<PendingNotice>;
    if (typeof parsed.message !== "string") return null;
    return { message: parsed.message, kind: parsed.kind ?? "info" };
  } catch {
    return null;
  }
}
