import { toggleMark, setBlockType, wrapIn, lift } from "prosemirror-commands";
import { wrapInList, liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { TextSelection, NodeSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, type Attrs, type MarkType, type NodeType, type Node as PMNode } from "prosemirror-model";
import {
  addRowAfter as pmAddRowAfter,
  addRowBefore as pmAddRowBefore,
  addColumnAfter as pmAddColumnAfter,
  addColumnBefore as pmAddColumnBefore,
  deleteRow as pmDeleteRow,
  deleteColumn as pmDeleteColumn,
  goToNextCell,
  isInTable,
  selectedRect,
} from "prosemirror-tables";
import { findParentNode } from "./utils";
import { schema } from "../markdown/schema";

export { toggleMark, wrapInList, liftListItem, sinkListItem, splitListItem };

export function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

export function markAttrs(state: EditorState, type: MarkType): Attrs | null {
  const { $from, empty, from, to } = state.selection;
  if (empty) return type.isInSet(state.storedMarks || $from.marks())?.attrs ?? null;
  let found: Attrs | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    const mark = type.isInSet(node.marks);
    if (mark) found = mark.attrs;
    return true;
  });
  return found;
}

export function blockTypeActive(state: EditorState, type: NodeType, attrs?: Attrs): boolean {
  const { $from, to, node } = state.selection as { $from: typeof state.selection.$from; to: number; node?: PMNode };
  if (node) return node.hasMarkup(type, attrs);
  return to <= $from.end() && $from.parent.hasMarkup(type, attrs);
}

export function currentHeadingLevel(state: EditorState): number {
  const { $from } = state.selection;
  const parent = $from.parent;
  if (parent.type === schema.nodes.heading) return parent.attrs.level;
  return 0;
}

/** Set heading level 1-6 or 0 for paragraph. */
export function setHeadingLevel(level: number): Command {
  return (state, dispatch) => {
    if (level === 0) return setBlockType(schema.nodes.paragraph)(state, dispatch);
    return setBlockType(schema.nodes.heading, { level })(state, dispatch);
  };
}

export function listTypeAt(state: EditorState): { type: NodeType; task: boolean; depth: number } | null {
  const item = findParentNode(state.selection.$from, (n) => n.type === schema.nodes.list_item);
  if (!item) return null;
  const list = state.selection.$from.node(item.depth - 1);
  return { type: list.type, task: item.node.attrs.checked !== null, depth: item.depth };
}

/**
 * Toggle a list of the given kind around the selection. Switching between
 * bullet, ordered and task lists converts in place.
 */
export function toggleList(kind: "bullet" | "ordered" | "task"): Command {
  return (state, dispatch) => {
    const targetType = kind === "ordered" ? schema.nodes.ordered_list : schema.nodes.bullet_list;
    const current = listTypeAt(state);
    if (current) {
      const sameKind = current.type === targetType && current.task === (kind === "task");
      if (sameKind) return liftListItem(schema.nodes.list_item)(state, dispatch);
      if (dispatch) {
        const tr = state.tr;
        // Convert the enclosing list in place.
        const listDepth = current.depth - 1;
        const listPos = state.selection.$from.before(listDepth);
        const list = state.doc.nodeAt(listPos)!;
        if (list.type !== targetType) tr.setNodeMarkup(listPos, targetType, { ...targetType.spec.attrs ? {} : {}, tight: list.attrs.tight });
        // Update checked attrs on the selected items.
        const { from, to } = state.selection;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type === schema.nodes.list_item) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: kind === "task" ? (node.attrs.checked ?? false) : null });
          }
          return true;
        });
        if (kind === "task") {
          // Ensure the item at the cursor is a task even when the selection is empty.
          const item = findParentNode(state.selection.$from, (n) => n.type === schema.nodes.list_item)!;
          const pos = state.selection.$from.before(item.depth);
          tr.setNodeMarkup(pos, undefined, { ...item.node.attrs, checked: item.node.attrs.checked ?? false });
        }
        dispatch(tr.scrollIntoView());
      }
      return true;
    }
    const ok = wrapInList(targetType)(state, (tr) => {
      if (kind === "task") {
        // Mark all new list items as unchecked tasks.
        const { from, to } = tr.selection;
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type === schema.nodes.list_item) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
          return true;
        });
      }
      dispatch?.(tr.scrollIntoView());
    });
    return ok;
  };
}

export function toggleBlockquote(): Command {
  return (state, dispatch) => {
    const inQuote = findParentNode(state.selection.$from, (n) => n.type === schema.nodes.blockquote);
    if (inQuote) return lift(state, dispatch);
    return wrapIn(schema.nodes.blockquote)(state, dispatch);
  };
}

export function toggleCodeBlock(language: string | null = null): Command {
  return (state, dispatch) => {
    if (blockTypeActive(state, schema.nodes.code_block)) return setBlockType(schema.nodes.paragraph)(state, dispatch);
    return setBlockType(schema.nodes.code_block, { language })(state, dispatch);
  };
}

export function insertHorizontalRule(): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const { $to } = state.selection;
      const tr = state.tr;
      const hr = schema.nodes.horizontal_rule.create();
      // Insert after the current top-level block.
      const after = $to.after(1);
      tr.insert(after, hr);
      // Continue writing in a new paragraph below the rule.
      tr.insert(after + hr.nodeSize, schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, after + hr.nodeSize + 1));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export function setLink(href: string | null, title?: string | null): Command {
  return (state, dispatch) => {
    const type = schema.marks.link;
    const { from, to, empty } = state.selection;
    if (!href) {
      if (dispatch) {
        const tr = state.tr;
        if (empty) {
          // Remove the link around the cursor.
          const range = markRangeAt(state, type);
          if (range) tr.removeMark(range.from, range.to, type);
        } else tr.removeMark(from, to, type);
        dispatch(tr);
      }
      return true;
    }
    const mark = type.create({ href, title: title ?? null });
    if (dispatch) {
      const tr = state.tr;
      if (empty) {
        const range = markRangeAt(state, type);
        if (range) {
          tr.removeMark(range.from, range.to, type).addMark(range.from, range.to, mark);
        } else {
          tr.insertText(href, from, from).addMark(from, from + href.length, mark);
        }
      } else {
        tr.removeMark(from, to, type).addMark(from, to, mark);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Range of the mark of `type` around the cursor, if any. */
export function markRangeAt(state: EditorState, type: MarkType): { from: number; to: number } | null {
  const { $from } = state.selection;
  const parent = $from.parent;
  const index = $from.index();
  if (index >= parent.childCount) {
    // cursor at end: check previous child
    if (index === 0) return null;
  }
  const start = $from.start();
  let pos = start;
  let found: { from: number; to: number } | null = null;
  parent.forEach((child, offset) => {
    const from = start + offset;
    const to = from + child.nodeSize;
    if (type.isInSet(child.marks) && from <= $from.pos && $from.pos <= to) {
      found = { from, to };
    }
    pos = to;
  });
  void pos;
  if (!found) return null;
  // Expand across adjacent children carrying the same mark.
  let { from, to } = found as { from: number; to: number };
  parent.forEach((child, offset) => {
    const cFrom = start + offset;
    const cTo = cFrom + child.nodeSize;
    if (!type.isInSet(child.marks)) return;
    if (cTo === from) from = cFrom;
    if (cFrom === to) to = cTo;
  });
  return { from, to };
}

export function insertImage(src: string, alt = "", title: string | null = null): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const node = schema.nodes.image.create({ src, alt, title });
      dispatch(state.tr.replaceSelectionWith(node, false).scrollIntoView());
    }
    return true;
  };
}

export function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

export function insertTable(rows = 3, cols = 3): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const header = schema.nodes.table_row.create(
        null,
        Array.from({ length: cols }, (_, i) => schema.nodes.table_header.create(null, schema.text(`Column ${i + 1}`))),
      );
      const body = Array.from({ length: Math.max(1, rows - 1) }, () =>
        schema.nodes.table_row.create(
          null,
          Array.from({ length: cols }, () => schema.nodes.table_cell.create()),
        ),
      );
      const table = schema.nodes.table.create(null, [header, ...body]);
      const { $to } = state.selection;
      const tr = state.tr;
      const atEmptyParagraph = $to.parent.type === schema.nodes.paragraph && $to.parent.content.size === 0 && $to.depth === 1;
      let pos: number;
      if (atEmptyParagraph) {
        pos = $to.before(1);
        tr.replaceWith(pos, pos + $to.parent.nodeSize, table);
      } else {
        pos = $to.after(1);
        tr.insert(pos, table);
      }
      // Put the cursor in the first header cell.
      tr.setSelection(TextSelection.create(tr.doc, pos + 3));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/* ---------- Tables ----------
 * GFM tables always have exactly one header row, so the wrappers below keep
 * the first row as table_header cells: new rows never go above the header and
 * the header itself can only be removed together with the table.
 */

export type TableAlign = "left" | "center" | "right" | null;

export { isInTable };

/** Enclosing table node and its position, or null when the selection is outside a table. */
export function tableAt(state: EditorState): { node: PMNode; pos: number } | null {
  const found = findParentNode(state.selection.$anchor, (n) => n.type === schema.nodes.table);
  if (!found) return null;
  return { node: found.node, pos: state.selection.$anchor.before(found.depth) };
}

export const addRowBefore: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  // Above the header means directly below it: the header must stay first.
  if (selectedRect(state).top === 0) return pmAddRowAfter(state, dispatch);
  return pmAddRowBefore(state, dispatch);
};

export const addRowAfter: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  return pmAddRowAfter(state, dispatch);
};

export const addColumnBefore: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  return pmAddColumnBefore(state, dispatch);
};

export const addColumnAfter: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  return pmAddColumnAfter(state, dispatch);
};

/** Removes the table; when it was the only block an empty paragraph takes its place. */
export const deleteTable: Command = (state, dispatch) => {
  const table = tableAt(state);
  if (!table) return false;
  if (dispatch) {
    const tr = state.tr;
    const from = table.pos;
    const to = from + table.node.nodeSize;
    if (state.doc.childCount === 1) {
      tr.replaceWith(from, to, schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, from + 1));
    } else {
      tr.delete(from, to);
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), from >= tr.doc.content.size ? -1 : 1));
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** Deletes the selected body row(s). The header row is only removed with the whole table. */
export const deleteRow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  if (rect.top === 0) {
    if (rect.bottom === rect.map.height) return deleteTable(state, dispatch);
    return false;
  }
  return pmDeleteRow(state, dispatch);
};

/** Deletes the selected column(s); removing every column removes the table. */
export const deleteColumn: Command = (state, dispatch) => {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  if (rect.left === 0 && rect.right === rect.map.width) return deleteTable(state, dispatch);
  return pmDeleteColumn(state, dispatch);
};

/** Sets the GFM alignment of every cell in the selected column(s). */
export function setColumnAlign(align: TableAlign): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    if (dispatch) {
      const rect = selectedRect(state);
      const tr = state.tr;
      const seen = new Set<number>();
      for (let row = 0; row < rect.map.height; row++) {
        for (let col = rect.left; col < rect.right; col++) {
          const pos = rect.map.map[row * rect.map.width + col];
          if (seen.has(pos)) continue;
          seen.add(pos);
          const cell = rect.table.nodeAt(pos);
          if (cell && cell.attrs.align !== align) tr.setNodeMarkup(rect.tableStart + pos, undefined, { ...cell.attrs, align });
        }
      }
      if (tr.docChanged) dispatch(tr);
    }
    return true;
  };
}

/** Alignment of the column at the selection anchor, or null outside a table. */
export function columnAlignAt(state: EditorState): TableAlign {
  if (!isInTable(state)) return null;
  const rect = selectedRect(state);
  const cell = rect.table.nodeAt(rect.map.map[rect.left]);
  return (cell?.attrs.align as TableAlign) ?? null;
}

/** Enter in the last cell of the last row appends a row and moves into it. */
export const addRowOnEnterAtEnd: Command = (state, dispatch) => {
  if (!isInTable(state) || !state.selection.empty) return false;
  const rect = selectedRect(state);
  const { map } = rect;
  if (rect.bottom !== map.height || rect.right !== map.width) return false;
  if (dispatch) {
    pmAddRowAfter(state, (tr) => {
      let rowPos = rect.tableStart;
      for (let i = 0; i < map.height; i++) rowPos += tr.doc.nodeAt(rect.tableStart - 1)!.child(i).nodeSize;
      // The new row starts at rowPos; its first cell's content starts two tokens in.
      tr.setSelection(TextSelection.create(tr.doc, rowPos + 2));
      dispatch(tr.scrollIntoView());
    });
  }
  return true;
};

/** Backspace inside a table whose cells are all empty removes the table. */
export const deleteEmptyTableOnBackspace: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const table = tableAt(state);
  if (!table || table.node.textContent.length > 0) return false;
  let hasContent = false;
  table.node.descendants((n) => {
    const role = n.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") {
      if (n.content.size > 0) hasContent = true;
      return false;
    }
    return true;
  });
  if (hasContent) return false;
  return deleteTable(state, dispatch);
};

export { goToNextCell };

export function toggleTaskChecked(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== schema.nodes.list_item || node.attrs.checked === null) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
    return true;
  };
}

export function setCodeBlockLanguage(pos: number, language: string | null): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== schema.nodes.code_block) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: language || null }));
    return true;
  };
}

export function insertHardBreak(): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    if ($from.parent.type.spec.code) return false;
    dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
    return true;
  };
}

/** Backspace at the start of a list item lifts it out of the list. */
export const liftEmptyListItemOnBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const item = findParentNode($from, (n) => n.type === schema.nodes.list_item);
  if (!item || $from.depth !== item.depth + 1 || $from.index(item.depth) !== 0) return false;
  return liftListItem(schema.nodes.list_item)(state, dispatch);
};

export function selectAllText(state: EditorState): Transaction {
  return state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1));
}

export { NodeSelection, Fragment };

