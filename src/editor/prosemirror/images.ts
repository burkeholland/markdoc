import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "../markdown/schema";

/** Uploads a file and resolves with the URL to put in the document (and optionally alt text). */
export type ImageUploader = (file: File) => Promise<{ url: string; alt?: string }>;

export interface ImageUploadOptions {
  /** Called when an upload fails, after the placeholder has been removed. */
  onError?: (message: string, file: File) => void;
}

interface PlaceholderMeta {
  add?: { id: object; pos: number; dom: HTMLElement };
  remove?: { id: object };
}

export const imageUploadKey = new PluginKey<DecorationSet>("imageUpload");

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
  return {
    dom,
    destroy() {
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
  const cleanups = new Map<object, () => void>();

  function startUpload(view: EditorView, file: File, pos: number) {
    const id = {};
    const placeholder = createPlaceholder(file);
    cleanups.set(id, placeholder.destroy);
    view.dispatch(view.state.tr.setMeta(imageUploadKey, { add: { id, pos, dom: placeholder.dom } } satisfies PlaceholderMeta));

    const finish = (tr: Transaction) => {
      cleanups.get(id)?.();
      cleanups.delete(id);
      if (!view.isDestroyed) view.dispatch(tr.setMeta(imageUploadKey, { remove: { id } } satisfies PlaceholderMeta));
    };

    upload(file).then(
      ({ url, alt }) => {
        if (view.isDestroyed) return;
        const at = findPlaceholder(view.state, id);
        if (at === null) return;
        const node = schema.nodes.image.create({ src: url, alt: alt ?? altFromFileName(file.name) });
        finish(view.state.tr.replaceWith(at, at, node).scrollIntoView());
      },
      (err: unknown) => {
        if (!view.isDestroyed) finish(view.state.tr);
        options.onError?.(err instanceof Error ? err.message : "Upload failed", file);
      },
    );
  }

  function handleFiles(view: EditorView, files: File[], pos: number): boolean {
    if (!files.length || !session.canEdit) return false;
    const at = Math.min(Math.max(pos, 0), view.state.doc.content.size);
    for (const file of files) startUpload(view, file, at);
    return true;
  }

  return new Plugin<DecorationSet>({
    key: imageUploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        set = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(imageUploadKey) as PlaceholderMeta | undefined;
        if (meta?.add) {
          const { id, pos, dom } = meta.add;
          set = set.add(tr.doc, [Decoration.widget(pos, dom, { id, side: 0 })]);
        }
        if (meta?.remove) {
          const { id } = meta.remove;
          set = set.remove(set.find(undefined, undefined, (spec) => spec.id === id));
        }
        return set;
      },
    },
    props: {
      decorations: (state) => imageUploadKey.getState(state) ?? null,
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
    view() {
      return {
        destroy() {
          for (const cleanup of cleanups.values()) cleanup();
          cleanups.clear();
        },
      };
    },
  });
}
