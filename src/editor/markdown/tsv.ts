import { schema } from "./schema";
import { serializeBlocks } from "./serialize";

/** Toast shown after a TSV paste in either pane; the action is Undo. */
export const TSV_TABLE_NOTICE = "Pasted tab-separated text as a table";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/**
 * Decode tab-separated clipboard text, including double-quoted spreadsheet fields, into
 * rows of trimmed cells. Returns null for malformed quoting or unless there are at least
 * two logical rows with the same number of cells (at least two).
 */
export function parseTsv(text: string): string[][] | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  let position = 0;
  let end = normalized.length;
  while (position < end && normalized[position] === "\n") position++;
  while (end > position && normalized[end - 1] === "\n") end--;

  const rows: string[][] = [];
  let cells: string[] = [];
  while (position <= end) {
    let cell: string;
    if (normalized[position] === '"') {
      let start = ++position;
      const parts: string[] = [];
      let closed = false;
      while (position < end) {
        if (normalized[position] !== '"') {
          position++;
          continue;
        }
        parts.push(normalized.slice(start, position++));
        if (normalized[position] === '"') {
          parts.push('"');
          start = ++position;
        } else {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      if (position < end && normalized[position] !== "\t" && normalized[position] !== "\n") return null;
      cell = parts.join("");
    } else {
      const start = position;
      while (position < end && normalized[position] !== "\t" && normalized[position] !== "\n") position++;
      cell = normalized.slice(start, position);
    }
    cells.push(cell.trim());

    if (position < end && normalized[position] === "\t") {
      position++;
      continue;
    }
    if (cells.length < 2 || (rows.length > 0 && cells.length !== rows[0].length)) return null;
    rows.push(cells);
    if (position === end) break;
    cells = [];
    position++;
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * Render TSV text as a GFM table (first row as header) through the same serializer the rich
 * pane uses, so cell text is escaped and columns are padded exactly like any other table.
 * Returns null when the text is not TSV.
 */
export function tsvToMarkdownTable(text: string): string | null {
  const rows = parseTsv(text);
  if (!rows) return null;
  const { table, table_row, table_header, table_cell } = schema.nodes;
  const node = table.create(
    null,
    rows.map((cells, i) =>
      table_row.create(
        null,
        cells.map((c) => (i === 0 ? table_header : table_cell).create(null, c ? schema.text(c) : null)),
      ),
    ),
  );
  return serializeBlocks([node]).trim();
}
