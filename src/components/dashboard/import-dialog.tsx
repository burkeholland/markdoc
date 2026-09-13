"use client";
import "./import.css";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
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
  readonly retryAll: (() => void) | undefined;
  readonly href: string | null;
}

interface IgnoredImportPublication {
  readonly source: string[];
  readonly names: readonly string[];
  readonly text: string | null;
}

interface ImportResultAuthority {
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

type ImportResultActionKind = "open" | "retry";
type ImportResultNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

interface ImportResultActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly kind: ImportResultActionKind;
  readonly rowIndex: number | null;
}

interface ImportResultNavigationActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly actionIdentity: symbol;
  readonly kind: ImportResultActionKind;
  readonly rowIndex: number | null;
}

interface ImportResultControlPublication<T extends HTMLElement> {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: ImportResultActionKind;
  readonly rowIndex: number | null;
  readonly element: T;
  readonly action: ImportResultActionPublication;
  readonly navigationAction: ImportResultNavigationActionPublication;
  readonly path: readonly EventTarget[];
}

type ImportResultReactKeyboardMethodName =
  | "preventDefault"
  | "isDefaultPrevented"
  | "isPropagationStopped";

type ImportResultReactKeyboardMethod = (...args: never[]) => unknown;

interface ImportResultReactKeyboardFacts {
  readonly nativeEvent: Event;
  readonly type: string;
  readonly target: EventTarget;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly trusted: boolean;
  readonly view: unknown;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean | undefined;
}

interface ImportResultReactKeyboardSnapshot {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly publicFacts: ImportResultReactKeyboardFacts;
  readonly nativeFacts: ImportResultNativeKeyboardFacts;
  readonly methods: Readonly<
    Record<
      ImportResultReactKeyboardMethodName,
      ImportResultReactKeyboardMethod
    >
  >;
}

interface ImportResultNavigationNativeStage {
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly facts: ImportResultNativeKeyboardFacts;
  readonly control: ImportResultControlPublication<HTMLElement>;
}

interface ImportResultNavigationPair {
  readonly publication: ImportResultPublication;
  readonly action: ImportResultNavigationActionPublication;
  readonly nativeEvent: KeyboardEvent;
  readonly stage: ImportResultNavigationNativeStage;
  readonly capture: ImportResultReactKeyboardSnapshot;
  readonly sourceControl: ImportResultControlPublication<HTMLElement>;
  readonly destinationControl: ImportResultControlPublication<HTMLElement>;
  readonly key: ImportResultNavigationKey;
}

interface ImportResultRowPublication {
  readonly identity: symbol;
  readonly authority: ImportItemPublication;
  readonly item: HTMLLIElement;
  readonly open: ImportResultControlPublication<HTMLAnchorElement> | null;
  readonly retry: ImportResultControlPublication<HTMLButtonElement> | null;
}

interface ImportResultDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly ignoredAttributes: readonly string[];
  readonly children: readonly ImportResultDomSnapshot[];
}

interface ImportResultPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ImportResultPublication {
  readonly identity: symbol;
  readonly authority: ImportResultAuthority;
  readonly ownerDocument: Document;
  readonly dialog: HTMLDivElement;
  readonly root: HTMLDivElement;
  readonly list: HTMLUListElement;
  readonly rows: readonly ImportResultRowPublication[];
  readonly ignored: HTMLParagraphElement | null;
  readonly retry: ImportResultControlPublication<HTMLButtonElement> | null;
  readonly navigationControls: readonly ImportResultControlPublication<HTMLElement>[];
  readonly keyboard: ImportResultKeyboardAuthority | null;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface ElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class ElementOwner<T extends HTMLElement> implements ElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;

  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    if (element && this.last && element !== this.last && !element.isConnected) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

class CurrentCell<T> {
  constructor(public current: T) {}
}

interface ImportResultReplay {
  readonly source: ImportResultPublication;
  readonly dom: ImportResultDomSnapshot;
  readonly rootPlacement: ImportResultPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface ImportResultCells {
  readonly active: CurrentCell<ImportResultPublication | null>;
  readonly successorOf: CurrentCell<ImportResultPublication | null>;
  readonly replay: CurrentCell<ImportResultReplay | null>;
  readonly retiredPublications: WeakSet<ImportResultPublication>;
  readonly retiredRows: WeakSet<ImportResultRowPublication>;
  readonly retiredControls: WeakSet<ImportResultControlPublication<HTMLElement>>;
  readonly retiredActions: WeakSet<
    ImportResultActionPublication | ImportResultNavigationActionPublication
  >;
  readonly claimedOpenPublications: WeakSet<ImportResultPublication>;
  readonly claimedRetryPublications: WeakSet<ImportResultPublication>;
  readonly claimedRows: WeakSet<ImportResultRowPublication>;
  readonly claimedControls: WeakSet<ImportResultControlPublication<HTMLElement>>;
  readonly claimedActions: WeakSet<ImportResultActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedNavigationReactEvents: WeakSet<object>;
  readonly claimedNavigationNativeEvents: WeakSet<Event>;
  readonly navigationAttempt: CurrentCell<object | null>;
  readonly navigationDelivery: CurrentCell<symbol | null>;
}

interface RefReplay {
  readonly owner: ElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface ImportResultPublicationRuntime {
  readonly publication: ImportResultPublication;
  readonly publish: (
    dom: ImportResultDomSnapshot,
    rootPlacement: ImportResultPlacement,
    owners: readonly ElementOwnerView[],
    partialReplayElements: ReadonlySet<HTMLElement>,
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => ImportResultDomSnapshot | null;
  readonly rootPlacement: () => ImportResultPlacement | null;
  readonly navigationCaptureIsReady: () => boolean;
  readonly navigationListenerIsCurrent: () => boolean;
  readonly navigationStage: (
    event: KeyboardEvent,
  ) => ImportResultNavigationNativeStage | null;
  readonly pairNavigation: (
    event: KeyboardEvent,
    stage: ImportResultNavigationNativeStage,
    pair: ImportResultNavigationPair,
  ) => boolean;
  readonly navigationPair: (
    event: KeyboardEvent,
  ) => ImportResultNavigationPair | null;
  readonly consumeNavigationPair: (
    event: KeyboardEvent,
    pair: ImportResultNavigationPair,
  ) => boolean;
}

interface ImportResultPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly captureIgnored: (element: HTMLParagraphElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly rows: readonly {
    readonly authority: ImportItemPublication;
    readonly captureItem: (element: HTMLLIElement | null) => void;
    readonly captureOpen: (element: HTMLAnchorElement | null) => void;
    readonly captureRetry: (element: HTMLButtonElement | null) => void;
  }[];
  readonly establish: () => void | (() => void);
  readonly onOpen: (
    row: ImportItemPublication,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => void;
  readonly onRetry: (
    row: ImportItemPublication | null,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly onNavigateCapture: <T extends HTMLElement>(
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
    event: ReactKeyboardEvent<T>,
  ) => void;
  readonly onNavigate: <T extends HTMLElement>(
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
    event: ReactKeyboardEvent<T>,
  ) => void;
}

function ImportResultPublicationBoundary({
  publication,
  children,
}: {
  publication: ImportResultPublicationSet;
  children: ReactNode;
}) {
  useLayoutEffect(() => publication.establish(), [publication]);
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
    retryAll: item.retryAll,
    href: id ? `/d/${id}` : null,
  });
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

function importResultFactsAreCurrent(authority: ImportResultAuthority): boolean {
  const { sourceItems, items } = authority;
  if (sourceItems.length !== items.length) return false;

  for (let index = 0; index < items.length; index++) {
    const row = items[index];
    if (!row || row.index !== index || items[index] !== row) return false;
    const item = sourceItems[row.index];
    if (
      item !== row.source ||
      item.name !== row.name ||
      item.status !== row.status ||
      item.id !== row.id ||
      item.title !== row.title ||
      item.error !== row.error ||
      item.retry !== row.retry ||
      item.retryAll !== row.retryAll ||
      item.warnings !== row.sourceWarnings ||
      item.warnings.length !== row.warnings.length ||
      row.href !== (row.id ? `/d/${row.id}` : null)
    ) {
      return false;
    }
    for (let index = 0; index < row.warnings.length; index++) {
      if (item.warnings[index] !== row.warnings[index]) return false;
    }
  }

  const busy = sourceItems.some((item) => item.status === "uploading");
  const retry = retryAllFrom(sourceItems);
  if (busy !== authority.busy || retry !== authority.retry) return false;
  if (retry) {
    if (sourceItems.some((item) => item.retryAll && item.retryAll !== retry)) return false;
    if (!busy && !sourceItems.some((item) => item.status === "error" && item.retry)) return false;
  }

  const { source, names, text } = authority.ignored;
  if (source.length !== names.length || text !== ignoredImportText(names)) return false;
  for (let index = 0; index < names.length; index++) {
    if (source[index] !== names[index]) return false;
  }
  return true;
}

function importResultAuthoritiesMatch(
  previous: ImportResultAuthority,
  current: ImportResultAuthority,
): boolean {
  return (
    previous.mount === current.mount &&
    previous.open === current.open &&
    previous.onOpenChange === current.onOpenChange &&
    previous.sourceItems === current.sourceItems &&
    previous.busy === current.busy &&
    previous.retry === current.retry &&
    previous.footer === current.footer &&
    previous.ignored.source === current.ignored.source &&
    previous.ignored.text === current.ignored.text &&
    previous.ignored.names.length === current.ignored.names.length &&
    previous.ignored.names.every((name, index) => current.ignored.names[index] === name) &&
    previous.items.length === current.items.length &&
    previous.items.every((row, index) => {
      const candidate = current.items[index];
      return Boolean(
        candidate &&
          row.index === candidate.index &&
          row.source === candidate.source &&
          row.sourceWarnings === candidate.sourceWarnings &&
          row.name === candidate.name &&
          row.status === candidate.status &&
          row.id === candidate.id &&
          row.title === candidate.title &&
          row.error === candidate.error &&
          row.retry === candidate.retry &&
          row.retryAll === candidate.retryAll &&
          row.href === candidate.href &&
          row.warnings.length === candidate.warnings.length &&
          row.warnings.every((warning, warningIndex) => candidate.warnings[warningIndex] === warning),
      );
    }) &&
    importResultFactsAreCurrent(previous) &&
    importResultFactsAreCurrent(current)
  );
}

function snapshotAttributes(
  node: Node,
  ignored: readonly string[] = [],
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .filter(({ name }) => !ignored.includes(name))
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotImportResultDom(
  node: Node,
  dialog: HTMLDivElement,
): ImportResultDomSnapshot {
  const ignoredAttributes =
    node === dialog
      ? Object.freeze(["aria-labelledby", "aria-describedby", "style"])
      : Object.freeze([] as string[]);
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotAttributes(node, ignoredAttributes),
    ignoredAttributes,
    children: Object.freeze(
      [...node.childNodes].map((child) => snapshotImportResultDom(child, dialog)),
    ),
  });
}

function importResultDomMatches(snapshot: ImportResultDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotAttributes(node, snapshot.ignoredAttributes);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || name !== expected[0] || value !== expected[1];
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node && importResultDomMatches(child),
    )
  );
}

function captureImportResultPlacement(
  node: HTMLElement,
): ImportResultPlacement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: node.ownerDocument,
    parent,
    previousSibling: node.previousSibling,
    nextSibling: node.nextSibling,
  });
}

function importResultPlacementMatches(
  node: HTMLElement,
  placement: ImportResultPlacement,
): boolean {
  return (
    node.ownerDocument === placement.document &&
    node.parentNode === placement.parent &&
    node.previousSibling === placement.previousSibling &&
    node.nextSibling === placement.nextSibling
  );
}

function isEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true" ||
    element.getAttribute("aria-busy")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

interface ImportResultNativeKeyboardFacts {
  readonly type: string;
  readonly currentTarget: EventTarget | null;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly target: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly trusted: boolean;
  readonly view: Window | null;
  readonly detail: number;
  readonly composed: boolean;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
}

interface ImportResultStableGetter<T> {
  readonly read: (value: object) => T;
  readonly isCurrent: () => boolean;
}

interface ImportResultStableMethod<Args extends readonly unknown[], Result> {
  readonly invoke: (value: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface ImportResultUnforgeableGetter<T> {
  readonly read: (value: object) => T;
  readonly matches: (value: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface ImportResultKeyboardAuthority {
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly read: (event: object) => ImportResultNativeKeyboardFacts | null;
  readonly applyMethod: (
    method: ImportResultReactKeyboardMethod,
    receiver: object,
  ) => Readonly<{ called: boolean; value?: unknown }>;
  readonly register: (
    listener: (this: EventTarget, event: Event) => void,
  ) =>
    | Readonly<{
        isCurrent: () => boolean;
        remove: () => void;
      }>
    | null;
  readonly activeElement: () => Element | null | undefined;
  readonly focus: (element: HTMLElement) => boolean;
}

interface ImportResultReactKeyboardEvent {
  readonly isDefaultPrevented?: unknown;
  readonly isPropagationStopped?: unknown;
  readonly preventDefault?: unknown;
  readonly isComposing?: unknown;
}

function importResultDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.get === expected.get &&
      current.set === expected.set &&
      current.value === expected.value &&
      current.writable === expected.writable
  );
}

function captureImportResultGetter<T>(
  owner: object,
  property: PropertyKey,
  descriptorOf: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): ImportResultStableGetter<T> | null {
  const descriptor = descriptorOf(owner, property);
  if (!descriptor?.get) return null;
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  return Object.freeze({
    read: (value: object) => apply(getter, value, []) as T,
    isCurrent: () =>
      importResultDescriptorsMatch(descriptorOf(owner, property), expected),
  });
}

function captureImportResultMethod<
  Args extends readonly unknown[],
  Result,
>(
  owner: object,
  property: PropertyKey,
  descriptorOf: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): ImportResultStableMethod<Args, Result> | null {
  const descriptor = descriptorOf(owner, property);
  if (!descriptor || typeof descriptor.value !== "function") return null;
  const expected = Object.freeze({ ...descriptor });
  const method = descriptor.value;
  return Object.freeze({
    invoke: (value: object, ...args: Args) =>
      apply(method, value, args) as Result,
    isCurrent: () =>
      importResultDescriptorsMatch(descriptorOf(owner, property), expected),
  });
}

function captureImportResultUnforgeableGetter<T>(
  owner: object,
  property: PropertyKey,
  descriptorOf: typeof Object.getOwnPropertyDescriptor,
  apply: typeof Reflect.apply,
): ImportResultUnforgeableGetter<T> | null {
  const descriptor = descriptorOf(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const expected = Object.freeze({ ...descriptor });
  const getter = descriptor.get;
  return Object.freeze({
    read: (value: object) => apply(getter, value, []) as T,
    matches: (value: object) =>
      importResultDescriptorsMatch(descriptorOf(value, property), expected),
    isCurrent: () =>
      importResultDescriptorsMatch(descriptorOf(owner, property), expected),
  });
}

function captureImportResultKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
): ImportResultKeyboardAuthority | null {
  const objectConstructor = ownerWindow.Object;
  const reflectObject = ownerWindow.Reflect;
  const eventConstructor = ownerWindow.Event;
  const uiEventConstructor = ownerWindow.UIEvent;
  const keyboardConstructor = ownerWindow.KeyboardEvent;
  const documentConstructor = ownerWindow.Document;
  const htmlElementConstructor = ownerWindow.HTMLElement;
  const addEventListener = ownerWindow.addEventListener;
  const removeEventListener = ownerWindow.removeEventListener;
  const descriptorOf = objectConstructor.getOwnPropertyDescriptor;
  const apply = reflectObject.apply;
  const eventPrototype = eventConstructor.prototype;
  const uiEventPrototype = uiEventConstructor.prototype;
  const keyboardPrototype = keyboardConstructor.prototype;
  const documentPrototype = documentConstructor.prototype;
  const htmlElementPrototype = htmlElementConstructor.prototype;
  const objectPrototype = objectConstructor.prototype;
  const getter = <T,>(owner: object, property: PropertyKey) =>
    captureImportResultGetter<T>(owner, property, descriptorOf, apply);
  const method = <Args extends readonly unknown[], Result>(
    owner: object,
    property: PropertyKey,
  ) =>
    captureImportResultMethod<Args, Result>(
      owner,
      property,
      descriptorOf,
      apply,
    );
  const type = getter<string>(eventPrototype, "type");
  const currentTarget = getter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const phase = getter<number>(eventPrototype, "eventPhase");
  const bubbles = getter<boolean>(eventPrototype, "bubbles");
  const cancelable = getter<boolean>(eventPrototype, "cancelable");
  const defaultPrevented = getter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const cancelBubble = getter<boolean>(eventPrototype, "cancelBubble");
  const target = getter<EventTarget | null>(eventPrototype, "target");
  const composed = getter<boolean>(eventPrototype, "composed");
  const composedPath = method<readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const view = getter<Window | null>(uiEventPrototype, "view");
  const detail = getter<number>(uiEventPrototype, "detail");
  const key = getter<string>(keyboardPrototype, "key");
  const code = getter<string>(keyboardPrototype, "code");
  const location = getter<number>(keyboardPrototype, "location");
  const ctrlKey = getter<boolean>(keyboardPrototype, "ctrlKey");
  const altKey = getter<boolean>(keyboardPrototype, "altKey");
  const metaKey = getter<boolean>(keyboardPrototype, "metaKey");
  const shiftKey = getter<boolean>(keyboardPrototype, "shiftKey");
  const repeat = getter<boolean>(keyboardPrototype, "repeat");
  const composing = getter<boolean>(keyboardPrototype, "isComposing");
  const activeElement = getter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = method<readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
  );
  const isPrototypeOf = method<readonly [object], boolean>(
    objectPrototype,
    "isPrototypeOf",
  );
  let trustProbe: KeyboardEvent;
  try {
    trustProbe = new keyboardConstructor("import-result-keyboard-intrinsic");
  } catch {
    return null;
  }
  const trusted = captureImportResultUnforgeableGetter<boolean>(
    trustProbe,
    "isTrusted",
    descriptorOf,
    apply,
  );
  const getters = Object.freeze([
    type,
    currentTarget,
    phase,
    bubbles,
    cancelable,
    defaultPrevented,
    cancelBubble,
    target,
    composed,
    view,
    detail,
    key,
    code,
    location,
    ctrlKey,
    altKey,
    metaKey,
    shiftKey,
    repeat,
    composing,
    activeElement,
  ]);
  const methods = Object.freeze([
    composedPath,
    focus,
    isPrototypeOf,
  ]);
  if (
    getters.some((intrinsic) => !intrinsic || !intrinsic.isCurrent()) ||
    methods.some((intrinsic) => !intrinsic || !intrinsic.isCurrent()) ||
    !trusted ||
    !trusted.isCurrent() ||
    !type ||
    !currentTarget ||
    !phase ||
    !bubbles ||
    !cancelable ||
    !defaultPrevented ||
    !cancelBubble ||
    !target ||
    !composed ||
    !composedPath ||
    !view ||
    !detail ||
    !key ||
    !code ||
    !location ||
    !ctrlKey ||
    !altKey ||
    !metaKey ||
    !shiftKey ||
    !repeat ||
    !composing ||
    !activeElement ||
    !focus ||
    !isPrototypeOf ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    return null;
  }
  const realmIsCurrent = () =>
    ownerWindow.Object === objectConstructor &&
    ownerWindow.Reflect === reflectObject &&
    ownerWindow.Event === eventConstructor &&
    ownerWindow.UIEvent === uiEventConstructor &&
    ownerWindow.KeyboardEvent === keyboardConstructor &&
    ownerWindow.Document === documentConstructor &&
    ownerWindow.HTMLElement === htmlElementConstructor &&
    eventConstructor.prototype === eventPrototype &&
    uiEventConstructor.prototype === uiEventPrototype &&
    keyboardConstructor.prototype === keyboardPrototype &&
    documentConstructor.prototype === documentPrototype &&
    htmlElementConstructor.prototype === htmlElementPrototype &&
    objectConstructor.prototype === objectPrototype &&
    objectConstructor.getOwnPropertyDescriptor === descriptorOf &&
    reflectObject.apply === apply &&
    ownerWindow.addEventListener === addEventListener &&
    ownerWindow.removeEventListener === removeEventListener;
  let historyIsClean = true;
  const intrinsicsAreCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      realmIsCurrent() &&
      getters.every((intrinsic) => intrinsic?.isCurrent() === true) &&
      methods.every((intrinsic) => intrinsic?.isCurrent() === true) &&
      trusted.isCurrent();
    return historyIsClean;
  };
  return Object.freeze({
    capturingPhase: eventConstructor.CAPTURING_PHASE,
    bubblingPhase: eventConstructor.BUBBLING_PHASE,
    read: (event: object) => {
      try {
        if (
          !intrinsicsAreCurrent() ||
          !trusted.matches(event) ||
          !isPrototypeOf.invoke(keyboardPrototype, event)
        ) {
          return null;
        }
        const isTrusted = trusted.read(event);
        const eventView = view.read(event);
        if (isTrusted !== true) return null;
        return Object.freeze({
          type: type.read(event),
          currentTarget: currentTarget.read(event),
          phase: phase.read(event),
          bubbles: bubbles.read(event),
          cancelable: cancelable.read(event),
          defaultPrevented: defaultPrevented.read(event),
          cancelBubble: cancelBubble.read(event),
          target: target.read(event),
          path: Object.freeze([...composedPath.invoke(event)]),
          trusted: isTrusted,
          view: eventView,
          detail: detail.read(event),
          composed: composed.read(event),
          key: key.read(event),
          code: code.read(event),
          location: location.read(event),
          ctrlKey: ctrlKey.read(event),
          altKey: altKey.read(event),
          metaKey: metaKey.read(event),
          shiftKey: shiftKey.read(event),
          repeat: repeat.read(event),
          composing: composing.read(event),
        });
      } catch {
        return null;
      }
    },
    applyMethod: (
      reactMethod: ImportResultReactKeyboardMethod,
      receiver: object,
    ) => {
      if (!intrinsicsAreCurrent()) return Object.freeze({ called: false });
      try {
        return Object.freeze({
          called: true,
          value: apply(reactMethod, receiver, []),
        });
      } catch {
        return Object.freeze({ called: false });
      }
    },
    register: (
      listener: (this: EventTarget, event: Event) => void,
    ) => {
      if (!intrinsicsAreCurrent()) return null;
      let active = true;
      try {
        apply(addEventListener, ownerWindow, ["keydown", listener, true]);
      } catch {
        return null;
      }
      return Object.freeze({
        isCurrent: () => active && intrinsicsAreCurrent(),
        remove: () => {
          if (!active) return;
          active = false;
          try {
            apply(removeEventListener, ownerWindow, [
              "keydown",
              listener,
              true,
            ]);
          } catch {
            return;
          }
        },
      });
    },
    activeElement: () => {
      if (!intrinsicsAreCurrent()) return undefined;
      try {
        return activeElement.read(ownerWindow.document);
      } catch {
        return undefined;
      }
    },
    focus: (element: HTMLElement) => {
      if (!intrinsicsAreCurrent()) return false;
      try {
        focus.invoke(element, { preventScroll: true });
        return true;
      } catch {
        return false;
      }
    },
  });
}

function isImportResultNavigationKey(
  key: string,
): key is ImportResultNavigationKey {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End"
  );
}

function captureImportResultEventPath(
  element: HTMLElement,
  ownerDocument: Document,
): readonly EventTarget[] | null {
  const path: EventTarget[] = [];
  let current: Node | null = element;
  while (current) {
    path.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  return Object.freeze(path);
}

function importResultPathMatches(
  path: readonly EventTarget[],
  expected: readonly EventTarget[],
  terminal: EventTarget,
) {
  return (
    expected.length > 0 &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function captureImportResultReactKeyboardEvent(
  event: ReactKeyboardEvent<HTMLElement>,
  nativeEvent: Event,
  nativeFacts: ImportResultNativeKeyboardFacts,
  source: HTMLElement,
  expectedPhase: number,
): ImportResultReactKeyboardSnapshot | null {
  try {
    const proof = event as ReactKeyboardEvent<HTMLElement> &
      ImportResultReactKeyboardEvent;
    const publicMethods = readImportResultReactKeyboardMethods(proof);
    if (!publicMethods) return null;
    const reactComposing = proof.isComposing;
    const publicFacts: ImportResultReactKeyboardFacts = Object.freeze({
      nativeEvent: event.nativeEvent,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      phase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted,
      view: event.view,
      key: event.key,
      code: event.code,
      location: event.location,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      composing:
        reactComposing === undefined
          ? undefined
          : Boolean(reactComposing),
    });
    const methods = Object.freeze({ ...publicMethods });
    const snapshot: ImportResultReactKeyboardSnapshot = Object.freeze({
      event,
      publicFacts,
      nativeFacts,
      methods,
    });
    return importResultReactKeyboardSnapshotIsCurrent(
      snapshot,
      nativeFacts,
      source,
      expectedPhase,
      false,
      methods,
    ) && nativeEvent === publicFacts.nativeEvent
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function readImportResultReactKeyboardMethods(
  event: ImportResultReactKeyboardEvent,
): Readonly<
  Record<ImportResultReactKeyboardMethodName, ImportResultReactKeyboardMethod>
> | null {
  try {
    const preventDefault = event.preventDefault;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    return typeof preventDefault === "function" &&
      typeof isDefaultPrevented === "function" &&
      typeof isPropagationStopped === "function"
      ? Object.freeze({
          preventDefault:
            preventDefault as ImportResultReactKeyboardMethod,
          isDefaultPrevented:
            isDefaultPrevented as ImportResultReactKeyboardMethod,
          isPropagationStopped:
            isPropagationStopped as ImportResultReactKeyboardMethod,
        })
      : null;
  } catch {
    return null;
  }
}

function readImportResultReactKeyboardFacts(
  event: ReactKeyboardEvent<HTMLElement>,
): ImportResultReactKeyboardFacts | null {
  try {
    const proof = event as ReactKeyboardEvent<HTMLElement> &
      ImportResultReactKeyboardEvent;
    const composing = proof.isComposing;
    return Object.freeze({
      nativeEvent: event.nativeEvent,
      type: event.type,
      target: event.target,
      currentTarget: event.currentTarget,
      phase: event.eventPhase,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      trusted: event.isTrusted,
      view: event.view,
      key: event.key,
      code: event.code,
      location: event.location,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      composing:
        composing === undefined ? undefined : Boolean(composing),
    });
  } catch {
    return null;
  }
}

function importResultReactKeyboardSnapshotIsCurrent(
  snapshot: ImportResultReactKeyboardSnapshot,
  nativeFacts: ImportResultNativeKeyboardFacts,
  source: HTMLElement,
  expectedPhase: number,
  expectedDefaultPrevented: boolean,
  expectedMethods: Readonly<
    Record<ImportResultReactKeyboardMethodName, ImportResultReactKeyboardMethod>
  >,
) {
  const current = readImportResultReactKeyboardFacts(snapshot.event);
  const methods = readImportResultReactKeyboardMethods(
    snapshot.event as ReactKeyboardEvent<HTMLElement> &
      ImportResultReactKeyboardEvent,
  );
  const initial = snapshot.publicFacts;
  return Boolean(
    current &&
      methods &&
      current.nativeEvent === initial.nativeEvent &&
      current.type === initial.type &&
      current.type === nativeFacts.type &&
      current.type === "keydown" &&
      current.target === initial.target &&
      current.target === source &&
      current.currentTarget === initial.currentTarget &&
      current.currentTarget === source &&
      current.phase === initial.phase &&
      current.phase === nativeFacts.phase &&
      current.phase === expectedPhase &&
      current.bubbles === initial.bubbles &&
      current.bubbles === nativeFacts.bubbles &&
      current.cancelable === initial.cancelable &&
      current.cancelable === nativeFacts.cancelable &&
      initial.defaultPrevented === false &&
      current.defaultPrevented === expectedDefaultPrevented &&
      nativeFacts.defaultPrevented === expectedDefaultPrevented &&
      current.trusted === initial.trusted &&
      current.trusted === nativeFacts.trusted &&
      Object.is(current.view, initial.view) &&
      Object.is(current.view, nativeFacts.view) &&
      current.key === initial.key &&
      current.key === nativeFacts.key &&
      current.code === initial.code &&
      current.code === nativeFacts.code &&
      current.location === initial.location &&
      current.location === nativeFacts.location &&
      current.ctrlKey === initial.ctrlKey &&
      current.ctrlKey === nativeFacts.ctrlKey &&
      current.altKey === initial.altKey &&
      current.altKey === nativeFacts.altKey &&
      current.metaKey === initial.metaKey &&
      current.metaKey === nativeFacts.metaKey &&
      current.shiftKey === initial.shiftKey &&
      current.shiftKey === nativeFacts.shiftKey &&
      current.repeat === initial.repeat &&
      current.repeat === nativeFacts.repeat &&
      current.composing === initial.composing &&
      (current.composing === undefined ||
        current.composing === nativeFacts.composing) &&
      methods.preventDefault === expectedMethods.preventDefault &&
      methods.isDefaultPrevented ===
        expectedMethods.isDefaultPrevented &&
      methods.isPropagationStopped ===
        expectedMethods.isPropagationStopped
  );
}

function importResultReactKeyboardMethodsAreCurrent(
  snapshot: ImportResultReactKeyboardSnapshot,
  expectedMethods: Readonly<
    Record<ImportResultReactKeyboardMethodName, ImportResultReactKeyboardMethod>
  > = snapshot.methods,
) {
  const methods = readImportResultReactKeyboardMethods(
    snapshot.event as ReactKeyboardEvent<HTMLElement> &
      ImportResultReactKeyboardEvent,
  );
  return Boolean(
    methods &&
      methods.preventDefault === expectedMethods.preventDefault &&
      methods.isDefaultPrevented ===
        expectedMethods.isDefaultPrevented &&
      methods.isPropagationStopped ===
        expectedMethods.isPropagationStopped,
  );
}

function importResultNativeKeyboardFactsMatch(
  first: ImportResultNativeKeyboardFacts,
  second: ImportResultNativeKeyboardFacts,
  expectedDefaultPrevented = first.defaultPrevented,
  expectedCancelBubble = first.cancelBubble,
) {
  return (
    first.type === second.type &&
    first.bubbles === second.bubbles &&
    first.cancelable === second.cancelable &&
    second.defaultPrevented === expectedDefaultPrevented &&
    second.cancelBubble === expectedCancelBubble &&
    first.target === second.target &&
    first.trusted === second.trusted &&
    first.view === second.view &&
    first.detail === second.detail &&
    first.composed === second.composed &&
    first.key === second.key &&
    first.code === second.code &&
    first.location === second.location &&
    first.ctrlKey === second.ctrlKey &&
    first.altKey === second.altKey &&
    first.metaKey === second.metaKey &&
    first.shiftKey === second.shiftKey &&
    first.repeat === second.repeat &&
    first.composing === second.composing &&
    first.path.length === second.path.length &&
    first.path.every((entry, index) => entry === second.path[index])
  );
}

function createImportResultPublication(
  authority: ImportResultAuthority,
  cells: ImportResultCells,
  requestSuccessor: () => void,
): ImportResultPublicationSet {
  const mount = authority.mount;
  const open = authority.open;
  const onOpenChange = authority.onOpenChange;
  const sourceItems = authority.sourceItems;
  const items = authority.items;
  const busy = authority.busy;
  const retry = authority.retry;
  const ignoredSource = authority.ignored.source;
  const ignoredNames = authority.ignored.names;
  const ignoredText = authority.ignored.text;
  const footer = authority.footer;
  let currentRuntime: ImportResultPublicationRuntime | null = null;
  let lastRuntime: ImportResultPublicationRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    Object.isFrozen(authority) &&
    Object.isFrozen(authority.items) &&
    Object.isFrozen(authority.ignored) &&
    Object.isFrozen(authority.ignored.names) &&
    authority.items.every(
      (row) => Object.isFrozen(row) && Object.isFrozen(row.warnings),
    ) &&
    authority.mount === mount &&
    authority.open === open &&
    authority.onOpenChange === onOpenChange &&
    authority.sourceItems === sourceItems &&
    authority.items === items &&
    authority.busy === busy &&
    authority.retry === retry &&
    authority.ignored.source === ignoredSource &&
    authority.ignored.names === ignoredNames &&
    authority.ignored.text === ignoredText &&
    authority.footer === footer &&
    importResultFactsAreCurrent(authority);

  const onElementChange = (
    owner: ElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay() &&
      cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new ElementOwner<HTMLDivElement>(onElementChange);
  const listOwner = new ElementOwner<HTMLUListElement>(onElementChange);
  const ignoredOwner = new ElementOwner<HTMLParagraphElement>(onElementChange);
  const retryOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
  const rowOwners = Object.freeze(
    items.map((row) => {
      const itemOwner = new ElementOwner<HTMLLIElement>(onElementChange);
      const openOwner = new ElementOwner<HTMLAnchorElement>(onElementChange);
      const retryOwner = new ElementOwner<HTMLButtonElement>(onElementChange);
      return Object.freeze({
        authority: row,
        captureItem: itemOwner.capture,
        captureOpen: openOwner.capture,
        captureRetry: retryOwner.capture,
        itemOwner,
        openOwner,
        retryOwner,
      });
    }),
  );

  const expectedOwners = (): readonly ElementOwnerView[] => [
    rootOwner,
    listOwner,
    ...rowOwners.flatMap(({ authority: row, itemOwner, openOwner, retryOwner }) => [
      itemOwner,
      ...(row.href ? [openOwner] : []),
      ...(row.retry ? [retryOwner] : []),
    ]),
    ...(ignoredText ? [ignoredOwner] : []),
    ...(retry ? [retryOwner] : []),
  ];

  const exactDomIsCurrent = (allowPendingDialogAttributes = false) => {
    const root = rootOwner.element();
    const list = listOwner.element();
    const dialog = root?.parentElement;
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !authority.open ||
      !factsAreCurrent() ||
      !root ||
      !root.isConnected ||
      !ownerDocument ||
      !ownerWindow ||
      !(dialog instanceof ownerWindow.HTMLDivElement) ||
      !dialog.isConnected ||
      dialog.ownerDocument !== ownerDocument ||
      dialog.getAttribute("role") !== "dialog" ||
      (dialog.style.pointerEvents !== "auto" &&
        (!allowPendingDialogAttributes || dialog.style.pointerEvents !== "")) ||
      dialog.children.length !== 2 ||
      dialog.lastElementChild !== root ||
      !(root instanceof ownerWindow.HTMLDivElement) ||
      root.parentElement !== dialog ||
      root.dataset.testid !== "import-dialog" ||
      !(list instanceof ownerWindow.HTMLUListElement) ||
      !list.isConnected ||
      list.ownerDocument !== ownerDocument ||
      list.parentElement !== root ||
      root.firstElementChild !== list ||
      list.className !== "import-list" ||
      list.dataset.testid !== "import-list" ||
      list.children.length !== items.length
    ) {
      return false;
    }

    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    const title = labelledBy ? ownerDocument.getElementById(labelledBy) : null;
    const description = describedBy ? ownerDocument.getElementById(describedBy) : null;
    const header = dialog.firstElementChild;
    const pendingDialogAttributes =
      allowPendingDialogAttributes &&
      labelledBy === null &&
      describedBy === null &&
      header?.querySelector("h2")?.textContent === IMPORT_DIALOG_TITLE &&
      header?.querySelector("p")?.textContent === IMPORT_DIALOG_DESCRIPTION;
    if (
      (!pendingDialogAttributes &&
        (!title ||
          !dialog.contains(title) ||
          title.textContent !== IMPORT_DIALOG_TITLE ||
          !description ||
          !dialog.contains(description) ||
          description.textContent !== IMPORT_DIALOG_DESCRIPTION)) ||
      !(header instanceof ownerWindow.HTMLDivElement) ||
      header.className !== "mb-4 flex items-start justify-between gap-4" ||
      header.nextElementSibling !== root
    ) {
      return false;
    }

    let openCount = 0;
    for (const owned of rowOwners) {
      const row = owned.authority;
      const item = owned.itemOwner.element();
      const anchor = owned.openOwner.element();
      const retryButton = owned.retryOwner.element();
      if (
        items[row.index] !== row ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        !item.isConnected ||
        item.ownerDocument !== ownerDocument ||
        item.parentElement !== list ||
        list.children.item(row.index) !== item ||
        item.className !== "import-item" ||
        item.dataset.testid !== "import-item" ||
        item.dataset.status !== row.status ||
        item.children.length !== 2 + (row.href ? 1 : 0) + (row.retry ? 1 : 0) ||
        item.firstElementChild?.getAttribute("aria-label") !==
          (row.status === "uploading"
            ? "Importing"
            : row.status === "done"
              ? "Imported"
              : "Failed")
      ) {
        return false;
      }
      const details = item.children.item(1);
      const name = details?.querySelector("span[title]");
      const warnings = details?.querySelectorAll('[data-testid="import-warning"]');
      if (
        !(details instanceof ownerWindow.HTMLDivElement) ||
        details.className !== "min-w-0 flex-1" ||
        name?.getAttribute("title") !== row.name ||
        !warnings ||
        warnings.length !== row.warnings.length ||
        row.warnings.some(
          (warning, warningIndex) =>
            warnings.item(warningIndex).textContent?.trim() !== warning,
        )
      ) {
        return false;
      }

      if (row.href) {
        openCount++;
        if (
          !(anchor instanceof ownerWindow.HTMLAnchorElement) ||
          !anchor.isConnected ||
          anchor.ownerDocument !== ownerDocument ||
          anchor.parentElement !== item ||
          item.children.item(2) !== anchor ||
          anchor.getAttribute("href") !== row.href ||
          anchor.className !== "import-open" ||
          anchor.dataset.testid !== "import-open" ||
          anchor.textContent?.trim() !== "Open" ||
          !isEffectivelyEnabled(anchor) ||
          item.querySelectorAll('[data-testid="import-open"]').length !== 1
        ) {
          return false;
        }
      } else if (
        anchor !== null ||
        item.querySelector('[data-testid="import-open"]')
      ) {
        return false;
      }

      if (row.retry) {
        if (
          !(retryButton instanceof ownerWindow.HTMLButtonElement) ||
          !retryButton.isConnected ||
          retryButton.ownerDocument !== ownerDocument ||
          retryButton.parentElement !== item ||
          item.lastElementChild !== retryButton ||
          retryButton.type !== "button" ||
          retryButton.className !== "btn btn-sm btn-outline shrink-0" ||
          retryButton.disabled !== busy ||
          retryButton.dataset.testid !== "import-row-retry" ||
          retryButton.textContent !== `Retry ${row.name}` ||
          (!busy && !isEffectivelyEnabled(retryButton)) ||
          item.querySelectorAll('[data-testid="import-row-retry"]').length !== 1
        ) {
          return false;
        }
      } else if (
        retryButton !== null ||
        item.querySelector('[data-testid="import-row-retry"]')
      ) {
        return false;
      }
    }
    if (list.querySelectorAll('[data-testid="import-open"]').length !== openCount) {
      return false;
    }
    if (
      list.querySelectorAll('[data-testid="import-row-retry"]').length !==
      items.filter((item) => item.retry).length
    ) {
      return false;
    }

    let rootIndex = 1;
    const ignoredElement = ignoredOwner.element();
    if (ignoredText) {
      if (
        !(ignoredElement instanceof ownerWindow.HTMLParagraphElement) ||
        !ignoredElement.isConnected ||
        ignoredElement.ownerDocument !== ownerDocument ||
        ignoredElement.parentElement !== root ||
        root.children.item(rootIndex++) !== ignoredElement ||
        ignoredElement.className !== "mt-3 text-xs text-ink-3" ||
        ignoredElement.dataset.testid !== "import-ignored" ||
        ignoredElement.textContent !== ignoredText ||
        root.querySelectorAll('[data-testid="import-ignored"]').length !== 1
      ) {
        return false;
      }
    } else if (
      ignoredElement !== null ||
      root.querySelector('[data-testid="import-ignored"]')
    ) {
      return false;
    }

    const retryElement = retryOwner.element();
    if (retry) {
      if (
        !(retryElement instanceof ownerWindow.HTMLButtonElement) ||
        !retryElement.isConnected ||
        retryElement.ownerDocument !== ownerDocument ||
        retryElement.parentElement !== root ||
        root.children.item(rootIndex) !== retryElement ||
        retryElement.type !== "button" ||
        retryElement.className !== "btn btn-sm btn-outline mt-4" ||
        retryElement.disabled !== busy ||
        retryElement.dataset.testid !== "import-retry" ||
        retryElement.textContent?.trim() !== "Retry failed" ||
        (!busy && !isEffectivelyEnabled(retryElement)) ||
        root.querySelectorAll('[data-testid="import-retry"]').length !== 1
      ) {
        return false;
      }
    } else if (
      retryElement !== null ||
      root.querySelector('[data-testid="import-retry"]')
    ) {
      return false;
    }
    return true;
  };

  const publicationWasClaimed = (publication: ImportResultPublication) =>
    cells.claimedOpenPublications.has(publication) ||
    cells.claimedRetryPublications.has(publication);

  const requestReplaySuccessor = (runtime: ImportResultPublicationRuntime) => {
    const dom = runtime.snapshot();
    const rootPlacement = runtime.rootPlacement();
    const currentFacts = factsAreCurrent();
    const currentDom = exactDomIsCurrent(true);
    const publishedDom = runtime.publishedDomMatches();
    if (
      successorRequested ||
      !dom ||
      !rootPlacement ||
      cells.successorOf.current !== runtime.publication ||
      publicationWasClaimed(runtime.publication) ||
      !currentFacts ||
      !currentDom ||
      !publishedDom
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom,
      rootPlacement,
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

  const nativeClick = <T extends HTMLElement>(
    publication: ImportResultPublication,
    event: ReactMouseEvent<T>,
    control: T,
  ): MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !ownerWindow ||
      event.type !== "click" ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      event.currentTarget !== control ||
      nativeEvent.target !== target ||
      !(target instanceof ownerWindow.Node) ||
      target.ownerDocument !== publication.ownerDocument ||
      target !== control ||
      !control.isConnected ||
      !isEffectivelyEnabled(control)
    ) {
      return null;
    }
    return nativeEvent;
  };

  const eventsAreUnclaimed = (
    reactEvent: object,
    nativeEvent: Event,
  ) =>
    !cells.claimedReactEvents.has(reactEvent) &&
    !cells.claimedNativeEvents.has(nativeEvent);

  const claimOpen = (
    row: ImportItemPublication,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ): ImportResultPublication | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && items[row.index] === row
        ? publication.rows[row.index]
        : null;
    const control = publishedRow?.open;
    const action = control?.action;
    const source = event?.currentTarget;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      cells.retiredPublications.has(publication) ||
      cells.active.current !== publication ||
      publication.authority !== authority ||
      publishedRow?.authority !== row ||
      !control ||
      !action ||
      source !== control.element ||
      cells.retiredRows.has(publishedRow) ||
      cells.retiredControls.has(control) ||
      cells.retiredActions.has(action) ||
      cells.claimedOpenPublications.has(publication) ||
      cells.claimedRows.has(publishedRow) ||
      cells.claimedControls.has(control) ||
      cells.claimedActions.has(action) ||
      action.publicationIdentity !== publication.identity ||
      action.controlIdentity !== control.identity ||
      action.kind !== "open" ||
      action.rowIndex !== row.index ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, event, source);
    if (!nativeEvent || !eventsAreUnclaimed(event, nativeEvent)) return null;
    cells.claimedOpenPublications.add(publication);
    cells.claimedRows.add(publishedRow);
    cells.claimedControls.add(control);
    cells.claimedActions.add(action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    return publication;
  };

  const claimRetry = (
    row: ImportItemPublication | null,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): (() => void) | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedRow =
      publication && row && items[row.index] === row
        ? publication.rows[row.index]
        : null;
    const control = row ? publishedRow?.retry : publication?.retry;
    const action = control?.action;
    const retryAction = row?.retry ?? authority.retry;
    const source = event?.currentTarget;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      cells.retiredPublications.has(publication) ||
      cells.active.current !== publication ||
      publication.authority !== authority ||
      !retryAction ||
      authority.busy ||
      (row !== null &&
        (publishedRow?.authority !== row ||
          cells.retiredRows.has(publishedRow) ||
          cells.claimedRows.has(publishedRow))) ||
      !control ||
      !action ||
      source !== control.element ||
      source.disabled ||
      cells.retiredControls.has(control) ||
      cells.retiredActions.has(action) ||
      cells.claimedRetryPublications.has(publication) ||
      cells.claimedControls.has(control) ||
      cells.claimedActions.has(action) ||
      action.publicationIdentity !== publication.identity ||
      action.controlIdentity !== control.identity ||
      action.kind !== "retry" ||
      action.rowIndex !== (row?.index ?? null) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, event, source);
    if (!nativeEvent || !eventsAreUnclaimed(event, nativeEvent)) return null;
    cells.claimedRetryPublications.add(publication);
    if (publishedRow) cells.claimedRows.add(publishedRow);
    cells.claimedControls.add(control);
    cells.claimedActions.add(action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    return retryAction;
  };

  const navigationOrderIsCurrent = (
    publication: ImportResultPublication,
  ) => {
    const elements = publication.root.querySelectorAll<HTMLElement>(
      '[data-testid="import-open"], [data-testid="import-row-retry"], [data-testid="import-retry"]',
    );
    return (
      elements.length === publication.navigationControls.length &&
      publication.navigationControls.every(
        (control, index) => elements.item(index) === control.element,
      ) &&
      new Set(
        publication.navigationControls.map(({ element }) => element),
      ).size === publication.navigationControls.length
    );
  };

  const navigationControlIsCurrent = (
    publication: ImportResultPublication,
    control: ImportResultControlPublication<HTMLElement>,
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
  ) => {
    const publishedRow =
      row && items[row.index] === row
        ? publication.rows[row.index]
        : null;
    const expected =
      kind === "open"
        ? publishedRow?.open
        : row
          ? publishedRow?.retry
          : publication.retry;
    const action = control.action;
    const navigationAction = control.navigationAction;
    return (
      expected === control &&
      publication.navigationControls.includes(control) &&
      control.publicationIdentity === publication.identity &&
      control.kind === kind &&
      control.rowIndex === (row?.index ?? null) &&
      action.publicationIdentity === publication.identity &&
      action.controlIdentity === control.identity &&
      action.kind === kind &&
      action.rowIndex === (row?.index ?? null) &&
      navigationAction.publicationIdentity === publication.identity &&
      navigationAction.controlIdentity === control.identity &&
      navigationAction.actionIdentity === action.identity &&
      navigationAction.kind === kind &&
      navigationAction.rowIndex === (row?.index ?? null) &&
      !cells.retiredControls.has(control) &&
      !cells.retiredActions.has(action) &&
      !cells.retiredActions.has(navigationAction) &&
      isEffectivelyEnabled(control.element)
    );
  };

  const publishedNavigationControlIsCurrent = (
    publication: ImportResultPublication,
    control: ImportResultControlPublication<HTMLElement>,
  ) => {
    const row =
      control.rowIndex === null
        ? null
        : items[control.rowIndex] ?? null;
    return navigationControlIsCurrent(
      publication,
      control,
      row,
      control.kind,
    );
  };

  const navigationDestination = (
    publication: ImportResultPublication,
    control: ImportResultControlPublication<HTMLElement>,
    key: ImportResultNavigationKey,
  ) => {
    const enabled = publication.navigationControls.filter(
      (candidate) => isEffectivelyEnabled(candidate.element),
    );
    const sourceIndex = enabled.indexOf(control);
    if (sourceIndex < 0) return null;
    let destinationIndex: number | null = null;
    if (key === "ArrowDown" && sourceIndex + 1 < enabled.length) {
      destinationIndex = sourceIndex + 1;
    } else if (key === "ArrowUp" && sourceIndex > 0) {
      destinationIndex = sourceIndex - 1;
    } else if (key === "Home" && sourceIndex !== 0) {
      destinationIndex = 0;
    } else if (key === "End" && sourceIndex !== enabled.length - 1) {
      destinationIndex = enabled.length - 1;
    }
    const destination =
      destinationIndex === null ? null : enabled[destinationIndex];
    return destination &&
      destination !== control &&
      publication.navigationControls.includes(destination) &&
      isEffectivelyEnabled(destination.element)
      ? destination
      : null;
  };

  const navigationNativeFactsAreEligible = (
    publication: ImportResultPublication,
    control: ImportResultControlPublication<HTMLElement>,
    facts: ImportResultNativeKeyboardFacts,
    expectedPhase: number,
    receiver: EventTarget,
    expectedDefaultPrevented = false,
  ) => {
    const keyboard = publication.keyboard;
    const ownerWindow = publication.ownerDocument.defaultView;
    const terminal = facts.path.at(-1);
    return Boolean(
      keyboard &&
        ownerWindow &&
        terminal &&
        facts.type === "keydown" &&
        facts.phase === expectedPhase &&
        facts.bubbles &&
        facts.cancelable &&
        facts.defaultPrevented === expectedDefaultPrevented &&
        !facts.cancelBubble &&
        facts.detail === 0 &&
        facts.code === facts.key &&
        facts.location ===
          ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_STANDARD &&
        !facts.ctrlKey &&
        !facts.altKey &&
        !facts.metaKey &&
        !facts.shiftKey &&
        !facts.repeat &&
        !facts.composing &&
        facts.target === control.element &&
        facts.currentTarget !== null &&
        facts.path.includes(facts.currentTarget) &&
        (facts.view === null ||
          facts.view === ownerWindow ||
          facts.view === receiver) &&
        importResultPathMatches(facts.path, control.path, terminal),
    );
  };

  const navigationStageMatches = (
    publication: ImportResultPublication,
    stage: ImportResultNavigationNativeStage,
    control: ImportResultControlPublication<HTMLElement>,
    nativeEvent: Event,
    facts: ImportResultNativeKeyboardFacts,
    expectedDefaultPrevented = false,
  ) => {
    const keyboard = publication.keyboard;
    const terminal = stage.facts.path.at(-1);
    return Boolean(
      keyboard &&
        terminal &&
        stage.nativeEvent === nativeEvent &&
        stage.control === control &&
        stage.receiver === stage.facts.currentTarget &&
        terminal === stage.receiver &&
        stage.facts.phase === keyboard.capturingPhase &&
        stage.facts.target === control.element &&
        importResultPathMatches(
          stage.facts.path,
          control.path,
          terminal,
        ) &&
        facts.path.at(-1) === terminal &&
        importResultNativeKeyboardFactsMatch(
          stage.facts,
          facts,
          expectedDefaultPrevented,
        ),
    );
  };

  const createRuntime = (): ImportResultPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const list = listOwner.element();
    const dialog = root?.parentElement;
    const ownerWindow = root?.ownerDocument.defaultView as
      | (Window & typeof globalThis)
      | null
      | undefined;
    const ignoredElement = ignoredOwner.element();
    const retryElement = retryOwner.element();
    const rootPlacement = root
      ? captureImportResultPlacement(root)
      : null;
    if (
      !root ||
      !list ||
      !ownerWindow ||
      !(dialog instanceof ownerWindow.HTMLDivElement) ||
      !rootPlacement ||
      rowOwners.some(
        ({ authority: row, itemOwner, openOwner, retryOwner }) =>
          !itemOwner.element() ||
          (row.href ? !openOwner.element() : Boolean(openOwner.element())) ||
          (row.retry ? !retryOwner.element() : Boolean(retryOwner.element())),
      ) ||
      (ignoredText ? !ignoredElement : Boolean(ignoredElement)) ||
      (retry ? !retryElement : Boolean(retryElement))
    ) {
      return null;
    }

    const identity = Symbol("import-result-publication");
    const control = <T extends HTMLElement>(
      kind: ImportResultActionKind,
      rowIndex: number | null,
      element: T,
    ): ImportResultControlPublication<T> => {
      const controlIdentity = Symbol(`import-result-${kind}-control`);
      const action = Object.freeze({
        identity: Symbol(`import-result-${kind}-action`),
        publicationIdentity: identity,
        controlIdentity,
        kind,
        rowIndex,
      });
      const path = captureImportResultEventPath(
        element,
        root.ownerDocument,
      );
      if (!path) {
        throw new Error(
          "Cannot publish an import result action without its owner-realm path",
        );
      }
      return Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        kind,
        rowIndex,
        element,
        action,
        navigationAction: Object.freeze({
          identity: Symbol(`import-result-${kind}-navigation-action`),
          publicationIdentity: identity,
          controlIdentity,
          actionIdentity: action.identity,
          kind,
          rowIndex,
        }),
        path,
      });
    };
    const publishedRows = Object.freeze(
      rowOwners.map((owned) => {
        const item = owned.itemOwner.element();
        const openElement = owned.openOwner.element();
        const retryElement = owned.retryOwner.element();
        if (
          !item ||
          (owned.authority.href && !openElement) ||
          (owned.authority.retry && !retryElement)
        ) {
          throw new Error("Cannot publish an import row without every committed ref");
        }
        return Object.freeze({
          identity: Symbol("import-result-row"),
          authority: owned.authority,
          item,
          open:
            owned.authority.href && openElement
              ? control("open", owned.authority.index, openElement)
              : null,
          retry:
            owned.authority.retry && retryElement
              ? control("retry", owned.authority.index, retryElement)
              : null,
        });
      }),
    );
    const publishedRetry =
      retry && retryElement ? control("retry", null, retryElement) : null;
    const navigationControls = Object.freeze([
      ...publishedRows.flatMap((row) => [
        ...(row.open ? [row.open] : []),
        ...(row.retry ? [row.retry] : []),
      ]),
      ...(publishedRetry ? [publishedRetry] : []),
    ] as ImportResultControlPublication<HTMLElement>[]);
    const keyboard = captureImportResultKeyboardAuthority(ownerWindow);
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: ImportResultDomSnapshot | null = null;
    let publishedRootPlacement: ImportResultPlacement | null = null;
    let replayRefs: RefReplay[] = [];
    let partialReplayOwners = new Set<ElementOwnerView>();
    let invalidReplay = false;
    let navigationCaptureReady = false;
    let navigationStages: WeakMap<
      KeyboardEvent,
      ImportResultNavigationNativeStage
    > | null = keyboard ? new WeakMap() : null;
    let navigationPairs: WeakMap<
      KeyboardEvent,
      ImportResultNavigationPair
    > | null = keyboard ? new WeakMap() : null;
    let navigationRegistration: ReturnType<
      ImportResultKeyboardAuthority["register"]
    > = null;
    const pendingDialogAttributes = new Set(
      ["aria-labelledby", "aria-describedby", "style"].filter(
        (attribute) => dialog.getAttribute(attribute) === null,
      ),
    );
    const publication: ImportResultPublication = Object.freeze({
      identity,
      authority,
      ownerDocument: root.ownerDocument,
      dialog,
      root,
      list,
      rows: publishedRows,
      ignored: ignoredElement,
      retry: publishedRetry,
      navigationControls,
      keyboard,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const exactInitialDialogAriaWrite = (record: MutationRecord) => {
      const attribute = record.attributeName;
      if (
        record.type !== "attributes" ||
        record.target !== dialog ||
        !attribute ||
        !pendingDialogAttributes.has(attribute) ||
        record.oldValue !== null
      ) {
        return false;
      }
      if (attribute === "style") {
        if (dialog.style.pointerEvents !== "auto") return false;
        pendingDialogAttributes.delete(attribute);
        return true;
      }
      const id = dialog.getAttribute(attribute);
      const referenced = id ? publication.ownerDocument.getElementById(id) : null;
      const expected =
        attribute === "aria-labelledby"
          ? IMPORT_DIALOG_TITLE
          : IMPORT_DIALOG_DESCRIPTION;
      if (!referenced || !dialog.contains(referenced) || referenced.textContent !== expected) {
        return false;
      }
      pendingDialogAttributes.delete(attribute);
      return true;
    };
    const mutationIsRelevant = (record: MutationRecord) => {
      if (exactInitialDialogAriaWrite(record)) return false;
      if (record.target === dialog || dialog.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "aria-busy" ||
          record.attributeName === "disabled")
      ) {
        return dialog.contains(record.target) || record.target.contains(dialog);
      }
      if (record.type !== "childList") return false;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === dialog || node.contains(dialog),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      const relevant = records.map(mutationIsRelevant);
      if (!domChanged && relevant.some(Boolean)) domChanged = true;
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (recordMutations(records) && !retire("element")) {
        releaseReplayGuard();
      }
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      navigationCaptureReady = false;
      navigationStages = null;
      navigationPairs = null;
      navigationRegistration?.remove();
      navigationRegistration = null;
      cells.retiredPublications.add(publication);
      for (const row of publication.rows) {
        cells.retiredRows.add(row);
        if (row.open) {
          cells.retiredControls.add(row.open);
          cells.retiredActions.add(row.open.action);
          cells.retiredActions.add(row.open.navigationAction);
        }
        if (row.retry) {
          cells.retiredControls.add(row.retry);
          cells.retiredActions.add(row.retry.action);
          cells.retiredActions.add(row.retry.navigationAction);
        }
      }
      if (publication.retry) {
        cells.retiredControls.add(publication.retry);
        cells.retiredActions.add(publication.retry.action);
        cells.retiredActions.add(publication.retry.navigationAction);
      }
      const wasActive = cells.active.current === publication;
      if (wasActive) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (reason === "layout" || reason === "element") {
        queueMicrotask(() => {
          if (!domObserver) return;
          recordMutations(domObserver.takeRecords());
          if (!domChanged && cells.replay.current?.source === publication) {
            return;
          }
          domChanged = true;
          domObserver.disconnect();
          domObserver = null;
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
          domSnapshot &&
          publishedRootPlacement &&
          rootOwner.element() === root &&
          listOwner.element() === list &&
          dialog.isConnected &&
          root.isConnected &&
          importResultPlacementMatches(root, publishedRootPlacement) &&
          importResultDomMatches(domSnapshot),
      );
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactPartialReplay = () =>
      !invalidReplay &&
      partialReplayOwners.size > 0 &&
      replayRefs.every(
        (entry) =>
          entry.owner.element() === entry.element &&
          (partialReplayOwners.has(entry.owner)
            ? entry.detached && entry.reattached
            : !entry.detached && !entry.reattached),
      );
    const runtime: ImportResultPublicationRuntime = Object.freeze({
      publication,
      publish: (
        dom: ImportResultDomSnapshot,
        nextRootPlacement: ImportResultPlacement,
        owners: readonly ElementOwnerView[],
        partialReplayElements: ReadonlySet<HTMLElement>,
      ) => {
        established = true;
        domSnapshot = dom;
        publishedRootPlacement = nextRootPlacement;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish ImportDialog without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        partialReplayOwners = new Set(
          replayRefs
            .filter(({ element }) => partialReplayElements.has(element))
            .map(({ owner }) => owner),
        );
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(publication.ownerDocument, {
            attributeOldValue: true,
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: ElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (
          element === null &&
          previous === proof.element &&
          proof.element.isConnected
        ) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached &&
          proof.element.isConnected
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        established &&
        (layoutRetired
          ? refsHaveExactReplay()
          : refsHaveExactPartialReplay()) &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            publishedRootPlacement &&
            dialog.isConnected &&
            root.isConnected &&
            importResultPlacementMatches(root, publishedRootPlacement) &&
            importResultDomMatches(domSnapshot),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      rootPlacement: () => publishedRootPlacement,
      navigationCaptureIsReady: () => navigationCaptureReady,
      navigationListenerIsCurrent: () =>
        navigationRegistration?.isCurrent() === true,
      navigationStage: (event: KeyboardEvent) =>
        navigationStages?.get(event) ?? null,
      pairNavigation: (
        event: KeyboardEvent,
        stage: ImportResultNavigationNativeStage,
        pair: ImportResultNavigationPair,
      ) => {
        const stages = navigationStages;
        const pairs = navigationPairs;
        if (
          !stages ||
          !pairs ||
          stages.get(event) !== stage ||
          pairs.has(event)
        ) {
          return false;
        }
        stages.delete(event);
        pairs.set(event, pair);
        return true;
      },
      navigationPair: (event: KeyboardEvent) =>
        navigationPairs?.get(event) ?? null,
      consumeNavigationPair: (
        event: KeyboardEvent,
        pair: ImportResultNavigationPair,
      ) => {
        const pairs = navigationPairs;
        if (!pairs || pairs.get(event) !== pair) return false;
        return pairs.delete(event);
      },
    });
    if (keyboard) {
      const navigationKeyboard = keyboard;
      const navigationOwnerWindow = ownerWindow;
      function rememberImportResultNavigationNative(
        this: EventTarget,
        nativeEvent: Event,
      ) {
        const stages = navigationStages;
        const pairs = navigationPairs;
        if (
          !navigationCaptureReady ||
          !stages ||
          !pairs ||
          navigationRegistration?.isCurrent() !== true ||
          retired ||
          !established ||
          cells.active.current !== publication ||
          cells.navigationAttempt.current !== null ||
          cells.navigationDelivery.current !== null
        ) {
          return;
        }
        const facts = navigationKeyboard.read(nativeEvent);
        const sourceControl = facts
          ? publication.navigationControls.find(
              ({ element }) => element === facts.target,
            )
          : undefined;
        const terminal = facts?.path.at(-1);
        if (
          !facts ||
          !sourceControl ||
          !terminal ||
          !isImportResultNavigationKey(facts.key) ||
          facts.type !== "keydown" ||
          facts.phase !== navigationKeyboard.capturingPhase ||
          facts.currentTarget !== this ||
          terminal !== this ||
          (facts.view !== null &&
            facts.view !== navigationOwnerWindow &&
            facts.view !== this) ||
          facts.target !== sourceControl.element ||
          stages.has(nativeEvent as KeyboardEvent) ||
          pairs.has(nativeEvent as KeyboardEvent) ||
          !importResultPathMatches(
            facts.path,
            sourceControl.path,
            terminal,
          )
        ) {
          return;
        }
        const stage = Object.freeze({
          nativeEvent: nativeEvent as KeyboardEvent,
          receiver: this,
          facts,
          control: sourceControl,
        });
        stages.set(nativeEvent as KeyboardEvent, stage);
      }
      const registration = navigationKeyboard.register(
        rememberImportResultNavigationNative,
      );
      if (registration) {
        navigationRegistration = registration;
        navigationCaptureReady = true;
      } else {
        navigationStages = null;
        navigationPairs = null;
        navigationCaptureReady = false;
      }
    }
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent(true)) return undefined;
    const root = rootOwner.element();
    const dialog = root?.parentElement;
    if (!root || !(dialog instanceof HTMLDivElement)) return undefined;
    const rootPlacement = captureImportResultPlacement(root);
    if (!rootPlacement) return undefined;
    const replay = cells.replay.current;
    if (
      replay &&
      (
        cells.successorOf.current !== replay.source ||
        publicationWasClaimed(replay.source) ||
        !importResultAuthoritiesMatch(replay.source.authority, authority) ||
        replay.dom.node !== dialog ||
        !importResultPlacementMatches(root, replay.rootPlacement) ||
        !importResultDomMatches(replay.dom) ||
        !replay.unchanged()
      )
    ) {
      const exactDomStillCommitted =
        replay.dom.node === dialog &&
        importResultPlacementMatches(root, replay.rootPlacement) &&
        importResultDomMatches(replay.dom) &&
        replay.unchanged();
      replay.release();
      cells.replay.current = null;
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (exactDomStillCommitted) requestSuccessor();
      return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active.current;
    const predecessor = previous ?? cells.successorOf.current;
    const predecessorControls = new Set<HTMLElement>(
      predecessor
        ? [
            ...predecessor.rows.flatMap((row) =>
              [
                ...(row.open ? [row.open.element] : []),
                ...(row.retry ? [row.retry.element] : []),
              ],
            ),
            ...(predecessor.retry ? [predecessor.retry.element] : []),
          ]
        : [],
    );
    const partialReplayElements = new Set<HTMLElement>(
      predecessor?.authority.mount === mount
        ? [
            ...publication.rows.flatMap((row) =>
              [
                ...(row.open && !predecessorControls.has(row.open.element)
                  ? [row.open.element]
                  : []),
                ...(row.retry && !predecessorControls.has(row.retry.element)
                  ? [row.retry.element]
                  : []),
              ],
            ),
            ...(publication.retry &&
            !predecessorControls.has(publication.retry.element)
              ? [publication.retry.element]
              : []),
          ]
        : [],
    );
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotImportResultDom(dialog, dialog),
      rootPlacement,
      expectedOwners(),
      partialReplayElements,
    );
    replay?.release();
    return runtime.retireForLayout;
  };

  const onOpen = (
    row: ImportItemPublication,
    event: ReactMouseEvent<HTMLAnchorElement>,
  ) => {
    const publication = claimOpen(row, event);
    if (!publication) return;
    publication.authority.onOpenChange(false);
  };
  const onRetry = (
    row: ImportItemPublication | null,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    claimRetry(row, event)?.();
  };
  const navigationAttemptIsCurrent = ({
    runtime,
    publication,
    stage,
    control,
    destination,
    row,
    kind,
    nativeEvent,
    nativeFacts,
    react,
    methods,
    expectedPhase,
    expectedDefaultPrevented,
    storeIsCurrent,
    capture,
    claimed,
  }: {
    runtime: ImportResultPublicationRuntime;
    publication: ImportResultPublication;
    stage: ImportResultNavigationNativeStage;
    control: ImportResultControlPublication<HTMLElement>;
    destination: ImportResultControlPublication<HTMLElement>;
    row: ImportItemPublication | null;
    kind: ImportResultActionKind;
    nativeEvent: KeyboardEvent;
    nativeFacts: ImportResultNativeKeyboardFacts;
    react: ImportResultReactKeyboardSnapshot;
    methods: Readonly<
      Record<
        ImportResultReactKeyboardMethodName,
        ImportResultReactKeyboardMethod
      >
    >;
    expectedPhase: number;
    expectedDefaultPrevented: boolean;
    storeIsCurrent: () => boolean;
    capture?: ImportResultReactKeyboardSnapshot;
    claimed: boolean;
  }) => {
    const keyboard = publication.keyboard;
    const publishedRow =
      row && items[row.index] === row
        ? publication.rows[row.index]
        : null;
    const currentNativeFacts = keyboard?.read(nativeEvent);
    const navigationAction = control.navigationAction;
    return Boolean(
      keyboard &&
        currentNativeFacts &&
        runtime.navigationCaptureIsReady() &&
        runtime.navigationListenerIsCurrent() &&
        !runtime.isRetired() &&
        !cells.retiredPublications.has(publication) &&
        cells.active.current === publication &&
        publication.authority === authority &&
        !publicationWasClaimed(publication) &&
        cells.navigationAttempt.current === nativeEvent &&
        (claimed
          ? cells.navigationDelivery.current === publication.identity &&
            cells.claimedNavigationReactEvents.has(
              capture?.event ?? react.event,
            ) &&
            cells.claimedNavigationReactEvents.has(react.event) &&
            cells.claimedNavigationNativeEvents.has(nativeEvent)
          : cells.navigationDelivery.current === null &&
            !cells.claimedNavigationReactEvents.has(
              capture?.event ?? react.event,
            ) &&
            !cells.claimedNavigationReactEvents.has(react.event) &&
            !cells.claimedNavigationNativeEvents.has(nativeEvent)) &&
        (row === null ||
          (publishedRow?.authority === row &&
            !cells.retiredRows.has(publishedRow))) &&
        navigationControlIsCurrent(publication, control, row, kind) &&
        publishedNavigationControlIsCurrent(publication, destination) &&
        isImportResultNavigationKey(currentNativeFacts.key) &&
        navigationDestination(
          publication,
          control,
          currentNativeFacts.key,
        ) === destination &&
        currentNativeFacts.key === nativeFacts.key &&
        keyboard.activeElement() === control.element &&
        react.publicFacts.nativeEvent === nativeEvent &&
        react.publicFacts.target === control.element &&
        react.publicFacts.currentTarget === control.element &&
        importResultReactKeyboardSnapshotIsCurrent(
          react,
          currentNativeFacts,
          control.element,
          expectedPhase,
          expectedDefaultPrevented,
          methods,
        ) &&
        (!capture ||
          importResultReactKeyboardMethodsAreCurrent(capture)) &&
        navigationNativeFactsAreEligible(
          publication,
          control,
          currentNativeFacts,
          expectedPhase,
          stage.receiver,
          expectedDefaultPrevented,
        ) &&
        navigationStageMatches(
          publication,
          stage,
          control,
          nativeEvent,
          currentNativeFacts,
          expectedDefaultPrevented,
        ) &&
        importResultNativeKeyboardFactsMatch(
          nativeFacts,
          currentNativeFacts,
          expectedDefaultPrevented,
        ) &&
        stage.nativeEvent === nativeEvent &&
        stage.control === control &&
        navigationAction.publicationIdentity === publication.identity &&
        navigationAction.controlIdentity === control.identity &&
        navigationAction.actionIdentity === control.action.identity &&
        navigationAction.kind === control.kind &&
        navigationAction.rowIndex === control.rowIndex &&
        !cells.retiredActions.has(navigationAction) &&
        storeIsCurrent() &&
        factsAreCurrent() &&
        exactDomIsCurrent() &&
        navigationOrderIsCurrent(publication) &&
        runtime.publishedDomMatches(),
    );
  };
  const onNavigateCapture = <T extends HTMLElement>(
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
    event: ReactKeyboardEvent<T>,
  ) => {
    if (!event || typeof event !== "object") return;
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      cells.claimedNavigationReactEvents.has(event) ||
      cells.claimedNavigationNativeEvents.has(nativeEvent as Event)
    ) {
      return;
    }
    if (
      cells.navigationAttempt.current !== null ||
      cells.navigationDelivery.current !== null
    ) {
      return;
    }
    cells.navigationAttempt.current = nativeEvent;
    try {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      const publishedRow =
        publication && row && items[row.index] === row
          ? publication.rows[row.index]
          : null;
      const control =
        kind === "open"
          ? publishedRow?.open
          : row
            ? publishedRow?.retry
            : publication?.retry;
      const keyboard = publication?.keyboard;
      const keyEvent = nativeEvent as KeyboardEvent;
      const stage = runtime?.navigationStage(keyEvent);
      if (
        !runtime ||
        !publication ||
        !control ||
        !keyboard ||
        !stage ||
        !runtime.navigationCaptureIsReady() ||
        !runtime.navigationListenerIsCurrent() ||
        runtime.navigationPair(keyEvent) !== null ||
        runtime.isRetired() ||
        cells.retiredPublications.has(publication) ||
        cells.active.current !== publication ||
        publication.authority !== authority ||
        publicationWasClaimed(publication) ||
        cells.claimedNavigationReactEvents.has(event) ||
        cells.claimedNavigationNativeEvents.has(nativeEvent as Event) ||
        (row !== null &&
          (publishedRow?.authority !== row ||
            cells.retiredRows.has(publishedRow))) ||
        !navigationControlIsCurrent(publication, control, row, kind) ||
        !factsAreCurrent() ||
        !exactDomIsCurrent() ||
        !navigationOrderIsCurrent(publication) ||
        !runtime.publishedDomMatches()
      ) {
        return;
      }
      const nativeFacts = keyboard.read(nativeEvent);
      const destination =
        nativeFacts && isImportResultNavigationKey(nativeFacts.key)
          ? navigationDestination(publication, control, nativeFacts.key)
          : null;
      const capture =
        nativeFacts
          ? captureImportResultReactKeyboardEvent(
              event as ReactKeyboardEvent<HTMLElement>,
              nativeEvent as Event,
              nativeFacts,
              control.element,
              keyboard.capturingPhase,
            )
          : null;
      if (
        !nativeFacts ||
        !destination ||
        !capture ||
        !navigationNativeFactsAreEligible(
          publication,
          control,
          nativeFacts,
          keyboard.capturingPhase,
          stage.receiver,
        ) ||
        !navigationStageMatches(
          publication,
          stage,
          control,
          nativeEvent as Event,
          nativeFacts,
        ) ||
        cells.active.current !== publication ||
        runtime.isRetired() ||
        publicationWasClaimed(publication) ||
        keyboard.activeElement() !== control.element ||
        !navigationControlIsCurrent(publication, control, row, kind) ||
        !publishedNavigationControlIsCurrent(
          publication,
          destination,
        ) ||
        !factsAreCurrent() ||
        !exactDomIsCurrent() ||
        !navigationOrderIsCurrent(publication) ||
        !runtime.publishedDomMatches() ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage,
          control,
          destination,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.capturingPhase,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.navigationStage(keyEvent) === stage &&
            runtime.navigationPair(keyEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const defaultPrevented = keyboard.applyMethod(
        capture.methods.isDefaultPrevented,
        capture.event,
      );
      if (
        !defaultPrevented.called ||
        defaultPrevented.value !== false ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage,
          control,
          destination,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.capturingPhase,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.navigationStage(keyEvent) === stage &&
            runtime.navigationPair(keyEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const propagationStopped = keyboard.applyMethod(
        capture.methods.isPropagationStopped,
        capture.event,
      );
      if (
        !propagationStopped.called ||
        propagationStopped.value !== false ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage,
          control,
          destination,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: capture,
          methods: capture.methods,
          expectedPhase: keyboard.capturingPhase,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.navigationStage(keyEvent) === stage &&
            runtime.navigationPair(keyEvent) === null,
          claimed: false,
        })
      ) {
        return;
      }
      const pair: ImportResultNavigationPair = Object.freeze({
        publication,
        action: control.navigationAction,
        nativeEvent: keyEvent,
        stage,
        capture,
        sourceControl: control,
        destinationControl: destination,
        key: nativeFacts.key as ImportResultNavigationKey,
      });
      runtime.pairNavigation(keyEvent, stage, pair);
    } finally {
      if (cells.navigationAttempt.current === nativeEvent) {
        cells.navigationAttempt.current = null;
      }
    }
  };

  const completeNavigation = <T extends HTMLElement>(
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
    event: ReactKeyboardEvent<T>,
    nativeEvent: Event,
  ) => {
    const keyEvent = nativeEvent as KeyboardEvent;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const pair = runtime?.navigationPair(keyEvent);
    const publishedRow =
      publication && row && items[row.index] === row
        ? publication.rows[row.index]
        : null;
    const control =
      kind === "open"
        ? publishedRow?.open
        : row
          ? publishedRow?.retry
          : publication?.retry;
    const keyboard = publication?.keyboard;
    if (
      !runtime ||
      !publication ||
      !pair ||
      !control ||
      !keyboard ||
      !runtime.navigationCaptureIsReady() ||
      !runtime.navigationListenerIsCurrent() ||
      runtime.isRetired() ||
      pair.publication !== publication ||
      pair.nativeEvent !== nativeEvent ||
      pair.capture.publicFacts.nativeEvent !== nativeEvent ||
      pair.capture.event === event ||
      pair.sourceControl !== control ||
      pair.action !== control.navigationAction ||
      cells.retiredPublications.has(publication) ||
      cells.active.current !== publication ||
      publication.authority !== authority ||
      publicationWasClaimed(publication) ||
      cells.claimedNavigationReactEvents.has(pair.capture.event) ||
      cells.claimedNavigationReactEvents.has(event) ||
      cells.claimedNavigationNativeEvents.has(nativeEvent) ||
      (row !== null &&
        (publishedRow?.authority !== row ||
          cells.retiredRows.has(publishedRow))) ||
      !navigationControlIsCurrent(publication, control, row, kind) ||
      !publishedNavigationControlIsCurrent(
        publication,
        pair.destinationControl,
      ) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !navigationOrderIsCurrent(publication) ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    const nativeFacts = keyboard.read(nativeEvent);
    const bubble = nativeFacts
      ? captureImportResultReactKeyboardEvent(
          event as ReactKeyboardEvent<HTMLElement>,
          nativeEvent,
          nativeFacts,
          control.element,
          keyboard.bubblingPhase,
        )
      : null;
    const currentDestination =
      nativeFacts && isImportResultNavigationKey(nativeFacts.key)
        ? navigationDestination(publication, control, nativeFacts.key)
        : null;
    if (
      !nativeFacts ||
      !bubble ||
      !currentDestination ||
      currentDestination !== pair.destinationControl ||
      nativeFacts.key !== pair.key ||
      pair.capture.publicFacts.target !== bubble.publicFacts.target ||
      pair.capture.publicFacts.currentTarget !==
        bubble.publicFacts.currentTarget ||
      pair.capture.publicFacts.phase !== keyboard.capturingPhase ||
      bubble.publicFacts.phase !== keyboard.bubblingPhase ||
      !navigationNativeFactsAreEligible(
        publication,
        control,
        nativeFacts,
        keyboard.bubblingPhase,
        pair.stage.receiver,
      ) ||
      !importResultNativeKeyboardFactsMatch(
        pair.capture.nativeFacts,
        nativeFacts,
      ) ||
      !navigationStageMatches(
        publication,
        pair.stage,
        control,
        nativeEvent,
        nativeFacts,
      ) ||
      !importResultReactKeyboardMethodsAreCurrent(pair.capture) ||
      keyboard.activeElement() !== control.element ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !navigationOrderIsCurrent(publication) ||
      !runtime.publishedDomMatches() ||
      !navigationAttemptIsCurrent({
        runtime,
        publication,
        stage: pair.stage,
        control,
        destination: pair.destinationControl,
        row,
        kind,
        nativeEvent: keyEvent,
        nativeFacts,
        react: bubble,
        methods: bubble.methods,
        expectedPhase: keyboard.bubblingPhase,
        expectedDefaultPrevented: false,
        storeIsCurrent: () =>
          runtime.navigationPair(keyEvent) === pair,
        capture: pair.capture,
        claimed: false,
      })
    ) {
      return;
    }
    const bubbleDefaultPrevented = keyboard.applyMethod(
      bubble.methods.isDefaultPrevented,
      bubble.event,
    );
    if (
      !bubbleDefaultPrevented.called ||
      bubbleDefaultPrevented.value !== false ||
      !navigationAttemptIsCurrent({
        runtime,
        publication,
        stage: pair.stage,
        control,
        destination: pair.destinationControl,
        row,
        kind,
        nativeEvent: keyEvent,
        nativeFacts,
        react: bubble,
        methods: bubble.methods,
        expectedPhase: keyboard.bubblingPhase,
        expectedDefaultPrevented: false,
        storeIsCurrent: () =>
          runtime.navigationPair(keyEvent) === pair,
        capture: pair.capture,
        claimed: false,
      })
    ) {
      return;
    }
    const bubblePropagationStopped = keyboard.applyMethod(
      bubble.methods.isPropagationStopped,
      bubble.event,
    );
    if (
      !bubblePropagationStopped.called ||
      bubblePropagationStopped.value !== false ||
      !navigationAttemptIsCurrent({
        runtime,
        publication,
        stage: pair.stage,
        control,
        destination: pair.destinationControl,
        row,
        kind,
        nativeEvent: keyEvent,
        nativeFacts,
        react: bubble,
        methods: bubble.methods,
        expectedPhase: keyboard.bubblingPhase,
        expectedDefaultPrevented: false,
        storeIsCurrent: () =>
          runtime.navigationPair(keyEvent) === pair,
        capture: pair.capture,
        claimed: false,
      })
    ) {
      return;
    }
    const action = pair.action;
    if (
      cells.navigationDelivery.current !== null ||
      cells.active.current !== publication ||
      cells.retiredControls.has(control) ||
      cells.retiredActions.has(action) ||
      action.publicationIdentity !== publication.identity ||
      action.controlIdentity !== control.identity ||
      action.actionIdentity !== control.action.identity ||
      action.kind !== control.kind ||
      action.rowIndex !== control.rowIndex
    ) {
      return;
    }
    if (!runtime.consumeNavigationPair(keyEvent, pair)) return;
    cells.claimedNavigationReactEvents.add(pair.capture.event);
    cells.claimedNavigationReactEvents.add(event);
    cells.claimedNavigationNativeEvents.add(nativeEvent);
    cells.navigationDelivery.current = publication.identity;
    try {
      if (
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          control,
          destination: pair.destinationControl,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: bubble,
          methods: bubble.methods,
          expectedPhase: keyboard.bubblingPhase,
          expectedDefaultPrevented: false,
          storeIsCurrent: () =>
            runtime.navigationPair(keyEvent) === null,
          capture: pair.capture,
          claimed: true,
        })
      ) {
        return;
      }
      const prevented = keyboard.applyMethod(
        bubble.methods.preventDefault,
        bubble.event,
      );
      if (!prevented.called) return;
      const postPreventionMethods =
        readImportResultReactKeyboardMethods(
          bubble.event as ReactKeyboardEvent<HTMLElement> &
            ImportResultReactKeyboardEvent,
        );
      if (
        !postPreventionMethods ||
        postPreventionMethods.preventDefault !==
          bubble.methods.preventDefault ||
        postPreventionMethods.isPropagationStopped !==
          bubble.methods.isPropagationStopped ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          control,
          destination: pair.destinationControl,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: bubble,
          methods: postPreventionMethods,
          expectedPhase: keyboard.bubblingPhase,
          expectedDefaultPrevented: true,
          storeIsCurrent: () =>
            runtime.navigationPair(keyEvent) === null,
          capture: pair.capture,
          claimed: true,
        })
      ) {
        return;
      }
      const defaultPreventedAfter = keyboard.applyMethod(
        postPreventionMethods.isDefaultPrevented,
        bubble.event,
      );
      if (
        !defaultPreventedAfter.called ||
        defaultPreventedAfter.value !== true ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          control,
          destination: pair.destinationControl,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: bubble,
          methods: postPreventionMethods,
          expectedPhase: keyboard.bubblingPhase,
          expectedDefaultPrevented: true,
          storeIsCurrent: () =>
            runtime.navigationPair(keyEvent) === null,
          capture: pair.capture,
          claimed: true,
        })
      ) {
        return;
      }
      const propagationStoppedAfter = keyboard.applyMethod(
        postPreventionMethods.isPropagationStopped,
        bubble.event,
      );
      if (
        !propagationStoppedAfter.called ||
        propagationStoppedAfter.value !== false ||
        !navigationAttemptIsCurrent({
          runtime,
          publication,
          stage: pair.stage,
          control,
          destination: pair.destinationControl,
          row,
          kind,
          nativeEvent: keyEvent,
          nativeFacts,
          react: bubble,
          methods: postPreventionMethods,
          expectedPhase: keyboard.bubblingPhase,
          expectedDefaultPrevented: true,
          storeIsCurrent: () =>
            runtime.navigationPair(keyEvent) === null,
          capture: pair.capture,
          claimed: true,
        })
      ) {
        return;
      }
      keyboard.focus(pair.destinationControl.element);
    } finally {
      if (cells.navigationDelivery.current === publication.identity) {
        cells.navigationDelivery.current = null;
      }
    }
  };

  const onNavigate = <T extends HTMLElement>(
    row: ImportItemPublication | null,
    kind: ImportResultActionKind,
    event: ReactKeyboardEvent<T>,
  ) => {
    if (!event || typeof event !== "object") return;
    let nativeEvent: unknown;
    try {
      nativeEvent = event.nativeEvent;
    } catch {
      return;
    }
    if (
      !nativeEvent ||
      typeof nativeEvent !== "object" ||
      cells.claimedNavigationReactEvents.has(event) ||
      cells.claimedNavigationNativeEvents.has(nativeEvent as Event)
    ) {
      return;
    }
    if (
      cells.navigationAttempt.current !== null ||
      cells.navigationDelivery.current !== null
    ) {
      return;
    }
    cells.navigationAttempt.current = nativeEvent;
    try {
      completeNavigation(row, kind, event, nativeEvent as Event);
    } finally {
      if (cells.navigationAttempt.current === nativeEvent) {
        cells.navigationAttempt.current = null;
      }
    }
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureList: listOwner.capture,
    captureIgnored: ignoredOwner.capture,
    captureRetry: retryOwner.capture,
    rows: rowOwners,
    establish,
    onOpen,
    onRetry,
    onNavigateCapture,
    onNavigate,
  });
}

function StatusIcon({ status }: { status: ImportItemStatus }) {
  if (status === "uploading") return <Loader2 size={16} className="animate-spin text-ink-3" aria-label="Importing" />;
  if (status === "done") return <CheckCircle2 size={16} className="text-emerald-600" aria-label="Imported" />;
  return <XCircle size={16} className="text-red-600" aria-label="Failed" />;
}

/** Per-file progress and "Open" links for an import batch. */
export function ImportDialog({ open, onOpenChange, items, ignored, footer }: ImportDialogProps) {
  const [mount] = useState(() => Symbol("import-result-dialog"));
  const [cells] = useState<ImportResultCells>(() => ({
    active: new CurrentCell<ImportResultPublication | null>(null),
    successorOf: new CurrentCell<ImportResultPublication | null>(null),
    replay: new CurrentCell<ImportResultReplay | null>(null),
    retiredPublications: new WeakSet<ImportResultPublication>(),
    retiredRows: new WeakSet<ImportResultRowPublication>(),
    retiredControls: new WeakSet<ImportResultControlPublication<HTMLElement>>(),
    retiredActions: new WeakSet<
      ImportResultActionPublication | ImportResultNavigationActionPublication
    >(),
    claimedOpenPublications: new WeakSet<ImportResultPublication>(),
    claimedRetryPublications: new WeakSet<ImportResultPublication>(),
    claimedRows: new WeakSet<ImportResultRowPublication>(),
    claimedControls: new WeakSet<ImportResultControlPublication<HTMLElement>>(),
    claimedActions: new WeakSet<ImportResultActionPublication>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
    claimedNavigationReactEvents: new WeakSet<object>(),
    claimedNavigationNativeEvents: new WeakSet<Event>(),
    navigationAttempt: new CurrentCell<object | null>(null),
    navigationDelivery: new CurrentCell<symbol | null>(null),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const publishedItems = Object.freeze(items.map(snapshotImportItem));
  const ignoredNames = Object.freeze([...ignored]);
  const authority: ImportResultAuthority = Object.freeze({
    mount,
    open,
    onOpenChange,
    sourceItems: items,
    items: publishedItems,
    busy: publishedItems.some((item) => item.status === "uploading"),
    retry: retryAllFrom(publishedItems),
    ignored: Object.freeze({
      source: ignored,
      names: ignoredNames,
      text: ignoredImportText(ignoredNames),
    }),
    footer,
  });
  const publication = createImportResultPublication(
    authority,
    cells,
    requestPublicationSuccessor,
  );

  const {
    captureRoot,
    captureList,
    captureIgnored,
    captureRetry,
    rows,
    onOpen,
    onRetry,
    onNavigateCapture,
    onNavigate,
  } = publication;

  return (
    <Dialog open={authority.open} onOpenChange={authority.onOpenChange}>
      <DialogContent title={IMPORT_DIALOG_TITLE} description={IMPORT_DIALOG_DESCRIPTION}>
        <ImportResultPublicationBoundary publication={publication}>
          <div ref={captureRoot} data-testid="import-dialog">
          <ul ref={captureList} className="import-list" data-testid="import-list">
              {rows.map(({ authority: item, captureItem, captureOpen, captureRetry: captureRowRetry }) => (
                <li
                  ref={captureItem}
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
                      ref={captureOpen}
                      href={item.href}
                      className="import-open"
                      data-testid="import-open"
                      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => onOpen(item, event)}
                      onKeyDownCapture={(event: ReactKeyboardEvent<HTMLAnchorElement>) =>
                        onNavigateCapture(item, "open", event)
                      }
                      onKeyDown={(event: ReactKeyboardEvent<HTMLAnchorElement>) =>
                        onNavigate(item, "open", event)
                      }
                    >
                      Open
                    </Link>
                  )}
                  {item.retry && (
                    <button
                      ref={captureRowRetry}
                      type="button"
                      className="btn btn-sm btn-outline shrink-0"
                      disabled={authority.busy}
                      data-testid="import-row-retry"
                      onClick={(event: ReactMouseEvent<HTMLButtonElement>) => onRetry(item, event)}
                      onKeyDownCapture={(event: ReactKeyboardEvent<HTMLButtonElement>) =>
                        onNavigateCapture(item, "retry", event)
                      }
                      onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) =>
                        onNavigate(item, "retry", event)
                      }
                    >
                      Retry {item.name}
                    </button>
                  )}
                </li>
              ))}
          </ul>
            {authority.ignored.text && (
              <p
                ref={captureIgnored}
                className="mt-3 text-xs text-ink-3"
                data-testid="import-ignored"
              >
                {authority.ignored.text}
              </p>
            )}
          {authority.retry && (
              <button
                ref={captureRetry}
                type="button"
                className="btn btn-sm btn-outline mt-4"
                disabled={authority.busy}
                data-testid="import-retry"
                onClick={(event: ReactMouseEvent<HTMLButtonElement>) => onRetry(null, event)}
                onKeyDownCapture={(event: ReactKeyboardEvent<HTMLButtonElement>) =>
                  onNavigateCapture(null, "retry", event)
                }
                onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) =>
                  onNavigate(null, "retry", event)
                }
              >
                Retry failed
              </button>
            )}
          {authority.footer}
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
