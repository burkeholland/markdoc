import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { altFromFileName, imageFiles, type ImageUploader } from "../prosemirror/images";

export interface CodeImageOptions {
  onError?: (message: string, file: File) => void;
}

interface CodeImageSession {
  readonly canEdit: boolean;
  readonly ytext: Y.Text;
}

type UploadResult = { url: string; alt?: string };
type MemberState =
  | { kind: "pending" }
  | { kind: "success"; result: UploadResult }
  | { kind: "failure"; error: unknown }
  | { kind: "retired" }
  | { kind: "complete" };

interface UploadBatch {
  readonly owner: object;
  readonly view: EditorView;
  readonly originalAnchor: number;
  readonly files: readonly File[];
  readonly members: UploadMember[];
  relativeAnchor: Y.RelativePosition | null;
  fallbackAnchor: number;
  next: number;
  active: boolean;
}

interface UploadMember {
  readonly batch: UploadBatch;
  readonly file: File;
  state: MemberState;
}

/**
 * Paste or drop image files into the Markdown source. The file uploads first and
 * `![alt](url)` is inserted where the cursor (or drop point) was; the position is
 * remembered relative to the shared text so it survives edits made meanwhile.
 */
export function codeImageUpload(session: CodeImageSession, upload: ImageUploader, options: CodeImageOptions = {}): Extension {
  class ImageUploadView {
    readonly batches = new Set<UploadBatch>();
    destroyed = false;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!session.canEdit || update.state.readOnly) this.retireAll();
    }

    destroy() {
      this.destroyed = true;
      this.retireAll();
    }

    private hasAuthority(batch: UploadBatch): boolean {
      return (
        batch.active &&
        !this.destroyed &&
        batch.owner === this &&
        batch.view === this.view &&
        this.batches.has(batch) &&
        session.canEdit &&
        !this.view.state.readOnly
      );
    }

    private retire(batch: UploadBatch) {
      if (!batch.active) return;
      batch.active = false;
      this.batches.delete(batch);
      for (const member of batch.members) {
        if (member.state.kind !== "complete") member.state = { kind: "retired" };
      }
    }

    private retireAll() {
      for (const batch of [...this.batches]) this.retire(batch);
    }

    private resolveAnchor(batch: UploadBatch): number {
      const resolved =
        batch.relativeAnchor && session.ytext.doc
          ? Y.createAbsolutePositionFromRelativePosition(batch.relativeAnchor, session.ytext.doc)
          : null;
      return Math.min(Math.max(resolved?.index ?? batch.fallbackAnchor, 0), this.view.state.doc.length);
    }

    private complete(batch: UploadBatch) {
      batch.active = false;
      this.batches.delete(batch);
    }

    private flush(batch: UploadBatch) {
      if (!this.hasAuthority(batch)) {
        this.retire(batch);
        return;
      }

      while (batch.next < batch.members.length) {
        const member = batch.members[batch.next];
        if (member.state.kind === "pending") return;
        if (member.state.kind === "retired" || member.state.kind === "complete") {
          batch.next++;
          continue;
        }
        if (!this.hasAuthority(batch)) {
          this.retire(batch);
          return;
        }

        if (member.state.kind === "success") {
          const at = this.resolveAnchor(batch);
          const before = at > 0 ? this.view.state.doc.sliceString(at - 1, at) : "";
          const after = this.view.state.doc.sliceString(at, at + 1);
          const { url, alt } = member.state.result;
          const insert = `${before && !/\s/.test(before) ? " " : ""}![${alt ?? altFromFileName(member.file.name)}](${url})${after && !/\s/.test(after) ? " " : ""}`;
          member.state = { kind: "complete" };
          this.view.dispatch({
            changes: { from: at, insert },
            selection: EditorSelection.cursor(at + insert.length),
            userEvent: "input.paste",
            scrollIntoView: true,
          });
          batch.fallbackAnchor = at + insert.length;
          batch.relativeAnchor = session.ytext.doc
            ? Y.createRelativePositionFromTypeIndex(session.ytext, batch.fallbackAnchor)
            : null;
        } else {
          const error = member.state.error;
          member.state = { kind: "complete" };
          if (this.hasAuthority(batch)) options.onError?.(error instanceof Error ? error.message : "Upload failed", member.file);
        }
        batch.next++;
      }

      this.complete(batch);
    }

    private settle(member: UploadMember, state: MemberState) {
      if (member.state.kind !== "pending") return;
      if (!this.hasAuthority(member.batch)) {
        this.retire(member.batch);
        return;
      }
      member.state = state;
      this.flush(member.batch);
    }

    private start(pos: number, files: File[]) {
      const materializedFiles = [...files];
      const originalAnchor = Math.min(Math.max(pos, 0), this.view.state.doc.length);
      const batch: UploadBatch = {
        owner: this,
        view: this.view,
        originalAnchor,
        files: materializedFiles,
        members: [],
        relativeAnchor: session.ytext.doc ? Y.createRelativePositionFromTypeIndex(session.ytext, originalAnchor) : null,
        fallbackAnchor: originalAnchor,
        next: 0,
        active: true,
      };
      batch.members.push(...materializedFiles.map((file) => ({ batch, file, state: { kind: "pending" } as MemberState })));
      this.batches.add(batch);

      const pending: Array<{ member: UploadMember; promise: Promise<UploadResult> }> = [];
      let hasSynchronousFailure = false;
      for (const member of batch.members) {
        try {
          pending.push({ member, promise: upload(member.file) });
        } catch (error) {
          member.state = { kind: "failure", error };
          hasSynchronousFailure = true;
        }
      }
      for (const { member, promise } of pending) {
        void promise.then(
          (result) => this.settle(member, { kind: "success", result }),
          (error: unknown) => this.settle(member, { kind: "failure", error }),
        );
      }
      if (hasSynchronousFailure) this.flush(batch);
    }

    paste(event: ClipboardEvent, view: EditorView): boolean {
      const files = imageFiles(event.clipboardData);
      if (!files.length || !session.canEdit || view.state.readOnly) return false;
      event.preventDefault();
      const range = view.state.selection.main;
      if (!range.empty) view.dispatch({ changes: { from: range.from, to: range.to, insert: "" }, selection: EditorSelection.cursor(range.from) });
      this.start(range.from, files);
      return true;
    }

    drop(event: DragEvent, view: EditorView): boolean {
      const files = imageFiles(event.dataTransfer);
      if (!files.length || !session.canEdit || view.state.readOnly) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      this.start(pos, files);
      return true;
    }
  }

  return ViewPlugin.define((view) => new ImageUploadView(view), {
    eventHandlers: {
      paste(event, view) {
        return this.paste(event, view);
      },
      drop(event, view) {
        return this.drop(event, view);
      },
    },
  });
}
