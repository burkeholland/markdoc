"use client";
import "./import.css";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileText, Loader2, XCircle } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { apiErrorText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { uploadImportBatch, type FailedImport, type ImportedDocument } from "@/lib/import-upload";
import { IMPORT_ACCEPT, IMPORT_EXTENSIONS, IMPORT_EXTENSIONS_LIST, importFormatFor } from "@/lib/import-extensions";

/** The server's list (`@/lib/import-extensions`), kept under the name this module has always exported. */
export const IMPORT_FILE_EXTENSIONS = IMPORT_EXTENSIONS;
export { IMPORT_ACCEPT };

/** The drop-zone toast when nothing importable was dropped: the server's 415 sentence with a capital. */
const NOTHING_IMPORTABLE_MESSAGE = `${IMPORT_EXTENSIONS_LIST[0].toUpperCase()}${IMPORT_EXTENSIONS_LIST.slice(1)}.`;

/** Same predicate the server applies before it answers 415, so the client never disagrees with it. */
export function isImportableFile(file: File): boolean {
  return importFormatFor(file.name) !== null;
}

/** Split a drop/pick into documents to import and images that may be referenced by them. */
export function splitImportFiles(files: Iterable<File>): { documents: File[]; images: File[]; ignored: File[] } {
  const documents: File[] = [];
  const images: File[] = [];
  const ignored: File[] = [];
  for (const f of files) {
    if (isImportableFile(f)) documents.push(f);
    else if (f.type.startsWith("image/")) images.push(f);
    else ignored.push(f);
  }
  return { documents, images, ignored };
}

/** True when a drag carries files (not text or editor content). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

export type ImportItemStatus = "uploading" | "done" | "error";

export interface ImportItem {
  name: string;
  status: ImportItemStatus;
  id?: string;
  title?: string;
  warnings: string[];
  error?: string;
  /** Internal action shared by the failed rows in the current in-memory batch. */
  retry?: () => void;
}

interface RetryOwnership {
  authority: HookAuthority;
  generation: number;
  files: Map<number, File>;
  images: File[];
}

interface HookAuthority {
  readonly token: symbol;
}

interface InitialBatchOwnership {
  kind: "initial";
  authority: HookAuthority;
  generation: number;
  selectedFiles: File[];
  documents: File[];
  images: File[];
  ignoredNames: string[];
}

interface RetryBatchOwnership {
  kind: "retry";
  authority: HookAuthority;
  generation: number;
  retryOwnership: RetryOwnership;
  rowIndexes: number[];
  documents: File[];
  images: File[];
}

type UploadOwnership = InitialBatchOwnership | RetryBatchOwnership;

function summarizeImportItems(items: ImportItem[]): { documents: ImportedDocument[]; failed: FailedImport[] } {
  return {
    documents: items.flatMap((item) =>
      item.status === "done" && item.id
        ? [{ id: item.id, title: item.title ?? item.name, warnings: item.warnings }]
        : [],
    ),
    failed: items.flatMap((item, index) =>
      item.status === "error"
        ? [{ index, name: item.name, error: item.error ?? "Import failed" }]
        : [],
    ),
  };
}

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ImportItem[];
  ignored: string[];
  /** Rendered under the list (for example a "Done" button). */
  footer?: ReactNode;
}

function StatusIcon({ status }: { status: ImportItemStatus }) {
  if (status === "uploading") return <Loader2 size={16} className="animate-spin text-ink-3" aria-label="Importing" />;
  if (status === "done") return <CheckCircle2 size={16} className="text-emerald-600" aria-label="Imported" />;
  return <XCircle size={16} className="text-red-600" aria-label="Failed" />;
}

/** Per-file progress and "Open" links for an import batch. */
export function ImportDialog({ open, onOpenChange, items, ignored, footer }: ImportDialogProps) {
  const busy = items.some((i) => i.status === "uploading");
  const retry = items.find((i) => i.retry)?.retry;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title="Import files" description="Each file becomes a new document. Images dropped with a Markdown file are attached to it.">
        <div data-testid="import-dialog">
          <ul className="import-list" data-testid="import-list">
            {items.map((item, i) => (
              <li key={`${item.name}-${i}`} className="import-item" data-testid="import-item" data-status={item.status}>
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="shrink-0 text-ink-4" />
                    <span className="truncate text-sm text-ink" title={item.name}>
                      {item.title ?? item.name}
                    </span>
                    {item.title && item.title !== item.name && <span className="truncate text-xs text-ink-4">{item.name}</span>}
                  </div>
                  {item.error && <div className="mt-0.5 text-xs text-red-600">{item.error}</div>}
                  {item.warnings.map((w, j) => (
                    <div key={j} className="import-warning" data-testid="import-warning">
                      <AlertTriangle size={12} /> {w}
                    </div>
                  ))}
                </div>
                {item.id && (
                  <Link href={`/d/${item.id}`} className="import-open" data-testid="import-open" onClick={() => onOpenChange(false)}>
                    Open
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {ignored.length > 0 && (
            <p className="mt-3 text-xs text-ink-3" data-testid="import-ignored">
              Skipped {ignored.length === 1 ? "1 file" : `${ignored.length} files`} that {ignored.length === 1 ? "is" : "are"} not Markdown, text, HTML or an image: {ignored.slice(0, 4).join(", ")}
              {ignored.length > 4 ? "…" : ""}
            </p>
          )}
          {retry && (
            <button type="button" className="btn btn-sm btn-outline mt-4" disabled={busy} onClick={retry}>
              Retry failed
            </button>
          )}
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface UseFileImportOptions {
  /**
   * Called after each upload attempt. After a retry, the arguments describe the current result for the
   * whole original batch so callers retain accurate partial-success accounting.
   */
  onDone?: (documents: ImportedDocument[], failed: FailedImport[]) => void;
  onError?: (message: string) => void;
}

/**
 * State for importing a set of files: a dropzone flag for whole-page drags, the hidden
 * file input, the dialog items and the upload itself.
 */
export function useFileImport(options: UseFileImportOptions = {}) {
  const [items, setItems] = useState<ImportItem[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<ImportItem[]>([]);
  const generationRef = useRef(0);
  const authorityRef = useRef<HookAuthority | null>(null);
  const activeUploadRef = useRef<UploadOwnership | null>(null);
  const retryOwnershipRef = useRef<RetryOwnership | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const replaceItems = useCallback((next: ImportItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const ownsUpload = useCallback(
    (ownership: UploadOwnership) =>
      authorityRef.current === ownership.authority &&
      activeUploadRef.current === ownership &&
      generationRef.current === ownership.generation,
    [],
  );

  const setDialogOpen = useCallback((next: boolean) => {
    if (!next) {
      if (activeUploadRef.current) return;
      retryOwnershipRef.current = null;
    }
    setOpen(next);
  }, []);

  const retryFailed = useCallback(async () => {
    const authority = authorityRef.current;
    const retryOwnership = retryOwnershipRef.current;
    if (!authority || activeUploadRef.current || !retryOwnership || retryOwnership.authority !== authority) return;

    const entries = Array.from(retryOwnership.files.entries()).sort(([a], [b]) => a - b);
    if (entries.length === 0) return;

    const rowIndexes = entries.map(([index]) => index);
    const documents = entries.map(([, file]) => file);
    const ownership: RetryBatchOwnership = {
      kind: "retry",
      authority,
      generation: retryOwnership.generation,
      retryOwnership,
      rowIndexes,
      documents,
      images: retryOwnership.images,
    };
    activeUploadRef.current = ownership;
    if (!ownsUpload(ownership)) return;
    replaceItems(
      itemsRef.current.map((item, index) =>
        retryOwnership.files.has(index) ? { ...item, status: "uploading", warnings: [], error: undefined } : item,
      ),
    );

    try {
      const { documents: created, failed } = await uploadImportBatch(documents, ownership.images);
      if (!ownsUpload(ownership)) return;

      const failedAt = new Map(failed.map((failure) => [failure.index, failure.error]));
      const retained = new Map<number, File>();
      const outcomes = new Map<number, ImportItem>();
      let nextCreated = 0;
      for (let attemptIndex = 0; attemptIndex < rowIndexes.length; attemptIndex++) {
        const rowIndex = rowIndexes[attemptIndex];
        const file = documents[attemptIndex];
        const retry = itemsRef.current[rowIndex]?.retry;
        const error = failedAt.get(attemptIndex);
        if (error !== undefined) {
          retained.set(rowIndex, file);
          outcomes.set(rowIndex, { name: file.name, status: "error", warnings: [], error, retry });
          continue;
        }
        const document = created[nextCreated++];
        if (document) {
          outcomes.set(rowIndex, {
            name: file.name,
            status: "done",
            id: document.id,
            title: document.title,
            warnings: document.warnings,
          });
        } else {
          retained.set(rowIndex, file);
          outcomes.set(rowIndex, { name: file.name, status: "error", warnings: [], error: "Import failed", retry });
        }
      }

      const nextItems = itemsRef.current.map((item, index) => outcomes.get(index) ?? item);
      if (!ownsUpload(ownership)) return;
      replaceItems(nextItems);
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = retained.size
        ? { authority, generation: ownership.generation, files: retained, images: ownership.images }
        : null;
      const result = summarizeImportItems(nextItems);
      if (ownsUpload(ownership)) {
        optionsRef.current.onDone?.(result.documents, result.failed);
      }
    } catch (err) {
      if (!ownsUpload(ownership)) return;
      const message = apiErrorText(err, "Import failed");
      const nextItems = itemsRef.current.map((item, index) =>
        retryOwnership.files.has(index) ? { ...item, status: "error" as const, warnings: [], error: message } : item,
      );
      if (!ownsUpload(ownership)) return;
      replaceItems(nextItems);
      if (ownsUpload(ownership)) optionsRef.current.onError?.(message);
      const result = summarizeImportItems(nextItems);
      if (ownsUpload(ownership)) {
        optionsRef.current.onDone?.(result.documents, result.failed);
      }
    } finally {
      if (ownsUpload(ownership)) activeUploadRef.current = null;
    }
  }, [ownsUpload, replaceItems]);

  const start = useCallback(async (files: Iterable<File>) => {
    const authority = authorityRef.current;
    if (!authority || activeUploadRef.current) return;

    const selectedFiles = Array.from(files);
    const { documents, images, ignored: skipped } = splitImportFiles(selectedFiles);
    const generation = ++generationRef.current;
    retryOwnershipRef.current = null;
    const ignoredNames = skipped.map((f) => f.name);
    setIgnored(ignoredNames);
    if (documents.length === 0) {
      const msg = images.length ? "Drop a Markdown, text or HTML file together with the images." : NOTHING_IMPORTABLE_MESSAGE;
      optionsRef.current.onError?.(msg);
      replaceItems([]);
      setOpen(skipped.length > 0 || images.length > 0);
      return;
    }

    const ownership: InitialBatchOwnership = {
      kind: "initial",
      authority,
      generation,
      selectedFiles,
      documents,
      images,
      ignoredNames,
    };
    activeUploadRef.current = ownership;
    if (!ownsUpload(ownership)) return;
    replaceItems(documents.map((f) => ({ name: f.name, status: "uploading", warnings: [] })));
    setOpen(true);
    try {
      const { documents: created, failed } = await uploadImportBatch(documents, images);
      if (!ownsUpload(ownership)) return;
      // `created` holds only the successes, so walk it with a cursor and let `failed[].index` claim its file.
      const failedAt = new Map(failed.map((f) => [f.index, f.error]));
      const retained = new Map<number, File>();
      let next = 0;
      const nextItems = documents.map((f, i): ImportItem => {
        const error = failedAt.get(i);
        if (error !== undefined) {
          retained.set(i, f);
          return { name: f.name, status: "error", warnings: [], error, retry: retryFailed };
        }
        const doc = created[next++];
        if (doc) return { name: f.name, status: "done", id: doc.id, title: doc.title, warnings: doc.warnings };
        retained.set(i, f);
        return { name: f.name, status: "error", warnings: [], error: "Import failed", retry: retryFailed };
      });
      if (!ownsUpload(ownership)) return;
      replaceItems(nextItems);
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = retained.size ? { authority, generation, files: retained, images } : null;
      if (ownsUpload(ownership)) optionsRef.current.onDone?.(created, failed);
    } catch (err) {
      if (!ownsUpload(ownership)) return;
      const message = apiErrorText(err, "Import failed");
      const nextItems = documents.map((f) => ({ name: f.name, status: "error" as const, warnings: [], error: message, retry: retryFailed }));
      if (!ownsUpload(ownership)) return;
      replaceItems(nextItems);
      if (ownsUpload(ownership)) optionsRef.current.onError?.(message);
      if (ownsUpload(ownership)) optionsRef.current.onDone?.([], []);
    } finally {
      if (ownsUpload(ownership)) activeUploadRef.current = null;
    }
  }, [ownsUpload, replaceItems, retryFailed]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  useLayoutEffect(() => {
    const authority: HookAuthority = { token: Symbol("file-import-authority") };
    authorityRef.current = authority;
    return () => {
      if (authorityRef.current !== authority) return;
      authorityRef.current = null;
      if (activeUploadRef.current?.authority === authority) activeUploadRef.current = null;
      if (retryOwnershipRef.current?.authority === authority) retryOwnershipRef.current = null;
      itemsRef.current = [];
    };
  }, []);

  // Whole-window drag tracking: show the overlay while files are dragged anywhere over the page.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void start(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [start]);

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={IMPORT_ACCEPT}
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      data-testid="import-file-input"
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
        if (files.length) void start(files);
      }}
    />
  );

  return { items, ignored, open, setOpen: setDialogOpen, dragging, start, pick, input };
}

/** Full-page overlay shown while files are dragged over the dashboard. */
export function ImportDropzone({ active, className }: { active: boolean; className?: string }) {
  return (
    <div className={cn("import-dropzone", active && "is-active", className)} data-testid="import-dropzone" data-active={active} aria-hidden={!active}>
      <div className="import-dropzone-card">
        <FileText size={28} />
        <span className="text-base font-semibold">Drop Markdown files to import</span>
        <span className="text-sm text-ink-3">.md, .txt and .html — images dropped alongside are attached</span>
      </div>
    </div>
  );
}
