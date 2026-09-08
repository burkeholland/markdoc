"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ChevronDown, ChevronUp, Clock, Copy, GitCommit, History, Loader2, MoveVertical, Pencil, RotateCcw, Tag, Upload, X, Download } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, apiErrorText, type VersionSummary } from "@/lib/api";
import { collapseSegment, detectMoves, diffStats, hunkCounter, hunks, wordDiff, type Collapsed, type DiffSegment } from "@/editor/diff";
import { cn, formatDateTime, formatDayHeading, relativeTime } from "@/lib/utils";
import { setPendingNotice } from "@/lib/notice";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { useSessionValue } from "./use-session";

/** What the diff view shows: one version against the live text, or (with `base`) two versions. */
export interface VersionPreview {
  version: VersionSummary;
  content: string;
  /** The older side in compare mode; absent = compare against the current document. */
  base?: { version: VersionSummary; content: string };
  /** Versions in (base, version], newest first — whose authors are listed under the header. */
  range?: VersionSummary[];
}

export interface VersionsPanelProps {
  session: CollabSession;
  onClose: () => void;
  /** Called with the selected version(s) to show a diff in place of the editor (null = back to editing). */
  onPreview: (preview: VersionPreview | null) => void;
  refreshKey: number;
}

const KIND_LABEL: Record<VersionSummary["kind"], string> = {
  auto: "Autosaved",
  named: "Named version",
  publish: "Published",
  restore: "Restored",
  import: "Imported",
};

const KIND_TAG: Record<VersionSummary["kind"], string> = {
  auto: "Auto",
  named: "Named",
  publish: "Published",
  restore: "Restored",
  import: "Imported",
};

function KindIcon({ kind }: { kind: VersionSummary["kind"] }) {
  const cls = "shrink-0";
  switch (kind) {
    case "publish":
      return <Upload size={14} className={cn(cls, "text-accent")} />;
    case "named":
      return <Tag size={14} className={cn(cls, "text-violet-600")} />;
    case "restore":
      return <RotateCcw size={14} className={cn(cls, "text-warning")} />;
    case "import":
      return <Download size={14} className={cn(cls, "text-ink-3")} />;
    default:
      return <Clock size={14} className={cn(cls, "text-ink-4")} />;
  }
}

/**
 * Last list seen per document, shared by every panel mount. A re-open renders the rows from here in
 * the same frame and refreshes behind them; `prefetchVersions` fills it while the ⋯ menu is open so the
 * first open usually finds it warm too (task #487).
 */
const listCache = new Map<string, VersionSummary[]>();
const inflight = new Map<string, { owner: symbol; promise: Promise<VersionSummary[]> }>();

function fetchVersions(docId: string, options?: { fresh?: boolean; canCommit?: () => boolean }): Promise<VersionSummary[]> {
  const pending = inflight.get(docId);
  if (pending && !options?.fresh) return pending.promise;

  const owner = Symbol(docId);
  const promise = api.documents
    .versions(docId)
    .then((res) => {
      if (inflight.get(docId)?.owner === owner && (options?.canCommit?.() ?? true)) listCache.set(docId, res.versions);
      return res.versions;
    })
    .finally(() => {
      if (inflight.get(docId)?.owner === owner) inflight.delete(docId);
    });
  inflight.set(docId, { owner, promise });
  return promise;
}

/** Warm the version list for `docId` (no-op while a fetch is already running). Errors are left to the panel. */
export function prefetchVersions(docId: string): void {
  void fetchVersions(docId).catch(() => {});
}

export function VersionsPanel(props: VersionsPanelProps) {
  return <VersionsPanelForDocument key={props.session.docId} {...props} />;
}

type VersionMutationIntent =
  | { kind: "restore"; versionId: string }
  | { kind: "rename"; versionId: string; title: string }
  | { kind: "copy"; versionId: string };

type VersionsRouter = ReturnType<typeof useRouter>;

interface PanelAuthority {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly onClose: () => void;
  readonly onPreview: (preview: VersionPreview | null) => void;
  readonly router: VersionsRouter;
  readonly routerPush: VersionsRouter["push"];
}

interface VersionRowPublication {
  readonly index: number;
  readonly version: VersionSummary;
  readonly id: string;
  readonly number: number;
  readonly title: string | null;
  readonly kind: VersionSummary["kind"];
  readonly createdBy: string | null;
  readonly createdByName: string | null;
  readonly commitSha: string | null;
  readonly createdAt: string;
  readonly size: number;
}

interface VersionGroupPublication {
  readonly day: string;
  readonly rows: readonly VersionRowPublication[];
}

interface PreviewOperation {
  operationId: number;
  activation: PanelRenderPublication;
  authority: PanelAuthority;
  root: HTMLElement;
  versions: VersionSummary[] | null;
  rows: readonly VersionRowPublication[];
  compare: readonly string[];
  selected: string | null;
  busyVersionId: string | null;
}

type VersionMutationOwner = VersionMutationIntent & {
  operationId: number;
  authority: PanelAuthority;
  root: HTMLElement;
  row: VersionRowPublication;
  source: HTMLButtonElement | HTMLInputElement;
  control: "restore" | "renameInput" | "copy";
  phase: "request" | "reload";
};

interface ListOperation {
  operationId: number;
  authority: PanelAuthority;
  root: HTMLElement;
  refreshKey: number;
  retry: boolean;
  mutation: VersionMutationOwner | null;
}

interface PanelRenderPublication {
  readonly mount: symbol;
  readonly authority: PanelAuthority;
  readonly refreshKey: number;
  readonly versions: VersionSummary[] | null;
  readonly rows: readonly VersionRowPublication[];
  readonly groups: readonly VersionGroupPublication[];
  readonly error: string | null;
  readonly listError: string | null;
  readonly retry: ListOperation | null;
  readonly selected: string | null;
  readonly compare: readonly string[];
  readonly compareValues: readonly string[];
  readonly preview: PreviewOperation | null;
  readonly mutation: VersionMutationOwner | null;
  readonly mutationPhase: VersionMutationOwner["phase"] | null;
  readonly renaming: string | null;
  readonly draft: string;
  readonly canEdit: boolean;
  readonly revision: number;
}

interface VersionRowElements {
  item: HTMLDivElement | null;
  checkbox: HTMLInputElement | null;
  select: HTMLButtonElement | null;
  restore: HTMLButtonElement | null;
  startRename: HTMLButtonElement | null;
  renameInput: HTMLInputElement | null;
  copy: HTMLButtonElement | null;
}

type PanelControl = "close" | "retry" | "clear";
type RowControl = Exclude<keyof VersionRowElements, "item">;
type PanelEventKind = "click" | "checkbox-change" | "input-change" | "blur" | "keydown";
type PanelReactEvent =
  | MouseEvent<HTMLButtonElement | HTMLInputElement>
  | ChangeEvent<HTMLInputElement>
  | FocusEvent<HTMLInputElement>
  | KeyboardEvent<HTMLInputElement>;

interface PanelDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PanelDomSnapshot[];
}

interface PanelPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface PanelElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface PanelRefReplay {
  readonly owner: PanelElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
  handoffDetached: boolean;
}

interface PanelAction {
  readonly identity: symbol;
  readonly renderIdentity: symbol;
  readonly control: PanelControl | RowControl;
  readonly rowIndex: number | null;
  readonly eventKind: PanelEventKind;
}

interface PanelPublicationRuntime {
  readonly publication: PanelRenderPublication;
  readonly renderIdentity: symbol;
  readonly root: HTMLElement;
  readonly close: HTMLButtonElement;
  readonly retry: HTMLButtonElement | null;
  readonly clear: HTMLButtonElement | null;
  readonly groupLists: readonly HTMLUListElement[];
  readonly rows: readonly VersionRowElements[];
  readonly ownerDocument: Document;
  readonly dom: PanelDomSnapshot;
  readonly placement: PanelPlacement;
  readonly publish: (owners: readonly PanelElementOwnerView[]) => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly retireForAction: () => void;
  readonly retireForReplacement: () => void;
  readonly noteRef: (
    owner: PanelElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly stageSuccessorHandoff: () => boolean;
  readonly successorHandoffIsExact: () => boolean;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
}

interface PanelReplay {
  readonly source: PanelPublicationRuntime;
  readonly dom: PanelDomSnapshot;
  readonly placement: PanelPlacement;
  readonly historyIsClean: () => boolean;
  readonly refsAreExact: () => boolean;
  readonly release: () => void;
}

interface PanelControlledRestore {
  readonly input: HTMLInputElement;
  readonly attributes: readonly string[];
}

interface PanelPublicationCells {
  readonly active: { value: PanelPublicationRuntime | null };
  readonly successorOf: { value: PanelPublicationRuntime | null };
  readonly replay: { value: PanelReplay | null };
  readonly controlledRestore: { value: PanelControlledRestore | null };
  readonly retired: WeakSet<PanelRenderPublication>;
  readonly claimedPublications: WeakSet<PanelRenderPublication>;
  readonly claimedEvents: WeakSet<object>;
  readonly claimedActions: WeakSet<PanelAction>;
}

interface PanelPublicationSet {
  readonly publication: PanelRenderPublication;
  readonly captureRoot: (element: HTMLElement | null) => void;
  readonly capturePanel: Readonly<Record<PanelControl, (element: HTMLButtonElement | null) => void>>;
  readonly captureGroups: readonly ((element: HTMLUListElement | null) => void)[];
  readonly captureRows: readonly {
    readonly item: (element: HTMLDivElement | null) => void;
    readonly checkbox: (element: HTMLInputElement | null) => void;
    readonly select: (element: HTMLButtonElement | null) => void;
    readonly restore: (element: HTMLButtonElement | null) => void;
    readonly startRename: (element: HTMLButtonElement | null) => void;
    readonly renameInput: (element: HTMLInputElement | null) => void;
    readonly copy: (element: HTMLButtonElement | null) => void;
  }[];
  readonly root: () => HTMLElement | null;
  readonly establish: () => void | (() => void);
  readonly retire: () => boolean;
  readonly claimPanel: (
    control: PanelControl,
    event: MouseEvent<HTMLButtonElement>,
  ) => boolean;
  readonly claimRow: (
    row: VersionRowPublication,
    control: RowControl,
    event: PanelReactEvent,
  ) => boolean;
}

interface PanelDomGuard {
  readonly isClean: () => boolean;
  readonly stageHandoff: () => boolean;
  readonly release: () => void;
}

class PanelElementOwner<T extends HTMLElement> implements PanelElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: PanelElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.current;

  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

function snapshotVersion(version: VersionSummary, index: number): VersionRowPublication {
  return Object.freeze({
    index,
    version,
    id: version.id,
    number: version.number,
    title: version.title,
    kind: version.kind,
    createdBy: version.createdBy,
    createdByName: version.createdByName,
    commitSha: version.commitSha,
    createdAt: version.createdAt,
    size: version.size,
  });
}

function versionSnapshotIsCurrent(row: VersionRowPublication): boolean {
  const version = row.version;
  return (
    version.id === row.id &&
    version.number === row.number &&
    version.title === row.title &&
    version.kind === row.kind &&
    version.createdBy === row.createdBy &&
    version.createdByName === row.createdByName &&
    version.commitSha === row.commitSha &&
    version.createdAt === row.createdAt &&
    version.size === row.size
  );
}

function sameVersionPresentation(
  versions: VersionSummary[] | null,
  rows: readonly VersionRowPublication[],
  publication: PanelRenderPublication,
): boolean {
  if (
    publication.versions !== versions ||
    publication.rows.length !== rows.length ||
    (versions !== null && versions.length !== rows.length)
  ) {
    return false;
  }
  return rows.every((row, index) => {
    const current = publication.rows[index];
    return (
      versions?.[index] === row.version &&
      current.version === row.version &&
      current.index === row.index &&
      versionSnapshotIsCurrent(row)
    );
  });
}

function groupPublishedVersions(rows: readonly VersionRowPublication[]): VersionGroupPublication[] {
  const groups = new Map<string, VersionRowPublication[]>();
  for (const row of rows) {
    const day = formatDayHeading(row.createdAt);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(row);
  }
  return Array.from(groups, ([day, groupedRows]) =>
    Object.freeze({ day, rows: Object.freeze(groupedRows) }),
  );
}

function isOwnerInput(element: HTMLElement): element is HTMLInputElement {
  const Input = element.ownerDocument.defaultView?.HTMLInputElement;
  return Boolean(Input && element instanceof Input);
}

function collectInteractiveElements(root: HTMLElement): Array<HTMLButtonElement | HTMLInputElement> {
  const elements: Array<HTMLButtonElement | HTMLInputElement> = [];
  const ownerWindow = root.ownerDocument.defaultView;
  if (!ownerWindow) return elements;
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (
        child instanceof ownerWindow.HTMLButtonElement ||
        child instanceof ownerWindow.HTMLInputElement
      ) {
        elements.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return elements;
}

function rowForId(publication: PanelRenderPublication, id: string): VersionRowPublication | undefined {
  return publication.rows.find((row) => row.id === id);
}

function mutationMatchesPresentation(owner: VersionMutationOwner, publication: PanelRenderPublication): boolean {
  const row = publication.rows[owner.row.index];
  return (
    publication.authority === owner.authority &&
    row?.version === owner.row.version &&
    row.id === owner.row.id &&
    versionSnapshotIsCurrent(owner.row) &&
    (owner.kind === "copy" || publication.canEdit)
  );
}

function previewMatchesPresentation(owner: PreviewOperation, publication: PanelRenderPublication): boolean {
  return (
    publication.authority === owner.authority &&
    sameVersionPresentation(owner.versions, owner.rows, publication) &&
    publication.selected === owner.selected &&
    publication.compare === owner.compare
  );
}

function retryMatchesPresentation(owner: ListOperation, publication: PanelRenderPublication): boolean {
  return publication.authority === owner.authority && publication.refreshKey === owner.refreshKey && owner.retry;
}

function snapshotPanelAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotPanelDom(node: Node): PanelDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotPanelAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPanelDom)),
  });
}

function panelDomMatches(snapshot: PanelDomSnapshot, ownerDocument: Document): boolean {
  const { node } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
  const attributes = snapshotPanelAttributes(node);
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
        node.childNodes.item(index) === child.node &&
        panelDomMatches(child, ownerDocument),
    )
  );
}

function panelDomContains(snapshot: PanelDomSnapshot, target: Node): boolean {
  return (
    snapshot.node === target ||
    snapshot.children.some((child) => panelDomContains(child, target))
  );
}

function capturePanelPlacement(root: HTMLElement): PanelPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function panelPlacementMatches(root: HTMLElement, placement: PanelPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.parentNode === placement.parent &&
    root.previousSibling === placement.previousSibling &&
    root.nextSibling === placement.nextSibling
  );
}

function createPanelDomGuard(
  root: HTMLElement,
  placement: PanelPlacement,
  controlledRestore: PanelControlledRestore | null,
  allowInitialInputWrites: boolean,
): PanelDomGuard | null {
  const ownerWindow = placement.document.defaultView;
  if (!ownerWindow) return null;
  const MutationObserverConstructor = ownerWindow.MutationObserver;
  let changed = false;
  let pendingControlledRestore = controlledRestore;
  let initialInputWrites: ReadonlySet<HTMLInputElement> | null =
    allowInitialInputWrites
      ? new Set(root.querySelectorAll<HTMLInputElement>("input"))
      : null;
  let handoffInputs: ReadonlySet<HTMLInputElement> | null = null;
  let handoffWriteBatches = 0;
  const matchesInputWrites = (
    records: readonly MutationRecord[],
    input: HTMLInputElement,
    attributes: readonly string[],
    offset = 0,
  ) =>
    records.length >= offset + attributes.length &&
    attributes.every((attribute, index) => {
      const record = records[offset + index];
      return (
        record.type === "attributes" &&
        record.target === input &&
        record.attributeName === attribute &&
        record.oldValue ===
          (attribute === "name" && index === attributes.length - 1
            ? ""
            : input.getAttribute(attribute))
      );
    });
  const matchesInputWriteBatch = (
    records: readonly MutationRecord[],
    inputs: ReadonlySet<HTMLInputElement> | null,
  ) => {
    if (!inputs || records.length === 0) return false;
    let offset = 0;
    while (offset < records.length) {
      const input = records[offset].target;
      if (
        !(input instanceof ownerWindow.HTMLInputElement) ||
        !inputs.has(input)
      ) {
        return false;
      }
      const attributes =
        input.type === "checkbox"
          ? ["name", "type", "name"]
          : records[offset + 1]?.attributeName === "value"
            ? ["name", "value", "name"]
            : ["name", "name"];
      if (!matchesInputWrites(records, input, attributes, offset)) return false;
      offset += attributes.length;
    }
    return true;
  };
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    if (
      pendingControlledRestore &&
      records.length === pendingControlledRestore.attributes.length &&
      matchesInputWrites(
        records,
        pendingControlledRestore.input,
        pendingControlledRestore.attributes,
      )
    ) {
      pendingControlledRestore = null;
      return;
    }
    pendingControlledRestore = null;
    if (matchesInputWriteBatch(records, initialInputWrites)) {
      initialInputWrites = null;
      return;
    }
    initialInputWrites = null;
    if (
      handoffWriteBatches < 2 &&
      matchesInputWriteBatch(records, handoffInputs)
    ) {
      handoffWriteBatches += 1;
      return;
    }
    handoffInputs = null;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList" || record.target !== placement.parent) {
        return false;
      }
      if (record.previousSibling === root || record.nextSibling === root) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node === root ||
          (node.nodeType === 1 && (node as Element).contains(root)),
      );
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      pendingControlledRestore = null;
      initialInputWrites = null;
      handoffInputs = null;
      return !changed;
    },
    stageHandoff: () => {
      recordChanges(observer.takeRecords());
      if (changed) return false;
      handoffInputs = new Set(root.querySelectorAll<HTMLInputElement>("input"));
      handoffWriteBatches = 0;
      return true;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function panelControlIsEnabled(control: HTMLButtonElement | HTMLInputElement): boolean {
  if (
    control.disabled ||
    control.matches(":disabled") ||
    control.getAttribute("aria-disabled")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let element: HTMLElement | null = control; element; element = element.parentElement) {
    if (
      element.hasAttribute("inert") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function panelAuthorityIsCurrent(authority: PanelAuthority): boolean {
  return (
    authority.session.docId === authority.documentId &&
    authority.session.role === authority.role &&
    authority.router.push === authority.routerPush
  );
}

function samePublishedRows(
  previous: readonly VersionRowPublication[],
  current: readonly VersionRowPublication[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((row, index) => {
      const candidate = current[index];
      return Boolean(
        candidate &&
          row.index === candidate.index &&
          row.version === candidate.version &&
          row.id === candidate.id &&
          row.number === candidate.number &&
          row.title === candidate.title &&
          row.kind === candidate.kind &&
          row.createdBy === candidate.createdBy &&
          row.createdByName === candidate.createdByName &&
          row.commitSha === candidate.commitSha &&
          row.createdAt === candidate.createdAt &&
          row.size === candidate.size &&
          versionSnapshotIsCurrent(row) &&
          versionSnapshotIsCurrent(candidate),
      );
    })
  );
}

function samePublishedGroups(
  previous: readonly VersionGroupPublication[],
  current: readonly VersionGroupPublication[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((group, index) => {
      const candidate = current[index];
      return Boolean(
        candidate &&
          group.day === candidate.day &&
          samePublishedRows(group.rows, candidate.rows),
      );
    })
  );
}

function panelFactsAreCurrent(publication: PanelRenderPublication): boolean {
  const {
    authority,
    versions,
    rows,
    groups,
    compare,
    compareValues,
    preview,
    mutation,
    retry,
  } = publication;
  if (
    publication.mount !== authority.mount ||
    !panelAuthorityIsCurrent(authority) ||
    publication.canEdit !==
      (authority.role === "owner" || authority.role === "editor") ||
    compare.length !== compareValues.length ||
    compare.some((id, index) => id !== compareValues[index]) ||
    (versions?.length ?? 0) !== rows.length ||
    rows.some(
      (row, index) =>
        row.index !== index ||
        versions?.[index] !== row.version ||
        !versionSnapshotIsCurrent(row),
    ) ||
    groups.flatMap((group) => group.rows).length !== rows.length ||
    groups.some(
      (group) =>
        group.rows.length === 0 ||
        group.rows.some(
          (row) =>
            rows[row.index] !== row ||
            formatDayHeading(row.createdAt) !== group.day,
        ),
    ) ||
    !samePublishedGroups(
      groups,
      groupPublishedVersions([...rows]),
    ) ||
    (retry !== null && !retryMatchesPresentation(retry, publication)) ||
    (preview !== null && !previewMatchesPresentation(preview, publication)) ||
    (mutation !== null && !mutationMatchesPresentation(mutation, publication)) ||
    (mutation === null && publication.mutationPhase !== null)
  ) {
    return false;
  }
  return true;
}

function panelPublicationsMatch(
  previous: PanelRenderPublication,
  current: PanelRenderPublication,
): boolean {
  const before = previous.authority;
  const after = current.authority;
  return (
    before.mount === after.mount &&
    before.session === after.session &&
    before.documentId === after.documentId &&
    before.role === after.role &&
    before.onClose === after.onClose &&
    before.onPreview === after.onPreview &&
    before.router === after.router &&
    before.routerPush === after.routerPush &&
    previous.refreshKey === current.refreshKey &&
    previous.versions === current.versions &&
    samePublishedRows(previous.rows, current.rows) &&
    samePublishedGroups(previous.groups, current.groups) &&
    previous.error === current.error &&
    previous.listError === current.listError &&
    previous.retry === current.retry &&
    previous.selected === current.selected &&
    previous.compare === current.compare &&
    previous.compareValues.length === current.compareValues.length &&
    previous.compareValues.every(
      (id, index) => id === current.compareValues[index],
    ) &&
    previous.preview === current.preview &&
    previous.mutation === current.mutation &&
    previous.mutationPhase === current.mutationPhase &&
    previous.renaming === current.renaming &&
    previous.draft === current.draft &&
    previous.canEdit === current.canEdit &&
    panelFactsAreCurrent(previous) &&
    panelFactsAreCurrent(current)
  );
}

function panelExactDomIsCurrent(
  runtime: PanelPublicationRuntime,
  pendingInput: HTMLInputElement | null = null,
): boolean {
  const publication = runtime.publication;
  const {
    root,
    close,
    retry,
    clear,
    groupLists,
    rows: elementsByRow,
    ownerDocument,
  } = runtime;
  const ownerWindow = ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !root.isConnected ||
    root.ownerDocument !== ownerDocument ||
    root.tagName !== "ASIDE" ||
    root.dataset.testid !== "versions-panel" ||
    !close.isConnected ||
    close.ownerDocument !== ownerDocument ||
    close.tagName !== "BUTTON" ||
    close.type !== "button" ||
    !panelControlIsEnabled(close) ||
    close.getAttribute("aria-label") !== "Close version history"
  ) {
    return false;
  }

  const header = root.firstElementChild;
  const body = root.children.item(1);
  if (
    root.children.length !== 2 ||
    header?.parentElement !== root ||
    body?.parentElement !== root ||
    header.children.length !== 2 ||
    header.lastElementChild !== close ||
    close.parentElement !== header
  ) {
    return false;
  }

  const expected = new Set<HTMLButtonElement | HTMLInputElement>([close]);
  if (publication.listError) {
    const alert = retry?.parentElement;
    if (
      !retry ||
      !retry.isConnected ||
      retry.ownerDocument !== ownerDocument ||
      retry.type !== "button" ||
      retry.disabled !== (publication.retry !== null) ||
      (publication.retry === null && !panelControlIsEnabled(retry)) ||
      alert?.getAttribute("role") !== "alert" ||
      alert.parentElement !== body
    ) {
      return false;
    }
    expected.add(retry);
  } else if (retry !== null) {
    return false;
  }
  if (publication.compare.length > 0) {
    const hint = clear?.parentElement;
    if (
      !clear ||
      !clear.isConnected ||
      clear.ownerDocument !== ownerDocument ||
      clear.type !== "button" ||
      !panelControlIsEnabled(clear) ||
      hint?.getAttribute("data-testid") !== "compare-hint" ||
      hint.parentElement !== body ||
      hint.lastElementChild !== clear
    ) {
      return false;
    }
    expected.add(clear);
  } else if (clear !== null) {
    return false;
  }

  if (
    groupLists.length !== publication.groups.length ||
    elementsByRow.length !== publication.rows.length
  ) {
    return false;
  }
  for (let groupIndex = 0; groupIndex < publication.groups.length; groupIndex++) {
    const group = publication.groups[groupIndex];
    const list = groupLists[groupIndex];
    if (
      !list ||
      !list.isConnected ||
      list.ownerDocument !== ownerDocument ||
      list.tagName !== "UL" ||
      list.parentElement?.parentElement !== body ||
      list.children.length !== group.rows.length
    ) {
      return false;
    }
    const previousList = groupLists[groupIndex - 1];
    if (
      previousList &&
      !(previousList.compareDocumentPosition(list) &
        ownerWindow.Node.DOCUMENT_POSITION_FOLLOWING)
    ) {
      return false;
    }
    for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex++) {
      const row = group.rows[rowIndex];
      const elements = elementsByRow[row.index];
      const item = elements?.item;
      const checkbox = elements?.checkbox;
      const selectControl = elements?.select;
      const listItem = list.children.item(rowIndex);
      const rowTop = item?.firstElementChild;
      const checkboxLabel = checkbox?.parentElement;
      if (
        !versionSnapshotIsCurrent(row) ||
        !(listItem instanceof ownerWindow.HTMLLIElement) ||
        !item?.isConnected ||
        !checkbox?.isConnected ||
        !selectControl?.isConnected ||
        item.ownerDocument !== ownerDocument ||
        checkbox.ownerDocument !== ownerDocument ||
        selectControl.ownerDocument !== ownerDocument ||
        listItem.children.length !== 1 ||
        listItem.firstElementChild !== item ||
        item.parentElement !== listItem ||
        item.dataset.testid !== "version-item" ||
        item.dataset.versionKind !== row.kind ||
        item.dataset.versionNumber !== String(row.number) ||
        rowTop?.parentElement !== item ||
        rowTop.children.length !== 2 ||
        rowTop.children.item(0) !== checkboxLabel ||
        rowTop.children.item(1) !== selectControl ||
        checkboxLabel?.parentElement !== rowTop ||
        checkboxLabel.children.length !== 1 ||
        checkbox.parentElement !== checkboxLabel ||
        checkbox.type !== "checkbox" ||
        (checkbox === pendingInput
          ? checkbox.checked === publication.compare.includes(row.id)
          : checkbox.checked !== publication.compare.includes(row.id)) ||
        checkbox.getAttribute("aria-label") !== `Compare v${row.number}` ||
        !panelControlIsEnabled(checkbox) ||
        selectControl.parentElement !== rowTop ||
        selectControl.type !== "button" ||
        !panelControlIsEnabled(selectControl)
      ) {
        return false;
      }
      expected.add(checkbox);
      expected.add(selectControl);

      const isSelected = publication.selected === row.id;
      const actionContainer = item.children.item(1);
      if (!isSelected) {
        if (
          elements.restore !== null ||
          elements.startRename !== null ||
          elements.copy !== null ||
          actionContainer !== null
        ) {
          return false;
        }
      } else {
        if (!actionContainer?.isConnected || actionContainer.parentElement !== item) {
          return false;
        }
        const actionControls = publication.canEdit
          ? [elements.restore, elements.startRename, elements.copy]
          : [elements.copy];
        if (
          actionControls.some(
            (element) =>
              !element?.isConnected ||
              element.ownerDocument !== ownerDocument ||
              element.parentElement !== actionContainer,
          ) ||
          actionContainer.children.length !== actionControls.length ||
          actionControls.some(
            (element, index) => actionContainer.children.item(index) !== element,
          )
        ) {
          return false;
        }
        for (const element of actionControls) {
          const shouldBeEnabled = publication.mutation === null;
          if (
            !element ||
            element.disabled === shouldBeEnabled ||
            (shouldBeEnabled && !panelControlIsEnabled(element))
          ) {
            return false;
          }
          expected.add(element);
        }
        if (
          !publication.canEdit &&
          (elements.restore !== null || elements.startRename !== null)
        ) {
          return false;
        }
      }

      if (publication.renaming === row.id) {
        if (
          !elements.renameInput?.isConnected ||
          elements.renameInput.ownerDocument !== ownerDocument ||
          !selectControl.contains(elements.renameInput) ||
          (elements.renameInput !== pendingInput &&
            elements.renameInput.value !== publication.draft) ||
          elements.renameInput.disabled !== (publication.mutation !== null) ||
          (publication.mutation === null &&
            !panelControlIsEnabled(elements.renameInput))
        ) {
          return false;
        }
        expected.add(elements.renameInput);
      } else if (elements.renameInput !== null) {
        return false;
      }
    }
  }

  const actual = collectInteractiveElements(root);
  return (
    actual.length === expected.size &&
    actual.every((element) => expected.has(element))
  );
}

function panelPublicationIsCurrent(
  cells: PanelPublicationCells,
  candidate: PanelRenderPublication,
  allowClaimed = false,
  pendingInput: HTMLInputElement | null = null,
): PanelPublicationRuntime | null {
  const runtime = cells.active.value;
  if (
    !runtime ||
    runtime.publication !== candidate ||
    runtime.isRetired() ||
    cells.retired.has(candidate) ||
    (!allowClaimed && cells.claimedPublications.has(candidate)) ||
    !panelFactsAreCurrent(candidate) ||
    !panelExactDomIsCurrent(runtime, pendingInput) ||
    !runtime.publishedDomMatches()
  ) {
    return null;
  }
  return runtime;
}

function nativePanelEvent(
  runtime: PanelPublicationRuntime,
  source: HTMLButtonElement | HTMLInputElement,
  event: PanelReactEvent,
  kind: PanelEventKind,
): globalThis.Event | null {
  if (!event || typeof event !== "object") return null;
  const ownerWindow = runtime.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  const reactEvent = event as PanelReactEvent & {
    _reactName?: unknown;
    isDefaultPrevented?: unknown;
    isPropagationStopped?: unknown;
    persist?: unknown;
  };
  const expectedReactName =
    kind === "click"
      ? "onClick"
      : kind === "blur"
        ? "onBlur"
        : kind === "keydown"
          ? "onKeyDown"
          : "onChange";
  const expectedReactType =
    kind === "click"
      ? "click"
      : kind === "blur"
        ? "blur"
        : kind === "keydown"
          ? "keydown"
          : "change";
  if (
    !ownerWindow ||
    !(nativeEvent instanceof ownerWindow.Event) ||
    nativeEvent.eventPhase === ownerWindow.Event.NONE ||
    event.type !== expectedReactType ||
    reactEvent._reactName !== expectedReactName ||
    typeof reactEvent.isDefaultPrevented !== "function" ||
    reactEvent.isDefaultPrevented() ||
    typeof reactEvent.isPropagationStopped !== "function" ||
    reactEvent.isPropagationStopped() ||
    typeof reactEvent.persist !== "function" ||
    event.defaultPrevented ||
    nativeEvent.defaultPrevented ||
    event.currentTarget !== source ||
    target !== nativeEvent.target ||
    !(target instanceof ownerWindow.Node) ||
    target.ownerDocument !== runtime.ownerDocument ||
    !nativeEvent.composedPath().includes(source) ||
    !nativeEvent.composedPath().includes(runtime.root) ||
    !panelDomContains(runtime.dom, target)
  ) {
    return null;
  }
  if (kind === "click") {
    if (
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      !nativeEvent.bubbles ||
      !event.bubbles ||
      (event as MouseEvent<HTMLElement>).button !== 0 ||
      !source.contains(target)
    ) {
      return null;
    }
  } else if (kind === "checkbox-change") {
    if (
      target !== source ||
      (!(nativeEvent instanceof ownerWindow.MouseEvent) ||
        nativeEvent.type !== "click" ||
        nativeEvent.button !== 0 ||
        !nativeEvent.bubbles)
    ) {
      return null;
    }
  } else if (kind === "input-change") {
    const InputEventConstructor = ownerWindow.InputEvent;
    const isInput =
      InputEventConstructor &&
      nativeEvent instanceof InputEventConstructor &&
      nativeEvent.type === "input";
    if (
      target !== source ||
      (!isInput && nativeEvent.type !== "change")
    ) {
      return null;
    }
  } else if (kind === "blur") {
    if (
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      (nativeEvent.type !== "focusout" && nativeEvent.type !== "blur") ||
      target !== source
    ) {
      return null;
    }
  } else {
    const keyboardEvent = event as KeyboardEvent<HTMLInputElement>;
    if (
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      nativeEvent.type !== "keydown" ||
      target !== source ||
      nativeEvent.key !== keyboardEvent.key
    ) {
      return null;
    }
  }
  return nativeEvent;
}

function createPanelPublicationSet(
  publication: PanelRenderPublication,
  cells: PanelPublicationCells,
  requestSuccessor: () => void,
): PanelPublicationSet {
  const renderIdentity = Symbol("versions-panel-render");
  let currentRuntime: PanelPublicationRuntime | null = null;
  let lastRuntime: PanelPublicationRuntime | null = null;
  let successorRequested = false;
  let renderRetired = false;
  let invalidBeforeEstablish = false;

  const acceptsSuccessorOf = (runtime: PanelPublicationRuntime) =>
    cells.active.value === null &&
    cells.successorOf.value === runtime &&
    cells.retired.has(runtime.publication) &&
    runtime.isRetired() &&
    !cells.claimedPublications.has(runtime.publication);

  const requestReplaySuccessor = (runtime: PanelPublicationRuntime) => {
    if (
      successorRequested ||
      cells.replay.value !== null ||
      !acceptsSuccessorOf(runtime) ||
      !panelFactsAreCurrent(publication) ||
      !panelExactDomIsCurrent(runtime) ||
      !runtime.publishedDomMatches() ||
      !runtime.stageSuccessorHandoff()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay.value = Object.freeze({
      source: runtime,
      dom: runtime.dom,
      placement: runtime.placement,
      historyIsClean: runtime.mutationHistoryIsClean,
      refsAreExact: runtime.successorHandoffIsExact,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: PanelElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      if (currentRuntime) currentRuntime.retireForElement();
      else if (!lastRuntime) {
        renderRetired = true;
        invalidBeforeEstablish = true;
        cells.retired.add(publication);
      }
    }
    if (runtime?.isExactElementReplay() && acceptsSuccessorOf(runtime)) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new PanelElementOwner<HTMLElement>(onElementChange);
  const panelOwners = {
    close: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    retry: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    clear: new PanelElementOwner<HTMLButtonElement>(onElementChange),
  };
  const groupOwners = publication.groups.map(
    () => new PanelElementOwner<HTMLUListElement>(onElementChange),
  );
  const rowOwners = publication.rows.map(() => ({
    item: new PanelElementOwner<HTMLDivElement>(onElementChange),
    checkbox: new PanelElementOwner<HTMLInputElement>(onElementChange),
    select: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    restore: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    startRename: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    renameInput: new PanelElementOwner<HTMLInputElement>(onElementChange),
    copy: new PanelElementOwner<HTMLButtonElement>(onElementChange),
  }));

  const eventKindFor = (control: PanelControl | RowControl): PanelEventKind =>
    control === "checkbox"
      ? "checkbox-change"
      : control === "renameInput"
        ? "input-change"
        : "click";
  const action = (
    control: PanelControl | RowControl,
    rowIndex: number | null,
    eventKind = eventKindFor(control),
  ): PanelAction =>
    Object.freeze({
      identity: Symbol(`versions-panel-${control}-${eventKind}`),
      renderIdentity,
      control,
      rowIndex,
      eventKind,
    });
  const panelActions = {
    close: action("close", null),
    retry: publication.listError ? action("retry", null) : null,
    clear: publication.compare.length > 0 ? action("clear", null) : null,
  };
  const rowActions = publication.rows.map((row) => {
    const selected = publication.selected === row.id;
    return {
      item: null,
      checkbox: action("checkbox", row.index, "checkbox-change"),
      select: action("select", row.index),
      restore:
        selected && publication.canEdit ? action("restore", row.index) : null,
      startRename:
        selected && publication.canEdit ? action("startRename", row.index) : null,
      renameInput:
        publication.renaming === row.id
          ? {
              click: action("renameInput", row.index, "click"),
              change: action("renameInput", row.index, "input-change"),
              blur: action("renameInput", row.index, "blur"),
              keydown: action("renameInput", row.index, "keydown"),
            }
          : null,
      copy: selected ? action("copy", row.index) : null,
    };
  });

  const expectedOwners = (): readonly PanelElementOwnerView[] => [
    rootOwner,
    panelOwners.close,
    ...(publication.listError ? [panelOwners.retry] : []),
    ...(publication.compare.length > 0 ? [panelOwners.clear] : []),
    ...groupOwners,
    ...publication.rows.flatMap((row) => {
      const owned = rowOwners[row.index];
      const selected = publication.selected === row.id;
      return [
        owned.item,
        owned.checkbox,
        owned.select,
        ...(selected && publication.canEdit
          ? [owned.restore, owned.startRename]
          : []),
        ...(selected ? [owned.copy] : []),
        ...(publication.renaming === row.id ? [owned.renameInput] : []),
      ];
    }),
  ];

  const committedElements = () => {
    const root = rootOwner.element();
    const close = panelOwners.close.element();
    const retry = panelOwners.retry.element();
    const clear = panelOwners.clear.element();
    const groupLists = groupOwners.map((owner) => owner.element());
    const rows = publication.rows.map((row) => {
      const owned = rowOwners[row.index];
      const elements: VersionRowElements = {
        item: owned.item.element(),
        checkbox: owned.checkbox.element(),
        select: owned.select.element(),
        restore: owned.restore.element(),
        startRename: owned.startRename.element(),
        renameInput: owned.renameInput.element(),
        copy: owned.copy.element(),
      };
      return elements;
    });
    if (
      !root ||
      !close ||
      Boolean(publication.listError) !== Boolean(retry) ||
      (publication.compare.length > 0) !== Boolean(clear) ||
      groupLists.some((list) => !list) ||
      rows.some((elements, index) => {
        const row = publication.rows[index];
        const selected = publication.selected === row.id;
        return (
          !elements.item ||
          !elements.checkbox ||
          !elements.select ||
          (selected && publication.canEdit) !== Boolean(elements.restore) ||
          (selected && publication.canEdit) !== Boolean(elements.startRename) ||
          selected !== Boolean(elements.copy) ||
          (publication.renaming === row.id) !== Boolean(elements.renameInput)
        );
      })
    ) {
      return null;
    }
    return {
      root,
      close,
      retry,
      clear,
      groupLists: groupLists as HTMLUListElement[],
      rows,
    };
  };

  const createRuntime = (
    elements: NonNullable<ReturnType<typeof committedElements>>,
    dom: PanelDomSnapshot,
    placement: PanelPlacement,
    replayOwners: ReadonlySet<PanelElementOwnerView>,
    allowInitialInputWrites: boolean,
  ): PanelPublicationRuntime => {
    type Retirement = "element" | "layout" | "action" | "replacement";
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let successorStaged = false;
    let replayRefs: PanelRefReplay[] = [];
    let domGuard: PanelDomGuard | null = null;

    const retire = (reason: Retirement) => {
      if (renderRetired) return false;
      renderRetired = true;
      retirement = reason;
      cells.retired.add(publication);
      if (cells.active.value === runtime) {
        cells.active.value = null;
        cells.successorOf.value = runtime;
      }
      if (currentRuntime === runtime) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.value?.source !== runtime) domGuard?.release();
      });
      return true;
    };
    const refsHaveNoReplay = () =>
      !invalidReplay &&
      replayRefs.every(
        (entry) =>
          !entry.detached &&
          !entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactMountedReplay = () =>
      !invalidReplay &&
      replayOwners.size > 0 &&
      replayRefs.every((entry) =>
        replayOwners.has(entry.owner)
          ? entry.detached &&
            entry.reattached &&
            entry.owner.element() === entry.element
          : !entry.detached &&
            !entry.reattached &&
            entry.owner.element() === entry.element,
      );
    const publishedDomMatches = () =>
      Boolean(
        domGuard &&
          domGuard.isClean() &&
          elements.root === dom.node &&
          elements.root.isConnected &&
          panelPlacementMatches(elements.root, placement) &&
          panelDomMatches(dom, elements.root.ownerDocument),
      );

    const runtime: PanelPublicationRuntime = Object.freeze({
      publication,
      renderIdentity,
      ...elements,
      groupLists: Object.freeze(elements.groupLists),
      rows: Object.freeze(elements.rows),
      ownerDocument: elements.root.ownerDocument,
      dom,
      placement,
      publish: (owners: readonly PanelElementOwnerView[]) => {
        if (renderRetired || established) return false;
        const controlledRestore =
          cells.controlledRestore.value &&
          elements.root.contains(cells.controlledRestore.value.input)
          ? cells.controlledRestore.value
          : null;
        cells.controlledRestore.value = null;
        domGuard = createPanelDomGuard(
          elements.root,
          placement,
          controlledRestore,
          allowInitialInputWrites,
        );
        if (!domGuard) return false;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish version history without every committed ref",
            );
          }
          return {
            owner,
            element,
            detached: false,
            reattached: false,
            handoffDetached: false,
          };
        });
        established = true;
        cells.active.value = runtime;
        cells.successorOf.value = null;
        cells.replay.value = null;
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      retireForAction: () => {
        retire("action");
      },
      retireForReplacement: () => {
        retire("replacement");
      },
      noteRef: (
        owner: PanelElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (successorStaged) {
          if (
            element === null &&
            previous === proof.element &&
            !proof.handoffDetached
          ) {
            proof.handoffDetached = true;
          } else if (element !== previous) {
            invalidReplay = true;
          }
          return;
        }
        if (element === null && previous === proof.element) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => renderRetired,
      publishedDomMatches,
      isExactElementReplay: () =>
        renderRetired &&
        retirement === "element" &&
        established &&
        ((layoutRetired && refsHaveExactReplay()) ||
          (!layoutRetired && refsHaveExactMountedReplay())) &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        renderRetired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        publishedDomMatches(),
      stageSuccessorHandoff: () => {
        if (successorStaged || !domGuard?.stageHandoff()) return false;
        successorStaged = true;
        return true;
      },
      successorHandoffIsExact: () =>
        successorStaged &&
        !invalidReplay &&
        replayRefs.every(
          (entry) => entry.handoffDetached && entry.owner.element() === null,
        ),
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release: () => {
        domGuard?.release();
      },
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        acceptsSuccessorOf(lastRuntime)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (renderRetired || invalidBeforeEstablish || !panelFactsAreCurrent(publication)) {
      return undefined;
    }
    const elements = committedElements();
    const placement = elements ? capturePanelPlacement(elements.root) : null;
    if (!elements || !placement) return undefined;
    const dom = snapshotPanelDom(elements.root);
    const replay = cells.replay.value;
    let allowInitialInputWrites = false;
    if (replay) {
      const sameGeneration = panelPublicationsMatch(
        replay.source.publication,
        publication,
      );
      const exactReplay =
        sameGeneration &&
        replay.source.isRetired() &&
        cells.retired.has(replay.source.publication) &&
        cells.successorOf.value === replay.source &&
        replay.refsAreExact() &&
        replay.historyIsClean() &&
        elements.root === replay.dom.node &&
        panelPlacementMatches(elements.root, replay.placement) &&
        panelDomMatches(replay.dom, elements.root.ownerDocument);
      cells.replay.value = null;
      replay.release();
      if (cells.successorOf.value === replay.source) {
        cells.successorOf.value = null;
      }
      if (sameGeneration && !exactReplay) {
        renderRetired = true;
        cells.retired.add(publication);
        return undefined;
      }
      allowInitialInputWrites = exactReplay;
    }

    const previous = cells.active.value;
    const transitionSource = cells.successorOf.value;
    if (previous && previous.publication !== publication) {
      previous.retireForReplacement();
    }
    const owners = expectedOwners();
    const replayOwners = new Set<PanelElementOwnerView>();
    if (transitionSource?.publication.mount === publication.mount) {
      for (const owner of owners) {
        const element = owner.element();
        if (element && !panelDomContains(transitionSource.dom, element)) {
          replayOwners.add(owner);
        }
      }
    }
    const runtime = createRuntime(
      elements,
      dom,
      placement,
      replayOwners,
      allowInitialInputWrites,
    );
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!panelExactDomIsCurrent(runtime) || !runtime.publish(owners)) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const actionForRow = (
    row: VersionRowPublication,
    control: RowControl,
    event: PanelReactEvent,
  ): PanelAction | null => {
    const actions = rowActions[row.index];
    if (!actions || publication.rows[row.index] !== row) return null;
    if (control !== "renameInput") return actions[control];
    const reactName = (
      event as PanelReactEvent & { _reactName?: unknown }
    )._reactName;
    return reactName === "onClick"
      ? actions.renameInput?.click ?? null
      : reactName === "onChange"
        ? actions.renameInput?.change ?? null
        : reactName === "onBlur"
          ? actions.renameInput?.blur ?? null
          : reactName === "onKeyDown"
            ? actions.renameInput?.keydown ?? null
            : null;
  };

  const claim = (
    selectedAction: PanelAction | null,
    source: HTMLButtonElement | HTMLInputElement | null,
    event: PanelReactEvent,
  ) => {
    const pendingInput =
      selectedAction?.eventKind === "checkbox-change" ||
      selectedAction?.eventKind === "input-change"
        ? source && isOwnerInput(source)
          ? source
          : null
        : null;
    const runtime = panelPublicationIsCurrent(
      cells,
      publication,
      false,
      pendingInput,
    );
    if (
      !runtime ||
      runtime.renderIdentity !== renderIdentity ||
      !selectedAction ||
      selectedAction.renderIdentity !== renderIdentity ||
      !source ||
      !source.isConnected ||
      !panelControlIsEnabled(source) ||
      cells.claimedPublications.has(publication) ||
      cells.claimedActions.has(selectedAction) ||
      cells.claimedEvents.has(event)
    ) {
      return false;
    }
    const nativeEvent = nativePanelEvent(
      runtime,
      source,
      event,
      selectedAction.eventKind,
    );
    if (!nativeEvent || cells.claimedEvents.has(nativeEvent)) return false;
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(selectedAction);
    cells.claimedEvents.add(event);
    cells.claimedEvents.add(nativeEvent);
    cells.controlledRestore.value =
      isOwnerInput(source) &&
      (selectedAction.eventKind === "checkbox-change" ||
        selectedAction.eventKind === "input-change")
        ? Object.freeze({
            input: source,
            attributes: Object.freeze(
              selectedAction.eventKind === "checkbox-change"
                ? ["name", "type", "name"]
                : ["name", "name"],
            ),
          })
        : null;
    return true;
  };

  const set: PanelPublicationSet = {
    publication,
    captureRoot: rootOwner.capture,
    capturePanel: Object.freeze({
      close: panelOwners.close.capture,
      retry: panelOwners.retry.capture,
      clear: panelOwners.clear.capture,
    }),
    captureGroups: Object.freeze(groupOwners.map((owner) => owner.capture)),
    captureRows: Object.freeze(
      rowOwners.map((owned) =>
        Object.freeze({
          item: owned.item.capture,
          checkbox: owned.checkbox.capture,
          select: owned.select.capture,
          restore: owned.restore.capture,
          startRename: owned.startRename.capture,
          renameInput: owned.renameInput.capture,
          copy: owned.copy.capture,
        }),
      ),
    ),
    root: rootOwner.element,
    establish,
    retire: () => {
      if (renderRetired) return false;
      if (currentRuntime) {
        currentRuntime.retireForAction();
        return true;
      }
      renderRetired = true;
      cells.retired.add(publication);
      return true;
    },
    claimPanel: (control, event) => {
      const runtime = cells.active.value;
      const source = event?.currentTarget;
      const expected =
        control === "close"
          ? runtime?.close
          : control === "retry"
            ? runtime?.retry
            : runtime?.clear;
      return source === expected && claim(panelActions[control], source, event);
    },
    claimRow: (row, control, event) => {
      const runtime = cells.active.value;
      const source = event?.currentTarget;
      const expected = runtime?.rows[row.index]?.[control] ?? null;
      return (
        source === expected &&
        claim(actionForRow(row, control, event), source, event)
      );
    },
  };
  return Object.freeze(set);
}

function VersionsPanelForDocument({ session, onClose, onPreview, refreshKey }: VersionsPanelProps) {
  const router = useRouter();
  const routerPush = router.push;
  const [mount] = useState(() => Symbol("versions-panel"));
  const [versions, setVersions] = useState<VersionSummary[] | null>(() => listCache.get(session.docId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retryState, setRetryState] = useState<ListOperation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [previewState, setPreviewState] = useState<PreviewOperation | null>(null);
  const [mutationState, setMutationState] = useState<VersionMutationOwner | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [publicationRevision, setPublicationRevision] = useState(0);
  const contentCache = useRef(new Map<string, string>());
  const contentRequests = useRef(new Map<string, Promise<string>>());
  const authorityRef = useRef<PanelAuthority | null>(null);
  const lastPublicationRef = useRef<PanelRenderPublication | null>(null);
  const lastRootRef = useRef<HTMLElement | null>(null);
  const [publicationCells] = useState<PanelPublicationCells>(() => ({
    active: { value: null },
    successorOf: { value: null },
    replay: { value: null },
    controlledRestore: { value: null },
    retired: new WeakSet<PanelRenderPublication>(),
    claimedPublications: new WeakSet<PanelRenderPublication>(),
    claimedEvents: new WeakSet<object>(),
    claimedActions: new WeakSet<PanelAction>(),
  }));
  const replayCleanup = useRef(0);
  useLayoutEffect(() => {
    replayCleanup.current += 1;
    return () => {
      replayCleanup.current += 1;
      const cleanup = replayCleanup.current;
      queueMicrotask(() => {
        if (replayCleanup.current !== cleanup) return;
        const replay = publicationCells.replay.value;
        if (!replay) return;
        publicationCells.replay.value = null;
        if (publicationCells.successorOf.value === replay.source) {
          publicationCells.successorOf.value = null;
        }
        replay.release();
      });
    };
  }, [publicationCells]);
  const listOperation = useRef<ListOperation | null>(null);
  const listSequence = useRef(0);
  const previewOperation = useRef<PreviewOperation | null>(null);
  const previewSequence = useRef(0);
  const mutationOperation = useRef(0);
  const mutationOwner = useRef<VersionMutationOwner | null>(null);
  const automaticLoadRef = useRef<{ authority: PanelAuthority; refreshKey: number } | null>(null);
  const documentId = session.docId;
  const role = session.role;
  const canEdit = role === "owner" || role === "editor";
  const authority = useMemo<PanelAuthority>(
    () => Object.freeze({
      mount,
      session,
      documentId,
      role,
      onClose,
      onPreview,
      router,
      routerPush,
    }),
    [documentId, mount, onClose, onPreview, role, router, routerPush, session],
  );
  const rows = (versions ?? []).map(snapshotVersion);
  const currentPreview =
    previewState &&
    previewMatchesPresentation(previewState, {
      mount,
      authority,
      refreshKey,
      versions,
      rows,
      groups: [],
      error,
      listError,
      retry: null,
      selected,
      compare,
      compareValues: compare,
      preview: previewState,
      mutation: null,
      mutationPhase: null,
      renaming,
      draft,
      canEdit,
      revision: publicationRevision,
    })
      ? previewState
      : null;
  const currentMutation =
    mutationState &&
    mutationMatchesPresentation(mutationState, {
      mount,
      authority,
      refreshKey,
      versions,
      rows,
      groups: [],
      error,
      listError,
      retry: null,
      selected,
      compare,
      compareValues: compare,
      preview: currentPreview,
      mutation: mutationState,
      mutationPhase: mutationState.phase,
      renaming,
      draft,
      canEdit,
      revision: publicationRevision,
    })
      ? mutationState
      : null;
  const currentRetry =
    retryState &&
    retryMatchesPresentation(retryState, {
      mount,
      authority,
      refreshKey,
      versions,
      rows,
      groups: [],
      error,
      listError,
      retry: retryState,
      selected,
      compare,
      compareValues: compare,
      preview: currentPreview,
      mutation: currentMutation,
      mutationPhase: currentMutation?.phase ?? null,
      renaming,
      draft,
      canEdit,
      revision: publicationRevision,
    })
      ? retryState
      : null;
  const mutationBusy = currentMutation !== null;
  const previewBusy = currentPreview?.busyVersionId ?? null;
  const retrying = currentRetry !== null;
  const publication: PanelRenderPublication = Object.freeze({
    mount,
    authority,
    refreshKey,
    versions,
    rows: Object.freeze(rows),
    groups: Object.freeze(groupPublishedVersions(rows)),
    error,
    listError,
    retry: currentRetry,
    selected,
    compare,
    compareValues: Object.freeze([...compare]),
    preview: currentPreview,
    mutation: currentMutation,
    mutationPhase: currentMutation?.phase ?? null,
    renaming,
    draft,
    canEdit,
    revision: publicationRevision,
  });
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const publicationSet = createPanelPublicationSet(
    publication,
    publicationCells,
    requestPublicationSuccessor,
  );
  const publicationDomIsCurrent = useCallback(
    (candidate: PanelRenderPublication, allowClaimed = false) =>
      panelPublicationIsCurrent(publicationCells, candidate, allowClaimed) !== null,
    [publicationCells],
  );
  const claimPanelControl = (
    candidate: PanelRenderPublication,
    control: PanelControl,
    event: MouseEvent<HTMLButtonElement>,
  ) =>
    candidate === publication &&
    publicationSet.claimPanel(control, event);
  const claimRowControl = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    control: RowControl,
    event: PanelReactEvent,
  ) =>
    candidate === publication &&
    publicationSet.claimRow(row, control, event);

  const currentPublicationFor = useCallback(
    (candidate: PanelAuthority, root: HTMLElement, allowClaimed = true) => {
      const runtime = publicationCells.active.value;
      const current = runtime?.publication;
      return current &&
        current.authority === candidate &&
        runtime.root === root &&
        panelPublicationIsCurrent(publicationCells, current, allowClaimed)
        ? current
        : null;
    },
    [publicationCells],
  );

  const ownsMutation = useCallback(
    (owner: VersionMutationOwner) => {
      const current = currentPublicationFor(owner.authority, owner.root);
      if (!current || mutationOwner.current !== owner) return false;
      if (owner.phase === "request" && owner.kind !== "rename") {
        const currentSource =
          publicationCells.active.value?.rows[owner.row.index]?.[owner.control];
        if (currentSource !== owner.source) return false;
      }
      return mutationMatchesPresentation(owner, current);
    },
    [currentPublicationFor, publicationCells],
  );

  const ownsListOperation = useCallback(
    (operation: ListOperation) => {
      if (
        listOperation.current !== operation ||
        operation.refreshKey !== refreshKey ||
        !currentPublicationFor(operation.authority, operation.root)
      ) {
        return false;
      }
      return !operation.mutation || ownsMutation(operation.mutation);
    },
    [currentPublicationFor, ownsMutation, refreshKey],
  );

  const load = useCallback(async (
    loadAuthority: PanelAuthority,
    loadRefreshKey: number,
    options?: { retry?: boolean; mutation?: VersionMutationOwner },
  ) => {
    const runtime = publicationCells.active.value;
    const current = runtime?.publication;
    if (
      !current ||
      current.authority !== loadAuthority ||
      !runtime?.root ||
      !publicationDomIsCurrent(current, true) ||
      (!options?.mutation && !options?.retry && mutationOwner.current !== null) ||
      (options?.mutation && !ownsMutation(options.mutation))
    ) {
      return false;
    }
    const operation: ListOperation = {
      operationId: ++listSequence.current,
      authority: loadAuthority,
      root: runtime.root,
      refreshKey: loadRefreshKey,
      retry: options?.retry === true,
      mutation: options?.mutation ?? null,
    };
    listOperation.current = operation;
    if (operation.retry) setRetryState(operation);
    const ownsRequest = () => ownsListOperation(operation);
    try {
      const list = await fetchVersions(loadAuthority.documentId, {
        fresh: Boolean(operation.mutation),
        canCommit: ownsRequest,
      });
      if (!ownsRequest()) return false;
      const currentPublication = publicationCells.active.value?.publication;
      if (currentPublication && currentPublication.versions !== list) {
        previewOperation.current = null;
        setPreviewState((candidate) => (candidate?.authority === loadAuthority ? null : candidate));
        if (mutationOwner.current && mutationOwner.current !== operation.mutation) {
          mutationOwner.current = null;
          setMutationState((candidate) => (candidate?.authority === loadAuthority ? null : candidate));
        }
      }
      setVersions(list);
      setListError(null);
      return true;
    } catch (e) {
      if (!ownsRequest()) return false;
      setListError(apiErrorText(e, "Failed to load versions"));
      return true;
    } finally {
      if (listOperation.current === operation && ownsListOperation(operation)) {
        listOperation.current = null;
        if (operation.retry) setRetryState((candidate) => (candidate === operation ? null : candidate));
      }
    }
  }, [ownsListOperation, ownsMutation, publicationCells, publicationDomIsCurrent]);

  useEffect(() => {
    const previous = automaticLoadRef.current;
    automaticLoadRef.current = { authority, refreshKey };
    const firstLoad = previous === null;
    const refreshChanged = previous !== null && previous.refreshKey !== refreshKey;
    const emptyAuthorityReplacement =
      previous !== null &&
      previous.authority !== authority &&
      versions === null;
    if (firstLoad || refreshChanged || emptyAuthorityReplacement) {
      void load(authority, refreshKey);
    }
  }, [authority, load, refreshKey, versions]);

  const contentOf = useCallback(
    async (contentAuthority: PanelAuthority, row: VersionRowPublication) => {
      const cached = contentCache.current.get(row.id);
      if (cached !== undefined) return cached;
      const pending = contentRequests.current.get(row.id);
      if (pending) return pending;

      const request = api.documents.version(contentAuthority.documentId, row.id).then((res) => {
        contentCache.current.set(row.id, res.version.content);
        return res.version.content;
      });
      contentRequests.current.set(row.id, request);
      void request.then(
        () => {
          if (contentRequests.current.get(row.id) === request) contentRequests.current.delete(row.id);
        },
        () => {
          if (contentRequests.current.get(row.id) === request) contentRequests.current.delete(row.id);
        },
      );
      return request;
    },
    [],
  );

  const ownsPreview = useCallback(
    (owner: PreviewOperation) => {
      const current = currentPublicationFor(owner.authority, owner.root);
      return (
        previewOperation.current === owner &&
        !!current &&
        (current === owner.activation || previewMatchesPresentation(owner, current))
      );
    },
    [currentPublicationFor],
  );

  /** Two ticked versions → old→new compare; otherwise fall back to the clicked row vs current, or nothing. */
  const showPreview = useCallback(
    async (
      candidate: PanelRenderPublication,
      compareIds: readonly string[],
      selectedId: string | null,
      pendingInput: HTMLInputElement | null = null,
    ) => {
      const runtime = panelPublicationIsCurrent(
        publicationCells,
        candidate,
        true,
        pendingInput,
      );
      if (!runtime) return;
      const picked = compareIds.map((id) => rowForId(candidate, id)).filter((row): row is VersionRowPublication => Boolean(row));
      const pair = picked.length === 2 ? [...picked].sort((a, b) => a.number - b.number) : null;
      const single = selectedId ? rowForId(candidate, selectedId) : undefined;
      const owner: PreviewOperation = {
        operationId: ++previewSequence.current,
        activation: candidate,
        authority: candidate.authority,
        root: runtime.root,
        versions: candidate.versions,
        rows: candidate.rows,
        compare: compareIds,
        selected: selectedId,
        busyVersionId: pair ? pair[1].id : single?.id ?? null,
      };
      previewOperation.current = owner;
      setPreviewState(owner);
      setError(null);
      try {
        if (pair) {
          const [older, newer] = pair;
          const [oldContent, newContent] = await Promise.all([
            contentOf(owner.authority, older),
            contentOf(owner.authority, newer),
          ]);
          if (!ownsPreview(owner)) return;
          const range = owner.rows
            .filter((row) => row.number > older.number && row.number <= newer.number)
            .map((row) => row.version);
          owner.authority.onPreview({
            version: newer.version,
            content: newContent,
            base: { version: older.version, content: oldContent },
            range,
          });
          return;
        }
        if (single) {
          const content = await contentOf(owner.authority, single);
          if (!ownsPreview(owner)) return;
          owner.authority.onPreview({ version: single.version, content });
          return;
        }
        if (ownsPreview(owner)) owner.authority.onPreview(null);
      } catch (e) {
        if (ownsPreview(owner)) setError(apiErrorText(e, "Failed to load version"));
      } finally {
        if (previewOperation.current === owner && ownsPreview(owner)) {
          previewOperation.current = null;
          setPreviewState((current) => (current === owner ? null : current));
        }
      }
    },
    [contentOf, ownsPreview, publicationCells],
  );

  const invalidatePreview = useCallback(() => {
    previewOperation.current = null;
    setPreviewState(null);
  }, []);

  const claimMutation = useCallback(
    (
      candidate: PanelRenderPublication,
      row: VersionRowPublication,
      intent: VersionMutationIntent,
      source: HTMLButtonElement | HTMLInputElement,
      control: "restore" | "renameInput" | "copy",
    ): VersionMutationOwner | null => {
      const runtime = panelPublicationIsCurrent(publicationCells, candidate, true);
      if (
        !runtime ||
        mutationOwner.current ||
        runtime.rows[row.index]?.[control] !== source ||
        !panelControlIsEnabled(source)
      ) {
        return null;
      }
      const owner: VersionMutationOwner = {
        ...intent,
        operationId: ++mutationOperation.current,
        authority: candidate.authority,
        root: runtime.root,
        row,
        source,
        control,
        phase: "request",
      };
      mutationOwner.current = owner;
      setMutationState(owner);
      setError(null);
      return owner;
    },
    [publicationCells],
  );

  const releaseMutation = useCallback((owner: VersionMutationOwner) => {
    if (mutationOwner.current !== owner || !ownsMutation(owner)) return;
    mutationOwner.current = null;
    setMutationState((current) => (current === owner ? null : current));
  }, [ownsMutation]);

  const invalidateMutation = useCallback(() => {
    mutationOwner.current = null;
    setMutationState(null);
  }, []);

  const select = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimRowControl(candidate, row, "select", event)) return;
    const next = candidate.selected === row.id ? null : row.id;
    const nextCompare = candidate.compare;
    setSelected(next);
    setPublicationRevision((current) => current + 1);
    void showPreview(candidate, nextCompare, next);
  };

  const toggleCompare = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "checkbox", event)) return;
    // Keep at most two ticked; ticking a third replaces the older tick.
    const next = candidate.compare.includes(row.id)
      ? candidate.compare.filter((id) => id !== row.id)
      : [...candidate.compare.slice(-1), row.id];
    setCompare(next);
    setPublicationRevision((current) => current + 1);
    void showPreview(candidate, next, candidate.selected, event.currentTarget);
  };

  const restore = async (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimRowControl(candidate, row, "restore", event)) return;
    setPublicationRevision((current) => current + 1);
    if (!window.confirm(`Restore version ${row.number}? The current text is saved as a version first.`)) return;
    const owner = claimMutation(
      candidate,
      row,
      { kind: "restore", versionId: row.id },
      event.currentTarget,
      "restore",
    );
    if (!owner) return;
    invalidatePreview();
    try {
      await api.documents.restoreVersion(owner.authority.documentId, owner.row.id);
      if (!ownsMutation(owner)) return;
      owner.phase = "reload";
      setSelected(null);
      setCompare([]);
      owner.authority.onPreview(null);
      await load(owner.authority, candidate.refreshKey, { mutation: owner });
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Restore failed"));
    } finally {
      releaseMutation(owner);
    }
  };

  const rename = async (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    source: HTMLInputElement,
  ) => {
    const title = candidate.draft.trim();
    setRenaming(null);
    setPublicationRevision((current) => current + 1);
    if (!title || title === row.title) return;
    const owner = claimMutation(
      candidate,
      row,
      { kind: "rename", versionId: row.id, title },
      source,
      "renameInput",
    );
    if (!owner) return;
    try {
      await api.documents.renameVersion(owner.authority.documentId, owner.row.id, title);
      if (!ownsMutation(owner)) return;
      owner.phase = "reload";
      await load(owner.authority, candidate.refreshKey, { mutation: owner });
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Rename failed"));
    } finally {
      releaseMutation(owner);
    }
  };

  const copyAsNew = async (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimRowControl(candidate, row, "copy", event)) return;
    setPublicationRevision((current) => current + 1);
    const owner = claimMutation(
      candidate,
      row,
      { kind: "copy", versionId: row.id },
      event.currentTarget,
      "copy",
    );
    if (!owner) return;
    try {
      const res = await api.documents.copyVersion(owner.authority.documentId, owner.row.id);
      if (!ownsMutation(owner)) return;
      setPendingNotice(`Created “${res.title}” from version ${owner.row.number}.`, "success");
      owner.authority.routerPush.call(owner.authority.router, `/d/${res.id}`);
    } catch (e) {
      if (ownsMutation(owner)) setError(apiErrorText(e, "Could not copy the version"));
    } finally {
      releaseMutation(owner);
    }
  };

  const close = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "close", event)) return;
    publicationSet.retire();
    listOperation.current = null;
    setRetryState(null);
    invalidatePreview();
    invalidateMutation();
    candidate.authority.onPreview(null);
    candidate.authority.onClose();
  };

  const retry = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "retry", event)) return;
    setPublicationRevision((current) => current + 1);
    void load(candidate.authority, candidate.refreshKey, { retry: true });
  };

  const clearComparison = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "clear", event)) return;
    const next: string[] = [];
    setCompare(next);
    setPublicationRevision((current) => current + 1);
    void showPreview(candidate, next, candidate.selected);
  };

  const startRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimRowControl(candidate, row, "startRename", event)) return;
    setDraft(row.title ?? "");
    setRenaming(row.id);
    setPublicationRevision((current) => current + 1);
  };

  const changeRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "renameInput", event)) return;
    setDraft(event.currentTarget.value);
    setPublicationRevision((current) => current + 1);
  };

  const blurRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: FocusEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "renameInput", event)) return;
    void rename(candidate, row, event.currentTarget);
  };

  const keyDownRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (!claimRowControl(candidate, row, "renameInput", event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void rename(candidate, row, event.currentTarget);
    } else {
      setRenaming(null);
      setPublicationRevision((current) => current + 1);
    }
  };

  const clickRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "renameInput", event)) return;
    setPublicationRevision((current) => current + 1);
    event.stopPropagation();
  };

  useLayoutEffect(() => {
    const previous = lastPublicationRef.current;
    const previousRoot = lastRootRef.current;
    const currentRoot = publicationSet.root();
    const authorityChanged = authorityRef.current !== publication.authority;
    const refreshChanged =
      previous?.authority === publication.authority &&
      previous.refreshKey !== publication.refreshKey;
    const listChanged =
      previous?.authority === publication.authority &&
      !sameVersionPresentation(previous.versions, previous.rows, publication);
    const rootChanged =
      previous?.authority === publication.authority &&
      previousRoot !== null &&
      previousRoot !== currentRoot;

    if (authorityChanged) {
      authorityRef.current = publication.authority;
      listOperation.current = null;
      previewOperation.current = null;
      mutationOwner.current = null;
      if (retryState?.authority !== publication.authority) setRetryState(null);
      if (previewState?.authority !== publication.authority) setPreviewState(null);
      if (mutationState?.authority !== publication.authority) setMutationState(null);
    } else {
      const pendingList = listOperation.current;
      if (pendingList && (pendingList.refreshKey !== publication.refreshKey || rootChanged)) {
        listOperation.current = null;
        setRetryState((candidate) => (candidate === pendingList ? null : candidate));
      }
      const pendingPreview = previewOperation.current;
      if (
        pendingPreview &&
        (refreshChanged ||
          listChanged ||
          rootChanged ||
          (pendingPreview.activation !== previous && !previewMatchesPresentation(pendingPreview, publication)))
      ) {
        previewOperation.current = null;
        setPreviewState((candidate) => (candidate === pendingPreview ? null : candidate));
      }
      const pendingMutation = mutationOwner.current;
      if (
        pendingMutation &&
        (refreshChanged || listChanged || rootChanged || !mutationMatchesPresentation(pendingMutation, publication))
      ) {
        mutationOwner.current = null;
        setMutationState((candidate) => (candidate === pendingMutation ? null : candidate));
      }
    }

    lastPublicationRef.current = publication;
    lastRootRef.current = currentRoot;
  }, [
    mutationState?.authority,
    previewState?.authority,
    publication,
    publicationSet,
    retryState?.authority,
  ]);
  useLayoutEffect(() => publicationSet.establish(), [publicationSet]);

  const { captureRoot, capturePanel, captureGroups, captureRows } = publicationSet;
  const {
    close: captureClose,
    retry: captureRetry,
    clear: captureClear,
  } = capturePanel;
  const compareHint =
    publication.compare.length === 1
      ? "Tick one more version to compare"
      : publication.compare.length === 2
        ? "Comparing two versions"
        : null;

  return (
    <aside
      ref={captureRoot}
      className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2"
      data-testid="versions-panel"
    >
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Version history</span>
        <button
          ref={captureClose}
          type="button"
          className="icon-btn h-8 w-8"
          onClick={(event) => close(publication, event)}
          aria-label="Close version history"
        >
          <X size={16} />
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {listError && (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
            <div>{listError}</div>
            <button
              ref={captureRetry}
              type="button"
              className="btn btn-outline btn-sm mt-2 gap-1.5"
              onClick={(event) => retry(publication, event)}
              disabled={retrying}
            >
              {retrying && <Loader2 size={13} className="animate-spin" />}
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">{error}</div>}
        {compareHint && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-accent-soft px-3 py-1.5 text-xs text-ink-2" data-testid="compare-hint">
            <span>{compareHint}</span>
            <button
              ref={captureClear}
              type="button"
              className="text-accent hover:underline"
              onClick={(event) => clearComparison(publication, event)}
            >
              Clear
            </button>
          </div>
        )}
        {versions === null && !listError ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : versions?.length === 0 ? (
          <EmptyState icon={<History size={28} />} title="No versions yet">
            Versions are captured automatically while you edit, and whenever you publish.
          </EmptyState>
        ) : versions ? (
          publication.groups.map((group, groupIndex) => (
            <div key={group.day} className="mb-4">
              <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-ink-4">{group.day}</div>
              <ul
                ref={captureGroups[groupIndex]}
                className="flex flex-col gap-1"
              >
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <div
                      ref={captureRows[row.index].item}
                      className={cn(
                        "group rounded-lg border px-2 py-2 transition-colors",
                        selected === row.id || compare.includes(row.id) ? "border-accent bg-surface shadow-sm" : "border-transparent hover:border-line hover:bg-surface",
                      )}
                      data-testid="version-item"
                      data-version-kind={row.kind}
                      data-version-number={row.number}
                    >
                      <div className="flex items-start gap-2">
                        <label
                          className="-mx-[5px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
                          title="Tick two versions to compare them"
                          data-testid="version-compare-target"
                        >
                          <input
                            ref={captureRows[row.index].checkbox}
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                            checked={compare.includes(row.id)}
                            onChange={(event) => toggleCompare(publication, row, event)}
                            aria-label={`Compare v${row.number}`}
                            title="Tick two versions to compare them"
                            data-testid="version-compare"
                          />
                        </label>
                        <button
                          ref={captureRows[row.index].select}
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          onClick={(event) => select(publication, row, event)}
                        >
                          <KindIcon kind={row.kind} />
                          <div className="min-w-0 flex-1">
                            {renaming === row.id ? (
                              <input
                                ref={captureRows[row.index].renameInput}
                                autoFocus
                                className="input h-7 text-[13px]"
                                value={draft}
                                placeholder={`Name version ${row.number}`}
                                onChange={(event) => changeRename(publication, row, event)}
                                onBlur={(event) => blurRename(publication, row, event)}
                                disabled={mutationBusy}
                                onKeyDown={(event) => keyDownRename(publication, row, event)}
                                onClick={(event) => clickRename(publication, row, event)}
                                data-testid="version-rename-input"
                              />
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[13px] font-medium text-ink">{row.title ?? KIND_LABEL[row.kind]}</span>
                                {row.title && (
                                  <span
                                    className="shrink-0 rounded border border-line px-1 text-[10px] font-medium uppercase tracking-wide text-ink-3"
                                    data-testid="version-kind"
                                  >
                                    {KIND_TAG[row.kind]}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
                              <span className="font-mono text-[11px] text-ink-4">v{row.number}</span>
                              <span title={formatDateTime(row.createdAt)}>· {relativeTime(row.createdAt)}</span>
                              {row.createdByName && <span>· {row.createdByName}</span>}
                              {row.commitSha && (
                                <span className="inline-flex items-center gap-0.5 font-mono text-[11px]" title={row.commitSha}>
                                  <GitCommit size={11} /> {row.commitSha.slice(0, 7)}
                                </span>
                              )}
                            </div>
                          </div>
                          {(previewBusy === row.id || currentMutation?.versionId === row.id) && <Loader2 size={14} className="mt-1 animate-spin text-ink-4" />}
                        </button>
                      </div>
                      {selected === row.id && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
                          {canEdit && (
                            <button
                              ref={captureRows[row.index].restore}
                              type="button"
                              className="btn btn-sm btn-primary gap-1.5"
                              onClick={(event) => void restore(publication, row, event)}
                              disabled={mutationBusy}
                              data-testid="version-restore"
                            >
                              <RotateCcw size={13} /> Restore
                            </button>
                          )}
                          {canEdit && (
                            <button
                              ref={captureRows[row.index].startRename}
                              type="button"
                              className="btn btn-sm btn-ghost gap-1.5"
                              onClick={(event) => startRename(publication, row, event)}
                              disabled={mutationBusy}
                              data-testid="version-rename"
                            >
                              <Pencil size={13} /> {row.title ? "Rename" : "Name"}
                            </button>
                          )}
                          <button
                            ref={captureRows[row.index].copy}
                            type="button"
                            className="btn btn-sm btn-ghost gap-1.5"
                            onClick={(event) => void copyAsNew(publication, row, event)}
                            disabled={mutationBusy}
                            title="Copy this version as a new document"
                            data-testid="version-copy"
                          >
                            <Copy size={13} /> Copy as new doc
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : null}
      </div>
    </aside>
  );
}

/** One rendered block of the diff: a hunk (all its segments) or a stretch of unchanged text between hunks. */
type Block = { hunk: number; segments: DiffSegment[] } | { gap: (DiffSegment | Collapsed)[] };

function buildBlocks(segments: DiffSegment[], hunkList: { start: number; end: number }[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  hunkList.forEach((h, n) => {
    if (i < h.start) blocks.push({ gap: segments.slice(i, h.start).flatMap((s, k) => collapseSegment(s, i + k === 0, false)) });
    blocks.push({ hunk: n, segments: segments.slice(h.start, h.end + 1) });
    i = h.end + 1;
  });
  if (i < segments.length) blocks.push({ gap: segments.slice(i).flatMap((s, k) => collapseSegment(s, i + k === 0, i + k === segments.length - 1)) });
  return blocks;
}

function Segment({ c }: { c: DiffSegment | Collapsed }) {
  if ("collapsed" in c) {
    return <span className="my-2 block rounded bg-surface-3 px-2 py-0.5 text-center text-xs text-ink-4">··· {c.collapsed} unchanged words ···</span>;
  }
  if (c.moved) {
    return (
      <span className="rounded-sm bg-surface-3 text-ink-2 outline-1 outline-dashed outline-line-2" title="Moved paragraph (unchanged text)" data-testid="diff-moved">
        <MoveVertical size={12} className="mr-1 inline-block align-[-1px] text-ink-3" aria-label="Moved" />
        {c.value}
      </span>
    );
  }
  if (c.added) return <ins>{c.value}</ins>;
  if (c.removed) return <del>{c.value}</del>;
  return <span>{c.value}</span>;
}

function versionLabel(v: VersionSummary) {
  return (
    <>
      <span className="font-medium text-ink">v{v.number}</span>
      {v.title && <span className="text-ink-2"> ‘{v.title}’</span>}
    </>
  );
}

function compactRange(numbers: number[]): string {
  if (numbers.length <= 4) return numbers.map((n) => `v${n}`).join(", ");
  return `v${numbers[0]}–v${numbers[numbers.length - 1]}`;
}

/** Read-only comparison of a past version against the live document, or of two versions (old → new). */
export function VersionDiffView({ session, preview }: { session: CollabSession; preview: VersionPreview }) {
  const { version, content, base, range } = preview;
  const current = useSessionValue(session, (s) => s.ytext.toString());
  const [swapped, setSwapped] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const oldSide = base ? (swapped ? { version, content } : base) : { version, content };
  const newSide = base ? (swapped ? base : { version, content }) : null;
  const oldText = oldSide.content;
  const newText = newSide ? newSide.content : current;

  const segments = useMemo(() => detectMoves(wordDiff(oldText, newText)), [oldText, newText]);
  const stats = useMemo(() => diffStats(segments), [segments]);
  const hunkList = useMemo(() => hunks(segments), [segments]);
  const blocks = useMemo(() => buildBlocks(segments, hunkList), [segments, hunkList]);
  const movedCount = useMemo(() => hunkList.filter((h) => h.kind === "moved").length, [hunkList]);

  useEffect(() => {
    setActive(0);
  }, [oldText, newText]);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const goTo = useCallback(
    (n: number) => {
      if (hunkList.length === 0) return;
      const next = Math.min(Math.max(n, 0), hunkList.length - 1);
      setActive(next);
      bodyRef.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`)?.scrollIntoView({ block: "center" });
    },
    [hunkList.length],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLElement && /^(input|textarea|button)$/i.test(e.target.tagName) && e.key !== "[" && e.key !== "]") return;
    if (e.key === "]") {
      e.preventDefault();
      goTo(active + 1);
    } else if (e.key === "[") {
      e.preventDefault();
      goTo(active - 1);
    }
  };

  const authors = useMemo(() => {
    const names = new Set<string>();
    for (const v of range ?? []) if (v.createdByName) names.add(v.createdByName);
    return Array.from(names);
  }, [range]);
  const rangeNumbers = useMemo(() => (range ?? []).map((v) => v.number).sort((a, b) => a - b), [range]);

  return (
    <div className="flex h-full min-h-0 flex-col outline-none" data-testid="version-diff" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-6 py-2">
        <span className="pane-label">Comparing</span>
        <span className="min-w-0 break-words text-sm text-ink-2" data-testid="diff-header">
          {newSide ? (
            <>
              {versionLabel(oldSide.version)} → {versionLabel(newSide.version)}{" "}
              <span className="text-ink-3">
                ({newSide.version.createdByName ?? "unknown"}, {relativeTime(newSide.version.createdAt)})
              </span>
            </>
          ) : (
            <>
              {versionLabel(version)} <span className="text-ink-3">({formatDateTime(version.createdAt)})</span> → current
            </>
          )}
        </span>
        {base && (
          <button type="button" className="btn btn-sm btn-ghost gap-1" onClick={() => setSwapped((s) => !s)} title="Swap old and new" data-testid="diff-swap">
            <ArrowLeftRight size={13} /> Swap
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-3 font-mono text-xs">
            <span className="text-success">+{stats.added} words</span>
            <span className="text-danger">−{stats.removed} words</span>
            {movedCount > 0 && <span className="text-ink-3">↕ {movedCount} moved</span>}
          </span>
          <span className="ml-2 flex items-center gap-1 rounded-md border border-line bg-surface text-xs text-ink-2">
            <button type="button" className="icon-btn h-7 w-7" onClick={() => goTo(active - 1)} disabled={active <= 0} aria-label="Previous change ([)" title="Previous change ([)" data-testid="diff-prev">
              <ChevronUp size={14} />
            </button>
            <span className="min-w-[7ch] text-center tabular-nums" data-testid="diff-counter">
              {hunkCounter(active, hunkList.length)}
            </span>
            <button
              type="button"
              className="icon-btn h-7 w-7"
              onClick={() => goTo(active + 1)}
              disabled={active >= hunkList.length - 1}
              aria-label="Next change (])"
              title="Next change (])"
              data-testid="diff-next"
            >
              <ChevronDown size={14} />
            </button>
          </span>
        </span>
        {newSide && rangeNumbers.length > 0 && (
          <div className="flex basis-full flex-wrap items-center gap-1.5 text-xs text-ink-3" data-testid="diff-authors">
            <span>
              {compactRange(rangeNumbers)} by{authors.length === 0 && " unknown"}
            </span>
            {authors.map((name) => (
              <span key={name} className="rounded-full border border-line bg-surface px-2 py-0.5 text-ink-2" data-testid="diff-author">
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto" ref={bodyRef}>
        <pre className="md-diff whitespace-pre-wrap break-words px-8 py-6 font-mono text-[14px] leading-7 text-ink-2">
          {blocks.map((b, i) =>
            "hunk" in b ? (
              <span
                key={i}
                data-hunk={b.hunk}
                data-testid={`diff-hunk-${b.hunk + 1}`}
                data-active={b.hunk === active ? "true" : undefined}
                className={cn("rounded-sm", b.hunk === active && "bg-accent-soft shadow-[0_2px_0_0_var(--color-accent)]")}
              >
                {b.segments.map((s, k) => (
                  <Segment key={k} c={s} />
                ))}
              </span>
            ) : (
              b.gap.map((s, k) => <Segment key={`${i}-${k}`} c={s} />)
            ),
          )}
        </pre>
      </div>
    </div>
  );
}
