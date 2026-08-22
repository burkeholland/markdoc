import { Annotation, ChangeSet, EditorSelection, EditorState, Transaction, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CollabSession } from "../collab/session";
import { SUGGESTIONS_ORIGIN } from "../collab/suggestions";

interface SuggestMeta {
  /** Ranges the user tried to delete, in coordinates of the transaction's new document. */
  deletes: { from: number; to: number }[];
  /** Ranges the user inserted, in coordinates of the new document. */
  inserts: { from: number; to: number }[];
}

const suggestAnnotation = Annotation.define<SuggestMeta>();

/**
 * Suggesting mode for the source editor. User edits are rewritten so that
 * deletions are kept in the text (and recorded as delete-suggestions) while
 * insertions are applied and recorded as insert-suggestions.
 */
export function suggestingMode(session: CollabSession): Extension {
  const filter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    // Only direct user input is rewritten. Changes coming from Yjs (other users, undo, the
    // rich editor) carry no user event and pass through untouched.
    if (!tr.annotation(Transaction.userEvent) || tr.annotation(Transaction.remote)) return tr;
    if (tr.annotation(suggestAnnotation)) return tr;

    const specs: ChangeSpec[] = [];
    const rawDeletes: { from: number; to: number }[] = [];
    const rawInserts: { from: number; length: number }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const text = inserted.toString();
      if (toA > fromA) rawDeletes.push({ from: fromA, to: toA });
      if (text) {
        specs.push({ from: fromA, to: fromA, insert: text });
        rawInserts.push({ from: fromA, length: text.length });
      }
    });
    if (rawDeletes.length === 0) {
      // Pure insertion: keep the transaction, just tag it so the listener records it.
      const inserts = rawInserts.map((i) => {
        const from = tr.changes.mapPos(i.from, -1);
        return { from, to: from + i.length };
      });
      return [tr, { annotations: suggestAnnotation.of({ deletes: [], inserts }) }];
    }

    const changes = ChangeSet.of(specs, tr.startState.doc.length);
    const deletes = rawDeletes.map((d) => ({ from: changes.mapPos(d.from, 1), to: changes.mapPos(d.to, 1) }));
    const inserts = rawInserts.map((i) => {
      const from = changes.mapPos(i.from, -1);
      return { from, to: from + i.length };
    });
    // Cursor: after inserted text, or at the start of the deleted range (backspace moves left).
    const cursor = inserts.length ? inserts[inserts.length - 1].to : Math.min(...deletes.map((d) => d.from));
    return {
      changes,
      selection: EditorSelection.cursor(cursor),
      annotations: [suggestAnnotation.of({ deletes, inserts }), Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? "input")],
      scrollIntoView: true,
    };
  });

  const listener = EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      const meta = tr.annotation(suggestAnnotation);
      if (!meta) continue;
      // At this point y-codemirror has already written the inserted text into the Y.Text,
      // so source offsets equal editor offsets.
      session.ydoc.transact(() => {
        for (const ins of meta.inserts) session.suggestions.recordInserted(ins.from, ins.to - ins.from, session.user);
        for (const del of [...meta.deletes].sort((a, b) => b.from - a.from)) {
          session.suggestions.markDeleted(del.from, del.to, session.user);
        }
      }, SUGGESTIONS_ORIGIN);
    }
  });

  return [filter, listener];
}

