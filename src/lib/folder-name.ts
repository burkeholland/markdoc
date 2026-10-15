/**
 * The one rule for how long a folder name may be. Lives here, not in `server/folders.ts`, because
 * the naming dialog needs it too and that module reaches the database — importing it from a client
 * component would drag drizzle and the connection into the browser bundle.
 *
 * Mirrors `server/document-title.ts` for documents.
 */
export const FOLDER_NAME_MAX = 100;

/** Trim a folder name and clip it to {@link FOLDER_NAME_MAX}, never splitting a surrogate pair. */
export function boundFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= FOLDER_NAME_MAX) return trimmed;
  let cut = trimmed.slice(0, FOLDER_NAME_MAX);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}
