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
  readonly deliverButton: (event: object) => boolean;
  readonly rejectAdditional: (event: object) => void;
  readonly isExact: () => boolean;
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

function manualSaveReactMouseWrapperIsExact(
  event: React.MouseEvent<Element>,
  nativeEvent: MouseEvent,
  currentTarget: Element,
  target: Node,
  phase: number,
): boolean {
  return (
    event.nativeEvent !== nativeEvent
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
  ) === false;
}

function createManualSaveClickAdmission(
  publication: ManualSavePublication,
  nativeEvent: MouseEvent,
  event: React.MouseEvent<HTMLSpanElement>,
  target: Node,
  root: HTMLSpanElement,
  button: HTMLButtonElement,
): ManualSaveClickAdmission {
  let buttonDelivered = false;
  let invalid = false;
  return Object.freeze({
    publication,
    nativeEvent,
    reactEvent: event,
    target,
    root,
    button,
    deliverButton: (candidate: object) => {
      if (candidate !== event || buttonDelivered) {
        invalid = true;
        return false;
      }
      buttonDelivered = true;
      return true;
    },
    rejectAdditional: (candidate: object) => {
      if (candidate !== event || buttonDelivered) invalid = true;
    },
    isExact: () => !invalid && buttonDelivered && event.currentTarget === null,
  });
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
      || root.childNodes.length !== 1
      || root.childNodes.item(0) !== button
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
      || button.childNodes.length !== 2
      || button.childNodes.item(0) !== icon
      || button.childNodes.item(1) !== text
      || button.children.item(0) !== icon
      || button.children.item(1) !== text
      || icon.parentElement !== button
      || icon.localName !== "svg"
      || icon.classList.contains("animate-spin") !== (render.iconClassName === "animate-spin")
      || text.parentElement !== button
      || text.tagName !== "SPAN"
      || text.className !== render.textClassName
      || text.textContent !== render.text
      || text.childNodes.length !== 1
      || text.firstChild?.nodeType !== ownerWindow.Node.TEXT_NODE
      || text.firstChild.nodeValue !== render.text
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
    let nativeClickListenerAttached = false;

    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      const button = buttonOwner.element();
      if (nativeClickListenerAttached && button) {
        button.removeEventListener("click", completeNativeClick, true);
        nativeClickListenerAttached = false;
      }
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
        const button = buttonOwner.element();
        if (!button) throw new Error("Cannot publish SaveIndicator without its Save button");
        button.addEventListener("click", completeNativeClick, true);
        nativeClickListenerAttached = true;
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
    const nativeEvent = event?.nativeEvent;
    const existing = cells.clickAdmissions.get(nativeEvent);
    if (existing) {
      existing.rejectAdditional(event);
      return;
    }
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
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
    ) {
      return;
    }
    if (
      !manualSaveReactMouseWrapperIsExact(
        event,
        nativeEvent,
        root,
        target,
        ownerWindow.Event.CAPTURING_PHASE,
      )
    ) {
      return;
    }
    cells.clickAdmissions.set(
      nativeEvent,
      createManualSaveClickAdmission(
        publication,
        nativeEvent,
        event,
        target,
        root,
        button,
      ),
    );
  };

  const onButtonClickCapture = (event: React.MouseEvent<HTMLButtonElement>) => {
    const nativeEvent = event?.nativeEvent;
    const admission = cells.clickAdmissions.get(nativeEvent);
    admission?.rejectAdditional(event);
    if (admission && admission.reactEvent !== event) return;
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const target = event?.target;
    const wrapperIsExact = (
      ownerWindow
      && button
      && nativeEvent instanceof ownerWindow.MouseEvent
      && target instanceof ownerWindow.Node
    )
      ? manualSaveReactMouseWrapperIsExact(
          event,
          nativeEvent,
          button,
          target,
          ownerWindow.Event.CAPTURING_PHASE,
        )
      : null;
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
      || !wrapperIsExact
      || !isLiveNativeEvent(nativeEvent, ownerDocument)
      || !nativeEvent.composedPath().includes(button)
      || !admission
      || admission.publication !== publication
      || admission.nativeEvent !== nativeEvent
      || admission.reactEvent !== event
      || admission.target !== target
      || admission.root !== root
      || admission.button !== button
      || cells.active.current !== publication
      || publication.render !== render
      || publication.render.identity !== render.identity
      || !publication.isExact()
      || render.buttonDisabled
      || !render.canEdit
      || !admission.deliverButton(event)
    ) {
      return;
    }
  };

  const completeNativeClick = (event: Event) => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const root = rootOwner.element();
    const button = buttonOwner.element();
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !runtime
      || !publication
      || !root
      || !button
      || !ownerDocument
      || !ownerWindow
      || !(event instanceof ownerWindow.MouseEvent)
    ) {
      return;
    }
    const admission = cells.clickAdmissions.get(event);
    cells.clickAdmissions.delete(event);
    const target = event.target;
    if (
      !admission
      || admission.publication !== publication
      || admission.nativeEvent !== event
      || admission.root !== root
      || admission.button !== button
      || admission.target !== target
      || !admission.isExact()
      || event.type !== "click"
      || event.button !== 0
      || event.currentTarget !== button
      || event.eventPhase === ownerWindow.Event.NONE
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== ownerDocument
      || !button.contains(target)
      || !event.composedPath().includes(root)
      || !event.composedPath().includes(button)
      || cells.requestOwner.current !== null
      || cells.claimedPublications.has(publication)
      || cells.claimedActions.has(render.action)
      || cells.claimedReactEvents.has(admission.reactEvent)
      || cells.claimedNativeEvents.has(event)
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
    cells.claimedReactEvents.add(admission.reactEvent);
    cells.claimedNativeEvents.add(event);
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

type PublishStatusActionName = "publish" | "pull" | "sync";
type PublishStatusIconName = "loader" | "refresh" | "merge" | "alert" | "success-dot" | "warning-dot";
type PublishStatusWindow = Window & typeof globalThis;

interface PublishStatusRender {
  readonly identity: object;
  readonly mount: symbol;
  readonly sync: SyncStatusDto;
  readonly remote: SyncStatusDto["remote"];
  readonly lines: SyncStatusDto["lines"];
  readonly status: SyncStatusDto["status"];
  readonly remoteSha: string | null;
  readonly remoteRevision: string | null;
  readonly remoteUrl: string | null;
  readonly remoteUpdatedAt: string | null;
  readonly localChanged: boolean;
  readonly remoteChanged: boolean;
  readonly localLines: number;
  readonly remoteLines: number;
  readonly size: number | null | undefined;
  readonly limit: number | undefined;
  readonly pollMs: number | undefined;
  readonly remoteContent: string | undefined;
  readonly publishing: boolean;
  readonly onPublishNow: HeaderProps["onPublishNow"];
  readonly onPull: HeaderProps["onPull"];
  readonly onSync: HeaderProps["onSync"];
  readonly actionName: PublishStatusActionName;
  readonly callback: HeaderProps["onPublishNow"];
  readonly action: object;
  readonly label: string;
  readonly title: string;
  readonly buttonClassName: string;
  readonly iconName: PublishStatusIconName;
  readonly disabled: boolean;
}

interface PublishStatusElementOwnerView {
  readonly element: () => Element | null;
}

class PublishStatusElementOwner<T extends Element> implements PublishStatusElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: PublishStatusElementOwnerView,
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

interface PublishStatusDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly PublishStatusDomSnapshot[];
}

interface PublishStatusPlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface PublishStatusDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface PublishStatusPublication {
  readonly render: PublishStatusRender;
  readonly ownerDocument: Document;
  readonly ownerWindow: PublishStatusWindow;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
  readonly isExact: () => boolean;
}

interface PublishStatusReplay {
  readonly source: PublishStatusPublication;
  readonly dom: PublishStatusDomSnapshot;
  readonly placements: readonly PublishStatusPlacement[];
  readonly expectSuccessor: (identity: object) => void;
  readonly replayIsExact: (identity: object) => boolean;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface PublishStatusRefReplay {
  readonly owner: PublishStatusElementOwnerView;
  readonly element: Element;
  detached: boolean;
  reattached: boolean;
}

interface PublishStatusPublicationRuntime {
  readonly publication: PublishStatusPublication;
  readonly publish: (
    snapshot: PublishStatusDomSnapshot,
    placements: readonly PublishStatusPlacement[],
    owners: readonly PublishStatusElementOwnerView[],
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: PublishStatusElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly snapshot: () => PublishStatusDomSnapshot | null;
  readonly placements: () => readonly PublishStatusPlacement[] | null;
  readonly mutationHistoryIsClean: () => boolean;
  readonly release: () => void;
  readonly claimActivation: () => boolean;
  readonly beginReplayHandoff: () => void;
  readonly expectSuccessor: (identity: object) => void;
  readonly successorTransitionIsExact: (identity: object) => boolean;
}

interface PublishStatusClickAdmission {
  readonly publication: PublishStatusPublication;
  readonly nativeEvent: MouseEvent;
  readonly captureEvent: React.MouseEvent<HTMLButtonElement>;
  readonly target: Node;
  readonly button: HTMLButtonElement;
  readonly deliverBubble: (event: React.MouseEvent<HTMLButtonElement>) => boolean;
  readonly bubbleEvent: () => React.MouseEvent<HTMLButtonElement> | null;
  readonly rejectAdditional: (event: object) => void;
  readonly isExact: () => boolean;
}

interface PublishStatusCells {
  readonly active: { current: PublishStatusPublication | null };
  readonly successorOf: { current: PublishStatusPublication | null };
  readonly replay: { current: PublishStatusReplay | null };
  readonly callbackDepth: { current: number };
  readonly claimedPublications: WeakSet<PublishStatusPublication>;
  readonly claimedActions: WeakSet<object>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly clickAdmissions: WeakMap<Event, PublishStatusClickAdmission>;
}

interface PublishStatusPublicationSet {
  readonly captureButton: React.RefCallback<HTMLButtonElement>;
  readonly captureSvgIcon: React.RefCallback<SVGSVGElement>;
  readonly captureDot: React.RefCallback<HTMLSpanElement>;
  readonly captureStatus: React.RefCallback<HTMLSpanElement>;
  readonly establish: () => void | (() => void);
  readonly onClickCapture: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface PublishStatusIconChild {
  readonly tag: "circle" | "path";
  readonly attributes: readonly (readonly [string, string])[];
}

interface PublishStatusIconFacts {
  readonly className: string;
  readonly size: string;
  readonly children: readonly PublishStatusIconChild[];
}

const PUBLISH_STATUS_BUTTON_CLASS_NAME = "btn btn-primary gap-1.5 rounded-r-none pl-3 pr-3";
const publishStatusCallbackDepths = new WeakMap<Document, number>();
const claimedPublishStatusNativeEvents = new WeakSet<Event>();
const PUBLISH_STATUS_ICON_FACTS: Readonly<Record<Exclude<PublishStatusIconName, "success-dot" | "warning-dot">, PublishStatusIconFacts>> = Object.freeze({
  loader: Object.freeze({
    className: "lucide lucide-loader-circle animate-spin",
    size: "16",
    children: Object.freeze([
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M21 12a9 9 0 1 1-6.219-8.56"] as const)]),
      }),
    ]),
  }),
  refresh: Object.freeze({
    className: "lucide lucide-refresh-cw",
    size: "15",
    children: Object.freeze([
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"] as const)]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M21 3v5h-5"] as const)]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"] as const)]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M8 16H3v5"] as const)]),
      }),
    ]),
  }),
  merge: Object.freeze({
    className: "lucide lucide-git-merge",
    size: "15",
    children: Object.freeze([
      Object.freeze({
        tag: "circle" as const,
        attributes: Object.freeze([
          Object.freeze(["cx", "18"] as const),
          Object.freeze(["cy", "18"] as const),
          Object.freeze(["r", "3"] as const),
        ]),
      }),
      Object.freeze({
        tag: "circle" as const,
        attributes: Object.freeze([
          Object.freeze(["cx", "6"] as const),
          Object.freeze(["cy", "6"] as const),
          Object.freeze(["r", "3"] as const),
        ]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M6 21V9a9 9 0 0 0 9 9"] as const)]),
      }),
    ]),
  }),
  alert: Object.freeze({
    className: "lucide lucide-triangle-alert text-amber-200",
    size: "15",
    children: Object.freeze([
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"] as const)]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M12 9v4"] as const)]),
      }),
      Object.freeze({
        tag: "path" as const,
        attributes: Object.freeze([Object.freeze(["d", "M12 17h.01"] as const)]),
      }),
    ]),
  }),
});

function publishStatusCallbackDepth(ownerDocument: Document) {
  return publishStatusCallbackDepths.get(ownerDocument) ?? 0;
}

function enterPublishStatusCallback(ownerDocument: Document) {
  publishStatusCallbackDepths.set(
    ownerDocument,
    publishStatusCallbackDepth(ownerDocument) + 1,
  );
  return () => {
    const depth = publishStatusCallbackDepth(ownerDocument);
    if (depth <= 1) publishStatusCallbackDepths.delete(ownerDocument);
    else publishStatusCallbackDepths.set(ownerDocument, depth - 1);
  };
}

function publishStatusActionName(status: SyncStatusDto["status"]): PublishStatusActionName {
  if (status === "remote-ahead") return "pull";
  if (status === "diverged" || status === "remote-unreadable") return "sync";
  return "publish";
}

function publishStatusLabel(status: SyncStatusDto["status"]) {
  return status === "remote-ahead"
    ? "Pull"
    : status === "diverged"
      ? "Both changed"
      : status === "remote-unreadable"
        ? SYNC_LABELS[status]
        : status === "in-sync"
          ? "Up to date"
          : "Publish";
}

function publishStatusIconName(
  status: SyncStatusDto["status"],
  publishing: boolean,
): PublishStatusIconName {
  if (publishing) return "loader";
  if (status === "remote-ahead") return "refresh";
  if (status === "diverged") return "merge";
  if (status === "remote-unreadable") return "alert";
  return status === "in-sync" ? "success-dot" : "warning-dot";
}

function publishStatusRendersMatch(left: PublishStatusRender, right: PublishStatusRender) {
  return left.mount === right.mount
    && left.sync === right.sync
    && left.remote === right.remote
    && left.lines === right.lines
    && left.status === right.status
    && left.remoteSha === right.remoteSha
    && left.remoteRevision === right.remoteRevision
    && left.remoteUrl === right.remoteUrl
    && left.remoteUpdatedAt === right.remoteUpdatedAt
    && left.localChanged === right.localChanged
    && left.remoteChanged === right.remoteChanged
    && left.localLines === right.localLines
    && left.remoteLines === right.remoteLines
    && left.size === right.size
    && left.limit === right.limit
    && left.pollMs === right.pollMs
    && left.remoteContent === right.remoteContent
    && left.publishing === right.publishing
    && left.onPublishNow === right.onPublishNow
    && left.onPull === right.onPull
    && left.onSync === right.onSync
    && left.actionName === right.actionName
    && left.callback === right.callback
    && left.label === right.label
    && left.title === right.title
    && left.buttonClassName === right.buttonClassName
    && left.iconName === right.iconName
    && left.disabled === right.disabled;
}

function publishStatusFactsAreCurrent(render: PublishStatusRender) {
  const { sync } = render;
  const actionName = publishStatusActionName(sync.status);
  const callback = actionName === "pull"
    ? render.onPull
    : actionName === "sync"
      ? render.onSync
      : render.onPublishNow;
  return sync.remote === render.remote
    && sync.lines === render.lines
    && sync.status === render.status
    && sync.remote.sha === render.remoteSha
    && sync.remote.revision === render.remoteRevision
    && sync.remote.url === render.remoteUrl
    && sync.remote.updatedAt === render.remoteUpdatedAt
    && sync.localChanged === render.localChanged
    && sync.remoteChanged === render.remoteChanged
    && sync.lines.local === render.localLines
    && sync.lines.remote === render.remoteLines
    && sync.size === render.size
    && sync.limit === render.limit
    && sync.pollMs === render.pollMs
    && sync.remoteContent === render.remoteContent
    && actionName === render.actionName
    && callback === render.callback
    && publishStatusLabel(sync.status) === render.label
    && SYNC_LABELS[sync.status] === render.title
    && PUBLISH_STATUS_BUTTON_CLASS_NAME === render.buttonClassName
    && publishStatusIconName(sync.status, render.publishing) === render.iconName
    && render.disabled === render.publishing;
}

function snapshotPublishStatusAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function publishStatusAttributesAreExact(
  element: Element,
  expected: readonly (readonly [string, string])[],
) {
  const actual = snapshotPublishStatusAttributes(element);
  const sortedExpected = [...expected].sort(([left], [right]) => left.localeCompare(right));
  return actual !== null
    && actual.length === sortedExpected.length
    && actual.every(([name, value], index) => {
      const pair = sortedExpected[index];
      return pair?.[0] === name && pair[1] === value;
    });
}

function publishStatusIconIsExact(
  icon: Element,
  button: HTMLButtonElement,
  render: PublishStatusRender,
  ownerWindow: PublishStatusWindow,
) {
  if (render.iconName === "success-dot" || render.iconName === "warning-dot") {
    const expectedClassName = cn(
      "inline-block h-2 w-2 rounded-full",
      render.iconName === "success-dot" ? "bg-emerald-300" : "bg-amber-300",
    );
    return icon instanceof ownerWindow.HTMLSpanElement
      && icon.parentElement === button
      && icon.tagName === "SPAN"
      && icon.childNodes.length === 0
      && publishStatusAttributesAreExact(icon, [
        ["aria-hidden", "true"],
        ["class", expectedClassName],
      ]);
  }
  if (!(icon instanceof ownerWindow.SVGSVGElement)) return false;
  const facts = PUBLISH_STATUS_ICON_FACTS[render.iconName];
  const iconAttributes = [
    ["aria-hidden", "true"],
    ["class", facts.className],
    ["fill", "none"],
    ["height", facts.size],
    ["stroke", "currentColor"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["stroke-width", "2"],
    ["viewBox", "0 0 24 24"],
    ["width", facts.size],
    ["xmlns", "http://www.w3.org/2000/svg"],
  ] as const;
  return icon.parentElement === button
    && icon.localName === "svg"
    && publishStatusAttributesAreExact(icon, iconAttributes)
    && icon.childNodes.length === facts.children.length
    && facts.children.every((expected, index) => {
      const child = icon.childNodes.item(index);
      return child instanceof ownerWindow.SVGElement
        && child.localName === expected.tag
        && child.childNodes.length === 0
        && publishStatusAttributesAreExact(child, expected.attributes);
    });
}

function snapshotPublishStatusDom(node: Node): PublishStatusDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotPublishStatusAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotPublishStatusDom)),
  });
}

function publishStatusDomMatches(snapshot: PublishStatusDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotPublishStatusAttributes(node);
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
      (child, index) => node.childNodes.item(index) === child.node && publishStatusDomMatches(child),
    );
}

function publishStatusSnapshotContains(snapshot: PublishStatusDomSnapshot, node: Node): boolean {
  return snapshot.node === node
    || snapshot.children.some((child) => publishStatusSnapshotContains(child, node));
}

function snapshotPublishStatusPlacement(
  button: HTMLButtonElement,
): readonly PublishStatusPlacement[] | null {
  const placements: PublishStatusPlacement[] = [];
  const ownerDocument = button.ownerDocument;
  for (let node: Node | null = button; node; node = node.parentNode) {
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

function publishStatusPlacementsMatch(placements: readonly PublishStatusPlacement[]) {
  return placements.length > 0
    && placements[placements.length - 1]?.node.nodeType === 9
    && placements.every(({ node, parent, previousSibling, nextSibling }) =>
      node.parentNode === parent
      && node.previousSibling === previousSibling
      && node.nextSibling === nextSibling);
}

function publishStatusPlacementIsExact(
  button: HTMLButtonElement,
  placements: readonly PublishStatusPlacement[],
) {
  return button.isConnected
    && placements[0]?.node === button
    && placements[placements.length - 1]?.node === button.ownerDocument
    && publishStatusPlacementsMatch(placements);
}

function createPublishStatusDomGuard(
  button: HTMLButtonElement,
  placements: readonly PublishStatusPlacement[],
  onInvalidated: () => void,
): PublishStatusDomGuard | null {
  const MutationObserverConstructor = button.ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  const placementNodes = new Set(placements.map(({ node }) => node));
  let changed = false;
  let released = false;
  const isRelevant = (record: MutationRecord) => {
    if (record.target === button || button.contains(record.target)) return true;
    if (record.type !== "childList" || !placementNodes.has(record.target)) return false;
    return (record.previousSibling !== null && placementNodes.has(record.previousSibling))
      || (record.nextSibling !== null && placementNodes.has(record.nextSibling))
      || [...record.addedNodes, ...record.removedNodes].some((node) =>
        placementNodes.has(node) || node.contains(button));
  };
  const inspect = (records: readonly MutationRecord[]) => {
    if (changed || released || !records.some(isRelevant)) return;
    changed = true;
    onInvalidated();
  };
  const observer = new MutationObserverConstructor(inspect);
  observer.observe(button, {
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

function clearDetachedPublishStatusReplay(
  cells: PublishStatusCells,
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

function publishStatusReactMouseWrapperIsExact(
  event: React.MouseEvent<HTMLButtonElement>,
  nativeEvent: MouseEvent,
  button: HTMLButtonElement,
  target: Node,
  phase: number,
) {
  return event.nativeEvent === nativeEvent
    && event.type === nativeEvent.type
    && event.currentTarget === button
    && event.target === target
    && nativeEvent.target === target
    && event.button === nativeEvent.button
    && event.buttons === nativeEvent.buttons
    && event.altKey === nativeEvent.altKey
    && event.ctrlKey === nativeEvent.ctrlKey
    && event.metaKey === nativeEvent.metaKey
    && event.shiftKey === nativeEvent.shiftKey
    && event.clientX === nativeEvent.clientX
    && event.clientY === nativeEvent.clientY
    && event.detail === nativeEvent.detail
    && event.bubbles === nativeEvent.bubbles
    && event.cancelable === nativeEvent.cancelable
    && event.eventPhase === nativeEvent.eventPhase
    && nativeEvent.eventPhase === phase
    && event.isTrusted === nativeEvent.isTrusted
    && event.timeStamp === nativeEvent.timeStamp
    && !event.defaultPrevented
    && !nativeEvent.defaultPrevented
    && typeof event.preventDefault === "function"
    && typeof event.stopPropagation === "function"
    && typeof event.isDefaultPrevented === "function"
    && typeof event.isPropagationStopped === "function"
    && typeof event.persist === "function";
}

function createPublishStatusClickAdmission(
  publication: PublishStatusPublication,
  nativeEvent: MouseEvent,
  event: React.MouseEvent<HTMLButtonElement>,
  target: Node,
  button: HTMLButtonElement,
): PublishStatusClickAdmission {
  let bubbleEvent: React.MouseEvent<HTMLButtonElement> | null = null;
  let bubbleDelivered = false;
  let invalid = false;
  return Object.freeze({
    publication,
    nativeEvent,
    captureEvent: event,
    target,
    button,
    deliverBubble: (candidate: React.MouseEvent<HTMLButtonElement>) => {
      if (candidate === event || bubbleDelivered) {
        invalid = true;
        return false;
      }
      bubbleEvent = candidate;
      bubbleDelivered = true;
      return true;
    },
    bubbleEvent: () => bubbleEvent,
    rejectAdditional: (candidate: object) => {
      if (candidate !== event || bubbleDelivered) invalid = true;
    },
    isExact: () => !invalid
      && bubbleDelivered
      && event.currentTarget === null
      && bubbleEvent !== null
      && bubbleEvent.currentTarget === null,
  });
}

function createPublishStatusPublication(
  render: PublishStatusRender,
  cells: PublishStatusCells,
  requestSuccessor: () => void,
): PublishStatusPublicationSet {
  let currentRuntime: PublishStatusPublicationRuntime | null = null;
  let lastRuntime: PublishStatusPublicationRuntime | null = null;
  let successorRequested = false;

  const requestReplaySuccessor = (runtime: PublishStatusPublicationRuntime) => {
    const dom = runtime.snapshot();
    const placements = runtime.placements();
    if (
      successorRequested
      || !dom
      || !placements
      || cells.successorOf.current !== runtime.publication
      || cells.claimedPublications.has(runtime.publication)
      || !publishStatusFactsAreCurrent(render)
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
    owner: PublishStatusElementOwnerView,
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
  const buttonOwner = new PublishStatusElementOwner<HTMLButtonElement>(onElementChange);
  const iconOwner = new PublishStatusElementOwner<Element>(onElementChange);
  const statusOwner = new PublishStatusElementOwner<HTMLSpanElement>(onElementChange);
  const captureSvgIcon = (element: SVGSVGElement | null) => iconOwner.capture(element);
  const captureDot = (element: HTMLSpanElement | null) => iconOwner.capture(element);
  const expectedOwners = (): readonly PublishStatusElementOwnerView[] => [
    buttonOwner,
    iconOwner,
    statusOwner,
  ];

  const exactDomIsCurrent = () => {
    const button = buttonOwner.element();
    const icon = iconOwner.element();
    const status = statusOwner.element();
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !button
      || !icon
      || !status
      || !ownerDocument
      || !ownerWindow
      || !(button instanceof ownerWindow.HTMLButtonElement)
      || !(status instanceof ownerWindow.HTMLSpanElement)
      || !button.isConnected
      || button.ownerDocument !== ownerDocument
      || icon.ownerDocument !== ownerDocument
      || status.ownerDocument !== ownerDocument
      || button.tagName !== "BUTTON"
      || button.type !== "button"
      || button.className !== render.buttonClassName
      || button.disabled !== render.disabled
      || button.matches(":disabled") !== render.disabled
      || button.dataset.testid !== "publish-button"
      || button.title !== render.title
      || button.getAttribute("aria-label") !== null
      || button.getAttribute("aria-busy") !== null
      || button.children.length !== 2
      || button.childNodes.length !== 2
      || button.childNodes.item(0) !== icon
      || button.childNodes.item(1) !== status
      || button.children.item(0) !== icon
      || button.children.item(1) !== status
      || icon.parentElement !== button
      || status.parentElement !== button
      || status.tagName !== "SPAN"
      || status.dataset.testid !== "publish-status"
      || status.dataset.status !== render.status
      || status.textContent !== render.label
      || status.childNodes.length !== 1
      || status.firstChild?.nodeType !== ownerWindow.Node.TEXT_NODE
      || status.firstChild.nodeValue !== render.label
      || button.textContent !== render.label
      || button.querySelectorAll('[data-testid="publish-status"]').length !== 1
    ) {
      return false;
    }
    const buttonAttributes: (readonly [string, string])[] = [
      ["class", render.buttonClassName],
      ["data-testid", "publish-button"],
      ["title", render.title],
      ["type", "button"],
    ];
    if (render.disabled) buttonAttributes.push(["disabled", ""]);
    return publishStatusAttributesAreExact(button, buttonAttributes)
      && publishStatusIconIsExact(icon, button, render, ownerWindow)
      && publishStatusAttributesAreExact(status, [
        ["data-status", render.status],
        ["data-testid", "publish-status"],
      ]);
  };

  const createRuntime = (
    ownerDocument: Document,
    ownerWindow: PublishStatusWindow,
  ): PublishStatusPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domSnapshot: PublishStatusDomSnapshot | null = null;
    let placementSnapshots: readonly PublishStatusPlacement[] | null = null;
    let domGuard: PublishStatusDomGuard | null = null;
    let replayRefs: PublishStatusRefReplay[] = [];
    let invalidReplay = false;
    let activationClaimed = false;
    let replayHandedOff = false;
    let replayHandoffInvalid = false;
    let expectedSuccessor: object | null = null;
    let nativeClickListenerAttached = false;

    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      if (nativeClickListenerAttached) {
        ownerDocument.removeEventListener("click", completeNativeClick);
        nativeClickListenerAttached = false;
      }
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        clearDetachedPublishStatusReplay(cells, render.mount);
        if (cells.replay.current?.source !== publication) domGuard?.release();
      });
      return true;
    };
    const publishedDomMatches = () => {
      const button = buttonOwner.element();
      return Boolean(
        domSnapshot
        && placementSnapshots
        && domGuard?.isClean()
        && button
        && button === domSnapshot.node
        && button.ownerDocument === ownerDocument
        && ownerDocument.defaultView === ownerWindow
        && publishStatusPlacementIsExact(button, placementSnapshots)
        && publishStatusDomMatches(domSnapshot)
      );
    };
    const publication: PublishStatusPublication = Object.freeze({
      render,
      ownerDocument,
      ownerWindow,
      retire: () => retire("other"),
      isRetired: () => retired,
      isExact: () => {
        if (retired) return false;
        const exact = publishStatusFactsAreCurrent(render)
          && exactDomIsCurrent()
          && publishedDomMatches();
        if (!exact) retire("other");
        return exact;
      },
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
    const runtime: PublishStatusPublicationRuntime = Object.freeze({
      publication,
      publish: (
        snapshot: PublishStatusDomSnapshot,
        placements: readonly PublishStatusPlacement[],
        owners: readonly PublishStatusElementOwnerView[],
      ) => {
        const button = buttonOwner.element();
        if (!button) throw new Error("Cannot publish GitHub status without its button");
        domGuard = createPublishStatusDomGuard(button, placements, () => retire("mutation"));
        if (!domGuard) {
          throw new Error("Cannot publish GitHub status without a DOM mutation observer");
        }
        established = true;
        domSnapshot = snapshot;
        placementSnapshots = placements;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) throw new Error("Cannot publish GitHub status without every committed ref");
          return { owner, element, detached: false, reattached: false };
        });
        ownerDocument.addEventListener("click", completeNativeClick);
        nativeClickListenerAttached = true;
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
        owner: PublishStatusElementOwnerView,
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

    function completeNativeClick(event: Event) {
      const activeRuntime = currentRuntime;
      const activePublication = activeRuntime?.publication;
      const button = buttonOwner.element();
      if (
        !activeRuntime
        || !activePublication
        || !button
        || !(event instanceof ownerWindow.MouseEvent)
      ) {
        return;
      }
      const admission = cells.clickAdmissions.get(event);
      cells.clickAdmissions.delete(event);
      const target = event.target;
      const dom = activeRuntime.snapshot();
      const bubbleEvent = admission?.bubbleEvent();
      if (
        !admission
        || admission.publication !== activePublication
        || admission.nativeEvent !== event
        || admission.button !== button
        || admission.target !== target
        || !admission.isExact()
        || event.type !== "click"
        || event.button !== 0
        || !event.bubbles
        || event.currentTarget !== ownerDocument
        || event.eventPhase === ownerWindow.Event.NONE
        || !(target instanceof ownerWindow.Node)
        || target.ownerDocument !== ownerDocument
        || !button.contains(target)
        || !event.composedPath().includes(button)
        || !dom
        || !publishStatusSnapshotContains(dom, target)
        || cells.callbackDepth.current !== 0
        || publishStatusCallbackDepth(ownerDocument) !== 0
        || cells.claimedPublications.has(activePublication)
        || cells.claimedActions.has(render.action)
        || cells.claimedReactEvents.has(admission.captureEvent)
        || !bubbleEvent
        || cells.claimedReactEvents.has(bubbleEvent)
        || cells.claimedNativeEvents.has(event)
        || claimedPublishStatusNativeEvents.has(event)
        || cells.active.current !== activePublication
        || activePublication.render !== render
        || activePublication.render.identity !== render.identity
        || render.disabled
        || button.matches(":disabled")
        || !activePublication.isExact()
        || !activeRuntime.claimActivation()
      ) {
        return;
      }

      cells.claimedPublications.add(activePublication);
      cells.claimedActions.add(render.action);
      cells.claimedReactEvents.add(admission.captureEvent);
      cells.claimedReactEvents.add(bubbleEvent);
      cells.claimedNativeEvents.add(event);
      claimedPublishStatusNativeEvents.add(event);
      cells.callbackDepth.current++;
      const leaveCallback = enterPublishStatusCallback(ownerDocument);
      try {
        const callback = render.callback;
        callback();
      } finally {
        leaveCallback();
        cells.callbackDepth.current--;
      }
    }

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
    if (!publishStatusFactsAreCurrent(render) || !exactDomIsCurrent()) return undefined;
    const button = buttonOwner.element();
    const ownerDocument = button?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    const placements = button ? snapshotPublishStatusPlacement(button) : null;
    if (
      !button
      || !ownerDocument
      || !ownerWindow
      || !placements
      || !publishStatusPlacementIsExact(button, placements)
    ) {
      return undefined;
    }

    const replay = cells.replay.current;
    if (replay) {
      const sameRender = publishStatusRendersMatch(replay.source.render, render);
      const exactReplay = sameRender
        && replay.source.isRetired()
        && cells.successorOf.current === replay.source
        && replay.replayIsExact(render.identity)
        && replay.historyIsClean()
        && button === replay.dom.node
        && ownerDocument === replay.source.ownerDocument
        && ownerWindow === replay.source.ownerWindow
        && publishStatusPlacementIsExact(button, replay.placements)
        && publishStatusDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) cells.successorOf.current = null;
      if (sameRender && !exactReplay) return undefined;
    }

    const runtime = createRuntime(ownerDocument, ownerWindow);
    const previous = cells.active.current;
    if (previous && previous !== runtime.publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(snapshotPublishStatusDom(button), placements, expectedOwners());
    return runtime.retireForLayout;
  };

  const replay = cells.replay.current;
  if (replay && publishStatusRendersMatch(replay.source.render, render)) {
    replay.expectSuccessor(render.identity);
  }

  const currentPublication = () => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const button = buttonOwner.element();
    if (
      !runtime
      || !publication
      || !button
      || cells.active.current !== publication
      || publication.render !== render
      || publication.render.identity !== render.identity
      || render.disabled
      || button.matches(":disabled")
      || cells.callbackDepth.current !== 0
      || publishStatusCallbackDepth(button.ownerDocument) !== 0
      || cells.claimedPublications.has(publication)
      || cells.claimedActions.has(render.action)
      || !publication.isExact()
    ) {
      return null;
    }
    return { runtime, publication, button };
  };

  const onClickCapture = (event: React.MouseEvent<HTMLButtonElement>) => {
    const current = currentPublication();
    const button = current?.button;
    const publication = current?.publication;
    const ownerDocument = publication?.ownerDocument;
    const ownerWindow = publication?.ownerWindow;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !current
      || !button
      || !publication
      || !ownerDocument
      || !ownerWindow
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || !nativeEvent.bubbles
      || !(target instanceof ownerWindow.Node)
      || target.ownerDocument !== ownerDocument
      || !button.contains(target)
      || !isLiveNativeEvent(nativeEvent, ownerDocument)
      || !nativeEvent.composedPath().includes(button)
      || cells.claimedReactEvents.has(event)
      || cells.claimedNativeEvents.has(nativeEvent)
      || claimedPublishStatusNativeEvents.has(nativeEvent)
      || !publishStatusReactMouseWrapperIsExact(
        event,
        nativeEvent,
        button,
        target,
        ownerWindow.Event.CAPTURING_PHASE,
      )
    ) {
      return;
    }
    const existing = cells.clickAdmissions.get(nativeEvent);
    if (existing) {
      existing.rejectAdditional(event);
      return;
    }
    cells.clickAdmissions.set(
      nativeEvent,
      createPublishStatusClickAdmission(
        publication,
        nativeEvent,
        event,
        target,
        button,
      ),
    );
  };

  const onClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const nativeEvent = event?.nativeEvent;
    const ownerWindow = buttonOwner.element()?.ownerDocument.defaultView;
    const admission = cells.clickAdmissions.get(nativeEvent);
    const current = currentPublication();
    const button = current?.button;
    const publication = current?.publication;
    const target = event?.target;
    if (
      !admission
      || !current
      || !button
      || !publication
      || !ownerWindow
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || !(target instanceof ownerWindow.Node)
      || admission.publication !== publication
      || admission.nativeEvent !== nativeEvent
      || admission.captureEvent === event
      || admission.target !== target
      || admission.button !== button
      || !publishStatusReactMouseWrapperIsExact(
        event,
        nativeEvent,
        button,
        target,
        ownerWindow.Event.BUBBLING_PHASE,
      )
      || !admission.deliverBubble(event)
    ) {
      admission?.rejectAdditional(event);
    }
  };

  return Object.freeze({
    captureButton: buttonOwner.capture,
    captureSvgIcon,
    captureDot,
    captureStatus: statusOwner.capture,
    establish,
    onClickCapture,
    onClick,
  });
}

export function PublishStatusButton({
  sync,
  publishing,
  onPublishNow,
  onPull,
  onSync,
}: Pick<HeaderProps, "sync" | "publishing" | "onPublishNow" | "onPull" | "onSync"> & { sync: SyncStatusDto }) {
  const [mount] = useState(() => Symbol("publish status"));
  const [cells] = useState<PublishStatusCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    callbackDepth: { current: 0 },
    claimedPublications: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    clickAdmissions: new WeakMap(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  useEffect(() => () => {
    clearDetachedPublishStatusReplay(cells, mount);
  }, [cells, mount]);

  const actionName = publishStatusActionName(sync.status);
  const callback = actionName === "pull"
    ? onPull
    : actionName === "sync"
      ? onSync
      : onPublishNow;
  const label = publishStatusLabel(sync.status);
  const iconName = publishStatusIconName(sync.status, publishing);
  const render = Object.freeze<PublishStatusRender>({
    identity: Object.freeze({}),
    mount,
    sync,
    remote: sync.remote,
    lines: sync.lines,
    status: sync.status,
    remoteSha: sync.remote.sha,
    remoteRevision: sync.remote.revision,
    remoteUrl: sync.remote.url,
    remoteUpdatedAt: sync.remote.updatedAt,
    localChanged: sync.localChanged,
    remoteChanged: sync.remoteChanged,
    localLines: sync.lines.local,
    remoteLines: sync.lines.remote,
    size: sync.size,
    limit: sync.limit,
    pollMs: sync.pollMs,
    remoteContent: sync.remoteContent,
    publishing,
    onPublishNow,
    onPull,
    onSync,
    actionName,
    callback,
    action: Object.freeze({}),
    label,
    title: SYNC_LABELS[sync.status],
    buttonClassName: PUBLISH_STATUS_BUTTON_CLASS_NAME,
    iconName,
    disabled: publishing,
  });
  const publication = createPublishStatusPublication(
    render,
    cells,
    requestPublicationSuccessor,
  );
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureButton,
    captureSvgIcon,
    captureDot,
    captureStatus,
    onClickCapture,
    onClick,
  } = publication;

  return (
    <button
      ref={captureButton}
      type="button"
      className={PUBLISH_STATUS_BUTTON_CLASS_NAME}
      disabled={publishing}
      data-testid="publish-button"
      onClickCapture={onClickCapture}
      onClick={onClick}
      title={SYNC_LABELS[sync.status]}
    >
      {publishing ? (
        <Loader2 ref={captureSvgIcon} size={16} className="animate-spin" />
      ) : sync.status === "remote-ahead" ? (
        <RefreshCw ref={captureSvgIcon} size={15} />
      ) : sync.status === "diverged" ? (
        <GitMerge ref={captureSvgIcon} size={15} />
      ) : sync.status === "remote-unreadable" ? (
        <AlertTriangle ref={captureSvgIcon} size={15} className="text-amber-200" />
      ) : (
        <span ref={captureDot} aria-hidden className={cn("inline-block h-2 w-2 rounded-full", sync.status === "in-sync" ? "bg-emerald-300" : "bg-amber-300")} />
      )}
      <span ref={captureStatus} data-testid="publish-status" data-status={sync.status}>
        {label}
      </span>
    </button>
  );
}

type MoreMenuActionName = "history" | "name-version" | "duplicate" | "delete";

interface MoreMenuVisit {
  readonly mount: symbol;
  readonly session: CollabSession;
  readonly document: DocumentDto;
}

interface MoreMenuState {
  readonly visit: MoreMenuVisit;
  readonly open: boolean;
}

interface MoreMenuAction {
  readonly name: MoreMenuActionName;
  readonly callback: () => void;
  readonly eligible: boolean;
  readonly label: string;
  readonly testId: string | null;
  readonly className: string;
  readonly iconClassName: string;
  readonly busy: boolean;
}

interface MoreMenuRender {
  readonly identity: object;
  readonly visit: MoreMenuVisit;
  readonly props: HeaderProps;
  readonly session: CollabSession;
  readonly document: DocumentDto;
  readonly documentFields: readonly (readonly [string, unknown])[];
  readonly bindings: readonly unknown[];
  readonly docId: string;
  readonly role: CollabSession["role"];
  readonly mode: EditMode;
  readonly setMode: CollabSession["setMode"];
  readonly compact: boolean;
  readonly linked: boolean;
  readonly canEdit: boolean;
  readonly isOwner: boolean;
  readonly githubConfigured: boolean;
  readonly publishing: boolean;
  readonly documentMutation: HeaderProps["documentMutation"];
  readonly open: boolean;
  readonly actions: Readonly<Record<MoreMenuActionName, MoreMenuAction>>;
}

interface MoreMenuDom {
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLDivElement | null;
  readonly actions: Readonly<Record<MoreMenuActionName, HTMLDivElement | null>>;
}

interface MoreMenuPublication {
  readonly render: MoreMenuRender;
  readonly document: Document;
  readonly dom: MoreMenuDom;
  readonly triggerSnapshot: ModeSwitcherDomSnapshot;
  readonly contentSnapshot: ModeSwitcherDomSnapshot | null;
  readonly placements: readonly ModeSwitcherPlacementSnapshot[];
  readonly isExact: () => boolean;
  readonly recordElementChange: (
    owner: MoreMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactElementReplay: () => boolean;
  readonly retire: () => boolean;
  readonly dispose: () => void;
}

interface MoreMenuPublicationRuntime {
  readonly publication: MoreMenuPublication;
  readonly retireForLayout: () => void;
  readonly isExactLayoutReplay: () => boolean;
}

interface MoreMenuDisclosureIntent {
  readonly publication: MoreMenuPublication;
  readonly open: boolean;
  readonly returnFocus: boolean;
  readonly events: readonly Event[];
}

interface MoreMenuSelectionIntent {
  readonly publication: MoreMenuPublication;
  readonly action: MoreMenuAction;
  readonly nativeEvent: MouseEvent;
  readonly target: Node;
  readonly path: readonly EventTarget[];
}

interface MoreMenuGenericSelectionIntent {
  readonly nativeEvent: MouseEvent;
  readonly target: Node;
  readonly item: HTMLElement;
  readonly path: readonly EventTarget[];
}

interface MoreMenuFocusIntent {
  readonly source: MoreMenuPublication;
  readonly visit: MoreMenuVisit;
  readonly target: HTMLButtonElement;
  readonly action: MoreMenuActionName | null;
  readonly modes: readonly EditMode[];
  readonly guard: MoreMenuFocusGuard;
}

interface MoreMenuFocusGuard {
  readonly isExact: (publication: MoreMenuPublication) => boolean;
  readonly dispose: () => void;
}

interface MoreMenuPresentation {
  readonly captureTrigger: React.RefCallback<HTMLButtonElement>;
  readonly captureContent: React.RefCallback<HTMLDivElement>;
  readonly captureHistory: React.RefCallback<HTMLDivElement>;
  readonly captureNameVersion: React.RefCallback<HTMLDivElement>;
  readonly captureDuplicate: React.RefCallback<HTMLDivElement>;
  readonly captureDelete: React.RefCallback<HTMLDivElement>;
  readonly establish: () => (() => void) | undefined;
  readonly onTriggerPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  readonly onTriggerKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onHistorySelect: (event: Event) => void;
  readonly onNameVersionSelect: (event: Event) => void;
  readonly onDuplicateSelect: (event: Event) => void;
  readonly onDeleteSelect: (event: Event) => void;
  readonly onEscapeKeyDown: (event: KeyboardEvent) => void;
  readonly onOutside: (event: CustomEvent<{ originalEvent: Event }>) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}

class MoreMenuElementOwner<T extends HTMLElement> {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly accepts: (element: T) => boolean,
    private readonly allowsReplacement: () => boolean,
    private readonly onChange: (
      owner: MoreMenuElementOwner<T>,
      element: T | null,
      previous: T | null,
    ) => void,
  ) {}

  readonly element = () => this.#current;

  readonly capture: React.RefCallback<T> = (element) => {
    if (this.#current === element) return;
    if (
      element
      && (
        !this.accepts(element)
        || (this.#current !== null && this.#current !== element)
        || (
          this.#current === null
          && this.#last !== null
          && this.#last !== element
          && !this.allowsReplacement()
        )
      )
    ) {
      return;
    }
    const previous = this.#current;
    if (element === null) {
      this.onChange(this, null, previous);
      this.#current = null;
      return;
    }
    this.#current = element;
    this.#last = element;
    this.onChange(this, element, previous);
  };
}

interface MoreMenuElementOwnerHandle {
  readonly element: () => HTMLElement | null;
}

interface MoreMenuOwners {
  readonly trigger: MoreMenuElementOwner<HTMLButtonElement>;
  readonly content: MoreMenuElementOwner<HTMLDivElement>;
  readonly actions: Readonly<Record<MoreMenuActionName, MoreMenuElementOwner<HTMLDivElement>>>;
}

class MoreMenuPublicationCoordinator {
  #active: MoreMenuPublication | null = null;
  #successorOf: MoreMenuPublication | null = null;
  #disclosureIntent: MoreMenuDisclosureIntent | null = null;
  #selectionIntent: MoreMenuSelectionIntent | null = null;
  #focusIntent: MoreMenuFocusIntent | null = null;
  #claimedPublications = new WeakSet<MoreMenuPublication>();
  #claimedActions = new WeakSet<MoreMenuAction>();
  #claimedEvents = new WeakSet<Event>();
  #stagedNativeEvents = new WeakSet<Event>();
  #dispatchedSelectionCustomEvent: Event | null = null;
  #selectionCustomEvent: Event | null = null;
  #dispatchedOutsideCustomEvents = new WeakMap<Event, Event>();
  #outsideCustomEvents = new WeakMap<Event, Event>();
  #taintedOutsideNativeEvents = new WeakSet<Event>();
  #requestedSuccessors = new WeakSet<MoreMenuPublication>();
  #unpublishedChangeRequested = false;
  #dispatchObserverPublication: MoreMenuPublication | null = null;
  #dispatchObserverRestorers: Array<readonly [EventTarget, () => boolean]> = [];
  #observedOutsideTargets = new WeakSet<EventTarget>();
  #unsafeDispatchTargets = new WeakSet<EventTarget>();

  constructor(private readonly requestSuccessor: () => void) {}

  active() {
    return this.#active;
  }

  allowsElementReplacement() {
    return this.#active === null;
  }

  publish(publication: MoreMenuPublication) {
    const previous = this.#active ?? this.#successorOf;
    this.#clearDispatchObservers();
    this.#active = publication;
    this.#successorOf = null;
    this.#unpublishedChangeRequested = false;
    const focus = this.#focusIntent;
    const focusTarget = focus && moreMenuFocusSuccessorIsExact(focus, publication)
      ? focus.target
      : null;
    if (focus) this.#clearFocus(focus);
    if (previous && previous !== publication) previous.dispose();
    this.#dispatchObserverPublication = publication;
    for (const item of Object.values(publication.dom.actions)) {
      if (!item) continue;
      if (this.#unsafeDispatchTargets.has(item)) {
        this.#clearDispatchObservers(publication);
        publication.retire();
        return false;
      }
      const restore = installMoreMenuDispatchObserver(
        publication.document.defaultView,
        item,
        (target, event) => this.observeDispatchedCustom(publication, target, event),
      );
      if (!restore) {
        this.#unsafeDispatchTargets.add(item);
        this.#clearDispatchObservers(publication);
        publication.retire();
        return false;
      }
      this.#dispatchObserverRestorers.push([item, restore]);
    }
    focusTarget?.focus();
    return true;
  }

  retire(publication: MoreMenuPublication) {
    if (this.#active !== publication) return false;
    this.#active = null;
    this.#successorOf = publication;
    if (this.#disclosureIntent?.publication === publication) this.#disclosureIntent = null;
    if (this.#selectionIntent?.publication === publication) {
      this.#selectionIntent = null;
      this.#dispatchedSelectionCustomEvent = null;
      this.#selectionCustomEvent = null;
    }
    queueMicrotask(() => {
      if (this.#active !== null || this.#successorOf !== publication) return;
      this.#successorOf = null;
      this.#clearDispatchObservers(publication);
      publication.dispose();
    });
    return true;
  }

  acceptsSuccessorOf(publication: MoreMenuPublication) {
    return this.#active === null && this.#successorOf === publication;
  }

  requestReplacement(publication: MoreMenuPublication) {
    if (
      !this.acceptsSuccessorOf(publication)
      || this.#requestedSuccessors.has(publication)
    ) {
      return;
    }
    this.#requestedSuccessors.add(publication);
    this.requestSuccessor();
  }

  elementChanged(
    owner: MoreMenuElementOwnerHandle,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) {
    const focus = this.#focusIntent;
    if (focus && previous === focus.target && element !== focus.target) this.#clearFocus(focus);
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

  claimDisclosure(events: readonly Event[]) {
    const unique = new Set(events);
    if (
      unique.size !== events.length
      || events.some((event) => this.#claimedEvents.has(event))
    ) {
      return false;
    }
    for (const event of events) this.#claimedEvents.add(event);
    return true;
  }

  publishDisclosure(
    publication: MoreMenuPublication,
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

  consumeDisclosure(publication: MoreMenuPublication, open: boolean) {
    const intent = this.#disclosureIntent;
    if (
      intent?.publication !== publication
      || intent.open !== open
      || this.#active !== publication
      || !publication.isExact()
      || !intent.events.some((event) =>
        isLiveMoreMenuNativeEvent(event, publication.document))
    ) {
      return null;
    }
    this.#disclosureIntent = null;
    return intent;
  }

  stageSelection(
    publication: MoreMenuPublication,
    action: MoreMenuAction,
    nativeEvent: MouseEvent,
    target: Node,
    path: readonly EventTarget[],
  ) {
    if (
      this.#active !== publication
      || this.#stagedNativeEvents.has(nativeEvent)
      || this.#claimedEvents.has(nativeEvent)
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
    ) {
      return false;
    }
    this.#stagedNativeEvents.add(nativeEvent);
    this.#dispatchedSelectionCustomEvent = null;
    this.#selectionCustomEvent = null;
    const intent = Object.freeze({
      publication,
      action,
      nativeEvent,
      target,
      path: Object.freeze([...path]),
    });
    this.#selectionIntent = intent;
    queueMicrotask(() => {
      if (this.#selectionIntent === intent) {
        this.#selectionIntent = null;
        this.#dispatchedSelectionCustomEvent = null;
        this.#selectionCustomEvent = null;
      }
    });
    return true;
  }

  observeDispatchedCustom(
    publication: MoreMenuPublication,
    dispatchTarget: EventTarget,
    customEvent: Event,
  ): MoreMenuDispatchCompletion | null {
    if (this.#active !== publication || !publication.isExact()) return null;
    const intent = this.#selectionIntent;
    const item = intent && publication.dom.actions[intent.action.name];
    if (
      intent
      && intent.publication === publication
      && item
      && dispatchTarget === item
      && exactMoreMenuUndispatchedSelect(publication, item, customEvent)
      && moreMenuNativeClickIsAtRadixSelection(
        publication,
        item,
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
    ) {
      const completeSelection: MoreMenuDispatchCompletion = (reachedTarget) => {
        if (
          !reachedTarget
          && this.#selectionIntent === intent
          && this.#dispatchedSelectionCustomEvent === customEvent
        ) {
          this.#selectionIntent = null;
          this.#dispatchedSelectionCustomEvent = null;
          this.#selectionCustomEvent = null;
        }
      };
      const dispatched = this.#dispatchedSelectionCustomEvent;
      if (dispatched) {
        if (dispatched === customEvent) return completeSelection;
        const ownerWindow = publication.document.defaultView;
        if (
          ownerWindow
          && nativeEventGetter<number>(
            ownerWindow.Event.prototype,
            "eventPhase",
            dispatched,
          ) !== ownerWindow.Event.NONE
        ) {
          return null;
        }
      }
      this.#dispatchedSelectionCustomEvent = customEvent;
      return completeSelection;
    }
    const outside = exactMoreMenuUndispatchedOutside(publication, customEvent);
    if (!outside || this.#taintedOutsideNativeEvents.has(outside.originalEvent)) return null;
    const ownerWindow = publication.document.defaultView;
    if (
      !ownerWindow
      || nativeEventGetter<EventTarget | null>(
        ownerWindow.Event.prototype,
        "target",
        outside.originalEvent,
      ) !== dispatchTarget
    ) {
      return null;
    }
    const completeOutside: MoreMenuDispatchCompletion = (reachedTarget) => {
      if (
        !reachedTarget
        && this.#dispatchedOutsideCustomEvents.get(outside.originalEvent) === customEvent
      ) {
        this.#taintedOutsideNativeEvents.add(outside.originalEvent);
        this.#dispatchedOutsideCustomEvents.delete(outside.originalEvent);
        this.#outsideCustomEvents.delete(outside.originalEvent);
      }
    };
    const dispatched = this.#dispatchedOutsideCustomEvents.get(outside.originalEvent);
    if (dispatched) {
      if (dispatched === customEvent) return completeOutside;
      const ownerWindow = publication.document.defaultView;
      if (
        ownerWindow
        && nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          dispatched,
        ) !== ownerWindow.Event.NONE
      ) {
        return null;
      }
    }
    this.#dispatchedOutsideCustomEvents.set(outside.originalEvent, customEvent);
    return completeOutside;
  }

  observeNativeOutsideTarget(publication: MoreMenuPublication, nativeEvent: Event) {
    if (
      this.#active !== publication
      || this.#dispatchObserverPublication !== publication
      || !publication.isExact()
    ) {
      return false;
    }
    const target = exactMoreMenuNativeOutsideAtCapture(publication, nativeEvent);
    if (!target || this.#observedOutsideTargets.has(target)) return Boolean(target);
    if (this.#unsafeDispatchTargets.has(target)) {
      publication.retire();
      return false;
    }
    const restore = installMoreMenuDispatchObserver(
      publication.document.defaultView,
      target,
      (dispatchTarget, event) =>
        this.observeDispatchedCustom(publication, dispatchTarget, event),
    );
    if (!restore) {
      this.#unsafeDispatchTargets.add(target);
      publication.retire();
      return false;
    }
    this.#observedOutsideTargets.add(target);
    this.#dispatchObserverRestorers.push([target, restore]);
    return true;
  }

  bindSelectionCustom(publication: MoreMenuPublication, customEvent: Event) {
    const intent = this.#selectionIntent;
    const item = intent && publication.dom.actions[intent.action.name];
    if (
      !intent
      || intent.publication !== publication
      || this.#active !== publication
      || !item
      || this.#dispatchedSelectionCustomEvent !== customEvent
      || !moreMenuNativeClickIsAtRadixSelection(
        publication,
        item,
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
      || !exactMoreMenuCustomSelectAtWindow(publication, item, customEvent)
    ) {
      return false;
    }
    if (this.#selectionCustomEvent) {
      if (this.#selectionCustomEvent === customEvent) return true;
      const ownerWindow = publication.document.defaultView;
      if (
        !ownerWindow
        || nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          this.#selectionCustomEvent,
        ) !== ownerWindow.Event.NONE
      ) {
        return false;
      }
    }
    this.#selectionCustomEvent = customEvent;
    return true;
  }

  consumeSelection(
    publication: MoreMenuPublication,
    action: MoreMenuAction,
    customEvent: Event,
  ) {
    const intent = this.#selectionIntent;
    if (
      intent?.publication !== publication
      || intent.action !== action
      || this.#active !== publication
      || this.#claimedPublications.has(publication)
      || this.#claimedActions.has(action)
      || this.#claimedEvents.has(customEvent)
      || this.#claimedEvents.has(intent.nativeEvent)
      || this.#selectionCustomEvent !== customEvent
      || !moreMenuNativeClickIsAtRadixSelection(
        publication,
        publication.dom.actions[action.name],
        intent.nativeEvent,
        intent.target,
        intent.path,
      )
      || !publication.isExact()
    ) {
      return null;
    }
    this.#selectionIntent = null;
    this.#dispatchedSelectionCustomEvent = null;
    this.#selectionCustomEvent = null;
    this.#claimedPublications.add(publication);
    this.#claimedActions.add(action);
    this.#claimedEvents.add(customEvent);
    this.#claimedEvents.add(intent.nativeEvent);
    return intent;
  }

  bindOutsideCustom(
    publication: MoreMenuPublication,
    customEvent: CustomEvent<{ originalEvent: Event }>,
  ) {
    if (
      this.#active !== publication
      || !publication.isExact()
    ) {
      return false;
    }
    const outside = exactMoreMenuOutside(publication, customEvent, "window");
    if (
      !outside
      || this.#dispatchedOutsideCustomEvents.get(outside.originalEvent) !== customEvent
    ) {
      return false;
    }
    const admitted = this.#outsideCustomEvents.get(outside.originalEvent);
    if (admitted) {
      if (admitted === customEvent) return true;
      const ownerWindow = publication.document.defaultView;
      if (
        ownerWindow
        && nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          admitted,
        ) !== ownerWindow.Event.NONE
      ) {
        return false;
      }
    }
    this.#outsideCustomEvents.set(outside.originalEvent, customEvent);
    return true;
  }

  claimOutsideCustom(
    publication: MoreMenuPublication,
    customEvent: CustomEvent<{ originalEvent: Event }>,
    originalEvent: Event,
  ) {
    if (
      this.#active !== publication
      || this.#outsideCustomEvents.get(originalEvent) !== customEvent
      || !this.claimDisclosure([customEvent, originalEvent])
    ) {
      return false;
    }
    this.#outsideCustomEvents.delete(originalEvent);
    this.#dispatchedOutsideCustomEvents.delete(originalEvent);
    return true;
  }

  #clearDispatchObservers(publication?: MoreMenuPublication) {
    if (
      publication
      && this.#dispatchObserverPublication !== publication
    ) {
      return;
    }
    for (const [target, restore] of this.#dispatchObserverRestorers.splice(0).reverse()) {
      if (!restore()) this.#unsafeDispatchTargets.add(target);
    }
    this.#dispatchObserverPublication = null;
    this.#observedOutsideTargets = new WeakSet<EventTarget>();
  }

  scheduleFocus(
    source: MoreMenuPublication,
    target: HTMLButtonElement,
    action: MoreMenuActionName | null,
    mode: EditMode = source.render.mode,
  ) {
    const previous = this.#focusIntent;
    if (previous) this.#clearFocus(previous);
    let pending: MoreMenuFocusIntent | null = null;
    const guard = createMoreMenuFocusGuard(source, target, () => {
      if (pending) this.#clearFocus(pending);
    });
    const intent: MoreMenuFocusIntent = Object.freeze({
      source,
      visit: source.render.visit,
      target,
      action,
      modes: Object.freeze(
        mode === source.render.mode ? [mode] : [source.render.mode, mode],
      ),
      guard,
    });
    pending = intent;
    this.#focusIntent = intent;
  }

  #clearFocus(intent: MoreMenuFocusIntent) {
    if (this.#focusIntent !== intent) return;
    this.#focusIntent = null;
    intent.guard.dispose();
  }
}

function createMoreMenuOwners(coordinator: MoreMenuPublicationCoordinator): MoreMenuOwners {
  const changed = <T extends HTMLElement>(
    owner: MoreMenuElementOwner<T>,
    element: T | null,
    previous: T | null,
  ) => coordinator.elementChanged(owner, element, previous);
  const accepts = <T extends HTMLElement>(tagName: string) => (element: T) =>
    element.tagName === tagName;
  const allowsReplacement = () => coordinator.allowsElementReplacement();
  const actionOwner = () =>
    new MoreMenuElementOwner<HTMLDivElement>(accepts("DIV"), allowsReplacement, changed);
  return Object.freeze({
    trigger: new MoreMenuElementOwner<HTMLButtonElement>(
      accepts("BUTTON"),
      allowsReplacement,
      changed,
    ),
    content: new MoreMenuElementOwner<HTMLDivElement>(
      accepts("DIV"),
      allowsReplacement,
      changed,
    ),
    actions: Object.freeze({
      history: actionOwner(),
      "name-version": actionOwner(),
      duplicate: actionOwner(),
      delete: actionOwner(),
    }),
  });
}

function snapshotMoreMenuDocument(document: DocumentDto) {
  return Object.freeze(
    Object.entries(document)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => Object.freeze([name, value] as const)),
  );
}

function moreMenuDocumentMatches(render: MoreMenuRender) {
  const fields = Object.entries(render.document)
    .sort(([left], [right]) => left.localeCompare(right));
  return (
    fields.length === render.documentFields.length
    && fields.every(([name, value], index) => {
      const expected = render.documentFields[index];
      return expected?.[0] === name && Object.is(expected[1], value);
    })
  );
}

function moreMenuBindings(props: HeaderProps): readonly unknown[] {
  return Object.freeze([
    props.onShare,
    props.onPublish,
    props.onPublishNow,
    props.onHistory,
    props.onMoreMenuOpen,
    props.onActivity,
    props.onShortcuts,
    props.onCommandPalette,
    props.onDelete,
    props.onDuplicate,
    props.onDownload,
    props.onCopyMarkdown,
    props.onNameVersion,
    props.onHome,
    props.compact,
    props.publishing,
    props.isOwner,
    props.githubConfigured,
  ]);
}

function moreMenuFactsAreCurrent(render: MoreMenuRender) {
  const {
    actions,
    document,
    props,
    session,
  } = render;
  const currentBindings = moreMenuBindings(props);
  const linked = document.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";
  const mutation = props.documentMutation;
  return (
    render.visit.session === session
    && render.visit.document === document
    && props.session === session
    && props.doc === document
    && session.docId === render.docId
    && session.role === render.role
    && session.mode === render.mode
    && session.setMode === render.setMode
    && linked === render.linked
    && canEdit === render.canEdit
    && props.compact === render.compact
    && props.isOwner === render.isOwner
    && props.githubConfigured === render.githubConfigured
    && props.publishing === render.publishing
    && mutation === render.documentMutation
    && currentBindings.length === render.bindings.length
    && currentBindings.every((value, index) => Object.is(value, render.bindings[index]))
    && moreMenuDocumentMatches(render)
    && actions.history.callback === props.onHistory
    && actions.history.eligible
    && actions.history.label === "Version history"
    && actions.history.testId === "menu-history"
    && actions.history.className === "menu-item"
    && actions.history.iconClassName === "lucide-rotate-ccw-clock"
    && !actions.history.busy
    && actions["name-version"].callback === props.onNameVersion
    && actions["name-version"].eligible === canEdit
    && actions["name-version"].label === "Name current version"
    && actions["name-version"].testId === null
    && actions["name-version"].className === "menu-item"
    && actions["name-version"].iconClassName === "lucide-pencil"
    && !actions["name-version"].busy
    && actions.duplicate.callback === props.onDuplicate
    && actions.duplicate.eligible === (mutation === null)
    && actions.duplicate.label === (mutation === "duplicate" ? "Making a copy…" : "Make a copy")
    && actions.duplicate.testId === "menu-duplicate"
    && actions.duplicate.className === "menu-item"
    && actions.duplicate.iconClassName === (mutation === "duplicate" ? "lucide-loader-circle" : "lucide-files")
    && actions.duplicate.busy === (mutation === "duplicate")
    && actions.delete.callback === props.onDelete
    && actions.delete.eligible === (props.isOwner && mutation === null)
    && actions.delete.label === (mutation === "delete" ? "Moving to trash…" : "Move to trash")
    && actions.delete.testId === "menu-delete"
    && actions.delete.className === "menu-item text-danger"
    && actions.delete.iconClassName === (mutation === "delete" ? "lucide-loader-circle" : "lucide-trash-2")
    && actions.delete.busy === (mutation === "delete")
  );
}

function moreMenuActionElementIsExact(
  render: MoreMenuRender,
  content: HTMLDivElement,
  action: MoreMenuAction,
  element: HTMLDivElement | null,
) {
  const shouldExist = action.name === "name-version"
    ? render.canEdit
    : action.name === "delete"
      ? render.isOwner
      : true;
  if (!shouldExist) return element === null;
  const ownerWindow = content.ownerDocument.defaultView;
  const disabled = action.name === "duplicate" || action.name === "delete"
    ? render.documentMutation !== null
    : false;
  if (
    !ownerWindow
    || !element
    || !(element instanceof ownerWindow.HTMLDivElement)
    || !element.isConnected
    || element.ownerDocument !== content.ownerDocument
    || element.parentElement !== content
    || element.getAttribute("role") !== "menuitem"
    || element.className !== action.className
    || element.textContent !== action.label
    || element.dataset.testid !== (action.testId ?? undefined)
    || (element.getAttribute("aria-disabled") === "true") !== disabled
    || element.hasAttribute("data-disabled") !== disabled
    || element.getAttribute("aria-busy") !== (action.busy ? "true" : null)
    || element.children.length !== 2
  ) {
    return false;
  }
  const iconBox = element.children.item(0);
  const label = element.children.item(1);
  const icon = iconBox?.firstElementChild;
  return Boolean(
    iconBox
    && iconBox.tagName === "SPAN"
    && iconBox.className === "flex h-4 w-4 items-center justify-center text-ink-3"
    && iconBox.children.length === 1
    && icon
    && icon.tagName.toLowerCase() === "svg"
    && icon.classList.contains(action.iconClassName)
    && icon.getAttribute("width") === "15"
    && icon.getAttribute("height") === "15"
    && icon.getAttribute("aria-hidden") === "true"
    && label
    && label.tagName === "SPAN"
    && label.className === "flex-1"
    && label.children.length === 0
    && label.textContent === action.label
  );
}

function currentMoreMenuDom(
  render: MoreMenuRender,
  owners: MoreMenuOwners,
): MoreMenuDom | null {
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
    || trigger.className !== "icon-btn"
    || trigger.getAttribute("aria-label") !== "More"
    || trigger.dataset.testid !== "more-menu"
    || trigger.getAttribute("aria-haspopup") !== "menu"
    || trigger.getAttribute("aria-expanded") !== String(render.open)
    || trigger.getAttribute("data-state") !== (render.open ? "open" : "closed")
    || trigger.children.length !== 1
    || !trigger.firstElementChild?.classList.contains("lucide-ellipsis-vertical")
  ) {
    return null;
  }

  const content = owners.content.element();
  const actions: Readonly<Record<MoreMenuActionName, HTMLDivElement | null>> = Object.freeze({
    history: owners.actions.history.element(),
    "name-version": owners.actions["name-version"].element(),
    duplicate: owners.actions.duplicate.element(),
    delete: owners.actions.delete.element(),
  });
  if (!render.open) {
    if (content || Object.values(actions).some(Boolean)) return null;
    return Object.freeze({ trigger, content: null, actions });
  }
  if (
    !content
    || !(content instanceof ownerWindow.HTMLDivElement)
    || !content.isConnected
    || content.ownerDocument !== ownerDocument
    || content.getAttribute("role") !== "menu"
    || content.getAttribute("data-state") !== "open"
    || content.getAttribute("data-align") !== "end"
    || !content.classList.contains("menu")
    || !content.classList.contains("w-64")
    || !Object.values(render.actions).every((action) =>
      moreMenuActionElementIsExact(render, content, action, actions[action.name]))
  ) {
    return null;
  }
  const ordered = [
    actions.history,
    ...(render.canEdit ? [actions["name-version"]] : []),
    actions.duplicate,
    ...(render.isOwner ? [actions.delete] : []),
  ];
  if (
    ordered.some((element) => !element)
    || ordered.some((element, index) => {
      const next = ordered[index + 1];
      return Boolean(next && element && next.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    })
  ) {
    return null;
  }
  return Object.freeze({ trigger, content, actions });
}

function moreMenuDomIsSame(current: MoreMenuDom, published: MoreMenuDom) {
  return (
    current.trigger === published.trigger
    && current.content === published.content
    && (Object.keys(current.actions) as MoreMenuActionName[]).every(
      (name) => current.actions[name] === published.actions[name],
    )
  );
}

function nativeEventGetter<T>(
  prototype: object,
  property: string,
  event: Event,
): T | undefined {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  if (!getter) return undefined;
  try {
    return Reflect.apply(getter, event, []) as T;
  } catch (error) {
    if (
      error instanceof TypeError
      || (
        typeof error === "object"
        && error !== null
        && Reflect.get(error, "name") === "TypeError"
      )
    ) {
      return undefined;
    }
    throw error;
  }
}

function nativeEventPath(ownerWindow: Window & typeof globalThis, event: Event) {
  try {
    return Object.freeze(
      Reflect.apply(ownerWindow.Event.prototype.composedPath, event, []) as EventTarget[],
    );
  } catch (error) {
    if (
      error instanceof TypeError
      || (
        typeof error === "object"
        && error !== null
        && Reflect.get(error, "name") === "TypeError"
      )
    ) {
      return Object.freeze([] as EventTarget[]);
    }
    throw error;
  }
}

type MoreMenuDispatchCompletion = (reachedTarget: boolean) => void;

const moreMenuGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const moreMenuDefineProperty = Object.defineProperty;
const moreMenuIsExtensible = Object.isExtensible;
const moreMenuDeleteProperty = Reflect.deleteProperty;
const MORE_MENU_DESCRIPTOR_FAILURE = Symbol("more-menu-descriptor-failure");

function moreMenuOwnDescriptor(target: object, property: PropertyKey) {
  try {
    return moreMenuGetOwnPropertyDescriptor(target, property);
  } catch {
    return MORE_MENU_DESCRIPTOR_FAILURE;
  }
}

function moreMenuDescriptorMatches(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor | undefined,
) {
  if (!current || !expected) return current === expected;
  if (
    current.configurable !== expected.configurable
    || current.enumerable !== expected.enumerable
  ) {
    return false;
  }
  if ("value" in expected || "writable" in expected) {
    return (
      "value" in current
      && current.value === expected.value
      && current.writable === expected.writable
    );
  }
  return (
    !("value" in current)
    && current.get === expected.get
    && current.set === expected.set
  );
}

function installMoreMenuDispatchObserver(
  ownerWindow: (Window & typeof globalThis) | null,
  target: EventTarget,
  observe: (target: EventTarget, event: Event) => MoreMenuDispatchCompletion | null,
) {
  if (!ownerWindow || !(target instanceof ownerWindow.EventTarget)) return null;
  const descriptor = moreMenuOwnDescriptor(target, "dispatchEvent");
  if (
    descriptor === MORE_MENU_DESCRIPTOR_FAILURE
    || (descriptor && !descriptor.configurable)
  ) {
    return null;
  }
  if (!descriptor) {
    try {
      if (!moreMenuIsExtensible(target)) return null;
    } catch {
      return null;
    }
  }
  const eventTargetPrototype = ownerWindow.EventTarget.prototype;
  const nativeDispatch = eventTargetPrototype.dispatchEvent;
  const nativeAdd = eventTargetPrototype.addEventListener;
  const nativeRemove = eventTargetPrototype.removeEventListener;
  const observedDispatch = function (this: EventTarget, event: Event) {
    const completion = this === target ? observe(target, event) : null;
    if (!completion) return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    let reachedTarget = false;
    const markTarget = (current: Event) => {
      if (current === event) reachedTarget = true;
    };
    const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
    if (!type) return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    Reflect.apply(nativeAdd, target, [type, markTarget, { capture: true }]);
    try {
      return Reflect.apply(nativeDispatch, this, [event]) as boolean;
    } finally {
      Reflect.apply(nativeRemove, target, [type, markTarget, { capture: true }]);
      completion(reachedTarget);
    }
  };
  const installedDescriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: false,
    value: observedDispatch,
    writable: true,
  };
  let restoredByObserver = false;
  const restoreObserved = () => {
    const current = moreMenuOwnDescriptor(target, "dispatchEvent");
    if (current === MORE_MENU_DESCRIPTOR_FAILURE) return false;
    if (restoredByObserver) return moreMenuDescriptorMatches(current, descriptor);
    if (!moreMenuDescriptorMatches(current, installedDescriptor)) {
      return false;
    }
    try {
      if (descriptor) moreMenuDefineProperty(target, "dispatchEvent", descriptor);
      else if (!moreMenuDeleteProperty(target, "dispatchEvent")) return false;
    } catch {
      return false;
    }
    const restored = moreMenuOwnDescriptor(target, "dispatchEvent");
    restoredByObserver = (
      restored !== MORE_MENU_DESCRIPTOR_FAILURE
      && moreMenuDescriptorMatches(restored, descriptor)
    );
    return restoredByObserver;
  };
  try {
    moreMenuDefineProperty(target, "dispatchEvent", installedDescriptor);
  } catch {
    return null;
  }
  const installed = moreMenuOwnDescriptor(target, "dispatchEvent");
  if (
    installed === MORE_MENU_DESCRIPTOR_FAILURE
    || !moreMenuDescriptorMatches(installed, installedDescriptor)
  ) {
    restoreObserved();
    return null;
  }
  return restoreObserved;
}

function exactMoreMenuUndispatchedSelect(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return false;
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event)
      === "menu.itemSelect"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) === null
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) === null
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.NONE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<unknown>(
      ownerWindow.CustomEvent.prototype,
      "detail",
      event,
    ) === null
    && nativeEventPath(ownerWindow, event).length === 0
    && item.ownerDocument === publication.document
    && item.isConnected
  );
}

function isLiveMoreMenuNativeEvent(event: Event, document: Document) {
  const ownerWindow = document.defaultView;
  return Boolean(
    ownerWindow
    && event instanceof ownerWindow.Event
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.NONE
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    )
  );
}

function exactMoreMenuNativeClick(
  publication: MoreMenuPublication,
  action: MoreMenuAction,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.MouseEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const button = nativeEventGetter<number>(
    ownerWindow.MouseEvent.prototype,
    "button",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const content = publication.dom.content;
  if (
    type !== "click"
    || button !== 0
    || bubbles !== true
    || cancelable !== true
    || defaultPrevented !== false
    || currentTarget !== item
    || (eventPhase !== ownerWindow.Event.CAPTURING_PHASE && eventPhase !== ownerWindow.Event.AT_TARGET)
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !item.contains(target)
    || !content
    || path[0] !== target
    || path.indexOf(item) < 0
    || path.indexOf(content) <= path.indexOf(item)
    || !publication.isExact()
  ) {
    return null;
  }
  return Object.freeze({
    nativeEvent: event,
    target,
    path,
    action,
  });
}

function moreMenuNativeClickIsAtRadixSelection(
  publication: MoreMenuPublication,
  item: HTMLElement | null,
  event: MouseEvent,
  admittedTarget: Node,
  admittedPath: readonly EventTarget[],
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (
    !ownerWindow
    || !item
    || !content
    || !(event instanceof ownerWindow.MouseEvent)
  ) {
    return false;
  }
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const bodyIndex = path.indexOf(publication.document.body);
  const documentIndex = path.indexOf(publication.document);
  const atReactDelegationBoundary = (
    currentTarget === publication.document.body
    || (
      currentTarget === publication.document
      && documentIndex === path.length - 2
      && path[path.length - 1] === ownerWindow
    )
  );
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event) === "click"
    && nativeEventGetter<number>(
      ownerWindow.MouseEvent.prototype,
      "button",
      event,
    ) === 0
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.BUBBLING_PHASE
    && target === admittedTarget
    && target instanceof ownerWindow.Node
    && target.ownerDocument === publication.document
    // Direct roots delegate portal clicks from body; a document-hydrated root delegates from document.
    && atReactDelegationBoundary
    && item.contains(target)
    && path.length === admittedPath.length
    && path.every((entry, index) => entry === admittedPath[index])
    && path[0] === target
    && path.indexOf(item) >= 0
    && path.indexOf(content) > path.indexOf(item)
    && bodyIndex > path.indexOf(content)
    && documentIndex > bodyIndex
  );
}

function exactMoreMenuCustomSelect(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return false;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const content = publication.dom.content;
  return Boolean(
    type === "menu.itemSelect"
    && target === item
    && currentTarget === item
    && eventPhase === ownerWindow.Event.AT_TARGET
    && bubbles === true
    && cancelable === true
    && defaultPrevented === false
    && detail === null
    && content
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && publication.isExact()
  );
}

function exactMoreMenuCustomSelectAtWindow(
  publication: MoreMenuPublication,
  item: HTMLDivElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return false;
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event)
      === "menu.itemSelect"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) === item
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) instanceof ownerWindow.Window
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.CAPTURING_PHASE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && nativeEventGetter<unknown>(
      ownerWindow.CustomEvent.prototype,
      "detail",
      event,
    ) === null
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && path.indexOf(publication.document) > path.indexOf(content)
    && path[path.length - 1] === nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    )
    && path.indexOf(publication.document) < path.length - 1
    && publication.isExact()
  );
}

function exactMoreMenuGenericNativeClick(
  publication: MoreMenuPublication,
  event: Event,
): MoreMenuGenericSelectionIntent | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.MouseEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const button = nativeEventGetter<number>(
    ownerWindow.MouseEvent.prototype,
    "button",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  const contentIndex = path.indexOf(content);
  const item = path.slice(0, contentIndex).find((candidate): candidate is HTMLElement => (
    candidate instanceof ownerWindow.HTMLElement
    && ["menuitem", "menuitemradio", "menuitemcheckbox"].includes(
      candidate.getAttribute("role") ?? "",
    )
  ));
  if (
    type !== "click"
    || button !== 0
    || bubbles !== true
    || cancelable !== true
    || defaultPrevented !== false
    || currentTarget !== content
    || eventPhase !== ownerWindow.Event.CAPTURING_PHASE
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || contentIndex < 1
    || !item
    || item.ownerDocument !== publication.document
    || !item.isConnected
    || !item.contains(target)
    || path[0] !== target
    || path.indexOf(item) < 0
    || !publication.isExact()
  ) {
    return null;
  }
  return Object.freeze({
    nativeEvent: event,
    target,
    item,
    path,
  });
}

function exactMoreMenuGenericCustomSelect(
  publication: MoreMenuPublication,
  item: HTMLElement,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return false;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const eventPhase = nativeEventGetter<number>(
    ownerWindow.Event.prototype,
    "eventPhase",
    event,
  );
  const bubbles = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "bubbles",
    event,
  );
  const cancelable = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "cancelable",
    event,
  );
  const defaultPrevented = nativeEventGetter<boolean>(
    ownerWindow.Event.prototype,
    "defaultPrevented",
    event,
  );
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    type === "menu.itemSelect"
    && target === item
    && currentTarget === content
    && eventPhase === ownerWindow.Event.CAPTURING_PHASE
    && bubbles === true
    && cancelable === true
    && defaultPrevented === false
    && detail === null
    && path[0] === item
    && path.indexOf(content) > path.indexOf(item)
    && publication.isExact()
  );
}

function moreMenuModeForGenericSelection(
  publication: MoreMenuPublication,
  item: HTMLElement,
): EditMode {
  if (!publication.render.compact || item.getAttribute("role") !== "menuitemradio") {
    return publication.render.mode;
  }
  const group = item.parentElement;
  const rows = group ? Array.from(group.children) : [];
  const modes = ["editing", "suggesting", "viewing"] as const;
  const labels = ["Editing", "Suggesting", "Viewing"] as const;
  const index = rows.indexOf(item);
  if (
    group?.getAttribute("role") !== "group"
    || rows.length !== modes.length
    || index < 0
    || !rows.every((row, rowIndex) => (
      row.getAttribute("role") === "menuitemradio"
      && row.lastElementChild?.tagName === "SPAN"
      && row.lastElementChild.className === "flex flex-col"
      && row.lastElementChild.children.length === 1
      && row.lastElementChild.firstElementChild?.tagName === "SPAN"
      && row.lastElementChild.firstElementChild.attributes.length === 0
      && row.lastElementChild.firstElementChild.textContent === labels[rowIndex]
    ))
  ) {
    return publication.render.mode;
  }
  return modes[index] ?? publication.render.mode;
}

function exactMoreMenuEscape(
  publication: MoreMenuPublication,
  event: KeyboardEvent,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.KeyboardEvent)) return false;
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  return Boolean(
    nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event) === "keydown"
    && nativeEventGetter<string>(
      ownerWindow.KeyboardEvent.prototype,
      "key",
      event,
    ) === "Escape"
    && nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) === publication.document
    && nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) === ownerWindow.Event.CAPTURING_PHASE
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) === true
    && nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) === false
    && target instanceof ownerWindow.Node
    && target.ownerDocument === publication.document
    && content.contains(target)
    && path[0] === target
    && path.indexOf(content) >= 0
    && path.indexOf(publication.document) > path.indexOf(content)
  );
}

interface ExactMoreMenuOutside {
  readonly originalEvent: Event;
  readonly rightClick: boolean;
}

function moreMenuOutsideOriginalEvent(
  ownerWindow: Window & typeof globalThis,
  event: CustomEvent<{ originalEvent: Event }>,
) {
  const detail = nativeEventGetter<unknown>(
    ownerWindow.CustomEvent.prototype,
    "detail",
    event,
  );
  if (
    typeof detail !== "object"
    || detail === null
    || Reflect.ownKeys(detail).length !== 1
  ) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(detail, "originalEvent");
  return descriptor && "value" in descriptor && descriptor.value instanceof ownerWindow.Event
    ? descriptor.value
    : null;
}

function exactMoreMenuNativeOutsideAtCapture(
  publication: MoreMenuPublication,
  event: Event,
) {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.Event)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const pointerOutside = type === "pointerdown" && event instanceof ownerWindow.PointerEvent;
  const focusOutside = type === "focusin" && event instanceof ownerWindow.FocusEvent;
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const path = nativeEventPath(ownerWindow, event);
  if (
    (!pointerOutside && !focusOutside)
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.CAPTURING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || path[0] !== target
    || path.indexOf(publication.document) < 0
  ) {
    return null;
  }
  if (pointerOutside) {
    const button = nativeEventGetter<number>(
      ownerWindow.MouseEvent.prototype,
      "button",
      event,
    );
    const ctrlKey = nativeEventGetter<boolean>(
      ownerWindow.MouseEvent.prototype,
      "ctrlKey",
      event,
    );
    if (button === undefined || ctrlKey === undefined) return null;
  }
  return target;
}

function exactMoreMenuUndispatchedOutside(
  publication: MoreMenuPublication,
  event: Event,
): ExactMoreMenuOutside | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  if (
    type !== "dismissableLayer.pointerDownOutside"
    && type !== "dismissableLayer.focusOutside"
  ) {
    return null;
  }
  const originalEvent = moreMenuOutsideOriginalEvent(
    ownerWindow,
    event as CustomEvent<{ originalEvent: Event }>,
  );
  if (!originalEvent) return null;
  const originalType = nativeEventGetter<string>(
    ownerWindow.Event.prototype,
    "type",
    originalEvent,
  );
  const pointerOutside = (
    type === "dismissableLayer.pointerDownOutside"
    && originalType === "pointerdown"
    && originalEvent instanceof ownerWindow.PointerEvent
  );
  const focusOutside = (
    type === "dismissableLayer.focusOutside"
    && originalType === "focusin"
    && originalEvent instanceof ownerWindow.FocusEvent
  );
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    originalEvent,
  );
  const originalPath = nativeEventPath(ownerWindow, originalEvent);
  if (
    (!pointerOutside && !focusOutside)
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
      event,
    ) !== null
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      event,
    ) !== null
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      event,
    ) !== ownerWindow.Event.NONE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || nativeEventPath(ownerWindow, event).length !== 0
    || nativeEventGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
      originalEvent,
    ) !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      originalEvent,
    ) !== ownerWindow.Event.BUBBLING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      originalEvent,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      originalEvent,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      originalEvent,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || originalPath[0] !== target
    || originalPath.indexOf(publication.document) < 0
  ) {
    return null;
  }
  const button = pointerOutside
    ? nativeEventGetter<number>(
        ownerWindow.MouseEvent.prototype,
        "button",
        originalEvent,
      )
    : undefined;
  const ctrlKey = pointerOutside
    ? nativeEventGetter<boolean>(
        ownerWindow.MouseEvent.prototype,
        "ctrlKey",
        originalEvent,
      )
    : undefined;
  if (pointerOutside && (button === undefined || ctrlKey === undefined)) return null;
  return Object.freeze({
    originalEvent,
    rightClick: pointerOutside && (button === 2 || (button === 0 && ctrlKey === true)),
  });
}

function exactMoreMenuOutside(
  publication: MoreMenuPublication,
  event: CustomEvent<{ originalEvent: Event }>,
  boundary: "window" | "target" = "target",
): ExactMoreMenuOutside | null {
  const ownerWindow = publication.document.defaultView;
  const content = publication.dom.content;
  const trigger = publication.dom.trigger;
  if (!ownerWindow || !content || !(event instanceof ownerWindow.CustomEvent)) return null;
  const originalEvent = moreMenuOutsideOriginalEvent(ownerWindow, event);
  if (!originalEvent) return null;
  const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
  const target = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    event,
  );
  const currentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    event,
  );
  const originalType = nativeEventGetter<string>(
    ownerWindow.Event.prototype,
    "type",
    originalEvent,
  );
  const originalTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "target",
    originalEvent,
  );
  const originalCurrentTarget = nativeEventGetter<EventTarget | null>(
    ownerWindow.Event.prototype,
    "currentTarget",
    originalEvent,
  );
  const path = nativeEventPath(ownerWindow, event);
  const originalPath = nativeEventPath(ownerWindow, originalEvent);
  const pointerOutside = (
    type === "dismissableLayer.pointerDownOutside"
    && originalType === "pointerdown"
    && originalEvent instanceof ownerWindow.PointerEvent
  );
  const focusOutside = (
    type === "dismissableLayer.focusOutside"
    && originalType === "focusin"
    && originalEvent instanceof ownerWindow.FocusEvent
  );
  const exactCustomBoundary = boundary === "window"
    ? currentTarget instanceof ownerWindow.Window
      && currentTarget === path[path.length - 1]
      && nativeEventGetter<number>(
        ownerWindow.Event.prototype,
        "eventPhase",
        event,
      ) === ownerWindow.Event.CAPTURING_PHASE
    : currentTarget === target
      && nativeEventGetter<number>(
        ownerWindow.Event.prototype,
        "eventPhase",
        event,
      ) === ownerWindow.Event.AT_TARGET;
  if (
    (!pointerOutside && !focusOutside)
    || target !== originalTarget
    || !exactCustomBoundary
    || originalCurrentTarget !== publication.document
    || nativeEventGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
      originalEvent,
    ) !== ownerWindow.Event.BUBBLING_PHASE
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      event,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      event,
    ) !== false
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
      originalEvent,
    ) !== true
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
      originalEvent,
    ) !== pointerOutside
    || nativeEventGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
      originalEvent,
    ) !== false
    || !(target instanceof ownerWindow.Node)
    || target.ownerDocument !== publication.document
    || !target.isConnected
    || content.contains(target)
    || trigger.contains(target)
    || path.length !== originalPath.length
    || !path.every((entry, index) => entry === originalPath[index])
    || path[0] !== target
    || path.indexOf(publication.document) < 0
    || !(path[path.length - 1] instanceof ownerWindow.Window)
    || path.indexOf(publication.document) >= path.length - 1
  ) {
    return null;
  }
  const button = pointerOutside
    ? nativeEventGetter<number>(
        ownerWindow.MouseEvent.prototype,
        "button",
        originalEvent,
      )
    : undefined;
  const ctrlKey = pointerOutside
    ? nativeEventGetter<boolean>(
        ownerWindow.MouseEvent.prototype,
        "ctrlKey",
        originalEvent,
      )
    : undefined;
  if (pointerOutside && (button === undefined || ctrlKey === undefined)) return null;
  return Object.freeze({
    originalEvent,
    rightClick: pointerOutside && (button === 2 || (button === 0 && ctrlKey === true)),
  });
}

function createMoreMenuFocusGuard(
  source: MoreMenuPublication,
  target: HTMLButtonElement,
  onInvalidated: () => void,
): MoreMenuFocusGuard {
  const placement = Object.freeze({
    node: target,
    parent: target.parentNode,
    previousSibling: target.previousSibling,
    nextSibling: target.nextSibling,
  });
  const Observer = source.document.defaultView?.MutationObserver;
  const initialDynamicAttributes = new Map(
    ["data-radix-popper-align", "data-radix-popper-side"].map(
      (name) => [name, target.getAttribute(name)],
    ),
  );
  const records: MutationRecord[] = [];
  let observer: MutationObserver | null = null;
  let invalid = false;
  const inspect = (pending: readonly MutationRecord[]) => {
    if (!invalid) records.push(...pending);
  };
  if (Observer) {
    observer = new Observer(inspect);
    observer.observe(target, {
      attributeOldValue: true,
      attributes: true,
      characterDataOldValue: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    if (placement.parent) observer.observe(placement.parent, { childList: true });
  }
  const expected = (
    record: MutationRecord,
    publication: MoreMenuPublication,
  ) => {
    if (record.target === target || target.contains(record.target)) {
      if (record.type !== "attributes" || record.target !== target) return false;
      if (record.attributeName === "aria-expanded") {
        return record.oldValue === "true" && target.getAttribute("aria-expanded") === "false";
      }
      if (record.attributeName === "aria-controls") {
        return Boolean(
          source.dom.content?.id
          && record.oldValue === source.dom.content.id
          && target.getAttribute("aria-controls") === null
        );
      }
      if (record.attributeName === "data-state") {
        return record.oldValue === "open" && target.getAttribute("data-state") === "closed";
      }
      if (record.attributeName && initialDynamicAttributes.has(record.attributeName)) {
        return (
          record.oldValue === initialDynamicAttributes.get(record.attributeName)
          && target.getAttribute(record.attributeName) === null
        );
      }
      return false;
    }
    return record.type === "childList"
      && record.target === placement.parent
      && record.previousSibling !== target
      && record.nextSibling !== target
      && [...record.addedNodes, ...record.removedNodes].every(
        (node) => node !== target && !node.contains(target),
      )
      && publication.document === source.document;
  };
  return Object.freeze({
    isExact: (publication: MoreMenuPublication) => {
      if (observer) inspect(observer.takeRecords());
      if (!records.every((record) => expected(record, publication))) {
        invalid = true;
        onInvalidated();
      }
      return (
        !invalid
        && target.isConnected
        && modeSwitcherPlacementMatches(placement)
        && publication.dom.trigger === target
        && publication.isExact()
      );
    },
    dispose: () => {
      observer?.disconnect();
      observer = null;
    },
  });
}

function moreMenuFocusSuccessorIsExact(
  intent: MoreMenuFocusIntent,
  publication: MoreMenuPublication,
) {
  const before = intent.source.render;
  const after = publication.render;
  const allowedMutation = intent.action === "duplicate"
    ? after.documentMutation === null || after.documentMutation === "duplicate"
    : intent.action === "delete"
      ? after.documentMutation === null || after.documentMutation === "delete"
      : after.documentMutation === before.documentMutation;
  return (
    before.open
    && !after.open
    && after.visit === intent.visit
    && after.session === before.session
    && after.document === before.document
    && after.docId === before.docId
    && after.role === before.role
    && intent.modes.includes(after.mode)
    && after.setMode === before.setMode
    && after.compact === before.compact
    && after.linked === before.linked
    && after.canEdit === before.canEdit
    && after.isOwner === before.isOwner
    && after.githubConfigured === before.githubConfigured
    && after.publishing === before.publishing
    && allowedMutation
    && after.bindings.length === before.bindings.length
    && after.bindings.every((value, index) => Object.is(value, before.bindings[index]))
    && publication.document === intent.source.document
    && publication.dom.trigger === intent.target
    && intent.target.ownerDocument === publication.document
    && intent.guard.isExact(publication)
  );
}

function createMoreMenuPresentation({
  render,
  coordinator,
  owners,
  commitOpen,
}: {
  render: MoreMenuRender;
  coordinator: MoreMenuPublicationCoordinator;
  owners: MoreMenuOwners;
  commitOpen: (state: MoreMenuState) => void;
}): MoreMenuPresentation {
  const runtimeState: {
    current: MoreMenuPublicationRuntime | null;
    last: MoreMenuPublicationRuntime | null;
  } = { current: null, last: null };

  const createRuntime = (dom: MoreMenuDom): MoreMenuPublicationRuntime => {
    type Retirement = "element" | "layout" | "mutation" | "other";
    const triggerSnapshot = snapshotModeSwitcherDom(dom.trigger);
    const contentSnapshot = dom.content ? snapshotModeSwitcherDom(dom.content) : null;
    const placements = snapshotModeSwitcherPlacement(
      dom.content ? [dom.trigger, dom.content] : [dom.trigger],
    );
    const placementNodes = new Set(placements.map(({ node }) => node));
    const expectedOwners = new Map<MoreMenuElementOwnerHandle, HTMLElement>([
      [owners.trigger, dom.trigger],
    ]);
    if (dom.content) {
      expectedOwners.set(owners.content, dom.content);
      for (const action of Object.values(render.actions)) {
        const element = dom.actions[action.name];
        if (element) expectedOwners.set(owners.actions[action.name], element);
      }
    }
    const detached = new Set<MoreMenuElementOwnerHandle>();
    const reattached = new Set<MoreMenuElementOwnerHandle>();
    const listeners: Array<readonly [HTMLDivElement, (event: Event) => void]> = [];
    let genericSelection: MoreMenuGenericSelectionIntent | null = null;
    let genericClickListener: ((event: Event) => void) | null = null;
    let genericSelectListener: ((event: Event) => void) | null = null;
    let selectionCustomListener: ((event: Event) => void) | null = null;
    let outsideCustomListener: ((event: Event) => void) | null = null;
    let nativeOutsideListener: ((event: Event) => void) | null = null;
    let blurListener: ((event: Event) => void) | null = null;
    let replayInvalid = false;
    let retired = false;
    let retirement: Retirement | null = null;
    let mutationSeen = false;
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
        if (retire("mutation")) coordinator.requestReplacement(publication);
      }
    }
    const historyIsClean = () => {
      if (observer) inspectMutations(observer.takeRecords());
      return !mutationSeen;
    };
    const recordElementChange = (
      owner: MoreMenuElementOwnerHandle,
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
    const publication: MoreMenuPublication = Object.freeze({
      render,
      document: dom.trigger.ownerDocument,
      dom,
      triggerSnapshot,
      contentSnapshot,
      placements,
      isExact: () => {
        if (!historyIsClean() || !moreMenuFactsAreCurrent(render)) return false;
        const current = currentMoreMenuDom(render, owners);
        return Boolean(
          current
          && moreMenuDomIsSame(current, dom)
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
        for (const [item, listener] of listeners) {
          item.removeEventListener("click", listener, { capture: true });
        }
        listeners.length = 0;
        if (dom.content && genericClickListener && genericSelectListener) {
          dom.content.removeEventListener("click", genericClickListener, { capture: true });
          dom.content.removeEventListener(
            "menu.itemSelect",
            genericSelectListener,
            { capture: true },
          );
        }
        if (selectionCustomListener) {
          publication.document.defaultView?.removeEventListener(
            "menu.itemSelect",
            selectionCustomListener,
            { capture: true },
          );
        }
        if (outsideCustomListener) {
          publication.document.defaultView?.removeEventListener(
            "dismissableLayer.pointerDownOutside",
            outsideCustomListener,
            { capture: true },
          );
          publication.document.defaultView?.removeEventListener(
            "dismissableLayer.focusOutside",
            outsideCustomListener,
            { capture: true },
          );
        }
        if (nativeOutsideListener) {
          publication.document.removeEventListener("pointerdown", nativeOutsideListener, {
            capture: true,
          });
          publication.document.removeEventListener("focusin", nativeOutsideListener, {
            capture: true,
          });
        }
        const ownerWindow = publication.document.defaultView;
        if (ownerWindow && blurListener) ownerWindow.removeEventListener("blur", blurListener);
        genericClickListener = null;
        genericSelectListener = null;
        selectionCustomListener = null;
        outsideCustomListener = null;
        nativeOutsideListener = null;
        blurListener = null;
        genericSelection = null;
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
    const runtime: MoreMenuPublicationRuntime = Object.freeze({
      publication,
      retireForLayout: () => {
        retire(mutationSeen ? "mutation" : "layout");
      },
      isExactLayoutReplay: () => (
        retired
        && retirement === "layout"
        && publication.isExact()
      ),
    });
    const Observer = publication.document.defaultView?.MutationObserver;
    if (Observer) {
      observer = new Observer(inspectMutations);
      observer.observe(dom.trigger, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (let ancestor = dom.trigger.parentNode; ancestor; ancestor = ancestor.parentNode) {
        observer.observe(ancestor, { childList: true });
      }
      if (dom.content) {
        observer.observe(dom.content, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        for (let ancestor = dom.content.parentNode; ancestor; ancestor = ancestor.parentNode) {
          observer.observe(ancestor, { childList: true });
        }
      }
    }
    selectionCustomListener = (event: Event) => {
      coordinator.bindSelectionCustom(publication, event);
    };
    outsideCustomListener = (event: Event) => {
      const ownerWindow = publication.document.defaultView;
      if (!ownerWindow || !(event instanceof ownerWindow.CustomEvent)) return;
      coordinator.bindOutsideCustom(
        publication,
        event as CustomEvent<{ originalEvent: Event }>,
      );
    };
    nativeOutsideListener = (event: Event) => {
      coordinator.observeNativeOutsideTarget(publication, event);
    };
    publication.document.defaultView?.addEventListener(
      "menu.itemSelect",
      selectionCustomListener,
      { capture: true },
    );
    publication.document.defaultView?.addEventListener(
      "dismissableLayer.pointerDownOutside",
      outsideCustomListener,
      { capture: true },
    );
    publication.document.defaultView?.addEventListener(
      "dismissableLayer.focusOutside",
      outsideCustomListener,
      { capture: true },
    );
    publication.document.addEventListener("pointerdown", nativeOutsideListener, {
      capture: true,
    });
    publication.document.addEventListener("focusin", nativeOutsideListener, {
      capture: true,
    });
    if (dom.content) {
      genericClickListener = (event: Event) => {
        const admission = exactMoreMenuGenericNativeClick(publication, event);
        if (
          !admission
          || Object.values(dom.actions).some((element) => element === admission.item)
        ) {
          return;
        }
        genericSelection = admission;
        queueMicrotask(() => {
          if (genericSelection === admission) genericSelection = null;
        });
      };
      genericSelectListener = (event: Event) => {
        const admission = genericSelection;
        if (
          !admission
          || coordinator.active() !== publication
          || !moreMenuNativeClickIsAtRadixSelection(
            publication,
            admission.item,
            admission.nativeEvent,
            admission.target,
            admission.path,
          )
          || !exactMoreMenuGenericCustomSelect(publication, admission.item, event)
          || !coordinator.claimDisclosure([admission.nativeEvent, event])
        ) {
          return;
        }
        genericSelection = null;
        close(
          publication,
          true,
          null,
          moreMenuModeForGenericSelection(publication, admission.item),
        );
      };
      dom.content.addEventListener("click", genericClickListener, { capture: true });
      dom.content.addEventListener(
        "menu.itemSelect",
        genericSelectListener,
        { capture: true },
      );
    }
    const ownerWindow = publication.document.defaultView;
    if (ownerWindow && render.open) {
      blurListener = (event: Event) => {
        const type = nativeEventGetter<string>(ownerWindow.Event.prototype, "type", event);
        const target = nativeEventGetter<EventTarget | null>(
          ownerWindow.Event.prototype,
          "target",
          event,
        );
        const currentTarget = nativeEventGetter<EventTarget | null>(
          ownerWindow.Event.prototype,
          "currentTarget",
          event,
        );
        const eventPhase = nativeEventGetter<number>(
          ownerWindow.Event.prototype,
          "eventPhase",
          event,
        );
        const bubbles = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "bubbles",
          event,
        );
        const cancelable = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "cancelable",
          event,
        );
        const defaultPrevented = nativeEventGetter<boolean>(
          ownerWindow.Event.prototype,
          "defaultPrevented",
          event,
        );
        const path = nativeEventPath(ownerWindow, event);
        if (
          type !== "blur"
          || !target
          || target !== currentTarget
          || path.length !== 1
          || path[0] !== target
          || eventPhase !== ownerWindow.Event.AT_TARGET
          || bubbles !== false
          || cancelable !== false
          || defaultPrevented !== false
          || !isLiveMoreMenuNativeEvent(event, publication.document)
          || coordinator.active() !== publication
          || !publication.isExact()
          || !coordinator.claimDisclosure([event])
        ) {
          return;
        }
        close(publication);
      };
      ownerWindow.addEventListener("blur", blurListener);
    }
    for (const action of Object.values(render.actions)) {
      const item = dom.actions[action.name];
      if (!item) continue;
      const listener = (event: Event) => {
        if (
          coordinator.active() !== publication
          || publication.render !== render
          || !action.eligible
        ) {
          return;
        }
        const admission = exactMoreMenuNativeClick(publication, action, item, event);
        if (!admission || !(admission.nativeEvent instanceof MouseEvent)) return;
        coordinator.stageSelection(
          publication,
          action,
          admission.nativeEvent,
          admission.target,
          admission.path,
        );
      };
      item.addEventListener("click", listener, { capture: true });
      listeners.push(Object.freeze([item, listener] as const));
    }
    return runtime;
  };

  const currentPublication = () => {
    const runtime = runtimeState.current;
    const publication = runtime?.publication;
    return runtime
      && publication
      && coordinator.active() === publication
      && publication.render === render
      && publication.isExact()
      ? publication
      : null;
  };
  function close(
    publication: MoreMenuPublication,
    returnFocus = true,
    action: MoreMenuActionName | null = null,
    mode: EditMode = publication.render.mode,
  ) {
    if (
      !render.open
      || coordinator.active() !== publication
      || !publication.isExact()
      || !publication.retire()
    ) {
      return false;
    }
    if (returnFocus) {
      coordinator.scheduleFocus(publication, publication.dom.trigger, action, mode);
    }
    commitOpen(Object.freeze({ visit: render.visit, open: false }));
    return true;
  }
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
      || !isLiveMoreMenuNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claimDisclosure([nativeEvent])
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
      || !isLiveMoreMenuNativeEvent(nativeEvent, publication.document)
      || !nativeEvent.composedPath().includes(trigger)
      || !coordinator.claimDisclosure([nativeEvent])
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
    if (!publication || !intent || render.open === open) return;
    if (open) {
      if (!publication.retire()) return;
      commitOpen(Object.freeze({ visit: render.visit, open: true }));
      render.props.onMoreMenuOpen?.();
    } else {
      close(publication, intent.returnFocus);
    }
  };
  const select = (action: MoreMenuAction, event: Event) => {
    const publication = currentPublication();
    const item = publication?.dom.actions[action.name];
    if (
      !publication
      || !item
      || !action.eligible
      || !exactMoreMenuCustomSelect(publication, item, event)
    ) {
      return;
    }
    const intent = coordinator.consumeSelection(publication, action, event);
    if (
      !intent
      || intent.target.ownerDocument !== publication.document
      || intent.path[0] !== intent.target
      || intent.path.indexOf(item) < 0
      || !close(publication, true, action.name)
    ) {
      return;
    }
    action.callback();
  };
  const onEscapeKeyDown = (event: KeyboardEvent) => {
    const publication = currentPublication();
    if (
      !publication
      || !exactMoreMenuEscape(publication, event)
      || !coordinator.claimDisclosure([event])
    ) {
      return;
    }
    coordinator.publishDisclosure(publication, false, [event]);
  };
  const onOutside = (event: CustomEvent<{ originalEvent: Event }>) => {
    const publication = currentPublication();
    const outside = publication && exactMoreMenuOutside(publication, event);
    if (
      !publication
      || !outside
      || !coordinator.claimOutsideCustom(
        publication,
        event,
        outside.originalEvent,
      )
    ) {
      return;
    }
    coordinator.publishDisclosure(
      publication,
      false,
      [event, outside.originalEvent],
      !outside.rightClick,
    );
  };
  function establish() {
    if (
      (runtimeState.last && !runtimeState.last.isExactLayoutReplay())
      || !moreMenuFactsAreCurrent(render)
    ) {
      return undefined;
    }
    const dom = currentMoreMenuDom(render, owners);
    if (!dom) return undefined;
    const runtime = createRuntime(dom);
    runtimeState.current = runtime;
    runtimeState.last = runtime;
    coordinator.publish(runtime.publication);
    return runtime.retireForLayout;
  }
  return Object.freeze({
    captureTrigger: owners.trigger.capture,
    captureContent: owners.content.capture,
    captureHistory: owners.actions.history.capture,
    captureNameVersion: owners.actions["name-version"].capture,
    captureDuplicate: owners.actions.duplicate.capture,
    captureDelete: owners.actions.delete.capture,
    establish,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onOpenChange,
    onHistorySelect: (event: Event) => select(render.actions.history, event),
    onNameVersionSelect: (event: Event) => select(render.actions["name-version"], event),
    onDuplicateSelect: (event: Event) => select(render.actions.duplicate, event),
    onDeleteSelect: (event: Event) => select(render.actions.delete, event),
    onEscapeKeyDown,
    onOutside,
    onCloseAutoFocus: (event: Event) => event.preventDefault(),
  });
}

function MoreMenuOpenCommit({ presentation }: { presentation: MoreMenuPresentation }) {
  useLayoutEffect(() => presentation.establish(), [presentation]);
  return null;
}

export const Header = memo(function Header(props: HeaderProps) {
  const { session, doc, compact, githubConfigured, embed = false, keepAgentNonce = 0 } = props;
  const openComments = useSessionValue(session, (s) => s.comments.list().filter((c) => !c.resolved).length);
  const linked = doc.storage !== "local";
  const canEdit = session.role === "owner" || session.role === "editor";
  const [moreMenuMount] = useState(() => Symbol("document more menu"));
  const [, setMoreMenuPublicationRevision] = useState(0);
  const [moreMenuCoordinator] = useState(
    () => new MoreMenuPublicationCoordinator(
      () => setMoreMenuPublicationRevision((revision) => revision + 1),
    ),
  );
  const [moreMenuOwners] = useState(() => createMoreMenuOwners(moreMenuCoordinator));
  const moreMenuVisit = useMemo<MoreMenuVisit>(
    () => Object.freeze({ mount: moreMenuMount, session, document: doc }),
    [doc, moreMenuMount, session],
  );
  const initialMoreMenuState = useMemo<MoreMenuState>(
    () => Object.freeze({ visit: moreMenuVisit, open: false }),
    [moreMenuVisit],
  );
  const [storedMoreMenuState, setStoredMoreMenuState] = useState(initialMoreMenuState);
  const moreMenuState = storedMoreMenuState.visit === moreMenuVisit
    ? storedMoreMenuState
    : initialMoreMenuState;
  const moreMenuRender: MoreMenuRender = Object.freeze({
    identity: Object.freeze({}),
    visit: moreMenuVisit,
    props,
    session,
    document: doc,
    documentFields: snapshotMoreMenuDocument(doc),
    bindings: moreMenuBindings(props),
    docId: doc.id,
    role: session.role,
    mode: session.mode,
    setMode: session.setMode,
    compact,
    linked,
    canEdit,
    isOwner: props.isOwner,
    githubConfigured,
    publishing: props.publishing,
    documentMutation: props.documentMutation,
    open: moreMenuState.open,
    actions: Object.freeze({
      history: Object.freeze({
        name: "history",
        callback: props.onHistory,
        eligible: true,
        label: "Version history",
        testId: "menu-history",
        className: "menu-item",
        iconClassName: "lucide-rotate-ccw-clock",
        busy: false,
      }),
      "name-version": Object.freeze({
        name: "name-version",
        callback: props.onNameVersion,
        eligible: canEdit,
        label: "Name current version",
        testId: null,
        className: "menu-item",
        iconClassName: "lucide-pencil",
        busy: false,
      }),
      duplicate: Object.freeze({
        name: "duplicate",
        callback: props.onDuplicate,
        eligible: props.documentMutation === null,
        label: props.documentMutation === "duplicate" ? "Making a copy…" : "Make a copy",
        testId: "menu-duplicate",
        className: "menu-item",
        iconClassName: props.documentMutation === "duplicate" ? "lucide-loader-circle" : "lucide-files",
        busy: props.documentMutation === "duplicate",
      }),
      delete: Object.freeze({
        name: "delete",
        callback: props.onDelete,
        eligible: props.isOwner && props.documentMutation === null,
        label: props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash",
        testId: "menu-delete",
        className: "menu-item text-danger",
        iconClassName: props.documentMutation === "delete" ? "lucide-loader-circle" : "lucide-trash-2",
        busy: props.documentMutation === "delete",
      }),
    }),
  });
  const moreMenuPresentation = createMoreMenuPresentation({
    render: moreMenuRender,
    coordinator: moreMenuCoordinator,
    owners: moreMenuOwners,
    commitOpen: setStoredMoreMenuState,
  });
  useLayoutEffect(
    () => moreMenuPresentation.establish(),
    [moreMenuPresentation],
  );
  const {
    captureTrigger: captureMoreMenuTrigger,
    captureContent: captureMoreMenuContent,
    captureHistory,
    captureNameVersion,
    captureDuplicate,
    captureDelete,
    onTriggerPointerDown: onMoreMenuTriggerPointerDown,
    onTriggerKeyDown: onMoreMenuTriggerKeyDown,
    onOpenChange: onMoreMenuOpenChange,
    onHistorySelect,
    onNameVersionSelect,
    onDuplicateSelect,
    onDeleteSelect,
    onEscapeKeyDown: onMoreMenuEscapeKeyDown,
    onOutside: onMoreMenuOutside,
    onCloseAutoFocus: onMoreMenuCloseAutoFocus,
  } = moreMenuPresentation;
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
        {!embed && <Menu open={moreMenuState.open} onOpenChange={onMoreMenuOpenChange}>
          <MenuTrigger asChild>
            <button
              ref={captureMoreMenuTrigger}
              type="button"
              className="icon-btn"
              aria-label="More"
              data-testid="more-menu"
              onPointerDown={onMoreMenuTriggerPointerDown}
              onKeyDown={onMoreMenuTriggerKeyDown}
            >
              <MoreVertical size={20} />
            </button>
          </MenuTrigger>
          <MenuContent
            ref={captureMoreMenuContent}
            align="end"
            className="w-64"
            onEscapeKeyDown={onMoreMenuEscapeKeyDown}
            onPointerDownOutside={onMoreMenuOutside}
            onFocusOutside={onMoreMenuOutside}
            onCloseAutoFocus={onMoreMenuCloseAutoFocus}
          >
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
            <MenuItem ref={captureHistory} icon={<History size={15} />} onSelect={onHistorySelect} data-testid="menu-history">
              Version history
            </MenuItem>
            <MenuItem icon={<Activity size={15} />} onSelect={props.onActivity} data-testid="menu-activity">
              Activity
            </MenuItem>
            {canEdit && (
              <MenuItem ref={captureNameVersion} icon={<Pencil size={15} />} onSelect={onNameVersionSelect}>
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
              ref={captureDuplicate}
              icon={props.documentMutation === "duplicate" ? <Loader2 size={15} className="animate-spin" /> : <Files size={15} />}
              onSelect={onDuplicateSelect}
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
                  ref={captureDelete}
                  icon={props.documentMutation === "delete" ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                  className="text-danger"
                  onSelect={onDeleteSelect}
                  disabled={props.documentMutation !== null}
                  aria-busy={props.documentMutation === "delete" || undefined}
                  data-testid="menu-delete"
                >
                  {props.documentMutation === "delete" ? "Moving to trash…" : "Move to trash"}
                </MenuItem>
              </>
            )}
            <MoreMenuOpenCommit presentation={moreMenuPresentation} />
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
