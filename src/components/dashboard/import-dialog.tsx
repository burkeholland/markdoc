"use client";
import "./import.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
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

type StartFileImport = (files: Iterable<File>) => Promise<void>;

interface DragListenerOwner {
  active: boolean;
  readonly authority: HookAuthority;
  readonly target: Window;
  depth: number;
  start: StartFileImport;
  readonly enter: (event: DragEvent) => void;
  readonly over: (event: DragEvent) => void;
  readonly leave: (event: DragEvent) => void;
  readonly drop: (event: DragEvent) => void;
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

interface ImportItemPublication {
  readonly index: number;
  readonly source: ImportItem;
  readonly sourceWarnings: string[];
  readonly name: string;
  readonly status: ImportItemStatus;
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly warnings: readonly string[];
  readonly error: string | undefined;
  readonly retry: (() => void) | undefined;
  readonly href: string | null;
}

interface IgnoredImportPublication {
  readonly source: string[];
  readonly names: readonly string[];
  readonly text: string | null;
}

interface ImportResultPublication {
  readonly mount: symbol;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sourceItems: ImportItem[];
  readonly items: readonly ImportItemPublication[];
  readonly busy: boolean;
  readonly retry: (() => void) | undefined;
  readonly ignored: IgnoredImportPublication;
  readonly footer: ReactNode;
}

interface ImportRowElements {
  item: HTMLLIElement | null;
  open: HTMLAnchorElement | null;
}

interface ImportResultPublicationRuntime {
  active: boolean;
  dialog: HTMLDivElement | null;
  root: HTMLDivElement | null;
  list: HTMLUListElement | null;
  rows: ImportRowElements[];
  ignored: HTMLParagraphElement | null;
  retry: HTMLButtonElement | null;
}

function ImportResultPublicationBoundary({
  publication,
  publish,
  retire,
  children,
}: {
  publication: ImportResultPublication;
  publish: (publication: ImportResultPublication) => void;
  retire: (publication: ImportResultPublication) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    publish(publication);
    return () => retire(publication);
  }, [publication, publish, retire]);
  return children;
}

function snapshotImportItem(item: ImportItem, index: number): ImportItemPublication {
  const id = item.id;
  return Object.freeze({
    index,
    source: item,
    sourceWarnings: item.warnings,
    name: item.name,
    status: item.status,
    id,
    title: item.title,
    warnings: Object.freeze([...item.warnings]),
    error: item.error,
    retry: item.retry,
    href: id ? `/d/${id}` : null,
  });
}

function ignoredImportText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const count = names.length === 1 ? "1 file" : `${names.length} files`;
  const verb = names.length === 1 ? "is" : "are";
  const overflow = names.length > 4 ? "…" : "";
  return `Skipped ${count} that ${verb} not Markdown, text, HTML or an image: ${names.slice(0, 4).join(", ")}${overflow}`;
}

function importResultFactsAreCurrent(publication: ImportResultPublication): boolean {
  const { sourceItems, items } = publication;
  if (sourceItems.length !== items.length) return false;

  for (const row of items) {
    const item = sourceItems[row.index];
    if (
      item !== row.source ||
      item.name !== row.name ||
      item.status !== row.status ||
      item.id !== row.id ||
      item.title !== row.title ||
      item.error !== row.error ||
      item.retry !== row.retry ||
      item.warnings !== row.sourceWarnings ||
      item.warnings.length !== row.warnings.length
    ) {
      return false;
    }
    for (let index = 0; index < row.warnings.length; index++) {
      if (item.warnings[index] !== row.warnings[index]) return false;
    }
  }

  const busy = sourceItems.some((item) => item.status === "uploading");
  const retry = sourceItems.find((item) => item.retry)?.retry;
  if (busy !== publication.busy || retry !== publication.retry) return false;
  if (retry) {
    if (sourceItems.some((item) => item.retry && item.retry !== retry)) return false;
    if (!busy && !sourceItems.some((item) => item.status === "error" && item.retry === retry)) return false;
  }

  const { source, names, text } = publication.ignored;
  if (source.length !== names.length || text !== ignoredImportText(names)) return false;
  for (let index = 0; index < names.length; index++) {
    if (source[index] !== names[index]) return false;
  }
  return true;
}

function isExactNativeResultClick<T extends HTMLElement>(event: ReactMouseEvent<T>, control: T): boolean {
  const ownerWindow = control.ownerDocument.defaultView;
  const target = event.target;
  return (
    event.type === "click" &&
    ownerWindow !== null &&
    event.nativeEvent instanceof ownerWindow.MouseEvent &&
    event.nativeEvent.type === "click" &&
    event.currentTarget === control &&
    target instanceof ownerWindow.Node &&
    target === event.nativeEvent.target &&
    target === control &&
    control.contains(target)
  );
}

function StatusIcon({ status }: { status: ImportItemStatus }) {
  if (status === "uploading") return <Loader2 size={16} className="animate-spin text-ink-3" aria-label="Importing" />;
  if (status === "done") return <CheckCircle2 size={16} className="text-emerald-600" aria-label="Imported" />;
  return <XCircle size={16} className="text-red-600" aria-label="Failed" />;
}

/** Per-file progress and "Open" links for an import batch. */
export function ImportDialog({ open, onOpenChange, items, ignored, footer }: ImportDialogProps) {
  const [mount] = useState(() => Symbol("import-result-dialog"));
  const activePublicationRef = useRef<ImportResultPublication | null>(null);
  const publicationRuntimesRef = useRef(new WeakMap<ImportResultPublication, ImportResultPublicationRuntime>());
  const claimedOpenPublicationsRef = useRef(new WeakSet<ImportResultPublication>());
  const claimedRetryPublicationsRef = useRef(new WeakSet<ImportResultPublication>());
  const publishedItems = Object.freeze(items.map(snapshotImportItem));
  const ignoredNames = Object.freeze([...ignored]);
  const publication: ImportResultPublication = Object.freeze({
    mount,
    open,
    onOpenChange,
    sourceItems: items,
    items: publishedItems,
    busy: publishedItems.some((item) => item.status === "uploading"),
    retry: publishedItems.find((item) => item.retry)?.retry,
    ignored: Object.freeze({
      source: ignored,
      names: ignoredNames,
      text: ignoredImportText(ignoredNames),
    }),
    footer,
  });

  const runtimeFor = useCallback((candidate: ImportResultPublication) => {
    const runtimes = publicationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        dialog: null,
        root: null,
        list: null,
        rows: candidate.items.map(() => ({ item: null, open: null })),
        ignored: null,
        retry: null,
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const retirePublication = useCallback((candidate: ImportResultPublication) => {
    const runtime = publicationRuntimesRef.current.get(candidate);
    if (runtime) runtime.active = false;
    if (activePublicationRef.current === candidate) activePublicationRef.current = null;
  }, []);

  const bindElement = useCallback(
    <K extends "root" | "list" | "ignored" | "retry">(
      candidate: ImportResultPublication,
      kind: K,
      element: ImportResultPublicationRuntime[K],
    ) => {
      const runtime = runtimeFor(candidate);
      const existing = runtime[kind];
      if (!element) {
        runtime[kind] = null;
        retirePublication(candidate);
        return;
      }
      if (runtime.active && existing && existing !== element) {
        retirePublication(candidate);
        return;
      }
      runtime[kind] = element;
    },
    [retirePublication, runtimeFor],
  );

  const bindRowElement = useCallback(
    <K extends keyof ImportRowElements>(
      candidate: ImportResultPublication,
      row: ImportItemPublication,
      kind: K,
      element: ImportRowElements[K],
    ) => {
      const runtime = runtimeFor(candidate);
      const elements = runtime.rows[row.index];
      if (!elements || candidate.items[row.index] !== row) {
        retirePublication(candidate);
        return;
      }
      const existing = elements[kind];
      if (!element) {
        elements[kind] = null;
        retirePublication(candidate);
        return;
      }
      if (runtime.active && existing && existing !== element) {
        retirePublication(candidate);
        return;
      }
      elements[kind] = element;
    },
    [retirePublication, runtimeFor],
  );

  const publicationDomIsValid = useCallback(
    (candidate: ImportResultPublication) => {
      if (candidate.mount !== mount || !candidate.open || !importResultFactsAreCurrent(candidate)) return false;
      const runtime = publicationRuntimesRef.current.get(candidate);
      const dialog = runtime?.dialog;
      const root = runtime?.root;
      const list = runtime?.list;
      if (
        !runtime ||
        !(dialog instanceof HTMLDivElement) ||
        !dialog.isConnected ||
        dialog.getAttribute("role") !== "dialog" ||
        !(root instanceof HTMLDivElement) ||
        !root.isConnected ||
        root.parentElement !== dialog ||
        dialog.lastElementChild !== root ||
        !(list instanceof HTMLUListElement) ||
        !list.isConnected ||
        list.parentElement !== root ||
        root.firstElementChild !== list ||
        list.children.length !== candidate.items.length ||
        runtime.rows.length !== candidate.items.length
      ) {
        return false;
      }

      let openCount = 0;
      for (const row of candidate.items) {
        const elements = runtime.rows[row.index];
        const item = elements?.item;
        const anchor = elements?.open;
        if (
          !(item instanceof HTMLLIElement) ||
          !item.isConnected ||
          item.parentElement !== list ||
          list.children.item(row.index) !== item ||
          item.getAttribute("data-status") !== row.status
        ) {
          return false;
        }
        if (row.href) {
          openCount++;
          if (
            !(anchor instanceof HTMLAnchorElement) ||
            !anchor.isConnected ||
            anchor.parentElement !== item ||
            item.lastElementChild !== anchor ||
            anchor.getAttribute("href") !== row.href ||
            item.querySelectorAll('[data-testid="import-open"]').length !== 1
          ) {
            return false;
          }
        } else if (anchor !== null || item.querySelector('[data-testid="import-open"]')) {
          return false;
        }
      }
      if (list.querySelectorAll('[data-testid="import-open"]').length !== openCount) return false;

      const ignoredElement = runtime.ignored;
      if (candidate.ignored.text) {
        if (
          !(ignoredElement instanceof HTMLParagraphElement) ||
          !ignoredElement.isConnected ||
          ignoredElement.parentElement !== root ||
          root.children.item(1) !== ignoredElement ||
          ignoredElement.textContent !== candidate.ignored.text ||
          root.querySelectorAll('[data-testid="import-ignored"]').length !== 1
        ) {
          return false;
        }
      } else if (ignoredElement !== null || root.querySelector('[data-testid="import-ignored"]')) {
        return false;
      }

      const retryElement = runtime.retry;
      if (candidate.retry) {
        const expectedIndex = candidate.ignored.text ? 2 : 1;
        if (
          !(retryElement instanceof HTMLButtonElement) ||
          !retryElement.isConnected ||
          retryElement.parentElement !== root ||
          root.children.item(expectedIndex) !== retryElement ||
          retryElement.disabled !== candidate.busy ||
          retryElement.textContent?.trim() !== "Retry failed" ||
          root.querySelectorAll('[data-testid="import-retry"]').length !== 1
        ) {
          return false;
        }
      } else if (retryElement !== null || root.querySelector('[data-testid="import-retry"]')) {
        return false;
      }
      return true;
    },
    [mount],
  );

  const publicationIsCurrent = useCallback(
    (candidate: ImportResultPublication) =>
      activePublicationRef.current === candidate &&
      publicationRuntimesRef.current.get(candidate)?.active === true &&
      publicationDomIsValid(candidate),
    [publicationDomIsValid],
  );

  const claimOpen = useCallback(
    (candidate: ImportResultPublication, row: ImportItemPublication, source: HTMLAnchorElement) => {
      const runtime = publicationRuntimesRef.current.get(candidate);
      if (
        claimedOpenPublicationsRef.current.has(candidate) ||
        candidate.items[row.index] !== row ||
        row.href === null ||
        runtime?.rows[row.index]?.open !== source
      ) {
        return false;
      }
      if (!publicationIsCurrent(candidate)) {
        retirePublication(candidate);
        return false;
      }
      claimedOpenPublicationsRef.current.add(candidate);
      return true;
    },
    [publicationIsCurrent, retirePublication],
  );

  const claimRetry = useCallback(
    (candidate: ImportResultPublication, source: HTMLButtonElement) => {
      const runtime = publicationRuntimesRef.current.get(candidate);
      if (
        !candidate.retry ||
        candidate.busy ||
        source.disabled ||
        claimedRetryPublicationsRef.current.has(candidate) ||
        runtime?.retry !== source
      ) {
        return null;
      }
      if (!publicationIsCurrent(candidate)) {
        retirePublication(candidate);
        return null;
      }
      claimedRetryPublicationsRef.current.add(candidate);
      return candidate.retry;
    },
    [publicationIsCurrent, retirePublication],
  );

  const publishPublication = useCallback((candidate: ImportResultPublication) => {
    const existing = activePublicationRef.current;
    if (existing && existing !== candidate) retirePublication(existing);
    const runtime = runtimeFor(candidate);
    const dialog = runtime.root?.parentElement;
    runtime.dialog = dialog instanceof HTMLDivElement ? dialog : null;
    if (!publicationDomIsValid(candidate)) {
      retirePublication(candidate);
      return;
    }
    runtime.active = true;
    activePublicationRef.current = candidate;
  }, [publicationDomIsValid, retirePublication, runtimeFor]);

  return (
    <Dialog open={publication.open} onOpenChange={(next) => !publication.busy && publication.onOpenChange(next)}>
      <DialogContent title="Import files" description="Each file becomes a new document. Images dropped with a Markdown file are attached to it.">
        <ImportResultPublicationBoundary
          publication={publication}
          publish={publishPublication}
          retire={retirePublication}
        >
          <div ref={(element) => bindElement(publication, "root", element)} data-testid="import-dialog">
            <ul ref={(element) => bindElement(publication, "list", element)} className="import-list" data-testid="import-list">
              {publication.items.map((item) => (
                <li
                  ref={(element) => bindRowElement(publication, item, "item", element)}
                  key={`${item.name}-${item.index}`}
                  className="import-item"
                  data-testid="import-item"
                  data-status={item.status}
                >
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
                  {item.href && (
                    <Link
                      ref={(element) => bindRowElement(publication, item, "open", element)}
                      href={item.href}
                      className="import-open"
                      data-testid="import-open"
                      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                        if (!isExactNativeResultClick(event, event.currentTarget)) return;
                        if (claimOpen(publication, item, event.currentTarget)) publication.onOpenChange(false);
                      }}
                    >
                      Open
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            {publication.ignored.text && (
              <p
                ref={(element) => bindElement(publication, "ignored", element)}
                className="mt-3 text-xs text-ink-3"
                data-testid="import-ignored"
              >
                {publication.ignored.text}
              </p>
            )}
            {publication.retry && (
              <button
                ref={(element) => bindElement(publication, "retry", element)}
                type="button"
                className="btn btn-sm btn-outline mt-4"
                disabled={publication.busy}
                data-testid="import-retry"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  if (!isExactNativeResultClick(event, event.currentTarget)) return;
                  claimRetry(publication, event.currentTarget)?.();
                }}
              >
                Retry failed
              </button>
            )}
            {publication.footer}
          </div>
        </ImportResultPublicationBoundary>
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

  const dragOwnerRef = useRef<DragListenerOwner | null>(null);
  const startIntentRef = useRef(start);

  useLayoutEffect(() => {
    startIntentRef.current = start;
    const owner = dragOwnerRef.current;
    if (owner?.active && authorityRef.current === owner.authority) owner.start = start;
  }, [start]);

  useLayoutEffect(() => {
    const authority: HookAuthority = { token: Symbol("file-import-authority") };
    const target = window;
    const ownsListeners = () =>
      owner.active && dragOwnerRef.current === owner && authorityRef.current === owner.authority;
    const owner: DragListenerOwner = {
      active: true,
      authority,
      target,
      depth: 0,
      start: startIntentRef.current,
      enter: (event) => {
        if (!ownsListeners() || !dragHasFiles(event.dataTransfer)) return;
        owner.depth++;
        setDragging(true);
      },
      over: (event) => {
        if (!ownsListeners() || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      },
      leave: (event) => {
        if (!ownsListeners() || !dragHasFiles(event.dataTransfer)) return;
        owner.depth = Math.max(0, owner.depth - 1);
        if (owner.depth === 0) setDragging(false);
      },
      drop: (event) => {
        if (!ownsListeners()) return;
        owner.depth = 0;
        setDragging(false);
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) void owner.start(files);
      },
    };
    authorityRef.current = authority;
    dragOwnerRef.current = owner;
    target.addEventListener("dragenter", owner.enter);
    target.addEventListener("dragover", owner.over);
    target.addEventListener("dragleave", owner.leave);
    target.addEventListener("drop", owner.drop);
    return () => {
      owner.active = false;
      if (dragOwnerRef.current === owner) dragOwnerRef.current = null;
      if (authorityRef.current === authority) {
        authorityRef.current = null;
        if (activeUploadRef.current?.authority === authority) activeUploadRef.current = null;
        if (retryOwnershipRef.current?.authority === authority) retryOwnershipRef.current = null;
        itemsRef.current = [];
      }
      owner.target.removeEventListener("dragenter", owner.enter);
      owner.target.removeEventListener("dragover", owner.over);
      owner.target.removeEventListener("dragleave", owner.leave);
      owner.target.removeEventListener("drop", owner.drop);
    };
  }, []);

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
