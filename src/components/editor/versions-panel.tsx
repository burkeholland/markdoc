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
import { ArrowLeftRight, ChevronDown, ChevronUp, Clock, Copy, Download, GitCommit, History, Loader2, MoveVertical, Pencil, RefreshCw, RotateCcw, Tag, Upload, X } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import { api, apiErrorText, type VersionSummary } from "@/lib/api";
import { collapseSegment, detectMoves, diffStats, hunkCounter, hunks, wordDiff, type Collapsed, type DiffSegment, type Hunk } from "@/editor/diff";
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
const inflight = new Map<
  string,
  { owner: symbol; promise: Promise<VersionSummary[]>; shareable: boolean }
>();

function fetchVersions(docId: string, options?: { fresh?: boolean; canCommit?: () => boolean }): Promise<VersionSummary[]> {
  const pending = inflight.get(docId);
  if (pending?.shareable && !options?.fresh) return pending.promise;

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
  inflight.set(docId, {
    owner,
    promise,
    shareable: !options?.fresh,
  });
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
  readonly visit: symbol;
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
  activation: PanelRenderPublication;
  authority: PanelAuthority;
  root: HTMLElement;
  refreshKey: number;
  intent: "initial" | "external" | "manual" | "retry" | "mutation";
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
  readonly refresh: ListOperation | null;
  readonly selected: string | null;
  readonly compare: readonly string[];
  readonly compareValues: readonly string[];
  readonly preview: PreviewOperation | null;
  readonly mutation: VersionMutationOwner | null;
  readonly mutationPhase: VersionMutationOwner["phase"] | null;
  readonly renaming: string | null;
  readonly draft: string;
  readonly canEdit: boolean;
  readonly toolbarStop: PanelToolbarControl;
  readonly toolbarActions: readonly PanelToolbarActionFact[];
  readonly setToolbarStop: (control: PanelToolbarControl) => void;
  readonly requestSuccessor: () => void;
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

type PanelToolbarControl = "refresh" | "close";
type PanelControl = PanelToolbarControl | "retry" | "clear";
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

interface PanelNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface PanelPlacement {
  readonly document: Document;
  readonly chain: readonly PanelNodePlacement[];
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
  readonly toolbar: HTMLDivElement;
  readonly close: HTMLButtonElement;
  readonly refresh: HTMLButtonElement;
  readonly retry: HTMLButtonElement | null;
  readonly clear: HTMLButtonElement | null;
  readonly groupLists: readonly HTMLUListElement[];
  readonly rows: readonly VersionRowElements[];
  readonly ownerDocument: Document;
  readonly dom: PanelDomSnapshot;
  readonly placement: PanelPlacement;
  readonly toolbarKeyboard: {
    value: PanelToolbarKeyboardRuntime | null;
  };
  readonly rowKeyboard: {
    value: PanelRowKeyboardRuntime | null;
  };
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
  readonly attemptedToolbarReactEvents: WeakSet<object>;
  readonly attemptedToolbarNativeEvents: WeakSet<Event>;
  readonly claimedToolbarPublications: WeakSet<PanelToolbarKeyboardPublication>;
  readonly claimedToolbarEntries: WeakSet<PanelToolbarKeyboardEntry>;
  readonly claimedToolbarActions: WeakSet<PanelToolbarKeyboardAction>;
  readonly claimedToolbarReactEvents: WeakSet<object>;
  readonly claimedToolbarNativeEvents: WeakSet<Event>;
  readonly attemptedRowReactEvents: WeakSet<object>;
  readonly attemptedRowNativeEvents: WeakSet<Event>;
  readonly claimedRowPublications: WeakSet<PanelRowKeyboardPublication>;
  readonly claimedRowEntries: WeakSet<PanelRowKeyboardEntry>;
  readonly claimedRowActions: WeakSet<PanelRowKeyboardAction>;
  readonly claimedRowReactEvents: WeakSet<object>;
  readonly claimedRowNativeEvents: WeakSet<Event>;
}

interface PanelPublicationSet {
  readonly publication: PanelRenderPublication;
  readonly captureRoot: (element: HTMLElement | null) => void;
  readonly captureToolbar: (element: HTMLDivElement | null) => void;
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
  readonly captureToolbarKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly captureToolbarActionKeyDown: (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly toolbarActionKeyDown: (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly toolbarKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly captureRowListKeyDown: (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => void;
  readonly captureRowSelectKeyDown: (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly rowSelectKeyDown: (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly rowListKeyDown: (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => void;
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

interface PanelToolbarActionFact {
  readonly control: PanelToolbarControl;
  readonly index: number;
  readonly label: string;
  readonly enabled: boolean;
  readonly tabStop: boolean;
}

interface PanelToolbarKeyboardAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly entryIdentity: symbol;
  readonly control: PanelToolbarControl;
  readonly index: number;
}

interface PanelToolbarKeyboardEntry {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly fact: PanelToolbarActionFact;
  readonly index: number;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: PanelToolbarKeyboardAction;
}

interface PanelToolbarKeyboardPublication {
  readonly identity: symbol;
  readonly render: PanelRenderPublication;
  readonly runtime: PanelPublicationRuntime;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly toolbar: HTMLDivElement;
  readonly entries: readonly PanelToolbarKeyboardEntry[];
  readonly dom: PanelDomSnapshot;
  readonly placement: PanelPlacement;
}

interface PanelToolbarNativeKeyProof {
  readonly identity: symbol;
  readonly publication: PanelToolbarKeyboardPublication;
  readonly entry: PanelToolbarKeyboardEntry;
  readonly action: PanelToolbarKeyboardAction;
  readonly event: globalThis.KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly pathTerminal: EventTarget;
  readonly view: Window | null;
  readonly capturePhase: number;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly locale: string | undefined;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly detail: number;
  readonly timeStamp: number;
  readonly destination: PanelToolbarKeyboardEntry;
  readonly trusted: true;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly altKey: false;
  readonly shiftKey: false;
  readonly repeat: false;
  readonly composing: false;
}

type PanelToolbarReactMethod = (...args: never[]) => unknown;

interface PanelToolbarReactEventMethods {
  readonly preventDefault: PanelToolbarReactMethod;
  readonly isDefaultPrevented: PanelToolbarReactMethod;
  readonly isPropagationStopped: PanelToolbarReactMethod;
}

interface PanelToolbarReactKeyProof {
  readonly event: object;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: Element;
  readonly eventPhase: number;
  readonly view: unknown;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly locale: string | undefined;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly detail: number;
  readonly timeStamp: number;
  readonly composing: false | null;
  readonly methods: PanelToolbarReactEventMethods;
}

type PanelRowReactKeyProof = Omit<PanelToolbarReactKeyProof, "currentTarget"> & {
  readonly currentTarget: Element | null;
};

interface PanelToolbarMovement {
  readonly identity: symbol;
  readonly publication: PanelToolbarKeyboardPublication;
  readonly source: PanelToolbarKeyboardEntry;
  readonly destination: PanelToolbarKeyboardEntry;
  readonly actions: readonly PanelToolbarActionFact[];
  readonly key: string;
  readonly setToolbarStop: PanelRenderPublication["setToolbarStop"];
  readonly requestSuccessor: PanelRenderPublication["requestSuccessor"];
}

interface PanelToolbarListenerAccess {
  readonly identity: symbol;
  pairs: WeakMap<
    globalThis.KeyboardEvent,
    PanelToolbarNativeReactPair
  >;
  attempted: WeakSet<globalThis.KeyboardEvent>;
  active: boolean;
}

interface PanelToolbarNativeReactPair {
  readonly native: PanelToolbarNativeKeyProof;
  readonly movement: PanelToolbarMovement;
  readonly access: PanelToolbarListenerAccess;
  reactToolbarCapture: PanelToolbarReactKeyProof | null;
  reactActionCapture: PanelToolbarReactKeyProof | null;
  reactActionBubble: PanelToolbarReactKeyProof | null;
  reactToolbarBubble: PanelToolbarReactKeyProof | null;
  boundaryObserved: boolean;
  documentBubbleObserved: boolean;
  windowReceiver: EventTarget | null;
  handling: boolean;
  finalizing: boolean;
  consumed: boolean;
  rejected: boolean;
}

interface PanelToolbarTerminalKeyProof {
  readonly native: PanelToolbarNativeKeyProof;
  readonly movement: PanelToolbarMovement;
  readonly toolbarCapture: PanelToolbarReactKeyProof;
  readonly actionCapture: PanelToolbarReactKeyProof;
  readonly actionBubble: PanelToolbarReactKeyProof;
  readonly toolbarBubble: PanelToolbarReactKeyProof;
}

interface PanelToolbarKeyboardRuntime {
  readonly publication: PanelToolbarKeyboardPublication;
  readonly publish: () => boolean;
  readonly release: () => void;
  readonly captureToolbar: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly captureAction: (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleAction: (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleToolbar: (event: KeyboardEvent<HTMLDivElement>) => void;
}

type PanelToolbarIntrinsicGetter<T> = {
  readonly read: (target: object) => T;
  readonly isCurrent: () => boolean;
};

type PanelToolbarIntrinsicMethod<
  Args extends readonly unknown[],
  Result,
> = {
  readonly call: (target: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
};

interface PanelToolbarKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly eventPrototype: object;
  readonly keyboardPrototype: object;
  readonly documentPrototype: object;
  readonly htmlElementPrototype: object;
  readonly eventType: PanelToolbarIntrinsicGetter<string>;
  readonly eventTarget: PanelToolbarIntrinsicGetter<EventTarget | null>;
  readonly eventCurrentTarget: PanelToolbarIntrinsicGetter<EventTarget | null>;
  readonly eventPhase: PanelToolbarIntrinsicGetter<number>;
  readonly eventBubbles: PanelToolbarIntrinsicGetter<boolean>;
  readonly eventCancelable: PanelToolbarIntrinsicGetter<boolean>;
  readonly eventDefaultPrevented: PanelToolbarIntrinsicGetter<boolean>;
  readonly eventCancelBubble: PanelToolbarIntrinsicGetter<boolean>;
  readonly eventTimeStamp?: PanelToolbarIntrinsicGetter<number>;
  readonly eventPath: PanelToolbarIntrinsicMethod<readonly [], EventTarget[]>;
  readonly eventPreventDefault: PanelToolbarIntrinsicMethod<readonly [], void>;
  readonly eventStopPropagation: PanelToolbarIntrinsicMethod<readonly [], void>;
  readonly eventStopImmediatePropagation: PanelToolbarIntrinsicMethod<
    readonly [],
    void
  >;
  readonly eventView: PanelToolbarIntrinsicGetter<Window | null>;
  readonly eventDetail?: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardKey: PanelToolbarIntrinsicGetter<string>;
  readonly keyboardCode?: PanelToolbarIntrinsicGetter<string>;
  readonly keyboardLocation?: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardLocale: PanelToolbarIntrinsicGetter<string> | null;
  readonly keyboardCharCode?: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardKeyCode?: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardWhich?: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardCtrl: PanelToolbarIntrinsicGetter<boolean>;
  readonly keyboardMeta: PanelToolbarIntrinsicGetter<boolean>;
  readonly keyboardAlt: PanelToolbarIntrinsicGetter<boolean>;
  readonly keyboardShift: PanelToolbarIntrinsicGetter<boolean>;
  readonly keyboardRepeat: PanelToolbarIntrinsicGetter<boolean>;
  readonly keyboardComposing: PanelToolbarIntrinsicGetter<boolean>;
  readonly activeElement: PanelToolbarIntrinsicGetter<Element | null>;
  readonly focus: PanelToolbarIntrinsicMethod<readonly [FocusOptions?], void>;
  readonly addEventListener: PanelToolbarIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeEventListener: PanelToolbarIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly addWindowEventListener: PanelToolbarIntrinsicMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >;
  readonly removeWindowEventListener: PanelToolbarIntrinsicMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >;
  readonly isTrusted: {
    readonly matches: (event: object) => boolean;
    readonly read: (event: object) => boolean;
    readonly isCurrent: () => boolean;
  };
  readonly defineProperty: typeof Reflect.defineProperty;
  readonly apply: typeof Reflect.apply;
  readonly getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly isCurrent: () => boolean;
}

interface PanelToolbarPublicKeyboardAuthority
  extends PanelToolbarKeyboardAuthority {
  readonly eventTimeStamp: PanelToolbarIntrinsicGetter<number>;
  readonly eventDetail: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardCode: PanelToolbarIntrinsicGetter<string>;
  readonly keyboardLocation: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardCharCode: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardKeyCode: PanelToolbarIntrinsicGetter<number>;
  readonly keyboardWhich: PanelToolbarIntrinsicGetter<number>;
}

function panelToolbarHasPublicScalarAuthority(
  authority: PanelToolbarKeyboardAuthority,
): authority is PanelToolbarPublicKeyboardAuthority {
  return Boolean(
    authority.eventTimeStamp &&
      authority.eventDetail &&
      authority.keyboardCode &&
      authority.keyboardLocation &&
      authority.keyboardCharCode &&
      authority.keyboardKeyCode &&
      authority.keyboardWhich,
  );
}

/** One row's main select button as a navigation stop, bound to the exact published row and list. */
interface PanelRowKeyboardAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly entryIdentity: symbol;
  readonly rowId: string;
  readonly rowIndex: number;
  readonly order: number;
}

interface PanelRowKeyboardEntry {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly row: VersionRowPublication;
  readonly rowIndex: number;
  readonly order: number;
  readonly groupIndex: number;
  readonly groupOrder: number;
  readonly list: HTMLUListElement;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: PanelRowKeyboardAction;
}

interface PanelRowKeyboardPublication {
  readonly identity: symbol;
  readonly render: PanelRenderPublication;
  readonly runtime: PanelPublicationRuntime;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly entries: readonly PanelRowKeyboardEntry[];
  readonly dom: PanelDomSnapshot;
  readonly placement: PanelPlacement;
}

interface PanelRowNativeKeyProof {
  readonly identity: symbol;
  readonly publication: PanelRowKeyboardPublication;
  readonly entry: PanelRowKeyboardEntry;
  readonly action: PanelRowKeyboardAction;
  readonly event: globalThis.KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly locale: string | undefined;
  readonly charCode: number;
  readonly keyCode: number;
  readonly which: number;
  readonly detail: number;
  readonly timeStamp: number;
  readonly destination: PanelRowKeyboardEntry;
  readonly trusted: true;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly altKey: false;
  readonly shiftKey: false;
  readonly repeat: false;
  readonly composing: false;
  readonly propagationStopped: () => boolean;
  crossed: boolean;
}

interface PanelRowTerminalKeyProof {
  readonly native: PanelRowNativeKeyProof;
  readonly reactProofs: readonly PanelRowReactKeyProof[];
  readonly reactBubble: PanelRowReactKeyProof;
}

interface PanelRowKeyboardRuntime {
  readonly publication: PanelRowKeyboardPublication;
  readonly publish: () => boolean;
  readonly release: () => void;
  readonly captureList: (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => void;
  readonly captureSelect: (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleSelect: (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleList: (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => void;
}

const PANEL_TOOLBAR_CLASS = "flex items-center gap-1";
const PANEL_TOOLBAR_LABEL = "Version history actions";
const PANEL_TOOLBAR_DEFINITIONS = Object.freeze([
  Object.freeze({
    control: "refresh",
    label: "Refresh versions",
  }),
  Object.freeze({
    control: "close",
    label: "Close version history",
  }),
] as const);
const PANEL_TOOLBAR_PREVENT_SCROLL = Object.freeze({ preventScroll: true });

function panelToolbarDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  return Boolean(
    current &&
      current.configurable === expected.configurable &&
      current.enumerable === expected.enumerable &&
      current.writable === expected.writable &&
      current.value === expected.value &&
      current.get === expected.get &&
      current.set === expected.set,
  );
}

function capturePanelToolbarKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
  includePublicScalars = false,
): PanelToolbarKeyboardAuthority | null {
  const getOwnPropertyDescriptor = ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const apply = ownerWindow.Reflect.apply;
  const defineProperty = ownerWindow.Reflect.defineProperty;
  const eventPrototype = ownerWindow.Event.prototype;
  const keyboardPrototype = ownerWindow.KeyboardEvent.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  const authorities: Array<{ readonly isCurrent: () => boolean }> = [];
  const prototypeLinks: Array<readonly [object, object | null]> = [];
  const linkedPrototypes = new Set<object>();
  const capturePrototypeChain = (prototype: object) => {
    let current: object | null = prototype;
    while (current && !linkedPrototypes.has(current)) {
      linkedPrototypes.add(current);
      const parent = getPrototypeOf(current) as object | null;
      prototypeLinks.push(Object.freeze([current, parent] as const));
      current = parent;
    }
  };
  capturePrototypeChain(keyboardPrototype);
  capturePrototypeChain(eventPrototype);
  capturePrototypeChain(documentPrototype);
  capturePrototypeChain(htmlElementPrototype);
  capturePrototypeChain(ownerWindow.EventTarget.prototype);

  const captureGetter = <T,>(
    prototype: object,
    property: PropertyKey,
  ): PanelToolbarIntrinsicGetter<T> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.get !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const getter = descriptor.get;
        const authority = Object.freeze({
          read: (target: object) => apply(getter, target, []) as T,
          isCurrent: () =>
            panelToolbarDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const captureMethod = <Args extends readonly unknown[], Result>(
    prototype: object,
    property: PropertyKey,
  ): PanelToolbarIntrinsicMethod<Args, Result> | null => {
    let current: object | null = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (typeof descriptor.value !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const method = descriptor.value as (...args: Args) => Result;
        const authority = Object.freeze({
          call: (target: object, ...args: Args) =>
            apply(method, target, args) as Result,
          isCurrent: () =>
            panelToolbarDescriptorsMatch(
              getOwnPropertyDescriptor(owner, property),
              expected,
            ),
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const captureCallableProperty = <
    Args extends readonly unknown[],
    Result,
  >(
    target: object,
    property: PropertyKey,
  ): PanelToolbarIntrinsicMethod<Args, Result> | null => {
    let current: object | null = target;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        const method =
          typeof descriptor.value === "function"
            ? descriptor.value
            : typeof descriptor.get === "function"
              ? apply(descriptor.get, target, [])
              : null;
        if (typeof method !== "function") return null;
        const owner = current;
        const expected = Object.freeze({ ...descriptor });
        const authority = Object.freeze({
          call: (receiver: object, ...args: Args) =>
            apply(method as (...values: Args) => Result, receiver, args) as Result,
          isCurrent: () => {
            const currentDescriptor = getOwnPropertyDescriptor(owner, property);
            if (!panelToolbarDescriptorsMatch(currentDescriptor, expected)) {
              return false;
            }
            return (
              typeof expected.get !== "function" ||
              apply(expected.get, target, []) === method
            );
          },
        });
        authorities.push(authority);
        return authority;
      }
      current = getPrototypeOf(current) as object | null;
    }
    return null;
  };

  const eventType = captureGetter<string>(eventPrototype, "type");
  const eventTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "target",
  );
  const eventCurrentTarget = captureGetter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventPhase = captureGetter<number>(eventPrototype, "eventPhase");
  const eventBubbles = captureGetter<boolean>(eventPrototype, "bubbles");
  const eventCancelable = captureGetter<boolean>(eventPrototype, "cancelable");
  const eventDefaultPrevented = captureGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureGetter<boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const eventTimeStamp = includePublicScalars
    ? captureGetter<number>(eventPrototype, "timeStamp")
    : undefined;
  const eventPath = captureMethod<readonly [], EventTarget[]>(
    eventPrototype,
    "composedPath",
  );
  const eventPreventDefault = captureMethod<readonly [], void>(
    eventPrototype,
    "preventDefault",
  );
  const eventStopPropagation = captureMethod<readonly [], void>(
    eventPrototype,
    "stopPropagation",
  );
  const eventStopImmediatePropagation = captureMethod<readonly [], void>(
    eventPrototype,
    "stopImmediatePropagation",
  );
  const eventView = captureGetter<Window | null>(
    ownerWindow.UIEvent.prototype,
    "view",
  );
  const eventDetail = includePublicScalars
    ? captureGetter<number>(ownerWindow.UIEvent.prototype, "detail")
    : undefined;
  const keyboardKey = captureGetter<string>(keyboardPrototype, "key");
  const keyboardCode = includePublicScalars
    ? captureGetter<string>(keyboardPrototype, "code")
    : undefined;
  const keyboardLocation = includePublicScalars
    ? captureGetter<number>(keyboardPrototype, "location")
    : undefined;
  const keyboardLocale = includePublicScalars
    ? captureGetter<string>(keyboardPrototype, "locale")
    : null;
  const keyboardCharCode = includePublicScalars
    ? captureGetter<number>(keyboardPrototype, "charCode")
    : undefined;
  const keyboardKeyCode = includePublicScalars
    ? captureGetter<number>(keyboardPrototype, "keyCode")
    : undefined;
  const keyboardWhich = includePublicScalars
    ? captureGetter<number>(keyboardPrototype, "which")
    : undefined;
  const keyboardCtrl = captureGetter<boolean>(keyboardPrototype, "ctrlKey");
  const keyboardMeta = captureGetter<boolean>(keyboardPrototype, "metaKey");
  const keyboardAlt = captureGetter<boolean>(keyboardPrototype, "altKey");
  const keyboardShift = captureGetter<boolean>(keyboardPrototype, "shiftKey");
  const keyboardRepeat = captureGetter<boolean>(keyboardPrototype, "repeat");
  const keyboardComposing = captureGetter<boolean>(
    keyboardPrototype,
    "isComposing",
  );
  const activeElement = captureGetter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const focus = captureMethod<readonly [FocusOptions?], void>(
    htmlElementPrototype,
    "focus",
  );
  const addEventListener = captureMethod<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(ownerWindow.EventTarget.prototype, "addEventListener");
  const removeEventListener = captureMethod<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(ownerWindow.EventTarget.prototype, "removeEventListener");
  const addWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | AddEventListenerOptions)?],
    void
  >(ownerWindow, "addEventListener");
  const removeWindowEventListener = captureCallableProperty<
    readonly [string, EventListener, (boolean | EventListenerOptions)?],
    void
  >(ownerWindow, "removeEventListener");

  let trustProbe: globalThis.KeyboardEvent;
  try {
    trustProbe = new ownerWindow.KeyboardEvent(
      "versions-panel-toolbar-keyboard-intrinsic",
    );
  } catch {
    return null;
  }
  const trustDescriptor = getOwnPropertyDescriptor(trustProbe, "isTrusted");
  if (
    !trustDescriptor ||
    trustDescriptor.configurable !== false ||
    typeof trustDescriptor.get !== "function" ||
    trustDescriptor.set !== undefined
  ) {
    return null;
  }
  const expectedTrustDescriptor = Object.freeze({ ...trustDescriptor });
  const isTrusted = Object.freeze({
    matches: (event: object) =>
      panelToolbarDescriptorsMatch(
        getOwnPropertyDescriptor(event, "isTrusted"),
        expectedTrustDescriptor,
      ),
    read: (event: object) =>
      apply(trustDescriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      panelToolbarDescriptorsMatch(
        getOwnPropertyDescriptor(trustProbe, "isTrusted"),
        expectedTrustDescriptor,
      ),
  });

  if (
    !eventType ||
    !eventTarget ||
    !eventCurrentTarget ||
    !eventPhase ||
    !eventBubbles ||
    !eventCancelable ||
    !eventDefaultPrevented ||
    !eventCancelBubble ||
    !eventPath ||
    !eventPreventDefault ||
    !eventStopPropagation ||
    !eventStopImmediatePropagation ||
    !eventView ||
    !keyboardKey ||
    (includePublicScalars &&
      (!eventTimeStamp ||
        !eventDetail ||
        !keyboardCode ||
        !keyboardLocation ||
        !keyboardCharCode ||
        !keyboardKeyCode ||
        !keyboardWhich)) ||
    !keyboardCtrl ||
    !keyboardMeta ||
    !keyboardAlt ||
    !keyboardShift ||
    !keyboardRepeat ||
    !keyboardComposing ||
    !activeElement ||
    !focus ||
    !addEventListener ||
    !removeEventListener ||
    !addWindowEventListener ||
    !removeWindowEventListener
  ) {
    return null;
  }

  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.apply === apply &&
    ownerWindow.Reflect.defineProperty === defineProperty &&
    ownerWindow.Event.prototype === eventPrototype &&
    ownerWindow.KeyboardEvent.prototype === keyboardPrototype &&
    ownerWindow.Document.prototype === documentPrototype &&
    ownerWindow.HTMLElement.prototype === htmlElementPrototype &&
    prototypeLinks.every(
      ([prototype, parent]) => getPrototypeOf(prototype) === parent,
    ) &&
    isTrusted.isCurrent() &&
    authorities.every((authority) => authority.isCurrent());

  return Object.freeze({
    ownerWindow,
    eventPrototype,
    keyboardPrototype,
    documentPrototype,
    htmlElementPrototype,
    eventType,
    eventTarget,
    eventCurrentTarget,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventTimeStamp: eventTimeStamp ?? undefined,
    eventPath,
    eventPreventDefault,
    eventStopPropagation,
    eventStopImmediatePropagation,
    eventView,
    eventDetail: eventDetail ?? undefined,
    keyboardKey,
    keyboardCode: keyboardCode ?? undefined,
    keyboardLocation: keyboardLocation ?? undefined,
    keyboardLocale,
    keyboardCharCode: keyboardCharCode ?? undefined,
    keyboardKeyCode: keyboardKeyCode ?? undefined,
    keyboardWhich: keyboardWhich ?? undefined,
    keyboardCtrl,
    keyboardMeta,
    keyboardAlt,
    keyboardShift,
    keyboardRepeat,
    keyboardComposing,
    activeElement,
    focus,
    addEventListener,
    removeEventListener,
    addWindowEventListener,
    removeWindowEventListener,
    isTrusted,
    defineProperty,
    apply,
    getOwnPropertyDescriptor,
    getPrototypeOf,
    isCurrent,
  });
}

function panelToolbarEventPath(
  ownerDocument: Document,
  target: Node,
) {
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  return Object.freeze(path);
}

function panelToolbarPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
) {
  return (
    actual.length === expected.length + 1 &&
    actual.at(-2) === expected.at(-1) &&
    actual.at(-1) != null &&
    expected.every((target, index) => target === actual[index])
  );
}

function panelRowEventPath(ownerDocument: Document, target: Node) {
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  return path.at(-1) === ownerDocument ? Object.freeze(path) : null;
}

function panelRowPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
) {
  return (
    actual.length === expected.length + 1 &&
    actual.at(-2) === expected.at(-1) &&
    actual.at(-1) != null &&
    expected.every((target, index) => actual[index] === target)
  );
}

function panelRowExactPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
) {
  return (
    actual.length === expected.length &&
    actual.every((target, index) => target === expected[index])
  );
}

function panelToolbarStop(
  requested: PanelToolbarControl,
  refreshEnabled: boolean,
): PanelToolbarControl {
  return requested === "refresh" && refreshEnabled ? "refresh" : "close";
}

function panelToolbarDestination(
  actions: readonly PanelToolbarActionFact[],
  source: PanelToolbarActionFact,
  key: string,
) {
  if (
    actions.length !== PANEL_TOOLBAR_DEFINITIONS.length ||
    actions[source.index] !== source ||
    !source.enabled
  ) {
    return null;
  }
  if (key === "Home" || key === "End") {
    const ordered = key === "Home" ? actions : [...actions].reverse();
    const destination = ordered.find((action) => action.enabled) ?? null;
    return destination === source ? null : destination;
  }
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (!step) return null;
  for (let offset = 1; offset <= actions.length; offset++) {
    const index =
      (source.index + step * offset + actions.length) % actions.length;
    const destination = actions[index];
    if (destination?.enabled) return destination;
  }
  return null;
}

/**
 * The vertical navigation stop an arrow, Home, or End key moves to from `source`, in the published
 * row order across day groups, wrapping at both ends. Returns null when nothing should move.
 */
function panelRowDestination(
  entries: readonly PanelRowKeyboardEntry[],
  source: PanelRowKeyboardEntry,
  key: string,
) {
  const enabled = (entry: PanelRowKeyboardEntry | undefined) =>
    Boolean(
      entry &&
        entry.element.isConnected &&
        panelControlIsEnabled(entry.element),
    );
  if (
    entries.length === 0 ||
    entries[source.order] !== source ||
    !enabled(source)
  ) {
    return null;
  }
  if (key === "Home" || key === "End") {
    const ordered = key === "Home" ? entries : [...entries].reverse();
    const destination = ordered.find(enabled) ?? null;
    return destination === source ? null : destination;
  }
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  if (!step) return null;
  for (let offset = 1; offset <= entries.length; offset++) {
    const index =
      (source.order + step * offset + entries.length) % entries.length;
    const destination = entries[index];
    if (enabled(destination)) return destination;
  }
  return null;
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
    if (!element) return;
    return () => {
      if (this.current === element) this.capture(null);
      else this.onChange(this, null, element, this.last);
    };
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
  return (
    owner.intent === "retry" &&
    publication.authority === owner.authority &&
    publication.refreshKey === owner.refreshKey &&
    sameVersionPresentation(
      owner.activation.versions,
      owner.activation.rows,
      publication,
    )
  );
}

function refreshMatchesPresentation(owner: ListOperation, publication: PanelRenderPublication): boolean {
  return (
    owner.intent === "manual" &&
    publication.authority === owner.authority &&
    publication.refreshKey === owner.refreshKey &&
    sameVersionPresentation(
      owner.activation.versions,
      owner.activation.rows,
      publication,
    )
  );
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
  if (!root.isConnected) return null;
  const document = root.ownerDocument;
  const chain: PanelNodePlacement[] = [];
  let current: Node = root;
  while (current !== document) {
    const parent = current.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node: current,
        parent,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
        exactSiblings: current === root,
      }),
    );
    current = parent;
  }
  return chain.length > 0
    ? Object.freeze({ document, chain: Object.freeze(chain) })
    : null;
}

function panelPlacementMatches(root: HTMLElement, placement: PanelPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.chain[0]?.node === root &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        (!entry.exactSiblings ||
          (entry.node.previousSibling === entry.previousSibling &&
            entry.node.nextSibling === entry.nextSibling)),
    )
  );
}

function panelPlacementRecordChanged(
  record: MutationRecord,
  placement: PanelNodePlacement,
) {
  if (record.type !== "childList" || record.target !== placement.parent) {
    return false;
  }
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node ||
      record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === placement.node || node.contains(placement.node),
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
      return placement.chain.some((entry) =>
        panelPlacementRecordChanged(record, entry),
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
  for (const entry of placement.chain) {
    observer.observe(entry.parent, { childList: true });
  }
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
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function panelAuthorityIsCurrent(authority: PanelAuthority): boolean {
  return (
    typeof authority.visit === "symbol" &&
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

function panelToolbarFactsAreCurrent(
  publication: PanelRenderPublication,
): boolean {
  const actions = publication.toolbarActions;
  return (
    Object.isFrozen(actions) &&
    actions.length === PANEL_TOOLBAR_DEFINITIONS.length &&
    actions.filter((action) => action.tabStop).length === 1 &&
    actions.every((action, index) => {
      const definition = PANEL_TOOLBAR_DEFINITIONS[index];
      return (
        Object.isFrozen(action) &&
        action.control === definition.control &&
        action.index === index &&
        action.label === definition.label &&
        action.enabled ===
          (action.control === "refresh" ? publication.refresh === null : true) &&
        action.tabStop === (action.control === publication.toolbarStop)
      );
    }) &&
    actions.some(
      (action) =>
        action.control === publication.toolbarStop &&
        action.enabled &&
        action.tabStop,
    )
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
    refresh,
  } = publication;
  if (
    !Object.isFrozen(publication) ||
    !Object.isFrozen(authority) ||
    !Object.isFrozen(rows) ||
    !Object.isFrozen(groups) ||
    !Object.isFrozen(compareValues) ||
    publication.mount !== authority.mount ||
    !panelAuthorityIsCurrent(authority) ||
    !Number.isSafeInteger(publication.revision) ||
    publication.revision < 0 ||
    publication.canEdit !==
      (authority.role === "owner" || authority.role === "editor") ||
    !panelToolbarFactsAreCurrent(publication) ||
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
    (refresh !== null &&
      !refreshMatchesPresentation(refresh, publication)) ||
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
    before.visit === after.visit &&
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
    previous.refresh === current.refresh &&
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
    previous.toolbarStop === current.toolbarStop &&
    previous.toolbarActions.length === current.toolbarActions.length &&
    previous.toolbarActions.every((action, index) => {
      const candidate = current.toolbarActions[index];
      return (
        candidate &&
        action.control === candidate.control &&
        action.index === candidate.index &&
        action.label === candidate.label &&
        action.enabled === candidate.enabled &&
        action.tabStop === candidate.tabStop
      );
    }) &&
    previous.setToolbarStop === current.setToolbarStop &&
    previous.requestSuccessor === current.requestSuccessor &&
    previous.revision === current.revision &&
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
    toolbar,
    close,
    refresh,
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
    !toolbar.isConnected ||
    toolbar.ownerDocument !== ownerDocument ||
    toolbar.tagName !== "DIV" ||
    toolbar.className !== PANEL_TOOLBAR_CLASS ||
    toolbar.getAttribute("role") !== "toolbar" ||
    toolbar.getAttribute("aria-label") !== PANEL_TOOLBAR_LABEL ||
    toolbar.getAttribute("aria-orientation") !== "horizontal" ||
    !close.isConnected ||
    close.ownerDocument !== ownerDocument ||
    close.tagName !== "BUTTON" ||
    close.type !== "button" ||
    !panelControlIsEnabled(close) ||
    close.getAttribute("aria-label") !== "Close version history" ||
    close.tabIndex !==
      (publication.toolbarStop === "close" ? 0 : -1)
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
    !refresh.isConnected ||
    refresh.ownerDocument !== ownerDocument ||
    refresh.tagName !== "BUTTON" ||
    refresh.type !== "button" ||
    refresh.getAttribute("aria-label") !== "Refresh versions" ||
    refresh.getAttribute("title") !== "Refresh versions" ||
    refresh.disabled !== (publication.refresh !== null) ||
    refresh.getAttribute("aria-busy") !==
      (publication.refresh === null ? null : "true") ||
    refresh.tabIndex !==
      (publication.toolbarStop === "refresh" ? 0 : -1) ||
    (publication.refresh === null && !panelControlIsEnabled(refresh))
  ) {
    return false;
  }

  if (
    toolbar.parentElement !== header ||
    header.lastElementChild !== toolbar ||
    toolbar.children.length !== PANEL_TOOLBAR_DEFINITIONS.length ||
    toolbar.children.item(0) !== refresh ||
    toolbar.children.item(1) !== close ||
    refresh.parentElement !== toolbar ||
    close.parentElement !== toolbar ||
    new Set(publication.toolbarActions.map((action) => action.control)).size !==
      PANEL_TOOLBAR_DEFINITIONS.length
  ) {
    return false;
  }

  const expected = new Set<HTMLButtonElement | HTMLInputElement>([
    refresh,
    close,
  ]);
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

function readPanelRowReactKeyProof(
  event: object,
  native: PanelRowNativeKeyProof,
  currentTarget: Element | null,
  eventPhase: number,
  defaultPrevented = false,
): PanelRowReactKeyProof | null {
  const wrapper = event as KeyboardEvent<Element> & {
    isComposing?: unknown;
    locale?: unknown;
  };
  const current = {
    type: wrapper.type,
    nativeEvent: wrapper.nativeEvent,
    target: wrapper.target,
    currentTarget: wrapper.currentTarget,
    eventPhase: wrapper.eventPhase,
    bubbles: wrapper.bubbles,
    cancelable: wrapper.cancelable,
    defaultPrevented: wrapper.defaultPrevented,
    isTrusted: wrapper.isTrusted,
    view: wrapper.view as unknown,
    key: wrapper.key,
    code: wrapper.code,
    location: wrapper.location,
    locale: wrapper.locale,
    charCode: wrapper.charCode,
    keyCode: wrapper.keyCode,
    which: wrapper.which,
    detail: wrapper.detail,
    timeStamp: wrapper.timeStamp,
    ctrlKey: wrapper.ctrlKey,
    metaKey: wrapper.metaKey,
    altKey: wrapper.altKey,
    shiftKey: wrapper.shiftKey,
    repeat: wrapper.repeat,
    composing: wrapper.isComposing,
    preventDefault: wrapper.preventDefault,
    isDefaultPrevented: wrapper.isDefaultPrevented,
    isPropagationStopped: wrapper.isPropagationStopped,
  };
  if (
    event === native.event ||
    current.type !== "keydown" ||
    current.nativeEvent !== native.event ||
    current.target !== native.target ||
    current.currentTarget !== currentTarget ||
    current.eventPhase !== eventPhase ||
    current.bubbles !== true ||
    current.cancelable !== true ||
    current.defaultPrevented !== defaultPrevented ||
    current.isTrusted !== true ||
    current.view !== native.publication.ownerWindow ||
    current.key !== native.key ||
    current.code !== native.code ||
    current.location !== native.location ||
    current.locale !== native.locale ||
    current.charCode !== native.charCode ||
    current.keyCode !== native.keyCode ||
    current.which !== native.which ||
    current.detail !== native.detail ||
    current.timeStamp !== native.timeStamp ||
    current.ctrlKey !== false ||
    current.metaKey !== false ||
    current.altKey !== false ||
    current.shiftKey !== false ||
    current.repeat !== false ||
    (current.composing !== undefined && current.composing !== false) ||
    typeof current.preventDefault !== "function" ||
    typeof current.isDefaultPrevented !== "function" ||
    typeof current.isPropagationStopped !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    event,
    nativeEvent: native.event,
    target: native.target,
    currentTarget,
    key: native.key,
    code: native.code,
    location: native.location,
    locale: native.locale,
    charCode: native.charCode,
    keyCode: native.keyCode,
    which: native.which,
    detail: native.detail,
    timeStamp: native.timeStamp,
    view: current.view,
    eventPhase,
    methods: Object.freeze({
      preventDefault: current.preventDefault,
      isDefaultPrevented: current.isDefaultPrevented,
      isPropagationStopped: current.isPropagationStopped,
    }),
    composing: current.composing === false ? false : null,
  });
}

function panelToolbarKeyboardPublicationIsCurrent(
  publication: PanelToolbarKeyboardPublication,
  cells: PanelPublicationCells,
  verifyHistory = true,
) {
  const runtime = publication.runtime;
  const render = publication.render;
  return (
    cells.active.value === runtime &&
    runtime.publication === render &&
    runtime.toolbarKeyboard.value?.publication === publication &&
    !runtime.isRetired() &&
    !cells.retired.has(render) &&
    !cells.claimedPublications.has(render) &&
    panelFactsAreCurrent(render) &&
    panelExactDomIsCurrent(runtime) &&
    (!verifyHistory || runtime.publishedDomMatches()) &&
    publication.dom === runtime.dom &&
    publication.placement === runtime.placement &&
    publication.ownerDocument === runtime.ownerDocument &&
    publication.ownerDocument.defaultView === publication.ownerWindow &&
    publication.toolbar === runtime.toolbar &&
    publication.entries.length === PANEL_TOOLBAR_DEFINITIONS.length &&
    Object.isFrozen(publication) &&
    Object.isFrozen(publication.entries) &&
    publication.entries.every((entry, index) => {
      const fact = render.toolbarActions[index];
      const definition = PANEL_TOOLBAR_DEFINITIONS[index];
      const element =
        entry.fact.control === "refresh" ? runtime.refresh : runtime.close;
      return (
        entry.publicationIdentity === publication.identity &&
        entry.index === index &&
        entry.fact === fact &&
        entry.fact.control === definition.control &&
        entry.fact.label === definition.label &&
        entry.element === element &&
        entry.action.publicationIdentity === publication.identity &&
        entry.action.entryIdentity === entry.identity &&
        entry.action.control === entry.fact.control &&
        entry.action.index === index
      );
    })
  );
}


function createPanelToolbarPublicKeyboardRuntime(
  runtime: PanelPublicationRuntime,
  cells: PanelPublicationCells,
  requestSuccessor: () => void,
): PanelToolbarKeyboardRuntime | null {
  const render = runtime.publication;
  const ownerDocument = runtime.ownerDocument;
  const ownerWindow = ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (
    !ownerWindow ||
    runtime.toolbar.ownerDocument !== ownerDocument ||
    runtime.root.ownerDocument !== ownerDocument
  ) {
    return null;
  }
  const authority = capturePanelToolbarKeyboardAuthority(ownerWindow, true);
  if (
    !authority ||
    !panelToolbarHasPublicScalarAuthority(authority) ||
    !authority.isCurrent()
  ) {
    return null;
  }

  const identity = Symbol("versions-panel-toolbar-keyboard-publication");
  const entries: PanelToolbarKeyboardEntry[] = [];
  for (let index = 0; index < render.toolbarActions.length; index++) {
    const fact = render.toolbarActions[index];
    const element =
      fact?.control === "refresh" ? runtime.refresh : runtime.close;
    const path = fact ? panelToolbarEventPath(ownerDocument, element) : null;
    if (
      !fact ||
      !path ||
      fact.index !== index ||
      runtime.toolbar.children.item(index) !== element
    ) {
      return null;
    }
    const entryIdentity = Symbol(
      `versions-panel-toolbar-${fact.control}-entry`,
    );
    entries.push(
      Object.freeze({
        identity: entryIdentity,
        publicationIdentity: identity,
        fact,
        index,
        element,
        path,
        action: Object.freeze({
          identity: Symbol(
            `versions-panel-toolbar-${fact.control}-keyboard-action`,
          ),
          publicationIdentity: identity,
          entryIdentity,
          control: fact.control,
          index,
        }),
      }),
    );
  }
  const publication: PanelToolbarKeyboardPublication = Object.freeze({
    identity,
    render,
    runtime,
    ownerDocument,
    ownerWindow,
    toolbar: runtime.toolbar,
    entries: Object.freeze(entries),
    dom: runtime.dom,
    placement: runtime.placement,
  });

  let published = false;
  let released = false;
  let successorRequested = false;
  let callbackActive = false;
  let attemptedReactEvents = new WeakSet<object>();
  let claimedReactEvents = new WeakSet<object>();
  let claimedNativeEvents = new WeakSet<globalThis.KeyboardEvent>();
  let listenerAccess: PanelToolbarListenerAccess = {
    identity: Symbol("versions-panel-toolbar-listener-access"),
    pairs: new WeakMap(),
    attempted: new WeakSet(),
    active: true,
  };
  const registeredAccess = listenerAccess;
  let documentCaptureRegistered = false;
  let documentBubbleRegistered = false;
  let windowBubbleRegistered = false;
  const registeredBoundaries = new Set<PanelToolbarKeyboardEntry>();

  const requestCurrentSuccessor = () => {
    if (successorRequested) return;
    successorRequested = true;
    if (callbackActive) return;
    callbackActive = true;
    try {
      requestSuccessor();
    } finally {
      callbackActive = false;
    }
  };
  const publicationIsCurrent = (verifyHistory = true) =>
    !released &&
    registeredAccess.active &&
    listenerAccess === registeredAccess &&
    authority.isCurrent() &&
    panelToolbarKeyboardPublicationIsCurrent(
      publication,
      cells,
      verifyHistory,
    );
  const retireAndRequestSuccessor = () => {
    if (cells.active.value === runtime && !runtime.isRetired()) {
      runtime.retireForAction();
    }
    requestCurrentSuccessor();
  };
  const invokeGuarded = (
    method: (...args: never[]) => unknown,
    receiver: unknown,
    args: readonly unknown[] = [],
  ) => {
    if (callbackActive || released || !registeredAccess.active) return null;
    callbackActive = true;
    try {
      return Object.freeze({
        value: authority.apply(method, receiver, args),
      });
    } catch {
      return null;
    } finally {
      callbackActive = false;
    }
  };
  const readGuarded = <T,>(reader: () => T) => {
    if (callbackActive || released || !registeredAccess.active) return null;
    callbackActive = true;
    try {
      return Object.freeze({ value: reader() });
    } catch {
      return null;
    } finally {
      callbackActive = false;
    }
  };
  const entryForControl = (control: PanelToolbarControl) =>
    publication.entries.find((entry) => entry.fact.control === control) ?? null;
  const rejectPair = (pair: PanelToolbarNativeReactPair) => {
    if (pair.access.pairs.get(pair.native.event) === pair) {
      pair.access.pairs.delete(pair.native.event);
    }
    pair.rejected = true;
    pair.handling = false;
  };
  const readNative = (
    event: Event,
    entry: PanelToolbarKeyboardEntry,
  ): PanelToolbarNativeKeyProof | null => {
    try {
      if (
        !publicationIsCurrent() ||
        authority.getPrototypeOf(event) !== authority.keyboardPrototype ||
        !authority.isTrusted.matches(event) ||
        authority.isTrusted.read(event) !== true ||
        authority.eventType.read(event) !== "keydown" ||
        authority.eventTarget.read(event) !== entry.element ||
        authority.eventCurrentTarget.read(event) !== ownerDocument ||
        authority.eventPhase.read(event) !== ownerWindow.Event.CAPTURING_PHASE ||
        !authority.eventBubbles.read(event) ||
        !authority.eventCancelable.read(event) ||
        authority.eventDefaultPrevented.read(event) ||
        authority.eventCancelBubble.read(event) ||
        authority.keyboardCtrl.read(event) ||
        authority.keyboardMeta.read(event) ||
        authority.keyboardAlt.read(event) ||
        authority.keyboardShift.read(event) ||
        authority.keyboardRepeat.read(event) ||
        authority.keyboardComposing.read(event) ||
        authority.activeElement.read(ownerDocument) !== entry.element ||
        !entry.fact.enabled
      ) {
        return null;
      }
      const key = authority.keyboardKey.read(event);
      const destinationFact = panelToolbarDestination(
        render.toolbarActions,
        entry.fact,
        key,
      );
      const destination =
        destinationFact === null
          ? null
          : publication.entries[destinationFact.index];
      const path = authority.eventPath.call(event);
      const pathTerminal = path.at(-1);
      const view = authority.eventView.read(event);
      if (
        !destination ||
        destination.fact !== destinationFact ||
        !destination.fact.enabled ||
        entry.publicationIdentity !== publication.identity ||
        entry.action.publicationIdentity !== publication.identity ||
        entry.action.entryIdentity !== entry.identity ||
        entry.action.control !== entry.fact.control ||
        !pathTerminal ||
        !panelToolbarPathMatches(entry.path, path)
      ) {
        return null;
      }
      return Object.freeze({
        identity: Symbol("versions-panel-toolbar-native-key"),
        publication,
        entry,
        action: entry.action,
        event: event as globalThis.KeyboardEvent,
        target: entry.element,
        path: Object.freeze([...path]),
        pathTerminal,
        view,
        capturePhase: ownerWindow.Event.CAPTURING_PHASE,
        key,
        code: authority.keyboardCode.read(event),
        location: authority.keyboardLocation.read(event),
        locale: authority.keyboardLocale?.read(event),
        charCode: authority.keyboardCharCode.read(event),
        keyCode: authority.keyboardKeyCode.read(event),
        which: authority.keyboardWhich.read(event),
        detail: authority.eventDetail.read(event),
        timeStamp: authority.eventTimeStamp.read(event),
        destination,
        trusted: true,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        composing: false,
      });
    } catch {
      return null;
    }
  };
  const nativeRemainsExact = (
    native: PanelToolbarNativeKeyProof,
    defaultPrevented: boolean,
  ) => {
    try {
      const path = authority.eventPath.call(native.event);
      return (
        authority.isCurrent() &&
        authority.getPrototypeOf(native.event) === authority.keyboardPrototype &&
        authority.isTrusted.matches(native.event) &&
        authority.isTrusted.read(native.event) === native.trusted &&
        authority.eventType.read(native.event) === "keydown" &&
        authority.eventTarget.read(native.event) === native.target &&
        authority.eventBubbles.read(native.event) &&
        authority.eventCancelable.read(native.event) &&
        authority.eventDefaultPrevented.read(native.event) ===
          defaultPrevented &&
        !authority.eventCancelBubble.read(native.event) &&
        authority.eventView.read(native.event) === native.view &&
        authority.eventTimeStamp.read(native.event) === native.timeStamp &&
        authority.eventDetail.read(native.event) === native.detail &&
        authority.keyboardKey.read(native.event) === native.key &&
        authority.keyboardCode.read(native.event) === native.code &&
        authority.keyboardLocation.read(native.event) === native.location &&
        (!authority.keyboardLocale ||
          authority.keyboardLocale.read(native.event) === native.locale) &&
        authority.keyboardCharCode.read(native.event) === native.charCode &&
        authority.keyboardKeyCode.read(native.event) === native.keyCode &&
        authority.keyboardWhich.read(native.event) === native.which &&
        authority.keyboardCtrl.read(native.event) === native.ctrlKey &&
        authority.keyboardMeta.read(native.event) === native.metaKey &&
        authority.keyboardAlt.read(native.event) === native.altKey &&
        authority.keyboardShift.read(native.event) === native.shiftKey &&
        authority.keyboardRepeat.read(native.event) === native.repeat &&
        authority.keyboardComposing.read(native.event) === native.composing &&
        path.length === native.path.length &&
        path.every((target, index) => target === native.path[index]) &&
        path.at(-1) === native.pathTerminal
      );
    } catch {
      return false;
    }
  };
  const movementRemainsExact = (pair: PanelToolbarNativeReactPair) => {
    const { movement, native } = pair;
    return (
      movement.publication === publication &&
      movement.source === native.entry &&
      movement.destination === native.destination &&
      movement.actions === render.toolbarActions &&
      movement.key === native.key &&
      movement.setToolbarStop === render.setToolbarStop &&
      movement.requestSuccessor === render.requestSuccessor &&
      native.publication === publication &&
      native.action === native.entry.action &&
      native.destination.publicationIdentity === publication.identity
    );
  };
  const stagedPairIsCurrent = (
    pair: PanelToolbarNativeReactPair,
    defaultPrevented = false,
  ) =>
    !pair.rejected &&
    !pair.consumed &&
    !pair.finalizing &&
    pair.access === registeredAccess &&
    registeredAccess.active &&
    listenerAccess === registeredAccess &&
    registeredAccess.pairs.get(pair.native.event) === pair &&
    !claimedNativeEvents.has(pair.native.event) &&
    publicationIsCurrent() &&
    movementRemainsExact(pair) &&
    nativeRemainsExact(pair.native, defaultPrevented) &&
    authority.activeElement.read(ownerDocument) === pair.native.target;
  const reactScalarsRemainExact = (
    proof: PanelToolbarReactKeyProof,
    pair: PanelToolbarNativeReactPair,
    currentTarget: Element | null,
    defaultPrevented: boolean,
    allowUpdatedDefaultQuery: boolean,
  ) => {
    const result = readGuarded(() => {
      const event = proof.event as KeyboardEvent<Element> & {
        isComposing?: unknown;
        locale?: unknown;
      };
      const currentIsDefaultPrevented = event.isDefaultPrevented;
      return {
        nativeEvent: event.nativeEvent,
        type: event.type,
        target: event.target,
        currentTarget: event.currentTarget,
        eventPhase: event.eventPhase,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented,
        isTrusted: event.isTrusted,
        timeStamp: event.timeStamp,
        view: event.view as unknown,
        detail: event.detail,
        key: event.key,
        code: event.code,
        location: event.location,
        locale: event.locale,
        charCode: event.charCode,
        keyCode: event.keyCode,
        which: event.which,
        repeat: event.repeat,
        composing: event.isComposing,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        preventDefault: event.preventDefault,
        isDefaultPrevented: currentIsDefaultPrevented,
        isPropagationStopped: event.isPropagationStopped,
      };
    });
    if (!result) return null;
    const current = result.value;
    const native = pair.native;
    if (
      typeof current.isDefaultPrevented !== "function" ||
      current.nativeEvent !== native.event ||
      current.type !== "keydown" ||
      current.target !== native.target ||
      current.currentTarget !== currentTarget ||
      current.eventPhase !== proof.eventPhase ||
      current.bubbles !== true ||
      current.cancelable !== true ||
      current.defaultPrevented !== defaultPrevented ||
      current.isTrusted !== true ||
      current.timeStamp !== proof.timeStamp ||
      current.view !== proof.view ||
      current.detail !== proof.detail ||
      current.key !== proof.key ||
      current.code !== proof.code ||
      current.location !== proof.location ||
      current.locale !== proof.locale ||
      current.charCode !== proof.charCode ||
      current.keyCode !== proof.keyCode ||
      current.which !== proof.which ||
      current.repeat !== false ||
      (proof.composing === null
        ? current.composing !== undefined
        : current.composing !== false) ||
      current.altKey !== false ||
      current.ctrlKey !== false ||
      current.metaKey !== false ||
      current.shiftKey !== false ||
      current.preventDefault !== proof.methods.preventDefault ||
      current.isPropagationStopped !==
        proof.methods.isPropagationStopped ||
      (!allowUpdatedDefaultQuery &&
        current.isDefaultPrevented !== proof.methods.isDefaultPrevented) ||
      (current.view !== null &&
        pair.windowReceiver !== null &&
        current.view !== publication.ownerWindow &&
        current.view !== native.pathTerminal &&
        current.view !== pair.windowReceiver)
    ) {
      return null;
    }
    return current.isDefaultPrevented as PanelToolbarReactMethod;
  };
  const authenticateReactProof = (
    proof: PanelToolbarReactKeyProof,
    pair: PanelToolbarNativeReactPair,
    currentTarget: Element | null,
    defaultPrevented: boolean,
    allowUpdatedDefaultQuery: boolean,
    baseIsCurrent: () => boolean,
  ) => {
    const currentDefaultQuery = reactScalarsRemainExact(
      proof,
      pair,
      currentTarget,
      defaultPrevented,
      allowUpdatedDefaultQuery,
    );
    if (!currentDefaultQuery || !baseIsCurrent()) return false;
    const defaultResult = invokeGuarded(
      currentDefaultQuery,
      proof.event,
    );
    const verifiedDefaultQuery = reactScalarsRemainExact(
      proof,
      pair,
      currentTarget,
      defaultPrevented,
      allowUpdatedDefaultQuery,
    );
    if (
      defaultResult?.value !== defaultPrevented ||
      !baseIsCurrent() ||
      verifiedDefaultQuery !== currentDefaultQuery
    ) {
      return false;
    }
    const propagationResult = invokeGuarded(
      proof.methods.isPropagationStopped,
      proof.event,
    );
    const finalDefaultQuery = reactScalarsRemainExact(
      proof,
      pair,
      currentTarget,
      defaultPrevented,
      allowUpdatedDefaultQuery,
    );
    return (
      propagationResult?.value === false &&
      baseIsCurrent() &&
      finalDefaultQuery === currentDefaultQuery
    );
  };
  const captureReactProof = (
    event: object,
    currentTarget: Element,
    pair: PanelToolbarNativeReactPair,
  ): PanelToolbarReactKeyProof | null => {
    const result = readGuarded(() => {
      const wrapper = event as KeyboardEvent<Element> & {
        isComposing?: unknown;
        locale?: unknown;
      };
      return {
        nativeEvent: wrapper.nativeEvent,
        type: wrapper.type,
        target: wrapper.target,
        currentTarget: wrapper.currentTarget,
        eventPhase: wrapper.eventPhase,
        bubbles: wrapper.bubbles,
        cancelable: wrapper.cancelable,
        defaultPrevented: wrapper.defaultPrevented,
        isTrusted: wrapper.isTrusted,
        timeStamp: wrapper.timeStamp,
        view: wrapper.view as unknown,
        detail: wrapper.detail,
        key: wrapper.key,
        code: wrapper.code,
        location: wrapper.location,
        locale: wrapper.locale,
        charCode: wrapper.charCode,
        keyCode: wrapper.keyCode,
        which: wrapper.which,
        repeat: wrapper.repeat,
        composing: wrapper.isComposing,
        altKey: wrapper.altKey,
        ctrlKey: wrapper.ctrlKey,
        metaKey: wrapper.metaKey,
        shiftKey: wrapper.shiftKey,
        preventDefault: wrapper.preventDefault,
        isDefaultPrevented: wrapper.isDefaultPrevented,
        isPropagationStopped: wrapper.isPropagationStopped,
      };
    });
    if (!result) return null;
    const current = result.value;
    const native = pair.native;
    if (
      typeof current.preventDefault !== "function" ||
      typeof current.isDefaultPrevented !== "function" ||
      typeof current.isPropagationStopped !== "function" ||
      event === (native.event as unknown) ||
      current.nativeEvent !== native.event ||
      current.type !== "keydown" ||
      current.target !== native.target ||
      current.currentTarget !== currentTarget ||
      current.eventPhase !== authority.eventPhase.read(native.event) ||
      current.bubbles !== true ||
      current.cancelable !== true ||
      current.defaultPrevented !== false ||
      current.isTrusted !== true ||
      current.timeStamp !== native.timeStamp ||
      current.key !== native.key ||
      current.code !== native.code ||
      current.location !== native.location ||
      current.locale !== native.locale ||
      current.charCode !== native.charCode ||
      current.keyCode !== native.keyCode ||
      current.which !== native.which ||
      current.detail !== native.detail ||
      current.repeat !== false ||
      (current.composing !== undefined && current.composing !== false) ||
      current.altKey !== false ||
      current.ctrlKey !== false ||
      current.metaKey !== false ||
      current.shiftKey !== false
    ) {
      return null;
    }
    const proof: PanelToolbarReactKeyProof = Object.freeze({
      event,
      nativeEvent: native.event,
      target: native.target,
      currentTarget,
      eventPhase: current.eventPhase,
      view: current.view,
      key: current.key,
      code: current.code,
      location: current.location,
      locale: current.locale,
      charCode: current.charCode,
      keyCode: current.keyCode,
      which: current.which,
      detail: current.detail,
      timeStamp: current.timeStamp,
      composing: current.composing === false ? false : null,
      methods: Object.freeze({
        preventDefault: current.preventDefault,
        isDefaultPrevented: current.isDefaultPrevented,
        isPropagationStopped: current.isPropagationStopped,
      }),
    });
    return authenticateReactProof(
      proof,
      pair,
      currentTarget,
      false,
      false,
      () => stagedPairIsCurrent(pair),
    )
      ? proof
      : null;
  };
  const pairForReactEvent = (event: object) => {
    const nativeResult = readGuarded(
      () =>
        (event as KeyboardEvent<Element>).nativeEvent as
          | globalThis.KeyboardEvent
          | undefined,
    );
    const nativeEvent = nativeResult?.value;
    return nativeEvent && typeof nativeEvent === "object"
      ? registeredAccess.pairs.get(nativeEvent) ?? null
      : null;
  };
  const recordReactBoundary = (
    event: object,
    currentTarget: Element,
    selectProof: (
      pair: PanelToolbarNativeReactPair,
    ) => PanelToolbarReactKeyProof | null,
    storeProof: (
      pair: PanelToolbarNativeReactPair,
      proof: PanelToolbarReactKeyProof,
    ) => void,
  ) => {
    if (
      callbackActive ||
      released ||
      !event ||
      typeof event !== "object"
    ) {
      return;
    }
    const pair = pairForReactEvent(event);
    if (
      !pair ||
      !stagedPairIsCurrent(pair) ||
      selectProof(pair) ||
      (attemptedReactEvents.has(event) &&
        ![
          pair.reactToolbarCapture?.event,
          pair.reactActionCapture?.event,
          pair.reactActionBubble?.event,
          pair.reactToolbarBubble?.event,
        ].includes(event))
    ) {
      return;
    }
    attemptedReactEvents.add(event);
    const proof = captureReactProof(event, currentTarget, pair);
    if (!proof || !stagedPairIsCurrent(pair)) return;
    storeProof(pair, proof);
  };
  const captureToolbar = (event: KeyboardEvent<HTMLDivElement>) => {
    recordReactBoundary(
      event,
      publication.toolbar,
      (pair) => pair.reactToolbarCapture,
      (pair, proof) => {
        pair.reactToolbarCapture = proof;
      },
    );
  };
  const captureAction = (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const entry = entryForControl(control);
    if (!entry) return;
    const pair = pairForReactEvent(event);
    if (pair?.native.entry !== entry || !pair.reactToolbarCapture) return;
    recordReactBoundary(
      event,
      entry.element,
      (candidate) => candidate.reactActionCapture,
      (candidate, proof) => {
        candidate.reactActionCapture = proof;
      },
    );
  };
  const bubbleAction = (
    control: PanelToolbarControl,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const entry = entryForControl(control);
    if (!entry) return;
    const pair = pairForReactEvent(event);
    if (
      pair?.native.entry !== entry ||
      !pair.boundaryObserved ||
      !pair.reactActionCapture
    ) {
      return;
    }
    recordReactBoundary(
      event,
      entry.element,
      (candidate) => candidate.reactActionBubble,
      (candidate, proof) => {
        candidate.reactActionBubble = proof;
      },
    );
  };
  const bubbleToolbar = (event: KeyboardEvent<HTMLDivElement>) => {
    const pair = pairForReactEvent(event);
    if (!pair?.reactActionBubble) return;
    recordReactBoundary(
      event,
      publication.toolbar,
      (candidate) => candidate.reactToolbarBubble,
      (candidate, proof) => {
        candidate.reactToolbarBubble = proof;
      },
    );
  };
  const allReactProofsAreCurrent = (
    terminal: PanelToolbarTerminalKeyProof,
    pair: PanelToolbarNativeReactPair,
    defaultPrevented: boolean,
    baseIsCurrent: () => boolean,
  ) => {
    const proofs = [
      terminal.toolbarCapture,
      terminal.actionCapture,
      terminal.toolbarBubble,
      terminal.actionBubble,
    ];
    const authenticated = proofs.every((proof) => {
      const wrapperWasPrevented =
        defaultPrevented && proof.event === terminal.actionBubble.event;
      return authenticateReactProof(
        proof,
        pair,
        null,
        wrapperWasPrevented,
        wrapperWasPrevented,
        baseIsCurrent,
      );
    });
    return (
      authenticated &&
      baseIsCurrent() &&
      proofs.every((proof) => {
        const wrapperWasPrevented =
          defaultPrevented &&
          proof.event === terminal.actionBubble.event;
        return reactScalarsRemainExact(
          proof,
          pair,
          null,
          wrapperWasPrevented,
          wrapperWasPrevented,
        ) !== null;
      })
    );
  };
  const terminalForPair = (
    pair: PanelToolbarNativeReactPair,
  ): PanelToolbarTerminalKeyProof | null => {
    const {
      reactToolbarCapture,
      reactActionCapture,
      reactActionBubble,
      reactToolbarBubble,
    } = pair;
    if (
      !pair.boundaryObserved ||
      !pair.documentBubbleObserved ||
      !reactToolbarCapture ||
      !reactActionCapture ||
      !reactActionBubble ||
      !reactToolbarBubble
    ) {
      return null;
    }
    const terminal = Object.freeze({
      native: pair.native,
      movement: pair.movement,
      toolbarCapture: reactToolbarCapture,
      actionCapture: reactActionCapture,
      actionBubble: reactActionBubble,
      toolbarBubble: reactToolbarBubble,
    });
    return allReactProofsAreCurrent(
      terminal,
      pair,
      false,
      () => stagedPairIsCurrent(pair),
    )
      ? terminal
      : null;
  };
  const claimedPairIsCurrent = (
    pair: PanelToolbarNativeReactPair,
    activeElement: HTMLButtonElement,
    defaultPrevented: boolean,
  ) =>
    pair.consumed &&
    pair.finalizing &&
    !pair.rejected &&
    pair.access === registeredAccess &&
    registeredAccess.active &&
    listenerAccess === registeredAccess &&
    claimedNativeEvents.has(pair.native.event) &&
    cells.claimedToolbarPublications.has(publication) &&
    cells.claimedToolbarEntries.has(pair.native.entry) &&
    cells.claimedToolbarEntries.has(pair.native.destination) &&
    cells.claimedToolbarActions.has(pair.native.action) &&
    cells.claimedToolbarActions.has(pair.native.destination.action) &&
    cells.claimedToolbarNativeEvents.has(pair.native.event) &&
    [
      pair.reactToolbarCapture,
      pair.reactActionCapture,
      pair.reactActionBubble,
      pair.reactToolbarBubble,
    ].every(
      (proof) =>
        proof !== null &&
        claimedReactEvents.has(proof.event) &&
        cells.claimedToolbarReactEvents.has(proof.event),
    ) &&
    !released &&
    authority.isCurrent() &&
    cells.active.value === runtime &&
    runtime.toolbarKeyboard.value?.publication === publication &&
    !runtime.isRetired() &&
    panelFactsAreCurrent(render) &&
    panelExactDomIsCurrent(runtime) &&
    runtime.publishedDomMatches() &&
    movementRemainsExact(pair) &&
    nativeRemainsExact(pair.native, defaultPrevented) &&
    pair.windowReceiver !== null &&
    authority.eventCurrentTarget.read(pair.native.event) ===
      pair.native.pathTerminal &&
    authority.eventPhase.read(pair.native.event) ===
      ownerWindow.Event.BUBBLING_PHASE &&
    (pair.native.view === null ||
      pair.native.view === publication.ownerWindow ||
      pair.native.view === pair.windowReceiver) &&
    authority.activeElement.read(ownerDocument) === activeElement;
  const claimPair = (
    pair: PanelToolbarNativeReactPair,
    terminal: PanelToolbarTerminalKeyProof,
  ) => {
    const wrappers = [
      terminal.toolbarCapture.event,
      terminal.actionCapture.event,
      terminal.actionBubble.event,
      terminal.toolbarBubble.event,
    ];
    if (
      cells.claimedToolbarPublications.has(publication) ||
      cells.claimedToolbarEntries.has(pair.native.entry) ||
      cells.claimedToolbarEntries.has(pair.native.destination) ||
      cells.claimedToolbarActions.has(pair.native.action) ||
      cells.claimedToolbarActions.has(pair.native.destination.action) ||
      cells.claimedToolbarNativeEvents.has(pair.native.event) ||
      claimedNativeEvents.has(pair.native.event) ||
      wrappers.some(
        (wrapper) =>
          cells.claimedToolbarReactEvents.has(wrapper) ||
          claimedReactEvents.has(wrapper),
      ) ||
      registeredAccess.pairs.get(pair.native.event) !== pair ||
      !registeredAccess.pairs.delete(pair.native.event)
    ) {
      return false;
    }
    pair.consumed = true;
    pair.finalizing = true;
    claimedNativeEvents.add(pair.native.event);
    cells.claimedToolbarPublications.add(publication);
    cells.claimedToolbarEntries.add(pair.native.entry);
    cells.claimedToolbarEntries.add(pair.native.destination);
    cells.claimedToolbarActions.add(pair.native.action);
    cells.claimedToolbarActions.add(pair.native.destination.action);
    cells.claimedToolbarNativeEvents.add(pair.native.event);
    for (const wrapper of wrappers) {
      claimedReactEvents.add(wrapper);
      cells.claimedToolbarReactEvents.add(wrapper);
    }
    return true;
  };
  const finishClaimedPair = (pair: PanelToolbarNativeReactPair) => {
    pair.finalizing = false;
    pair.handling = false;
    retireAndRequestSuccessor();
  };
  const performClaimedMovement = (
    pair: PanelToolbarNativeReactPair,
    terminal: PanelToolbarTerminalKeyProof,
  ) => {
    const source = pair.native.target;
    const destination = pair.native.destination.element;
    const actionBubble = terminal.actionBubble;
    const beforePrevention = () =>
      claimedPairIsCurrent(pair, source, false);
    if (
      !beforePrevention() ||
      !allReactProofsAreCurrent(terminal, pair, false, beforePrevention)
    ) {
      finishClaimedPair(pair);
      return;
    }
    const prevention = invokeGuarded(
      actionBubble.methods.preventDefault,
      actionBubble.event,
    );
    const afterPrevention = () =>
      claimedPairIsCurrent(pair, source, true);
    if (
      !prevention ||
      !afterPrevention() ||
      !allReactProofsAreCurrent(terminal, pair, true, afterPrevention)
    ) {
      finishClaimedPair(pair);
      return;
    }
    const focused = invokeGuarded(
      authority.focus.call as (...args: never[]) => unknown,
      authority.focus,
      [destination, PANEL_TOOLBAR_PREVENT_SCROLL],
    );
    const afterFocus = () =>
      claimedPairIsCurrent(pair, destination, true);
    if (
      !focused ||
      !afterFocus() ||
      !allReactProofsAreCurrent(terminal, pair, true, afterFocus)
    ) {
      finishClaimedPair(pair);
      return;
    }
    const stopCommitted = invokeGuarded(
      pair.movement.setToolbarStop as (...args: never[]) => unknown,
      undefined,
      [pair.native.destination.fact.control],
    );
    if (
      !stopCommitted ||
      (cells.active.value === runtime &&
        (!claimedPairIsCurrent(pair, destination, true) ||
          !allReactProofsAreCurrent(
            terminal,
            pair,
            true,
            afterFocus,
          )))
    ) {
      finishClaimedPair(pair);
      return;
    }
    finishClaimedPair(pair);
  };
  function onNativeWindowBubble(this: EventTarget, event: Event) {
    const keyboardAuthority = authority;
    const windowAuthority = ownerWindow;
    if (
      !keyboardAuthority ||
      !windowAuthority ||
      callbackActive ||
      released ||
      !registeredAccess.active ||
      listenerAccess !== registeredAccess
    ) {
      return;
    }
    const nativeEvent = event as globalThis.KeyboardEvent;
    const pair = registeredAccess.pairs.get(nativeEvent);
    if (!pair || pair.handling) return;
    pair.handling = true;
    try {
      const path = keyboardAuthority.eventPath.call(event);
      pair.windowReceiver = this;
      const currentTarget =
        keyboardAuthority.eventCurrentTarget.read(event);
      const receiverWindow = this as Window;
      const receiverIsExact =
        this === currentTarget ||
        (currentTarget === publication.ownerWindow &&
          receiverWindow.document === ownerDocument &&
          receiverWindow.window === this);
      if (
        !receiverIsExact ||
        currentTarget !== pair.native.pathTerminal ||
        keyboardAuthority.eventPhase.read(event) !==
          windowAuthority.Event.BUBBLING_PHASE ||
        path.at(-1) !== pair.native.pathTerminal ||
        pair.native.path.length !== path.length ||
        pair.native.path.some((target, index) => target !== path[index]) ||
        (pair.native.view !== null &&
          pair.native.view !== publication.ownerWindow &&
          pair.native.view !== this)
      ) {
        return;
      }
      if (!stagedPairIsCurrent(pair)) {
        rejectPair(pair);
        retireAndRequestSuccessor();
        return;
      }
      const terminal = terminalForPair(pair);
      if (
        !terminal ||
        !stagedPairIsCurrent(pair) ||
        !claimPair(pair, terminal)
      ) {
        rejectPair(pair);
        retireAndRequestSuccessor();
        return;
      }
      performClaimedMovement(pair, terminal);
    } catch {
      rejectPair(pair);
      if (cells.active.value === runtime && !keyboardAuthority.isCurrent()) {
        retireAndRequestSuccessor();
      }
    } finally {
      pair.handling = false;
    }
  }
  const onNativeDocumentCapture: EventListener = (event) => {
    if (
      callbackActive ||
      released ||
      !registeredAccess.active ||
      authority.eventType.read(event) !== "keydown" ||
      registeredAccess.attempted.has(event as globalThis.KeyboardEvent)
    ) {
      return;
    }
    const target = authority.eventTarget.read(event);
    const entry =
      publication.entries.find(({ element }) => element === target) ?? null;
    if (!entry) return;
    const nativeEvent = event as globalThis.KeyboardEvent;
    registeredAccess.attempted.add(nativeEvent);
    const native = readNative(event, entry);
    if (!native || cells.attemptedToolbarNativeEvents.has(nativeEvent)) return;
    cells.attemptedToolbarNativeEvents.add(nativeEvent);
    const movement: PanelToolbarMovement = Object.freeze({
      identity: Symbol("versions-panel-toolbar-movement"),
      publication,
      source: native.entry,
      destination: native.destination,
      actions: render.toolbarActions,
      key: native.key,
      setToolbarStop: render.setToolbarStop,
      requestSuccessor: render.requestSuccessor,
    });
    const pair: PanelToolbarNativeReactPair = {
      native,
      movement,
      access: registeredAccess,
      reactToolbarCapture: null,
      reactActionCapture: null,
      reactActionBubble: null,
      reactToolbarBubble: null,
      boundaryObserved: false,
      documentBubbleObserved: false,
      windowReceiver: null,
      handling: false,
      finalizing: false,
      consumed: false,
      rejected: false,
    };
    if (registeredAccess.pairs.has(nativeEvent)) return;
    registeredAccess.pairs.set(nativeEvent, pair);
    if (!stagedPairIsCurrent(pair)) rejectPair(pair);
  };
  const boundaryListeners = publication.entries.map((entry) => {
    const listener: EventListener = (event) => {
      if (callbackActive || released) return;
      const pair = registeredAccess.pairs.get(
        event as globalThis.KeyboardEvent,
      );
      if (
        !pair ||
        pair.native.entry !== entry ||
        pair.boundaryObserved ||
        !pair.reactToolbarCapture ||
        !pair.reactActionCapture ||
        authority.eventCurrentTarget.read(event) !== entry.element ||
        (authority.eventPhase.read(event) !==
          ownerWindow.Event.CAPTURING_PHASE &&
          authority.eventPhase.read(event) !== ownerWindow.Event.AT_TARGET) ||
        !stagedPairIsCurrent(pair) ||
        !authenticateReactProof(
          pair.reactToolbarCapture,
          pair,
          null,
          false,
          false,
          () => stagedPairIsCurrent(pair),
        ) ||
        !authenticateReactProof(
          pair.reactActionCapture,
          pair,
          null,
          false,
          false,
          () => stagedPairIsCurrent(pair),
        )
      ) {
        if (pair) {
          rejectPair(pair);
          retireAndRequestSuccessor();
        }
        return;
      }
      pair.boundaryObserved = true;
    };
    return Object.freeze({ entry, listener });
  });
  const onNativeDocumentBubble: EventListener = (event) => {
    if (callbackActive || released) return;
    const pair = registeredAccess.pairs.get(
      event as globalThis.KeyboardEvent,
    );
    if (!pair) return;
    if (
      pair.documentBubbleObserved ||
      !pair.boundaryObserved ||
      !pair.reactActionBubble ||
      !pair.reactToolbarBubble ||
      authority.eventCurrentTarget.read(event) !== ownerDocument ||
      authority.eventPhase.read(event) !== ownerWindow.Event.BUBBLING_PHASE ||
      !stagedPairIsCurrent(pair)
    ) {
      rejectPair(pair);
      retireAndRequestSuccessor();
      return;
    }
    pair.documentBubbleObserved = true;
    const terminal = terminalForPair(pair);
    if (!terminal || !stagedPairIsCurrent(pair)) {
      rejectPair(pair);
      retireAndRequestSuccessor();
    }
  };
  const publish = () => {
    if (
      published ||
      released ||
      !authority.isCurrent() ||
      !panelToolbarKeyboardPublicationIsCurrent(publication, cells, false)
    ) {
      return false;
    }
    published = true;
    try {
      authority.addEventListener.call(
        ownerDocument,
        "keydown",
        onNativeDocumentCapture,
        true,
      );
      documentCaptureRegistered = true;
      for (const { entry, listener } of boundaryListeners) {
        authority.addEventListener.call(
          entry.element,
          "keydown",
          listener,
          true,
        );
        registeredBoundaries.add(entry);
      }
      authority.addEventListener.call(
        ownerDocument,
        "keydown",
        onNativeDocumentBubble,
      );
      documentBubbleRegistered = true;
      authority.addWindowEventListener.call(
        ownerWindow,
        "keydown",
        onNativeWindowBubble,
      );
      windowBubbleRegistered = true;
      return true;
    } catch {
      release();
      return false;
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    registeredAccess.active = false;
    registeredAccess.pairs = new WeakMap();
    registeredAccess.attempted = new WeakSet();
    listenerAccess = {
      identity: Symbol("versions-panel-toolbar-revoked-listener-access"),
      pairs: new WeakMap(),
      attempted: new WeakSet(),
      active: false,
    };
    attemptedReactEvents = new WeakSet();
    claimedReactEvents = new WeakSet();
    claimedNativeEvents = new WeakSet();
    if (documentCaptureRegistered) {
      authority.removeEventListener.call(
        ownerDocument,
        "keydown",
        onNativeDocumentCapture,
        true,
      );
      documentCaptureRegistered = false;
    }
    for (const { entry, listener } of boundaryListeners) {
      if (!registeredBoundaries.has(entry)) continue;
      authority.removeEventListener.call(
        entry.element,
        "keydown",
        listener,
        true,
      );
      registeredBoundaries.delete(entry);
    }
    if (documentBubbleRegistered) {
      authority.removeEventListener.call(
        ownerDocument,
        "keydown",
        onNativeDocumentBubble,
      );
      documentBubbleRegistered = false;
    }
    if (windowBubbleRegistered) {
      authority.removeWindowEventListener.call(
        ownerWindow,
        "keydown",
        onNativeWindowBubble,
      );
      windowBubbleRegistered = false;
    }
  };

  return Object.freeze({
    publication,
    publish,
    release,
    captureToolbar,
    captureAction,
    bubbleAction,
    bubbleToolbar,
  });
}

function panelRowKeyboardPublicationIsCurrent(
  publication: PanelRowKeyboardPublication,
  cells: PanelPublicationCells,
  verifyHistory = true,
) {
  const runtime = publication.runtime;
  const render = publication.render;
  if (
    cells.active.value !== runtime ||
    runtime.publication !== render ||
    runtime.rowKeyboard.value?.publication !== publication ||
    runtime.isRetired() ||
    cells.retired.has(render) ||
    cells.claimedPublications.has(render) ||
    !panelFactsAreCurrent(render) ||
    !panelExactDomIsCurrent(runtime) ||
    (verifyHistory && !runtime.publishedDomMatches()) ||
    publication.dom !== runtime.dom ||
    publication.placement !== runtime.placement ||
    publication.ownerDocument !== runtime.ownerDocument ||
    publication.ownerDocument.defaultView !== publication.ownerWindow ||
    publication.entries.length !== render.rows.length ||
    !Object.isFrozen(publication) ||
    !Object.isFrozen(publication.entries)
  ) {
    return false;
  }
  let order = 0;
  for (let groupIndex = 0; groupIndex < render.groups.length; groupIndex++) {
    const group = render.groups[groupIndex];
    const list = runtime.groupLists[groupIndex];
    for (let groupOrder = 0; groupOrder < group.rows.length; groupOrder++) {
      const row = group.rows[groupOrder];
      const entry = publication.entries[order];
      const listItem = list?.children.item(groupOrder) ?? null;
      if (
        !list ||
        !entry ||
        entry.publicationIdentity !== publication.identity ||
        entry.order !== order ||
        entry.groupIndex !== groupIndex ||
        entry.groupOrder !== groupOrder ||
        entry.row !== row ||
        entry.rowIndex !== row.index ||
        render.rows[row.index] !== row ||
        entry.list !== list ||
        entry.element !== runtime.rows[row.index]?.select ||
        entry.element.parentElement?.parentElement?.parentElement !== listItem ||
        entry.action.publicationIdentity !== publication.identity ||
        entry.action.entryIdentity !== entry.identity ||
        entry.action.rowId !== row.id ||
        entry.action.rowIndex !== row.index ||
        entry.action.order !== order
      ) {
        return false;
      }
      order += 1;
    }
  }
  return order === publication.entries.length;
}

function createPanelRowKeyboardRuntime(
  runtime: PanelPublicationRuntime,
  cells: PanelPublicationCells,
  requestSuccessor: () => void,
): PanelRowKeyboardRuntime | null {
  const render = runtime.publication;
  const ownerDocument = runtime.ownerDocument;
  const ownerWindow = ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  if (!ownerWindow || runtime.root.ownerDocument !== ownerDocument) return null;
  const authority = capturePanelToolbarKeyboardAuthority(ownerWindow, true);
  if (
    !authority ||
    !panelToolbarHasPublicScalarAuthority(authority) ||
    !authority.isCurrent()
  ) {
    return null;
  }
  const windowAuthority = ownerWindow;
  const keyboardAuthority = authority;
  const identity = Symbol("versions-panel-row-keyboard-publication");
  const entries: PanelRowKeyboardEntry[] = [];
  for (let groupIndex = 0; groupIndex < render.groups.length; groupIndex++) {
    const group = render.groups[groupIndex];
    const list = runtime.groupLists[groupIndex];
    for (let groupOrder = 0; groupOrder < group.rows.length; groupOrder++) {
      const row = group.rows[groupOrder];
      const element = runtime.rows[row.index]?.select ?? null;
      const path = element ? panelRowEventPath(ownerDocument, element) : null;
      if (
        !list ||
        !element ||
        !path ||
        render.rows[row.index] !== row ||
        list.ownerDocument !== ownerDocument ||
        element.ownerDocument !== ownerDocument ||
        element.parentElement?.parentElement?.parentElement !==
          list.children.item(groupOrder)
      ) {
        return null;
      }
      const order = entries.length;
      const entryIdentity = Symbol(`versions-panel-row-${row.id}-entry`);
      entries.push(
        Object.freeze({
          identity: entryIdentity,
          publicationIdentity: identity,
          row,
          rowIndex: row.index,
          order,
          groupIndex,
          groupOrder,
          list,
          element,
          path,
          action: Object.freeze({
            identity: Symbol(`versions-panel-row-${row.id}-keyboard-action`),
            publicationIdentity: identity,
            entryIdentity,
            rowId: row.id,
            rowIndex: row.index,
            order,
          }),
        }),
      );
    }
  }
  if (entries.length !== render.rows.length) return null;
  const publication: PanelRowKeyboardPublication = Object.freeze({
    identity,
    render,
    runtime,
    ownerDocument,
    ownerWindow,
    entries: Object.freeze(entries),
    dom: runtime.dom,
    placement: runtime.placement,
  });

  let published = false;
  let released = false;
  let successorRequested = false;
  let nativeProof: PanelRowNativeKeyProof | null = null;
  let reactListCapture: PanelRowReactKeyProof | null = null;
  let reactSelectCapture: PanelRowReactKeyProof | null = null;
  let reactSelectBubble: PanelRowReactKeyProof | null = null;
  let reactListBubble: PanelRowReactKeyProof | null = null;
  let boundaryProof: PanelRowNativeKeyProof | null = null;
  let terminal: PanelRowTerminalKeyProof | null = null;
  let windowTerminal: PanelRowTerminalKeyProof | null = null;
  let windowListenerActive = false;
  let callbackActive = false;

  const requestCurrentSuccessor = () => {
    if (successorRequested) return;
    successorRequested = true;
    requestSuccessor();
  };
  const publicationIsCurrent = () => {
    if (
      authority.isCurrent() &&
      panelRowKeyboardPublicationIsCurrent(publication, cells)
    ) {
      return true;
    }
    if (cells.active.value === runtime) {
      runtime.retireForAction();
      requestCurrentSuccessor();
    }
    return false;
  };
  const nativeStillMatches = (proof: PanelRowNativeKeyProof) =>
    authority.isCurrent() &&
    authority.getPrototypeOf(proof.event) === authority.keyboardPrototype &&
    authority.isTrusted.matches(proof.event) &&
    authority.isTrusted.read(proof.event) === proof.trusted &&
    authority.eventType.read(proof.event) === "keydown" &&
    authority.eventTarget.read(proof.event) === proof.target &&
    authority.eventView.read(proof.event) === publication.ownerWindow &&
    authority.eventBubbles.read(proof.event) &&
    authority.eventCancelable.read(proof.event) &&
    authority.keyboardKey.read(proof.event) === proof.key &&
    authority.keyboardCode.read(proof.event) === proof.code &&
    authority.keyboardLocation.read(proof.event) === proof.location &&
    authority.keyboardLocale?.read(proof.event) === proof.locale &&
    authority.keyboardCharCode.read(proof.event) === proof.charCode &&
    authority.keyboardKeyCode.read(proof.event) === proof.keyCode &&
    authority.keyboardWhich.read(proof.event) === proof.which &&
    authority.eventDetail.read(proof.event) === proof.detail &&
    authority.eventTimeStamp.read(proof.event) === proof.timeStamp &&
    authority.keyboardCtrl.read(proof.event) === proof.ctrlKey &&
    authority.keyboardMeta.read(proof.event) === proof.metaKey &&
    authority.keyboardAlt.read(proof.event) === proof.altKey &&
    authority.keyboardShift.read(proof.event) === proof.shiftKey &&
    authority.keyboardRepeat.read(proof.event) === proof.repeat &&
    authority.keyboardComposing.read(proof.event) === proof.composing;
  const entryForRow = (row: VersionRowPublication) =>
    publication.entries.find((entry) => entry.row === row) ?? null;
  const removeWindowListener = () => {
    if (!windowListenerActive) return;
    authority.removeWindowEventListener.call(
      publication.ownerWindow,
      "keydown",
      onNativeWindowBubble,
    );
    windowListenerActive = false;
  };
  const clearProof = (proof?: PanelRowNativeKeyProof) => {
    if (proof && nativeProof !== proof) return;
    removeWindowListener();
    nativeProof = null;
    reactListCapture = null;
    reactSelectCapture = null;
    reactSelectBubble = null;
    reactListBubble = null;
    boundaryProof = null;
    terminal = null;
    windowTerminal = null;
  };
  const rejectObservedEvent = (proof: PanelRowNativeKeyProof) => {
    if (nativeProof !== proof) return;
    clearProof(proof);
    if (cells.active.value === runtime) runtime.retireForAction();
    requestCurrentSuccessor();
  };
  const exactNativeEvent = (
    event: Event,
    entry: PanelRowKeyboardEntry,
    receiver: EventTarget,
  ): PanelRowNativeKeyProof | null => {
    if (
      !publicationIsCurrent() ||
      authority.getPrototypeOf(event) !== authority.keyboardPrototype ||
      !authority.isTrusted.matches(event) ||
      authority.isTrusted.read(event) !== true
    ) {
      return null;
    }
    const key = authority.keyboardKey.read(event);
    const destination = panelRowDestination(publication.entries, entry, key);
    const path = authority.eventPath.call(event);
    if (
      !destination ||
      publication.entries[destination.order] !== destination ||
      authority.eventCurrentTarget.read(event) !== receiver ||
      path.at(-1) !== receiver ||
      authority.eventPhase.read(event) !==
        ownerWindow.Event.CAPTURING_PHASE ||
      !authority.eventBubbles.read(event) ||
      !authority.eventCancelable.read(event) ||
      authority.eventDefaultPrevented.read(event) ||
      authority.eventCancelBubble.read(event) ||
      authority.eventView.read(event) !== ownerWindow ||
      authority.keyboardCtrl.read(event) ||
      authority.keyboardMeta.read(event) ||
      authority.keyboardAlt.read(event) ||
      authority.keyboardShift.read(event) ||
      authority.keyboardRepeat.read(event) ||
      authority.keyboardComposing.read(event) ||
      authority.activeElement.read(ownerDocument) !== entry.element ||
      entry.publicationIdentity !== publication.identity ||
      entry.action.publicationIdentity !== publication.identity ||
      entry.action.entryIdentity !== entry.identity ||
      entry.action.rowId !== entry.row.id ||
      !panelRowPathMatches(entry.path, path) ||
      authority.getOwnPropertyDescriptor(event, "stopPropagation") ||
      authority.getOwnPropertyDescriptor(event, "stopImmediatePropagation")
    ) {
      return null;
    }
    let propagationStopped = false;
    if (
      !authority.defineProperty(event, "stopPropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.eventStopPropagation.call(event);
        },
      }) ||
      !authority.defineProperty(event, "stopImmediatePropagation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: () => {
          propagationStopped = true;
          authority.eventStopImmediatePropagation.call(event);
        },
      })
    ) {
      return null;
    }
    return {
      identity: Symbol("versions-panel-row-native-key"),
      publication,
      entry,
      action: entry.action,
      event: event as globalThis.KeyboardEvent,
      target: entry.element,
      path: Object.freeze([...path]),
      key,
      code: authority.keyboardCode.read(event),
      location: authority.keyboardLocation.read(event),
      locale: authority.keyboardLocale?.read(event),
      charCode: authority.keyboardCharCode.read(event),
      keyCode: authority.keyboardKeyCode.read(event),
      which: authority.keyboardWhich.read(event),
      detail: authority.eventDetail.read(event),
      timeStamp: authority.eventTimeStamp.read(event),
      destination,
      trusted: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      composing: false,
      propagationStopped: () => propagationStopped,
      crossed: false,
    };
  };
  const beginNativeEvent = (event: Event, receiver: EventTarget) => {
    if (
      callbackActive ||
      released ||
      authority.eventType.read(event) !== "keydown" ||
      authority.getPrototypeOf(event) !== authority.keyboardPrototype
    ) {
      return;
    }
    const target = authority.eventTarget.read(event);
    const entry =
      publication.entries.find(({ element }) => element === target) ?? null;
    if (!entry) return;
    if (
      nativeProof &&
      authority.eventPhase.read(nativeProof.event) === ownerWindow.Event.NONE &&
      authority.eventCurrentTarget.read(nativeProof.event) === null
    ) {
      clearProof(nativeProof);
    }
    if (nativeProof) {
      if (nativeProof.event === event) return;
      nativeProof.crossed = true;
      cells.attemptedRowNativeEvents.add(event);
      return;
    }
    if (cells.attemptedRowNativeEvents.has(event)) return;
    cells.attemptedRowNativeEvents.add(event);
    const proof = exactNativeEvent(event, entry, receiver);
    if (!proof) return;
    nativeProof = proof;
  };
  const readGuarded = <T,>(read: () => T) => {
    if (callbackActive || released) return null;
    callbackActive = true;
    try {
      return { value: read() };
    } catch {
      // Public wrapper getters and methods are external callbacks, not publication authority.
      return null;
    } finally {
      callbackActive = false;
    }
  };
  const nativeIsCurrent = (proof: PanelRowNativeKeyProof, prevented = false) =>
    !released &&
    nativeProof === proof &&
    !proof.crossed &&
    !proof.propagationStopped() &&
    nativeStillMatches(proof) &&
    authority.eventDefaultPrevented.read(proof.event) === prevented &&
    !authority.eventCancelBubble.read(proof.event) &&
    authority.activeElement.read(ownerDocument) === proof.target &&
    publicationIsCurrent();
  const authenticateReact = (
    proof: PanelRowReactKeyProof,
    native: PanelRowNativeKeyProof,
    currentTarget: Element | null,
    nativePrevented = false,
    wrapperPrevented = false,
  ) => {
    const readCurrent = () => {
      const current = readGuarded(() =>
        readPanelRowReactKeyProof(
          proof.event,
          native,
          currentTarget,
          proof.eventPhase,
          wrapperPrevented,
        ),
      )?.value;
      return current &&
        current.composing === proof.composing &&
        current.methods.preventDefault === proof.methods.preventDefault &&
        current.methods.isPropagationStopped === proof.methods.isPropagationStopped &&
        (wrapperPrevented ||
          current.methods.isDefaultPrevented === proof.methods.isDefaultPrevented) &&
        nativeIsCurrent(native, nativePrevented)
        ? current
        : null;
    };
    const current = readCurrent();
    if (!current) return false;
    const defaultResult = readGuarded(() =>
      authority.apply(current.methods.isDefaultPrevented, proof.event, []),
    );
    const afterDefault = readCurrent();
    if (
      defaultResult?.value !== wrapperPrevented ||
      !afterDefault ||
      afterDefault.methods.isDefaultPrevented !== current.methods.isDefaultPrevented
    ) {
      return false;
    }
    const propagationResult = readGuarded(() =>
      authority.apply(proof.methods.isPropagationStopped, proof.event, []),
    );
    const afterPropagation = readCurrent();
    return (
      propagationResult?.value === false &&
      afterPropagation !== null &&
      afterPropagation.methods.isDefaultPrevented === current.methods.isDefaultPrevented
    );
  };
  const readReact = (event: object, currentTarget: Element, eventPhase: number) => {
    const native = nativeProof;
    if (
      callbackActive ||
      !native ||
      !event ||
      typeof event !== "object" ||
      authority.eventPhase.read(native.event) !== eventPhase ||
      cells.claimedRowReactEvents.has(event) ||
      (cells.attemptedRowReactEvents.has(event) &&
        ![reactListCapture, reactSelectCapture, reactSelectBubble, reactListBubble]
          .some((proof) => proof?.event === event)) ||
      !nativeIsCurrent(native)
    ) {
      return null;
    }
    cells.attemptedRowReactEvents.add(event);
    const proof = readGuarded(() =>
      readPanelRowReactKeyProof(
        event,
        native,
        currentTarget,
        eventPhase,
      ),
    )?.value;
    return proof && authenticateReact(proof, native, currentTarget) ? proof : null;
  };
  const captureList = (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => {
    if (
      !event ||
      typeof event !== "object" ||
      !nativeProof ||
      nativeProof.entry.groupIndex !== groupIndex ||
      reactListCapture
    ) {
      return;
    }
    reactListCapture = readReact(event, nativeProof.entry.list, ownerWindow.Event.CAPTURING_PHASE);
  };
  const captureSelect = (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const entry = entryForRow(row);
    if (
      !nativeProof ||
      !entry ||
      nativeProof.entry !== entry ||
      !reactListCapture ||
      reactSelectCapture
    ) {
      return;
    }
    reactSelectCapture = readReact(event, entry.element, ownerWindow.Event.CAPTURING_PHASE);
  };
  const bubbleSelect = (
    row: VersionRowPublication,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    const entry = entryForRow(row);
    if (
      !nativeProof ||
      !entry ||
      nativeProof.entry !== entry ||
      !reactSelectCapture ||
      reactSelectBubble
    ) {
      return;
    }
    reactSelectBubble = readReact(event, entry.element, ownerWindow.Event.BUBBLING_PHASE);
  };
  const bubbleList = (
    groupIndex: number,
    event: KeyboardEvent<HTMLUListElement>,
  ) => {
    if (
      !nativeProof ||
      nativeProof.entry.groupIndex !== groupIndex ||
      !reactSelectBubble ||
      reactListBubble
    ) {
      return;
    }
    reactListBubble = readReact(event, nativeProof.entry.list, ownerWindow.Event.BUBBLING_PHASE);
  };
  const authenticateTerminal = (proof: PanelRowNativeKeyProof) => {
    if (
      proof.crossed ||
      boundaryProof !== proof ||
      !reactListCapture ||
      !reactSelectCapture ||
      !reactSelectBubble ||
      !reactListBubble ||
      !nativeStillMatches(proof) ||
      !publicationIsCurrent() ||
      authority.activeElement.read(ownerDocument) !== proof.target
    ) {
      return null;
    }
    return Object.freeze({
      native: proof,
      reactProofs: Object.freeze([
        reactListCapture,
        reactSelectCapture,
        reactSelectBubble,
        reactListBubble,
      ]),
      reactBubble: reactSelectBubble,
    });
  };
  const claim = (proof: PanelRowTerminalKeyProof) => {
    const native = proof.native;
    if (
      cells.claimedRowPublications.has(publication) ||
      cells.claimedRowEntries.has(native.entry) ||
      cells.claimedRowActions.has(native.action) ||
      cells.claimedRowNativeEvents.has(native.event) ||
      proof.reactProofs.some((react) => cells.claimedRowReactEvents.has(react.event))
    ) {
      return false;
    }
    cells.claimedRowPublications.add(publication);
    cells.claimedRowEntries.add(native.entry);
    cells.claimedRowActions.add(native.action);
    cells.claimedRowNativeEvents.add(native.event);
    for (const react of proof.reactProofs) cells.claimedRowReactEvents.add(react.event);
    return true;
  };
  const settleTerminal = (proof: PanelRowTerminalKeyProof) => {
    const native = proof.native;
    if (
      terminal !== proof ||
      windowTerminal !== proof ||
      nativeProof !== native ||
      released ||
      native.crossed ||
      native.propagationStopped() ||
      authority.eventCurrentTarget.read(native.event) !== native.path.at(-1) ||
      authority.eventPhase.read(native.event) !== ownerWindow.Event.BUBBLING_PHASE ||
      authority.eventDefaultPrevented.read(native.event) ||
      authority.eventCancelBubble.read(native.event) ||
      authority.activeElement.read(ownerDocument) !== native.target ||
      !nativeStillMatches(native) ||
      !proof.reactProofs.every((react) => authenticateReact(react, native, null)) ||
      !publicationIsCurrent() ||
      !claim(proof)
    ) {
      rejectObservedEvent(native);
      return;
    }
    const destination = native.destination;
    const prevented = readGuarded(() =>
      authority.apply(proof.reactBubble.methods.preventDefault, proof.reactBubble.event, []),
    );
    const canFocus = Boolean(
      prevented &&
      nativeIsCurrent(native, true) &&
      proof.reactProofs.every((react) =>
        authenticateReact(react, native, null, true, react.event === proof.reactBubble.event),
      ),
    );
    clearProof(native);
    runtime.retireForAction();
    if (canFocus) {
      authority.focus.call(destination.element, PANEL_TOOLBAR_PREVENT_SCROLL);
    }
    requestCurrentSuccessor();
  };
  function onNativeWindowBubble(this: EventTarget, event: Event) {
    const currentTarget = keyboardAuthority.eventCurrentTarget.read(event);
    const path = keyboardAuthority.eventPath.call(event);
    if (
      !terminal ||
      terminal.native.event !== event ||
      currentTarget !== this ||
      keyboardAuthority.eventPhase.read(event) !==
        windowAuthority.Event.BUBBLING_PHASE ||
      keyboardAuthority.eventDefaultPrevented.read(event) ||
      keyboardAuthority.eventCancelBubble.read(event) ||
      terminal.native.propagationStopped() ||
      terminal.native.path.at(-1) !== this ||
      path.at(-1) !== this ||
      !panelRowExactPathMatches(terminal.native.path, path)
    ) {
      if (nativeProof?.event === event) rejectObservedEvent(nativeProof);
      return;
    }
    windowTerminal = terminal;
    settleTerminal(terminal);
  }
  function onNativeCapture(this: EventTarget, event: Event) {
    beginNativeEvent(event, this);
  }
  const onNativeBubble = (event: Event) => {
    const proof = nativeProof;
    if (
      !proof ||
      proof.event !== event ||
      authority.eventCurrentTarget.read(event) !== ownerDocument ||
      authority.eventPhase.read(event) !== ownerWindow.Event.BUBBLING_PHASE ||
      authority.eventDefaultPrevented.read(event) ||
      authority.eventCancelBubble.read(event)
    ) {
      return;
    }
    const authenticated = authenticateTerminal(proof);
    if (!authenticated) {
      rejectObservedEvent(proof);
      return;
    }
    terminal = authenticated;
    windowListenerActive = true;
    authority.addWindowEventListener.call(
      ownerWindow,
      "keydown",
      onNativeWindowBubble,
    );
  };
  const boundaryListeners = publication.entries.map((entry) => {
    const listener = (event: Event) => {
      if (
        nativeProof?.event === event &&
        nativeProof.entry === entry &&
        authority.eventCurrentTarget.read(event) === entry.element &&
        (authority.eventPhase.read(event) ===
          ownerWindow.Event.CAPTURING_PHASE ||
          authority.eventPhase.read(event) === ownerWindow.Event.AT_TARGET) &&
        publicationIsCurrent() &&
        authority.activeElement.read(ownerDocument) === entry.element
      ) {
        boundaryProof = nativeProof;
      }
    };
    return Object.freeze({ entry, listener });
  });
  const publish = () => {
    if (
      published ||
      released ||
      !authority.isCurrent() ||
      !panelRowKeyboardPublicationIsCurrent(publication, cells, false)
    ) {
      return false;
    }
    published = true;
    // Window capture precedes React even when Next delegates from the document itself.
    authority.addWindowEventListener.call(
      ownerWindow,
      "keydown",
      onNativeCapture,
      true,
    );
    authority.addEventListener.call(ownerDocument, "keydown", onNativeBubble);
    for (const { entry, listener } of boundaryListeners) {
      authority.addEventListener.call(entry.element, "keydown", listener, true);
    }
    return true;
  };
  const release = () => {
    if (released) return;
    released = true;
    clearProof();
    if (!published) return;
    authority.removeWindowEventListener.call(
      ownerWindow,
      "keydown",
      onNativeCapture,
      true,
    );
    authority.removeEventListener.call(ownerDocument, "keydown", onNativeBubble);
    for (const { entry, listener } of boundaryListeners) {
      authority.removeEventListener.call(
        entry.element,
        "keydown",
        listener,
        true,
      );
    }
  };

  return Object.freeze({
    publication,
    publish,
    release,
    captureList,
    captureSelect,
    bubbleSelect,
    bubbleList,
  });
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
  const toolbarOwner = new PanelElementOwner<HTMLDivElement>(onElementChange);
  const panelOwners = {
    close: new PanelElementOwner<HTMLButtonElement>(onElementChange),
    refresh: new PanelElementOwner<HTMLButtonElement>(onElementChange),
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
    refresh: action("refresh", null),
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
    toolbarOwner,
    panelOwners.close,
    panelOwners.refresh,
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
    const toolbar = toolbarOwner.element();
    const close = panelOwners.close.element();
    const refresh = panelOwners.refresh.element();
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
      !toolbar ||
      !close ||
      !refresh ||
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
      toolbar,
      close,
      refresh,
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
    const toolbarKeyboard = {
      value: null as PanelToolbarKeyboardRuntime | null,
    };
    const rowKeyboard = {
      value: null as PanelRowKeyboardRuntime | null,
    };

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
      toolbarKeyboard.value?.release();
      toolbarKeyboard.value = null;
      rowKeyboard.value?.release();
      rowKeyboard.value = null;
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
      toolbarKeyboard,
      rowKeyboard,
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
        toolbarKeyboard.value = createPanelToolbarPublicKeyboardRuntime(
          runtime,
          cells,
          requestSuccessor,
        );
        if (!toolbarKeyboard.value?.publish()) return false;
        rowKeyboard.value = createPanelRowKeyboardRuntime(
          runtime,
          cells,
          requestSuccessor,
        );
        return rowKeyboard.value?.publish() ?? false;
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
        toolbarKeyboard.value?.release();
        toolbarKeyboard.value = null;
        rowKeyboard.value?.release();
        rowKeyboard.value = null;
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
    captureToolbar: toolbarOwner.capture,
    capturePanel: Object.freeze({
      close: panelOwners.close.capture,
      refresh: panelOwners.refresh.capture,
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
    captureToolbarKeyDown: (event) => {
      currentRuntime?.toolbarKeyboard.value?.captureToolbar(event);
    },
    captureToolbarActionKeyDown: (control, event) => {
      currentRuntime?.toolbarKeyboard.value?.captureAction(control, event);
    },
    toolbarActionKeyDown: (control, event) => {
      currentRuntime?.toolbarKeyboard.value?.bubbleAction(control, event);
    },
    toolbarKeyDown: (event) => {
      currentRuntime?.toolbarKeyboard.value?.bubbleToolbar(event);
    },
    captureRowListKeyDown: (groupIndex, event) => {
      currentRuntime?.rowKeyboard.value?.captureList(groupIndex, event);
    },
    captureRowSelectKeyDown: (row, event) => {
      currentRuntime?.rowKeyboard.value?.captureSelect(row, event);
    },
    rowSelectKeyDown: (row, event) => {
      currentRuntime?.rowKeyboard.value?.bubbleSelect(row, event);
    },
    rowListKeyDown: (groupIndex, event) => {
      currentRuntime?.rowKeyboard.value?.bubbleList(groupIndex, event);
    },
    claimPanel: (control, event) => {
      const runtime = cells.active.value;
      const source = event?.currentTarget;
      const expected =
        control === "close"
          ? runtime?.close
          : control === "refresh"
            ? runtime?.refresh
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
  const [refreshState, setRefreshState] = useState<ListOperation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [previewState, setPreviewState] = useState<PreviewOperation | null>(null);
  const [mutationState, setMutationState] = useState<VersionMutationOwner | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [publicationRevision, setPublicationRevision] = useState(0);
  const [, setPublicationSuccessor] = useState(0);
  const [requestedToolbarStop, setRequestedToolbarStop] =
    useState<PanelToolbarControl>("refresh");
  const setToolbarStop = useCallback((control: PanelToolbarControl) => {
    setRequestedToolbarStop(control);
  }, []);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationSuccessor((revision) => revision + 1);
  }, []);
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
    attemptedToolbarReactEvents: new WeakSet<object>(),
    attemptedToolbarNativeEvents: new WeakSet<Event>(),
    claimedToolbarPublications:
      new WeakSet<PanelToolbarKeyboardPublication>(),
    claimedToolbarEntries: new WeakSet<PanelToolbarKeyboardEntry>(),
    claimedToolbarActions: new WeakSet<PanelToolbarKeyboardAction>(),
    claimedToolbarReactEvents: new WeakSet<object>(),
    claimedToolbarNativeEvents: new WeakSet<Event>(),
    attemptedRowReactEvents: new WeakSet<object>(),
    attemptedRowNativeEvents: new WeakSet<Event>(),
    claimedRowPublications: new WeakSet<PanelRowKeyboardPublication>(),
    claimedRowEntries: new WeakSet<PanelRowKeyboardEntry>(),
    claimedRowActions: new WeakSet<PanelRowKeyboardAction>(),
    claimedRowReactEvents: new WeakSet<object>(),
    claimedRowNativeEvents: new WeakSet<Event>(),
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
      visit: Symbol("versions-panel-visit"),
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
      refresh: null,
      selected,
      compare,
      compareValues: compare,
      preview: previewState,
      mutation: null,
      mutationPhase: null,
      renaming,
      draft,
      canEdit,
      toolbarStop: "refresh",
      toolbarActions: Object.freeze([]),
      setToolbarStop,
      requestSuccessor: requestPublicationSuccessor,
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
      refresh: null,
      selected,
      compare,
      compareValues: compare,
      preview: currentPreview,
      mutation: mutationState,
      mutationPhase: mutationState.phase,
      renaming,
      draft,
      canEdit,
      toolbarStop: "refresh",
      toolbarActions: Object.freeze([]),
      setToolbarStop,
      requestSuccessor: requestPublicationSuccessor,
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
      refresh: null,
      selected,
      compare,
      compareValues: compare,
      preview: currentPreview,
      mutation: currentMutation,
      mutationPhase: currentMutation?.phase ?? null,
      renaming,
      draft,
      canEdit,
      toolbarStop: "refresh",
      toolbarActions: Object.freeze([]),
      setToolbarStop,
      requestSuccessor: requestPublicationSuccessor,
      revision: publicationRevision,
    })
      ? retryState
      : null;
  const currentRefresh =
    refreshState &&
    refreshMatchesPresentation(refreshState, {
      mount,
      authority,
      refreshKey,
      versions,
      rows,
      groups: [],
      error,
      listError,
      retry: currentRetry,
      refresh: refreshState,
      selected,
      compare,
      compareValues: compare,
      preview: currentPreview,
      mutation: currentMutation,
      mutationPhase: currentMutation?.phase ?? null,
      renaming,
      draft,
      canEdit,
      toolbarStop: "refresh",
      toolbarActions: Object.freeze([]),
      setToolbarStop,
      requestSuccessor: requestPublicationSuccessor,
      revision: publicationRevision,
    })
      ? refreshState
      : null;
  const mutationBusy = currentMutation !== null;
  const previewBusy = currentPreview?.busyVersionId ?? null;
  const retrying = currentRetry !== null;
  const refreshing = currentRefresh !== null;
  const currentToolbarStop = panelToolbarStop(
    requestedToolbarStop,
    !refreshing,
  );
  useEffect(() => {
    if (requestedToolbarStop !== currentToolbarStop) {
      setRequestedToolbarStop(currentToolbarStop);
    }
  }, [currentToolbarStop, requestedToolbarStop]);
  const toolbarActions: readonly PanelToolbarActionFact[] = Object.freeze(
    PANEL_TOOLBAR_DEFINITIONS.map((definition, index) =>
      Object.freeze({
        control: definition.control,
        index,
        label: definition.label,
        enabled: definition.control === "refresh" ? !refreshing : true,
        tabStop: definition.control === currentToolbarStop,
      }),
    ),
  );
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
    refresh: currentRefresh,
    selected,
    compare,
    compareValues: Object.freeze([...compare]),
    preview: currentPreview,
    mutation: currentMutation,
    mutationPhase: currentMutation?.phase ?? null,
    renaming,
    draft,
    canEdit,
    toolbarStop: currentToolbarStop,
    toolbarActions,
    setToolbarStop,
    requestSuccessor: requestPublicationSuccessor,
    revision: publicationRevision,
  });
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
      const current = currentPublicationFor(
        operation.authority,
        operation.root,
      );
      if (
        listOperation.current !== operation ||
        operation.refreshKey !== refreshKey ||
        !current ||
        !sameVersionPresentation(
          operation.activation.versions,
          operation.activation.rows,
          current,
        )
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
    options?: {
      intent?: "initial" | "external" | "manual" | "retry";
      mutation?: VersionMutationOwner;
    },
  ) => {
    const runtime = publicationCells.active.value;
    const current = runtime?.publication;
    const intent = options?.mutation
      ? "mutation"
      : options?.intent ?? "initial";
    if (
      !current ||
      current.authority !== loadAuthority ||
      !runtime?.root ||
      !publicationDomIsCurrent(current, true) ||
      (!options?.mutation &&
        intent !== "retry" &&
        mutationOwner.current !== null) ||
      (options?.mutation && !ownsMutation(options.mutation))
    ) {
      return false;
    }
    const pending = listOperation.current;
    if (
      intent === "manual" &&
      pending?.intent === "manual" &&
      ownsListOperation(pending)
    ) {
      return false;
    }
    const operation: ListOperation = {
      operationId: ++listSequence.current,
      activation: current,
      authority: loadAuthority,
      root: runtime.root,
      refreshKey: loadRefreshKey,
      intent,
      mutation: options?.mutation ?? null,
    };
    listOperation.current = operation;
    setRetryState(intent === "retry" ? operation : null);
    setRefreshState(intent === "manual" ? operation : null);
    const ownsRequest = () => ownsListOperation(operation);
    try {
      const list = await fetchVersions(loadAuthority.documentId, {
        fresh: operation.intent !== "initial",
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
        setRetryState((candidate) =>
          candidate === operation ? null : candidate,
        );
        setRefreshState((candidate) =>
          candidate === operation ? null : candidate,
        );
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
      void load(authority, refreshKey, {
        intent: firstLoad ? "initial" : "external",
      });
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
    setRefreshState(null);
    invalidatePreview();
    invalidateMutation();
    candidate.authority.onPreview(null);
    candidate.authority.onClose();
  };

  const retry = (candidate: PanelRenderPublication, event: MouseEvent<HTMLButtonElement>) => {
    if (!claimPanelControl(candidate, "retry", event)) return;
    setPublicationRevision((current) => current + 1);
    void load(candidate.authority, candidate.refreshKey, { intent: "retry" });
  };

  const refreshList = (
    candidate: PanelRenderPublication,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (!claimPanelControl(candidate, "refresh", event)) return;
    setPublicationRevision((current) => current + 1);
    void load(candidate.authority, candidate.refreshKey, { intent: "manual" });
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
      if (refreshState?.authority !== publication.authority) {
        setRefreshState(null);
      }
      if (previewState?.authority !== publication.authority) setPreviewState(null);
      if (mutationState?.authority !== publication.authority) setMutationState(null);
    } else {
      const pendingList = listOperation.current;
      if (pendingList && (pendingList.refreshKey !== publication.refreshKey || rootChanged)) {
        listOperation.current = null;
        setRetryState((candidate) => (candidate === pendingList ? null : candidate));
        setRefreshState((candidate) =>
          candidate === pendingList ? null : candidate,
        );
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
    refreshState?.authority,
    retryState?.authority,
  ]);
  useLayoutEffect(() => publicationSet.establish(), [publicationSet]);

  const {
    captureRoot,
    captureToolbar,
    capturePanel,
    captureGroups,
    captureRows,
    captureToolbarKeyDown,
    captureToolbarActionKeyDown,
    toolbarActionKeyDown,
    toolbarKeyDown,
    captureRowListKeyDown,
    captureRowSelectKeyDown,
    rowSelectKeyDown,
    rowListKeyDown,
  } = publicationSet;
  const {
    close: captureClose,
    refresh: captureRefresh,
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
        <div
          ref={captureToolbar}
          className={PANEL_TOOLBAR_CLASS}
          role="toolbar"
          aria-label={PANEL_TOOLBAR_LABEL}
          aria-orientation="horizontal"
          onKeyDownCapture={captureToolbarKeyDown}
          onKeyDown={toolbarKeyDown}
        >
          <button
            ref={captureRefresh}
            type="button"
            className="icon-btn h-8 w-8"
            onClick={(event) => refreshList(publication, event)}
            onKeyDownCapture={(event) =>
              captureToolbarActionKeyDown("refresh", event)
            }
            onKeyDown={(event) =>
              toolbarActionKeyDown("refresh", event)
            }
            tabIndex={
              publication.toolbarActions[0]?.tabStop ? 0 : -1
            }
            disabled={refreshing}
            aria-label="Refresh versions"
            aria-busy={refreshing || undefined}
            title="Refresh versions"
          >
            <RefreshCw
              size={15}
              className={refreshing ? "animate-spin" : undefined}
            />
          </button>
          <button
            ref={captureClose}
            type="button"
            className="icon-btn h-8 w-8"
            onClick={(event) => close(publication, event)}
            onKeyDownCapture={(event) =>
              captureToolbarActionKeyDown("close", event)
            }
            onKeyDown={(event) =>
              toolbarActionKeyDown("close", event)
            }
            tabIndex={
              publication.toolbarActions[1]?.tabStop ? 0 : -1
            }
            aria-label="Close version history"
          >
            <X size={16} />
          </button>
        </div>
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
                onKeyDownCapture={(event) =>
                  captureRowListKeyDown(groupIndex, event)
                }
                onKeyDown={(event) => rowListKeyDown(groupIndex, event)}
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
                          onKeyDownCapture={(event) =>
                            captureRowSelectKeyDown(row, event)
                          }
                          onKeyDown={(event) => rowSelectKeyDown(row, event)}
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

type VersionDiffNavigationKey = "Home" | "End";
type VersionDiffActionNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";
type VersionDiffActionKind = "swap" | "previous" | "next";

interface VersionDiffVersionFact {
  readonly source: VersionSummary;
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

interface VersionDiffBaseFact {
  readonly source: NonNullable<VersionPreview["base"]>;
  readonly version: VersionDiffVersionFact;
  readonly content: string;
}

interface VersionDiffHunkFact {
  readonly index: number;
  readonly source: Hunk;
  readonly start: number;
  readonly end: number;
  readonly kind: Hunk["kind"];
}

interface VersionDiffAuthority {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly documentId: string;
  readonly role: CollabSession["role"];
  readonly ytext: CollabSession["ytext"];
  readonly preview: VersionPreview;
  readonly version: VersionDiffVersionFact;
  readonly content: string;
  readonly base: VersionDiffBaseFact | null;
  readonly rangeSource: VersionSummary[] | undefined;
  readonly range: readonly VersionDiffVersionFact[];
  readonly current: string;
  readonly swapped: boolean;
  readonly oldText: string;
  readonly newText: string;
  readonly segments: DiffSegment[];
  readonly hunkList: Hunk[];
  readonly hunks: readonly VersionDiffHunkFact[];
  readonly active: number;
  readonly setActive: (index: number) => void;
  readonly actions: readonly VersionDiffActionFact[];
  readonly requestSuccessor: () => void;
}

interface VersionDiffActionFact {
  readonly identity: symbol;
  readonly kind: VersionDiffActionKind;
  readonly order: number;
  readonly callback: () => void;
  readonly eligible: boolean;
}

interface VersionDiffDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly VersionDiffDomSnapshot[];
}

interface VersionDiffNodePlacement {
  readonly node: Node;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
  readonly exactSiblings: boolean;
}

interface VersionDiffPlacement {
  readonly document: Document;
  readonly chain: readonly VersionDiffNodePlacement[];
}

interface VersionDiffDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface VersionDiffNativeKeyboardFacts {
  readonly type: string;
  readonly phase: number;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly cancelBubble: boolean;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly path: readonly EventTarget[];
  readonly isTrusted: boolean;
  readonly view: Window | null;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

interface VersionDiffWindowMethod<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface VersionDiffKeyboardIntrinsics {
  readonly keyboardPrototype: object;
  readonly capturingPhase: number;
  readonly bubblingPhase: number;
  readonly apply: typeof Reflect.apply;
  readonly getPrototypeOf: typeof Object.getPrototypeOf;
  readonly read: (event: object) => VersionDiffNativeKeyboardFacts | null;
  readonly defaultWasPrevented: (event: globalThis.Event) => boolean;
  readonly activeElement: () => Element | null | undefined;
  readonly preventDefault: (event: globalThis.Event) => boolean;
  readonly reveal: (element: Element) => boolean;
  readonly focus: (element: HTMLElement) => boolean;
  readonly addEventListener: VersionDiffWindowMethod<Window["addEventListener"]>;
  readonly removeEventListener: VersionDiffWindowMethod<
    Window["removeEventListener"]
  >;
  readonly isCurrent: () => boolean;
  readonly methodMatches: (
    event: object,
    property: PropertyKey,
    method: unknown,
  ) => boolean;
}

interface VersionDiffWindowProof {
  readonly identity: symbol;
  readonly publication: VersionDiffPublication;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly source: HTMLElement;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
  readonly snapshot: VersionDiffNativeKeyboardFacts;
}

interface VersionDiffKeyListener {
  readonly listener: EventListener;
  readonly activate: (publication: VersionDiffPublication) => boolean;
  readonly proofFor: (
    event: globalThis.KeyboardEvent,
    publication: VersionDiffPublication,
  ) => VersionDiffWindowProof | null;
  readonly claim: (
    proof: VersionDiffWindowProof,
    publication: VersionDiffPublication,
  ) => boolean;
  readonly retains: (
    proof: VersionDiffWindowProof,
    publication: VersionDiffPublication,
  ) => boolean;
  readonly release: (publication: VersionDiffPublication) => void;
}

interface VersionDiffPublishedAction {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly fact: VersionDiffActionFact;
  readonly element: HTMLButtonElement;
  readonly order: number;
}

interface VersionDiffActionMovement {
  readonly identity: symbol;
  readonly key: VersionDiffActionNavigationKey;
  readonly source: VersionDiffPublishedAction;
  readonly destination: VersionDiffPublishedAction | null;
}

interface VersionDiffReactMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly stopPropagation: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
  readonly persist: (...args: never[]) => unknown;
}

interface VersionDiffActionDelivery {
  readonly publication: VersionDiffPublication;
  readonly wrapper: KeyboardEvent<HTMLElement>;
  readonly methods: VersionDiffReactMethods;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: VersionDiffWindowProof;
  readonly currentTarget: HTMLElement;
  readonly dispatchTarget: EventTarget;
  readonly source: HTMLButtonElement;
  readonly action: VersionDiffPublishedAction;
  readonly key: VersionDiffActionNavigationKey;
  readonly snapshot: VersionDiffNativeKeyboardFacts;
}

interface VersionDiffBoundaryMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface VersionDiffBoundaryDelivery {
  readonly publication: VersionDiffBoundaryPublication;
  readonly wrapper: KeyboardEvent<HTMLDivElement>;
  readonly methods: VersionDiffBoundaryMethods;
  readonly nativeEvent: globalThis.KeyboardEvent;
  readonly listener: VersionDiffWindowProof;
  readonly key: VersionDiffNavigationKey;
  readonly snapshot: VersionDiffNativeKeyboardFacts;
  readonly destination: HTMLElement;
  readonly destinationIndex: number;
  readonly setActive: (index: number) => void;
  readonly requestSuccessor: () => void;
}

interface VersionDiffBoundaryAttempt {
  readonly identity: symbol;
  reentered: boolean;
}

interface VersionDiffBoundaryClaim {
  readonly identity: symbol;
  readonly publication: VersionDiffPublication;
  readonly capture: VersionDiffBoundaryDelivery;
  readonly bubble: VersionDiffBoundaryDelivery;
  readonly listener: VersionDiffWindowProof;
}

interface VersionDiffBoundaryPairing {
  readonly begin: (
    nativeEvent: globalThis.KeyboardEvent,
  ) => VersionDiffBoundaryAttempt | null;
  readonly attemptIsCurrent: (
    nativeEvent: globalThis.KeyboardEvent,
    attempt: VersionDiffBoundaryAttempt,
  ) => boolean;
  readonly finish: (
    nativeEvent: globalThis.KeyboardEvent,
    attempt: VersionDiffBoundaryAttempt,
  ) => void;
  readonly remember: (
    delivery: VersionDiffBoundaryDelivery,
    publication: VersionDiffPublication,
  ) => boolean;
  readonly captureFor: (
    nativeEvent: globalThis.KeyboardEvent,
    publication: VersionDiffPublication,
  ) => VersionDiffBoundaryDelivery | null;
  readonly canClaim: (
    capture: VersionDiffBoundaryDelivery,
    bubble: VersionDiffBoundaryDelivery,
    publication: VersionDiffPublication,
  ) => boolean;
  readonly claim: (
    capture: VersionDiffBoundaryDelivery,
    bubble: VersionDiffBoundaryDelivery,
    publication: VersionDiffPublication,
  ) => VersionDiffBoundaryClaim | null;
  readonly retains: (
    claim: VersionDiffBoundaryClaim,
    publication: VersionDiffPublication,
  ) => boolean;
  readonly release: (publication: VersionDiffPublication) => void;
}

interface VersionDiffPublication {
  readonly identity: symbol;
  readonly authority: VersionDiffAuthority;
  readonly root: HTMLDivElement;
  readonly rootParent: Node;
  readonly header: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly hunks: readonly HTMLElement[];
  readonly actionElements: Readonly<
    Record<VersionDiffActionKind, HTMLButtonElement | null>
  >;
  readonly actions: readonly VersionDiffPublishedAction[];
  readonly movements: readonly VersionDiffActionMovement[];
  readonly rootPath: readonly EventTarget[];
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly dom: VersionDiffDomSnapshot;
  readonly placement: VersionDiffPlacement;
  readonly keyboard: VersionDiffKeyboardIntrinsics | null;
  readonly keyListener: VersionDiffKeyListener | null;
  readonly boundaryPairing: VersionDiffBoundaryPairing | null;
}

interface VersionDiffBoundaryPublication extends VersionDiffPublication {
  readonly keyboard: VersionDiffKeyboardIntrinsics;
  readonly keyListener: VersionDiffKeyListener;
  readonly boundaryPairing: VersionDiffBoundaryPairing;
}

function versionDiffHasBoundaryPublication(
  publication: VersionDiffPublication,
): publication is VersionDiffBoundaryPublication {
  return (
    publication.keyboard !== null &&
    publication.keyListener !== null &&
    publication.boundaryPairing !== null
  );
}

interface VersionDiffElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface VersionDiffRefReplay {
  readonly owner: VersionDiffElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface VersionDiffReplay {
  readonly source: VersionDiffPublication;
  readonly dom: VersionDiffDomSnapshot;
  readonly placement: VersionDiffPlacement;
  readonly hunks: readonly HTMLElement[];
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface VersionDiffPublicationRuntime {
  readonly publication: VersionDiffPublication;
  readonly publish: (owners: readonly VersionDiffElementOwnerView[]) => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: VersionDiffElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly historyIsClean: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replay: () => VersionDiffReplay;
}

interface VersionDiffPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureHeader: (element: HTMLDivElement | null) => void;
  readonly captureBody: (element: HTMLDivElement | null) => void;
  readonly captureSwap: (element: HTMLButtonElement | null) => void;
  readonly capturePrevious: (element: HTMLButtonElement | null) => void;
  readonly captureNext: (element: HTMLButtonElement | null) => void;
  readonly captureHunks: readonly ((element: HTMLElement | null) => void)[];
  readonly root: () => HTMLDivElement | null;
  readonly establish: () => (() => void) | undefined;
  readonly onBoundaryKeyCapture: (
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onBoundaryKey: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onActionGroupKeyDownCapture: (
    event: KeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onActionGroupKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly actionHandlers: Readonly<
    Record<
      VersionDiffActionKind,
      Readonly<{
        onKeyDownCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
      }>
    >
  >;
}

class VersionDiffCoordinator {
  readonly #mount: symbol;
  #active: VersionDiffPublication | null = null;
  #successorOf: VersionDiffPublication | null = null;
  #replay: VersionDiffReplay | null = null;
  #retired = new WeakSet<VersionDiffPublication>();
  #claimedPublications = new WeakSet<VersionDiffPublication>();
  #claimedEvents = new WeakSet<object>();
  #claimedMovements = new WeakSet<VersionDiffActionMovement>();
  #claimedProofs = new WeakSet<VersionDiffWindowProof>();
  #claimedActions = new WeakSet<VersionDiffPublishedAction>();

  constructor(mount: symbol) {
    this.#mount = mount;
  }

  replay() {
    return this.#replay;
  }

  acceptsSuccessorOf(publication: VersionDiffPublication) {
    return (
      this.#active === null &&
      this.#successorOf === publication &&
      this.#retired.has(publication) &&
      !this.#claimedPublications.has(publication)
    );
  }

  stageReplay(replay: VersionDiffReplay) {
    if (!this.acceptsSuccessorOf(replay.source)) return false;
    this.#replay = replay;
    return true;
  }

  abandonReplay(publication: VersionDiffPublication) {
    if (this.#replay?.source === publication) {
      this.#replay.release();
      this.#replay = null;
    }
    if (this.#successorOf === publication) this.#successorOf = null;
  }

  publish(publication: VersionDiffPublication) {
    if (
      publication.authority.mount !== this.#mount ||
      this.#retired.has(publication)
    ) {
      return false;
    }
    const previous = this.#active;
    if (previous && previous !== publication) this.retire(previous);
    this.#replay?.release();
    this.#active = publication;
    this.#successorOf = null;
    this.#replay = null;
    return true;
  }

  retire(publication: VersionDiffPublication) {
    if (this.#retired.has(publication)) return false;
    this.#retired.add(publication);
    if (this.#active === publication) {
      this.#active = null;
      this.#successorOf = publication;
    }
    return true;
  }

  isCurrent(publication: VersionDiffPublication) {
    return this.#active === publication && !this.#retired.has(publication);
  }

  claimKeyboard(
    publication: VersionDiffPublication,
    event: object,
    nativeEvent: globalThis.KeyboardEvent,
  ) {
    if (!this.canClaimKeyboard(publication, event, nativeEvent)) return false;
    this.#claimedPublications.add(publication);
    this.#claimedEvents.add(event);
    this.#claimedEvents.add(nativeEvent);
    return true;
  }

  canClaimKeyboard(
    publication: VersionDiffPublication,
    event: object,
    nativeEvent: globalThis.KeyboardEvent,
  ) {
    return (
      this.isCurrent(publication) &&
      !this.#claimedPublications.has(publication) &&
      !this.#claimedEvents.has(event) &&
      !this.#claimedEvents.has(nativeEvent)
    );
  }

  retainsKeyboard(
    publication: VersionDiffPublication,
    event: object,
    nativeEvent: globalThis.KeyboardEvent,
  ) {
    return (
      this.isCurrent(publication) &&
      this.#claimedPublications.has(publication) &&
      this.#claimedEvents.has(event) &&
      this.#claimedEvents.has(nativeEvent)
    );
  }

  claimActionKeyboard(
    publication: VersionDiffPublication,
    movement: VersionDiffActionMovement,
    capture: object,
    bubble: object,
    nativeEvent: globalThis.KeyboardEvent,
    proof: VersionDiffWindowProof,
    source: VersionDiffPublishedAction,
    destination: VersionDiffPublishedAction,
  ) {
    if (
      !this.isCurrent(publication) ||
      this.#claimedPublications.has(publication) ||
      this.#claimedMovements.has(movement) ||
      this.#claimedEvents.has(capture) ||
      this.#claimedEvents.has(bubble) ||
      this.#claimedEvents.has(nativeEvent) ||
      this.#claimedProofs.has(proof) ||
      this.#claimedActions.has(source) ||
      this.#claimedActions.has(destination)
    ) {
      return false;
    }
    this.#claimedPublications.add(publication);
    this.#claimedMovements.add(movement);
    this.#claimedEvents.add(capture);
    this.#claimedEvents.add(bubble);
    this.#claimedEvents.add(nativeEvent);
    this.#claimedProofs.add(proof);
    this.#claimedActions.add(source);
    this.#claimedActions.add(destination);
    return true;
  }
}

class VersionDiffElementOwner<T extends HTMLElement>
  implements VersionDiffElementOwnerView
{
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: VersionDiffElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture = (element: T | null) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

function captureVersionDiffVersion(
  source: VersionSummary,
): VersionDiffVersionFact {
  return Object.freeze({
    source,
    id: source.id,
    number: source.number,
    title: source.title,
    kind: source.kind,
    createdBy: source.createdBy,
    createdByName: source.createdByName,
    commitSha: source.commitSha,
    createdAt: source.createdAt,
    size: source.size,
  });
}

function versionDiffVersionMatches(fact: VersionDiffVersionFact) {
  const source = fact.source;
  return (
    source.id === fact.id &&
    source.number === fact.number &&
    source.title === fact.title &&
    source.kind === fact.kind &&
    source.createdBy === fact.createdBy &&
    source.createdByName === fact.createdByName &&
    source.commitSha === fact.commitSha &&
    source.createdAt === fact.createdAt &&
    source.size === fact.size
  );
}

function versionDiffSegmentsMatch(
  current: readonly DiffSegment[],
  expected: readonly DiffSegment[],
) {
  return (
    current.length === expected.length &&
    current.every((segment, index) => {
      const candidate = expected[index];
      return (
        candidate !== undefined &&
        segment.value === candidate.value &&
        segment.added === candidate.added &&
        segment.removed === candidate.removed &&
        segment.count === candidate.count &&
        segment.moved === candidate.moved
      );
    })
  );
}

function versionDiffActionFactsAreCurrent(authority: VersionDiffAuthority) {
  const expectedKinds: VersionDiffActionKind[] = authority.base
    ? ["swap", "previous", "next"]
    : ["previous", "next"];
  return (
    authority.actions.length === expectedKinds.length &&
    authority.actions.length <= 3 &&
    authority.actions.every((action, index) => {
      const kind = expectedKinds[index];
      return (
        kind !== undefined &&
        action.kind === kind &&
        action.order === index &&
        typeof action.callback === "function" &&
        action.eligible ===
          (kind === "swap"
            ? authority.base !== null
            : kind === "previous"
              ? authority.active > 0
              : authority.active < authority.hunks.length - 1)
      );
    })
  );
}

function versionDiffAuthorityIsCurrent(authority: VersionDiffAuthority) {
  const {
    session,
    preview,
    version,
    base,
    rangeSource,
    range,
    segments,
    hunkList,
  } = authority;
  if (
    session.docId !== authority.documentId ||
    session.role !== authority.role ||
    session.ytext !== authority.ytext ||
    session.ytext.toString() !== authority.current ||
    preview.version !== version.source ||
    preview.content !== authority.content ||
    !versionDiffVersionMatches(version) ||
    preview.base !== base?.source ||
    preview.range !== rangeSource ||
    (base !== null &&
      (base.source.version !== base.version.source ||
        base.source.content !== base.content ||
        !versionDiffVersionMatches(base.version))) ||
    range.length !== (rangeSource?.length ?? 0) ||
    range.some(
      (entry, index) =>
        rangeSource?.[index] !== entry.source ||
        !versionDiffVersionMatches(entry),
    ) ||
    authority.segments !== segments ||
    authority.hunkList !== hunkList ||
    authority.hunks.length !== hunkList.length ||
    authority.active < 0 ||
    authority.active >= hunkList.length ||
    !versionDiffActionFactsAreCurrent(authority)
  ) {
    return false;
  }

  const oldSide = base
    ? authority.swapped
      ? { version: version.source, content: authority.content }
      : base.source
    : { version: version.source, content: authority.content };
  const newSide = base
    ? authority.swapped
      ? base.source
      : { version: version.source, content: authority.content }
    : null;
  if (
    oldSide.content !== authority.oldText ||
    (newSide ? newSide.content : authority.current) !== authority.newText
  ) {
    return false;
  }

  const expectedSegments = detectMoves(
    wordDiff(authority.oldText, authority.newText),
  );
  if (!versionDiffSegmentsMatch(segments, expectedSegments)) return false;
  const expectedHunks = hunks(expectedSegments);
  return authority.hunks.every((fact, index) => {
    const source = hunkList[index];
    const expected = expectedHunks[index];
    return (
      fact.index === index &&
      fact.source === source &&
      source?.start === fact.start &&
      source.end === fact.end &&
      source.kind === fact.kind &&
      expected?.start === fact.start &&
      expected.end === fact.end &&
      expected.kind === fact.kind
    );
  });
}

function versionDiffAuthoritiesMatch(
  previous: VersionDiffAuthority,
  current: VersionDiffAuthority,
) {
  return (
    previous.mount === current.mount &&
    previous.session === current.session &&
    previous.documentId === current.documentId &&
    previous.role === current.role &&
    previous.ytext === current.ytext &&
    previous.preview === current.preview &&
    previous.version.source === current.version.source &&
    versionDiffVersionMatches(previous.version) &&
    versionDiffVersionMatches(current.version) &&
    previous.content === current.content &&
    previous.base?.source === current.base?.source &&
    previous.base?.version.source === current.base?.version.source &&
    previous.base?.content === current.base?.content &&
    (previous.base === null ||
      (versionDiffVersionMatches(previous.base.version) &&
        current.base !== null &&
        versionDiffVersionMatches(current.base.version))) &&
    previous.rangeSource === current.rangeSource &&
    previous.range.length === current.range.length &&
    previous.range.every(
      (entry, index) =>
        entry.source === current.range[index]?.source &&
        versionDiffVersionMatches(entry) &&
        versionDiffVersionMatches(current.range[index]!),
    ) &&
    previous.current === current.current &&
    previous.swapped === current.swapped &&
    previous.oldText === current.oldText &&
    previous.newText === current.newText &&
    previous.segments === current.segments &&
    previous.hunkList === current.hunkList &&
    previous.hunks.length === current.hunks.length &&
    previous.hunks.every((fact, index) => {
      const candidate = current.hunks[index];
      return (
        candidate !== undefined &&
        fact.source === candidate.source &&
        fact.index === candidate.index &&
        fact.start === candidate.start &&
        fact.end === candidate.end &&
        fact.kind === candidate.kind
      );
    }) &&
    previous.active === current.active &&
    previous.setActive === current.setActive &&
    previous.actions.length === current.actions.length &&
    previous.actions.every((action, index) => {
      const candidate = current.actions[index];
      return (
        candidate !== undefined &&
        action.kind === candidate.kind &&
        action.order === candidate.order &&
        action.callback === candidate.callback &&
        action.eligible === candidate.eligible
      );
    }) &&
    versionDiffAuthorityIsCurrent(previous) &&
    versionDiffAuthorityIsCurrent(current)
  );
}

function snapshotVersionDiffAttributes(
  node: Node,
): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotVersionDiffDom(node: Node): VersionDiffDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotVersionDiffAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotVersionDiffDom)),
  });
}

function versionDiffDomMatches(
  snapshot: VersionDiffDomSnapshot,
  ownerDocument: Document,
): boolean {
  const { node } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    node.nodeValue !== snapshot.nodeValue
  ) {
    return false;
  }
  const attributes = snapshotVersionDiffAttributes(node);
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
        versionDiffDomMatches(child, ownerDocument),
    )
  );
}

function captureVersionDiffPlacement(
  node: HTMLElement,
): VersionDiffPlacement | null {
  if (!node.isConnected) return null;
  const document = node.ownerDocument;
  const chain: VersionDiffNodePlacement[] = [];
  let current: Node = node;
  while (current !== document) {
    const parent = current.parentNode;
    if (!parent) return null;
    chain.push(
      Object.freeze({
        node: current,
        parent,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
        exactSiblings: current === node,
      }),
    );
    current = parent;
  }
  return chain.length > 0
    ? Object.freeze({ document, chain: Object.freeze(chain) })
    : null;
}

function versionDiffPlacementMatches(
  node: HTMLElement,
  placement: VersionDiffPlacement,
) {
  return (
    node.ownerDocument === placement.document &&
    node.isConnected &&
    placement.chain[0]?.node === node &&
    placement.chain.every(
      (entry) =>
        entry.node.parentNode === entry.parent &&
        (!entry.exactSiblings ||
          (entry.node.previousSibling === entry.previousSibling &&
            entry.node.nextSibling === entry.nextSibling)),
    )
  );
}

function versionDiffPlacementRecordChanged(
  record: MutationRecord,
  placement: VersionDiffNodePlacement,
) {
  if (record.type !== "childList" || record.target !== placement.parent) {
    return false;
  }
  if (
    placement.exactSiblings &&
    (record.previousSibling === placement.node ||
      record.nextSibling === placement.node)
  ) {
    return true;
  }
  return [...record.addedNodes, ...record.removedNodes].some(
    (node) => node === placement.node || node.contains(placement.node),
  );
}

function createVersionDiffDomGuard(
  root: HTMLElement,
  placement: VersionDiffPlacement,
): VersionDiffDomGuard | null {
  const MutationObserverConstructor =
    placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  let released = false;
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      return placement.chain.some((entry) =>
        versionDiffPlacementRecordChanged(record, entry),
      );
    });
  };
  const observer = new MutationObserverConstructor(recordChanges);
  observer.observe(root, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const entry of placement.chain) {
    observer.observe(entry.parent, { childList: true });
  }
  return Object.freeze({
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      if (released) return;
      recordChanges(observer.takeRecords());
      observer.disconnect();
      released = true;
    },
  });
}

const VERSION_DIFF_GET_DESCRIPTOR =
  Object.getOwnPropertyDescriptor.bind(Object);
const VERSION_DIFF_REFLECT_APPLY = Reflect.apply;
const VERSION_DIFF_GET_PROTOTYPE = Object.getPrototypeOf.bind(Object);

interface VersionDiffStableGetter<T> {
  readonly read: (value: object) => T;
  readonly isCurrent: () => boolean;
}

interface VersionDiffUnforgeableGetter<T> {
  readonly isCurrent: () => boolean;
  readonly matches: (value: object) => boolean;
  readonly read: (value: object) => T;
}

interface VersionDiffStableMethod<
  T extends (...args: never[]) => unknown,
> {
  readonly invoke: T;
  readonly isCurrent: () => boolean;
}

function captureVersionDiffGetter<T>(
  prototype: object | null,
  property: PropertyKey,
): VersionDiffStableGetter<T> | null {
  if (!prototype) return null;
  const descriptor = VERSION_DIFF_GET_DESCRIPTOR(prototype, property);
  if (!descriptor?.get) return null;
  const getter = descriptor.get as () => T;
  return Object.freeze({
    read: (value: object) =>
      VERSION_DIFF_REFLECT_APPLY(getter, value, []) as T,
    isCurrent: () =>
      VERSION_DIFF_GET_DESCRIPTOR(prototype, property)?.get === getter,
  });
}

function captureVersionDiffMethod<
  T extends (...args: never[]) => unknown,
>(
  prototype: object | null,
  property: PropertyKey,
): VersionDiffStableMethod<T> | null {
  if (!prototype) return null;
  const descriptor = VERSION_DIFF_GET_DESCRIPTOR(prototype, property);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return null;
  }
  const method = descriptor.value as (...args: never[]) => unknown;
  return Object.freeze({
    invoke: ((value: object, ...args: unknown[]) =>
      VERSION_DIFF_REFLECT_APPLY(method, value, args)) as unknown as T,
    isCurrent: () =>
      VERSION_DIFF_GET_DESCRIPTOR(prototype, property)?.value === method,
  });
}

function captureVersionDiffUnforgeableGetter<T>(
  owner: object | null,
  property: PropertyKey,
): VersionDiffUnforgeableGetter<T> | null {
  if (!owner) return null;
  const descriptor = VERSION_DIFF_GET_DESCRIPTOR(owner, property);
  if (!descriptor?.get || "value" in descriptor) return null;
  const getter = descriptor.get as () => T;
  const setter = descriptor.set as undefined | ((value: T) => void);
  const configurable = descriptor.configurable === true;
  const enumerable = descriptor.enumerable === true;
  const matches = (value: object) => {
    const current = VERSION_DIFF_GET_DESCRIPTOR(value, property);
    return (
      !!current &&
      !("value" in current) &&
      current.get === getter &&
      current.set === setter &&
      current.configurable === configurable &&
      current.enumerable === enumerable
    );
  };
  return Object.freeze({
    isCurrent: () => matches(owner),
    matches,
    read: (value: object) =>
      VERSION_DIFF_REFLECT_APPLY(getter, value, []) as T,
  });
}

function captureVersionDiffWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): VersionDiffWindowMethod<Window[Property]> | null {
  const value = ownerWindow[property];
  if (typeof value !== "function") return null;
  let historyIsClean = true;
  const isCurrent = () => {
    if (!historyIsClean) return false;
    try {
      historyIsClean = ownerWindow[property] === value;
    } catch {
      historyIsClean = false;
    }
    return historyIsClean;
  };
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function captureVersionDiffKeyboardIntrinsics(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): VersionDiffKeyboardIntrinsics | null {
  const EventConstructor = ownerWindow.Event;
  const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
  const eventPrototype = EventConstructor.prototype;
  const uiEventPrototype = ownerWindow.UIEvent.prototype;
  const keyboardEventPrototype = KeyboardEventConstructor.prototype;
  const documentPrototype = ownerWindow.Document.prototype;
  const elementPrototype = ownerWindow.Element.prototype;
  const htmlElementPrototype = ownerWindow.HTMLElement.prototype;
  let keyboardProbe: globalThis.KeyboardEvent;
  try {
    keyboardProbe = new KeyboardEventConstructor(
      "version-diff-keyboard-intrinsic",
    );
  } catch {
    return null;
  }

  const eventType = captureVersionDiffGetter<string>(eventPrototype, "type");
  const eventPhase = captureVersionDiffGetter<number>(
    eventPrototype,
    "eventPhase",
  );
  const eventBubbles = captureVersionDiffGetter<boolean>(
    eventPrototype,
    "bubbles",
  );
  const eventCancelable = captureVersionDiffGetter<boolean>(
    eventPrototype,
    "cancelable",
  );
  const eventDefaultPrevented = captureVersionDiffGetter<boolean>(
    eventPrototype,
    "defaultPrevented",
  );
  const eventCancelBubble = captureVersionDiffGetter<boolean>(
    eventPrototype,
    "cancelBubble",
  );
  const eventTarget = captureVersionDiffGetter<EventTarget | null>(
    eventPrototype,
    "target",
  );
  const eventCurrentTarget = captureVersionDiffGetter<EventTarget | null>(
    eventPrototype,
    "currentTarget",
  );
  const eventTrusted = captureVersionDiffUnforgeableGetter<boolean>(
    keyboardProbe,
    "isTrusted",
  );
  const eventComposedPath = captureVersionDiffMethod<
    (event: globalThis.Event) => EventTarget[]
  >(eventPrototype, "composedPath");
  const preventDefault = captureVersionDiffMethod<
    (event: globalThis.Event) => void
  >(eventPrototype, "preventDefault");
  const uiView = captureVersionDiffGetter<Window | null>(
    uiEventPrototype,
    "view",
  );
  const key = captureVersionDiffGetter<string>(
    keyboardEventPrototype,
    "key",
  );
  const code = captureVersionDiffGetter<string>(
    keyboardEventPrototype,
    "code",
  );
  const location = captureVersionDiffGetter<number>(
    keyboardEventPrototype,
    "location",
  );
  const ctrlKey = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "ctrlKey",
  );
  const altKey = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "altKey",
  );
  const metaKey = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "metaKey",
  );
  const shiftKey = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "shiftKey",
  );
  const repeat = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "repeat",
  );
  const isComposing = captureVersionDiffGetter<boolean>(
    keyboardEventPrototype,
    "isComposing",
  );
  const activeElement = captureVersionDiffGetter<Element | null>(
    documentPrototype,
    "activeElement",
  );
  const scrollIntoView = captureVersionDiffMethod<
    (element: Element, options: ScrollIntoViewOptions) => void
  >(elementPrototype, "scrollIntoView");
  const focus = captureVersionDiffMethod<
    (element: HTMLElement, options: FocusOptions) => void
  >(htmlElementPrototype, "focus");
  const addEventListener = captureVersionDiffWindowMethod(
    ownerWindow,
    "addEventListener",
  );
  const removeEventListener = captureVersionDiffWindowMethod(
    ownerWindow,
    "removeEventListener",
  );
  const getters = [
    eventType,
    eventPhase,
    eventBubbles,
    eventCancelable,
    eventDefaultPrevented,
    eventCancelBubble,
    eventTarget,
    eventCurrentTarget,
    uiView,
    key,
    code,
    location,
    ctrlKey,
    altKey,
    metaKey,
    shiftKey,
    repeat,
    isComposing,
    activeElement,
  ];
  const methods = [eventComposedPath, preventDefault, scrollIntoView, focus];
  if (
    getters.some((intrinsic) => !intrinsic) ||
    methods.some((intrinsic) => !intrinsic) ||
    !eventTrusted ||
    !addEventListener ||
    !removeEventListener
  ) {
    return null;
  }

  const ownerRealmIsCurrent = () =>
    ownerWindow.Event === EventConstructor &&
    ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
    ownerWindow.Event.prototype === eventPrototype &&
    ownerWindow.UIEvent.prototype === uiEventPrototype &&
    ownerWindow.KeyboardEvent.prototype === keyboardEventPrototype &&
    ownerWindow.Document.prototype === documentPrototype &&
    ownerWindow.Element.prototype === elementPrototype &&
    ownerWindow.HTMLElement.prototype === htmlElementPrototype;
  let historyIsClean = true;
  const descriptorsAreCurrent = () => {
    if (!historyIsClean) return false;
    historyIsClean =
      ownerRealmIsCurrent() &&
      getters.every((intrinsic) => intrinsic?.isCurrent() === true) &&
      methods.every((intrinsic) => intrinsic?.isCurrent() === true) &&
      addEventListener.isCurrent() &&
      removeEventListener.isCurrent() &&
      eventTrusted.isCurrent();
    return historyIsClean;
  };

  return Object.freeze({
    read: (event: object) => {
      if (!descriptorsAreCurrent()) return null;
      try {
        if (
          VERSION_DIFF_GET_PROTOTYPE(event) !== keyboardEventPrototype ||
          !eventTrusted.matches(event)
        ) {
          return null;
        }
        const isTrustedValue = eventTrusted.read(event);
        const view = uiView!.read(event);
        if (isTrustedValue !== true) return null;
        return Object.freeze({
          type: eventType!.read(event),
          phase: eventPhase!.read(event),
          bubbles: eventBubbles!.read(event),
          cancelable: eventCancelable!.read(event),
          defaultPrevented: eventDefaultPrevented!.read(event),
          cancelBubble: eventCancelBubble!.read(event),
          target: eventTarget!.read(event),
          currentTarget: eventCurrentTarget!.read(event),
          path: Object.freeze([
            ...eventComposedPath!.invoke(event as globalThis.Event),
          ]),
          isTrusted: isTrustedValue,
          view,
          key: key!.read(event),
          code: code!.read(event),
          location: location!.read(event),
          ctrlKey: ctrlKey!.read(event),
          altKey: altKey!.read(event),
          metaKey: metaKey!.read(event),
          shiftKey: shiftKey!.read(event),
          repeat: repeat!.read(event),
          isComposing: isComposing!.read(event),
        });
      } catch {
        return null;
      }
    },
    defaultWasPrevented: (event: globalThis.Event) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        return eventDefaultPrevented!.read(event);
      } catch {
        return false;
      }
    },
    activeElement: () => {
      if (!descriptorsAreCurrent()) return undefined;
      try {
        return activeElement!.read(ownerDocument);
      } catch {
        return undefined;
      }
    },
    preventDefault: (event: globalThis.Event) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        preventDefault!.invoke(event);
        return true;
      } catch {
        return false;
      }
    },
    reveal: (element: Element) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        scrollIntoView!.invoke(element, { block: "center" });
        return true;
      } catch {
        return false;
      }
    },
    focus: (element: HTMLElement) => {
      if (!descriptorsAreCurrent()) return false;
      try {
        focus!.invoke(element, { preventScroll: true });
        return true;
      } catch {
        return false;
      }
    },
    keyboardPrototype: keyboardEventPrototype,
    capturingPhase: EventConstructor.CAPTURING_PHASE,
    bubblingPhase: EventConstructor.BUBBLING_PHASE,
    apply: VERSION_DIFF_REFLECT_APPLY,
    getPrototypeOf: VERSION_DIFF_GET_PROTOTYPE,
    addEventListener,
    removeEventListener,
    isCurrent: descriptorsAreCurrent,
    methodMatches: (
      event: object,
      property: PropertyKey,
      method: unknown,
    ) => {
      if (!descriptorsAreCurrent() || typeof method !== "function") return false;
      try {
        let owner: object | null = event;
        while (owner) {
          const descriptor = VERSION_DIFF_GET_DESCRIPTOR(owner, property);
          if (descriptor) {
            return "value" in descriptor && descriptor.value === method;
          }
          owner = VERSION_DIFF_GET_PROTOTYPE(owner) as object | null;
        }
        return false;
      } catch {
        return false;
      }
    },
  });
}

function captureVersionDiffEventPath(
  node: Node,
  ownerDocument: Document,
) {
  const path: EventTarget[] = [];
  let current: Node | null = node;
  while (current) {
    path.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  if (path[path.length - 1] !== ownerDocument) return null;
  return Object.freeze(path);
}

function isVersionDiffActionNavigationKey(
  key: string,
): key is VersionDiffActionNavigationKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End"
  );
}

function versionDiffNativeStableFactsMatch(
  left: VersionDiffNativeKeyboardFacts,
  right: VersionDiffNativeKeyboardFacts,
) {
  return (
    left.type === right.type &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.target === right.target &&
    left.currentTarget === right.currentTarget &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => entry === right.path[index]) &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing
  );
}

function versionDiffNativeCrossPhaseFactsMatch(
  left: VersionDiffNativeKeyboardFacts,
  right: VersionDiffNativeKeyboardFacts,
) {
  return (
    left.type === right.type &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.defaultPrevented === right.defaultPrevented &&
    left.cancelBubble === right.cancelBubble &&
    left.target === right.target &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => entry === right.path[index]) &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing
  );
}

function versionDiffBoundaryNativeFactsMatch(
  left: VersionDiffNativeKeyboardFacts,
  right: VersionDiffNativeKeyboardFacts,
) {
  return (
    left.type === right.type &&
    left.bubbles === right.bubbles &&
    left.cancelable === right.cancelable &&
    left.target === right.target &&
    left.path.length === right.path.length &&
    left.path.every((entry, index) => entry === right.path[index]) &&
    left.isTrusted === right.isTrusted &&
    left.view === right.view &&
    left.key === right.key &&
    left.code === right.code &&
    left.location === right.location &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.metaKey === right.metaKey &&
    left.shiftKey === right.shiftKey &&
    left.repeat === right.repeat &&
    left.isComposing === right.isComposing
  );
}

function versionDiffListenerPathMatches(
  path: readonly EventTarget[],
  source: HTMLElement,
  ownerDocument: Document,
  terminal: EventTarget,
) {
  const expected: EventTarget[] = [];
  let current: Node | null = source;
  while (current) {
    expected.push(current);
    if (current === ownerDocument) break;
    current = current.parentNode;
  }
  return (
    expected.at(-1) === ownerDocument &&
    path.length === expected.length + 1 &&
    expected.every((entry, index) => path[index] === entry) &&
    path.at(-1) === terminal
  );
}

function createVersionDiffKeyListener(
  keyboard: VersionDiffKeyboardIntrinsics,
): VersionDiffKeyListener {
  const proofs = new WeakMap<globalThis.KeyboardEvent, VersionDiffWindowProof>();
  const invalidEvents = new WeakSet<Event>();
  const claimedProofs = new WeakSet<VersionDiffWindowProof>();
  let publication: VersionDiffPublication | null = null;
  let active = false;
  let released = false;

  const listener: EventListener = function (this: EventTarget, event: Event) {
    const current = publication;
    if (
      !current ||
      !active ||
      released ||
      current.keyListener !== registration ||
      invalidEvents.has(event) ||
      keyboard.getPrototypeOf(event) !== keyboard.keyboardPrototype ||
      !keyboard.isCurrent()
    ) {
      return;
    }
    const nativeEvent = event as globalThis.KeyboardEvent;
    if (proofs.has(nativeEvent)) {
      invalidEvents.add(nativeEvent);
      return;
    }
    const snapshot = keyboard.read(nativeEvent);
    const action = current.actions.find(
      (candidate) => candidate.element === snapshot?.target,
    );
    const source =
      action?.element ?? (snapshot?.target === current.root ? current.root : null);
    const terminal = snapshot?.path.at(-1);
    if (
      !snapshot ||
      !source ||
      !terminal ||
      snapshot.currentTarget !== this ||
      terminal !== this ||
      snapshot.phase !== keyboard.capturingPhase ||
      snapshot.type !== "keydown" ||
      (snapshot.view !== null &&
        snapshot.view !== current.ownerWindow &&
        snapshot.view !== this) ||
      !versionDiffListenerPathMatches(
        snapshot.path,
        source,
        current.ownerDocument,
        this,
      )
    ) {
      return;
    }
    proofs.set(
      nativeEvent,
      Object.freeze({
        identity: Symbol("version-diff-window-proof"),
        publication: current,
        nativeEvent,
        source,
        receiver: this,
        currentTarget: this,
        terminal,
        path: Object.freeze([...snapshot.path]),
        snapshot,
      }),
    );
  };

  const proofFor = (
    event: globalThis.KeyboardEvent,
    current: VersionDiffPublication,
  ) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      publication !== current ||
      current.keyListener !== registration ||
      proof.publication !== current ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      invalidEvents.has(event) ||
      !keyboard.isCurrent()
    ) {
      return null;
    }
    const snapshot = keyboard.read(event);
    if (!snapshot) return null;
    const cancellationMatches =
      proof.source === current.root
        ? proof.snapshot.defaultPrevented === false &&
          proof.snapshot.cancelBubble === false &&
          snapshot.cancelBubble === false
        : proof.snapshot.defaultPrevented === snapshot.defaultPrevented &&
          proof.snapshot.cancelBubble === snapshot.cancelBubble;
    return cancellationMatches &&
      versionDiffBoundaryNativeFactsMatch(proof.snapshot, snapshot) &&
      (snapshot.view === null ||
        snapshot.view === current.ownerWindow ||
        snapshot.view === proof.receiver) &&
      versionDiffListenerPathMatches(
        snapshot.path,
        proof.source,
        current.ownerDocument,
        proof.receiver,
      )
      ? proof
      : null;
  };

  const registration: VersionDiffKeyListener = Object.freeze({
    listener,
    activate: (current: VersionDiffPublication) => {
      if (
        publication ||
        active ||
        released ||
        current.keyListener !== registration ||
        current.keyboard !== keyboard ||
        current.ownerDocument.defaultView !== current.ownerWindow ||
        !keyboard.isCurrent()
      ) {
        return false;
      }
      publication = current;
      active = true;
      try {
        keyboard.apply(keyboard.addEventListener.value, current.ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
      } catch {
        active = false;
        publication = null;
        return false;
      }
      if (keyboard.isCurrent()) return true;
      active = false;
      publication = null;
      keyboard.apply(keyboard.removeEventListener.value, current.ownerWindow, [
        "keydown",
        listener,
        true,
      ]);
      return false;
    },
    proofFor,
    claim: (proof: VersionDiffWindowProof, current: VersionDiffPublication) => {
      if (
        claimedProofs.has(proof) ||
        proofFor(proof.nativeEvent, current) !== proof
      ) {
        return false;
      }
      claimedProofs.add(proof);
      return true;
    },
    retains: (
      proof: VersionDiffWindowProof,
      current: VersionDiffPublication,
    ) =>
      publication === current &&
      current.keyListener === registration &&
      claimedProofs.has(proof) &&
      proofs.get(proof.nativeEvent) === proof &&
      proof.publication === current &&
      proof.receiver === proof.currentTarget &&
      proof.receiver === proof.terminal &&
      !invalidEvents.has(proof.nativeEvent) &&
      active &&
      !released &&
      keyboard.isCurrent(),
    release: (current: VersionDiffPublication) => {
      if (publication !== current || released) return;
      released = true;
      const wasActive = active;
      active = false;
      if (wasActive) {
        keyboard.apply(keyboard.removeEventListener.value, current.ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
      }
    },
  });
  return registration;
}

function versionDiffActionDestination(
  actions: readonly VersionDiffPublishedAction[],
  source: VersionDiffPublishedAction,
  key: VersionDiffActionNavigationKey,
) {
  const sourceIndex = actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number | null = null;
  if (
    (key === "ArrowLeft" || key === "ArrowUp") &&
    sourceIndex > 0
  ) {
    destinationIndex = sourceIndex - 1;
  } else if (
    (key === "ArrowRight" || key === "ArrowDown") &&
    sourceIndex + 1 < actions.length
  ) {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home" && sourceIndex !== 0) {
    destinationIndex = 0;
  } else if (key === "End" && sourceIndex !== actions.length - 1) {
    destinationIndex = actions.length - 1;
  }
  const destination =
    destinationIndex === null ? null : actions[destinationIndex];
  return destination && destination !== source ? destination : null;
}

function readVersionDiffReactMethods(
  event: KeyboardEvent<HTMLElement>,
  keyboard: VersionDiffKeyboardIntrinsics,
): VersionDiffReactMethods | null {
  try {
    const methods: VersionDiffReactMethods = Object.freeze({
      preventDefault: event.preventDefault,
      stopPropagation: event.stopPropagation,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
      persist: event.persist,
    });
    return (
        Object.entries(methods).every(([property, method]) =>
          keyboard.methodMatches(event, property, method),
        ) &&
        keyboard.apply(methods.isDefaultPrevented, event, []) === false &&
        keyboard.apply(methods.isPropagationStopped, event, []) === false
      )
      ? methods
      : null;
  } catch {
    return null;
  }
}

function versionDiffReactMethodsRemainFalse(
  delivery: VersionDiffActionDelivery,
) {
  const { wrapper, methods, publication } = delivery;
  const { keyboard } = publication;
  if (!keyboard) return false;
  try {
    return (
      wrapper.preventDefault === methods.preventDefault &&
      wrapper.stopPropagation === methods.stopPropagation &&
      wrapper.isDefaultPrevented === methods.isDefaultPrevented &&
      wrapper.isPropagationStopped === methods.isPropagationStopped &&
      wrapper.persist === methods.persist &&
      Object.entries(methods).every(([property, method]) =>
        keyboard.methodMatches(wrapper, property, method),
      ) &&
      keyboard.apply(methods.isDefaultPrevented, wrapper, []) === false &&
      keyboard.apply(methods.isPropagationStopped, wrapper, []) === false
    );
  } catch {
    return false;
  }
}

function versionDiffDeliveriesMatchWithinPhase(
  left: VersionDiffActionDelivery,
  right: VersionDiffActionDelivery,
) {
  return (
    left.publication === right.publication &&
    left.wrapper === right.wrapper &&
    left.methods.preventDefault === right.methods.preventDefault &&
    left.methods.stopPropagation === right.methods.stopPropagation &&
    left.methods.isDefaultPrevented === right.methods.isDefaultPrevented &&
    left.methods.isPropagationStopped ===
      right.methods.isPropagationStopped &&
    left.methods.persist === right.methods.persist &&
    left.nativeEvent === right.nativeEvent &&
    left.listener === right.listener &&
    left.dispatchTarget === right.dispatchTarget &&
    left.source === right.source &&
    left.action === right.action &&
    left.key === right.key &&
    left.snapshot.phase === right.snapshot.phase &&
    versionDiffNativeStableFactsMatch(left.snapshot, right.snapshot)
  );
}

function versionDiffDeliveriesMatchAcrossPhases(
  capture: VersionDiffActionDelivery,
  bubble: VersionDiffActionDelivery,
) {
  return (
    capture.publication === bubble.publication &&
    capture.wrapper !== bubble.wrapper &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listener === bubble.listener &&
    capture.dispatchTarget === bubble.dispatchTarget &&
    capture.source === bubble.source &&
    capture.action === bubble.action &&
    capture.key === bubble.key &&
    versionDiffNativeCrossPhaseFactsMatch(capture.snapshot, bubble.snapshot)
  );
}

function readVersionDiffActionDelivery(
  event: KeyboardEvent<HTMLElement>,
  publication: VersionDiffPublication,
  currentTarget: HTMLElement,
  expectedPhase: number,
): VersionDiffActionDelivery | null {
  if (!event || typeof event !== "object") return null;
  const reactEvent = event as KeyboardEvent<HTMLElement> & {
    readonly isComposing?: boolean;
  };
  const keyboard = publication.keyboard;
  const keyListener = publication.keyListener;
  const nativeEvent = event.nativeEvent;
  if (
    !keyboard ||
    !keyListener ||
    !nativeEvent ||
    keyboard.getPrototypeOf(nativeEvent) !== keyboard.keyboardPrototype
  ) {
    return null;
  }
  const listener = keyListener.proofFor(nativeEvent, publication);
  const snapshot = listener ? keyboard.read(nativeEvent) : null;
  const methods = snapshot ? readVersionDiffReactMethods(event, keyboard) : null;
  const action = publication.actions.find(
    (candidate) => candidate.element === snapshot?.target,
  );
  const dispatchTarget = snapshot?.currentTarget ?? null;
  if (
    !listener ||
    !snapshot ||
    !methods ||
    !action ||
    !dispatchTarget ||
    !isVersionDiffActionNavigationKey(snapshot.key) ||
    snapshot.type !== "keydown" ||
    snapshot.phase !== expectedPhase ||
    !snapshot.bubbles ||
    !snapshot.cancelable ||
    snapshot.defaultPrevented ||
    snapshot.cancelBubble ||
    !snapshot.isTrusted ||
    snapshot.ctrlKey ||
    snapshot.altKey ||
    snapshot.metaKey ||
    snapshot.shiftKey ||
    snapshot.repeat ||
    snapshot.isComposing ||
    (snapshot.view !== null &&
      snapshot.view !== publication.ownerWindow &&
      snapshot.view !== listener.receiver) ||
    snapshot.target !== action.element ||
    listener.source !== action.element ||
    !versionDiffListenerPathMatches(
      snapshot.path,
      action.element,
      publication.ownerDocument,
      listener.receiver,
    ) ||
    !snapshot.path.includes(dispatchTarget) ||
    snapshot.path.filter((entry) => entry === dispatchTarget).length !== 1 ||
    keyboard.activeElement() !== action.element ||
    event === (nativeEvent as unknown) ||
    event.type !== snapshot.type ||
    event.nativeEvent !== nativeEvent ||
    event.currentTarget !== currentTarget ||
    event.target !== action.element ||
    event.eventPhase !== snapshot.phase ||
    event.bubbles !== snapshot.bubbles ||
    event.cancelable !== snapshot.cancelable ||
    event.defaultPrevented !== snapshot.defaultPrevented ||
    event.isTrusted !== snapshot.isTrusted ||
    event.key !== snapshot.key ||
    event.code !== snapshot.code ||
    event.location !== snapshot.location ||
    event.ctrlKey !== snapshot.ctrlKey ||
    event.altKey !== snapshot.altKey ||
    event.metaKey !== snapshot.metaKey ||
    event.shiftKey !== snapshot.shiftKey ||
    event.repeat !== snapshot.repeat ||
    (reactEvent.isComposing !== undefined &&
      reactEvent.isComposing !== snapshot.isComposing) ||
    !Object.is(event.view, snapshot.view)
  ) {
    return null;
  }
  return Object.freeze({
    publication,
    wrapper: event,
    methods,
    nativeEvent,
    listener,
    currentTarget,
    dispatchTarget,
    source: action.element,
    action,
    key: snapshot.key,
    snapshot,
  });
}

function readVersionDiffBoundaryMethods(
  event: KeyboardEvent<HTMLDivElement>,
): VersionDiffBoundaryMethods | null {
  try {
    const methods = Object.freeze({
      preventDefault: event.preventDefault,
      isDefaultPrevented: event.isDefaultPrevented,
      isPropagationStopped: event.isPropagationStopped,
    });
    return Object.values(methods).every(
      (method) => typeof method === "function",
    )
      ? methods
      : null;
  } catch {
    return null;
  }
}

function versionDiffBoundaryMethodsAreCurrent(
  delivery: VersionDiffBoundaryDelivery,
  defaultQuery: (...args: never[]) => unknown =
    delivery.methods.isDefaultPrevented,
) {
  try {
    return (
      delivery.wrapper.preventDefault === delivery.methods.preventDefault &&
      delivery.wrapper.isDefaultPrevented === defaultQuery &&
      delivery.wrapper.isPropagationStopped ===
        delivery.methods.isPropagationStopped
    );
  } catch {
    return false;
  }
}

function versionDiffBoundaryWrapperMatches(
  event: KeyboardEvent<HTMLDivElement>,
  nativeEvent: globalThis.KeyboardEvent,
  snapshot: VersionDiffNativeKeyboardFacts,
  root: HTMLDivElement,
) {
  const reactEvent = event as KeyboardEvent<HTMLDivElement> & {
    readonly isComposing?: boolean;
  };
  try {
    return (
      event !== (nativeEvent as unknown) &&
      event.nativeEvent === nativeEvent &&
      event.currentTarget === root &&
      event.target === root &&
      event.type === snapshot.type &&
      event.eventPhase === snapshot.phase &&
      event.bubbles === snapshot.bubbles &&
      event.cancelable === snapshot.cancelable &&
      event.defaultPrevented === snapshot.defaultPrevented &&
      event.isTrusted === snapshot.isTrusted &&
      event.key === snapshot.key &&
      event.code === snapshot.code &&
      event.location === snapshot.location &&
      event.ctrlKey === snapshot.ctrlKey &&
      event.altKey === snapshot.altKey &&
      event.metaKey === snapshot.metaKey &&
      event.shiftKey === snapshot.shiftKey &&
      event.repeat === snapshot.repeat &&
      (reactEvent.isComposing === undefined ||
        reactEvent.isComposing === snapshot.isComposing) &&
      Object.is(event.view, snapshot.view)
    );
  } catch {
    return false;
  }
}

function readVersionDiffBoundaryDelivery(
  event: KeyboardEvent<HTMLDivElement>,
  publication: VersionDiffBoundaryPublication,
  expectedPhase: number,
): VersionDiffBoundaryDelivery | null {
  if (!event || typeof event !== "object") return null;
  const keyboard = publication.keyboard;
  const keyListener = publication.keyListener;
  let nativeEvent: globalThis.KeyboardEvent;
  try {
    nativeEvent = event.nativeEvent;
  } catch {
    return null;
  }
  if (
    !keyboard ||
    !keyListener ||
    !nativeEvent ||
    keyboard.getPrototypeOf(nativeEvent) !== keyboard.keyboardPrototype
  ) {
    return null;
  }
  const listener = keyListener.proofFor(nativeEvent, publication);
  const snapshot = listener ? keyboard.read(nativeEvent) : null;
  const methods = snapshot ? readVersionDiffBoundaryMethods(event) : null;
  if (
    !listener ||
    !snapshot ||
    !methods ||
    listener.source !== publication.root ||
    snapshot.target !== publication.root ||
    snapshot.currentTarget === null ||
    !snapshot.path.includes(snapshot.currentTarget) ||
    snapshot.path.filter((entry) => entry === snapshot.currentTarget).length !==
      1 ||
    !versionDiffListenerPathMatches(
      snapshot.path,
      publication.root,
      publication.ownerDocument,
      listener.receiver,
    ) ||
    snapshot.type !== "keydown" ||
    snapshot.phase !== expectedPhase ||
    !snapshot.bubbles ||
    !snapshot.cancelable ||
    snapshot.defaultPrevented ||
    snapshot.cancelBubble ||
    !snapshot.isTrusted ||
    snapshot.ctrlKey ||
    snapshot.altKey ||
    snapshot.metaKey ||
    snapshot.shiftKey ||
    snapshot.repeat ||
    snapshot.isComposing ||
    (snapshot.key !== "Home" && snapshot.key !== "End") ||
    !versionDiffBoundaryWrapperMatches(
      event,
      nativeEvent,
      snapshot,
      publication.root,
    )
  ) {
    return null;
  }
  const destinationIndex =
    snapshot.key === "Home" ? 0 : publication.authority.hunks.length - 1;
  const destination = publication.hunks[destinationIndex];
  if (
    destinationIndex < 0 ||
    !destination ||
    !destination.isConnected ||
    destination.ownerDocument !== publication.ownerDocument ||
    !publication.body.contains(destination)
  ) {
    return null;
  }
  return Object.freeze<VersionDiffBoundaryDelivery>({
    publication,
    wrapper: event,
    methods,
    nativeEvent,
    listener,
    key: snapshot.key,
    snapshot,
    destination,
    destinationIndex,
    setActive: publication.authority.setActive,
    requestSuccessor: publication.authority.requestSuccessor,
  });
}

function versionDiffBoundaryCapturesMatch(
  left: VersionDiffBoundaryDelivery,
  right: VersionDiffBoundaryDelivery,
) {
  return (
    left.publication === right.publication &&
    left.wrapper === right.wrapper &&
    left.methods.preventDefault === right.methods.preventDefault &&
    left.methods.isDefaultPrevented === right.methods.isDefaultPrevented &&
    left.methods.isPropagationStopped ===
      right.methods.isPropagationStopped &&
    left.nativeEvent === right.nativeEvent &&
    left.listener === right.listener &&
    left.key === right.key &&
    left.destination === right.destination &&
    left.destinationIndex === right.destinationIndex &&
    left.setActive === right.setActive &&
    left.requestSuccessor === right.requestSuccessor &&
    left.snapshot.phase === right.snapshot.phase &&
    versionDiffNativeStableFactsMatch(left.snapshot, right.snapshot)
  );
}

function versionDiffBoundaryDeliveriesPair(
  capture: VersionDiffBoundaryDelivery,
  bubble: VersionDiffBoundaryDelivery,
) {
  return (
    capture.publication === bubble.publication &&
    capture.nativeEvent === bubble.nativeEvent &&
    capture.listener === bubble.listener &&
    capture.key === bubble.key &&
    capture.destination === bubble.destination &&
    capture.destinationIndex === bubble.destinationIndex &&
    capture.setActive === bubble.setActive &&
    capture.requestSuccessor === bubble.requestSuccessor &&
    versionDiffNativeCrossPhaseFactsMatch(capture.snapshot, bubble.snapshot)
  );
}

function createVersionDiffBoundaryPairing(): VersionDiffBoundaryPairing {
  const captures = new WeakMap<
    globalThis.KeyboardEvent,
    VersionDiffBoundaryDelivery
  >();
  const attempts = new WeakMap<
    globalThis.KeyboardEvent,
    VersionDiffBoundaryAttempt
  >();
  const claimedEvents = new WeakSet<globalThis.KeyboardEvent>();
  const claims = new WeakSet<VersionDiffBoundaryClaim>();
  let owner: VersionDiffPublication | null = null;
  let released = false;
  let activeAttempt: VersionDiffBoundaryAttempt | null = null;

  const owns = (publication: VersionDiffPublication) =>
    !released && (owner === null || owner === publication);
  const canClaim = (
    capture: VersionDiffBoundaryDelivery,
    bubble: VersionDiffBoundaryDelivery,
    publication: VersionDiffPublication,
  ) =>
    owns(publication) &&
    capture.publication === publication &&
    bubble.publication === publication &&
    captures.get(bubble.nativeEvent) === capture &&
    !claimedEvents.has(bubble.nativeEvent) &&
    versionDiffBoundaryDeliveriesPair(capture, bubble);

  const pairing: VersionDiffBoundaryPairing = {
    begin: (nativeEvent) => {
      if (released || claimedEvents.has(nativeEvent)) return null;
      if (activeAttempt) {
        activeAttempt.reentered = true;
        return null;
      }
      const active = attempts.get(nativeEvent);
      if (active) {
        active.reentered = true;
        return null;
      }
      const attempt = {
        identity: Symbol("version-diff-boundary-attempt"),
        reentered: false,
      };
      attempts.set(nativeEvent, attempt);
      activeAttempt = attempt;
      return attempt;
    },
    attemptIsCurrent: (nativeEvent, attempt) =>
      !released &&
      attempts.get(nativeEvent) === attempt &&
      !attempt.reentered,
    finish: (nativeEvent, attempt) => {
      if (attempts.get(nativeEvent) === attempt) attempts.delete(nativeEvent);
      if (activeAttempt === attempt) activeAttempt = null;
    },
    remember: (delivery, publication) => {
      if (!owns(publication) || delivery.publication !== publication) {
        return false;
      }
      owner ??= publication;
      const current = captures.get(delivery.nativeEvent);
      if (current) return versionDiffBoundaryCapturesMatch(current, delivery);
      captures.set(delivery.nativeEvent, delivery);
      return true;
    },
    captureFor: (nativeEvent, publication) => {
      if (!owns(publication)) return null;
      const capture = captures.get(nativeEvent);
      return capture && capture.publication === publication ? capture : null;
    },
    canClaim,
    claim: (capture, bubble, publication) => {
      if (!canClaim(capture, bubble, publication)) return null;
      owner ??= publication;
      captures.delete(bubble.nativeEvent);
      claimedEvents.add(bubble.nativeEvent);
      const claim = Object.freeze({
        identity: Symbol("version-diff-boundary-claim"),
        publication,
        capture,
        bubble,
        listener: bubble.listener,
      });
      claims.add(claim);
      return claim;
    },
    retains: (claim, publication) =>
      owns(publication) &&
      owner === publication &&
      claims.has(claim) &&
      claim.publication === publication &&
      claim.capture.publication === publication &&
      claim.bubble.publication === publication &&
      claim.listener === claim.bubble.listener &&
      claimedEvents.has(claim.bubble.nativeEvent),
    release: (publication) => {
      if (released || (owner !== null && owner !== publication)) return;
      owner = publication;
      released = true;
    },
  };
  return Object.freeze(pairing);
}

function createVersionDiffPublication(
  authority: VersionDiffAuthority,
  coordinator: VersionDiffCoordinator,
): VersionDiffPublicationSet {
  let currentRuntime: VersionDiffPublicationRuntime | null = null;
  let lastRuntime: VersionDiffPublicationRuntime | null = null;
  let successorRequested = false;
  const onElementChange = (
    owner: VersionDiffElementOwnerView,
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
      coordinator.acceptsSuccessorOf(runtime.publication)
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new VersionDiffElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const headerOwner = new VersionDiffElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const bodyOwner = new VersionDiffElementOwner<HTMLDivElement>(
    onElementChange,
  );
  const swapOwner = new VersionDiffElementOwner<HTMLButtonElement>(
    onElementChange,
  );
  const previousOwner = new VersionDiffElementOwner<HTMLButtonElement>(
    onElementChange,
  );
  const nextOwner = new VersionDiffElementOwner<HTMLButtonElement>(
    onElementChange,
  );
  const actionOwners: Readonly<
    Record<VersionDiffActionKind, VersionDiffElementOwner<HTMLButtonElement>>
  > = Object.freeze({
    swap: swapOwner,
    previous: previousOwner,
    next: nextOwner,
  });
  const hunkOwners = authority.hunks.map(
    () => new VersionDiffElementOwner<HTMLElement>(onElementChange),
  );
  const expectedOwners = () =>
    Object.freeze([
      rootOwner,
      headerOwner,
      bodyOwner,
      ...(authority.base ? [swapOwner] : []),
      previousOwner,
      nextOwner,
      ...hunkOwners,
    ]);

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const ownedHeader = headerOwner.element();
    const body = bodyOwner.element();
    const swap = swapOwner.element();
    const previous = previousOwner.element();
    const next = nextOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !root ||
      !root.isConnected ||
      !root.parentNode ||
      !ownerDocument ||
      !ownerWindow ||
      root.tagName !== "DIV" ||
      root.dataset.testid !== "version-diff" ||
      root.tabIndex !== 0 ||
      !body ||
      !body.isConnected ||
      body.ownerDocument !== ownerDocument ||
      body.tagName !== "DIV" ||
      body.parentElement !== root ||
      root.children.length !== 2 ||
      root.children.item(1) !== body ||
      !ownedHeader ||
      hunkOwners.length !== authority.hunks.length
    ) {
      return false;
    }
    const header = root.children.item(0);
    const pre = body.firstElementChild;
    if (
      !(header instanceof ownerWindow.HTMLDivElement) ||
      header !== ownedHeader ||
      header.ownerDocument !== ownerDocument ||
      header.parentElement !== root ||
      !(pre instanceof ownerWindow.HTMLPreElement) ||
      body.children.length !== 1 ||
      pre.parentElement !== body
    ) {
      return false;
    }
    const expectedButtons = authority.base
      ? [swap, previous, next]
      : [previous, next];
    const renderedButtons = header.querySelectorAll<HTMLButtonElement>("button");
    if (
      (authority.base === null ? swap !== null : swap === null) ||
      !previous ||
      !next ||
      expectedButtons.some((button) => !button) ||
      renderedButtons.length !== expectedButtons.length ||
      expectedButtons.some(
        (button, index) =>
          button !== renderedButtons.item(index) ||
          !button?.isConnected ||
          button.ownerDocument !== ownerDocument ||
          !header.contains(button),
      ) ||
      (swap !== null && swap.dataset.testid !== "diff-swap") ||
      previous.dataset.testid !== "diff-prev" ||
      next.dataset.testid !== "diff-next" ||
      swap?.disabled === true ||
      previous.disabled !== (authority.active <= 0) ||
      next.disabled !== (authority.active >= authority.hunks.length - 1) ||
      authority.actions.some((fact) => {
        const button = actionOwners[fact.kind].element();
        return (
          !button ||
          fact.callback !== authority.actions[fact.order]?.callback ||
          fact.eligible === button.disabled
        );
      })
    ) {
      return false;
    }
    const rendered = root.querySelectorAll<HTMLElement>("[data-hunk]");
    if (rendered.length !== hunkOwners.length) return false;
    return hunkOwners.every((owner, index) => {
      const element = owner.element();
      return (
        authority.hunks[index]?.index === index &&
        element instanceof ownerWindow.HTMLElement &&
        element.isConnected &&
        element.ownerDocument === ownerDocument &&
        element.parentElement === pre &&
        rendered.item(index) === element &&
        element.dataset.hunk === String(index) &&
        element.dataset.testid === `diff-hunk-${index + 1}` &&
        (element.dataset.active === "true") ===
          (index === authority.active)
      );
    });
  };

  const requestReplaySuccessor = (
    runtime: VersionDiffPublicationRuntime,
  ) => {
    const replay = runtime.replay();
    if (
      successorRequested ||
      !coordinator.acceptsSuccessorOf(runtime.publication) ||
      !versionDiffAuthorityIsCurrent(authority) ||
      !exactDomIsCurrent() ||
      !runtime.historyIsClean() ||
      !runtime.publishedDomMatches() ||
      !coordinator.stageReplay(replay)
    ) {
      return;
    }
    successorRequested = true;
    authority.requestSuccessor();
  };

  const createRuntime = (
    root: HTMLDivElement,
    header: HTMLDivElement,
    body: HTMLDivElement,
    actionElements: Readonly<
      Record<VersionDiffActionKind, HTMLButtonElement | null>
    >,
    hunkElements: readonly HTMLElement[],
    dom: VersionDiffDomSnapshot,
  ): VersionDiffPublicationRuntime | null => {
    type Retirement = "element" | "layout";
    const ownerDocument = root.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placement = captureVersionDiffPlacement(root);
    const rootPath = captureVersionDiffEventPath(root, ownerDocument);
    if (!ownerWindow || !placement || !rootPath) return null;
    const keyboard = captureVersionDiffKeyboardIntrinsics(
      ownerDocument,
      ownerWindow,
    );
    const keyListener = keyboard
      ? createVersionDiffKeyListener(keyboard)
      : null;
    const boundaryPairing = keyboard
      ? createVersionDiffBoundaryPairing()
      : null;
    const domGuard = createVersionDiffDomGuard(root, placement);
    if (!domGuard) return null;
    const identity = Symbol("version-diff-publication");
    const publishedActions: readonly VersionDiffPublishedAction[] =
      Object.freeze(
        authority.actions
          .filter(({ eligible }) => eligible)
          .map((fact) => {
            const element = actionElements[fact.kind];
            if (!element) {
              throw new Error(
                "Cannot publish an eligible version diff action without its element",
              );
            }
            return Object.freeze({
              identity: Symbol(`version-diff-${fact.kind}-action`),
              publicationIdentity: identity,
              fact,
              element,
              order: fact.order,
            });
          }),
      );
    const movements: readonly VersionDiffActionMovement[] = Object.freeze(
      publishedActions.flatMap((source) =>
        (
          [
            "ArrowLeft",
            "ArrowUp",
            "ArrowRight",
            "ArrowDown",
            "Home",
            "End",
          ] as const
        ).map((key) =>
          Object.freeze({
            identity: Symbol(`version-diff-${source.fact.kind}-${key}`),
            key,
            source,
            destination: versionDiffActionDestination(
              publishedActions,
              source,
              key,
            ),
          }),
        ),
      ),
    );
    const publication: VersionDiffPublication = Object.freeze({
      identity,
      authority,
      root,
      rootParent: root.parentNode!,
      header,
      body,
      hunks: Object.freeze([...hunkElements]),
      actionElements,
      actions: publishedActions,
      movements,
      rootPath,
      ownerDocument,
      ownerWindow,
      dom,
      placement,
      keyboard,
      keyListener,
      boundaryPairing,
    });
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let invalidReplay = false;
    let replayRefs: VersionDiffRefReplay[] = [];
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      publication.keyListener?.release(publication);
      publication.boundaryPairing?.release(publication);
      coordinator.retire(publication);
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (coordinator.replay()?.source !== publication) domGuard.release();
      });
      return true;
    };
    const publishedDomMatches = () =>
      root === dom.node &&
      root.parentNode === publication.rootParent &&
      versionDiffPlacementMatches(root, placement) &&
      versionDiffDomMatches(dom, ownerDocument) &&
      publication.hunks.length === authority.hunks.length &&
      publication.hunks.every(
        (element, index) =>
          element === hunkElements[index] &&
          element.dataset.hunk === String(index),
      ) &&
      publication.header === headerOwner.element() &&
      publication.actions.length ===
        authority.actions.filter(({ eligible }) => eligible).length &&
      publication.actions.every((published, index) => {
        const fact = authority.actions.filter(({ eligible }) => eligible)[index];
        return (
          fact !== undefined &&
          published.publicationIdentity === publication.identity &&
          published.fact === fact &&
          published.order === fact.order &&
          published.element === actionOwners[fact.kind].element() &&
          !published.element.disabled
        );
      });
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
    const runtime: VersionDiffPublicationRuntime = Object.freeze({
      publication,
      publish: (owners: readonly VersionDiffElementOwnerView[]) => {
        established = true;
        replayRefs = owners.map((owner: VersionDiffElementOwnerView) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish a version diff without every committed ref",
            );
          }
          return { owner, element, detached: false, reattached: false };
        });
        if (
          !publication.keyListener ||
          !publication.boundaryPairing ||
          !coordinator.publish(publication) ||
          !publication.keyListener.activate(publication)
        ) {
          publication.keyListener?.release(publication);
          publication.boundaryPairing?.release(publication);
          domGuard.release();
          return false;
        }
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: VersionDiffElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
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
        if (
          !retired &&
          replayRefs.every((entry) => entry.owner.element() === entry.element)
        ) {
          for (const entry of replayRefs) {
            entry.detached = false;
            entry.reattached = false;
          }
          invalidReplay = false;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      historyIsClean: domGuard.isClean,
      isExactElementReplay: () =>
        retired &&
        retirement === "element" &&
        layoutRetired &&
        established &&
        refsHaveExactReplay() &&
        domGuard.isClean() &&
        publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        (refsHaveNoReplay() || refsHaveExactReplay()) &&
        domGuard.isClean() &&
        publishedDomMatches(),
      replay: () =>
        Object.freeze({
          source: publication,
          dom,
          placement,
          hunks: publication.hunks,
          historyIsClean: domGuard.isClean,
          release: domGuard.release,
        }),
    });
    return runtime;
  };

  const currentBoundaryPublication =
    (): VersionDiffBoundaryPublication | null => {
      const runtime = currentRuntime;
      const publication = runtime?.publication;
      if (
        !runtime ||
        !publication ||
        runtime.isRetired() ||
        publication.authority !== authority ||
        !versionDiffHasBoundaryPublication(publication) ||
        !publication.keyboard.isCurrent() ||
        !coordinator.isCurrent(publication) ||
        !versionDiffAuthorityIsCurrent(authority) ||
        !exactDomIsCurrent() ||
        !runtime.historyIsClean() ||
        !runtime.publishedDomMatches()
      ) {
        return null;
      }
      return publication;
    };
  const boundaryDeliveryIsCurrent = (
    delivery: VersionDiffBoundaryDelivery,
    expectedPhase: number,
    defaultPrevented: boolean,
    defaultQuery: (...args: never[]) => unknown =
      delivery.methods.isDefaultPrevented,
  ) => {
    const publication = currentBoundaryPublication();
    if (
      !publication ||
      delivery.publication !== publication ||
      delivery.listener.source !== publication.root ||
      delivery.listener.nativeEvent !== delivery.nativeEvent ||
      delivery.key !== delivery.snapshot.key ||
      delivery.setActive !== authority.setActive ||
      delivery.requestSuccessor !== authority.requestSuccessor ||
      delivery.destinationIndex !==
        (delivery.key === "Home" ? 0 : authority.hunks.length - 1) ||
      delivery.destination !== publication.hunks[delivery.destinationIndex] ||
      delivery.destination !== hunkOwners[delivery.destinationIndex]?.element() ||
      !delivery.destination.isConnected ||
      delivery.destination.ownerDocument !== publication.ownerDocument ||
      !publication.body.contains(delivery.destination) ||
      publication.keyboard.activeElement() !== publication.root ||
      publication.keyListener.proofFor(
        delivery.nativeEvent,
        publication,
      ) !== delivery.listener ||
      !versionDiffBoundaryMethodsAreCurrent(delivery, defaultQuery)
    ) {
      return false;
    }
    const snapshot = publication.keyboard.read(delivery.nativeEvent);
    return (
      !!snapshot &&
      snapshot.phase === expectedPhase &&
      snapshot.defaultPrevented === defaultPrevented &&
      !snapshot.cancelBubble &&
      versionDiffBoundaryNativeFactsMatch(delivery.snapshot, snapshot) &&
      versionDiffBoundaryWrapperMatches(
        delivery.wrapper,
        delivery.nativeEvent,
        snapshot,
        publication.root,
      )
    );
  };
  const boundaryPairIsCurrent = (
    capture: VersionDiffBoundaryDelivery,
    bubble: VersionDiffBoundaryDelivery,
  ) => {
    const publication = currentBoundaryPublication();
    return (
      !!publication &&
      publication.boundaryPairing.captureFor(
        bubble.nativeEvent,
        publication,
      ) === capture &&
      capture.snapshot.phase === publication.keyboard.capturingPhase &&
      bubble.snapshot.phase === publication.keyboard.bubblingPhase &&
      versionDiffBoundaryDeliveriesPair(capture, bubble) &&
      versionDiffBoundaryMethodsAreCurrent(capture)
    );
  };
  const invokeBoundaryQuery = (
    delivery: VersionDiffBoundaryDelivery,
    query: (...args: never[]) => unknown,
    expected: boolean,
    attempt: VersionDiffBoundaryAttempt,
    defaultPrevented: boolean,
    defaultQuery: (...args: never[]) => unknown =
      delivery.methods.isDefaultPrevented,
  ) => {
    const publication = currentBoundaryPublication();
    if (!publication) return false;
    let result: unknown;
    try {
      result = publication.keyboard.apply(query, delivery.wrapper, []);
    } catch {
      return false;
    }
    return (
      result === expected &&
      publication.boundaryPairing.attemptIsCurrent(
        delivery.nativeEvent,
        attempt,
      ) &&
      boundaryDeliveryIsCurrent(
        delivery,
        delivery.snapshot.phase,
        defaultPrevented,
        defaultQuery,
      )
    );
  };
  const onBoundaryKeyCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const publication = currentBoundaryPublication();
    if (!publication) return;
    const delivery = readVersionDiffBoundaryDelivery(
      event,
      publication,
      publication.keyboard.capturingPhase,
    );
    if (
      !delivery ||
      !boundaryDeliveryIsCurrent(
        delivery,
        publication.keyboard.capturingPhase,
        false,
      )
    ) {
      return;
    }
    const attempt = publication.boundaryPairing.begin(delivery.nativeEvent);
    if (!attempt) return;
    try {
      if (
        !invokeBoundaryQuery(
          delivery,
          delivery.methods.isDefaultPrevented,
          false,
          attempt,
          false,
        ) ||
        !invokeBoundaryQuery(
          delivery,
          delivery.methods.isPropagationStopped,
          false,
          attempt,
          false,
        ) ||
        !publication.boundaryPairing.attemptIsCurrent(
          delivery.nativeEvent,
          attempt,
        ) ||
        currentBoundaryPublication() !== publication
      ) {
        return;
      }
      publication.boundaryPairing.remember(delivery, publication);
    } finally {
      publication.boundaryPairing.finish(delivery.nativeEvent, attempt);
    }
  };

  let capturedActionGroup: VersionDiffActionDelivery | null = null;
  let capturedAction: VersionDiffActionDelivery | null = null;
  let bubbledAction: VersionDiffActionDelivery | null = null;
  const clearActionBoundaryProof = () => {
    capturedActionGroup = null;
    capturedAction = null;
    bubbledAction = null;
  };
  const currentActionPublication = () => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    if (
      !runtime ||
      !publication ||
      runtime.isRetired() ||
      publication.authority !== authority ||
      !coordinator.isCurrent(publication) ||
      !versionDiffAuthorityIsCurrent(authority) ||
      !exactDomIsCurrent() ||
      !runtime.historyIsClean() ||
      !runtime.publishedDomMatches()
    ) {
      return null;
    }
    return publication;
  };
  const onActionGroupKeyDownCapture = (
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    clearActionBoundaryProof();
    const publication = currentActionPublication();
    if (!publication) return;
    const delivery = readVersionDiffActionDelivery(
      event,
      publication,
      publication.header,
      publication.keyboard?.capturingPhase ?? -1,
    );
    if (!delivery || delivery.currentTarget !== publication.header) return;
    capturedActionGroup = delivery;
    queueMicrotask(() => {
      if (capturedActionGroup === delivery) clearActionBoundaryProof();
    });
  };
  const actionHandlers = Object.freeze(
    Object.fromEntries(
      (["swap", "previous", "next"] as const).map((kind) => {
        const onKeyDownCapture = (
          event: KeyboardEvent<HTMLButtonElement>,
        ) => {
          const publication = currentActionPublication();
          const source = actionOwners[kind].element();
          const delivery =
            publication && source
              ? readVersionDiffActionDelivery(
                  event,
                  publication,
                  source,
                  publication.keyboard?.capturingPhase ?? -1,
                )
              : null;
          if (
            !capturedActionGroup ||
            capturedAction ||
            bubbledAction ||
            !delivery ||
            !source ||
            delivery.source !== source ||
            delivery.action.fact.kind !== kind ||
            !versionDiffDeliveriesMatchWithinPhase(
              capturedActionGroup,
              delivery,
            )
          ) {
            clearActionBoundaryProof();
            return;
          }
          capturedAction = delivery;
        };
        const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          const publication = currentActionPublication();
          const source = actionOwners[kind].element();
          const delivery =
            publication && source
              ? readVersionDiffActionDelivery(
                  event,
                  publication,
                  source,
                  publication.keyboard?.bubblingPhase ?? -1,
                )
              : null;
          if (
            !capturedActionGroup ||
            !capturedAction ||
            bubbledAction ||
            !delivery ||
            !source ||
            delivery.source !== source ||
            delivery.action.fact.kind !== kind ||
            !versionDiffDeliveriesMatchWithinPhase(
              capturedActionGroup,
              capturedAction,
            ) ||
            !versionDiffDeliveriesMatchAcrossPhases(
              capturedAction,
              delivery,
            )
          ) {
            clearActionBoundaryProof();
            return;
          }
          bubbledAction = delivery;
        };
        return [kind, Object.freeze({ onKeyDownCapture, onKeyDown })];
      }),
    ) as Record<
      VersionDiffActionKind,
      Readonly<{
        onKeyDownCapture: (event: KeyboardEvent<HTMLButtonElement>) => void;
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
      }>
    >,
  );
  const onActionGroupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const groupCapture = capturedActionGroup;
    const actionCapture = capturedAction;
    const actionBubble = bubbledAction;
    const publication = currentActionPublication();
    const groupBubble = publication
      ? readVersionDiffActionDelivery(
          event,
          publication,
          publication.header,
          publication.keyboard?.bubblingPhase ?? -1,
        )
      : null;
    clearActionBoundaryProof();
    if (
      !publication ||
      !publication.keyboard ||
      !publication.keyListener ||
      !groupCapture ||
      !actionCapture ||
      !actionBubble ||
      !groupBubble ||
      !versionDiffDeliveriesMatchWithinPhase(groupCapture, actionCapture) ||
      !versionDiffDeliveriesMatchWithinPhase(actionBubble, groupBubble) ||
      !versionDiffDeliveriesMatchAcrossPhases(actionCapture, actionBubble) ||
      groupCapture.currentTarget !== publication.header ||
      actionCapture.currentTarget !== actionCapture.source ||
      actionBubble.currentTarget !== actionBubble.source ||
      groupBubble.currentTarget !== publication.header ||
      !versionDiffReactMethodsRemainFalse(groupCapture) ||
      !versionDiffReactMethodsRemainFalse(actionCapture) ||
      !versionDiffReactMethodsRemainFalse(actionBubble) ||
      !versionDiffReactMethodsRemainFalse(groupBubble)
    ) {
      return;
    }
    const movement = publication.movements.find(
      (candidate) =>
        candidate.source === groupBubble.action &&
        candidate.key === groupBubble.key,
    );
    const destination = movement?.destination ?? null;
    if (!movement || !destination) return;
    const source = movement.source;
    const keyboard = publication.keyboard;
    const runtime = currentRuntime;
    if (
      !runtime ||
      runtime.publication !== publication ||
      source !== groupBubble.action ||
      source.fact !== authority.actions[source.fact.order] ||
      source.fact.callback !== authority.actions[source.fact.order]?.callback ||
      !source.fact.eligible ||
      destination.fact !== authority.actions[destination.fact.order] ||
      destination.fact.callback !==
        authority.actions[destination.fact.order]?.callback ||
      !destination.fact.eligible ||
      source.element !== actionOwners[source.fact.kind].element() ||
      destination.element !==
        actionOwners[destination.fact.kind].element() ||
      source.element.disabled ||
      destination.element.disabled ||
      keyboard.activeElement() !== source.element ||
      !publication.keyListener.claim(groupBubble.listener, publication) ||
      !coordinator.claimActionKeyboard(
        publication,
        movement,
        groupCapture.wrapper,
        groupBubble.wrapper,
        groupBubble.nativeEvent,
        groupBubble.listener,
        source,
        destination,
      )
    ) {
      return;
    }
    if (
      !publication.keyListener.retains(groupBubble.listener, publication) ||
      !versionDiffReactMethodsRemainFalse(groupCapture) ||
      !versionDiffReactMethodsRemainFalse(actionCapture) ||
      !versionDiffReactMethodsRemainFalse(actionBubble) ||
      !versionDiffReactMethodsRemainFalse(groupBubble) ||
      currentActionPublication() !== publication ||
      keyboard.activeElement() !== source.element
    ) {
      return;
    }
    try {
      keyboard.apply(
        groupBubble.methods.preventDefault,
        groupBubble.wrapper,
        [],
      );
    } catch {
      return;
    }
    let publicDefaultWasPrevented = false;
    try {
      const currentDefaultQuery = groupBubble.wrapper.isDefaultPrevented;
      publicDefaultWasPrevented =
        keyboard.methodMatches(
          groupBubble.wrapper,
          "isDefaultPrevented",
          currentDefaultQuery,
        ) &&
        keyboard.apply(
            currentDefaultQuery as (...args: never[]) => unknown,
            groupBubble.wrapper,
            [],
          ) === true;
    } catch {
      return;
    }
    if (
      !keyboard.defaultWasPrevented(groupBubble.nativeEvent) ||
      !groupBubble.wrapper.defaultPrevented ||
      !publicDefaultWasPrevented ||
      !publication.keyListener.retains(groupBubble.listener, publication)
    ) {
      return;
    }
    if (
      !keyboard.focus(destination.element) ||
      keyboard.activeElement() !== destination.element ||
      !publication.keyListener.retains(groupBubble.listener, publication)
    ) {
      return;
    }
    authority.requestSuccessor();
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        coordinator.acceptsSuccessorOf(lastRuntime.publication)
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (
      !versionDiffAuthorityIsCurrent(authority) ||
      !exactDomIsCurrent()
    ) {
      return undefined;
    }
    const root = rootOwner.element();
    const header = headerOwner.element();
    const body = bodyOwner.element();
    const actionElements = Object.freeze({
      swap: swapOwner.element(),
      previous: previousOwner.element(),
      next: nextOwner.element(),
    });
    const hunkElements = hunkOwners.map((owner) => owner.element());
    if (
      !root ||
      !header ||
      !body ||
      !actionElements.previous ||
      !actionElements.next ||
      (authority.base !== null && !actionElements.swap) ||
      hunkElements.some((element) => !element)
    ) {
      return undefined;
    }
    const replay = coordinator.replay();
    if (replay) {
      const replayIsCurrent =
        replay.historyIsClean() &&
        coordinator.acceptsSuccessorOf(replay.source) &&
        versionDiffAuthoritiesMatch(replay.source.authority, authority) &&
        replay.dom.node === root &&
        replay.placement.document === root.ownerDocument &&
        versionDiffPlacementMatches(root, replay.placement) &&
        versionDiffDomMatches(replay.dom, root.ownerDocument) &&
        replay.hunks.length === hunkOwners.length &&
        hunkOwners.every(
          (owner, index) => owner.element() === replay.hunks[index],
        );
      coordinator.abandonReplay(replay.source);
      if (!replayIsCurrent) return undefined;
    }
    const runtime = createRuntime(
      root,
      header,
      body,
      actionElements,
      hunkElements as HTMLElement[],
      snapshotVersionDiffDom(root),
    );
    if (!runtime) return undefined;
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish(expectedOwners())) {
      runtime.retireForElement();
      return undefined;
    }
    return runtime.retireForLayout;
  };

  const onBoundaryKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const publication = currentBoundaryPublication();
    if (!publication) return;
    const delivery = readVersionDiffBoundaryDelivery(
      event,
      publication,
      publication.keyboard.bubblingPhase,
    );
    const capture = delivery
      ? publication.boundaryPairing.captureFor(
          delivery.nativeEvent,
          publication,
        )
      : null;
    if (
      !delivery ||
      !capture ||
      !boundaryPairIsCurrent(capture, delivery) ||
      !boundaryDeliveryIsCurrent(
        delivery,
        publication.keyboard.bubblingPhase,
        false,
      )
    ) {
      return;
    }
    const attempt = publication.boundaryPairing.begin(delivery.nativeEvent);
    if (!attempt) return;
    try {
      if (
        !invokeBoundaryQuery(
          delivery,
          delivery.methods.isDefaultPrevented,
          false,
          attempt,
          false,
        ) ||
        !boundaryPairIsCurrent(capture, delivery) ||
        !invokeBoundaryQuery(
          delivery,
          delivery.methods.isPropagationStopped,
          false,
          attempt,
          false,
        ) ||
        !boundaryPairIsCurrent(capture, delivery)
      ) {
        return;
      }

      try {
        publication.keyboard.apply(
          delivery.methods.preventDefault,
          delivery.wrapper,
          [],
        );
      } catch {
        return;
      }
      let currentDefaultQuery: (...args: never[]) => unknown;
      try {
        currentDefaultQuery = delivery.wrapper.isDefaultPrevented;
      } catch {
        return;
      }
      if (
        typeof currentDefaultQuery !== "function" ||
        !publication.boundaryPairing.attemptIsCurrent(
          delivery.nativeEvent,
          attempt,
        ) ||
        currentBoundaryPublication() !== publication ||
        !boundaryPairIsCurrent(capture, delivery) ||
        !boundaryDeliveryIsCurrent(
          delivery,
          publication.keyboard.bubblingPhase,
          true,
          currentDefaultQuery,
        ) ||
        !publication.keyboard.defaultWasPrevented(delivery.nativeEvent) ||
        !invokeBoundaryQuery(
          delivery,
          currentDefaultQuery,
          true,
          attempt,
          true,
          currentDefaultQuery,
        ) ||
        !boundaryPairIsCurrent(capture, delivery) ||
        !invokeBoundaryQuery(
          delivery,
          delivery.methods.isPropagationStopped,
          false,
          attempt,
          true,
          currentDefaultQuery,
        ) ||
        !boundaryPairIsCurrent(capture, delivery) ||
        !publication.boundaryPairing.canClaim(
          capture,
          delivery,
          publication,
        ) ||
        !coordinator.canClaimKeyboard(
          publication,
          delivery.wrapper,
          delivery.nativeEvent,
        ) ||
        !publication.keyListener.claim(delivery.listener, publication)
      ) {
        return;
      }
      const claim = publication.boundaryPairing.claim(
        capture,
        delivery,
        publication,
      );
      if (
        !claim ||
        !coordinator.claimKeyboard(
          publication,
          delivery.wrapper,
          delivery.nativeEvent,
        )
      ) {
        return;
      }
      const readyForEffect = () =>
        publication.boundaryPairing.attemptIsCurrent(
          delivery.nativeEvent,
          attempt,
        ) &&
        currentBoundaryPublication() === publication &&
        versionDiffBoundaryMethodsAreCurrent(
          capture,
          capture.methods.isDefaultPrevented,
        ) &&
        boundaryDeliveryIsCurrent(
          delivery,
          publication.keyboard.bubblingPhase,
          true,
          currentDefaultQuery,
        ) &&
        publication.boundaryPairing.retains(claim, publication) &&
        publication.keyListener.retains(delivery.listener, publication) &&
        coordinator.retainsKeyboard(
          publication,
          delivery.wrapper,
          delivery.nativeEvent,
        ) &&
        delivery.setActive === authority.setActive &&
        delivery.requestSuccessor === authority.requestSuccessor &&
        delivery.destination === publication.hunks[delivery.destinationIndex] &&
        delivery.destination ===
          hunkOwners[delivery.destinationIndex]?.element() &&
        publication.keyboard.activeElement() === publication.root;

      if (!readyForEffect()) return;
      if (delivery.destinationIndex !== authority.active) {
        delivery.setActive(delivery.destinationIndex);
        if (
          !readyForEffect() ||
          !publication.keyboard.reveal(delivery.destination) ||
          !readyForEffect()
        ) {
          return;
        }
      }
      if (!readyForEffect()) return;
      delivery.requestSuccessor();
    } finally {
      publication.boundaryPairing.finish(delivery.nativeEvent, attempt);
    }
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureHeader: headerOwner.capture,
    captureBody: bodyOwner.capture,
    captureSwap: swapOwner.capture,
    capturePrevious: previousOwner.capture,
    captureNext: nextOwner.capture,
    captureHunks: Object.freeze(hunkOwners.map((owner) => owner.capture)),
    root: rootOwner.element as () => HTMLDivElement | null,
    establish,
    onBoundaryKeyCapture,
    onBoundaryKey,
    onActionGroupKeyDownCapture,
    onActionGroupKeyDown,
    actionHandlers,
  });
}

/** Read-only comparison of a past version against the live document, or of two versions (old → new). */
export function VersionDiffView({ session, preview }: { session: CollabSession; preview: VersionPreview }) {
  const { version, content, base, range } = preview;
  const current = useSessionValue(session, (s) => s.ytext.toString());
  const [mount] = useState(() => Symbol("version-diff"));
  const [coordinator] = useState(() => new VersionDiffCoordinator(mount));
  const [swapped, setSwapped] = useState(false);
  const [active, setActive] = useState(0);
  const [, setPublicationRevision] = useState(0);
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
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
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
  const onSwap = useCallback(() => {
    setSwapped((currentSwapped) => !currentSwapped);
  }, []);
  const onPrevious = useCallback(() => {
    goTo(active - 1);
  }, [active, goTo]);
  const onNext = useCallback(() => {
    goTo(active + 1);
  }, [active, goTo]);
  /* eslint-disable react-hooks/refs -- Publication members are retained callbacks used only by refs, effects, and events. */
  const actionFacts: readonly VersionDiffActionFact[] = Object.freeze([
    ...(base
      ? [
          Object.freeze({
            identity: Symbol("version-diff-swap-fact"),
            kind: "swap" as const,
            order: 0,
            callback: onSwap,
            eligible: true,
          }),
        ]
      : []),
    Object.freeze({
      identity: Symbol("version-diff-previous-fact"),
      kind: "previous" as const,
      order: base ? 1 : 0,
      callback: onPrevious,
      eligible: active > 0,
    }),
    Object.freeze({
      identity: Symbol("version-diff-next-fact"),
      kind: "next" as const,
      order: base ? 2 : 1,
      callback: onNext,
      eligible: active < hunkList.length - 1,
    }),
  ]);
  const authority: VersionDiffAuthority = Object.freeze({
    mount,
    session,
    documentId: session.docId,
    role: session.role,
    ytext: session.ytext,
    preview,
    version: captureVersionDiffVersion(version),
    content,
    base: base
      ? Object.freeze({
          source: base,
          version: captureVersionDiffVersion(base.version),
          content: base.content,
        })
      : null,
    rangeSource: range,
    range: Object.freeze((range ?? []).map(captureVersionDiffVersion)),
    current,
    swapped,
    oldText,
    newText,
    segments,
    hunkList,
    hunks: Object.freeze(
      hunkList.map((hunk, index) =>
        Object.freeze({
          index,
          source: hunk,
          start: hunk.start,
          end: hunk.end,
          kind: hunk.kind,
        }),
      ),
    ),
    active,
    setActive,
    actions: actionFacts,
    requestSuccessor: requestPublicationSuccessor,
  });
  const diffPublication = createVersionDiffPublication(
    authority,
    coordinator,
  );
  const captureRoot = (element: HTMLDivElement | null) => {
    rootRef.current = element;
    diffPublication.captureRoot(element);
  };
  const captureBody = (element: HTMLDivElement | null) => {
    bodyRef.current = element;
    diffPublication.captureBody(element);
  };

  useEffect(() => {
    setActive(0);
  }, [oldText, newText]);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => diffPublication.establish(), [diffPublication]);

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    let key: string;
    try {
      key = e.key;
    } catch {
      return;
    }
    if (key === "Home" || key === "End") {
      diffPublication.onBoundaryKeyCapture(
        e as KeyboardEvent<HTMLDivElement>,
      );
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    let key: string;
    try {
      key = e.key;
    } catch {
      return;
    }
    if (key === "Home" || key === "End") {
      diffPublication.onBoundaryKey(
        e as KeyboardEvent<HTMLDivElement>,
      );
      return;
    }
    if (e.target instanceof HTMLElement && /^(input|textarea|button)$/i.test(e.target.tagName) && key !== "[" && key !== "]") return;
    if (key === "]") {
      e.preventDefault();
      goTo(active + 1);
    } else if (key === "[") {
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
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      data-testid="version-diff"
      ref={captureRoot}
      tabIndex={0}
      onKeyDownCapture={onKeyDownCapture}
      onKeyDown={onKeyDown}
    >
      <div
        ref={diffPublication.captureHeader}
        className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-6 py-2"
        onKeyDownCapture={diffPublication.onActionGroupKeyDownCapture}
        onKeyDown={diffPublication.onActionGroupKeyDown}
      >
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
          <button
            ref={diffPublication.captureSwap}
            type="button"
            className="btn btn-sm btn-ghost gap-1"
            onClick={onSwap}
            onKeyDownCapture={
              diffPublication.actionHandlers.swap.onKeyDownCapture
            }
            onKeyDown={diffPublication.actionHandlers.swap.onKeyDown}
            title="Swap old and new"
            data-testid="diff-swap"
          >
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
            <button
              ref={diffPublication.capturePrevious}
              type="button"
              className="icon-btn h-7 w-7"
              onClick={onPrevious}
              onKeyDownCapture={
                diffPublication.actionHandlers.previous.onKeyDownCapture
              }
              onKeyDown={diffPublication.actionHandlers.previous.onKeyDown}
              disabled={active <= 0}
              aria-label="Previous change ([)"
              title="Previous change ([)"
              data-testid="diff-prev"
            >
              <ChevronUp size={14} />
            </button>
            <span className="min-w-[7ch] text-center tabular-nums" data-testid="diff-counter">
              {hunkCounter(active, hunkList.length)}
            </span>
            <button
              type="button"
              ref={diffPublication.captureNext}
              className="icon-btn h-7 w-7"
              onClick={onNext}
              onKeyDownCapture={
                diffPublication.actionHandlers.next.onKeyDownCapture
              }
              onKeyDown={diffPublication.actionHandlers.next.onKeyDown}
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
      <div className="scrollbar-thin flex-1 overflow-y-auto" ref={captureBody}>
        <pre className="md-diff whitespace-pre-wrap break-words px-8 py-6 font-mono text-[14px] leading-7 text-ink-2">
          {blocks.map((b, i) =>
            "hunk" in b ? (
              <span
                key={i}
                ref={diffPublication.captureHunks[b.hunk]}
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
  /* eslint-enable react-hooks/refs */
}
