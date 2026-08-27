/**
 * The one rule for how long a document title may be. Create, rename, import (file, text, HTML,
 * GitHub) and the collaboration store all go through it, so a title derived from a 2 MB
 * document's first heading is clipped the same way a `POST /api/documents` title is validated.
 */
export const DOCUMENT_TITLE_MAX = 200;

/**
 * Trim a title and clip it to {@link DOCUMENT_TITLE_MAX} characters. Deterministic: the cut never
 * splits a surrogate pair and trailing whitespace left by the cut is removed. Ordinary titles
 * come back unchanged (apart from the trim).
 */
export function boundTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= DOCUMENT_TITLE_MAX) return trimmed;
  let cut = trimmed.slice(0, DOCUMENT_TITLE_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
