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
  mount: symbol;
  session: CollabSession;
  documentId: string;
  role: CollabSession["role"];
  onClose: () => void;
  onPreview: (preview: VersionPreview | null) => void;
  router: VersionsRouter;
  routerPush: VersionsRouter["push"];
}

interface VersionRowPublication {
  index: number;
  version: VersionSummary;
  id: string;
  number: number;
  title: string | null;
  kind: VersionSummary["kind"];
  createdBy: string | null;
  createdByName: string | null;
  commitSha: string | null;
  createdAt: string;
  size: number;
}

interface VersionGroupPublication {
  day: string;
  rows: VersionRowPublication[];
}

interface PreviewOperation {
  operationId: number;
  activation: PanelRenderPublication;
  authority: PanelAuthority;
  root: HTMLElement;
  versions: VersionSummary[] | null;
  rows: VersionRowPublication[];
  compare: string[];
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
  mount: symbol;
  authority: PanelAuthority;
  refreshKey: number;
  versions: VersionSummary[] | null;
  rows: VersionRowPublication[];
  groups: VersionGroupPublication[];
  error: string | null;
  listError: string | null;
  retry: ListOperation | null;
  selected: string | null;
  compare: string[];
  compareValues: string[];
  preview: PreviewOperation | null;
  mutation: VersionMutationOwner | null;
  renaming: string | null;
  draft: string;
  canEdit: boolean;
  revision: number;
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

interface PanelPublicationRuntime {
  active: boolean;
  root: HTMLElement | null;
  close: HTMLButtonElement | null;
  retry: HTMLButtonElement | null;
  clear: HTMLButtonElement | null;
  groupLists: Array<HTMLUListElement | null>;
  rows: VersionRowElements[];
}

type PanelControl = "close" | "retry" | "clear";
type RowControl = Exclude<keyof VersionRowElements, "item">;

function snapshotVersion(version: VersionSummary, index: number): VersionRowPublication {
  return {
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
  };
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
  rows: VersionRowPublication[],
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

function groupPublishedVersions(rows: VersionRowPublication[]): VersionGroupPublication[] {
  const groups = new Map<string, VersionRowPublication[]>();
  for (const row of rows) {
    const day = formatDayHeading(row.createdAt);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day)!.push(row);
  }
  return Array.from(groups, ([day, groupedRows]) => ({ day, rows: groupedRows }));
}

function collectInteractiveElements(root: HTMLElement): Array<HTMLButtonElement | HTMLInputElement> {
  const elements: Array<HTMLButtonElement | HTMLInputElement> = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (child instanceof HTMLButtonElement || child instanceof HTMLInputElement) elements.push(child);
      visit(child);
    }
  };
  visit(root);
  return elements;
}

function emptyRowElements(): VersionRowElements {
  return {
    item: null,
    checkbox: null,
    select: null,
    restore: null,
    startRename: null,
    renameInput: null,
    copy: null,
  };
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
  const activePublicationRef = useRef<PanelRenderPublication | null>(null);
  const lastPublicationRef = useRef<PanelRenderPublication | null>(null);
  const publicationRuntimesRef = useRef(new WeakMap<PanelRenderPublication, PanelPublicationRuntime>());
  const claimedPublicationsRef = useRef(new WeakSet<PanelRenderPublication>());
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
    () => ({
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
  // Equal-looking renders are separate authorities so retained handlers cannot cross a commit boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const publication: PanelRenderPublication = {
    mount,
    authority,
    refreshKey,
    versions,
    rows,
    groups: groupPublishedVersions(rows),
    error,
    listError,
    retry: currentRetry,
    selected,
    compare,
    compareValues: [...compare],
    preview: currentPreview,
    mutation: currentMutation,
    renaming,
    draft,
    canEdit,
    revision: publicationRevision,
  };

  const runtimeFor = useCallback((candidate: PanelRenderPublication) => {
    const runtimes = publicationRuntimesRef.current;
    let runtime = runtimes.get(candidate);
    if (!runtime) {
      runtime = {
        active: false,
        root: null,
        close: null,
        retry: null,
        clear: null,
        groupLists: candidate.groups.map(() => null),
        rows: candidate.rows.map(() => emptyRowElements()),
      };
      runtimes.set(candidate, runtime);
    }
    return runtime;
  }, []);

  const retirePublication = useCallback((candidate: PanelRenderPublication) => {
    const runtime = publicationRuntimesRef.current.get(candidate);
    if (runtime) runtime.active = false;
    if (activePublicationRef.current === candidate) activePublicationRef.current = null;
  }, []);

  const bindPanelControl = useCallback(
    (candidate: PanelRenderPublication, control: PanelControl, element: HTMLButtonElement | null) => {
      const runtime = runtimeFor(candidate);
      runtime[control] = element;
      if (!element) retirePublication(candidate);
    },
    [retirePublication, runtimeFor],
  );

  const bindRoot = useCallback(
    (candidate: PanelRenderPublication, element: HTMLElement | null) => {
      const runtime = runtimeFor(candidate);
      runtime.root = element;
      if (!element) retirePublication(candidate);
    },
    [retirePublication, runtimeFor],
  );

  const bindGroupList = useCallback(
    (candidate: PanelRenderPublication, index: number, element: HTMLUListElement | null) => {
      const runtime = runtimeFor(candidate);
      runtime.groupLists[index] = element;
      if (!element) retirePublication(candidate);
    },
    [retirePublication, runtimeFor],
  );

  const bindRowElement = useCallback(
    <K extends keyof VersionRowElements>(
      candidate: PanelRenderPublication,
      row: VersionRowPublication,
      control: K,
      element: VersionRowElements[K],
    ) => {
      const runtime = runtimeFor(candidate);
      runtime.rows[row.index][control] = element;
      if (!element) retirePublication(candidate);
    },
    [retirePublication, runtimeFor],
  );

  const authorityIsCurrent = useCallback((candidate: PanelAuthority) => {
    return (
      authorityRef.current === candidate &&
      candidate.mount === mount &&
      candidate.session.docId === candidate.documentId &&
      candidate.session.role === candidate.role &&
      candidate.router.push === candidate.routerPush
    );
  }, [mount]);

  const publicationDomIsCurrent = useCallback(
    (candidate: PanelRenderPublication, allowClaimed = false) => {
      if (
        activePublicationRef.current !== candidate ||
        candidate.mount !== mount ||
        !authorityIsCurrent(candidate.authority) ||
        (!allowClaimed && claimedPublicationsRef.current.has(candidate))
      ) {
        return false;
      }
      if (
        candidate.compare.length !== candidate.compareValues.length ||
        candidate.compare.some((id, index) => id !== candidate.compareValues[index]) ||
        !sameVersionPresentation(candidate.versions, candidate.rows, candidate)
      ) {
        return false;
      }

      const runtime = publicationRuntimesRef.current.get(candidate);
      const root = runtime?.root;
      const close = runtime?.close;
      if (!runtime?.active || !root?.isConnected || !close?.isConnected || !root.contains(close)) return false;
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
      if (candidate.listError) {
        const alert = runtime.retry?.parentElement;
        if (
          !runtime.retry?.isConnected ||
          alert?.getAttribute("role") !== "alert" ||
          alert.parentElement !== body
        ) {
          return false;
        }
        expected.add(runtime.retry);
      } else if (runtime.retry !== null) {
        return false;
      }
      if (candidate.compare.length > 0) {
        const hint = runtime.clear?.parentElement;
        if (
          !runtime.clear?.isConnected ||
          hint?.getAttribute("data-testid") !== "compare-hint" ||
          hint.parentElement !== body ||
          hint.lastElementChild !== runtime.clear
        ) {
          return false;
        }
        expected.add(runtime.clear);
      } else if (runtime.clear !== null) {
        return false;
      }

      if (runtime.groupLists.length !== candidate.groups.length || runtime.rows.length !== candidate.rows.length) return false;
      for (let groupIndex = 0; groupIndex < candidate.groups.length; groupIndex++) {
        const group = candidate.groups[groupIndex];
        const list = runtime.groupLists[groupIndex];
        if (
          !list?.isConnected ||
          list.parentElement?.parentElement !== body ||
          list.children.length !== group.rows.length
        ) {
          return false;
        }
        const previousList = runtime.groupLists[groupIndex - 1];
        if (
          previousList &&
          !(previousList.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
        ) {
          return false;
        }
        for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex++) {
          const row = group.rows[rowIndex];
          const elements = runtime.rows[row.index];
          const item = elements?.item;
          const checkbox = elements?.checkbox;
          const selectControl = elements?.select;
          const listItem = list.children.item(rowIndex);
          const rowTop = item?.firstElementChild;
          const checkboxLabel = checkbox?.parentElement;
          if (
            !versionSnapshotIsCurrent(row) ||
            !(listItem instanceof HTMLLIElement) ||
            !item?.isConnected ||
            !checkbox?.isConnected ||
            !selectControl?.isConnected ||
            listItem.children.length !== 1 ||
            listItem.firstElementChild !== item ||
            item.parentElement !== listItem ||
            rowTop?.parentElement !== item ||
            rowTop.children.length !== 2 ||
            rowTop.children.item(0) !== checkboxLabel ||
            rowTop.children.item(1) !== selectControl ||
            checkboxLabel?.parentElement !== rowTop ||
            checkboxLabel.children.length !== 1 ||
            checkbox.parentElement !== checkboxLabel ||
            selectControl.parentElement !== rowTop
          ) {
            return false;
          }
          expected.add(checkbox);
          expected.add(selectControl);

          const isSelected = candidate.selected === row.id;
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
            if (!actionContainer?.isConnected || actionContainer.parentElement !== item) return false;
            const actionControls = candidate.canEdit
              ? [elements.restore, elements.startRename, elements.copy]
              : [elements.copy];
            if (
              actionControls.some((element) => !element?.isConnected || element.parentElement !== actionContainer) ||
              actionContainer.children.length !== actionControls.length ||
              actionControls.some((element, index) => actionContainer.children.item(index) !== element)
            ) {
              return false;
            }
            for (const element of actionControls) expected.add(element!);
            if (!candidate.canEdit && (elements.restore !== null || elements.startRename !== null)) return false;
          }

          if (candidate.renaming === row.id) {
            if (!elements.renameInput?.isConnected || !selectControl.contains(elements.renameInput)) return false;
            expected.add(elements.renameInput);
          } else if (elements.renameInput !== null) {
            return false;
          }
        }
      }

      const actual = collectInteractiveElements(root);
      return actual.length === expected.size && actual.every((element) => expected.has(element));
    },
    [authorityIsCurrent, mount],
  );

  const claimPanelControl = useCallback(
    (candidate: PanelRenderPublication, control: PanelControl, source: HTMLButtonElement) => {
      const runtime = publicationRuntimesRef.current.get(candidate);
      const expected = runtime?.[control];
      if (
        expected !== source ||
        source.disabled ||
        !publicationDomIsCurrent(candidate)
      ) {
        return false;
      }
      claimedPublicationsRef.current.add(candidate);
      return true;
    },
    [publicationDomIsCurrent],
  );

  const claimRowControl = useCallback(
    (
      candidate: PanelRenderPublication,
      row: VersionRowPublication,
      control: RowControl,
      source: HTMLButtonElement | HTMLInputElement,
    ) => {
      const publishedRow = candidate.rows[row.index];
      const runtime = publicationRuntimesRef.current.get(candidate);
      const expected = runtime?.rows[row.index]?.[control];
      if (
        publishedRow !== row ||
        expected !== source ||
        source.disabled ||
        !publicationDomIsCurrent(candidate)
      ) {
        return false;
      }
      claimedPublicationsRef.current.add(candidate);
      return true;
    },
    [publicationDomIsCurrent],
  );

  const currentPublicationFor = useCallback(
    (candidate: PanelAuthority, root: HTMLElement, allowClaimed = true) => {
      const current = activePublicationRef.current;
      return current &&
        current.authority === candidate &&
        publicationRuntimesRef.current.get(current)?.root === root &&
        publicationDomIsCurrent(current, allowClaimed)
        ? current
        : null;
    },
    [publicationDomIsCurrent],
  );

  const ownsMutation = useCallback(
    (owner: VersionMutationOwner) => {
      const current = currentPublicationFor(owner.authority, owner.root);
      if (!current || mutationOwner.current !== owner) return false;
      if (owner.phase === "request" && owner.kind !== "rename") {
        const currentSource = publicationRuntimesRef.current.get(current)?.rows[owner.row.index]?.[owner.control];
        if (currentSource !== owner.source) return false;
      }
      return mutationMatchesPresentation(owner, current);
    },
    [currentPublicationFor],
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
    const current = activePublicationRef.current;
    const runtime = current ? publicationRuntimesRef.current.get(current) : null;
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
      const currentPublication = activePublicationRef.current;
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
  }, [ownsListOperation, ownsMutation, publicationDomIsCurrent]);

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
      compareIds: string[],
      selectedId: string | null,
    ) => {
      const runtime = publicationRuntimesRef.current.get(candidate);
      if (!runtime?.root) return;
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
    [contentOf, ownsPreview],
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
      const runtime = publicationRuntimesRef.current.get(candidate);
      if (
        !runtime?.root ||
        mutationOwner.current ||
        runtime.rows[row.index]?.[control] !== source ||
        source.disabled ||
        !publicationDomIsCurrent(candidate, true)
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
    [publicationDomIsCurrent],
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
    if (!claimRowControl(candidate, row, "select", event.currentTarget)) return;
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
    if (!claimRowControl(candidate, row, "checkbox", event.currentTarget)) return;
    // Keep at most two ticked; ticking a third replaces the older tick.
    const next = candidate.compare.includes(row.id)
      ? candidate.compare.filter((id) => id !== row.id)
      : [...candidate.compare.slice(-1), row.id];
    setCompare(next);
    setPublicationRevision((current) => current + 1);
    void showPreview(candidate, next, candidate.selected);
  };

  const restore = async (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimRowControl(candidate, row, "restore", event.currentTarget)) return;
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
    if (!claimRowControl(candidate, row, "copy", event.currentTarget)) return;
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
    if (!claimPanelControl(candidate, "close", event.currentTarget)) return;
    retirePublication(candidate);
    listOperation.current = null;
    setRetryState(null);
    invalidatePreview();
    invalidateMutation();
    candidate.authority.onPreview(null);
    candidate.authority.onClose();
  };

  const retry = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "retry", event.currentTarget)) return;
    setPublicationRevision((current) => current + 1);
    void load(candidate.authority, candidate.refreshKey, { retry: true });
  };

  const clearComparison = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "clear", event.currentTarget)) return;
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
    if (!claimRowControl(candidate, row, "startRename", event.currentTarget)) return;
    setDraft(row.title ?? "");
    setRenaming(row.id);
    setPublicationRevision((current) => current + 1);
  };

  const changeRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "renameInput", event.currentTarget)) return;
    setDraft(event.currentTarget.value);
    setPublicationRevision((current) => current + 1);
  };

  const blurRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: FocusEvent<HTMLInputElement>,
  ) => {
    if (!claimRowControl(candidate, row, "renameInput", event.currentTarget)) return;
    void rename(candidate, row, event.currentTarget);
  };

  const keyDownRename = (
    candidate: PanelRenderPublication,
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (!claimRowControl(candidate, row, "renameInput", event.currentTarget)) return;
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
    if (!claimRowControl(candidate, row, "renameInput", event.currentTarget)) return;
    setPublicationRevision((current) => current + 1);
    event.stopPropagation();
  };

  useLayoutEffect(() => {
    const previous = lastPublicationRef.current;
    const runtime = runtimeFor(publication);
    const previousRoot = previous
      ? publicationRuntimesRef.current.get(previous)?.root
      : null;
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
      previousRoot !== runtime.root;

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

    runtime.active = true;
    activePublicationRef.current = publication;
    if (!publicationDomIsCurrent(publication, true)) retirePublication(publication);
    lastPublicationRef.current = publication;
    return () => retirePublication(publication);
  }, [
    mutationState?.authority,
    previewState?.authority,
    publication,
    publicationDomIsCurrent,
    retirePublication,
    retryState?.authority,
    runtimeFor,
  ]);

  const compareHint =
    publication.compare.length === 1
      ? "Tick one more version to compare"
      : publication.compare.length === 2
        ? "Comparing two versions"
        : null;

  return (
    <aside
      ref={(element) => bindRoot(publication, element)}
      className="flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2"
      data-testid="versions-panel"
    >
      <div className="flex h-12 items-center justify-between border-b border-line pl-4 pr-2">
        <span className="pane-label">Version history</span>
        <button
          ref={(element) => bindPanelControl(publication, "close", element)}
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
              ref={(element) => bindPanelControl(publication, "retry", element)}
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
              ref={(element) => bindPanelControl(publication, "clear", element)}
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
                ref={(element) => bindGroupList(publication, groupIndex, element)}
                className="flex flex-col gap-1"
              >
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <div
                      ref={(element) => bindRowElement(publication, row, "item", element)}
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
                            ref={(element) => bindRowElement(publication, row, "checkbox", element)}
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
                          ref={(element) => bindRowElement(publication, row, "select", element)}
                          type="button"
                          className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          onClick={(event) => select(publication, row, event)}
                        >
                          <KindIcon kind={row.kind} />
                          <div className="min-w-0 flex-1">
                            {renaming === row.id ? (
                              <input
                                ref={(element) => bindRowElement(publication, row, "renameInput", element)}
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
                              ref={(element) => bindRowElement(publication, row, "restore", element)}
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
                              ref={(element) => bindRowElement(publication, row, "startRename", element)}
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
                            ref={(element) => bindRowElement(publication, row, "copy", element)}
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
