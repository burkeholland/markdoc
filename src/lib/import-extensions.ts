// The one list of file types Markdoc imports, shared by the server (`@/server/import-file`, the 415 message)
// and the dashboard import dialog (`accept=`, the drop-zone predicate and its toast). Shipped to the browser:
// no `@/server/**` or Node-only imports here.

export type ImportFormat = "markdown" | "text" | "html";

export const FORMAT_BY_EXTENSION: Record<string, ImportFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkd": "markdown",
  ".txt": "text",
  ".text": "text",
  ".html": "html",
  ".htm": "html",
};

/** Every importable extension, lower-case with the dot, in map order. */
export const IMPORT_EXTENSIONS = Object.keys(FORMAT_BY_EXTENSION);

/** `a, b and c` (no Oxford comma), the shape the import messages have always used. */
export function listInProse(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The `415` sentence, derived from {@link IMPORT_EXTENSIONS} so it cannot drift from what is accepted. */
export const IMPORT_EXTENSIONS_LIST = `only ${listInProse(IMPORT_EXTENSIONS)} files can be imported`;

/** `accept=` for the import file input: the document extensions plus any image (attached to the documents). */
export const IMPORT_ACCEPT = [...IMPORT_EXTENSIONS, "image/*"].join(",");

export function fileExtension(name: string): string {
  const m = /(\.[a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** `markdown`, `text` or `html` from a file name, or `null` for anything Markdoc cannot import. */
export function importFormatFor(name: string): ImportFormat | null {
  return FORMAT_BY_EXTENSION[fileExtension(name)] ?? null;
}
