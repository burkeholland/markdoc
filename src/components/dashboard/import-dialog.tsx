"use client";
import "./import.css";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileText, Loader2, XCircle } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export const IMPORT_FILE_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".txt", ".text", ".html", ".htm"];
export const IMPORT_ACCEPT = [...IMPORT_FILE_EXTENSIONS, "image/*"].join(",");

export interface ImportedDocument {
  id: string;
  title: string;
  warnings: string[];
}

export function isImportableFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return IMPORT_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
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

/** Upload files to `POST /api/import/file`; resolves with the created documents. */
export async function uploadImportFiles(documents: File[], images: File[] = []): Promise<ImportedDocument[]> {
  const form = new FormData();
  for (const f of documents) form.append("files", f, f.name);
  for (const f of images) form.append("images", f, f.name);
  const res = await fetch("/api/import/file", { method: "POST", body: form, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as { documents?: ImportedDocument[]; error?: string }) : {};
  if (!res.ok) throw new Error(data.error ?? `Import failed (${res.status})`);
  return data.documents ?? [];
}

export type ImportItemStatus = "uploading" | "done" | "error";

export interface ImportItem {
  name: string;
  status: ImportItemStatus;
  id?: string;
  title?: string;
  warnings: string[];
  error?: string;
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
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface UseFileImportOptions {
  /** Called once every file finished; `documents` holds the created documents (empty on failure). */
  onDone?: (documents: ImportedDocument[]) => void;
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
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const start = useCallback(async (files: Iterable<File>) => {
    const { documents, images, ignored: skipped } = splitImportFiles(files);
    setIgnored(skipped.map((f) => f.name));
    if (documents.length === 0) {
      const msg = images.length ? "Drop a Markdown, text or HTML file together with the images." : "Only .md, .txt and .html files can be imported.";
      optionsRef.current.onError?.(msg);
      setItems([]);
      setOpen(skipped.length > 0 || images.length > 0);
      return;
    }
    setItems(documents.map((f) => ({ name: f.name, status: "uploading", warnings: [] })));
    setOpen(true);
    try {
      const created = await uploadImportFiles(documents, images);
      setItems(documents.map((f, i) => ({ name: f.name, status: created[i] ? "done" : "error", id: created[i]?.id, title: created[i]?.title, warnings: created[i]?.warnings ?? [] })));
      optionsRef.current.onDone?.(created);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      setItems(documents.map((f) => ({ name: f.name, status: "error", warnings: [], error: message })));
      optionsRef.current.onError?.(message);
      optionsRef.current.onDone?.([]);
    }
  }, []);

  const pick = useCallback(() => inputRef.current?.click(), []);

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

  return { items, ignored, open, setOpen, dragging, start, pick, input };
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
