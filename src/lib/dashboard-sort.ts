// Shared between the server page (reads the cookie) and the client dashboard (writes it), so it must
// stay free of "use client" and of browser-only code.

export type DashboardSort = "recent" | "modified" | "title" | "created";

export const DEFAULT_DASHBOARD_SORT: DashboardSort = "recent";

/** localStorage key; kept as a fallback for browsers that stored the sort before the cookie existed. */
export const SORT_STORAGE_KEY = "markdoc:dashboardSort";
/** Cookie the server reads so the first paint already shows the saved order (#165). */
export const SORT_COOKIE = "markdoc.dashboardSort";
export const SORT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const SORT_OPTIONS: { value: DashboardSort; label: string }[] = [
  { value: "recent", label: "Recently opened" },
  { value: "modified", label: "Last modified" },
  { value: "title", label: "Title A–Z" },
  { value: "created", label: "Created" },
];

export function isDashboardSort(v: unknown): v is DashboardSort {
  return SORT_OPTIONS.some((o) => o.value === v);
}
