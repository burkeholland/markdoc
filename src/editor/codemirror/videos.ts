import * as Y from "yjs";
import { EditorSelection, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { isAbortError, videoFileError, videoFiles, type UploadedVideo, type VideoUploader } from "@/lib/video-limits";
import { videoAssetMarkdownLink } from "../markdown/video";

interface VideoUploadOptions {
  onError?: (message: string, file: File) => void;
}

interface UploadTask {
  readonly batch: UploadBatch;
  readonly id: object;
  readonly file: File;
  readonly controller: AbortController;
  dom: HTMLElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  state: UploadState;
  active: boolean;
}

type UploadState =
  | { kind: "pending" }
  | { kind: "success"; result: UploadedVideo }
  | { kind: "failure"; error: unknown }
  | { kind: "retired" }
  | { kind: "complete" };

interface UploadBatch {
  readonly relativeAnchor: Y.RelativePosition | null;
  readonly tasks: UploadTask[];
  fallbackAnchor: number;
  nextAnchor: number | null;
  next: number;
  active: boolean;
  flushScheduled: boolean;
}

interface CodeVideoSession {
  readonly canEdit: boolean;
  readonly ytext: Y.Text;
}

function createUploadWidget(task: UploadTask, cancel: () => void): HTMLElement {
  const dom = document.createElement("span");
  dom.className = "md-video-upload";
  dom.setAttribute("data-testid", "video-upload-placeholder");
  dom.setAttribute("contenteditable", "false");

  const status = document.createElement("span");
  status.className = "md-video-upload-status";
  status.setAttribute("role", "status");
  status.textContent = `Uploading ${task.file.name} (0%)`;
  task.status = status;
  dom.appendChild(status);

  const progress = document.createElement("progress");
  progress.className = "md-video-upload-progress";
  progress.max = task.file.size;
  progress.value = 0;
  progress.setAttribute("aria-label", `Uploading ${task.file.name}`);
  task.progress = progress;
  dom.appendChild(progress);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "md-video-upload-cancel";
  button.textContent = "Cancel";
  button.setAttribute("aria-label", `Cancel upload of ${task.file.name}`);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", cancel);
  dom.appendChild(button);
  return dom;
}

class VideoUploadWidget extends WidgetType {
  constructor(readonly task: UploadTask) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof VideoUploadWidget && other.task.id === this.task.id;
  }

  toDOM(): HTMLElement {
    return this.task.dom;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function insertVideoBlock(view: EditorView, pos: number, video: UploadedVideo): number {
  const lineEnd = view.state.doc.lineAt(pos).to;
  const left = view.state.doc.sliceString(0, lineEnd);
  const right = view.state.doc.sliceString(lineEnd);
  const prefix = left.length === 0 || left.endsWith("\n\n") ? "" : left.endsWith("\n") ? "\n" : "\n\n";
  const suffix = right.startsWith("\n\n") ? "" : right.startsWith("\n") ? "\n" : "\n\n";
  const link = videoAssetMarkdownLink(video.name, video.url);
  if (!link) throw new Error("The server returned an invalid video asset URL");
  const insert = `${prefix}${link}${suffix}`;
  view.dispatch({
    changes: { from: lineEnd, insert },
    selection: EditorSelection.cursor(lineEnd + insert.length),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return lineEnd + insert.length;
}

/**
 * Paste or drop videos into Markdown source. Each upload gets an anchored progress widget with a
 * cancellation control, and the final link is inserted as its own block paragraph.
 */
export function codeVideoUpload(session: CodeVideoSession, upload: VideoUploader, options: VideoUploadOptions = {}): Extension {
  const refreshVideoUploads = StateEffect.define<void>();

  class VideoUploadView {
    readonly tasks = new Set<UploadTask>();
    readonly batches = new Set<UploadBatch>();
    destroyed = false;

    constructor(readonly view: EditorView) {}

    get decorations(): DecorationSet {
      const ranges = [...this.tasks]
        .filter((task) => task.active && task.batch.active)
        .map((task, side) =>
          Decoration.widget({ widget: new VideoUploadWidget(task), side }).range(this.resolveAnchor(task.batch)),
        );
      return Decoration.set(ranges, true);
    }

    update(update: import("@codemirror/view").ViewUpdate) {
      if (!session.canEdit || update.state.readOnly) {
        this.retireAll();
        return;
      }
      if (update.docChanged) {
        for (const batch of this.batches) {
          batch.fallbackAnchor = update.changes.mapPos(batch.fallbackAnchor, 1);
          if (batch.nextAnchor !== null) batch.nextAnchor = update.changes.mapPos(batch.nextAnchor, 1);
        }
      }
    }

    destroy() {
      this.destroyed = true;
      this.retireAll();
    }

    private hasAuthority(task: UploadTask): boolean {
      return task.active && this.tasks.has(task) && this.hasBatchAuthority(task.batch);
    }

    private hasBatchAuthority(batch: UploadBatch): boolean {
      return batch.active && !this.destroyed && this.batches.has(batch) && session.canEdit && !this.view.state.readOnly;
    }

    private resolveAnchor(batch: UploadBatch): number {
      const resolved = batch.relativeAnchor && session.ytext.doc
        ? Y.createAbsolutePositionFromRelativePosition(batch.relativeAnchor, session.ytext.doc)
        : null;
      return Math.min(Math.max(batch.nextAnchor ?? resolved?.index ?? batch.fallbackAnchor, 0), this.view.state.doc.length);
    }

    private refresh() {
      if (!this.destroyed) this.view.dispatch({ effects: refreshVideoUploads.of(undefined) });
    }

    private remove(task: UploadTask, state: UploadState, abort: boolean) {
      if (!task.active) return;
      task.active = false;
      task.state = state;
      this.tasks.delete(task);
      if (abort) task.controller.abort();
    }

    private retireBatch(batch: UploadBatch) {
      if (!batch.active) return;
      batch.active = false;
      this.batches.delete(batch);
      for (const task of batch.tasks) this.remove(task, { kind: "retired" }, true);
    }

    private retireAll() {
      for (const batch of [...this.batches]) this.retireBatch(batch);
    }

    private completeBatch(batch: UploadBatch) {
      batch.active = false;
      this.batches.delete(batch);
    }

    private flushBatch(batch: UploadBatch) {
      if (!this.hasBatchAuthority(batch)) {
        this.retireBatch(batch);
        this.refresh();
        return;
      }

      while (batch.next < batch.tasks.length) {
        const task = batch.tasks[batch.next];
        if (task.state.kind === "pending") return;
        if (task.state.kind === "retired" || task.state.kind === "complete") {
          batch.next++;
          continue;
        }
        if (!this.hasAuthority(task)) {
          this.retireBatch(batch);
          this.refresh();
          return;
        }

        if (task.state.kind === "success") {
          const result = task.state.result;
          const at = this.resolveAnchor(batch);
          this.remove(task, { kind: "complete" }, false);
          try {
            batch.nextAnchor = insertVideoBlock(this.view, at, result);
          } catch (error) {
            if (this.hasBatchAuthority(batch)) {
              options.onError?.(error instanceof Error ? error.message : "Video could not be inserted", task.file);
            }
          }
          this.refresh();
        } else {
          const error = task.state.error;
          this.remove(task, { kind: "complete" }, false);
          this.refresh();
          if (!isAbortError(error) && this.hasBatchAuthority(batch)) {
            options.onError?.(error instanceof Error ? error.message : "Video upload failed", task.file);
          }
        }
        batch.next++;
      }

      this.completeBatch(batch);
    }

    private scheduleFlush(batch: UploadBatch) {
      if (batch.flushScheduled || !batch.active) return;
      batch.flushScheduled = true;
      queueMicrotask(() => {
        batch.flushScheduled = false;
        if (batch.active) this.flushBatch(batch);
      });
    }

    private progress(task: UploadTask, uploaded: number, total: number) {
      if (!this.hasAuthority(task)) return;
      task.progress.max = total;
      task.progress.value = uploaded;
      const percent = total ? Math.min(100, Math.floor((uploaded / total) * 100)) : 0;
      task.status.textContent = `Uploading ${task.file.name} (${percent}%)`;
      this.view.requestMeasure();
    }

    private settle(task: UploadTask, result: UploadedVideo | null, error: unknown) {
      if (!task.active) return;
      if (!this.hasAuthority(task)) {
        this.retireBatch(task.batch);
        this.refresh();
        return;
      }
      task.state = result ? { kind: "success", result } : { kind: "failure", error };
      this.flushBatch(task.batch);
    }

    private start(pos: number, files: File[]) {
      const validFiles: File[] = [];
      for (const file of files) {
        const error = videoFileError(file);
        if (error) {
          options.onError?.(error, file);
        } else validFiles.push(file);
      }
      if (!validFiles.length) return;

      const fallbackAnchor = Math.min(Math.max(pos, 0), this.view.state.doc.length);
      const batch: UploadBatch = {
        relativeAnchor: session.ytext.doc
          ? Y.createRelativePositionFromTypeIndex(session.ytext, fallbackAnchor)
          : null,
        tasks: [],
        fallbackAnchor,
        nextAnchor: null,
        next: 0,
        active: true,
        flushScheduled: false,
      };
      batch.tasks.push(...validFiles.map((file) => {
        const controller = new AbortController();
        const task: UploadTask = {
          batch,
          id: {},
          file,
          controller,
          dom: document.createElement("span"),
          progress: document.createElement("progress"),
          status: document.createElement("span"),
          state: { kind: "pending" },
          active: true,
        };
        task.dom = createUploadWidget(task, () => {
          this.remove(task, { kind: "retired" }, true);
          this.refresh();
          this.scheduleFlush(batch);
        });
        this.tasks.add(task);
        return task;
      }));
      this.batches.add(batch);
      this.refresh();

      const pending: Array<{ task: UploadTask; promise: Promise<UploadedVideo> }> = [];
      let hasSynchronousFailure = false;
      for (const task of batch.tasks) {
        try {
          pending.push({
            task,
            promise: upload(task.file, task.controller.signal, (uploaded, total) => this.progress(task, uploaded, total)),
          });
        } catch (error) {
          task.state = { kind: "failure", error };
          hasSynchronousFailure = true;
        }
      }
      for (const { task, promise } of pending) {
        void promise.then(
          (result) => this.settle(task, result, null),
          (error: unknown) => this.settle(task, null, error),
        );
      }
      if (hasSynchronousFailure) this.flushBatch(batch);
    }

    paste(event: ClipboardEvent, view: EditorView): boolean {
      const files = videoFiles(event.clipboardData);
      if (!files.length || !session.canEdit || view.state.readOnly) return false;
      event.preventDefault();
      const range = view.state.selection.main;
      if (!range.empty) {
        view.dispatch({ changes: { from: range.from, to: range.to, insert: "" }, selection: EditorSelection.cursor(range.from) });
      }
      this.start(range.from, files);
      return true;
    }

    drop(event: DragEvent, view: EditorView): boolean {
      const files = videoFiles(event.dataTransfer);
      if (!files.length || !session.canEdit || view.state.readOnly) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      this.start(pos, files);
      return true;
    }
  }

  const plugin = ViewPlugin.define((view) => new VideoUploadView(view), {
    decorations: (value) => value.decorations,
    eventHandlers: {
      paste(event, view) {
        return this.paste(event, view);
      },
      drop(event, view) {
        return this.drop(event, view);
      },
    },
  });
  return plugin;
}
