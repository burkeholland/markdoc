import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";

/** Uploads a file and resolves with the URL to put in the document (and optionally alt text). */
export type ImageUploader = (file: File) => Promise<{ url: string; alt?: string }>;

export interface ImageUploadOptions {
  /** Called when an upload fails, after the placeholder has been removed. */
  onError?: (message: string, file: File) => void;
}

interface PlaceholderMeta {
  add?: Array<{ id: object; pos: number; dom: HTMLElement; side: number }>;
  remove?: Array<{ id: object }>;
}

export const imageUploadKey = new PluginKey<DecorationSet>("imageUpload");

type UploadResult = { url: string; alt?: string };
type UploadState =
  | { kind: "pending" }
  | { kind: "success"; result: UploadResult }
  | { kind: "failure"; error: unknown }
  | { kind: "retired" }
  | { kind: "complete" };

interface UploadRuntime {
  readonly view: EditorView;
  readonly batches: Set<UploadBatch>;
  readonly members: Map<object, UploadMember>;
  destroyed: boolean;
}

interface UploadBatch {
  readonly runtime: UploadRuntime;
  readonly view: EditorView;
  readonly originalAnchor: number;
  readonly files: readonly File[];
  readonly members: UploadMember[];
  next: number;
  active: boolean;
  flushScheduled: boolean;
}

interface UploadMember {
  readonly batch: UploadBatch;
  readonly id: object;
  readonly file: File;
  readonly placeholderDom: HTMLElement;
  cleanup: (() => void) | null;
  state: UploadState;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter(isImageFile);
  if (files.length) return files;
  // Some browsers only expose pasted images through items.
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
}

/** File name without its extension, used as the default alt text. */
export function altFromFileName(name: string): string {
  const stem = name.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  return stem || "image";
}

/** Position of the placeholder for an upload, or null when it was removed (for example by undo or a remote edit). */
export function findPlaceholder(state: EditorState, id: object): number | null {
  const decos = imageUploadKey.getState(state);
  const found = decos?.find(undefined, undefined, (spec) => spec.id === id);
  return found && found.length ? found[0].from : null;
}

function createPlaceholder(file: File): { dom: HTMLElement; destroy: () => void } {
  const dom = document.createElement("span");
  dom.className = "md-image-upload";
  dom.setAttribute("data-testid", "image-upload-placeholder");
  dom.setAttribute("contenteditable", "false");
  dom.title = `Uploading ${file.name}…`;
  let objectUrl: string | null = null;
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      objectUrl = null;
    }
  }
  if (objectUrl) {
    const img = document.createElement("img");
    img.src = objectUrl;
    img.alt = "";
    dom.appendChild(img);
  } else {
    const label = document.createElement("span");
    label.className = "md-image-upload-label";
    label.textContent = file.name;
    dom.appendChild(label);
  }
  const spinner = document.createElement("span");
  spinner.className = "md-image-upload-spinner";
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Uploading image");
  dom.appendChild(spinner);
  let destroyed = false;
  return {
    dom,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

function dropPosition(view: EditorView, event: DragEvent): number | null {
  try {
    return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
  } catch {
    // Layout APIs are unavailable (for example in tests); fall back to the selection.
    return null;
  }
}

/**
 * Paste or drop image files into the rich editor. A placeholder (local preview
 * with a spinner) is shown as a decoration while the file uploads, so nothing
 * is written to the shared document until the final URL is known. On success an
 * image node is inserted where the placeholder was; on failure the placeholder
 * disappears and `onError` is called.
 */
export function imageUploadPlugin(session: { readonly canEdit: boolean }, upload: ImageUploader, options: ImageUploadOptions = {}): Plugin<DecorationSet> {
  const pluginIdentity = {};
  const runtimes = new Map<EditorView, UploadRuntime>();

  function ownedDecorations(state: EditorState): DecorationSet | null {
    const set = imageUploadKey.getState(state);
    if (!set) return null;
    const foreign = set.find(undefined, undefined, (spec) => spec.owner !== pluginIdentity);
    return foreign.length ? set.remove(foreign) : set;
  }

  function releaseMember(member: UploadMember, state: UploadState) {
    if (member.state.kind === "retired" || member.state.kind === "complete") return;
    member.state = state;
    member.cleanup?.();
    member.cleanup = null;
    member.batch.runtime.members.delete(member.id);
  }

  function retireBatch(batch: UploadBatch) {
    if (!batch.active) return;
    batch.active = false;
    batch.runtime.batches.delete(batch);
    for (const member of batch.members) releaseMember(member, { kind: "retired" });
  }

  function hasAuthority(batch: UploadBatch): boolean {
    return (
      batch.active &&
      !batch.runtime.destroyed &&
      batch.runtime.view === batch.view &&
      batch.runtime.batches.has(batch) &&
      !batch.view.isDestroyed &&
      session.canEdit
    );
  }

  function completeBatch(batch: UploadBatch) {
    batch.active = false;
    batch.runtime.batches.delete(batch);
  }

  function flushBatch(batch: UploadBatch) {
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

      const at = findPlaceholder(batch.view.state, member.id);
      if (at === null) {
        releaseMember(member, { kind: "retired" });
        batch.next++;
        continue;
      }

      if (member.state.kind === "success") {
        const { url, alt } = member.state.result;
        const node = schema.nodes.image.create({ src: url, alt: alt ?? altFromFileName(member.file.name) });
        releaseMember(member, { kind: "complete" });
        batch.view.dispatch(
          batch.view.state.tr
            .replaceWith(at, at, node)
            .setMeta(imageUploadKey, { remove: [{ id: member.id }] } satisfies PlaceholderMeta)
            .scrollIntoView(),
        );
      } else {
        const error = member.state.error;
        releaseMember(member, { kind: "complete" });
        batch.view.dispatch(batch.view.state.tr.setMeta(imageUploadKey, { remove: [{ id: member.id }] } satisfies PlaceholderMeta));
        if (hasAuthority(batch)) options.onError?.(error instanceof Error ? error.message : "Upload failed", member.file);
      }
      batch.next++;
    }

    completeBatch(batch);
  }

  function scheduleFlush(batch: UploadBatch) {
    if (batch.flushScheduled || !batch.active) return;
    batch.flushScheduled = true;
    queueMicrotask(() => {
      batch.flushScheduled = false;
      if (batch.active) flushBatch(batch);
    });
  }

  function retireMissingMembers(runtime: UploadRuntime) {
    for (const member of [...runtime.members.values()]) {
      if (findPlaceholder(runtime.view.state, member.id) !== null) continue;
      releaseMember(member, { kind: "retired" });
      scheduleFlush(member.batch);
    }
  }

  function settleMember(member: UploadMember, state: UploadState) {
    if (member.state.kind !== "pending") return;
    const { batch } = member;
    if (!hasAuthority(batch)) {
      retireBatch(batch);
      return;
    }
    member.state = state;
    flushBatch(batch);
  }

  function handleFiles(view: EditorView, files: File[], pos: number): boolean {
    if (!files.length || !session.canEdit) return false;
    const runtime = runtimes.get(view);
    if (!runtime || runtime.destroyed || view.isDestroyed) return false;

    const materializedFiles = [...files];
    const originalAnchor = Math.min(Math.max(pos, 0), view.state.doc.content.size);
    const batch: UploadBatch = {
      runtime,
      view,
      originalAnchor,
      files: materializedFiles,
      members: [],
      next: 0,
      active: true,
      flushScheduled: false,
    };
    batch.members.push(
      ...materializedFiles.map((file) => {
        const placeholder = createPlaceholder(file);
        return {
          batch,
          id: {},
          file,
          placeholderDom: placeholder.dom,
          cleanup: placeholder.destroy,
          state: { kind: "pending" } as UploadState,
        };
      }),
    );
    runtime.batches.add(batch);
    for (const member of batch.members) runtime.members.set(member.id, member);

    try {
      view.dispatch(
        view.state.tr.setMeta(imageUploadKey, {
          add: batch.members.map((member, side) => ({
            id: member.id,
            pos: batch.originalAnchor,
            dom: member.placeholderDom,
            side,
          })),
        } satisfies PlaceholderMeta),
      );
    } catch (error) {
      retireBatch(batch);
      throw error;
    }

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
        (result) => settleMember(member, { kind: "success", result }),
        (error: unknown) => settleMember(member, { kind: "failure", error }),
      );
    }
    if (hasSynchronousFailure) flushBatch(batch);
    return true;
  }

  return new Plugin<DecorationSet>({
    key: imageUploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        set = set.map(tr.mapping, tr.doc);
        if (!session.canEdit) return DecorationSet.empty;
        set = set.remove(set.find(undefined, undefined, (spec) => spec.owner !== pluginIdentity));
        const meta = tr.getMeta(imageUploadKey) as PlaceholderMeta | undefined;
        if (meta?.add) {
          set = set.add(
            tr.doc,
            meta.add.map(({ id, pos, dom, side }) => Decoration.widget(pos, dom, { id, side, owner: pluginIdentity })),
          );
        }
        if (meta?.remove) {
          for (const { id } of meta.remove) set = set.remove(set.find(undefined, undefined, (spec) => spec.id === id));
        }
        return set;
      },
    },
    props: {
      decorations: ownedDecorations,
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        const { from, to } = view.state.selection;
        if (from !== to && session.canEdit) view.dispatch(view.state.tr.deleteSelection());
        return handleFiles(view, files, view.state.selection.from);
      },
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        const coords = dropPosition(view, event);
        return handleFiles(view, files, coords ?? view.state.selection.from);
      },
    },
    view(view) {
      const runtime: UploadRuntime = { view, batches: new Set(), members: new Map(), destroyed: false };
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
