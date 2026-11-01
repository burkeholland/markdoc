import { insertPoint } from "prosemirror-transform";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { videoFileError, videoFiles, type UploadedVideo, type VideoUploader } from "@/lib/video-limits";
import { schema } from "../markdown/schema";

interface PlaceholderMeta {
  add?: Array<{ id: object; pos: number; dom: HTMLElement; side: number }>;
  remove?: Array<{ id: object }>;
  setAnchor?: { batch: VideoUploadBatch; pos: number };
  advanceAnchor?: { batch: VideoUploadBatch; pos: number };
  removeBatch?: VideoUploadBatch;
}

interface VideoUploadPluginState {
  decorations: DecorationSet;
  anchors: Map<VideoUploadBatch, number>;
}

export interface VideoUploadOptions {
  onError?: (message: string, file: File) => void;
}

interface VideoPlaceholder {
  dom: HTMLElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  destroy: () => void;
}

type VideoUploadState =
  | { kind: "pending" }
  | { kind: "success"; result: UploadedVideo }
  | { kind: "failure"; error: unknown }
  | { kind: "retired" }
  | { kind: "complete" };

interface VideoUploadRuntime {
  readonly view: EditorView;
  readonly batches: Set<VideoUploadBatch>;
  readonly members: Map<object, VideoUploadMember>;
  destroyed: boolean;
}

interface VideoUploadBatch {
  readonly runtime: VideoUploadRuntime;
  readonly view: EditorView;
  readonly originalAnchor: number;
  readonly members: VideoUploadMember[];
  next: number;
  active: boolean;
  flushScheduled: boolean;
}

interface VideoUploadMember {
  readonly batch: VideoUploadBatch;
  readonly id: object;
  readonly file: File;
  readonly controller: AbortController;
  readonly placeholder: VideoPlaceholder;
  state: VideoUploadState;
}

export const videoUploadKey = new PluginKey<VideoUploadPluginState>("videoUpload");

export function findVideoPlaceholder(state: EditorState, id: object): number | null {
  const decorations = videoUploadKey.getState(state)?.decorations;
  const found = decorations?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0].from : null;
}

function topLevelInsertionAnchor(state: EditorState, pos: number): number {
  const clamped = Math.min(Math.max(pos, 0), state.doc.content.size);
  const $pos = state.doc.resolve(clamped);
  if ($pos.depth === 0) return $pos.pos;
  return $pos.parent.isTextblock && $pos.parentOffset === 0 ? $pos.before(1) : $pos.after(1);
}

function createPlaceholder(file: File, cancel: () => void): VideoPlaceholder {
  const dom = document.createElement("span");
  dom.className = "md-video-upload";
  dom.setAttribute("data-testid", "video-upload-placeholder");
  dom.setAttribute("contenteditable", "false");

  const status = document.createElement("span");
  status.className = "md-video-upload-status";
  status.setAttribute("role", "status");
  status.textContent = `Uploading ${file.name} (0%)`;
  dom.appendChild(status);

  const progress = document.createElement("progress");
  progress.className = "md-video-upload-progress";
  progress.max = file.size;
  progress.value = 0;
  progress.setAttribute("aria-label", `Uploading ${file.name}`);
  dom.appendChild(progress);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "md-video-upload-cancel";
  button.textContent = "Cancel";
  button.setAttribute("aria-label", `Cancel upload of ${file.name}`);
  button.addEventListener("mousedown", preventEditorBlur);
  button.addEventListener("click", cancel);
  dom.appendChild(button);

  let destroyed = false;
  return {
    dom,
    progress,
    status,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      button.removeEventListener("mousedown", preventEditorBlur);
      button.removeEventListener("click", cancel);
    },
  };
}

function preventEditorBlur(event: MouseEvent) {
  event.preventDefault();
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
  } catch {
    return null;
  }
}

/**
 * Upload pasted or dropped videos without placing temporary data in the shared document. A cancellable
 * progress widget follows each upload; only the completed, named local asset link becomes a video node.
 */
export function videoUploadPlugin(session: { readonly canEdit: boolean }, upload: VideoUploader, options: VideoUploadOptions = {}): Plugin<VideoUploadPluginState> {
  const pluginIdentity = {};
  const runtimes = new Map<EditorView, VideoUploadRuntime>();

  function ownedDecorations(state: EditorState): DecorationSet | null {
    const set = videoUploadKey.getState(state)?.decorations;
    if (!set) return null;
    const foreign = set.find(undefined, undefined, (spec) => spec.owner !== pluginIdentity);
    return foreign.length ? set.remove(foreign) : set;
  }

  function removeBatchAnchor(batch: VideoUploadBatch) {
    if (!batch.view.isDestroyed) {
      batch.view.dispatch(batch.view.state.tr.setMeta(videoUploadKey, { removeBatch: batch } satisfies PlaceholderMeta));
    }
  }

  function removePlaceholder(member: VideoUploadMember) {
    const { runtime, view } = member.batch;
    if (runtime.destroyed || view.isDestroyed) return;
    if (findVideoPlaceholder(view.state, member.id) === null) return;
    view.dispatch(view.state.tr.setMeta(videoUploadKey, { remove: [{ id: member.id }] } satisfies PlaceholderMeta));
  }

  function releaseMember(member: VideoUploadMember, state: VideoUploadState, abort = false) {
    if (member.state.kind === "retired" || member.state.kind === "complete") return;
    member.state = state;
    if (abort) member.controller.abort();
    member.placeholder.destroy();
    member.batch.runtime.members.delete(member.id);
  }

  function retireBatch(batch: VideoUploadBatch) {
    if (!batch.active) return;
    batch.active = false;
    batch.runtime.batches.delete(batch);
    for (const member of batch.members) {
      releaseMember(member, { kind: "retired" }, true);
      removePlaceholder(member);
    }
    removeBatchAnchor(batch);
  }

  function hasAuthority(batch: VideoUploadBatch): boolean {
    return (
      batch.active &&
      !batch.runtime.destroyed &&
      batch.runtime.view === batch.view &&
      runtimes.get(batch.view) === batch.runtime &&
      batch.runtime.batches.has(batch) &&
      !batch.view.isDestroyed &&
      session.canEdit
    );
  }

  function hasMemberAuthority(member: VideoUploadMember): boolean {
    return (
      member.state.kind === "pending" &&
      member.batch.runtime.members.get(member.id) === member &&
      hasAuthority(member.batch)
    );
  }

  function completeBatch(batch: VideoUploadBatch) {
    batch.active = false;
    batch.runtime.batches.delete(batch);
    removeBatchAnchor(batch);
  }

  function flushBatch(batch: VideoUploadBatch) {
    if (!hasAuthority(batch)) {
      retireBatch(batch);
      return;
    }

    while (batch.next < batch.members.length) {
      const member = batch.members[batch.next];
      if (member.state.kind === "pending") return;
      if (member.state.kind === "retired" || member.state.kind === "complete") {
        batch.next++;
        continue;
      }
      if (!hasAuthority(batch)) {
        retireBatch(batch);
        return;
      }

      const at = findVideoPlaceholder(batch.view.state, member.id);
      if (at === null) {
        releaseMember(member, { kind: "retired" }, true);
        batch.next++;
        continue;
      }

      if (member.state.kind === "success") {
        const node = schema.nodes.video.create({
          src: member.state.result.url,
          name: member.state.result.name || member.file.name,
        });
        const anchor = videoUploadKey.getState(batch.view.state)?.anchors.get(batch) ?? topLevelInsertionAnchor(batch.view.state, at);
        const insertion = insertPoint(batch.view.state.doc, anchor, node.type);
        releaseMember(member, { kind: "complete" });
        if (insertion === null) {
          batch.view.dispatch(batch.view.state.tr.setMeta(videoUploadKey, { remove: [{ id: member.id }] } satisfies PlaceholderMeta));
          if (hasAuthority(batch)) options.onError?.("The video could not be inserted at this location", member.file);
        } else {
          batch.view.dispatch(
            batch.view.state.tr
              .replaceWith(insertion, insertion, node)
              .setMeta(videoUploadKey, {
                remove: [{ id: member.id }],
                advanceAnchor: { batch, pos: insertion },
              } satisfies PlaceholderMeta)
              .scrollIntoView(),
          );
        }
      } else {
        const error = member.state.error;
        releaseMember(member, { kind: "complete" });
        batch.view.dispatch(batch.view.state.tr.setMeta(videoUploadKey, { remove: [{ id: member.id }] } satisfies PlaceholderMeta));
        if (hasAuthority(batch)) {
          options.onError?.(error instanceof Error ? error.message : "Video upload failed", member.file);
        }
      }
      batch.next++;
    }

    completeBatch(batch);
  }

  function scheduleFlush(batch: VideoUploadBatch) {
    if (batch.flushScheduled || !batch.active) return;
    batch.flushScheduled = true;
    queueMicrotask(() => {
      batch.flushScheduled = false;
      if (batch.active) flushBatch(batch);
    });
  }

  function retireMissingMembers(runtime: VideoUploadRuntime) {
    for (const member of [...runtime.members.values()]) {
      if (findVideoPlaceholder(runtime.view.state, member.id) !== null) continue;
      releaseMember(member, { kind: "retired" }, true);
      scheduleFlush(member.batch);
    }
  }

  function cancelMember(member: VideoUploadMember) {
    if (member.state.kind !== "pending") return;
    releaseMember(member, { kind: "retired" }, true);
    removePlaceholder(member);
    scheduleFlush(member.batch);
  }

  function cancelMemberById(runtime: VideoUploadRuntime, id: object) {
    const member = runtime.members.get(id);
    if (member) cancelMember(member);
  }

  function settleMember(member: VideoUploadMember, state: VideoUploadState) {
    if (member.state.kind !== "pending") return;
    const { batch } = member;
    if (!hasAuthority(batch)) {
      retireBatch(batch);
      return;
    }
    member.state = state;
    flushBatch(batch);
  }

  function updateProgress(member: VideoUploadMember, uploaded: number, total: number) {
    if (!hasMemberAuthority(member)) return;
    member.placeholder.progress.max = total;
    member.placeholder.progress.value = uploaded;
    const percent = total ? Math.min(100, Math.floor((uploaded / total) * 100)) : 0;
    member.placeholder.status.textContent = `Uploading ${member.file.name} (${percent}%)`;
  }

  function startUploads(runtime: VideoUploadRuntime, files: File[], pos: number): boolean {
    const validFiles: File[] = [];
    for (const file of files) {
      const error = videoFileError(file);
      if (error) options.onError?.(error, file);
      else validFiles.push(file);
    }
    if (!validFiles.length) return true;

    const anchor = topLevelInsertionAnchor(runtime.view.state, pos);
    const batch: VideoUploadBatch = {
      runtime,
      view: runtime.view,
      originalAnchor: anchor,
      members: [],
      next: 0,
      active: true,
      flushScheduled: false,
    };
    batch.members.push(
      ...validFiles.map((file) => {
        const controller = new AbortController();
        const id = {};
        const placeholder = createPlaceholder(file, () => cancelMemberById(runtime, id));
        const member: VideoUploadMember = { batch, id, file, controller, placeholder, state: { kind: "pending" } };
        runtime.members.set(id, member);
        return member;
      }),
    );
    runtime.batches.add(batch);

    try {
      batch.view.dispatch(
        batch.view.state.tr.setMeta(videoUploadKey, {
          add: batch.members.map((member, side) => ({
            id: member.id,
            pos: batch.originalAnchor,
            dom: member.placeholder.dom,
            side,
          })),
          setAnchor: { batch, pos: batch.originalAnchor },
        } satisfies PlaceholderMeta),
      );
    } catch (error) {
      retireBatch(batch);
      throw error;
    }

    const pending: Array<{ member: VideoUploadMember; promise: Promise<UploadedVideo> }> = [];
    let hasSynchronousFailure = false;
    for (const member of batch.members) {
      try {
        pending.push({
          member,
          promise: upload(member.file, member.controller.signal, (uploaded, total) => updateProgress(member, uploaded, total)),
        });
      } catch (error) {
        member.state = { kind: "failure", error };
        hasSynchronousFailure = true;
      }
    }
    for (const { member, promise } of pending) {
      void promise.then(
        (result) => settleMember(member, { kind: "success", result }),
        (error: unknown) => settleMember(member, { kind: "failure", error }),
      );
    }
    if (hasSynchronousFailure) flushBatch(batch);
    return true;
  }

  function handleFiles(view: EditorView, files: File[], pos: number): boolean {
    if (!files.length || !session.canEdit) return false;
    const runtime = runtimes.get(view);
    if (!runtime || runtime.destroyed || view.isDestroyed) return false;
    return startUploads(runtime, files, pos);
  }

  return new Plugin<VideoUploadPluginState>({
    key: videoUploadKey,
    state: {
      init: (): VideoUploadPluginState => ({ decorations: DecorationSet.empty, anchors: new Map() }),
      apply(tr, previous) {
        let decorations = previous.decorations.map(tr.mapping, tr.doc);
        const anchors = new Map([...previous.anchors].map(([batch, pos]) => [batch, tr.mapping.map(pos, 1)]));
        if (!session.canEdit) return { decorations: DecorationSet.empty, anchors: new Map() };
        decorations = decorations.remove(decorations.find(undefined, undefined, (spec) => spec.owner !== pluginIdentity));
        const meta = tr.getMeta(videoUploadKey) as PlaceholderMeta | undefined;
        if (meta?.add) {
          decorations = decorations.add(
            tr.doc,
            meta.add.map(({ id, pos, dom, side }) => Decoration.widget(pos, dom, { id, side, owner: pluginIdentity })),
          );
        }
        if (meta?.remove) {
          for (const { id } of meta.remove) decorations = decorations.remove(decorations.find(undefined, undefined, (spec) => spec.id === id));
        }
        if (meta?.setAnchor) anchors.set(meta.setAnchor.batch, tr.mapping.map(meta.setAnchor.pos, 1));
        if (meta?.advanceAnchor) anchors.set(meta.advanceAnchor.batch, tr.mapping.map(meta.advanceAnchor.pos, 1));
        if (meta?.removeBatch) anchors.delete(meta.removeBatch);
        return { decorations, anchors };
      },
    },
    props: {
      decorations: ownedDecorations,
      handlePaste(view, event) {
        const files = videoFiles(event.clipboardData);
        if (!files.length) return false;
        if (view.state.selection.from !== view.state.selection.to && session.canEdit) {
          view.dispatch(view.state.tr.deleteSelection());
        }
        return handleFiles(view, files, view.state.selection.from);
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = videoFiles(event.dataTransfer);
        if (!files.length) return false;
        return handleFiles(view, files, dropPosition(view, event) ?? view.state.selection.from);
      },
    },
    view(view) {
      const runtime: VideoUploadRuntime = { view, batches: new Set(), members: new Map(), destroyed: false };
      runtimes.set(view, runtime);
      return {
        update() {
          if (!session.canEdit) {
            for (const batch of [...runtime.batches]) retireBatch(batch);
            return;
          }
          retireMissingMembers(runtime);
        },
        destroy() {
          runtime.destroyed = true;
          for (const batch of [...runtime.batches]) retireBatch(batch);
          runtimes.delete(view);
        },
      };
    },
  });
}
