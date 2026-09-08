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
) => void;

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

interface ImportResultActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
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
  readonly retiredActions: WeakSet<ImportResultActionPublication>;
  readonly claimedOpenPublications: WeakSet<ImportResultPublication>;
  readonly claimedRetryPublications: WeakSet<ImportResultPublication>;
  readonly claimedRows: WeakSet<ImportResultRowPublication>;
  readonly claimedControls: WeakSet<ImportResultControlPublication<HTMLElement>>;
  readonly claimedActions: WeakSet<ImportResultActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
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

  const createRuntime = (): ImportResultPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const list = listOwner.element();
    const dialog = root?.parentElement;
    const ignoredElement = ignoredOwner.element();
    const retryElement = retryOwner.element();
    const rootPlacement = root
      ? captureImportResultPlacement(root)
      : null;
    if (
      !root ||
      !list ||
      !(dialog instanceof HTMLDivElement) ||
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
      return Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        kind,
        rowIndex,
        element,
        action: Object.freeze({
          identity: Symbol(`import-result-${kind}-action`),
          publicationIdentity: identity,
          controlIdentity,
          kind,
          rowIndex,
        }),
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
      retry: retry && retryElement ? control("retry", null, retryElement) : null,
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
      cells.retiredPublications.add(publication);
      for (const row of publication.rows) {
        cells.retiredRows.add(row);
        if (row.open) {
          cells.retiredControls.add(row.open);
          cells.retiredActions.add(row.open.action);
        }
        if (row.retry) {
          cells.retiredControls.add(row.retry);
          cells.retiredActions.add(row.retry.action);
        }
      }
      if (publication.retry) {
        cells.retiredControls.add(publication.retry);
        cells.retiredActions.add(publication.retry.action);
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
    });
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

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureList: listOwner.capture,
    captureIgnored: ignoredOwner.capture,
    captureRetry: retryOwner.capture,
    rows: rowOwners,
    establish,
    onOpen,
    onRetry,
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
    retiredActions: new WeakSet<ImportResultActionPublication>(),
    claimedOpenPublications: new WeakSet<ImportResultPublication>(),
    claimedRetryPublications: new WeakSet<ImportResultPublication>(),
    claimedRows: new WeakSet<ImportResultRowPublication>(),
    claimedControls: new WeakSet<ImportResultControlPublication<HTMLElement>>(),
    claimedActions: new WeakSet<ImportResultActionPublication>(),
    claimedReactEvents: new WeakSet<object>(),
    claimedNativeEvents: new WeakSet<Event>(),
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

  const retryDispatch = useCallback<RetryRequest>((ownership, rowIndex, action) => {
    retryRequestRef.current?.(ownership, rowIndex, action);
  }, []);

  const requestRetry = useCallback<RetryRequest>(async (retryOwnership, rowIndex, action) => {
    const authority = authorityRef.current;
    if (
      !authority ||
      activeUploadRef.current ||
      retryOwnershipRef.current !== retryOwnership ||
      retryOwnership.authority !== authority ||
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

    try {
      const { documents: created, failed } = await uploadImportBatch(documents, ownership.images);
      if (!ownsUpload(ownership)) return;

      const failedAt = new Map(failed.map((failure) => [failure.index, failure.error]));
      const retained = new Map(retryOwnership.files);
      const outcomes = new Map<number, ImportItem>();
      let nextCreated = 0;
      for (let attemptIndex = 0; attemptIndex < rowIndexes.length; attemptIndex++) {
        const rowIndex = rowIndexes[attemptIndex];
        const file = documents[attemptIndex];
        const error = failedAt.get(attemptIndex);
        if (error !== undefined) {
          outcomes.set(rowIndex, { name: file.name, status: "error", warnings: [], error });
          continue;
        }
        const document = created[nextCreated++];
        if (document) {
          retained.delete(rowIndex);
          outcomes.set(rowIndex, {
            name: file.name,
            status: "done",
            id: document.id,
            title: document.title,
            warnings: document.warnings,
          });
        } else {
          outcomes.set(rowIndex, { name: file.name, status: "error", warnings: [], error: "Import failed" });
        }
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
      if (ownsUpload(ownership)) {
        optionsRef.current.onDone?.(result.documents, result.failed);
      }
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
      if (ownsUpload(ownership)) optionsRef.current.onError?.(message);
      const result = summarizeImportItems(publishedItems);
      if (ownsUpload(ownership)) {
        optionsRef.current.onDone?.(result.documents, result.failed);
      }
    } finally {
      if (ownsUpload(ownership)) activeUploadRef.current = null;
    }
  }, [ownsUpload, replaceItems, retryDispatch]);

  useLayoutEffect(() => {
    retryRequestRef.current = requestRetry;
    return () => {
      if (retryRequestRef.current === requestRetry) retryRequestRef.current = null;
    };
  }, [requestRetry]);

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
      const pendingItems = documents.map((f, i): ImportItem => {
        const error = failedAt.get(i);
        if (error !== undefined) {
          retained.set(i, f);
          return { name: f.name, status: "error", warnings: [], error };
        }
        const doc = created[next++];
        if (doc) return { name: f.name, status: "done", id: doc.id, title: doc.title, warnings: doc.warnings };
        retained.set(i, f);
        return { name: f.name, status: "error", warnings: [], error: "Import failed" };
      });
      const retryOwnership = retained.size
        ? createRetryOwnership(authority, generation, retained, images, retryDispatch)
        : null;
      const nextItems = publishRetryItems(pendingItems, retryOwnership, retryDispatch);
      if (!ownsUpload(ownership)) return;
      retryOwnershipRef.current = retryOwnership;
      replaceItems(nextItems);
      if (ownsUpload(ownership)) optionsRef.current.onDone?.(created, failed);
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
      if (ownsUpload(ownership)) optionsRef.current.onError?.(message);
      if (ownsUpload(ownership)) optionsRef.current.onDone?.([], []);
    } finally {
      if (ownsUpload(ownership)) activeUploadRef.current = null;
    }
  }, [ownsUpload, replaceItems, retryDispatch]);

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
