"use client";
import "./import.css";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
const MALFORMED_IMPORT_RESULT_MESSAGE = "Import returned an invalid result";
const MAX_IMPORT_RESULT_WARNINGS = 1_000;
const arrayIsArray = Array.isArray;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const structuredCloneValue =
  typeof globalThis.structuredClone === "function"
    ? globalThis.structuredClone.bind(globalThis)
    : null;

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
  /** Internal action for this exact failed row in the current in-memory batch. */
  retry?: () => void;
  /** Internal action shared by all failed rows in the current in-memory batch. */
  retryAll?: () => void;
}

interface RetryOwnership {
  authority: HookAuthority;
  generation: number;
  files: ReadonlyMap<number, File>;
  images: File[];
  retryAll: () => void;
}

interface HookAuthority {
  readonly token: symbol;
  readonly onDone: UseFileImportOptions["onDone"];
  readonly onError: UseFileImportOptions["onError"];
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

type RetryRequest = (
  ownership: RetryOwnership,
  rowIndex: number | null,
  action: () => void,
) => Promise<void> | void;

function createRetryOwnership(
  authority: HookAuthority,
  generation: number,
  files: ReadonlyMap<number, File>,
  images: File[],
  request: RetryRequest,
): RetryOwnership {
  const ownedFiles = new Map(files);
  const retryAll = () => request(ownership, null, retryAll);
  const ownership: RetryOwnership = Object.freeze({
    authority,
    generation,
    files: ownedFiles,
    images,
    retryAll,
  });
  return ownership;
}

function publishRetryItems(
  items: ImportItem[],
  ownership: RetryOwnership | null,
  request: RetryRequest,
): ImportItem[] {
  return items.map((item, index) => {
    const file = ownership?.files.get(index);
    if (!ownership || !file) {
      if (!item.retry && !item.retryAll) return item;
      const settled = { ...item };
      delete settled.retry;
      delete settled.retryAll;
      return settled;
    }

    const retry = () => request(ownership, index, retry);
    return { ...item, retry, retryAll: ownership.retryAll };
  });
}

function retryAllFrom(items: readonly Pick<ImportItem, "retry" | "retryAll">[]): (() => void) | undefined {
  return items.find((item) => item.retryAll)?.retryAll ?? items.find((item) => item.retry)?.retry;
}

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

interface NormalizedImportBatch {
  readonly documents: ImportedDocument[];
  readonly failed: FailedImport[];
  readonly failedAt: ReadonlyMap<number, FailedImport>;
}

function malformedImportResult(): never {
  throw new Error(MALFORMED_IMPORT_RESULT_MESSAGE);
}

function readStableDataProperty(source: object, property: PropertyKey): unknown {
  const first = getOwnPropertyDescriptor(source, property);
  const second = getOwnPropertyDescriptor(source, property);
  if (
    !first ||
    !second ||
    !("value" in first) ||
    !("value" in second) ||
    !Object.is(first.value, second.value) ||
    first.configurable !== second.configurable ||
    first.enumerable !== second.enumerable ||
    first.writable !== second.writable
  ) {
    malformedImportResult();
  }
  return first.value;
}

function requirePlainRecord(value: unknown): object {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) malformedImportResult();
  const firstPrototype = getPrototypeOf(value);
  const secondPrototype = getPrototypeOf(value);
  if (
    firstPrototype !== secondPrototype ||
    (firstPrototype !== Object.prototype && firstPrototype !== null)
  ) {
    malformedImportResult();
  }
  return value;
}

function requireExactKeys(source: object, expected: readonly string[]) {
  const first = ownKeys(source);
  const second = ownKeys(source);
  const matches = (keys: readonly PropertyKey[]) =>
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key));
  if (
    !matches(first) ||
    !matches(second)
  ) {
    malformedImportResult();
  }
}

function snapshotArray<T>(
  value: unknown,
  maximumLength: number,
  snapshot: (entry: unknown) => T,
): T[] {
  if (!arrayIsArray(value)) malformedImportResult();
  const rawLength = readStableDataProperty(value, "length");
  if (
    typeof rawLength !== "number" ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0 ||
    rawLength > maximumLength
  ) {
    malformedImportResult();
  }
  const expectedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < rawLength; index++) expectedKeys.add(String(index));
  for (const keys of [ownKeys(value), ownKeys(value)]) {
    if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
      malformedImportResult();
    }
  }
  const entries: T[] = [];
  for (let index = 0; index < rawLength; index++) {
    entries.push(snapshot(readStableDataProperty(value, index)));
  }
  Object.freeze(entries);
  return entries;
}

function snapshotString(value: unknown): string {
  if (typeof value !== "string") malformedImportResult();
  return value;
}

function normalizeImportBatchResult(raw: unknown, attempted: readonly File[]): NormalizedImportBatch {
  try {
    const result = requirePlainRecord(raw);
    requireExactKeys(result, ["documents", "failed"]);
    const documents = snapshotArray(
      readStableDataProperty(result, "documents"),
      attempted.length,
      (entry): ImportedDocument => {
        const document = requirePlainRecord(entry);
        requireExactKeys(document, ["id", "title", "warnings"]);
        const id = snapshotString(readStableDataProperty(document, "id"));
        const title = snapshotString(readStableDataProperty(document, "title"));
        const warnings = snapshotArray(
          readStableDataProperty(document, "warnings"),
          MAX_IMPORT_RESULT_WARNINGS,
          snapshotString,
        );
        return Object.freeze({ id, title, warnings });
      },
    );
    const failed = snapshotArray(
      readStableDataProperty(result, "failed"),
      attempted.length,
      (entry): FailedImport => {
        const failure = requirePlainRecord(entry);
        requireExactKeys(failure, ["index", "name", "error"]);
        const index = readStableDataProperty(failure, "index");
        const name = snapshotString(readStableDataProperty(failure, "name"));
        const error = snapshotString(readStableDataProperty(failure, "error"));
        if (typeof index !== "number" || !Number.isSafeInteger(index)) malformedImportResult();
        return Object.freeze({ index, name, error });
      },
    );
    if (documents.length + failed.length !== attempted.length) malformedImportResult();

    const failedAt = new Map<number, FailedImport>();
    for (const failure of failed) {
      if (
        failure.index < 0 ||
        failure.index >= attempted.length ||
        failedAt.has(failure.index) ||
        failure.name !== attempted[failure.index].name
      ) {
        malformedImportResult();
      }
      failedAt.set(failure.index, failure);
    }
    structuredCloneValue?.(raw);
    return Object.freeze({ documents, failed, failedAt });
  } catch {
    malformedImportResult();
  }
}

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ImportItem[];
  ignored: string[];
  /** Rendered under the list (for example a "Done" button). */
  footer?: ReactNode;
}

const IMPORT_DIALOG_TITLE = "Import files";
const IMPORT_DIALOG_DESCRIPTION =
  "Each file becomes a new document. Images dropped with a Markdown file are attached to it.";

function ignoredImportText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const count = names.length === 1 ? "1 file" : `${names.length} files`;
  const verb = names.length === 1 ? "is" : "are";
  const overflow = names.length > 4 ? "…" : "";
  return `Skipped ${count} that ${verb} not Markdown, text, HTML or an image: ${names.slice(0, 4).join(", ")}${overflow}`;
}

const NAVIGATION_CONTROLS = '[data-testid="import-open"], [data-testid="import-row-retry"], [data-testid="import-retry"]';
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** ArrowDown/ArrowUp/Home/End move focus between the dialog's Open and Retry controls, without wrapping. */
function onNavigateKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (!NAVIGATION_KEYS.has(event.key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(NAVIGATION_CONTROLS)).filter(
    (control) => !(control as HTMLButtonElement).disabled,
  );
  const source = controls.indexOf(event.target as HTMLElement);
  if (source < 0) return;
  let destination: number | null = null;
  if (event.key === "ArrowDown" && source + 1 < controls.length) destination = source + 1;
  else if (event.key === "ArrowUp" && source > 0) destination = source - 1;
  else if (event.key === "Home" && source !== 0) destination = 0;
  else if (event.key === "End" && source !== controls.length - 1) destination = controls.length - 1;
  if (destination === null) return;
  event.preventDefault();
  controls[destination]?.focus();
}

function StatusIcon({ status }: { status: ImportItemStatus }) {
  if (status === "uploading") return <Loader2 size={16} className="animate-spin text-ink-3" aria-label="Importing" />;
  if (status === "done") return <CheckCircle2 size={16} className="text-emerald-600" aria-label="Imported" />;
  return <XCircle size={16} className="text-red-600" aria-label="Failed" />;
}

/** Per-file progress and "Open" links for an import batch. */
export function ImportDialog({ open, onOpenChange, items, ignored, footer }: ImportDialogProps) {
  const busy = items.some((item) => item.status === "uploading");
  const retry = retryAllFrom(items);
  const ignoredText = ignoredImportText(ignored);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={IMPORT_DIALOG_TITLE} description={IMPORT_DIALOG_DESCRIPTION}>
        <div data-testid="import-dialog" onKeyDown={onNavigateKeyDown}>
          <ul className="import-list" data-testid="import-list">
            {items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="import-item" data-testid="import-item" data-status={item.status}>
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="shrink-0 text-ink-4" />
                    <span className="truncate text-sm text-ink" title={item.title ?? item.name}>
                      {item.title ?? item.name}
                    </span>
                    {item.title && item.title !== item.name && <span className="truncate text-xs text-ink-4" title={item.name}>{item.name}</span>}
                  </div>
                  {item.error && <div className="mt-0.5 text-xs text-red-600 wrap-anywhere">{item.error}</div>}
                  {item.warnings.map((w, j) => (
                    <div key={j} className="import-warning wrap-anywhere" data-testid="import-warning">
                      <AlertTriangle size={12} className="shrink-0" /> {w}
                    </div>
                  ))}
                </div>
                {item.id && (
                  <Link
                    href={`/d/${item.id}`}
                    className="import-open"
                    data-testid="import-open"
                    onClick={() => onOpenChange(false)}
                  >
                    Open
                  </Link>
                )}
                {item.retry && (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline shrink-0"
                    disabled={busy}
                    data-testid="import-row-retry"
                    onClick={() => item.retry?.()}
                  >
                    Retry {item.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {ignoredText && (
            <p className="mt-3 text-xs text-ink-3" data-testid="import-ignored">
              {ignoredText}
            </p>
          )}
          {retry && (
            <button
              type="button"
              className="btn btn-sm btn-outline mt-4"
              disabled={busy}
              data-testid="import-retry"
              onClick={() => retry()}
            >
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
  const callbackSnapshot = Object.freeze({
    onDone: options.onDone,
    onError: options.onError,
  });
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
  const retryRequestRef = useRef<RetryRequest | null>(null);
  const callbackSnapshotRef = useRef(callbackSnapshot);
  const dragOwnerRef = useRef<DragListenerOwner | null>(null);
  useLayoutEffect(() => {
    callbackSnapshotRef.current = callbackSnapshot;
  });

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

  const ownsSettledUpload = useCallback(
    (ownership: UploadOwnership) =>
      authorityRef.current === ownership.authority &&
      activeUploadRef.current === null &&
      generationRef.current === ownership.generation,
    [],
  );

  const claimUploadAuthority = useCallback((current: HookAuthority): HookAuthority | null => {
    const callbacks = callbackSnapshotRef.current;
    if (authorityRef.current !== current || activeUploadRef.current) return null;
    const onDone = callbacks.onDone;
    if (authorityRef.current !== current || callbackSnapshotRef.current !== callbacks) return null;
    const onError = callbacks.onError;
    if (authorityRef.current !== current || callbackSnapshotRef.current !== callbacks) return null;
    const claimed = Object.freeze({ token: current.token, onDone, onError });
    authorityRef.current = claimed;
    return claimed;
  }, []);

  const finalizeUpload = useCallback(
    (ownership: UploadOwnership) => {
      if (!ownsUpload(ownership)) return false;
      activeUploadRef.current = null;
      return ownsSettledUpload(ownership);
    },
    [ownsSettledUpload, ownsUpload],
  );

  const deliverDone = useCallback(
    (ownership: UploadOwnership, documents: ImportedDocument[], failed: FailedImport[]) => {
      if (!ownsSettledUpload(ownership)) return;
      const onDone = ownership.authority.onDone;
      if (!ownsSettledUpload(ownership)) return;
      onDone?.(documents, failed);
    },
    [ownsSettledUpload],
  );

  const deliverFailure = useCallback(
    (
      ownership: UploadOwnership,
      message: string,
      documents: ImportedDocument[],
      failed: FailedImport[],
    ) => {
      if (!ownsSettledUpload(ownership)) return;
      const onError = ownership.authority.onError;
      if (!ownsSettledUpload(ownership)) return;
      const onDone = ownership.authority.onDone;
      if (!ownsSettledUpload(ownership)) return;
      let onErrorFailed = false;
      let onErrorFailure: unknown;
      try {
        onError?.(message);
      } catch (error) {
        onErrorFailed = true;
        onErrorFailure = error;
      }

      let onDoneFailed = false;
      let onDoneFailure: unknown;
      try {
        onDone?.(documents, failed);
      } catch (error) {
        onDoneFailed = true;
        onDoneFailure = error;
      }

      if (onErrorFailed && onDoneFailed) {
        throw new AggregateError([onErrorFailure, onDoneFailure], "Import callbacks failed");
      }
      if (onErrorFailed) throw onErrorFailure;
      if (onDoneFailed) throw onDoneFailure;
    },
    [ownsSettledUpload],
  );

  const setDialogOpen = useCallback((next: boolean) => {
    if (!next) {
      const active = activeUploadRef.current;
      if (active?.kind === "initial") return;
      if (active?.kind === "retry") {
        activeUploadRef.current = null;
        generationRef.current++;
      }
      retryOwnershipRef.current = null;
    }
    setOpen(next);
  }, []);

  const retryDispatch = useCallback<RetryRequest>(
    (ownership, rowIndex, action) => retryRequestRef.current?.(ownership, rowIndex, action),
    [],
  );

  const requestRetry = useCallback<RetryRequest>(async (retryOwnership, rowIndex, action) => {
    const currentAuthority = authorityRef.current;
    if (
      !currentAuthority ||
      activeUploadRef.current ||
      retryOwnershipRef.current !== retryOwnership ||
      retryOwnership.authority !== currentAuthority ||
      retryOwnership.generation !== generationRef.current
    ) {
      return;
    }

    const entries =
      rowIndex === null
        ? Array.from(retryOwnership.files.entries()).sort(([a], [b]) => a - b)
        : retryOwnership.files.has(rowIndex)
          ? [[rowIndex, retryOwnership.files.get(rowIndex)!] as const]
          : [];
    if (entries.length === 0) return;
    if (rowIndex === null) {
      if (
        action !== retryOwnership.retryAll ||
        entries.some(([index, file]) => {
          const item = itemsRef.current[index];
          return (
            retryOwnership.files.get(index) !== file ||
            item?.status !== "error" ||
            !item.retry ||
            item.retryAll !== retryOwnership.retryAll
          );
        })
      ) {
        return;
      }
    } else {
      const item = itemsRef.current[rowIndex];
      if (
        item?.status !== "error" ||
        item.retry !== action ||
        item.retryAll !== retryOwnership.retryAll
      ) {
        return;
      }
    }

    const authority = claimUploadAuthority(currentAuthority);
    if (!authority) return;
    const rowIndexes = entries.map(([index]) => index);
    const selectedRows = new Set(rowIndexes);
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
        selectedRows.has(index)
          ? { ...item, status: "uploading", warnings: [], error: undefined }
          : item,
      ),
    );

    let completedResult: ReturnType<typeof summarizeImportItems> | null = null;
    try {
      const rawResult: unknown = await uploadImportBatch(documents, ownership.images);
      if (!ownsUpload(ownership)) return;

      const { documents: created, failedAt } = normalizeImportBatchResult(rawResult, documents);
      const retained = new Map(retryOwnership.files);
      const outcomes = new Map<number, ImportItem>();
      let nextCreated = 0;
      for (let attemptIndex = 0; attemptIndex < rowIndexes.length; attemptIndex++) {
        const rowIndex = rowIndexes[attemptIndex];
        const file = documents[attemptIndex];
        const failure = failedAt.get(attemptIndex);
        if (failure) {
          outcomes.set(rowIndex, { name: file.name, status: "error", warnings: [], error: failure.error });
          continue;
        }
        const document = created[nextCreated++];
        if (!document) throw new Error(MALFORMED_IMPORT_RESULT_MESSAGE);
        retained.delete(rowIndex);
        outcomes.set(rowIndex, {
          name: file.name,
          status: "done",
          id: document.id,
          title: document.title,
          warnings: document.warnings,
        });
      }

      const nextOwnership = retained.size
        ? createRetryOwnership(
            authority,
            ownership.generation,
            retained,
            ownership.images,
            retryDispatch,
          )
        : null;
      const nextItems = publishRetryItems(
        itemsRef.current.map((item, index) => outcomes.get(index) ?? item),
        nextOwnership,
        retryDispatch,
      );
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = nextOwnership;
      replaceItems(nextItems);
      const result = summarizeImportItems(nextItems);
      if (!finalizeUpload(ownership)) return;
      completedResult = result;
    } catch (err) {
      if (!ownsUpload(ownership)) return;
      const message = apiErrorText(err, "Import failed");
      const nextItems = itemsRef.current.map((item, index) =>
        selectedRows.has(index)
          ? { ...item, status: "error" as const, warnings: [], error: message }
          : item,
      );
      const nextOwnership = createRetryOwnership(
        authority,
        ownership.generation,
        retryOwnership.files,
        ownership.images,
        retryDispatch,
      );
      const publishedItems = publishRetryItems(nextItems, nextOwnership, retryDispatch);
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = nextOwnership;
      replaceItems(publishedItems);
      const result = summarizeImportItems(publishedItems);
      if (!finalizeUpload(ownership)) return;
      deliverFailure(ownership, message, result.documents, result.failed);
      return;
    }
    deliverDone(ownership, completedResult.documents, completedResult.failed);
  }, [
    claimUploadAuthority,
    deliverDone,
    deliverFailure,
    finalizeUpload,
    ownsUpload,
    replaceItems,
    retryDispatch,
  ]);

  useLayoutEffect(() => {
    retryRequestRef.current = requestRetry;
    return () => {
      if (retryRequestRef.current === requestRetry) retryRequestRef.current = null;
    };
  }, [requestRetry]);

  const start = useCallback(async (files: Iterable<File>) => {
    const currentAuthority = authorityRef.current;
    if (!currentAuthority || activeUploadRef.current) return;
    const authority = claimUploadAuthority(currentAuthority);
    if (!authority) return;

    const selectedFiles = Array.from(files);
    const { documents, images, ignored: skipped } = splitImportFiles(selectedFiles);
    const generation = ++generationRef.current;
    retryOwnershipRef.current = null;
    const ignoredNames = skipped.map((f) => f.name);
    setIgnored(ignoredNames);
    if (documents.length === 0) {
      const msg = images.length ? "Drop a Markdown, text or HTML file together with the images." : NOTHING_IMPORTABLE_MESSAGE;
      replaceItems([]);
      setOpen(skipped.length > 0 || images.length > 0);
      const onError = authority.onError;
      if (authorityRef.current === authority && generationRef.current === generation) onError?.(msg);
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
    let completedResult: { documents: ImportedDocument[]; failed: FailedImport[] } | null = null;
    try {
      const rawResult: unknown = await uploadImportBatch(documents, images);
      if (!ownsUpload(ownership)) return;
      // `created` holds only the successes, so walk it with a cursor and let `failed[].index` claim its file.
      const { documents: created, failed, failedAt } = normalizeImportBatchResult(rawResult, documents);
      const retained = new Map<number, File>();
      let next = 0;
      const pendingItems = documents.map((f, i): ImportItem => {
        const failure = failedAt.get(i);
        if (failure) {
          retained.set(i, f);
          return { name: f.name, status: "error", warnings: [], error: failure.error };
        }
        const doc = created[next++];
        if (!doc) throw new Error(MALFORMED_IMPORT_RESULT_MESSAGE);
        return { name: f.name, status: "done", id: doc.id, title: doc.title, warnings: doc.warnings };
      });
      const retryOwnership = retained.size
        ? createRetryOwnership(authority, generation, retained, images, retryDispatch)
        : null;
      const nextItems = publishRetryItems(pendingItems, retryOwnership, retryDispatch);
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = retryOwnership;
      replaceItems(nextItems);
      if (!finalizeUpload(ownership)) return;
      completedResult = { documents: created, failed };
    } catch (err) {
      if (!ownsUpload(ownership)) return;
      const message = apiErrorText(err, "Import failed");
      const retained = new Map(documents.map((file, index) => [index, file]));
      const retryOwnership = createRetryOwnership(
        authority,
        generation,
        retained,
        images,
        retryDispatch,
      );
      const nextItems = publishRetryItems(
        documents.map((f) => ({ name: f.name, status: "error" as const, warnings: [], error: message })),
        retryOwnership,
        retryDispatch,
      );
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = retryOwnership;
      replaceItems(nextItems);
      if (!finalizeUpload(ownership)) return;
      deliverFailure(ownership, message, [], []);
      return;
    }
    deliverDone(ownership, completedResult.documents, completedResult.failed);
  }, [
    claimUploadAuthority,
    deliverDone,
    deliverFailure,
    finalizeUpload,
    ownsUpload,
    replaceItems,
    retryDispatch,
  ]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const startIntentRef = useRef(start);

  useLayoutEffect(() => {
    startIntentRef.current = start;
    const owner = dragOwnerRef.current;
    if (owner?.active && authorityRef.current?.token === owner.authority.token) owner.start = start;
  }, [start]);

  useLayoutEffect(() => {
    const callbacks = callbackSnapshotRef.current;
    const authority: HookAuthority = Object.freeze({
      token: Symbol("file-import-authority"),
      onDone: callbacks.onDone,
      onError: callbacks.onError,
    });
    const target = window;
    const ownsListeners = () =>
      owner.active &&
      dragOwnerRef.current === owner &&
      authorityRef.current?.token === owner.authority.token;
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
      if (authorityRef.current?.token === authority.token) {
        authorityRef.current = null;
        if (activeUploadRef.current?.authority.token === authority.token) activeUploadRef.current = null;
        if (retryOwnershipRef.current?.authority.token === authority.token) retryOwnershipRef.current = null;
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
