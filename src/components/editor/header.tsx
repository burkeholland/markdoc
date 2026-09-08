"use client";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Check,
  ChevronDown,
  CloudOff,
  Loader2,
  MessageSquare,
  MoreVertical,
  Pencil,
  Share2,
  UserPlus,
  History,
  Download,
  FileCode2,
  FileText,
  Copy,
  Files,
  Trash2,
  Keyboard,
  Command,
  ExternalLink,
  AlertTriangle,
  Eye,
  PenLine,
  MessageSquarePlus,
  LogOut,
  ArrowLeft,
  RefreshCw,
  UploadCloud,
  Link2,
  Star,
  BookOpen,
  PanelLeft,
  Code2,
  GitMerge,
  Bot,
} from "lucide-react";
import type { CollabSession, EditMode, PresenceUser, SaveState } from "@/editor/collab/session";
import type { SyncStatusDto } from "@/lib/api";
import { GITHUB_NOT_CONFIGURED, SYNC_LABELS } from "./labels";
import { isIdle } from "@/editor/collab/follow";
import { saveStateLabel } from "@/editor/collab/offline";
import type { DocumentDto } from "@/server/dto";
import { api, apiErrorText } from "@/lib/api";
import type { Layout } from "@/lib/viewport";

import { cn, shortcut } from "@/lib/utils";
import { jsonEqual, useOpenSettled, useSessionValue } from "./use-session";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import type { NotificationDto } from "@/lib/api";
import { pendingRequests, useAgentRequests } from "./agent-requests";
import { AgentBusyBadge, KeepAgentHereButton, PresenceActivity, PresenceRequests, WaitingPlaceholder, busyAgentNames, isRecentActivity, pendingWorker, presenceAgentName, presenceNameOf, useAgentActivity, waitingLabel } from "./presence-agents";
import { signOutSafely } from "@/lib/sign-out";
import { Logo } from "@/components/ui/logo";
import { useEverTrue, useHydrated } from "@/lib/hooks";
import { lazyOnFirstUse } from "./lazy-on-first-use";
import { HEADER_BOX } from "./chrome-classes";

// On demand (#1150): the dialog, with the agent-connect card and copy blocks behind it, is fetched on its first
// open and then stays mounted (mount-once gate below), so Radix's close handling and focus return are unchanged.
const KeepAgentHereDialog = lazyOnFirstUse(() => import("./keep-agent-here"), (m) => m.KeepAgentHereDialog);

interface ManualSaveOperation {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly canEdit: boolean;
  readonly flushSave: CollabSession["flushSave"];
  readonly serial: number;
  readonly publication: ManualSavePublication;
  readonly action: object;
}

type ManualSaveState =
  | { readonly owner: ManualSaveOperation; readonly status: "pending" }
  | { readonly owner: ManualSaveOperation; readonly status: "failed"; readonly message: string };

type ManualSaveIcon = "check" | "cloud-off" | "loader" | "alert";

interface ManualSaveRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly canEdit: boolean;
  readonly flushSave: CollabSession["flushSave"];
  readonly liveState: SaveState;
  readonly liveUnsyncedChanges: number;
  readonly liveDirty: boolean;
  readonly liveUnsynced: number;
  readonly liveRecovered: boolean;
  readonly liveProlonged: boolean;
  readonly saveError: string | null;
  readonly hydrated: boolean;
  readonly compact: boolean | undefined;
  readonly state: SaveState;
  readonly unsynced: number;
  readonly recovered: boolean;
  readonly prolonged: boolean;
  readonly label: string;
  readonly manualSave: ManualSaveState | null;
  readonly manualPending: boolean;
  readonly manualError: string | null;
  readonly flash: boolean;
  readonly icon: ManualSaveIcon;
  readonly iconClassName: string | undefined;
  readonly rootClassName: string;
  readonly rootTitle: string | undefined;
  readonly buttonClassName: string;
  readonly buttonLabel: string;
  readonly buttonDisabled: boolean;
  readonly buttonBusy: boolean;
  readonly textClassName: string;
  readonly text: string;
  readonly action: object;
}

interface ManualSaveElementOwnerView {
  readonly element: () => Element | null;
}

class ManualSaveElementOwner<T extends Element> implements ManualSaveElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: ManualSaveElementOwnerView,
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture = (element: T | null) => {
    if (element === this.#current) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(this, element, previous, last);
  };
}

interface ManualSaveDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ManualSaveDomSnapshot[];
}

interface ManualSavePlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ManualSaveDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface ManualSaveReplay {
  readonly source: ManualSavePublication;
  readonly dom: ManualSaveDomSnapshot;
  readonly placements: readonly ManualSavePlacement[];
  readonly expectSuccessor: (identity: object) => void;
  readonly replayIsExact: (identity: object) => boolean;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface ManualSavePublication {
  readonly render: ManualSaveRender;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly isExact: () => boolean;
}

interface ManualSaveRefReplay {
  readonly owner: ManualSaveElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface ManualSavePublicationRuntime {
  readonly publication: ManualSavePublication;
  readonly publish: (
    snapshot: ManualSaveDomSnapshot,
    placements: readonly ManualSavePlacement[],
    owners: readonly ManualSaveElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: ManualSaveElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly snapshot: () => ManualSaveDomSnapshot | null;
  readonly placements: () => readonly ManualSavePlacement[] | null;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
  readonly claimActivation: () => boolean;
  readonly beginReplayHandoff: () => void;
  readonly expectSuccessor: (identity: object) => void;
  readonly successorTransitionIsExact: (identity: object) => boolean;
}

interface ManualSavePublicationSet {
  readonly captureRoot: React.RefCallback<HTMLSpanElement>;
  readonly captureButton: React.RefCallback<HTMLButtonElement>;
  readonly captureIcon: React.RefCallback<SVGSVGElement>;
  readonly captureText: React.RefCallback<HTMLSpanElement>;
  readonly establish: () => void | (() => void);
  readonly onRootClickCapture: (event: React.MouseEvent<HTMLSpanElement>) => void;
  readonly onButtonClickCapture: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface ManualSaveClickAdmission {
  readonly publication: ManualSavePublication;
  readonly nativeEvent: MouseEvent;
  readonly reactEvent: React.MouseEvent<HTMLSpanElement>;
  readonly target: Node;
  readonly root: HTMLSpanElement;
  readonly button: HTMLButtonElement;
}

interface ManualSaveCells {
  readonly active: { current: ManualSavePublication | null };
  readonly successorOf: { current: ManualSavePublication | null };
  readonly replay: { current: ManualSaveReplay | null };
  readonly requestOwner: { current: ManualSaveOperation | null };
  readonly nextOperation: { current: number };
  readonly claimedPublications: WeakSet<ManualSavePublication>;
  readonly claimedActions: WeakSet<object>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly clickAdmissions: WeakMap<Event, ManualSaveClickAdmission>;
}

const MANUAL_SAVE_ICON_FACTS: Readonly<Record<ManualSaveIcon, {
  readonly className: string;
  readonly strokeWidth: string;
  readonly paths: readonly string[];
}>> = Object.freeze({
  check: Object.freeze({
    className: "lucide lucide-check",
    strokeWidth: "2.5",
    paths: Object.freeze(["M20 6 9 17l-5-5"]),
  }),
  "cloud-off": Object.freeze({
    className: "lucide lucide-cloud-off",
    strokeWidth: "2",
    paths: Object.freeze([
      "M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057",
      "M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78",
      "m2 2 20 20",
    ]),
  }),
  loader: Object.freeze({
    className: "lucide lucide-loader-circle animate-spin",
    strokeWidth: "2",
    paths: Object.freeze(["M21 12a9 9 0 1 1-6.219-8.56"]),
  }),
  alert: Object.freeze({
    className: "lucide lucide-triangle-alert",
    strokeWidth: "2",
    paths: Object.freeze([
      "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      "M12 9v4",
      "M12 17h.01",
    ]),
  }),
});

function manualSaveVisual(state: SaveState): {
  icon: ManualSaveIcon;
  iconClassName: string | undefined;
  className: string;
} {
  switch (state) {
    case "saved":
      return { icon: "check", iconClassName: undefined, className: "text-success" };
    case "pending":
      return { icon: "cloud-off", iconClassName: undefined, className: "text-ink-3" };
    case "saving":
    case "connecting":
      return { icon: "loader", iconClassName: "animate-spin", className: "text-ink-3" };
    case "reconnecting":
      return { icon: "loader", iconClassName: "animate-spin", className: "text-warning" };
    case "offline":
      return { icon: "cloud-off", iconClassName: undefined, className: "text-warning" };
    case "error":
      return { icon: "alert", iconClassName: undefined, className: "text-danger" };
  }
}

function manualSaveOperationMatches(
  operation: ManualSaveOperation,
  mount: symbol,
  session: CollabSession,
  canEdit: boolean,
  flushSave: CollabSession["flushSave"],
) {
  return operation.mount === mount
    && operation.session === session
    && operation.canEdit === canEdit
    && operation.flushSave === flushSave;
}

function clearManualSaveRequest(
  cells: ManualSaveCells,
  operation: ManualSaveOperation,
) {
  if (cells.requestOwner.current === operation) cells.requestOwner.current = null;
}

function manualSaveStatesMatch(left: ManualSaveState | null, right: ManualSaveState | null) {
  return left === null
    ? right === null
    : right !== null
      && left.owner === right.owner
      && left.status === right.status
      && (left.status !== "failed" || (right.status === "failed" && left.message === right.message));
}

function manualSaveRendersMatch(left: ManualSaveRender, right: ManualSaveRender) {
  return left.mount === right.mount
    && left.session === right.session
    && left.canEdit === right.canEdit
    && left.flushSave === right.flushSave
    && left.liveState === right.liveState
    && left.liveUnsyncedChanges === right.liveUnsyncedChanges
    && left.liveDirty === right.liveDirty
    && left.liveUnsynced === right.liveUnsynced
    && left.liveRecovered === right.liveRecovered
    && left.liveProlonged === right.liveProlonged
    && left.saveError === right.saveError
    && left.hydrated === right.hydrated
    && left.compact === right.compact
    && left.state === right.state
    && left.unsynced === right.unsynced
    && left.recovered === right.recovered
    && left.prolonged === right.prolonged
    && left.label === right.label
    && manualSaveStatesMatch(left.manualSave, right.manualSave)
    && left.manualPending === right.manualPending
    && left.manualError === right.manualError
    && left.flash === right.flash
    && left.icon === right.icon
    && left.iconClassName === right.iconClassName
    && left.rootClassName === right.rootClassName
    && left.rootTitle === right.rootTitle
    && left.buttonClassName === right.buttonClassName
    && left.buttonLabel === right.buttonLabel
    && left.buttonDisabled === right.buttonDisabled
    && left.buttonBusy === right.buttonBusy
    && left.textClassName === right.textClassName
    && left.text === right.text;
}

function manualSaveFactsAreCurrent(render: ManualSaveRender) {
  const {
    session,
    hydrated,
    compact,
    manualSave,
    manualPending,
    manualError,
  } = render;
  const liveState = session.saveState;
  const liveUnsyncedChanges = session.unsyncedChanges;
  const liveDirty = session.dirty;
  const liveUnsynced = Math.max(liveUnsyncedChanges, liveDirty ? 1 : 0);
  const liveRecovered = session.recovered;
  const liveProlonged = session.prolongedOffline;
  const saveError = session.saveError;
  const state: SaveState = hydrated ? liveState : "connecting";
  const unsynced = hydrated ? liveUnsynced : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = state === "error" && saveError
    ? "Save failed — retry"
    : saveStateLabel(state, unsynced, recovered, prolonged);
  const visual = manualSaveVisual(state);
  const flash = state === "saved" && recovered;
  const currentError = manualSave?.status === "failed" ? manualSave.message : null;
  const currentPending = manualSave?.status === "pending";
  const rootClassName = cn(
    "inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors",
    visual.className,
    flash && "save-state-recovered",
  );
  const rootTitle = currentError ?? saveError ?? (compact ? label : undefined);
  const buttonClassName = "inline-flex items-center gap-1.5";
  const buttonLabel = "Save document";
  const buttonDisabled = !session.canEdit || currentPending;
  const textClassName = cn(compact ? "sr-only" : "max-md:sr-only");
  return session.canEdit === render.canEdit
    && session.flushSave === render.flushSave
    && liveState === render.liveState
    && liveUnsyncedChanges === render.liveUnsyncedChanges
    && liveDirty === render.liveDirty
    && liveUnsynced === render.liveUnsynced
    && liveRecovered === render.liveRecovered
    && liveProlonged === render.liveProlonged
    && saveError === render.saveError
    && state === render.state
    && unsynced === render.unsynced
    && recovered === render.recovered
    && prolonged === render.prolonged
    && label === render.label
    && currentPending === manualPending
    && currentError === manualError
    && flash === render.flash
    && visual.icon === render.icon
    && visual.iconClassName === render.iconClassName
    && rootClassName === render.rootClassName
    && rootTitle === render.rootTitle
    && buttonClassName === render.buttonClassName
    && buttonLabel === render.buttonLabel
    && buttonDisabled === render.buttonDisabled
    && currentPending === render.buttonBusy
    && textClassName === render.textClassName
    && (currentError ?? label) === render.text;
}

function snapshotManualSaveAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function manualSaveAttributesAreExact(
  element: Element,
  expected: readonly (readonly [string, string])[],
) {
  const actual = snapshotManualSaveAttributes(element);
  const sortedExpected = [...expected].sort(([left], [right]) => left.localeCompare(right));
  return actual !== null
    && actual.length === sortedExpected.length
    && actual.every(([name, value], index) => {
      const pair = sortedExpected[index];
      return pair?.[0] === name && pair[1] === value;
    });
}

function manualSaveIconIsExact(
  icon: SVGSVGElement,
  render: ManualSaveRender,
) {
  const facts = MANUAL_SAVE_ICON_FACTS[render.icon];
  const iconAttributes = [
    ["aria-hidden", "true"],
    ["class", facts.className],
    ["fill", "none"],
    ["height", "16"],
    ["stroke", "currentColor"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["stroke-width", facts.strokeWidth],
    ["viewBox", "0 0 24 24"],
    ["width", "16"],
    ["xmlns", "http://www.w3.org/2000/svg"],
  ] as const;
  if (
    !manualSaveAttributesAreExact(icon, iconAttributes)
    || icon.childNodes.length !== facts.paths.length
  ) {
    return false;
  }
  const SVGElementConstructor = icon.ownerDocument.defaultView?.SVGElement;
  return facts.paths.every((path, index) => {
    const child = icon.childNodes.item(index);
    return Boolean(
      SVGElementConstructor
      && child instanceof SVGElementConstructor
      && child.localName === "path"
      && child.childNodes.length === 0
      && manualSaveAttributesAreExact(child, [["d", path]]),
    );
  });
}

function snapshotManualSaveDom(node: Node): ManualSaveDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotManualSaveAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotManualSaveDom)),
  });
}

function manualSaveDomMatches(snapshot: ManualSaveDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotManualSaveAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length
    || attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  return node.childNodes.length === snapshot.children.length
    && snapshot.children.every(
      (child, index) => node.childNodes.item(index) === child.node && manualSaveDomMatches(child),
    );
}

function snapshotManualSavePlacement(
  root: HTMLSpanElement,
): readonly ManualSavePlacement[] | null {
  const placements: ManualSavePlacement[] = [];
  const ownerDocument = root.ownerDocument;
  for (let node: Node | null = root; node; node = node.parentNode) {
    placements.push(Object.freeze({
      node,
      parent: node.parentNode,
      previousSibling: node.previousSibling,
      nextSibling: node.nextSibling,
    }));
    if (node === ownerDocument) return Object.freeze(placements);
  }
  return null;
}

function manualSavePlacementsMatch(placements: readonly ManualSavePlacement[]) {
  return placements.length > 0
    && placements[placements.length - 1]?.node.nodeType === 9
    && placements.every(({ node, parent, previousSibling, nextSibling }) =>
      node.parentNode === parent
      && node.previousSibling === previousSibling
      && node.nextSibling === nextSibling);
}

function createManualSaveDomGuard(
  root: HTMLSpanElement,
  placements: readonly ManualSavePlacement[],
  onInvalidated: () => void,
): ManualSaveDomGuard | null {
  const ownerDocument = root.ownerDocument;
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  const placementNodes = new Set(placements.map(({ node }) => node));
  let changed = false;
  let released = false;
  const isRelevant = (record: MutationRecord) => {
    if (record.target === root || root.contains(record.target)) return true;
    if (record.type !== "childList" || !placementNodes.has(record.target)) return false;
    return (record.previousSibling !== null && placementNodes.has(record.previousSibling))
      || (record.nextSibling !== null && placementNodes.has(record.nextSibling))
      || [...record.addedNodes, ...record.removedNodes].some((node) =>
        placementNodes.has(node) || node.contains(root));
  };
  const inspect = (records: readonly MutationRecord[]) => {
    if (changed || released || !records.some(isRelevant)) return;
    changed = true;
    onInvalidated();
  };
  const observer = new MutationObserverConstructor(inspect);
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const { node } of placements.slice(1)) {
    observer.observe(node, { childList: true });
  }
  return Object.freeze({
    isClean: () => {
      if (!released) inspect(observer.takeRecords());
      return !changed && !released;
    },
    release: () => {
      if (released) return;
      inspect(observer.takeRecords());
      released = true;
      observer.disconnect();
    },
  });
}

function manualSavePlacementIsExact(
  root: HTMLSpanElement,
  placements: readonly ManualSavePlacement[],
) {
  return root.isConnected
    && placements[0]?.node === root
    && placements[placements.length - 1]?.node === root.ownerDocument
    && manualSavePlacementsMatch(placements);
}

function clearDetachedManualSaveReplay(
  cells: ManualSaveCells,
  mount: symbol,
) {
  const replay = cells.replay.current;
  if (
    !replay
    || replay.source.render.mount !== mount
    || replay.dom.node.isConnected
  ) {
    return;
  }
  cells.replay.current = null;
  if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
  replay.release();
}

function manualSaveReactMouseWrapperPrototype(
  event: React.MouseEvent<Element>,
  nativeEvent: MouseEvent,
  currentTarget: Element,
  target: Node,
  phase: number,
): object | null {
  const prototype = Object.getPrototypeOf(event) as object | null;
  const constructor = prototype
    ? Reflect.get(prototype, "constructor") as unknown
    : null;
  if (
    !prototype
    || prototype === Object.prototype
    || typeof constructor !== "function"
    || constructor === Object
    || constructor.prototype !== prototype
    || event.nativeEvent !== nativeEvent
    || event.type !== nativeEvent.type
    || event.currentTarget !== currentTarget
    || event.target !== target
    || nativeEvent.target !== target
    || event.button !== nativeEvent.button
    || event.buttons !== nativeEvent.buttons
    || event.altKey !== nativeEvent.altKey
    || event.ctrlKey !== nativeEvent.ctrlKey
    || event.metaKey !== nativeEvent.metaKey
    || event.shiftKey !== nativeEvent.shiftKey
    || event.clientX !== nativeEvent.clientX
    || event.clientY !== nativeEvent.clientY
    || event.detail !== nativeEvent.detail
    || event.bubbles !== nativeEvent.bubbles
    || event.cancelable !== nativeEvent.cancelable
    || event.eventPhase !== nativeEvent.eventPhase
    || nativeEvent.eventPhase !== phase
    || event.isTrusted !== nativeEvent.isTrusted
    || event.timeStamp !== nativeEvent.timeStamp
    || event.defaultPrevented
    || nativeEvent.defaultPrevented
    || typeof event.preventDefault !== "function"
    || typeof event.stopPropagation !== "function"
    || typeof event.isDefaultPrevented !== "function"
    || typeof event.isPropagationStopped !== "function"
    || typeof event.persist !== "function"
  ) {
    return null;
  }
  return prototype;
}

function createManualSavePublication(
  render: ManualSaveRender,
  cells: ManualSaveCells,
  requestSuccessor: () => void,
  setManualSave: React.Dispatch<React.SetStateAction<ManualSaveState | null>>,
): ManualSavePublicationSet {
  let currentRuntime: ManualSavePublicationRuntime | null = null;
  let lastRuntime: ManualSavePublicationRuntime | null = null;
  let successorRequested = false;

  const requestReplaySuccessor = (runtime: ManualSavePublicationRuntime) => {
    const dom = runtime.snapshot();
    const placements = runtime.placements();
    if (
      successorRequested
      || !dom
      || !placements
      || cells.successorOf.current !== runtime.publication
      || !manualSaveFactsAreCurrent(render)
      || !exactDomIsCurrent()
      || !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    runtime.beginReplayHandoff();
    cells.replay.current = Object.freeze({
      source: runtime.publication,
      dom,
      placements,
      expectSuccessor: runtime.expectSuccessor,
      replayIsExact: runtime.successorTransitionIsExact,
      historyIsClean: runtime.mutationHistoryIsClean,
      release: runtime.release,
    });
    requestSuccessor();
  };

  const onElementChange = (
    owner: ManualSaveElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (element === null || (element !== null && last !== null && element !== last)) {
      currentRuntime?.retireForElement();
    }
    if (
      runtime?.isExactElementReplay()
      && cells.successorOf.current === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };
  const rootOwner = new ManualSaveElementOwner<HTMLSpanElement>(onElementChange);
  const buttonOwner = new ManualSaveElementOwner<HTMLButtonElement>(onElementChange);
  const iconOwner = new ManualSaveElementOwner<SVGSVGElement>(onElementChange);
  const textOwner = new ManualSaveElementOwner<HTMLSpanElement>(onElementChange);

  const expectedOwners = (): readonly ManualSaveElementOwnerView[] => [
    rootOwner,
    buttonOwner,
    iconOwner,
    textOwner,
  ];

  const exactDomIsCurrent = () => {
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const icon = iconOwner.element();
    const text = textOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !root
      || !button
      || !icon
      || !text
      || !ownerWindow
      || !(root instanceof ownerWindow.HTMLSpanElement)
      || !(button instanceof ownerWindow.HTMLButtonElement)
      || !(icon instanceof ownerWindow.SVGSVGElement)
      || !(text instanceof ownerWindow.HTMLSpanElement)
      || !root.isConnected
      || !button.isConnected
      || root.ownerDocument !== ownerDocument
      || button.ownerDocument !== ownerDocument
      || icon.ownerDocument !== ownerDocument
      || text.ownerDocument !== ownerDocument
      || root.tagName !== "SPAN"
      || root.className !== render.rootClassName
      || root.dataset.testid !== "save-state"
      || root.dataset.state !== render.state
      || root.dataset.liveState !== render.state
      || root.dataset.unsynced !== String(render.unsynced)
      || root.getAttribute("data-recovered") !== (render.flash ? "true" : null)
      || root.getAttribute("data-prolonged") !== (render.prolonged ? "true" : null)
      || root.getAttribute("role") !== "status"
      || root.getAttribute("title") !== (render.rootTitle ?? null)
      || root.children.length !== 1
      || root.firstElementChild !== button
      || button.parentElement !== root
      || button.tagName !== "BUTTON"
      || button.type !== "button"
      || button.className !== render.buttonClassName
      || button.disabled !== render.buttonDisabled
      || button.getAttribute("aria-disabled") !== null
      || button.getAttribute("aria-busy") !== (render.buttonBusy ? "true" : null)
      || button.getAttribute("aria-label") !== render.buttonLabel
      || button.children.length !== 2
      || button.children.item(0) !== icon
      || button.children.item(1) !== text
      || icon.parentElement !== button
      || icon.localName !== "svg"
      || icon.classList.contains("animate-spin") !== (render.iconClassName === "animate-spin")
      || text.parentElement !== button
      || text.tagName !== "SPAN"
      || text.className !== render.textClassName
      || text.textContent !== render.text
      || button.textContent !== render.text
      || root.querySelectorAll("button").length !== 1
    ) {
      return false;
    }
    const rootAttributes: (readonly [string, string])[] = [
      ["class", render.rootClassName],
      ["data-live-state", render.state],
      ["data-state", render.state],
      ["data-testid", "save-state"],
      ["data-unsynced", String(render.unsynced)],
      ["role", "status"],
    ];
    if (render.flash) rootAttributes.push(["data-recovered", "true"]);
    if (render.prolonged) rootAttributes.push(["data-prolonged", "true"]);
    if (render.rootTitle !== undefined) rootAttributes.push(["title", render.rootTitle]);
    const buttonAttributes: (readonly [string, string])[] = [
      ["aria-label", render.buttonLabel],
      ["class", render.buttonClassName],
      ["type", "button"],
    ];
    if (render.buttonBusy) buttonAttributes.push(["aria-busy", "true"]);
    if (render.buttonDisabled) buttonAttributes.push(["disabled", ""]);
    return manualSaveAttributesAreExact(root, rootAttributes)
      && manualSaveAttributesAreExact(button, buttonAttributes)
      && manualSaveIconIsExact(icon, render)
      && manualSaveAttributesAreExact(text, [["class", render.textClassName]]);
  };

  const createRuntime = (): ManualSavePublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: ManualSaveDomSnapshot | null = null;
    let placementSnapshots: readonly ManualSavePlacement[] | null = null;
    let domGuard: ManualSaveDomGuard | null = null;
    let replayRefs: ManualSaveRefReplay[] = [];
    let invalidReplay = false;
    let activationClaimed = false;
    let replayHandedOff = false;
    let replayHandoffInvalid = false;
    let expectedSuccessor: object | null = null;

    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        clearDetachedManualSaveReplay(cells, render.mount);
        if (cells.replay.current?.source !== publication) domGuard?.release();
      });
      return true;
    };
    const publishedDomMatches = () => {
      const root = rootOwner.element();
      return Boolean(
        domSnapshot
        && placementSnapshots
        && domGuard?.isClean()
        && root
        && root === domSnapshot.node
        && manualSavePlacementIsExact(root, placementSnapshots)
        && manualSaveDomMatches(domSnapshot)
      );
    };
    const publication: ManualSavePublication = Object.freeze({
      render,
      retire: () => retire("other"),
      isRetired: () => retired,
      isExact: () => !retired
        && manualSaveFactsAreCurrent(render)
        && exactDomIsCurrent()
        && publishedDomMatches(),
    });
    const refsHaveNoReplay = () => !invalidReplay
      && replayRefs.every((entry) =>
        !entry.detached
        && !entry.reattached
        && entry.owner.element() === entry.element);
    const refsHaveExactReplay = () => !invalidReplay
      && replayRefs.length > 0
      && replayRefs.every((entry) =>
        entry.detached
        && entry.reattached
        && entry.owner.element() === entry.element);
    const runtime: ManualSavePublicationRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: ManualSaveDomSnapshot,
        placements: readonly ManualSavePlacement[],
        owners: readonly ManualSaveElementOwnerView[],
      ) => {
        const root = rootOwner.element();
        if (!root) throw new Error("Cannot publish SaveIndicator without its status root");
        domGuard = createManualSaveDomGuard(root, placements, () => retire("mutation"));
        if (!domGuard) {
          throw new Error("Cannot publish SaveIndicator without a DOM mutation observer");
        }
        established = true;
        domSnapshot = snapshot;
        placementSnapshots = placements;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) throw new Error("Cannot publish SaveIndicator without every committed ref");
          return { owner, element, detached: false, reattached: false };
        });
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: ManualSaveElementOwnerView,
        element: Element | null,
        previous: Element | null,
      ) => {
        if (!established) return;
        if (replayHandedOff && expectedSuccessor === null) {
          replayHandoffInvalid = true;
        }
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (element === null && previous === proof.element) {
          proof.detached = true;
          proof.reattached = false;
        } else if (element === proof.element && previous === null && proof.detached) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      publishedDomMatches,
      isExactElementReplay: () => retired
        && retirement === "element"
        && layoutRetired
        && established
        && refsHaveExactReplay()
        && publishedDomMatches(),
      isExactLayoutReplay: () => retired
        && retirement === "layout"
        && established
        && (refsHaveNoReplay() || refsHaveExactReplay())
        && publishedDomMatches(),
      snapshot: () => domSnapshot,
      placements: () => placementSnapshots,
      mutationHistoryIsClean: () => domGuard?.isClean() ?? false,
      release: () => domGuard?.release(),
      claimActivation: () => {
        if (activationClaimed) return false;
        activationClaimed = true;
        return true;
      },
      beginReplayHandoff: () => {
        replayHandedOff = true;
      },
      expectSuccessor: (identity: object) => {
        expectedSuccessor = identity;
      },
      successorTransitionIsExact: (identity: object) =>
        replayHandedOff
        && !replayHandoffInvalid
        && expectedSuccessor === identity
        && replayRefs.every((entry) =>
          entry.detached
          && !entry.reattached
          && entry.owner.element() === null),
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() || lastRuntime.isExactElementReplay())
        && cells.successorOf.current === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!manualSaveFactsAreCurrent(render) || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    const placements = root ? snapshotManualSavePlacement(root) : null;
    if (!root || !placements || !manualSavePlacementIsExact(root, placements)) return undefined;

    const replay = cells.replay.current;
    if (replay) {
      const sameRender = manualSaveRendersMatch(replay.source.render, render);
      const exactReplay = sameRender
        && replay.source.isRetired()
        && cells.successorOf.current === replay.source
        && replay.replayIsExact(render.identity)
        && replay.historyIsClean()
        && root === replay.dom.node
        && manualSavePlacementIsExact(root, replay.placements)
        && manualSaveDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
      if (sameRender && !exactReplay) return undefined;
    }

    const runtime = createRuntime();
    const previous = cells.active.current;
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(snapshotManualSaveDom(root), placements, expectedOwners());
    return runtime.retireForLayout;
  };

  const replay = cells.replay.current;
  if (replay && manualSaveRendersMatch(replay.source.render, render)) {
    replay.expectSuccessor(render.identity);
  }

  const requestIsCurrent = (operation: ManualSaveOperation) => {
    const current = cells.active.current;
    return cells.requestOwner.current === operation
      && !!current
      && current.render.mount === operation.mount
      && current.render.session === operation.session
      && current.render.canEdit === operation.canEdit
      && current.render.flushSave === operation.flushSave
      && current.isExact()
      && (
        current === operation.publication
        || (
          current.render.manualPending
          && current.render.manualSave?.owner === operation
        )
      );
  };

  const settle = (
    operation: ManualSaveOperation,
    error: unknown | null,
  ) => {
    if (!requestIsCurrent(operation)) return;
    cells.requestOwner.current = null;
    setManualSave((current) => {
      if (current?.owner !== operation) return current;
      return error === null
        ? null
        : Object.freeze({
            owner: operation,
            status: "failed" as const,
            message: error instanceof Error ? error.message : "Save failed",
          });
    });
  };

  const onRootClickCapture = (event: React.MouseEvent<HTMLSpanElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !runtime
      || !publication
      || !root
      || !button
      || !ownerDocument
      || !ownerWindow
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== ownerDocument
      || !button.contains(target)
      || !isLiveNativeEvent(nativeEvent, ownerDocument)
      || !nativeEvent.composedPath().includes(root)
      || !nativeEvent.composedPath().includes(button)
      || cells.active.current !== publication
      || publication.render !== render
      || publication.render.identity !== render.identity
      || render.buttonDisabled
      || !render.canEdit
      || !publication.isExact()
      || cells.clickAdmissions.has(nativeEvent)
    ) {
      return;
    }
    const wrapperPrototype = manualSaveReactMouseWrapperPrototype(
      event,
      nativeEvent,
      root,
      target,
      ownerWindow.Event.CAPTURING_PHASE,
    );
    if (!wrapperPrototype) return;
    cells.clickAdmissions.set(nativeEvent, Object.freeze({
      publication,
      nativeEvent,
      reactEvent: event,
      target,
      root,
      button,
    }));
  };

  const onButtonClickCapture = (event: React.MouseEvent<HTMLButtonElement>) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    const wrapperPrototype = (
      ownerWindow
      && button
      && nativeEvent instanceof ownerWindow.MouseEvent
      && target instanceof ownerWindow.Node
    )
      ? manualSaveReactMouseWrapperPrototype(
          event,
          nativeEvent,
          button,
          target,
          ownerWindow.Event.CAPTURING_PHASE,
        )
      : null;
    const admission = ownerWindow && nativeEvent instanceof ownerWindow.Event
      ? cells.clickAdmissions.get(nativeEvent)
      : undefined;
    if (
      !runtime
      || !publication
      || !root
      || !button
      || !ownerDocument
      || !ownerWindow
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== ownerDocument
      || !button.contains(target)
      || nativeEvent.button !== 0
      || !wrapperPrototype
      || !isLiveNativeEvent(nativeEvent, ownerDocument)
      || !nativeEvent.composedPath().includes(button)
      || !admission
      || admission.publication !== publication
      || admission.nativeEvent !== nativeEvent
      || admission.reactEvent !== event
      || admission.target !== target
      || admission.root !== root
      || admission.button !== button
      || cells.requestOwner.current !== null
      || cells.claimedPublications.has(publication)
      || cells.claimedActions.has(render.action)
      || cells.claimedReactEvents.has(event)
      || cells.claimedNativeEvents.has(nativeEvent)
      || cells.active.current !== publication
      || publication.render !== render
      || publication.render.identity !== render.identity
      || !publication.isExact()
      || render.buttonDisabled
      || !render.canEdit
      || !runtime.claimActivation()
    ) {
      return;
    }

    cells.clickAdmissions.delete(nativeEvent);
    const operation: ManualSaveOperation = Object.freeze({
      mount: render.mount,
      session: render.session,
      canEdit: render.canEdit,
      flushSave: render.flushSave,
      serial: cells.nextOperation.current + 1,
      publication,
      action: render.action,
    });
    cells.nextOperation.current = operation.serial;
    cells.claimedPublications.add(publication);
    cells.claimedActions.add(render.action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    cells.requestOwner.current = operation;
    setManualSave(Object.freeze({ owner: operation, status: "pending" }));

    void (async () => {
      try {
        await operation.flushSave.call(operation.session);
        settle(operation, null);
      } catch (error: unknown) {
        settle(operation, error);
      } finally {
        if (cells.requestOwner.current === operation) cells.requestOwner.current = null;
      }
    })();
  };

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureButton: buttonOwner.capture,
    captureIcon: iconOwner.capture,
    captureText: textOwner.capture,
    establish,
    onRootClickCapture,
    onButtonClickCapture,
  });
}

export function SaveIndicator({ session, compact }: { session: CollabSession; compact?: boolean }) {
  const liveState = useSessionValue(session, (s) => s.saveState);
  const liveUnsyncedChanges = useSessionValue(session, (s) => s.unsyncedChanges);
  const liveDirty = useSessionValue(session, (s) => s.dirty);
  const liveUnsynced = Math.max(liveUnsyncedChanges, liveDirty ? 1 : 0);
  const liveRecovered = useSessionValue(session, (s) => s.recovered);
  const liveProlonged = useSessionValue(session, (s) => s.prolongedOffline);
  const saveError = useSessionValue(session, (s) => s.saveError);
  const [mount] = useState(() => Symbol("save indicator"));
  const [cells] = useState<ManualSaveCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    requestOwner: { current: null },
    nextOperation: { current: 0 },
    claimedPublications: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    clickAdmissions: new WeakMap(),
  }));
  const [manualSave, setManualSave] = useState<ManualSaveState | null>(null);
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const canEdit = session.canEdit;
  const flushSave = session.flushSave;
  const compatibleManualSave = manualSave
    && manualSaveOperationMatches(manualSave.owner, mount, session, canEdit, flushSave)
    && (
      manualSave.status === "failed"
      || cells.requestOwner.current === manualSave.owner
    )
    ? manualSave
    : null;
  const manualPending = compatibleManualSave?.status === "pending";
  const manualError = compatibleManualSave?.status === "failed" ? compatibleManualSave.message : null;

  useLayoutEffect(() => {
    const requestOwner = cells.requestOwner.current;
    if (
      requestOwner
      && !manualSaveOperationMatches(requestOwner, mount, session, canEdit, flushSave)
    ) {
      clearManualSaveRequest(cells, requestOwner);
    }
    if (manualSave && manualSave !== compatibleManualSave) {
      setManualSave((current) => current === manualSave ? null : current);
    }
  }, [canEdit, cells, compatibleManualSave, flushSave, manualSave, mount, session]);
  useEffect(() => () => {
    const requestOwner = cells.requestOwner.current;
    if (requestOwner?.mount === mount) clearManualSaveRequest(cells, requestOwner);
    clearDetachedManualSaveReplay(cells, mount);
  }, [cells, mount]);

  // The server renders a fresh session ("Connecting…"); an offline client may already have
  // failed to connect by the time React hydrates. Match the server markup first, then switch.
  const hydrated = useHydrated();
  const state: SaveState = hydrated ? liveState : "connecting";
  const unsynced = hydrated ? liveUnsynced : 0;
  const recovered = hydrated && liveRecovered;
  const prolonged = hydrated && liveProlonged;
  const label = state === "error" && saveError
    ? "Save failed — retry"
    : saveStateLabel(state, unsynced, recovered, prolonged);
  const visual = manualSaveVisual(state);
  const flash = state === "saved" && recovered;
  const rootClassName = cn(
    "inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors",
    visual.className,
    flash && "save-state-recovered",
  );
  const rootTitle = manualError ?? saveError ?? (compact ? label : undefined);
  const buttonClassName = "inline-flex items-center gap-1.5";
  const buttonLabel = "Save document";
  const buttonDisabled = !canEdit || manualPending;
  const textClassName = cn(compact ? "sr-only" : "max-md:sr-only");
  const text = manualError ?? label;
  const render = Object.freeze<ManualSaveRender>({
    identity: Object.freeze({}),
    mount,
    session,
    canEdit,
    flushSave,
    liveState,
    liveUnsyncedChanges,
    liveDirty,
    liveUnsynced,
    liveRecovered,
    liveProlonged,
    saveError,
    hydrated,
    compact,
    state,
    unsynced,
    recovered,
    prolonged,
    label,
    manualSave: compatibleManualSave,
    manualPending,
    manualError,
    flash,
    icon: visual.icon,
    iconClassName: visual.iconClassName,
    rootClassName,
    rootTitle,
    buttonClassName,
    buttonLabel,
    buttonDisabled,
    buttonBusy: manualPending,
    textClassName,
    text,
    action: Object.freeze({}),
  });
  const publication = createManualSavePublication(
    render,
    cells,
    requestPublicationSuccessor,
    setManualSave,
  );
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    captureButton,
    captureIcon,
    captureText,
    onRootClickCapture,
    onButtonClickCapture,
  } = publication;
  const icon = visual.icon === "check"
    ? <Check ref={captureIcon} size={16} strokeWidth={2.5} />
    : visual.icon === "cloud-off"
      ? <CloudOff ref={captureIcon} size={16} />
      : visual.icon === "loader"
        ? <Loader2 ref={captureIcon} size={16} className={visual.iconClassName} />
        : <AlertTriangle ref={captureIcon} size={16} />;
  return (
    <span
      ref={captureRoot}
      className={rootClassName}
      data-testid="save-state"
      data-state={state}
      data-live-state={state}
      data-unsynced={unsynced}
      data-recovered={flash || undefined}
      data-prolonged={prolonged || undefined}
      role="status"
      title={rootTitle}
      onClickCapture={onRootClickCapture}
    >
      <button
        ref={captureButton}
        type="button"
        className={buttonClassName}
        disabled={buttonDisabled}
        aria-busy={manualPending || undefined}
        aria-label={buttonLabel}
        onClickCapture={onButtonClickCapture}
      >
        {icon}
        {/* Phones show the icon only; the server markup uses the same responsive label. */}
        <span ref={captureText} className={textClassName}>{text}</span>
      </button>
    </span>
  );
}

interface TitleEditState {
  readonly generation: object;
  readonly session: CollabSession;
  readonly draft: string;
}

interface TitleRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly fallback: string;
  readonly title: string;
  readonly role: CollabSession["role"];
  readonly canEdit: boolean;
  readonly compact: boolean | undefined;
  readonly editing: boolean;
  readonly draft: string;
  readonly generation: object | null;
  readonly setTitle: CollabSession["setTitle"];
  readonly buttonClassName: string;
  readonly buttonTitle: string;
  readonly titleClassName: string;
  readonly iconClassName: string;
  readonly inputClassName: string;
  readonly inputLabel: string;
}

interface TitleDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly TitleDomSnapshot[];
}

interface TitleDisplayPresentation {
  readonly kind: "display";
  readonly render: TitleRender;
  readonly document: Document;
  readonly button: HTMLButtonElement;
  readonly title: HTMLSpanElement;
  readonly icon: SVGSVGElement | null;
  readonly snapshot: TitleDomSnapshot;
  readonly targets: WeakSet<Node>;
}

interface TitleInputPresentation {
  readonly kind: "input";
  readonly render: TitleRender;
  readonly document: Document;
  readonly input: HTMLInputElement;
  readonly snapshot: TitleDomSnapshot;
}

type TitlePresentation = TitleDisplayPresentation | TitleInputPresentation;

interface TitlePublicationRuntime {
  readonly presentation: TitlePresentation;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
}

class TitlePublicationAuthority {
  #active: TitlePresentation | null = null;
  #successorOf: TitlePresentation | null = null;
  #claimedEvents = new WeakSet<Event>();
  #claimedPresentations = new WeakSet<TitlePresentation>();
  #settledGenerations = new WeakSet<object>();
  #focusedInputs = new WeakMap<object, HTMLInputElement>();

  active() {
    return this.#active;
  }

  publish(presentation: TitlePresentation) {
    this.#active = presentation;
    this.#successorOf = null;
  }

  retire(presentation: TitlePresentation) {
    if (this.#active !== presentation) return;
    this.#active = null;
    this.#successorOf = presentation;
  }

  acceptsSuccessorOf(presentation: TitlePresentation) {
    return this.#active === null && this.#successorOf === presentation;
  }

  claim(presentation: TitlePresentation, event: Event, settle = false) {
    const generation = presentation.render.generation;
    if (
      this.#claimedEvents.has(event) ||
      this.#claimedPresentations.has(presentation) ||
      (settle && (!generation || this.#settledGenerations.has(generation)))
    ) {
      return false;
    }
    this.#claimedEvents.add(event);
    this.#claimedPresentations.add(presentation);
    if (settle && generation) this.#settledGenerations.add(generation);
    return true;
  }

  claimFocus(generation: object, input: HTMLInputElement) {
    if (this.#settledGenerations.has(generation) || this.#focusedInputs.get(generation) === input) return false;
    this.#focusedInputs.set(generation, input);
    return true;
  }
}

class TitleElementOwner<T extends Element> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      element: T | null,
      previous: T | null,
      last: T | null,
    ) => void,
  ) {}

  element = () => this.#current;

  capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    const previous = this.#current;
    const last = this.#last;
    this.#current = element;
    if (element) this.#last = element;
    this.onChange(element, previous, last);
  };
}

function snapshotTitleDom(node: Node): TitleDomSnapshot {
  const ElementConstructor = node.ownerDocument?.defaultView?.Element;
  const attributes = ElementConstructor && node instanceof ElementConstructor
    ? Object.freeze(Array.from(node.attributes, (attribute) => Object.freeze([attribute.name, attribute.value] as const)))
    : null;
  const children = Object.freeze(Array.from(node.childNodes, snapshotTitleDom));
  return Object.freeze({ node, nodeValue: node.nodeValue, attributes, children });
}

function titleDomMatches(snapshot: TitleDomSnapshot): boolean {
  const { node, attributes, children } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue || node.childNodes.length !== children.length) return false;
  if (attributes) {
    const ElementConstructor = node.ownerDocument?.defaultView?.Element;
    if (!ElementConstructor || !(node instanceof ElementConstructor) || node.attributes.length !== attributes.length) return false;
    for (let index = 0; index < attributes.length; index++) {
      const expected = attributes[index];
      const actual = node.attributes.item(index);
      if (!actual || actual.name !== expected[0] || actual.value !== expected[1]) return false;
    }
  }
  for (let index = 0; index < children.length; index++) {
    if (node.childNodes.item(index) !== children[index].node || !titleDomMatches(children[index])) return false;
  }
  return true;
}

function collectTitleTargets(snapshot: TitleDomSnapshot, targets: WeakSet<Node>) {
  targets.add(snapshot.node);
  for (const child of snapshot.children) collectTitleTargets(child, targets);
}

function titleRenderIsCurrent(render: TitleRender) {
  const { session } = render;
  const canEdit = session.role === "owner" || session.role === "editor";
  return (
    session.role === render.role &&
    canEdit === render.canEdit &&
    session.setTitle === render.setTitle &&
    (session.title || render.fallback) === render.title
  );
}

function titleDisplayIsExact(presentation: TitleDisplayPresentation) {
  const { render, document, button, title, icon, snapshot } = presentation;
  const ButtonElement = document.defaultView?.HTMLButtonElement;
  const SpanElement = document.defaultView?.HTMLSpanElement;
  const SvgElement = document.defaultView?.SVGSVGElement;
  if (
    !ButtonElement ||
    !SpanElement ||
    !(button instanceof ButtonElement) ||
    !(title instanceof SpanElement) ||
    !button.isConnected ||
    button.ownerDocument !== document ||
    title.ownerDocument !== document ||
    button.tagName !== "BUTTON" ||
    button.type !== "button" ||
    button.disabled ||
    button.getAttribute("aria-disabled") !== null ||
    button.className !== render.buttonClassName ||
    button.title !== render.buttonTitle ||
    button.dataset.testid !== "title" ||
    title.parentElement !== button ||
    title.tagName !== "SPAN" ||
    title.className !== render.titleClassName ||
    title.textContent !== render.title ||
    button.children.length !== (render.canEdit && !render.compact ? 2 : 1) ||
    button.children.item(0) !== title
  ) {
    return false;
  }
  if (render.canEdit && !render.compact) {
    if (
      !SvgElement ||
      !icon ||
      !(icon instanceof SvgElement) ||
      icon.ownerDocument !== document ||
      icon.parentElement !== button ||
      button.children.item(1) !== icon ||
      icon.tagName.toLowerCase() !== "svg" ||
      render.iconClassName.split(" ").some((token) => !icon.classList.contains(token))
    ) {
      return false;
    }
  } else if (icon !== null) {
    return false;
  }
  return titleDomMatches(snapshot);
}

function titleInputIsExact(presentation: TitleInputPresentation, changing = false) {
  const { render, document, input, snapshot } = presentation;
  const InputElement = document.defaultView?.HTMLInputElement;
  return Boolean(
    InputElement &&
    input instanceof InputElement &&
    input.isConnected &&
    input.ownerDocument === document &&
    input.tagName === "INPUT" &&
    input.type === "text" &&
    !input.disabled &&
    !input.readOnly &&
    input.getAttribute("aria-disabled") === null &&
    input.className === render.inputClassName &&
    input.getAttribute("aria-label") === render.inputLabel &&
    input.dataset.testid === "title-input" &&
    input.childNodes.length === 0 &&
    (changing || input.value === render.draft) &&
    titleDomMatches(snapshot)
  );
}

export function TitleEditor({ session, fallback, compact }: { session: CollabSession; fallback: string; compact?: boolean }) {
  const title = useSessionValue(session, (current) => current.title || fallback);
  const role = session.role;
  const canEdit = role === "owner" || role === "editor";
  const [mount] = useState(() => Symbol("title editor"));
  const [authority] = useState(() => new TitlePublicationAuthority());
  const [, setPublicationRevision] = useState(0);
  const [storedEdit, setStoredEdit] = useState<TitleEditState | null>(null);
  let edit = storedEdit;
  if (edit && (edit.session !== session || !canEdit)) {
    edit = null;
    setStoredEdit(null);
  }
  const editing = edit !== null;
  const draft = edit?.draft ?? title;
  const identity = Object.freeze({});
  const runtimeState: {
    layoutPassed: boolean;
    current: TitlePublicationRuntime | null;
    last: TitlePublicationRuntime | null;
    successorRequested: boolean;
  } = {
    layoutPassed: false,
    current: null,
    last: null,
    successorRequested: false,
  };
  const requestSuccessor = () => {
    setPublicationRevision((revision) => revision + 1);
  };
  const retireForElementChange = (
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    if (element === null || (runtimeState.layoutPassed && element !== previous) || (element && last && element !== last)) {
      runtimeState.current?.retireForElement();
    }
    const runtime = runtimeState.last;
    if (
      !runtimeState.successorRequested &&
      runtime?.isExactElementReplay() &&
      authority.acceptsSuccessorOf(runtime.presentation) &&
      titleRenderIsCurrent(render) &&
      titleOwnersMatch(runtime.presentation)
    ) {
      runtimeState.successorRequested = true;
      requestSuccessor();
    }
  };
  const buttonOwner = new TitleElementOwner<HTMLButtonElement>(retireForElementChange);
  const titleOwner = new TitleElementOwner<HTMLSpanElement>(retireForElementChange);
  const iconOwner = new TitleElementOwner<SVGSVGElement>(retireForElementChange);
  const inputOwner = new TitleElementOwner<HTMLInputElement>(retireForElementChange);
  const buttonClassName = cn("group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left", canEdit && "hover:bg-surface-3");
  const buttonTitle = canEdit ? "Rename" : title;
  const titleClassName = cn("doc-title truncate font-semibold leading-8 text-ink", compact ? "text-lg" : "text-lg md:text-[22px]");
  const iconClassName = "shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden";
  const inputClassName = "h-9 min-w-[12rem] max-w-[28rem] rounded-lg border border-accent bg-surface px-2 text-[22px] font-semibold text-ink outline-none ring-2 ring-accent/20";
  const inputLabel = "Document title";
  const render = Object.freeze<TitleRender>({
    identity,
    mount,
    session,
    fallback,
    title,
    role,
    canEdit,
    compact,
    editing,
    draft,
    generation: edit?.generation ?? null,
    setTitle: session.setTitle,
    buttonClassName,
    buttonTitle,
    titleClassName,
    iconClassName,
    inputClassName,
    inputLabel,
  });

  function titleOwnersMatch(presentation: TitlePresentation) {
    if (presentation.render !== render) return false;
    if (presentation.kind === "input") {
      return inputOwner.element() === presentation.input && titleInputIsExact(presentation);
    }
    return (
      buttonOwner.element() === presentation.button &&
      titleOwner.element() === presentation.title &&
      iconOwner.element() === presentation.icon &&
      titleDisplayIsExact(presentation)
    );
  }

  function createRuntime(presentation: TitlePresentation): TitlePublicationRuntime {
    type Retirement = "element" | "layout";
    let retired = false;
    let retirement: Retirement | null = null;
    const matches = () => titleOwnersMatch(presentation);
    const retire = (reason: Retirement) => {
      if (retired) return;
      retired = true;
      retirement = reason;
      authority.retire(presentation);
      if (runtimeState.current?.presentation === presentation) runtimeState.current = null;
    };
    return Object.freeze({
      presentation,
      retireForElement: () => retire("element"),
      retireForLayout: () => retire("layout"),
      isExactElementReplay: () => retired && retirement === "element" && matches(),
      isExactLayoutReplay: () => retired && retirement === "layout" && matches(),
    });
  }

  useEffect(() => {
    document.title = `${title} · Markdoc`;
  }, [title]);

  useLayoutEffect(() => {
    runtimeState.layoutPassed = true;
    if (
      (runtimeState.last && !runtimeState.last.isExactLayoutReplay()) ||
      !titleRenderIsCurrent(render)
    ) {
      return;
    }
    let presentation: TitlePresentation;
    if (render.editing) {
      const input = inputOwner.element();
      if (!input) return;
      presentation = Object.freeze({
        kind: "input",
        render,
        document: input.ownerDocument,
        input,
        snapshot: snapshotTitleDom(input),
      });
      if (!titleInputIsExact(presentation)) return;
    } else {
      const button = buttonOwner.element();
      const titleElement = titleOwner.element();
      const icon = iconOwner.element();
      if (!button || !titleElement || (render.canEdit && !render.compact && !icon)) return;
      const snapshot = snapshotTitleDom(button);
      const targets = new WeakSet<Node>();
      collectTitleTargets(snapshot, targets);
      presentation = Object.freeze({
        kind: "display",
        render,
        document: button.ownerDocument,
        button,
        title: titleElement,
        icon,
        snapshot,
        targets,
      });
      if (!titleDisplayIsExact(presentation)) return;
    }
    const runtime = createRuntime(presentation);
    const previous = authority.active();
    if (previous && previous !== presentation) authority.retire(previous);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    authority.publish(presentation);
    if (
      presentation.kind === "input" &&
      presentation.render.generation &&
      authority.active() === presentation &&
      titleInputIsExact(presentation) &&
      authority.claimFocus(presentation.render.generation, presentation.input)
    ) {
      presentation.input.focus();
      if (
        authority.active() === presentation &&
        titleInputIsExact(presentation) &&
        presentation.document.activeElement === presentation.input
      ) {
        presentation.input.select();
      }
    }
    return runtime.retireForLayout;
  });

  const currentPresentation = (changing = false) => {
    const presentation = authority.active();
    if (
      !presentation ||
      presentation.render !== render ||
      presentation.render.identity !== identity ||
      presentation.render.mount !== mount ||
      presentation.render.session !== session ||
      !titleRenderIsCurrent(render)
    ) {
      return null;
    }
    return presentation.kind === "input"
      ? (titleInputIsExact(presentation, changing) ? presentation : null)
      : (titleDisplayIsExact(presentation) ? presentation : null);
  };

  const changePresentation = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = inputOwner.element();
    if (
      !input ||
      (event.type !== "input" && event.type !== "change") ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.Event) ||
      nativeEvent instanceof ownerWindow.MouseEvent ||
      nativeEvent instanceof ownerWindow.KeyboardEvent ||
      nativeEvent instanceof ownerWindow.FocusEvent ||
      (nativeEvent.type !== "input" && nativeEvent.type !== "change") ||
      nativeEvent.target !== input ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const presentation = currentPresentation(true);
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent)
    ) {
      return null;
    }
    return presentation;
  };

  const blurPresentation = (event: React.FocusEvent<HTMLInputElement>) => {
    const input = inputOwner.element();
    if (
      !input ||
      event.type !== "blur" ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.FocusEvent) ||
      (nativeEvent.type !== "blur" && nativeEvent.type !== "focusout") ||
      nativeEvent.target !== input ||
      nativeEvent.defaultPrevented
    ) {
      return null;
    }
    const presentation = currentPresentation();
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent, true)
    ) {
      return null;
    }
    return presentation;
  };

  const keyboardPresentation = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return null;
    const input = inputOwner.element();
    if (
      !input ||
      event.type !== "keydown" ||
      event.currentTarget !== input ||
      event.target !== input ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.repeat
    ) {
      return null;
    }
    const ownerWindow = input.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
      nativeEvent.type !== "keydown" ||
      nativeEvent.target !== input ||
      nativeEvent.key !== event.key ||
      nativeEvent.defaultPrevented ||
      nativeEvent.altKey ||
      nativeEvent.ctrlKey ||
      nativeEvent.metaKey ||
      nativeEvent.shiftKey ||
      nativeEvent.repeat ||
      nativeEvent.isComposing
    ) {
      return null;
    }
    const presentation = currentPresentation();
    if (
      !presentation ||
      presentation.kind !== "input" ||
      presentation.input !== input ||
      !authority.claim(presentation, nativeEvent, true)
    ) {
      return null;
    }
    return presentation;
  };

  const finish = (presentation: TitleInputPresentation, commit: boolean) => {
    const generation = presentation.render.generation;
    if (!generation) return;
    if (commit) {
      const next = presentation.render.draft.trim();
      if (next && next !== presentation.render.title) {
        presentation.render.setTitle.call(presentation.render.session, next);
      }
    }
    setStoredEdit((current) => current?.generation === generation ? null : current);
  };

  if (editing) {
    return (
      <input
        ref={inputOwner.capture}
        value={draft}
        onChange={(event) => {
          const presentation = changePresentation(event);
          const generation = presentation?.render.generation;
          if (!presentation || !generation) return;
          const nextDraft = presentation.input.value;
          setStoredEdit((current) => current?.generation === generation
            ? Object.freeze({ ...current, draft: nextDraft })
            : current);
        }}
        onBlur={(event) => {
          const presentation = blurPresentation(event);
          if (presentation) finish(presentation, true);
        }}
        onKeyDown={(event) => {
          const presentation = keyboardPresentation(event);
          if (!presentation) return;
          finish(presentation, event.key === "Enter");
        }}
        className={inputClassName}
        aria-label={inputLabel}
        data-testid="title-input"
      />
    );
  }
  return (
    <button
      ref={buttonOwner.capture}
      type="button"
      onClick={(event) => {
        const button = buttonOwner.element();
        if (
          !button ||
          event.type !== "click" ||
          event.currentTarget !== button ||
          event.defaultPrevented
        ) {
          return;
        }
        const ownerWindow = button.ownerDocument.defaultView;
        const nativeEvent = event.nativeEvent;
        const target = event.target;
        if (
          !ownerWindow ||
          !(nativeEvent instanceof ownerWindow.MouseEvent) ||
          nativeEvent.type !== "click" ||
          nativeEvent.button !== 0 ||
          !(target instanceof ownerWindow.Node) ||
          nativeEvent.target !== target ||
          nativeEvent.defaultPrevented
        ) {
          return;
        }
        const presentation = currentPresentation();
        if (
          !presentation ||
          presentation.kind !== "display" ||
          presentation.button !== button ||
          !presentation.render.canEdit ||
          button.disabled ||
          button.getAttribute("aria-disabled") !== null ||
          !presentation.targets.has(target) ||
          !button.contains(target) ||
          !authority.claim(presentation, nativeEvent)
        ) {
          return;
        }
        const nextEdit = Object.freeze<TitleEditState>({
          generation: Object.freeze({}),
          session: presentation.render.session,
          draft: presentation.render.title,
        });
        setStoredEdit((current) => current === null ? nextEdit : current);
      }}
      className={buttonClassName}
      title={buttonTitle}
      data-testid="title"
    >
      {/* Phones render `compact` only after hydration; the `max-md:` rules make the server markup match its size and
          set of controls so the header does not shift when the breakpoint flips (#1470). */}
      <span ref={titleOwner.capture} className={titleClassName}>{title}</span>
      {canEdit && !compact && <Pencil ref={iconOwner.capture} size={15} className={iconClassName} />}
    </button>
  );
}

/**
 * Personal star for the open document. Stars live on the dashboard, so the header asks the API for
 * the current state once the open has settled (the editor does not need it to become editable) and
 * stays hidden for anonymous visitors (who cannot star).
 */
type HeaderStarError = {
  action: "load" | "star" | "unstar";
  message: string;
};

type HeaderStarAuthority = {
  mount: symbol;
  docId: string;
};

type HeaderStarOperation = {
  authority: HeaderStarAuthority;
  operation: number;
  retry: boolean;
} & (
  | { action: "load"; confirmed: null }
  | { action: "star" | "unstar"; confirmed: boolean }
);

interface HeaderStarState {
  docId: string;
  confirmed: boolean | null;
  starred: boolean | null;
  pending: "load" | "toggle" | null;
  error: HeaderStarError | null;
}

const emptyHeaderStarState = (docId: string): HeaderStarState => ({
  docId,
  confirmed: null,
  starred: null,
  pending: null,
  error: null,
});

export function HeaderStar({ docId, ready }: { docId: string; ready: boolean }) {
  const [state, setState] = useState<HeaderStarState>(() => emptyHeaderStarState(docId));
  const [mount] = useState(() => Symbol("header-star"));
  const authority = useRef<HeaderStarAuthority | null>(null);
  const owner = useRef<HeaderStarOperation | null>(null);
  const nextOperation = useRef(0);

  const owns = useCallback(
    (operation: HeaderStarOperation) => authority.current === operation.authority && owner.current === operation,
    [],
  );

  useLayoutEffect(() => {
    const currentAuthority: HeaderStarAuthority | null = ready ? { mount, docId } : null;
    authority.current = currentAuthority;
    owner.current = null;
    setState((current) => {
      if (current.docId === docId && current.confirmed === null && current.starred === null && current.pending === null && current.error === null) return current;
      return emptyHeaderStarState(docId);
    });
    return () => {
      if (authority.current === currentAuthority) authority.current = null;
      if (owner.current?.authority === currentAuthority) owner.current = null;
    };
  }, [docId, mount, ready]);

  const start = useCallback(
    (request: { action: "load"; confirmed: null; retry: boolean } | { action: "star" | "unstar"; confirmed: boolean; retry: boolean }) => {
      const currentAuthority = authority.current;
      if (!ready || !currentAuthority || currentAuthority.mount !== mount || currentAuthority.docId !== docId || owner.current) return;
      const operation: HeaderStarOperation = {
        authority: currentAuthority,
        operation: ++nextOperation.current,
        ...request,
      };
      owner.current = operation;

      if (operation.action === "load") {
        setState((previous) => ({
          docId: operation.authority.docId,
          confirmed: null,
          starred: null,
          pending: "load",
          error: operation.retry && previous.docId === operation.authority.docId && previous.error?.action === "load" ? previous.error : null,
        }));
      } else {
        setState({
          docId: operation.authority.docId,
          confirmed: operation.confirmed,
          starred: operation.action === "star",
          pending: "toggle",
          error: null,
        });
      }

      void (async () => {
        try {
          const result = operation.action === "load"
            ? await api.documents.starred(operation.authority.docId)
            : operation.action === "star"
              ? await api.documents.star(operation.authority.docId)
              : await api.documents.unstar(operation.authority.docId);
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: result.starred,
            starred: result.starred,
            pending: null,
            error: null,
          });
        } catch (error: unknown) {
          if (!owns(operation)) return;
          setState({
            docId: operation.authority.docId,
            confirmed: operation.confirmed,
            starred: operation.confirmed,
            pending: null,
            error: {
              action: operation.action,
              message: apiErrorText(
                error,
                operation.action === "load"
                  ? "Could not load star status"
                  : operation.action === "star"
                    ? "Could not star document"
                    : "Could not unstar document",
              ),
            },
          });
        } finally {
          if (authority.current === operation.authority && owner.current === operation) owner.current = null;
        }
      })();
    },
    [docId, mount, owns, ready],
  );

  useEffect(() => {
    if (ready) start({ action: "load", confirmed: null, retry: false });
  }, [ready, start]);

  if (!ready) return null;
  const current = state.docId === docId ? state : emptyHeaderStarState(docId);
  if (current.starred === null) {
    if (current.error?.action !== "load") return null;
    const retrying = current.pending === "load";
    return (
      <>
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. Retry star status.
        </span>
        <Tip label={retrying ? "Retrying star status…" : `${current.error.message}. Retry.`}>
          <button
            type="button"
            onClick={() => start({ action: "load", confirmed: null, retry: true })}
            disabled={retrying}
            className="icon-btn h-8 w-8 shrink-0 text-danger max-md:hidden"
            aria-label={retrying ? "Retrying star status" : "Retry star status"}
            aria-busy={retrying || undefined}
            data-testid="header-star"
            data-state={retrying ? "retrying" : "error"}
          >
            <RefreshCw size={17} className={retrying ? "animate-spin" : undefined} />
          </button>
        </Tip>
      </>
    );
  }

  const toggle = () => {
    if (current.confirmed === null) return;
    start({
      action: current.starred ? "unstar" : "star",
      confirmed: current.confirmed,
      retry: retryAction !== null,
    });
  };

  const retryAction = current.error?.action === "star" || current.error?.action === "unstar" ? current.error.action : null;
  const label = current.pending === "toggle"
    ? current.starred ? "Starring document…" : "Unstarring document…"
    : retryAction
      ? retryAction === "star" ? "Retry star document" : "Retry unstar document"
      : current.starred ? "Unstar document" : "Star document";

  return (
    <>
      {current.error && (
        <span className="sr-only" role="alert" aria-atomic="true">
          {current.error.message}. {label}.
        </span>
      )}
      <Tip label={label}>
        <button
          type="button"
          onClick={toggle}
          disabled={current.pending === "toggle"}
          className={cn("icon-btn h-8 w-8 shrink-0 max-md:hidden", current.error ? "text-danger" : current.starred ? "text-amber-500" : "text-ink-4")}
          aria-pressed={current.starred}
          aria-label={label}
          aria-busy={current.pending === "toggle" || undefined}
          data-testid="header-star"
          data-starred={current.starred}
          data-state={current.pending ?? (current.error ? "error" : "ready")}
        >
          <Star size={17} fill={current.starred ? "currentColor" : "none"} />
        </button>
      </Tip>
    </>
  );
}

/** Bot avatar for agents in the presence list (same badge style as agent comments in the comments panel). */
function AgentAvatar({ name, color, size }: { name: string; color: string; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 ring-2 ring-surface dark:bg-violet-950 dark:text-violet-300"
      style={{ width: size, height: size, boxShadow: `0 0 0 2px ${color}` }}
      aria-label={`${name} (agent)`}
      role="img"
    >
      <Bot size={Math.round(size * 0.55)} aria-hidden="true" />
    </span>
  );
}

/** How long an optimistically cancelled request stays hidden before it may come back (the server refused). */
const CANCEL_GRACE_MS = 8_000;

export interface PresenceStackProps {
  session: CollabSession;
  onJump?: (user: PresenceUser) => void;
  /** Cancel an open request from the popover's Requests section; without it the rows show but not Cancel (embed / read-only). */
  onCancelRequest?: (requestId: string) => void;
  /** Opens the "Keep an agent here" dialog; the popover offers it while no agent is present. */
  onKeepAgent?: () => void;
}

interface PresenceVisit {
  session: CollabSession;
  onJump: PresenceStackProps["onJump"];
  onCancelRequest: PresenceStackProps["onCancelRequest"];
  onKeepAgent: PresenceStackProps["onKeepAgent"];
}

interface PresenceVisitState {
  visit: PresenceVisit;
  open: boolean;
  cancelling: ReadonlySet<string>;
  now: number;
}

interface CancellationGraceOwner {
  visit: PresenceVisit;
  requestId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FreshnessOwner {
  visit: PresenceVisit;
  timer: ReturnType<typeof setInterval> | null;
}

interface PendingRequestsOwner {
  visit: PresenceVisit;
  ids: ReadonlySet<string>;
}

/**
 * Everyone in the document, agents included: agents are bot avatars with a spinner badge while they work,
 * and the popover carries their status, the open requests and the way to put an agent here (task #981).
 */
export function PresenceStack({ session, onJump, onCancelRequest, onKeepAgent }: PresenceStackProps) {
  const visit = useMemo<PresenceVisit>(
    () => ({ session, onJump, onCancelRequest, onKeepAgent }),
    [session, onJump, onCancelRequest, onKeepAgent],
  );
  const users = useSessionValue(session, (s) => s.presence(), jsonEqual);
  const followUserId = useSessionValue(session, (s) => s.followUserId);
  const requests = useAgentRequests(session);
  const activity = useAgentActivity(session);
  const initialState = useMemo<PresenceVisitState>(
    () => ({ visit, open: false, cancelling: new Set(), now: 0 }),
    [visit],
  );
  const [storedState, setStoredState] = useState<PresenceVisitState>(
    () => ({ ...initialState, now: Date.now() }),
  );
  const state = storedState.visit === visit ? storedState : initialState;
  const activeVisit = useRef<PresenceVisit | null>(null);
  const cancellationGrace = useRef(new Map<string, CancellationGraceOwner>());
  const freshnessOwner = useRef<FreshnessOwner | null>(null);
  const pendingRequestsOwner = useRef<PendingRequestsOwner | null>(null);
  const ownsVisit = useCallback((owner: PresenceVisit) => activeVisit.current === owner, []);
  const retireVisit = useCallback((owner: PresenceVisit) => {
    if (activeVisit.current !== owner) return;
    activeVisit.current = null;
    if (pendingRequestsOwner.current?.visit === owner) pendingRequestsOwner.current = null;
    for (const [requestId, grace] of cancellationGrace.current) {
      if (grace.visit !== owner) continue;
      if (grace.timer !== null) clearTimeout(grace.timer);
      if (cancellationGrace.current.get(requestId) === grace) cancellationGrace.current.delete(requestId);
    }
    const freshness = freshnessOwner.current;
    if (freshness?.visit === owner) {
      freshnessOwner.current = null;
      if (freshness.timer !== null) clearInterval(freshness.timer);
    }
  }, []);
  const updateState = useCallback(
    (update: (current: PresenceVisitState) => PresenceVisitState) => {
      if (!ownsVisit(visit)) return;
      setStoredState((current) => {
        if (!ownsVisit(visit) || current.visit !== visit) return current;
        return update(current);
      });
    },
    [ownsVisit, visit],
  );
  const finishCancellation = useCallback(
    (grace: CancellationGraceOwner) => {
      if (!ownsVisit(grace.visit) || cancellationGrace.current.get(grace.requestId) !== grace) return;
      cancellationGrace.current.delete(grace.requestId);
      if (grace.timer !== null) {
        clearTimeout(grace.timer);
        grace.timer = null;
      }
      setStoredState((current) => {
        if (!ownsVisit(grace.visit) || current.visit !== grace.visit || !current.cancelling.has(grace.requestId)) return current;
        const cancelling = new Set(current.cancelling);
        cancelling.delete(grace.requestId);
        return { ...current, cancelling };
      });
    },
    [ownsVisit],
  );
  useLayoutEffect(() => {
    activeVisit.current = visit;
    setStoredState((current) => (current.visit === visit ? current : { ...initialState, now: Date.now() }));
    return () => retireVisit(visit);
  }, [initialState, retireVisit, visit]);

  // Cancel is optimistic: the row and the placeholder go at once; the mirror catches up a moment later. If the
  // server refuses (editor-shell toasts the error) the request is still pending after the grace period and returns.
  const pending = pendingRequests(requests).filter((r) => !state.cancelling.has(r.id));
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: PendingRequestsOwner = {
      visit,
      ids: new Set(pendingRequests(requests).map((request) => request.id)),
    };
    pendingRequestsOwner.current = owner;
    for (const grace of cancellationGrace.current.values()) {
      if (grace.visit === visit && !owner.ids.has(grace.requestId)) finishCancellation(grace);
    }
    return () => {
      if (pendingRequestsOwner.current === owner) pendingRequestsOwner.current = null;
    };
  }, [finishCancellation, ownsVisit, requests, visit]);
  const cancelRequest = (id: string) => {
    const currentPending = pendingRequestsOwner.current;
    if (!ownsVisit(visit) || !visit.onCancelRequest || currentPending?.visit !== visit || !currentPending.ids.has(id)) return;
    const existing = cancellationGrace.current.get(id);
    if (existing?.visit === visit) return;
    const grace: CancellationGraceOwner = { visit, requestId: id, timer: null };
    cancellationGrace.current.set(id, grace);
    grace.timer = setTimeout(() => finishCancellation(grace), CANCEL_GRACE_MS);
    updateState((current) => {
      if (current.cancelling.has(id)) return current;
      const cancelling = new Set(current.cancelling);
      cancelling.add(id);
      return { ...current, cancelling };
    });
    visit.onCancelRequest(id);
  };
  // Idle dimming is time-based; re-evaluate it every 15 s while the stack is mounted. A fresh agent
  // activity ("proposed changes · 12 s ago") ticks every 5 s for the 45 s it shows.
  const now = state.now;
  const activityFresh = isRecentActivity(activity, now);
  useLayoutEffect(() => {
    if (!ownsVisit(visit)) return;
    const owner: FreshnessOwner = { visit, timer: null };
    freshnessOwner.current = owner;
    const currentNow = Date.now();
    const tick = () => {
      if (!ownsVisit(visit) || freshnessOwner.current !== owner) return;
      updateState((current) => {
        const nextNow = Date.now();
        return current.now === nextNow ? current : { ...current, now: nextNow };
      });
    };
    tick();
    owner.timer = setInterval(tick, isRecentActivity(activity, currentNow) ? 5_000 : 15_000);
    return () => {
      if (freshnessOwner.current !== owner) return;
      freshnessOwner.current = null;
      if (owner.timer !== null) clearInterval(owner.timer);
    };
  }, [activity, activityFresh, ownsVisit, updateState, visit]);
  const shown = users.slice(0, 3);
  const extra = users.length - shown.length;
  const others = users.filter((u) => !u.isLocal);
  const agents = users.filter((u) => u.isAgent);
  const busy = busyAgentNames(requests, activity, now);
  // Someone else's agent reads "Burke's Copilot CLI" everywhere (docs/agents.md, UI conventions); your own keeps its plain name.
  const viewer = session.user.login ?? null;
  const ownerNameOf = (login: string) => presenceNameOf(users, login);
  const agentName = (u: PresenceUser) => presenceAgentName(u, viewer);
  // No agent in presence but requests pending: the stack shows a dashed placeholder. It reads "waiting" until an
  // agent claims one (agents may claim over REST/MCP before they ever announce themselves), then "working".
  const noAgent = agents.length === 0 && pending.length > 0;
  const unseenWorker = noAgent ? pendingWorker(pending, viewer, ownerNameOf) : null;
  const waiting = noAgent && !unseenWorker;
  const nameOf = (userId: string) => users.find((u) => !u.isAgent && u.id === userId)?.name ?? null;
  const jump = (u: PresenceUser) => {
    if (!ownsVisit(visit) || u.cursor === null) return;
    visit.onJump?.(u);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const follow = (u: PresenceUser) => {
    if (!ownsVisit(visit)) return;
    visit.session.follow(followUserId === u.id ? null : u.id);
    updateState((current) => (current.open ? { ...current, open: false } : current));
  };
  const keepAgent = () => {
    if (!ownsVisit(visit)) return;
    updateState((current) => (current.open ? { ...current, open: false } : current));
    visit.onKeepAgent?.();
  };
  const changeOpen = (open: boolean) => {
    updateState((current) => (current.open === open ? current : { ...current, open }));
  };
  const roleLabel: Record<string, string> = { owner: "Owner", editor: "Editor", commenter: "Commenter", viewer: "Viewer" };
  const label = (u: PresenceUser) => (u.isLocal ? `${u.name} (you)` : u.isAgent ? `${agentName(u)} (agent${u.status ? `: ${u.status}` : ""})` : u.name);
  return (
    <Popover open={state.open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center -space-x-2 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="presence"
          aria-label={`${users.length} ${users.length === 1 ? "person" : "people"} here: ${users.map(label).join(", ")}${waiting ? `; ${waitingLabel(pending.length)}` : ""}`}
        >
          {shown.map((u) => (
            <Tip key={u.id} label={u.isAgent && busy.has(u.name) ? `${label(u)} — working` : label(u)}>
              <span
                className={cn("relative inline-flex transition-opacity", !u.isLocal && isIdle(u.idleSince, now) && "opacity-40")}
                data-testid="presence-avatar"
                data-user-id={u.id}
                data-idle={!u.isLocal && isIdle(u.idleSince, now) ? "" : undefined}
                data-agent={u.isAgent ? "" : undefined}
                data-busy={u.isAgent && busy.has(u.name) ? "" : undefined}
              >
                {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={36} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={36} />}
                {u.isAgent && busy.has(u.name) && <AgentBusyBadge name={agentName(u)} />}
              </span>
            </Tip>
          ))}
          {extra > 0 && (
            <Tip label={users.slice(3).map((u) => (u.isAgent ? agentName(u) : u.name)).join(", ")}>
              <span className="avatar text-[13px]">+{extra}</span>
            </Tip>
          )}
          {noAgent && (
            <Tip label={unseenWorker ? `${unseenWorker} (agent) — working` : waitingLabel(pending.length)}>
              <span className="relative inline-flex">
                <WaitingPlaceholder count={pending.length} workingBy={unseenWorker} size={36} />
              </span>
            </Tip>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2" data-testid="presence-popover">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
          {users.length === 1 ? "Only you are here" : `${users.length} people here`}
        </div>
        <ul className="flex flex-col gap-0.5">
          {users.map((u) => {
            const idle = !u.isLocal && isIdle(u.idleSince, now);
            const following = followUserId === u.id;
            const working = u.isAgent && busy.has(u.name);
            return (
              <li key={u.id} className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5", idle && !working && "opacity-60")} data-testid="presence-row" data-user-id={u.id} data-agent={u.isAgent ? "" : undefined}>
                <span className="relative inline-flex shrink-0">
                  {u.isAgent ? <AgentAvatar name={u.name} color={u.color} size={28} /> : <Avatar name={u.name} src={u.avatar} color={u.color} size={28} />}
                  {working && <AgentBusyBadge name={agentName(u)} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <span className="truncate">{u.isLocal ? `${u.name} (you)` : u.isAgent ? agentName(u) : u.name}</span>
                    {u.isAgent && <span className="rounded-md bg-violet-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-950 dark:text-violet-300">Agent</span>}
                    {u.role && <span className="rounded-md bg-surface-2 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-3">{roleLabel[u.role] ?? u.role}</span>}
                  </div>
                  <div className="truncate text-xs text-ink-3" data-testid="presence-section">
                    {u.isAgent ? (
                      <>
                        <span data-testid="presence-status">{idle && !working ? "Idle" : u.status ?? "working"}</span>
                        {activityFresh && activity.name === u.name && (
                          <>
                            {" · "}
                            <PresenceActivity activity={activity} now={now} />
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {idle ? "Idle · " : ""}
                        {u.cursor === null ? "no cursor" : u.section ? `in ‘${u.section}’` : "at the top"}
                      </>
                    )}
                  </div>
                </div>
                {!u.isLocal && !u.isAgent && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" className="btn btn-sm btn-outline h-7 px-2 text-xs" onClick={() => jump(u)} disabled={u.cursor === null} data-testid="presence-jump">
                      Jump
                    </button>
                    <button
                      type="button"
                      className={cn("btn btn-sm h-7 px-2 text-xs", following ? "btn-primary" : "btn-outline")}
                      onClick={() => follow(u)}
                      aria-pressed={following}
                      data-testid="presence-follow"
                    >
                      {following ? "Following" : "Follow"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {pending.length > 0 && <PresenceRequests session={session} pending={pending} nameOf={nameOf} ownerNameOf={ownerNameOf} onCancel={onCancelRequest ? cancelRequest : undefined} />}
        {waiting && (
          <p className="px-2 pb-1 pt-1.5 text-xs text-ink-3" data-testid="presence-waiting-note">
            {waitingLabel(pending.length)} — none is sitting in this document.
          </p>
        )}
        {agents.length === 0 && onKeepAgent && (
          <div className={cn("px-1 pb-1", waiting ? "pt-1" : "pt-1.5")}>
            <KeepAgentHereButton onClick={keepAgent} primary={waiting} />
          </div>
        )}
        {others.length === 0 && pending.length === 0 && <div className="px-2 pb-1 pt-1.5 text-xs text-ink-3">Share the document to work on it together.</div>}
      </PopoverContent>
    </Popover>
  );
}

interface ModeSwitcherVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
}

interface ModeSwitcherState {
  readonly visit: ModeSwitcherVisit;
  readonly open: boolean;
}

interface ModeSwitcherRowFacts {
  readonly index: number;
  readonly value: EditMode;
  readonly label: string;
  readonly description: string;
  readonly eligible: boolean;
}

interface ModeSwitcherRender {
  readonly identity: object;
  readonly visit: ModeSwitcherVisit;
  readonly session: CollabSession;
  readonly docId: string;
  readonly role: CollabSession["role"];
  readonly editable: boolean;
  readonly mode: EditMode;
  readonly open: boolean;
  readonly setMode: CollabSession["setMode"];
  readonly triggerClassName: string;
  readonly reader: Readonly<{
    url: string;
    target: "_blank";
    features: "noopener";
  }>;
  readonly rows: readonly ModeSwitcherRowFacts[];
}

interface ModeSwitcherDom {
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLDivElement | null;
  readonly group: HTMLDivElement | null;
  readonly rows: readonly HTMLDivElement[];
  readonly separator: HTMLDivElement | null;
  readonly reader: HTMLDivElement | null;
}

interface ModeSwitcherDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly ModeSwitcherDomSnapshot[];
}

interface ModeSwitcherPlacementSnapshot {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface ModeSwitcherPublication {
  readonly render: ModeSwitcherRender;
  readonly document: Document;
  readonly dom: ModeSwitcherDom;
  readonly triggerParent: Node;
  readonly contentParent: Node | null;
  readonly triggerSnapshot: ModeSwitcherDomSnapshot;
  readonly contentSnapshot: ModeSwitcherDomSnapshot | null;
  readonly isExact: () => boolean;
  readonly recordElementChange: (
    owner: ModeSwitcherElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly retire: () => boolean;
  readonly dispose: () => void;
}

interface ModeSwitcherPublicationRuntime {
  readonly publication: ModeSwitcherPublication;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly isRetired: () => boolean;
  readonly recordElementChange: (
    owner: ModeSwitcherElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
}

interface ModeSwitcherDisclosureIntent {
  readonly publication: ModeSwitcherPublication;
  readonly open: boolean;
  readonly returnFocus: boolean;
  readonly events: readonly Event[];
}

interface ModeSwitcherSelectionIntent {
  readonly publication: ModeSwitcherPublication;
  readonly row: ModeSwitcherRowFacts;
  readonly event: Event;
}

interface ModeSwitcherFocusIntent {
  readonly source: ModeSwitcherPublication;
  readonly visit: ModeSwitcherVisit;
  readonly target: HTMLButtonElement;
  readonly modes: readonly EditMode[];
  readonly guard: ModeSwitcherFocusGuard;
}

interface ModeSwitcherFocusGuard {
  readonly isExact: (publication: ModeSwitcherPublication) => boolean;
  readonly dispose: () => void;
}

interface ModeSwitcherFocusPlacement {
  readonly snapshots: readonly ModeSwitcherPlacementSnapshot[];
  readonly expectedRemovals: ReadonlyMap<Node, ModeSwitcherPlacementSnapshot>;
}

interface ModeSwitcherRowPublication extends ModeSwitcherRowFacts {
  readonly capture: React.RefCallback<HTMLDivElement>;
  readonly onSelect: (event: Event) => void;
}

interface ModeSwitcherPresentation {
  readonly rows: readonly ModeSwitcherRowPublication[];
  readonly captureTrigger: (element: HTMLButtonElement | null) => void;
  readonly captureContent: (element: HTMLDivElement | null) => void;
  readonly captureGroup: (element: HTMLDivElement | null) => void;
  readonly captureReader: (element: HTMLDivElement | null) => void;
  readonly establish: () => (() => void) | undefined;
  readonly onTriggerPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onModeChange: (value: string) => void;
  readonly onReaderSelect: (event: Event) => void;
  readonly onEscapeKeyDown: (event: KeyboardEvent) => void;
  readonly onOutside: (event: CustomEvent<{ originalEvent: Event }>) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}

class ModeSwitcherPublicationCoordinator {
  #active: ModeSwitcherPublication | null = null;
  #successorOf: ModeSwitcherPublication | null = null;
  #claimedEvents = new WeakSet<Event>();
  #disclosureIntent: ModeSwitcherDisclosureIntent | null = null;
  #selectionIntent: ModeSwitcherSelectionIntent | null = null;
  #focusIntent: ModeSwitcherFocusIntent | null = null;
  #requestedSuccessors = new WeakSet<ModeSwitcherPublication>();
  #unpublishedChangeRequested = false;

  constructor(private readonly requestSuccessor: () => void) {}

  active() {
    return this.#active;
  }

  allowsElementReplacement() {
    return this.#active === null;
  }

  publish(publication: ModeSwitcherPublication) {
    const previous = this.#active ?? this.#successorOf;
    this.#active = publication;
    this.#successorOf = null;
    this.#unpublishedChangeRequested = false;
    const focus = this.#focusIntent;
    const returnFocus = Boolean(
      focus && modeSwitcherFocusSuccessorIsExact(focus, publication),
    );
    const focusTarget = returnFocus ? focus?.target : null;
    if (focus) this.#clearFocus(focus);
    if (previous && previous !== publication) previous.dispose();
    focusTarget?.focus();
  }

  retire(publication: ModeSwitcherPublication) {
    if (this.#active !== publication) return false;
    this.#active = null;
    this.#successorOf = publication;
    if (this.#disclosureIntent?.publication === publication) {
      this.#disclosureIntent = null;
    }
    if (this.#selectionIntent?.publication === publication) {
      this.#selectionIntent = null;
    }
    queueMicrotask(() => {
      if (this.#active !== null || this.#successorOf !== publication) return;
      this.#successorOf = null;
      publication.dispose();
    });
    return true;
  }

  acceptsSuccessorOf(publication: ModeSwitcherPublication) {
    return this.#active === null && this.#successorOf === publication;
  }

  elementChanged(
    owner: ModeSwitcherElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) {
    const focus = this.#focusIntent;
    if (focus && previous === focus.target && element !== focus.target) {
      this.#clearFocus(focus);
    }
    const publication = this.#active;
    if (!publication) {
      if (!this.#unpublishedChangeRequested) {
        this.#unpublishedChangeRequested = true;
        this.requestSuccessor();
      }
      return;
    }
    const exactBeforeChange = publication.isExact();
    publication.recordElementChange(owner, element, previous);
    if (
      !this.#requestedSuccessors.has(publication)
      && this.acceptsSuccessorOf(publication)
      && (exactBeforeChange || publication.isExactElementReplay())
    ) {
      this.#requestedSuccessors.add(publication);
      this.requestSuccessor();
    }
  }

  claim(events: readonly Event[]) {
    const unique = new Set(events);
    if (unique.size !== events.length || events.some((event) => this.#claimedEvents.has(event))) {
      return false;
    }
    for (const event of events) this.#claimedEvents.add(event);
    return true;
  }

  publishDisclosure(
    publication: ModeSwitcherPublication,
    open: boolean,
    events: readonly Event[],
    returnFocus = true,
  ) {
    const intent = Object.freeze({
      publication,
      open,
      returnFocus,
      events: Object.freeze([...events]),
    });
    this.#disclosureIntent = intent;
    queueMicrotask(() => {
      if (this.#disclosureIntent === intent) this.#disclosureIntent = null;
    });
  }

  consumeDisclosure(publication: ModeSwitcherPublication, open: boolean) {
    const intent = this.#disclosureIntent;
    if (
      intent?.publication !== publication
      || intent.open !== open
      || this.#active !== publication
      || !publication.isExact()
      || !intent.events.some((event) => isLiveNativeEvent(event, publication.document))
    ) {
      return null;
    }
    this.#disclosureIntent = null;
    return intent;
  }

  publishSelection(
    publication: ModeSwitcherPublication,
    row: ModeSwitcherRowFacts,
    event: Event,
  ) {
    const intent = Object.freeze({ publication, row, event });
    this.#selectionIntent = intent;
    queueMicrotask(() => {
      if (this.#selectionIntent === intent) this.#selectionIntent = null;
    });
  }

  consumeSelection(publication: ModeSwitcherPublication, value: string) {
    const intent = this.#selectionIntent;
    if (
      intent?.publication !== publication
      || intent.row.value !== value
      || !intent.row.eligible
      || this.#active !== publication
      || !publication.isExact()
      || !isLiveNativeEvent(intent.event, publication.document)
    ) {
      return null;
    }
    this.#selectionIntent = null;
    return intent.row;
  }

  scheduleFocus(
    source: ModeSwitcherPublication,
    target: HTMLButtonElement,
    mode: EditMode = source.render.mode,
  ) {
    const previous = this.#focusIntent;
    if (previous) this.#clearFocus(previous);
    let pendingIntent: ModeSwitcherFocusIntent | null = null;
    const guard = createModeSwitcherFocusGuard(
      source,
      target,
      mode,
      () => {
        if (pendingIntent) this.#clearFocus(pendingIntent);
      },
    );
    const modes = mode === source.render.mode
      ? Object.freeze([mode])
      : Object.freeze([source.render.mode, mode]);
    const intent: ModeSwitcherFocusIntent = Object.freeze({
      source,
      visit: source.render.visit,
      target,
      modes,
      guard,
    });
    pendingIntent = intent;
    this.#focusIntent = intent;
  }

  #clearFocus(intent: ModeSwitcherFocusIntent) {
    if (this.#focusIntent !== intent) return;
    this.#focusIntent = null;
    intent.guard.dispose();
  }
}

class ModeSwitcherElementOwner<T extends HTMLElement> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly accepts: (element: T) => boolean,
    private readonly allowsReplacement: () => boolean,
    private readonly onChange: (
      owner: ModeSwitcherElementOwner<T>,
      element: T | null,
      previous: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    if (element) {
      if (
        !this.accepts(element)
        || (this.#current !== null && this.#current !== element)
        || (
          this.#current === null
          && this.#last !== null
          && this.#last !== element
          && !this.allowsReplacement()
        )
      ) {
        return;
      }
    }
    const previous = this.#current;
    if (element === null) {
      this.onChange(this, element, previous);
      this.#current = null;
      return;
    }
    this.#current = element;
    this.#last = element;
    this.onChange(this, element, previous);
  };
}

interface ModeSwitcherElementOwnerHandle {
  readonly element: () => HTMLElement | null;
}

interface ModeSwitcherOwners {
  readonly trigger: ModeSwitcherElementOwner<HTMLButtonElement>;
  readonly content: ModeSwitcherElementOwner<HTMLDivElement>;
  readonly group: ModeSwitcherElementOwner<HTMLDivElement>;
  readonly rows: readonly ModeSwitcherElementOwner<HTMLDivElement>[];
  readonly reader: ModeSwitcherElementOwner<HTMLDivElement>;
}

function createModeSwitcherOwners(coordinator: ModeSwitcherPublicationCoordinator): ModeSwitcherOwners {
  const changed = <T extends HTMLElement>(
    owner: ModeSwitcherElementOwner<T>,
    element: T | null,
    previous: T | null,
  ) => coordinator.elementChanged(owner, element, previous);
  const accepts = <T extends HTMLElement>(tagName: string) => (element: T) =>
    element.tagName === tagName;
  const allowsReplacement = () => coordinator.allowsElementReplacement();
  return Object.freeze({
    trigger: new ModeSwitcherElementOwner<HTMLButtonElement>(accepts("BUTTON"), allowsReplacement, changed),
    content: new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
    group: new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
    rows: Object.freeze([
      new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
      new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
      new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
    ]),
    reader: new ModeSwitcherElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed),
  });
}

const MODE_SWITCHER_DYNAMIC_ATTRIBUTES = new Set([
  "data-align",
  "data-highlighted",
  "data-radix-popper-align",
  "data-radix-popper-side",
  "data-side",
  "style",
  "tabindex",
]);

function createModeSwitcherFocusGuard(
  source: ModeSwitcherPublication,
  target: HTMLButtonElement,
  mode: EditMode,
  onInvalidated: () => void,
): ModeSwitcherFocusGuard {
  const focusPlacement = snapshotModeSwitcherFocusPlacement(source, target);
  const placementSnapshots = focusPlacement.snapshots;
  const placements = new Map(
    placementSnapshots.map((snapshot) => [snapshot.node, snapshot]),
  );
  const MutationObserverConstructor = target.ownerDocument.defaultView?.MutationObserver;
  const initialDynamicAttributes = new Map(
    [...MODE_SWITCHER_DYNAMIC_ATTRIBUTES].map((name) => [name, target.getAttribute(name)]),
  );
  const originalIcon = target.firstElementChild;
  const originalLabel = target.children.item(1);
  const records: MutationRecord[] = [];
  let observer: MutationObserver | null = null;
  let invalid = false;
  const inspect = (pending: readonly MutationRecord[]) => {
    if (invalid) return;
    records.push(...pending);
  };
  if (MutationObserverConstructor) {
    observer = new MutationObserverConstructor(inspect);
    observer.observe(target, {
      attributeOldValue: true,
      attributes: true,
      characterDataOldValue: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    for (let ancestor = target.parentNode; ancestor; ancestor = ancestor.parentNode) {
      observer.observe(ancestor, { childList: true });
    }
  }
  return Object.freeze({
    isExact: (publication: ModeSwitcherPublication) => {
      if (observer) inspect(observer.takeRecords());
      if (!records.every((record) =>
        modeSwitcherFocusMutationIsExpected(
          record,
          source,
          publication,
          target,
          originalIcon,
          originalLabel,
          placements,
          focusPlacement.expectedRemovals,
          mode,
        )
      )) {
        invalid = true;
        onInvalidated();
      }
      return Boolean(
        !invalid
        && target.isConnected
        && placementSnapshots.every(modeSwitcherPlacementMatches)
        && modeSwitcherFocusTriggerIsExact(publication, initialDynamicAttributes)
      );
    },
    dispose: () => {
      observer?.disconnect();
      observer = null;
    },
  });
}

function modeSwitcherFocusMutationIsExpected(
  record: MutationRecord,
  source: ModeSwitcherPublication,
  successor: ModeSwitcherPublication,
  trigger: HTMLButtonElement,
  originalIcon: Element | null,
  originalLabel: Element | null,
  placements: ReadonlyMap<Node, ModeSwitcherPlacementSnapshot>,
  expectedRemovals: ReadonlyMap<Node, ModeSwitcherPlacementSnapshot>,
  mode: EditMode,
) {
  if (record.target !== trigger && !trigger.contains(record.target)) {
    if (modeSwitcherFocusRemovalIsExpected(record, expectedRemovals)) return true;
    return record.type === "childList"
      && (record.previousSibling === null || !placements.has(record.previousSibling))
      && (record.nextSibling === null || !placements.has(record.nextSibling))
      && [...record.addedNodes, ...record.removedNodes].every(
        (node) => !placements.has(node) && !node.contains(trigger),
      );
  }
  if (record.type === "attributes" && record.target === trigger) {
    if (record.attributeName === "aria-expanded") {
      return record.oldValue === "true" && trigger.getAttribute("aria-expanded") === "false";
    }
    if (record.attributeName === "aria-controls") {
      return Boolean(
        source.dom.content?.id
        && record.oldValue === source.dom.content.id
        && trigger.getAttribute("aria-controls") === null
      );
    }
    if (record.attributeName === "data-state") {
      return record.oldValue === "open" && trigger.getAttribute("data-state") === "closed";
    }
    if (record.attributeName === "class" && mode !== source.render.mode) {
      return (
        record.oldValue === source.render.triggerClassName
        && trigger.className === successor.render.triggerClassName
      );
    }
    return false;
  }
  if (mode === source.render.mode) return false;
  const currentIcon = trigger.firstElementChild;
  if (record.type === "childList" && record.target === trigger) {
    return Boolean(
      originalIcon
      && currentIcon
      && record.previousSibling === null
      && record.nextSibling === originalLabel
      && (
        (
          record.removedNodes.length === 1
          && record.removedNodes.item(0) === originalIcon
          && record.addedNodes.length === 0
        )
        || (
          record.removedNodes.length === 0
          && record.addedNodes.length === 1
          && record.addedNodes.item(0) === currentIcon
        )
      )
    );
  }
  const currentLabel = trigger.children.item(1);
  return Boolean(
    record.type === "characterData"
    && originalLabel
    && currentLabel === originalLabel
    && originalLabel.contains(record.target)
    && record.oldValue === source.render.rows.find(
      (row) => row.value === source.render.mode,
    )?.label
    && record.target.nodeValue === successor.render.rows.find(
      (row) => row.value === mode,
    )?.label
  );
}

function snapshotModeSwitcherFocusPlacement(
  source: ModeSwitcherPublication,
  target: HTMLButtonElement,
): ModeSwitcherFocusPlacement {
  const expectedRemovals = new Map<Node, ModeSwitcherPlacementSnapshot>();
  const snapshots = snapshotModeSwitcherPlacement([target]).map((snapshot) => {
    let { previousSibling, nextSibling } = snapshot;
    const content = source.dom.content;
    if (content && previousSibling?.contains(content)) {
      expectedRemovals.set(previousSibling, Object.freeze({
        node: previousSibling,
        parent: previousSibling.parentNode,
        previousSibling: previousSibling.previousSibling,
        nextSibling: previousSibling.nextSibling,
      }));
      previousSibling = previousSibling.previousSibling;
    }
    if (content && nextSibling?.contains(content)) {
      expectedRemovals.set(nextSibling, Object.freeze({
        node: nextSibling,
        parent: nextSibling.parentNode,
        previousSibling: nextSibling.previousSibling,
        nextSibling: nextSibling.nextSibling,
      }));
      nextSibling = nextSibling.nextSibling;
    }
    return Object.freeze({
      node: snapshot.node,
      parent: snapshot.parent,
      previousSibling,
      nextSibling,
    });
  });
  return Object.freeze({
    snapshots: Object.freeze(snapshots),
    expectedRemovals,
  });
}

function modeSwitcherFocusRemovalIsExpected(
  record: MutationRecord,
  expectedRemovals: ReadonlyMap<Node, ModeSwitcherPlacementSnapshot>,
) {
  if (
    record.type !== "childList"
    || record.addedNodes.length !== 0
    || record.removedNodes.length !== 1
  ) {
    return false;
  }
  const removed = record.removedNodes.item(0);
  const snapshot = removed && expectedRemovals.get(removed);
  return Boolean(
    snapshot
    && record.target === snapshot.parent
    && record.previousSibling === snapshot.previousSibling
    && record.nextSibling === snapshot.nextSibling
  );
}

const MODE_SWITCHER_ICON_NODES: Readonly<Record<
  EditMode,
  readonly Readonly<{ tag: string; attributes: Readonly<Record<string, string>> }>[]
>> = Object.freeze({
  editing: Object.freeze([
    Object.freeze({ tag: "path", attributes: Object.freeze({ d: "M13 21h8" }) }),
    Object.freeze({
      tag: "path",
      attributes: Object.freeze({
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      }),
    }),
  ]),
  suggesting: Object.freeze([
    Object.freeze({
      tag: "path",
      attributes: Object.freeze({
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      }),
    }),
    Object.freeze({ tag: "path", attributes: Object.freeze({ d: "M12 8v6" }) }),
    Object.freeze({ tag: "path", attributes: Object.freeze({ d: "M9 11h6" }) }),
  ]),
  viewing: Object.freeze([
    Object.freeze({
      tag: "path",
      attributes: Object.freeze({
        d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0",
      }),
    }),
    Object.freeze({
      tag: "circle",
      attributes: Object.freeze({ cx: "12", cy: "12", r: "3" }),
    }),
  ]),
});

function modeSwitcherElementAttributesAreExact(
  element: Element,
  expected: Readonly<Record<string, string>>,
) {
  const entries = Object.entries(expected);
  return (
    element.attributes.length === entries.length
    && entries.every(([name, value]) => element.getAttribute(name) === value)
  );
}

function modeSwitcherIconIsExact(
  element: Element | null,
  mode: EditMode,
  size: number,
  className: string,
) {
  if (
    !element
    || element.tagName.toLowerCase() !== "svg"
    || !modeSwitcherElementAttributesAreExact(element, {
      "aria-hidden": "true",
      class: className,
      fill: "none",
      height: String(size),
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "2",
      viewBox: "0 0 24 24",
      width: String(size),
      xmlns: "http://www.w3.org/2000/svg",
    })
  ) {
    return false;
  }
  const expectedNodes = MODE_SWITCHER_ICON_NODES[mode];
  return (
    element.children.length === expectedNodes.length
    && expectedNodes.every((expected, index) => {
      const child = element.children.item(index);
      return Boolean(
        child
        && child.tagName.toLowerCase() === expected.tag
        && child.children.length === 0
        && child.textContent === ""
        && modeSwitcherElementAttributesAreExact(child, expected.attributes)
      );
    })
  );
}

function modeSwitcherChevronIsExact(element: Element | null) {
  const path = element?.children.item(0);
  return Boolean(
    element
    && element.tagName.toLowerCase() === "svg"
    && modeSwitcherElementAttributesAreExact(element, {
      "aria-hidden": "true",
      class: "lucide lucide-chevron-down text-ink-4",
      fill: "none",
      height: "14",
      stroke: "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "2",
      viewBox: "0 0 24 24",
      width: "14",
      xmlns: "http://www.w3.org/2000/svg",
    })
    && element.children.length === 1
    && path?.tagName.toLowerCase() === "path"
    && path.children.length === 0
    && path.textContent === ""
    && modeSwitcherElementAttributesAreExact(path, { d: "m6 9 6 6 6-6" })
  );
}

function modeSwitcherFocusTriggerIsExact(
  publication: ModeSwitcherPublication,
  initialDynamicAttributes: ReadonlyMap<string, string | null>,
) {
  const { trigger } = publication.dom;
  const label = publication.render.rows.find((row) => row.value === publication.render.mode)?.label;
  const allowedAttributes = new Set([
    "aria-expanded",
    "aria-haspopup",
    "class",
    "data-state",
    "data-testid",
    "id",
    "type",
  ]);
  const initialDynamicCount = [...initialDynamicAttributes.values()].filter(
    (value) => value !== null,
  ).length;
  const icon = trigger.children.item(0);
  const labelElement = trigger.children.item(1);
  const chevron = trigger.children.item(2);
  return Boolean(
    label
    && trigger.attributes.length === allowedAttributes.size + initialDynamicCount
    && Array.from(trigger.attributes).every((attribute) => (
      allowedAttributes.has(attribute.name)
      || initialDynamicAttributes.get(attribute.name) === attribute.value
    ))
    && [...initialDynamicAttributes].every(
      ([name, value]) => trigger.getAttribute(name) === value,
    )
    && Boolean(trigger.id)
    && trigger.getAttribute("aria-haspopup") === "menu"
    && trigger.getAttribute("aria-expanded") === "false"
    && trigger.getAttribute("data-state") === "closed"
    && trigger.getAttribute("aria-controls") === null
    && trigger.className === publication.render.triggerClassName
    && trigger.children.length === 3
    && modeSwitcherIconIsExact(
      icon,
      publication.render.mode,
      15,
      `lucide lucide-${publication.render.mode === "editing" ? "pen-line" : publication.render.mode === "suggesting" ? "message-square-plus" : "eye"}`,
    )
    && labelElement?.tagName === "SPAN"
    && labelElement.attributes.length === 0
    && labelElement.children.length === 0
    && labelElement.textContent === label
    && modeSwitcherChevronIsExact(chevron)
  );
}

function modeSwitcherFocusSuccessorIsExact(
  intent: ModeSwitcherFocusIntent,
  publication: ModeSwitcherPublication,
) {
  const before = intent.source.render;
  const after = publication.render;
  return (
    before.open
    && !after.open
    && after.visit === intent.visit
    && after.session === before.session
    && after.docId === before.docId
    && after.role === before.role
    && after.editable === before.editable
    && intent.modes.includes(after.mode)
    && after.setMode === before.setMode
    && after.reader.url === before.reader.url
    && after.reader.target === before.reader.target
    && after.reader.features === before.reader.features
    && after.rows.length === before.rows.length
    && after.rows.every((row, index) => {
      const previous = before.rows[index];
      return Boolean(
        previous
        && row.index === previous.index
        && row.value === previous.value
        && row.label === previous.label
        && row.description === previous.description
        && row.eligible === previous.eligible
      );
    })
    && publication.document === intent.source.document
    && publication.dom.trigger === intent.target
    && intent.target.ownerDocument === publication.document
    && intent.guard.isExact(publication)
    && publication.isExact()
  );
}

function snapshotModeSwitcherDom(node: Node): ModeSwitcherDomSnapshot {
  const ElementConstructor = node.ownerDocument?.defaultView?.Element;
  const attributes = ElementConstructor && node instanceof ElementConstructor
    ? Object.freeze(
        Array.from(node.attributes)
          .filter((attribute) => !MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(attribute.name))
          .map((attribute) => Object.freeze([attribute.name, attribute.value] as const)),
      )
    : null;
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes,
    children: Object.freeze(Array.from(node.childNodes, snapshotModeSwitcherDom)),
  });
}

function modeSwitcherDomSnapshotMatches(snapshot: ModeSwitcherDomSnapshot): boolean {
  const { node, attributes, children } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue || node.childNodes.length !== children.length) return false;
  if (attributes) {
    const ElementConstructor = node.ownerDocument?.defaultView?.Element;
    if (!ElementConstructor || !(node instanceof ElementConstructor)) return false;
    const current = Array.from(node.attributes).filter(
      (attribute) => !MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(attribute.name),
    );
    if (current.length !== attributes.length) return false;
    for (let index = 0; index < attributes.length; index++) {
      const expected = attributes[index]!;
      const actual = current[index];
      if (!actual || actual.name !== expected[0] || actual.value !== expected[1]) return false;
    }
  }
  for (let index = 0; index < children.length; index++) {
    if (
      node.childNodes.item(index) !== children[index]!.node
      || !modeSwitcherDomSnapshotMatches(children[index]!)
    ) {
      return false;
    }
  }
  return true;
}

function snapshotModeSwitcherPlacement(
  roots: readonly Node[],
): readonly ModeSwitcherPlacementSnapshot[] {
  const visited = new Set<Node>();
  const placements: ModeSwitcherPlacementSnapshot[] = [];
  for (const root of roots) {
    for (let node: Node | null = root; node && !visited.has(node); node = node.parentNode) {
      visited.add(node);
      placements.push(Object.freeze({
        node,
        parent: node.parentNode,
        previousSibling: node.previousSibling,
        nextSibling: node.nextSibling,
      }));
    }
  }
  return Object.freeze(placements);
}

function modeSwitcherPlacementMatches(snapshot: ModeSwitcherPlacementSnapshot) {
  return (
    snapshot.node.parentNode === snapshot.parent
    && snapshot.node.previousSibling === snapshot.previousSibling
    && snapshot.node.nextSibling === snapshot.nextSibling
  );
}

function modeSwitcherFactsAreCurrent(render: ModeSwitcherRender) {
  const { session } = render;
  const editable = session.role === "owner" || session.role === "editor";
  return (
    render.visit.session === session
    && session.docId === render.docId
    && session.role === render.role
    && editable === render.editable
    && session.mode === render.mode
    && session.setMode === render.setMode
    && render.reader.url === `/p/${render.docId}`
    && render.reader.target === "_blank"
    && render.reader.features === "noopener"
    && render.rows.length === 3
    && render.rows[0]?.index === 0
    && render.rows[0]?.value === "editing"
    && render.rows[0]?.label === "Editing"
    && render.rows[0]?.description === "Edit the document directly"
    && render.rows[0]?.eligible === render.editable
    && render.rows[1]?.index === 1
    && render.rows[1]?.value === "suggesting"
    && render.rows[1]?.label === "Suggesting"
    && render.rows[1]?.description === "Edits become suggestions others can accept"
    && render.rows[1]?.eligible === render.editable
    && render.rows[2]?.index === 2
    && render.rows[2]?.value === "viewing"
    && render.rows[2]?.label === "Viewing"
    && render.rows[2]?.description === "Read or print the final document"
    && render.rows[2]?.eligible
  );
}

function currentModeSwitcherDom(
  render: ModeSwitcherRender,
  owners: ModeSwitcherOwners,
): ModeSwitcherDom | null {
  const trigger = owners.trigger.element();
  const ownerDocument = trigger?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (
    !trigger
    || !ownerDocument
    || !ownerWindow
    || !(trigger instanceof ownerWindow.HTMLButtonElement)
    || !trigger.isConnected
    || trigger.type !== "button"
    || trigger.disabled
    || trigger.dataset.testid !== "mode-switcher"
    || trigger.className !== render.triggerClassName
    || trigger.textContent !== render.rows.find((row) => row.value === render.mode)?.label
    || trigger.getAttribute("aria-haspopup") !== "menu"
    || trigger.getAttribute("aria-expanded") !== String(render.open)
    || trigger.getAttribute("data-state") !== (render.open ? "open" : "closed")
  ) {
    return null;
  }

  const content = owners.content.element();
  const group = owners.group.element();
  const rows = owners.rows.map((owner) => owner.element());
  const reader = owners.reader.element();
  if (!render.open) {
    if (content || group || reader || rows.some(Boolean)) return null;
    return Object.freeze({
      trigger,
      content: null,
      group: null,
      rows: Object.freeze([]),
      separator: null,
      reader: null,
    });
  }

  const DivElement = ownerWindow.HTMLDivElement;
  if (
    !content
    || !group
    || !reader
    || rows.some((row) => !row)
    || !(content instanceof DivElement)
    || !(group instanceof DivElement)
    || !(reader instanceof DivElement)
    || !content.isConnected
    || content.ownerDocument !== ownerDocument
    || group.ownerDocument !== ownerDocument
    || reader.ownerDocument !== ownerDocument
    || content.getAttribute("role") !== "menu"
    || content.getAttribute("data-state") !== "open"
    || !["start", "center", "end"].includes(content.getAttribute("data-align") ?? "")
    || group.parentElement !== content
    || group.getAttribute("role") !== "group"
    || reader.parentElement !== content
    || reader.getAttribute("role") !== "menuitem"
    || reader.dataset.testid !== "mode-reader"
    || reader.textContent !== "Open reader view"
    || content.children.length !== 3
    || content.firstElementChild !== group
    || content.lastElementChild !== reader
    || group.children.length !== render.rows.length
  ) {
    return null;
  }
  const separator = content.children.item(1);
  if (
    !(separator instanceof DivElement)
    || separator.ownerDocument !== ownerDocument
    || separator.getAttribute("role") !== "separator"
    || group.nextElementSibling !== separator
    || separator.nextElementSibling !== reader
  ) {
    return null;
  }
  const exactRows: HTMLDivElement[] = [];
  for (const facts of render.rows) {
    const row = rows[facts.index];
    if (
      !row
      || !(row instanceof DivElement)
      || !row.isConnected
      || row.ownerDocument !== ownerDocument
      || row.parentElement !== group
      || group.children.item(facts.index) !== row
      || row.getAttribute("role") !== "menuitemradio"
      || row.getAttribute("aria-checked") !== String(facts.value === render.mode)
      || (row.getAttribute("aria-disabled") === "true") !== !facts.eligible
      || row.textContent !== `${facts.value === render.mode ? "✓" : ""}${facts.label}${facts.description}`
    ) {
      return null;
    }
    exactRows.push(row);
  }
  return Object.freeze({
    trigger,
    content,
    group,
    rows: Object.freeze(exactRows),
    separator,
    reader,
  });
}

function modeSwitcherDomIsSame(current: ModeSwitcherDom, published: ModeSwitcherDom) {
  return (
    current.trigger === published.trigger
    && current.content === published.content
    && current.group === published.group
    && current.separator === published.separator
    && current.reader === published.reader
    && current.rows.length === published.rows.length
    && current.rows.every((row, index) => row === published.rows[index])
  );
}

function isLiveNativeEvent(event: Event, document: Document) {
  const EventConstructor = document.defaultView?.Event;
  return Boolean(
    EventConstructor
    && event instanceof EventConstructor
    && event.eventPhase !== EventConstructor.NONE
    && event.target
  );
}

function createModeSwitcherPresentation({
  render,
  coordinator,
  owners,
  commitOpen,
}: {
  render: ModeSwitcherRender;
  coordinator: ModeSwitcherPublicationCoordinator;
  owners: ModeSwitcherOwners;
  commitOpen: (state: ModeSwitcherState) => void;
}): ModeSwitcherPresentation {
  const runtimeState: {
    layoutPassed: boolean;
    current: ModeSwitcherPublicationRuntime | null;
    last: ModeSwitcherPublicationRuntime | null;
  } = {
    layoutPassed: false,
    current: null,
    last: null,
  };

  const createRuntime = (dom: ModeSwitcherDom): ModeSwitcherPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const triggerParent = dom.trigger.parentNode;
    const contentParent = dom.content?.parentNode ?? null;
    if (!triggerParent || (dom.content && !contentParent)) {
      throw new Error("Mode switcher controls must have connected parents");
    }
    const triggerSnapshot = snapshotModeSwitcherDom(dom.trigger);
    const contentSnapshot = dom.content ? snapshotModeSwitcherDom(dom.content) : null;
    const placements = snapshotModeSwitcherPlacement(
      dom.content ? [dom.trigger, dom.content] : [dom.trigger],
    );
    const placementNodes = new Set(placements.map(({ node }) => node));
    const expectedOwners = new Map<ModeSwitcherElementOwnerHandle, HTMLElement>([
      [owners.trigger, dom.trigger],
    ]);
    if (render.open && dom.content && dom.group && dom.reader) {
      expectedOwners.set(owners.content, dom.content);
      expectedOwners.set(owners.group, dom.group);
      for (const [index, row] of dom.rows.entries()) expectedOwners.set(owners.rows[index]!, row);
      expectedOwners.set(owners.reader, dom.reader);
    }
    const detached = new Set<ModeSwitcherElementOwnerHandle>();
    const reattached = new Set<ModeSwitcherElementOwnerHandle>();
    let replayInvalid = false;
    let retired = false;
    let retirement: Retirement | null = null;
    let mutationSeen = false;
    const MutationObserverConstructor = dom.trigger.ownerDocument.defaultView?.MutationObserver;
    let observer: MutationObserver | null = null;

    const relevantMutation = (record: MutationRecord) => {
      if (
        record.type === "attributes"
        && record.attributeName
        && MODE_SWITCHER_DYNAMIC_ATTRIBUTES.has(record.attributeName)
      ) {
        return false;
      }
      const roots = dom.content ? [dom.trigger, dom.content] : [dom.trigger];
      if (roots.some((root) => record.target === root || root.contains(record.target))) return true;
      if (record.type !== "childList") return false;
      return (
        (record.previousSibling !== null && placementNodes.has(record.previousSibling))
        || (record.nextSibling !== null && placementNodes.has(record.nextSibling))
        || [...record.addedNodes, ...record.removedNodes].some((node) =>
          roots.some((root) => node === root || node.contains?.(root)))
      );
    };
    function inspectMutations(records: readonly MutationRecord[]) {
      if (records.some(relevantMutation)) {
        mutationSeen = true;
        retire("mutation");
      }
    }
    const mutationHistoryIsClean = () => {
      if (observer) inspectMutations(observer.takeRecords());
      return !mutationSeen;
    };
    const recordElementChange = (
      owner: ModeSwitcherElementOwnerHandle,
      element: HTMLElement | null,
      previous: HTMLElement | null,
    ) => {
      const expected = expectedOwners.get(owner);
      if (!expected || replayInvalid) return;
      if (!retired) retire("element");
      if (retirement !== "element") return;
      if (element === null) {
        if (
          previous !== expected
          || detached.has(owner)
          || reattached.size > 0
        ) {
          replayInvalid = true;
          return;
        }
        detached.add(owner);
        return;
      }
      if (
        previous !== null
        || element !== expected
        || detached.size !== expectedOwners.size
        || !detached.has(owner)
        || reattached.has(owner)
      ) {
        replayInvalid = true;
        return;
      }
      reattached.add(owner);
    };
    const isExactElementReplay = () => (
      retired
      && retirement === "element"
      && !replayInvalid
      && detached.size === expectedOwners.size
      && reattached.size === expectedOwners.size
      && publication.isExact()
    );
    const publication: ModeSwitcherPublication = Object.freeze({
      render,
      document: dom.trigger.ownerDocument,
      dom,
      triggerParent,
      contentParent,
      triggerSnapshot,
      contentSnapshot,
      isExact: () => {
        if (!mutationHistoryIsClean() || !modeSwitcherFactsAreCurrent(render)) return false;
        const current = currentModeSwitcherDom(render, owners);
        return Boolean(
          current
          && modeSwitcherDomIsSame(current, dom)
          && dom.trigger.parentNode === triggerParent
          && (dom.content ? dom.content.parentNode === contentParent : contentParent === null)
          && placements.every(modeSwitcherPlacementMatches)
          && modeSwitcherDomSnapshotMatches(triggerSnapshot)
          && (!contentSnapshot || modeSwitcherDomSnapshotMatches(contentSnapshot))
        );
      },
      recordElementChange,
      isExactElementReplay,
      retire: () => retire("other"),
      dispose: () => {
        observer?.disconnect();
        observer = null;
      },
    });
    function retire(reason: Retirement) {
      if (retired) return false;
      retired = true;
      retirement = reason;
      coordinator.retire(publication);
      if (runtimeState.current?.publication === publication) runtimeState.current = null;
      return true;
    }
    const runtime: ModeSwitcherPublicationRuntime = Object.freeze({
      publication,
      retireForElement: () => {
        retire(mutationSeen ? "mutation" : "element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      isRetired: () => retired,
      recordElementChange,
      isExactElementReplay,
      isExactLayoutReplay: () => (
        retired
        && retirement === "layout"
        && publication.isExact()
      ),
    });
    if (MutationObserverConstructor) {
      observer = new MutationObserverConstructor(inspectMutations);
      observer.observe(dom.trigger, { attributes: true, characterData: true, childList: true, subtree: true });
      for (let ancestor: Node | null = dom.trigger.parentNode; ancestor; ancestor = ancestor.parentNode) {
        observer.observe(ancestor, { childList: true });
      }
      if (dom.content && contentParent) {
        observer.observe(dom.content, { attributes: true, characterData: true, childList: true, subtree: true });
        for (let ancestor: Node | null = dom.content.parentNode; ancestor; ancestor = ancestor.parentNode) {
          observer.observe(ancestor, { childList: true });
        }
      }
    }
    return runtime;
  };

  const currentPublication = () => {
    const runtime = runtimeState.current;
    const publication = runtime?.publication;
    return runtime
      && publication
      && !runtime.isRetired()
      && coordinator.active() === publication
      && publication.render === render
      && publication.isExact()
      ? publication
      : null;
  };
  const close = (
    publication: ModeSwitcherPublication,
    returnFocus = true,
    mode: EditMode = publication.render.mode,
  ) => {
    if (
      !render.open
      || coordinator.active() !== publication
      || !publication.isExact()
      || !publication.retire()
    ) {
      return false;
    }
    if (returnFocus) coordinator.scheduleFocus(publication, publication.dom.trigger, mode);
    commitOpen(Object.freeze({ visit: render.visit, open: false }));
    return true;
  };
  const onTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const publication = currentPublication();
    const trigger = publication?.dom.trigger;
    const ownerWindow = publication?.document.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication
      || !trigger
      || !ownerWindow
      || event.type !== "pointerdown"
      || event.currentTarget !== trigger
      || event.defaultPrevented
      || event.button !== 0
      || event.ctrlKey
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || !trigger.contains(target)
      || !(nativeEvent instanceof ownerWindow.PointerEvent)
      || nativeEvent.type !== "pointerdown"
      || nativeEvent.target !== target
      || nativeEvent.defaultPrevented
      || nativeEvent.button !== 0
      || nativeEvent.ctrlKey
      || !isLiveNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claim([nativeEvent])
    ) {
      return;
    }
    coordinator.publishDisclosure(publication, !render.open, [nativeEvent]);
  };
  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
    const publication = currentPublication();
    const trigger = publication?.dom.trigger;
    const ownerWindow = publication?.document.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    if (
      !publication
      || !trigger
      || !ownerWindow
      || event.type !== "keydown"
      || event.currentTarget !== trigger
      || event.defaultPrevented
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || !trigger.contains(target)
      || !(nativeEvent instanceof ownerWindow.KeyboardEvent)
      || nativeEvent.type !== "keydown"
      || nativeEvent.target !== target
      || nativeEvent.key !== event.key
      || nativeEvent.defaultPrevented
      || !isLiveNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claim([nativeEvent])
    ) {
      return;
    }
    coordinator.publishDisclosure(
      publication,
      event.key === "ArrowDown" ? true : !render.open,
      [nativeEvent],
    );
  };
  const onOpenChange = (open: boolean) => {
    const publication = currentPublication();
    const intent = publication && coordinator.consumeDisclosure(publication, open);
    if (!publication || !intent) return;
    if (render.open === open) return;
    if (open) {
      if (!publication.retire()) return;
      commitOpen(Object.freeze({ visit: render.visit, open: true }));
    } else {
      close(publication, intent.returnFocus);
    }
  };
  const rows: readonly ModeSwitcherRowPublication[] = render.rows.map((row) => {
    const rowPublication: ModeSwitcherRowPublication = Object.freeze({
      ...row,
      capture: owners.rows[row.index]!.capture,
      onSelect: (event: Event) => {
        if (!row.eligible) return;
        const publication = currentPublication();
        const element = publication?.dom.rows[row.index];
        const ownerWindow = publication?.document.defaultView;
        if (
          !publication
          || !element
          || !ownerWindow
          || rowPublication !== rows[row.index]
          || !(event instanceof ownerWindow.CustomEvent)
          || event.type !== "menu.itemSelect"
          || event.currentTarget !== element
          || event.target !== element
          || event.defaultPrevented
          || !isLiveNativeEvent(event, publication.document)
          || !event.composedPath().includes(element)
          || !coordinator.claim([event])
        ) {
          return;
        }
        coordinator.publishSelection(publication, row, event);
      },
    });
    return rowPublication;
  });
  const onModeChange = (value: string) => {
    const publication = currentPublication();
    if (!publication) return;
    const row = coordinator.consumeSelection(publication, value);
    if (!row || !close(publication, true, row.value)) return;
    render.setMode.call(render.session, row.value);
  };
  const onReaderSelect = (event: Event) => {
    const publication = currentPublication();
    const reader = publication?.dom.reader;
    const ownerWindow = publication?.document.defaultView;
    if (
      !publication
      || !reader
      || !ownerWindow
      || !(event instanceof ownerWindow.CustomEvent)
      || event.type !== "menu.itemSelect"
      || event.currentTarget !== reader
      || event.target !== reader
      || event.defaultPrevented
      || !isLiveNativeEvent(event, publication.document)
      || !event.composedPath().includes(reader)
      || !coordinator.claim([event])
      || !close(publication)
    ) {
      return;
    }
    const { url, target, features } = render.reader;
    window.open(url, target, features);
  };
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    const publication = currentPublication();
    const content = publication?.dom.content;
    const ownerWindow = publication?.document.defaultView;
    const target = event.target;
    if (
      !publication
      || !content
      || !ownerWindow
      || !(event instanceof ownerWindow.KeyboardEvent)
      || event.type !== "keydown"
      || event.key !== "Escape"
      || event.currentTarget !== publication.document
      || event.defaultPrevented
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || !content.contains(target)
      || !isLiveNativeEvent(event, publication.document)
      || !event.composedPath().includes(content)
      || !coordinator.claim([event])
    ) {
      return;
    }
    coordinator.publishDisclosure(publication, false, [event]);
  };
  const onOutside = (event: CustomEvent<{ originalEvent: Event }>) => {
    const publication = currentPublication();
    const content = publication?.dom.content;
    const trigger = publication?.dom.trigger;
    const ownerWindow = publication?.document.defaultView;
    const originalEvent = event.detail?.originalEvent;
    const target = originalEvent?.target;
    const pointerOutside = ownerWindow
      && originalEvent instanceof ownerWindow.PointerEvent
      && event.type === "dismissableLayer.pointerDownOutside"
      && originalEvent.type === "pointerdown";
    const focusOutside = ownerWindow
      && originalEvent instanceof ownerWindow.FocusEvent
      && event.type === "dismissableLayer.focusOutside"
      && originalEvent.type === "focusin";
    if (
      !publication
      || !content
      || !trigger
      || !ownerWindow
      || !(event instanceof ownerWindow.CustomEvent)
      || event.defaultPrevented
      || (!pointerOutside && !focusOutside)
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== publication.document
      || event.target !== target
      || event.currentTarget !== target
      || !target.isConnected
      || content.contains(target)
      || trigger.contains(target)
      || !isLiveNativeEvent(event, publication.document)
      || !isLiveNativeEvent(originalEvent, publication.document)
      || !event.composedPath().includes(target)
      || !originalEvent.composedPath().includes(target)
      || !coordinator.claim([event, originalEvent])
    ) {
      return;
    }
    const rightClick = originalEvent instanceof ownerWindow.PointerEvent
      && (
        originalEvent.button === 2
        || (originalEvent.button === 0 && originalEvent.ctrlKey)
      );
    coordinator.publishDisclosure(publication, false, [event, originalEvent], !rightClick);
  };

  function establish() {
    runtimeState.layoutPassed = true;
    if (
      (runtimeState.last && !runtimeState.last.isExactLayoutReplay())
      || !modeSwitcherFactsAreCurrent(render)
    ) {
      return undefined;
    }
    const dom = currentModeSwitcherDom(render, owners);
    if (!dom) return undefined;
    const runtime = createRuntime(dom);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    coordinator.publish(runtime.publication);
    return runtime.retireForLayout;
  }
  const result: ModeSwitcherPresentation = Object.freeze({
    rows: Object.freeze(rows),
    captureTrigger: owners.trigger.capture,
    captureContent: owners.content.capture,
    captureGroup: owners.group.capture,
    captureReader: owners.reader.capture,
    establish,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onModeChange,
    onReaderSelect,
    onEscapeKeyDown,
    onOutside,
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
    },
  });
  return result;
}

function ModeSwitcherOpenCommit({ presentation }: { presentation: ModeSwitcherPresentation }) {
  useLayoutEffect(() => presentation.establish(), [presentation]);
  return null;
}

export function ModeSwitcher({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  const [mount] = useState(() => Symbol("mode switcher"));
  const [, setPublicationRevision] = useState(0);
  const [coordinator] = useState(
    () => new ModeSwitcherPublicationCoordinator(
      () => setPublicationRevision((current) => current + 1),
    ),
  );
  const [owners] = useState(() => createModeSwitcherOwners(coordinator));
  const visit = useMemo<ModeSwitcherVisit>(
    () => Object.freeze({ mount, session }),
    [mount, session],
  );
  const initialState = useMemo<ModeSwitcherState>(
    () => Object.freeze({ visit, open: false }),
    [visit],
  );
  const [storedState, setStoredState] = useState<ModeSwitcherState>(initialState);
  const state = storedState.visit === visit ? storedState : initialState;
  const rows: readonly ModeSwitcherRowFacts[] = Object.freeze([
    Object.freeze({ index: 0, value: "editing", label: "Editing", description: "Edit the document directly", eligible: editable }),
    Object.freeze({ index: 1, value: "suggesting", label: "Suggesting", description: "Edits become suggestions others can accept", eligible: editable }),
    Object.freeze({ index: 2, value: "viewing", label: "Viewing", description: "Read or print the final document", eligible: true }),
  ]);
  const triggerClassName = cn(
    "btn btn-sm gap-1.5 border",
    mode === "suggesting" ? "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300" : "border-line-2 bg-surface text-ink-2 hover:bg-surface-2",
  );
  const render: ModeSwitcherRender = Object.freeze({
    identity: Object.freeze({}),
    visit,
    session,
    docId: session.docId,
    role: session.role,
    editable,
    mode,
    open: state.open,
    setMode: session.setMode,
    triggerClassName,
    reader: Object.freeze({
      url: `/p/${session.docId}`,
      target: "_blank",
      features: "noopener",
    }),
    rows,
  });
  const presentation = createModeSwitcherPresentation({
    render,
    coordinator,
    owners,
    commitOpen: setStoredState,
  });

  useLayoutEffect(() => presentation.establish(), [presentation]);
  const {
    captureTrigger,
    captureContent,
    captureGroup,
    captureReader,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onModeChange,
    onReaderSelect,
    onEscapeKeyDown,
    onOutside,
    onCloseAutoFocus,
    rows: publishedRows,
  } = presentation;

  const icons: Record<EditMode, React.ReactNode> = {
    editing: <PenLine size={15} />,
    suggesting: <MessageSquarePlus size={15} />,
    viewing: <Eye size={15} />,
  };
  const labels: Record<EditMode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  return (
    <Menu open={state.open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <button
          ref={captureTrigger}
          type="button"
          className={triggerClassName}
          onPointerDown={onTriggerPointerDown}
          onKeyDown={onTriggerKeyDown}
          data-testid="mode-switcher"
        >
          {icons[mode]}
          <span>{labels[mode]}</span>
          <ChevronDown size={14} className="text-ink-4" />
        </button>
      </MenuTrigger>
      {state.open && (
        <MenuContent
          ref={captureContent}
          align="end"
          className="w-64"
          onEscapeKeyDown={onEscapeKeyDown}
          onPointerDownOutside={onOutside}
          onFocusOutside={onOutside}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <MenuRadioGroup ref={captureGroup} value={mode} onValueChange={onModeChange}>
            {publishedRows.map((row) => (
              <MenuRadioItem
                key={row.value}
                ref={row.capture}
                value={row.value}
                disabled={!row.eligible}
                description={row.description}
                onSelect={row.onSelect}
              >
                {row.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={captureReader}
            icon={<BookOpen size={15} />}
            onSelect={onReaderSelect}
            data-testid="mode-reader"
          >
            Open reader view
          </MenuItem>
          <ModeSwitcherOpenCommit presentation={presentation} />
        </MenuContent>
      )}
    </Menu>
  );
}

export type ExportFormat = "md" | "html" | "pdf";

/** Editing / Suggesting / Viewing as menu rows — the phone header has no room for the ModeSwitcher pill. */
function ModeItems({ session }: { session: CollabSession }) {
  const mode = useSessionValue(session, (s) => s.mode);
  const editable = session.role === "owner" || session.role === "editor";
  return (
    <>
      <MenuLabel>Mode</MenuLabel>
      <MenuRadioGroup value={mode} onValueChange={(v) => session.setMode(v as EditMode)}>
        <MenuRadioItem value="editing" disabled={!editable}>
          Editing
        </MenuRadioItem>
        <MenuRadioItem value="suggesting" disabled={!editable}>
          Suggesting
        </MenuRadioItem>
        <MenuRadioItem value="viewing">Viewing</MenuRadioItem>
      </MenuRadioGroup>
    </>
  );
}

export interface HeaderProps {
  session: CollabSession;
  doc: DocumentDto;
  commentsOpen: boolean;
  onToggleComments: (focusPanel?: boolean) => void;
  /** Open the thread/suggestion/document a notification points at (the item is already marked read). */
  onOpenNotification: (n: NotificationDto) => void;
  onShare: () => void;
  onPublish: () => void;
  onPublishNow: () => void;
  onPull: () => void;
  /** Opens the Sync dialog (both sides changed). */
  onSync: () => void;
  /** Three-way status against the linked GitHub file; null while unknown or when not linked. */
  sync: SyncStatusDto | null;
  onHistory: () => void;
  /** The ⋯ menu opened; the shell warms what its items need (the version list, task #487). */
  onMoreMenuOpen?: () => void;
  onActivity: () => void;
  onShortcuts: () => void;
  onCommandPalette?: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onDownload: (format: ExportFormat, withSuggestions: boolean) => void;
  onCopyMarkdown: () => void;
  onNameVersion: () => void;
  documentMutation: "delete" | "duplicate" | null;
  publishing: boolean;
  isOwner: boolean;
  /** The server has a GitHub OAuth app; without it the GitHub entries are disabled and say why (#162). */
  githubConfigured: boolean;
  onHome: () => void;
  /** Pane layout shown by the segmented control on phones. */
  layout: Layout;
  onLayout: (layout: Layout) => void;
  /** Opens the outline drawer (phones only). */
  onOutline: () => void;
  /** Phone layout: icon-only save state, segmented pane control, secondary actions folded into the menu. */
  compact: boolean;
  /** "Jump" in the presence popover: scroll both panes to a collaborator's cursor. */
  onJumpToUser?: (user: PresenceUser) => void;
  /** Cancel an open request from the presence popover's Requests section; the Cancel buttons are hidden when omitted. */
  onCancelRequest?: (requestId: string) => void;
  /** Where "Keep an agent here" sends people without a token (defaults to /settings#tokens). */
  onCreateToken?: () => void;
  /** Bumped by the command palette's "Keep an agent here" (and the `/agent` slash item): opens the Keep-an-agent dialog. */
  keepAgentNonce?: number;
  /** Canvas mode: hide navigation, sharing, publishing, and account menus. */
  embed?: boolean;
}

/** Preview | Markdown switch shown in the header below `md`; the status-bar menu covers wider windows. */
function LayoutSegment({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const options: { value: Layout; label: string; icon: React.ReactNode }[] = [
    { value: "rich", label: "Preview", icon: <Eye size={17} /> },
    { value: "code", label: "Markdown", icon: <Code2 size={17} /> },
  ];
  return (
    <div className="inline-flex h-9 shrink-0 rounded-lg border border-line-2 bg-surface p-0.5 md:hidden" role="radiogroup" aria-label="Pane" data-testid="layout-segment">
      {options.map((o) => {
        const active = layout === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            className={cn("inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors", active ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink")}
            onClick={() => onLayout(o.value)}
            data-testid={`layout-segment-${o.value}`}
          >
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}

/** Menu entry text for a GitHub action; says why it is disabled when the server has no GitHub OAuth app (#162). */
function GitHubEntryLabel({ configured, children }: { configured: boolean; children: React.ReactNode }) {
  if (configured) return <>{children}</>;
  return (
    <span className="flex flex-col">
      <span>{children}</span>
      <span className="text-xs text-ink-3">{GITHUB_NOT_CONFIGURED}</span>
    </span>
  );
}

export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const opensSyncDialog = sync.status === "diverged" || sync.status === "remote-unreadable";
  const label =
    sync.status === "remote-ahead"
      ? "Pull"
      : sync.status === "diverged"
        ? "Both changed"
        : sync.status === "remote-unreadable"
          ? SYNC_LABELS[sync.status]
          : sync.status === "in-sync"
            ? "Up to date"
            : "Publish";

  return (
    <button
      type="button"
      className="btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3"
      disabled={publishing}
      data-testid="publish-button"
      onClick={sync.status === "remote-ahead" ? onPull : opensSyncDialog ? onSync : onPublishNow}
      title={SYNC_LABELS[sync.status]}
    >
      {publishing ? (
        <Loader2 size={16} className="animate-spin" />
      ) : sync.status === "remote-ahead" ? (
        <RefreshCw size={15} />
      ) : sync.status === "diverged" ? (
        <GitMerge size={15} />
      ) : sync.status === "remote-unreadable" ? (
        <AlertTriangle size={15} className="text-amber-200" />
      ) : (
        <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", sync.status === "in-sync" ? "bg-emerald-300" : "bg-amber-300")} />
      )}
      <span data-testid="publish-status" data-status={sync.status}>
        {label}
      </span>
    </button>
  );
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, keepAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";
  // Star state and the notifications poll wait for the first sync: the socket handshake and the
  // collab-token call get the server to themselves on open (#118).
  const settled = useOpenSettled(session);
  // "Keep an agent here": one dialog, opened from the presence popover, the command palette and the slash menu.
  const [keepAgentOpen, setKeepAgentOpen] = useState(false);
  useEffect(() => {
    if (keepAgentNonce > 0) setKeepAgentOpen(true);
  }, [keepAgentNonce]);
  const keepAgentEverOpened = useEverTrue(keepAgentOpen);
  const liveTitle = useSessionValue(session, (s) => s.title || doc.title);
  const openKeepAgent = useCallback(() => setKeepAgentOpen(true), []);
  // Phones can paint the header while the HTML is still being parsed (a 4× slower CPU: `readyState` was "loading" at the
  // first frame in 2 of 3 runs), and then the right group is laid out with only its first children — 70 px, or 110 px
  // with the bell — and grows to 190 px once the comments toggle and ⋮ have arrived, pushing the title and the save chip
  // left (#1562: {x 268, w 110} → {x 188, w 190}, 0.0033–0.0050). Every child is already in the server markup, so the
  // group reserves its final phone width from the first byte: the 70 px pane segment plus 36 px icon buttons with 4 px
  // gaps — comments always, the bell when signed in, ⋮ outside embeds (the desktop-only children are `hidden`/
  // `max-md:hidden` below `md` and add nothing). In rem like the utilities it mirrors; from `md` the class is inert.
  const phoneRightMinWidth = embed
    ? "max-md:min-w-[calc(6.75rem+2px)]" // segment + comments: 110 px
    : session.user.login
      ? "max-md:min-w-[calc(11.75rem+2px)]" // segment + bell + comments + ⋮: 190 px
      : "max-md:min-w-[calc(9.25rem+2px)]"; // segment + comments + ⋮: 150 px

  return (
    <header className={HEADER_BOX} data-testid="header" data-embed={embed || undefined}>
      {compact ? (
        <button type="button" className="icon-btn h-9 w-9 shrink-0" onClick={props.onOutline} aria-label="Outline" title="Outline" data-testid="outline-button">
          <PanelLeft size={20} />
        </button>
      ) : embed ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center md:h-10 md:w-10" aria-label="Markdoc" data-testid="embed-logo">
          <Logo className="h-8 w-8" />
        </span>
      ) : (
        // Below `md` the same 36 px box as the outline button that replaces it after hydration (#1470).
        <Link href="/" className="icon-btn h-9 w-9 shrink-0 md:h-10 md:w-10" aria-label="Back to documents" title="All documents">
          <Logo className="h-8 w-8" />
        </Link>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-4">
        <TitleEditor session={session} fallback={doc.title} compact={compact} />
        {!embed && !compact && <HeaderStar docId={doc.id} ready={settled} />}
        <SaveIndicator session={session} compact={compact} />
      </div>
      <div className={cn("flex shrink-0 items-center gap-1 md:gap-3", phoneRightMinWidth)} data-testid="header-right">
        <LayoutSegment layout={props.layout} onLayout={props.onLayout} />
        <div className="hidden items-center gap-3 md:flex">
          <ModeSwitcher session={session} />
          <PresenceStack session={session} onJump={props.onJumpToUser} onCancelRequest={props.onCancelRequest} onKeepAgent={openKeepAgent} />
        </div>
        {keepAgentEverOpened && <KeepAgentHereDialog doc={{ id: doc.id, title: liveTitle }} open={keepAgentOpen} onOpenChange={setKeepAgentOpen} onCreateToken={props.onCreateToken} />}
        {!embed && session.user.login && <NotificationsBell currentDocId={doc.id} onOpen={props.onOpenNotification} ready={settled} />}
        {!embed && !compact && (
          <button type="button" className="btn btn-outline max-md:hidden" onClick={props.onShare} data-testid="share-button">
            <UserPlus size={17} />
            Share
          </button>
        )}
        <Tip label={props.commentsOpen ? "Hide comments" : "Show comments"} shortcut={shortcut("Mod-Alt-M")}>
          <button
            type="button"
            className="icon-btn relative"
            onClick={(event) => props.onToggleComments(event.detail === 0)}
            data-active={props.commentsOpen}
            aria-label="Comments"
            data-testid="comments-toggle"
          >
            <MessageSquare size={20} />
            {openComments > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-on-accent" data-testid="comments-badge">
                {openComments}
              </span>
            )}
          </button>
        </Tip>
        {!embed && <Menu onOpenChange={(o) => o && props.onMoreMenuOpen?.()}>
          <MenuTrigger asChild>
            <button type="button" className="icon-btn" aria-label="More" data-testid="more-menu">
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-64">
            {compact && (
              <>
                <MenuItem icon={<UserPlus size={15} />} onSelect={props.onShare} data-testid="menu-share">
                  Share…
                </MenuItem>
                <MenuItem
                  icon={linked ? <UploadCloud size={15} /> : <GitHubIcon size={15} />}
                  onSelect={linked ? props.onPublishNow : props.onPublish}
                  disabled={props.publishing || (linked ? !canEdit : !props.isOwner || !githubConfigured)}
                  title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                  data-testid="menu-publish"
                >
                  {linked ? (doc.storage === "gist" ? "Update gist" : "Commit to GitHub…") : <GitHubEntryLabel configured={githubConfigured}>Publish to GitHub…</GitHubEntryLabel>}
                </MenuItem>
                <MenuSeparator />
                <ModeItems session={session} />
                <MenuSeparator />
              </>
            )}
            <MenuItem icon={<History size={15} />} onSelect={props.onHistory} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={props.onActivity} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem icon={<Pencil size={15} />} onSelect={props.onNameVersion}>
                Name current version
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)} data-testid="download-md">
              Download Markdown
            </MenuItem>
            <MenuItem icon={<FileCode2 size={15} />} onSelect={() => props.onDownload("html", false)} data-testid="download-html">
              Download HTML
            </MenuItem>
            <MenuItem icon={<FileText size={15} />} onSelect={() => props.onDownload("pdf", false)} data-testid="download-pdf">
              Download PDF
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} onSelect={props.onCopyMarkdown}>
              Copy Markdown
            </MenuItem>
            <MenuItem
              icon={props.documentMutation === "duplicate" ? <Loader2 size={15} className="animate-spin" /> : <Files size={15} />}
              onSelect={props.onDuplicate}
              disabled={props.documentMutation !== null}
              aria-busy={props.documentMutation === "duplicate" || undefined}
              data-testid="menu-duplicate"
            >
              {props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy"}
            </MenuItem>
            <MenuItem icon={<BookOpen size={15} />} onSelect={() => window.open(`/p/${doc.id}`, "_blank", "noopener")} data-testid="menu-reader">
              Open reader view
            </MenuItem>
            <MenuSeparator />
            {linked && doc.githubUrl && (
              <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                Open on GitHub
              </MenuItem>
            )}
            {props.isOwner && (
              <MenuItem
                icon={<GitHubIcon size={15} />}
                onSelect={props.onPublish}
                disabled={!linked && !githubConfigured}
                title={!linked && !githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                data-testid="menu-github"
              >
                {linked ? "GitHub connection…" : <GitHubEntryLabel configured={githubConfigured}>Connect to GitHub…</GitHubEntryLabel>}
              </MenuItem>
            )}
            {props.onCommandPalette && (
              <MenuItem icon={<Command size={15} />} onSelect={props.onCommandPalette} shortcut={shortcut("Mod-K")} data-testid="menu-command-palette">
                Search commands
              </MenuItem>
            )}
            <MenuItem icon={<Keyboard size={15} />} onSelect={props.onShortcuts}>
              Keyboard shortcuts
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowLeft size={15} />} onSelect={props.onHome}>
              All documents
            </MenuItem>
            <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
              Sign out
            </MenuItem>
            {props.isOwner && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={props.documentMutation === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  className="text-danger"
                  onSelect={props.onDelete}
                  disabled={props.documentMutation !== null}
                  aria-busy={props.documentMutation === "delete" || undefined}
                  data-testid="menu-delete"
                >
                  {props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash"}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>}
        {!embed && !compact && (
          <Menu>
            <div className="flex items-stretch max-md:hidden" data-sync-status={linked ? (props.sync?.status ?? "unknown") : undefined}>
              {linked && canEdit && props.sync ? (
                <PublishStatusButton sync={props.sync} publishing={props.publishing} onPublishNow={props.onPublishNow} onPull={props.onPull} onSync={props.onSync} />
              ) : (
                <MenuTrigger asChild>
                  <button type="button" className="btn btn-primary gap-1.5 rounded-r-none pl-4 pr-3" disabled={props.publishing} data-testid="publish-button">
                    {props.publishing ? <Loader2 size={16} className="animate-spin" /> : null}
                    Publish
                  </button>
                </MenuTrigger>
              )}
              <MenuTrigger asChild>
                <button type="button" className="btn btn-primary rounded-l-none border-l border-white/20 px-1.5" disabled={props.publishing} aria-label="Publish options" data-testid="publish-menu">
                  <ChevronDown size={16} className="opacity-80" />
                </button>
              </MenuTrigger>
            </div>
            <MenuContent align="end" className="w-72">
              {linked ? (
                <>
                  <MenuLabel>
                    {doc.storage === "gist" ? "Gist" : `${doc.repoOwner}/${doc.repoName} · ${doc.repoBranch}`}
                    {props.sync && <span className="ml-1 font-normal text-ink-3">· {SYNC_LABELS[props.sync.status]}</span>}
                  </MenuLabel>
                  <MenuItem icon={<UploadCloud size={15} />} onSelect={props.onPublishNow} disabled={!canEdit}>
                    {doc.storage === "gist" ? "Update gist" : "Commit to GitHub…"}
                  </MenuItem>
                  <MenuItem icon={<RefreshCw size={15} />} onSelect={props.onPull} disabled={!canEdit || props.sync?.status === "remote-unreadable"}>
                    Pull latest from GitHub
                  </MenuItem>
                  <MenuItem icon={<GitMerge size={15} />} onSelect={props.onSync} disabled={!canEdit} data-testid="menu-sync">
                    Sync…
                  </MenuItem>
                  {doc.githubUrl && (
                    <MenuItem icon={<ExternalLink size={15} />} onSelect={() => window.open(doc.githubUrl!, "_blank", "noopener")}>
                      Open on GitHub
                    </MenuItem>
                  )}
                  {props.isOwner && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Link2 size={15} />} onSelect={props.onPublish}>
                        Change connection…
                      </MenuItem>
                    </>
                  )}
                </>
              ) : (
                <>
                  <MenuLabel>Publish to GitHub</MenuLabel>
                  <MenuItem
                    icon={<GitHubIcon size={15} />}
                    onSelect={props.onPublish}
                    disabled={!props.isOwner || !githubConfigured}
                    title={!githubConfigured ? GITHUB_NOT_CONFIGURED : undefined}
                    data-testid="menu-publish-github"
                  >
                    <GitHubEntryLabel configured={githubConfigured}>Gist or repository…</GitHubEntryLabel>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Download size={15} />} onSelect={() => props.onDownload("md", false)}>
                    Download Markdown
                  </MenuItem>
                  <MenuItem icon={<Share2 size={15} />} onSelect={props.onShare}>
                    Share link…
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
        )}
      </div>
    </header>
  );
});
