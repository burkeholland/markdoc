import { schema } from "./schema";
import { serializeBlocks } from "./serialize";

/** Toast shown after a TSV paste in either pane; the action is Undo. */
export const TSV_TABLE_NOTICE = "Pasted tab-separated text as a table";

export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/**
 * Split tab-separated plain text (what spreadsheets, `psql`, `jq -r @tsv` and most terminals
 * put on the clipboard) into rows of trimmed cells. Returns null unless there are at least
 * two rows and every row has the same number (≥ 1) of tabs — the shape a table range has and
 * ordinary prose never does.
 */
export function parseTsv(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
  if (lines.length < 2) return null;
  const tabs = lines[0].split("\t").length - 1;
  if (tabs < 1) return null;
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = line.split("\t");
    if (cells.length - 1 !== tabs) return null;
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
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
