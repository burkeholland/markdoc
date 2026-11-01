"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Dialog, DialogContent, Kbd } from "@/components/ui/primitives";
import { gridCell, type GridCell } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { findReplaceShortcut, shortcut } from "@/lib/utils";
import { IMAGE_TOO_LARGE_MESSAGE, isImageTooLarge } from "@/lib/image-limits";
import { isAbortError, videoFileError, type UploadedVideo, type VideoUploader } from "@/lib/video-limits";

/**
 * Editor actions picked in a dialog run after the dialog has closed and let go of focus (see
 * `DialogContent.onClosed`), so the caret ends up in the editor, not on the toolbar button.
 */
type DialogActionVisit = object;

function useActiveVisit(visit: DialogActionVisit) {
  const activeVisit = useRef<DialogActionVisit | null>(null);
  useLayoutEffect(() => {
    activeVisit.current = visit;
    return () => {
      if (activeVisit.current === visit) activeVisit.current = null;
    };
  }, [visit]);
  return activeVisit;
}

function useAfterClose(visit: DialogActionVisit, activeVisit: React.RefObject<DialogActionVisit | null>) {
  const pending = useRef<{ visit: DialogActionVisit; run: () => void } | null>(null);
  useLayoutEffect(
    () => () => {
      if (pending.current?.visit === visit) pending.current = null;
    },
    [visit],
  );
  const onClosed = useCallback(() => {
    const action = pending.current;
    if (!action || action.visit !== visit || activeVisit.current !== visit) return;
    pending.current = null;
    action.run();
  }, [activeVisit, visit]);
  const defer = useCallback(
    (run: () => void) => {
      if (activeVisit.current === visit) pending.current = { visit, run };
    },
    [activeVisit, visit],
  );
  return { defer, onClosed };
}

function normalizeLinkHref(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^(https?:|mailto:|#|\/|\.)/i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

interface LinkDraft {
  visit: DialogActionVisit;
  open: boolean;
  initialHref: string;
  initialText: string;
  href: string;
  text: string;
}

function linkDraft(visit: DialogActionVisit, open: boolean, href: string, text: string): LinkDraft {
  return { visit, open, initialHref: href, initialText: text, href, text };
}

export const LinkDialog = memo(function LinkDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { href: string; text: string } | null;
  onSubmit: (href: string, text: string) => void;
  onRemove?: () => void;
}) {
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onRemove, onSubmit }), [onOpenChange, onRemove, onSubmit]);
  const activeVisit = useActiveVisit(visit);
  const initialHref = initial?.href ?? "";
  const initialText = initial?.text ?? "";
  const [storedDraft, setDraft] = useState<LinkDraft>(() => linkDraft(visit, open, initialHref, initialText));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open || draft.initialHref !== initialHref || draft.initialText !== initialText) {
    draft = linkDraft(visit, open, initialHref, initialText);
    setDraft(draft);
  }
  const { href, text } = draft;
  const after = useAfterClose(visit, activeVisit);
  const removeAvailable = Boolean(initialHref && onRemove);
  const applyDisabled = !href.trim();

  const closeWithAction = (run: () => void) => {
    after.defer(run);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initialHref ? "Edit link" : "Insert link"} onClosed={after.onClosed}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (applyDisabled || !open) return;
            const nextHref = normalizeLinkHref(href);
            const nextText = text.trim();
            closeWithAction(() => onSubmit(nextHref, nextText));
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            URL
            <input
              className="input"
              placeholder="https://example.com"
              value={href}
              onChange={(e) => setDraft({ ...draft, href: e.target.value })}
              required
              autoFocus
              data-testid="link-url"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Text
            <input
              className="input"
              placeholder="Link text (optional)"
              value={text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              data-testid="link-text"
            />
          </label>
          <div className="flex items-center justify-between pt-1">
            {removeAvailable && onRemove ? (
              <button type="button" className="btn btn-ghost text-danger" onClick={() => closeWithAction(onRemove)}>
                Remove link
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={applyDisabled} data-testid="link-submit">
                Apply
              </button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const IMAGE_TITLE = "Insert image";
const IMAGE_DESCRIPTION =
  "Paste the address of an image or upload one. Alt text describes the image for people who can't see it.";
const IMAGE_FILE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
const FILE_READ_ERROR_MESSAGE = "Could not read the selected file. Please choose it again.";

function readSelectedFile(input: HTMLInputElement): { file: File | null; error: string | null } {
  try {
    return { file: input.files?.[0] ?? null, error: null };
  } catch {
    input.value = "";
    return { file: null, error: FILE_READ_ERROR_MESSAGE };
  }
}

function imageUploadErrorText(error: unknown) {
  try {
    return apiErrorText(error, "Upload failed");
  } catch {
    return "Upload failed";
  }
}

interface ImageDraft {
  readonly visit: DialogActionVisit;
  readonly open: boolean;
  readonly src: string;
  readonly alt: string;
  readonly altRevision: number;
  readonly error: string | null;
  readonly previewFailed: boolean;
  readonly upload: symbol | null;
}

function imageDraft(visit: DialogActionVisit, open: boolean): ImageDraft {
  return { visit, open, src: "", alt: "", altRevision: 0, error: null, previewFailed: false, upload: null };
}

export const ImageDialog = memo(function ImageDialog({
  open,
  onOpenChange,
  onSubmit,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (src: string, alt: string) => void;
  /** Uploads a chosen file and returns the URL to use; when absent the Upload button is hidden. */
  onUpload?: (file: File) => Promise<{ url: string; alt?: string }>;
}) {
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onSubmit, onUpload }), [onOpenChange, onSubmit, onUpload]);
  const activeVisit = useActiveVisit(visit);
  const [storedDraft, setDraft] = useState<ImageDraft>(() => imageDraft(visit, open));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = imageDraft(visit, open);
    setDraft(draft);
  }
  const after = useAfterClose(visit, activeVisit);
  const fileInput = useRef<HTMLInputElement>(null);
  // The upload in flight for the current visit; a late result from a closed or replaced visit is dropped.
  const activeUpload = useRef<symbol | null>(null);
  useEffect(() => {
    if (!open) activeUpload.current = null;
    return () => {
      activeUpload.current = null;
    };
  }, [open, visit]);

  const uploading = draft.upload !== null;
  const src = draft.src.trim();
  const submitDisabled = uploading || !src;

  const update = (change: (current: ImageDraft) => ImageDraft) =>
    setDraft((current) => (current.visit === visit && current.open ? change(current) : current));

  const startUpload = (file: File, input: HTMLInputElement) => {
    if (!onUpload || activeUpload.current) return;
    let fallbackAlt: string;
    try {
      if (isImageTooLarge(file)) {
        input.value = "";
        update((current) => ({ ...current, error: IMAGE_TOO_LARGE_MESSAGE }));
        return;
      }
      fallbackAlt = file.name.replace(/\.[a-z0-9]{2,5}$/i, "");
    } catch {
      input.value = "";
      update((current) => ({ ...current, error: FILE_READ_ERROR_MESSAGE }));
      return;
    }
    const token = Symbol("image-upload");
    activeUpload.current = token;
    const altRevision = draft.altRevision;
    update((current) => ({ ...current, error: null, upload: token }));
    const settle = (result: { url: string; alt?: string } | null, error: unknown) => {
      if (activeUpload.current !== token) return;
      activeUpload.current = null;
      input.value = "";
      update((current) => {
        if (current.upload !== token) return current;
        if (!result) return { ...current, upload: null, error: imageUploadErrorText(error) };
        const alt = current.altRevision !== altRevision || current.alt ? current.alt : result.alt || fallbackAlt;
        return { ...current, src: result.url ?? "", alt, error: null, previewFailed: false, upload: null };
      });
    };
    new Promise<{ url: string; alt?: string }>((resolve) => resolve(onUpload(file))).then(
      (result) => settle(result, null),
      (error: unknown) => settle(null, error),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={IMAGE_TITLE} description={IMAGE_DESCRIPTION} onClosed={after.onClosed}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (submitDisabled || !open) return;
            const alt = draft.alt.trim();
            after.defer(() => onSubmit(src, alt));
            onOpenChange(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Image URL
            <div className="flex gap-2">
              <input
                className="input flex-1"
                placeholder="https://…/image.png"
                value={draft.src}
                onChange={(e) => {
                  const value = e.target.value;
                  update((current) => ({ ...current, src: value, previewFailed: false }));
                }}
                autoFocus
                data-testid="image-url"
              />
              {onUpload && (
                <>
                  <button
                    type="button"
                    className="btn btn-outline shrink-0"
                    onClick={() => {
                      if (!uploading) fileInput.current?.click();
                    }}
                    disabled={uploading}
                    data-testid="image-upload"
                  >
                    {uploading ? "Uploading…" : "Upload…"}
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept={IMAGE_FILE_ACCEPT}
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const input = e.currentTarget;
                      const selection = readSelectedFile(input);
                      if (selection.error) {
                        update((current) => ({ ...current, error: selection.error }));
                        return;
                      }
                      if (selection.file) startUpload(selection.file, input);
                    }}
                    data-testid="image-file"
                  />
                </>
              )}
            </div>
          </label>
          {draft.error && (
            <div className="text-sm text-danger wrap-anywhere" role="alert" data-testid="image-upload-error">
              {draft.error}
            </div>
          )}
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Alt text
            <input
              className="input"
              placeholder="Describe the image"
              value={draft.alt}
              onChange={(e) => {
                const value = e.target.value;
                update((current) => ({ ...current, alt: value, altRevision: current.altRevision + 1 }));
              }}
              data-testid="image-alt"
            />
          </label>
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              className="max-h-40 rounded-lg border border-line object-contain"
              style={{ display: draft.previewFailed ? "none" : undefined }}
              onError={() => update((current) => ({ ...current, previewFailed: true }))}
            />
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitDisabled} data-testid="image-submit">
              Insert
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

interface VideoDraft {
  readonly visit: DialogActionVisit;
  readonly open: boolean;
  readonly file: File | null;
  readonly fileName: string | null;
  readonly uploaded: UploadedVideo | null;
  readonly upload: symbol | null;
  readonly canceling: boolean;
  readonly progress: { uploaded: number; total: number } | null;
  readonly error: string | null;
}

function videoDraft(visit: DialogActionVisit, open: boolean): VideoDraft {
  return { visit, open, file: null, fileName: null, uploaded: null, upload: null, canceling: false, progress: null, error: null };
}

export const VideoDialog = memo(function VideoDialog({
  open,
  onOpenChange,
  onSubmit,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (video: UploadedVideo) => void;
  onUpload?: VideoUploader;
}) {
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onSubmit, onUpload }), [onOpenChange, onSubmit, onUpload]);
  const activeVisit = useActiveVisit(visit);
  const [storedDraft, setDraft] = useState<VideoDraft>(() => videoDraft(visit, open));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = videoDraft(visit, open);
    setDraft(draft);
  }
  const after = useAfterClose(visit, activeVisit);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeUpload = useRef<{ token: symbol; controller: AbortController } | null>(null);

  useEffect(() => {
    if (!open) {
      activeUpload.current?.controller.abort();
      activeUpload.current = null;
    }
    return () => {
      activeUpload.current?.controller.abort();
      activeUpload.current = null;
    };
  }, [open, visit]);

  const update = (change: (current: VideoDraft) => VideoDraft) =>
    setDraft((current) => (current.visit === visit && current.open ? change(current) : current));
  const uploading = draft.upload !== null;
  const percent = draft.progress?.total
    ? Math.min(100, Math.floor((draft.progress.uploaded / draft.progress.total) * 100))
    : 0;

  const startUpload = (file: File, input: HTMLInputElement) => {
    if (!onUpload || activeUpload.current) return;
    let name: string;
    let size: number;
    let validationError: string | null;
    try {
      name = file.name;
      size = file.size;
      validationError = videoFileError({ name, size, type: file.type });
    } catch {
      input.value = "";
      update((current) => ({ ...current, file: null, fileName: null, uploaded: null, error: FILE_READ_ERROR_MESSAGE }));
      return;
    }
    if (validationError) {
      input.value = "";
      update((current) => ({ ...current, file: null, fileName: null, uploaded: null, error: validationError }));
      return;
    }
    const token = Symbol("video-upload");
    const controller = new AbortController();
    activeUpload.current = { token, controller };
    update((current) => ({ ...current, file, fileName: name, uploaded: null, error: null, upload: token, canceling: false, progress: { uploaded: 0, total: size } }));

    const settle = (result: UploadedVideo | null, error: unknown) => {
      if (activeUpload.current?.token !== token) return;
      activeUpload.current = null;
      input.value = "";
      update((current) => {
        if (current.upload !== token) return current;
        if (!result) {
          return {
            ...current,
            upload: null,
            canceling: false,
            progress: null,
            error: isAbortError(error) ? null : apiErrorText(error, "Video upload failed"),
          };
        }
        return { ...current, uploaded: result, upload: null, canceling: false, progress: null, error: null };
      });
    };

    void Promise.resolve()
      .then(() =>
        onUpload(file, controller.signal, (uploaded, total) =>
          update((current) => (current.upload === token ? { ...current, progress: { uploaded, total } } : current)),
        ),
      )
      .then(
        (result) => settle(result, null),
        (error: unknown) => settle(null, error),
      );
  };

  const cancelUpload = () => {
    const active = activeUpload.current;
    if (!active || draft.canceling) return;
    active.controller.abort();
    update((current) => (current.upload === active.token ? { ...current, canceling: true } : current));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Insert video" description="Upload an MP4 or WebM video up to 100 MB." onClosed={after.onClosed}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.uploaded || uploading || !open) return;
            after.defer(() => onSubmit(draft.uploaded!));
            onOpenChange(false);
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-ink-2">
            Video file
            <div className="flex gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="video/mp4,video/webm,.mp4,.webm"
                className="hidden"
                disabled={uploading}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const selection = readSelectedFile(input);
                  if (selection.error) {
                    update((current) => ({ ...current, error: selection.error }));
                    return;
                  }
                  if (selection.file) startUpload(selection.file, input);
                }}
                data-testid="video-file"
              />
              {onUpload && (
                <button
                  type="button"
                  className="btn btn-outline shrink-0"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                  data-testid="video-upload"
                >
                  Choose…
                </button>
              )}
            </div>
          </label>
          {draft.file && !uploading && !draft.error && (
            <p className="text-sm text-ink-3" data-testid="video-file-name">
              {draft.uploaded ? `${draft.uploaded.name} is ready to insert.` : draft.fileName}
            </p>
          )}
          {uploading && (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3" data-testid="video-upload-progress">
              <div className="flex items-center justify-between gap-3 text-sm text-ink-2">
                <span className="min-w-0 truncate">{draft.canceling ? "Cancelling upload…" : `Uploading ${draft.fileName ?? "video"} (${percent}%)`}</span>
                <button type="button" className="btn btn-ghost shrink-0" onClick={cancelUpload} disabled={draft.canceling} data-testid="video-cancel">
                  {draft.canceling ? "Cancelling…" : "Cancel upload"}
                </button>
              </div>
              <progress className="w-full" value={draft.progress?.uploaded ?? 0} max={draft.progress?.total ?? 1} aria-label="Video upload progress" />
            </div>
          )}
          {draft.error && (
            <div className="text-sm text-danger wrap-anywhere" role="alert" data-testid="video-upload-error">
              {draft.error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={uploading || !draft.uploaded} data-testid="video-submit">
              Insert
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const GRID_ROWS = 6;
const GRID_COLS = 8;

interface TableDraft {
  visit: DialogActionVisit;
  open: boolean;
  focused: GridCell;
  hover: GridCell | null;
}

function tableDraft(visit: DialogActionVisit, open: boolean): TableDraft {
  return { visit, open, focused: { row: 0, col: 0 }, hover: null };
}

/**
 * Size picker as a WAI-ARIA grid (issue #160): one Tab stop (the focused cell is the only `tabIndex=0`),
 * arrows / Home / End move focus, the "rows × columns" label follows the keyboard as well as the mouse,
 * Enter or a click inserts, Tab leaves straight for the dialog's Close button.
 */
export const TableDialog = memo(function TableDialog({ open, onOpenChange, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; onSubmit: (rows: number, cols: number) => void }) {
  const visit = useMemo<DialogActionVisit>(() => ({ onOpenChange, onSubmit }), [onOpenChange, onSubmit]);
  const activeVisit = useActiveVisit(visit);
  const [storedDraft, setDraft] = useState<TableDraft>(() => tableDraft(visit, open));
  let draft = storedDraft;
  if (draft.visit !== visit || draft.open !== open) {
    draft = tableDraft(visit, open);
    setDraft(draft);
  }
  const { focused, hover } = draft;
  const after = useAfterClose(visit, activeVisit);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = hover ?? focused;
  const update = (change: (current: TableDraft) => TableDraft) =>
    setDraft((current) => (current.visit === visit && current.open ? change(current) : current));

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return;
    if (event.target !== cells.current[focused.row * GRID_COLS + focused.col]) return;
    const next = gridCell(event.key, focused, GRID_ROWS, GRID_COLS, { ctrl: event.ctrlKey || event.metaKey });
    if (!next) return;
    event.preventDefault();
    update((current) => ({ ...current, focused: next, hover: null }));
    cells.current[next.row * GRID_COLS + next.col]?.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Insert table" description="Pick a size. The first row becomes the header." onClosed={after.onClosed}>
        <div className="flex flex-col items-center gap-3">
          <div
            className="flex flex-col gap-1"
            role="grid"
            aria-label="Table size"
            onMouseLeave={() => update((current) => ({ ...current, hover: null }))}
            onKeyDown={onGridKeyDown}
            data-testid="table-grid"
          >
            {Array.from({ length: GRID_ROWS }, (_, r) => (
              <div key={r} role="row" className="flex gap-1">
                {Array.from({ length: GRID_COLS }, (_, c) => {
                  const isFocused = focused.row === r && focused.col === c;
                  return (
                    <div key={c} role="gridcell">
                      <button
                        ref={(element) => {
                          cells.current[r * GRID_COLS + c] = element;
                        }}
                        type="button"
                        tabIndex={isFocused ? 0 : -1}
                        className={`block h-6 w-6 rounded border ${r < shown.row + 1 && c < shown.col + 1 ? "border-accent bg-accent-soft" : "border-line-2 bg-surface"}`}
                        onMouseEnter={() => update((current) => ({ ...current, hover: { row: r, col: c } }))}
                        onFocus={() => update((current) => ({ ...current, focused: { row: r, col: c }, hover: null }))}
                        onClick={() => {
                          if (!open) return;
                          after.defer(() => onSubmit(r + 1, c + 1));
                          onOpenChange(false);
                        }}
                        aria-label={`${r + 1} by ${c + 1}`}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="text-sm text-ink-3" data-testid="table-grid-label">
            {shown.row + 1} rows × {shown.col + 1} columns
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export interface NameVersionVisit {
  id: number;
  editor: object;
  documentId: string;
}

export interface NameVersionSaveOwner {
  visit: NameVersionVisit;
  editor: object;
  documentId: string;
  operationId: number;
  title: string;
}

export const NameVersionDialog = memo(function NameVersionDialog({
  open,
  visit,
  onOpenChange,
  nextOperationId,
  onSubmit,
}: {
  open: boolean;
  visit: NameVersionVisit;
  onOpenChange: (visit: NameVersionVisit, open: boolean) => void;
  nextOperationId: () => number;
  onSubmit: (owner: NameVersionSaveOwner) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeVisit = useRef<NameVersionVisit | null>(null);
  const activeSave = useRef<NameVersionSaveOwner | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open) {
      activeVisit.current = visit;
      activeSave.current = null;
      setTitle("");
      setError(null);
      setBusy(false);
    } else if (activeVisit.current === visit) {
      activeVisit.current = null;
      activeSave.current = null;
    }
    return () => {
      if (activeVisit.current === visit) {
        activeVisit.current = null;
        activeSave.current = null;
      }
    };
  }, [open, visit]);
  const ownsSave = (owner: NameVersionSaveOwner) => activeVisit.current === owner.visit && activeSave.current === owner;
  const setOpen = (nextOpen: boolean) => {
    if (!nextOpen && activeVisit.current === visit) {
      activeVisit.current = null;
      activeSave.current = null;
    }
    onOpenChange(visit, nextOpen);
  };

  // Arrow keys, Home and End move between the enabled action buttons.
  const onActionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const elements = [cancelButton.current, saveButton.current];
    const enabled = (index: number) => {
      const element = elements[index];
      return Boolean(element && !element.disabled);
    };
    const source = elements.indexOf(event.target as HTMLButtonElement);
    if (source < 0 || !enabled(source)) return;
    const indices = elements.map((_, index) => index).filter(enabled);
    let destination: number | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") destination = indices.filter((i) => i < source).at(-1);
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") destination = indices.find((i) => i > source);
    else if (event.key === "Home") destination = indices[0];
    else if (event.key === "End") destination = indices.at(-1);
    else return;
    if (destination === undefined || destination === source) return;
    event.preventDefault();
    elements[destination]?.focus({ preventScroll: true });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Name this version" description="Named versions stay easy to find in the history.">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const currentVisit = activeVisit.current;
            const submittedTitle = title.trim();
            if (!currentVisit || activeSave.current || !submittedTitle) return;
            const owner = Object.freeze({
              visit: currentVisit,
              editor: currentVisit.editor,
              documentId: currentVisit.documentId,
              operationId: nextOperationId(),
              title: submittedTitle,
            });
            activeSave.current = owner;
            setError(null);
            setBusy(true);
            try {
              await onSubmit(owner);
              if (ownsSave(owner)) setOpen(false);
            } catch (reason) {
              if (ownsSave(owner)) setError(apiErrorText(reason, "Could not save version"));
            } finally {
              if (ownsSave(owner)) {
                activeSave.current = null;
                setBusy(false);
              }
            }
          }}
        >
          <input
            className="input"
            placeholder="e.g. Draft sent for review"
            value={title}
            onChange={(e) => {
              if (!activeSave.current) setTitle(e.target.value);
            }}
            disabled={busy}
            autoFocus
            data-testid="version-name"
          />
          {error && (
            <div className="text-sm text-danger wrap-anywhere" role="alert" data-testid="version-name-error">
              {error}
            </div>
          )}
          {busy && (
            <div className="text-sm text-ink-3" role="status">
              Closing this dialog does not cancel the version already being saved.
            </div>
          )}
          <div className="flex justify-end gap-2" onKeyDown={onActionsKeyDown}>
            <button ref={cancelButton} type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              ref={saveButton}
              type="submit"
              className="btn btn-primary"
              disabled={busy || !title.trim()}
              data-testid="version-name-submit"
            >
              Save version
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
});

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "General",
    items: [
      ["Command palette", "Mod-Shift-P"],
      ["Command palette (no selection)", "Mod-K"],
      ["Document statistics and goal", "Mod-Shift-C"],
      ["Keyboard shortcuts", "Mod-/"],
      ["Stop following a collaborator", "Esc"],
      ["Toolbar: move between buttons / first, last", "← → / Home, End"],
    ],
  },
  {
    group: "Formatting",
    items: [
      ["Bold", "Mod-B"],
      ["Italic", "Mod-I"],
      ["Strikethrough", "Mod-Shift-X"],
      ["Inline code", "Mod-`"],
      ["Link (with a selection)", "Mod-K"],
      ["Heading 1–6 / Paragraph", "Mod-Alt-1…6 / 0"],
      ["Bulleted list", "Mod-Shift-8"],
      ["Numbered list", "Mod-Shift-7"],
      ["Task list", "Mod-Shift-9"],
      ["Quote", "Mod-Shift-."],
      ["Code block", "Mod-Alt-C"],
      ["Code block with a language (preview)", "```lang + Enter"],
      ["Toggle the task checkbox (preview)", "Mod-Enter"],
    ],
  },
  {
    group: "Editing",
    items: [
      ["Undo / Redo", "Mod-Z / Mod-Shift-Z"],
      ["Line break", "Shift-Enter"],
      ["Indent / outdent list item", "Tab / Shift-Tab"],
      ["Add comment", "Mod-Alt-M"],
      ["Find", "Mod-F"],
      ["Find and replace", findReplaceShortcut()],
      ["Next / previous match", "Enter / Shift-Enter"],
      ["Close find", "Esc"],
      ["Clear the selection / hide the table menu", "Esc"],
    ],
  },
  {
    group: "Tables",
    items: [
      ["Next / previous cell", "Tab / Shift-Tab"],
      ["Row below / above", "Mod-Alt-↓ / ↑"],
      ["Column right / left", "Mod-Alt-→ / ←"],
      ["Delete row", "Mod-Alt-⌫"],
      ["Delete column", "Mod-Alt-Shift-⌫"],
      ["New row from the last cell", "Enter / Tab"],
      ["Leave the table (paragraph below)", "Mod-Enter / ↓ from the last row"],
      ["Delete empty table", "⌫"],
    ],
  },
  {
    group: "Blocks",
    items: [
      ["Insert block menu", "/"],
      ["Leave a quote or list", "Enter on an empty line"],
      ["Leave a code block", "Mod-Enter / Shift-Enter, or Enter ×3"],
    ],
  },
  {
    group: "Code pane",
    items: [
      ["Wrap selection", "* _ ` ["],
      ["Code block", "``` or ~~~ at line start"],
      ["Indent / outdent list item", "Tab / Shift-Tab"],
    ],
  },
  {
    group: "Markdown shortcuts in the preview",
    items: [
      ["Heading", "# + space"],
      ["List", "- or 1. + space"],
      ["Task", "- [ ] + space"],
      ["Quote", "> + space"],
      ["Code block", "``` + language"],
      ["Divider", "---"],
    ],
  },
];

export const ShortcutsDialog = memo(function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" wide>
        <div className="grid gap-6 sm:grid-cols-2">
          {SHORTCUTS.map((g) => (
            <div key={g.group}>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">{g.group}</div>
              <ul className="flex flex-col gap-1.5">
                {g.items.map(([label, keys]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm text-ink-2">
                    <span>{label}</span>
                    <Kbd>{shortcut(keys)}</Kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs text-ink-3" data-testid="shortcuts-panels-note">
          Esc dismisses floating things — menus, the find bar, dialogs. The docked Comments and Version history panels close from the × in their header.
        </p>
      </DialogContent>
    </Dialog>
  );
});
