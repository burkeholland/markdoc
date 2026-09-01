/**
 * Shared by theme-contrast.test.ts and tokens-contrast.test.ts. A test file must never import another test
 * file: that re-registers the imported file's `describe`s into the importer (its tests run twice) and, under
 * a shared module cache, the imported file reports `No test suite found`. Not a route: Next ignores non-route
 * files in `app/`, and `*.helpers.ts` is outside vitest's `*.test.ts` include.
 */

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colours (order-independent), 1 … 21. */
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
