"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError, apiErrorText } from "@/lib/api";
import {
  GIST_AUTO_UPDATE_NOTICE,
  type GistAutoUpdateDestination,
  type GistAutoUpdateStatus,
} from "@/lib/gist-auto-update";

type Action =
  | { kind: "status"; serial: number; explicit: boolean }
  | { kind: "preview" | "disable" | "retry"; serial: number }
  | { kind: "enable"; serial: number; destination: DestinationSnapshot };
type Problem = { status: "failed" | "conflict"; message: string; source: Action["kind"] | "destination" };
type AuthorityStamp = { mount: symbol; serial: number; visibilityGeneration: number };
type RequestOwner = AuthorityStamp & { token: symbol; kind: Action["kind"] };
type TimerOwner = AuthorityStamp & { token: symbol };
class ControlAuthority {
  identity: string;
  mount: symbol | null;
  visible: boolean;
  visibilityGeneration: number;
  serial: number;
  busy: Action["kind"] | null;
  requestOwner: RequestOwner | null;
  queuedStatus: AuthorityStamp | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  timerOwner: TimerOwner | null;
  runQueuedStatus: (() => void) | null;

  constructor(identity: string) {
    this.identity = identity;
    this.mount = null;
    this.visible = false;
    this.visibilityGeneration = 0;
    this.serial = 0;
    this.busy = "status";
    this.requestOwner = null;
    this.queuedStatus = null;
    this.timer = undefined;
    this.timerOwner = null;
    this.runQueuedStatus = null;
  }
}

class ControlAuthorityCell {
  #current: ControlAuthority;

  constructor(current: ControlAuthority) {
    this.#current = current;
  }

  readonly read = () => this.#current;
}
type SettingsButtonName = "refresh" | "preview" | "enable" | "retry" | "disable";
type SettingsControlName = SettingsButtonName | "acknowledgement";
type DestinationSnapshot = Readonly<{
  gistId: string;
  filename: string;
  url: string;
  visibility: GistAutoUpdateDestination["visibility"];
  owner: string;
}>;
type StatusSnapshot = Readonly<{
  enabled: boolean;
  status: GistAutoUpdateStatus["status"];
  syncedAt: string | null;
  message: string | null;
  pending: boolean;
  destination: DestinationSnapshot | null;
}>;
type ProblemSnapshot = Readonly<Problem>;
type SettingsButtonFacts = Readonly<{
  name: SettingsButtonName;
  kind: Action["kind"];
  eligible: boolean;
  destination: DestinationSnapshot | null;
}>;
type AcknowledgementFacts = Readonly<{
  name: "acknowledgement";
  eligible: boolean;
  destination: DestinationSnapshot;
}>;
type SettingsPresentation = Readonly<{
  generation: number;
  callbackToken: symbol;
  mount: symbol;
  identity: string;
  documentId: string;
  gistId: string;
  filename: string;
  url: string;
  statusSource: GistAutoUpdateStatus | null;
  status: StatusSnapshot | null;
  previewSource: GistAutoUpdateDestination | null;
  preview: DestinationSnapshot | null;
  problemSource: Problem | null;
  problem: ProblemSnapshot | null;
  busy: Action["kind"] | null;
  acknowledged: boolean;
  enabled: boolean;
  state: Problem["status"] | GistAutoUpdateStatus["status"] | undefined;
  blocked: boolean;
  canRetry: boolean;
  buttons: Readonly<Record<SettingsButtonName, SettingsButtonFacts | null>>;
  acknowledgement: AcknowledgementFacts | null;
  requests: SettingsRequestFacts;
}>;
type SettingsRequestFacts = Readonly<{
  status: typeof api.documents.gistAutoUpdate;
  preview: typeof api.documents.gistAutoUpdatePreview;
  update: typeof api.documents.setGistAutoUpdate;
  retry: typeof api.documents.retryGistAutoUpdate;
}>;
type SettingsDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly SettingsDomSnapshot[];
}>;
type SettingsPlacement = Readonly<{
  document: Document;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;
type SettingsReplay = Readonly<{
  source: SettingsPublication;
  dom: SettingsDomSnapshot;
  placement: SettingsPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;
type RefReplay = {
  owner: SettingsElementOwnerView;
  element: HTMLElement;
  detached: boolean;
  reattached: boolean;
};
type SettingsControl<T extends HTMLElement> = Readonly<{
  name: SettingsControlName;
  token: symbol;
  facts: SettingsButtonFacts | AcknowledgementFacts | null;
  owner: SettingsElementOwnerView;
  element: () => T | null;
  capture: (element: T | null) => void;
}>;
type AnySettingsControl =
  | SettingsControl<HTMLButtonElement>
  | SettingsControl<HTMLInputElement>;
type SettingsControls = Readonly<{
  refresh: SettingsControl<HTMLButtonElement>;
  preview: SettingsControl<HTMLButtonElement>;
  acknowledgement: SettingsControl<HTMLInputElement>;
  enable: SettingsControl<HTMLButtonElement>;
  retry: SettingsControl<HTMLButtonElement>;
  disable: SettingsControl<HTMLButtonElement>;
}>;
type SettingsPublication = Readonly<{
  presentation: SettingsPresentation;
  controls: SettingsControls;
  captureRoot: (element: HTMLElement | null) => void;
  establish: () => (() => void) | undefined;
  reconcileReactCommit: () => void;
  claimClick: (
    name: SettingsButtonName,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => SettingsButtonFacts | null;
  claimAcknowledgement: (event: ChangeEvent<HTMLInputElement>) => boolean | null;
  retire: () => boolean;
  isRetired: () => boolean;
}>;
class SettingsPublicationCells {
  active: SettingsPublication | null = null;
  successorOf: SettingsPublication | null = null;
  replay: SettingsReplay | null = null;
  checkboxReconciliation: HTMLInputElement | null = null;
  readonly callbackToken = Symbol("settings callbacks");
  readonly claimedPresentations = new WeakSet<SettingsPresentation>();
  readonly claimedControls = new Set<symbol>();
  readonly claimedReactEvents = new WeakSet<object>();
  readonly claimedNativeEvents = new WeakSet<Event>();
}

const SETTINGS_BUTTON_NAMES: readonly SettingsButtonName[] = ["refresh", "preview", "enable", "retry", "disable"];

const LABELS = { off: "Off", pending: "Pending", syncing: "Syncing", synced: "Synced", failed: "Failed", conflict: "Conflict" };

function snapshotDestination(destination: Readonly<GistAutoUpdateDestination>): DestinationSnapshot {
  return Object.freeze({
    gistId: destination.gistId,
    filename: destination.filename,
    url: destination.url,
    visibility: destination.visibility,
    owner: destination.owner,
  });
}

function destinationMatchesSnapshot(
  destination: Readonly<GistAutoUpdateDestination> | null,
  snapshot: DestinationSnapshot | null,
) {
  return destination === null
    ? snapshot === null
    : snapshot !== null
      && destination.gistId === snapshot.gistId
      && destination.filename === snapshot.filename
      && destination.url === snapshot.url
      && destination.visibility === snapshot.visibility
      && destination.owner === snapshot.owner;
}

function snapshotStatus(status: Readonly<GistAutoUpdateStatus> | null): StatusSnapshot | null {
  if (!status) return null;
  return Object.freeze({
    enabled: status.enabled,
    status: status.status,
    syncedAt: status.syncedAt,
    message: status.message,
    pending: status.pending,
    destination: status.destination ? snapshotDestination(status.destination) : null,
  });
}

function statusMatchesSnapshot(status: Readonly<GistAutoUpdateStatus> | null, snapshot: StatusSnapshot | null) {
  return status === null
    ? snapshot === null
    : snapshot !== null
      && status.enabled === snapshot.enabled
      && status.status === snapshot.status
      && status.syncedAt === snapshot.syncedAt
      && status.message === snapshot.message
      && status.pending === snapshot.pending
      && destinationMatchesSnapshot(status.destination, snapshot.destination);
}

function snapshotProblem(problem: Readonly<Problem> | null): ProblemSnapshot | null {
  return problem
    ? Object.freeze({ status: problem.status, message: problem.message, source: problem.source })
    : null;
}

function problemMatchesSnapshot(problem: Readonly<Problem> | null, snapshot: ProblemSnapshot | null) {
  return problem === null
    ? snapshot === null
    : snapshot !== null
      && problem.status === snapshot.status
      && problem.message === snapshot.message
      && problem.source === snapshot.source;
}

interface SettingsElementOwnerView {
  readonly element: () => HTMLElement | null;
}

class SettingsElementOwner<T extends HTMLElement> implements SettingsElementOwnerView {
  #current: T | null = null;
  #last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: SettingsElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
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

function snapshotSettingsAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotSettingsDom(node: Node): SettingsDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: snapshotSettingsAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotSettingsDom)),
  });
}

function settingsDomMatches(snapshot: SettingsDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotSettingsAttributes(snapshot.node);
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
  return snapshot.node.childNodes.length === snapshot.children.length
    && snapshot.children.every(
      (child, index) => snapshot.node.childNodes.item(index) === child.node && settingsDomMatches(child),
    );
}

function captureSettingsPlacement(root: HTMLElement): SettingsPlacement | null {
  const parent = root.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: root.ownerDocument,
    parent,
    previousSibling: root.previousSibling,
    nextSibling: root.nextSibling,
  });
}

function settingsPlacementMatches(root: HTMLElement, placement: SettingsPlacement): boolean {
  return root.ownerDocument === placement.document
    && root.parentNode === placement.parent
    && root.previousSibling === placement.previousSibling
    && root.nextSibling === placement.nextSibling;
}

type SettingsDomGuard = Readonly<{
  acceptReactCommit: () => void;
  isClean: () => boolean;
  release: () => void;
}>;

function createSettingsDomGuard(
  root: HTMLElement,
  placement: SettingsPlacement,
  transientSpan: (
    records: readonly MutationRecord[],
    index: number,
    fromReactCommit: boolean,
  ) => number,
): SettingsDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const touchesGuardedDom = (record: MutationRecord) => {
    if (record.target === root || root.contains(record.target)) return true;
    if (record.type !== "childList" || record.target !== placement.parent) return false;
    return record.previousSibling === root
      || record.nextSibling === root
      || [...record.addedNodes, ...record.removedNodes].some((node) =>
        node === root || (node.nodeType === 1 && (node as Element).contains(root)));
  };
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    for (let index = 0; index < records.length;) {
      const skip = transientSpan(records, index, false);
      if (skip > 0) {
        index += skip;
        continue;
      }
      const record = records[index];
      if (record && touchesGuardedDom(record)) {
        changed = true;
        return;
      }
      index += 1;
    }
  };
  const observer = new MutationObserverConstructor((records) => recordChanges(records));
  observer.observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  return Object.freeze({
    acceptReactCommit: () => {
      const records = observer.takeRecords();
      const guardedRecords = records.filter(touchesGuardedDom);
      if (
        guardedRecords.length > 0
        && transientSpan(guardedRecords, 0, true) === guardedRecords.length
      ) {
        return;
      }
      recordChanges(records);
    },
    isClean: () => {
      recordChanges(observer.takeRecords());
      return !changed;
    },
    release: () => {
      recordChanges(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function destinationSnapshotsMatch(left: DestinationSnapshot | null, right: DestinationSnapshot | null) {
  return destinationMatchesSnapshot(left, right);
}

function buttonFactsMatch(left: SettingsButtonFacts | null, right: SettingsButtonFacts | null) {
  return left === null
    ? right === null
    : right !== null
      && left.name === right.name
      && left.kind === right.kind
      && left.eligible === right.eligible
      && destinationSnapshotsMatch(left.destination, right.destination);
}

function acknowledgementFactsMatch(left: AcknowledgementFacts | null, right: AcknowledgementFacts | null) {
  return left === null
    ? right === null
    : right !== null
      && left.name === right.name
      && left.eligible === right.eligible
      && destinationSnapshotsMatch(left.destination, right.destination);
}

function presentationsMatch(left: SettingsPresentation, right: SettingsPresentation) {
  return left.callbackToken === right.callbackToken
    && left.mount === right.mount
    && left.identity === right.identity
    && left.documentId === right.documentId
    && left.gistId === right.gistId
    && left.filename === right.filename
    && left.url === right.url
    && left.statusSource === right.statusSource
    && statusMatchesSnapshot(left.status, right.status)
    && left.previewSource === right.previewSource
    && destinationSnapshotsMatch(left.preview, right.preview)
    && left.problemSource === right.problemSource
    && problemMatchesSnapshot(left.problem, right.problem)
    && left.busy === right.busy
    && left.acknowledged === right.acknowledged
    && left.enabled === right.enabled
    && left.state === right.state
    && left.blocked === right.blocked
    && left.canRetry === right.canRetry
    && SETTINGS_BUTTON_NAMES.every((name) => buttonFactsMatch(left.buttons[name], right.buttons[name]))
    && acknowledgementFactsMatch(left.acknowledgement, right.acknowledgement)
    && left.requests.status === right.requests.status
    && left.requests.preview === right.requests.preview
    && left.requests.update === right.requests.update
    && left.requests.retry === right.requests.retry;
}

function presentationFactsAreCurrent(presentation: SettingsPresentation) {
  if (
    !statusMatchesSnapshot(presentation.statusSource, presentation.status)
    || !destinationMatchesSnapshot(presentation.previewSource, presentation.preview)
    || !problemMatchesSnapshot(presentation.problemSource, presentation.problem)
    || presentation.enabled !== (presentation.statusSource?.enabled ?? false)
    || presentation.state !== (presentation.problemSource?.status ?? presentation.statusSource?.status)
    || presentation.blocked !== (presentation.problemSource?.source === "destination")
    || presentation.canRetry !== (
      presentation.enabled
      && !presentation.blocked
      && (
       presentation.statusSource?.status === "failed"
       || presentation.statusSource?.status === "conflict"
       || presentation.problemSource?.source === "retry"
      )
    )
    || presentation.requests.status !== api.documents.gistAutoUpdate
    || presentation.requests.preview !== api.documents.gistAutoUpdatePreview
    || presentation.requests.update !== api.documents.setGistAutoUpdate
    || presentation.requests.retry !== api.documents.retryGistAutoUpdate
  ) {
    return false;
  }

  const refresh = presentation.buttons.refresh;
  const preview = presentation.buttons.preview;
  const enable = presentation.buttons.enable;
  const retry = presentation.buttons.retry;
  const disable = presentation.buttons.disable;
  const acknowledgement = presentation.acknowledgement;
  return (
    (presentation.problemSource && !presentation.blocked
      ? refresh?.name === "refresh"
       && refresh.kind === "status"
       && refresh.eligible === !presentation.busy
       && refresh.destination === null
      : refresh === null)
    && (!presentation.enabled
      ? preview?.name === "preview"
       && preview.kind === "preview"
       && preview.eligible === (!presentation.busy && !!presentation.statusSource && !presentation.blocked)
       && preview.destination === null
      : preview === null)
    && (!presentation.enabled
      ? enable?.name === "enable"
       && enable.kind === "enable"
       && enable.eligible === (
         !presentation.busy
         && !!presentation.statusSource
         && !!presentation.previewSource
         && presentation.acknowledged
         && !presentation.blocked
         && presentation.problemSource?.source !== "status"
       )
       && enable.destination === presentation.preview
      : enable === null)
    && (presentation.canRetry
      ? retry?.name === "retry"
       && retry.kind === "retry"
       && retry.eligible === !presentation.busy
       && retry.destination === null
      : retry === null)
    && (presentation.enabled
      ? disable?.name === "disable"
       && disable.kind === "disable"
       && disable.eligible === !presentation.busy
       && disable.destination === null
      : disable === null)
    && (!presentation.enabled && presentation.preview
      ? acknowledgement?.name === "acknowledgement"
       && acknowledgement.eligible === !presentation.busy
       && acknowledgement.destination === presentation.preview
      : acknowledgement === null)
  );
}

function isNodeFromSettingsDocument(value: EventTarget | null, ownerDocument: Document): value is Node {
  const NodeConstructor = ownerDocument.defaultView?.Node;
  return Boolean(
    NodeConstructor
    && value instanceof NodeConstructor
    && value.ownerDocument === ownerDocument,
  );
}

function isEffectivelyEnabled(element: HTMLElement) {
  if (element.matches(":disabled") || element.getAttribute("aria-disabled")?.toLowerCase() === "true") {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert")
      || current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createSettingsPublication(
  presentation: SettingsPresentation,
  cells: SettingsPublicationCells,
  requestSuccessor: () => void,
): SettingsPublication {
  let retired = false;
  let established = false;
  let layoutRetired = false;
  let consumed = false;
  let successorRequested = false;
  let invalidReplay = false;
  let replayRefs: RefReplay[] = [];
  let stableOwners = new Set<SettingsElementOwnerView>();
  let domSnapshot: SettingsDomSnapshot | null = null;
  let placementSnapshot: SettingsPlacement | null = null;
  let domGuard: SettingsDomGuard | null = null;
  let guardExpiryQueued = false;
  const introducedControlReplays = new Set<SettingsElementOwnerView>();
  const publicationFactsAreCurrent = () =>
    presentation.callbackToken === cells.callbackToken
    && presentationFactsAreCurrent(presentation);

  const onElementChange = (
    owner: SettingsElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    if (!established) return;
    const proof = replayRefs.find((entry) => entry.owner === owner);
    if (!proof) {
      invalidReplay = true;
      return;
    }
    if (element === null && previous === proof.element && proof.element.isConnected) {
      proof.detached = true;
      proof.reattached = false;
    } else if (
      element === proof.element
      && previous === null
      && proof.detached
      && proof.element.isConnected
    ) {
      proof.reattached = true;
    } else if (element !== previous) {
      invalidReplay = true;
    }
    const introducedReplayCompleted = Boolean(
      proof
      && introducedControlReplays.has(owner)
      && proof.detached
      && proof.reattached,
    );
    if (
      stableOwners.has(owner)
      && (element === null || (element !== null && last !== null && element !== last))
      && !introducedControlReplays.has(owner)
    ) {
      retire("element");
    }
    if (introducedReplayCompleted && proof) {
      introducedControlReplays.delete(owner);
      proof.detached = false;
      proof.reattached = false;
    }
    if (exactReplayReady()) requestReplaySuccessor();
  };

  const root = new SettingsElementOwner<HTMLElement>(onElementChange);
  const makeControl = <T extends HTMLElement>(
    name: SettingsControlName,
    facts: SettingsButtonFacts | AcknowledgementFacts | null,
  ): SettingsControl<T> => {
    const owner = new SettingsElementOwner<T>(onElementChange);
    return Object.freeze({
      name,
      token: Symbol(name),
      facts,
      owner,
      element: owner.element,
      capture: owner.capture,
    });
  };
  const controls: SettingsControls = Object.freeze({
    refresh: makeControl<HTMLButtonElement>("refresh", presentation.buttons.refresh),
    preview: makeControl<HTMLButtonElement>("preview", presentation.buttons.preview),
    acknowledgement: makeControl<HTMLInputElement>("acknowledgement", presentation.acknowledgement),
    enable: makeControl<HTMLButtonElement>("enable", presentation.buttons.enable),
    retry: makeControl<HTMLButtonElement>("retry", presentation.buttons.retry),
    disable: makeControl<HTMLButtonElement>("disable", presentation.buttons.disable),
  });

  const orderedControls = (): readonly AnySettingsControl[] => [
    ...(presentation.buttons.refresh ? [controls.refresh] : []),
    ...(presentation.buttons.preview ? [controls.preview] : []),
    ...(presentation.acknowledgement ? [controls.acknowledgement] : []),
    ...(presentation.buttons.enable ? [controls.enable] : []),
    ...(presentation.buttons.retry ? [controls.retry] : []),
    ...(presentation.buttons.disable ? [controls.disable] : []),
  ];
  const expectedOwners = (): readonly SettingsElementOwnerView[] => [
    root,
    ...orderedControls().map((control) => control.owner),
  ];
  const expectedButtonLabel = (name: SettingsButtonName) => {
    switch (name) {
      case "refresh": return "Refresh status";
      case "preview": return presentation.preview ? "Recheck linked gist" : "Check linked gist";
      case "enable": return presentation.busy === "enable" ? "Enabling…" : "Enable auto-update";
      case "retry": return presentation.busy === "retry" ? "Requesting retry…" : "Retry latest saved version";
      case "disable": return presentation.busy === "disable" ? "Disabling…" : "Disable auto-update";
    }
  };
  const exactDomIsCurrent = (changingAcknowledgement = false) => {
    const rootElement = root.element();
    const ownerDocument = rootElement?.ownerDocument;
    const expected = orderedControls();
    const actual = rootElement
      ? [...rootElement.querySelectorAll<HTMLElement>("button, input[type=\"checkbox\"]")]
      : [];
    if (
      !rootElement
      || !ownerDocument?.defaultView
      || !rootElement.isConnected
      || !rootElement.parentNode
      || rootElement.tagName !== "SECTION"
      || rootElement.dataset.testid !== "gist-auto-update"
      || actual.length !== expected.length
      || expected.some((control, index) => {
       const element = control.element();
       return !element
         || element !== actual[index]
         || !element.isConnected
         || element.ownerDocument !== ownerDocument
         || !rootElement.contains(element);
      })
    ) {
      return false;
    }
    for (const name of SETTINGS_BUTTON_NAMES) {
      const control = controls[name];
      const facts = presentation.buttons[name];
      const element = control.element();
      if (!facts) {
       if (element) return false;
       continue;
      }
      if (
       !(element instanceof ownerDocument.defaultView.HTMLButtonElement)
       || control.facts !== facts
       || element.type !== "button"
       || element.disabled === facts.eligible
       || element.textContent?.trim() !== expectedButtonLabel(name)
      ) {
       return false;
      }
    }
    const acknowledgement = presentation.acknowledgement;
    const input = controls.acknowledgement.element();
    if (!acknowledgement) return input === null;
    return Boolean(
      input
      && input instanceof ownerDocument.defaultView.HTMLInputElement
      && controls.acknowledgement.facts === acknowledgement
      && input.type === "checkbox"
      && input.disabled !== acknowledgement.eligible
      && input.parentElement?.tagName === "LABEL"
      && (
       changingAcknowledgement
         ? input.checked !== presentation.acknowledged
         : input.checked === presentation.acknowledged
      ),
    );
  };
  const publishedDomMatches = () => {
    const rootElement = root.element();
    return Boolean(
      domSnapshot
      && placementSnapshot
      && domGuard?.isClean()
      && rootElement
      && rootElement === domSnapshot.node
      && rootElement.isConnected
      && settingsPlacementMatches(rootElement, placementSnapshot)
      && settingsDomMatches(domSnapshot),
    );
  };
  const replayHistoryIsClean = () => Boolean(
    domSnapshot
    && placementSnapshot
    && domGuard?.isClean()
    && domSnapshot.node.isConnected
    && settingsPlacementMatches(domSnapshot.node as HTMLElement, placementSnapshot)
    && settingsDomMatches(domSnapshot),
  );
  const exactReplayReady = () =>
    retired
    && layoutRetired
    && established
    && !consumed
    && !invalidReplay
    && replayRefs.length > 0
    && replayRefs.every((entry) =>
      entry.detached
      && entry.reattached
      && entry.owner.element() === entry.element)
    && publicationFactsAreCurrent()
    && exactDomIsCurrent()
    && publishedDomMatches()
    && cells.successorOf === publication;
  const releaseGuard = () => {
    domGuard?.release();
    domGuard = null;
  };
  const scheduleGuardExpiry = () => {
    if (guardExpiryQueued) return;
    guardExpiryQueued = true;
    queueMicrotask(() => {
      if (cells.replay?.source !== publication) releaseGuard();
    });
  };
  const retire = (reason: "element" | "layout" | "other") => {
    if (retired) return false;
    domGuard?.isClean();
    retired = true;
    const wasActive = cells.active === publication;
    if (wasActive) {
      cells.active = null;
      cells.successorOf = publication;
    }
    if (reason === "other") releaseGuard();
    else scheduleGuardExpiry();
    return wasActive;
  };
  const retireForLayout = () => {
    layoutRetired = true;
    retire("layout");
    scheduleGuardExpiry();
  };
  const requestReplaySuccessor = () => {
    if (
      successorRequested
      || !domSnapshot
      || !placementSnapshot
      || !exactReplayReady()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay = Object.freeze({
      source: publication,
      dom: domSnapshot,
      placement: placementSnapshot,
      historyIsClean: replayHistoryIsClean,
      release: releaseGuard,
    });
    requestSuccessor();
  };
  const establish = () => {
    if (established) {
      if (exactReplayReady()) requestReplaySuccessor();
      return undefined;
    }
    if (!publicationFactsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const rootElement = root.element();
    const placement = rootElement ? captureSettingsPlacement(rootElement) : null;
    if (!rootElement || !placement) return undefined;
    const pendingReplay = cells.replay;
    if (pendingReplay) {
      const sameAuthority = presentation.generation === pendingReplay.source.presentation.generation + 1
        && presentationsMatch(pendingReplay.source.presentation, presentation);
      const exactReplay = sameAuthority
       && pendingReplay.source.isRetired()
       && cells.successorOf === pendingReplay.source
       && pendingReplay.historyIsClean()
       && pendingReplay.dom.node === rootElement
       && settingsPlacementMatches(rootElement, pendingReplay.placement)
       && settingsDomMatches(pendingReplay.dom);
      cells.replay = null;
      pendingReplay.release();
      if (cells.successorOf === pendingReplay.source) cells.successorOf = null;
      if (sameAuthority && !exactReplay) return undefined;
    }
    const guard = createSettingsDomGuard(
      rootElement,
      placement,
      (records, index, fromReactCommit) => {
        const input = controls.acknowledgement.element();
        const currentRoot = root.element();
        const nameStart = records[index];
        const typeReset = records[index + 1];
        const nameEnd = records[index + 2];
        const exactReactCommit = fromReactCommit
          && index === 0
          && records.length === 3;
        return (cells.checkboxReconciliation === input || exactReactCommit)
          && input
          && currentRoot === domSnapshot?.node
          && placementSnapshot
          && settingsPlacementMatches(currentRoot, placementSnapshot)
          && settingsDomMatches(domSnapshot)
          && cells.active === publication
          && publicationFactsAreCurrent()
          && exactDomIsCurrent()
          && nameStart?.type === "attributes"
          && nameStart.target === input
          && nameStart.attributeName === "name"
          && nameStart.oldValue === null
          && typeReset?.type === "attributes"
          && typeReset.target === input
          && typeReset.attributeName === "type"
          && typeReset.oldValue === "checkbox"
          && nameEnd?.type === "attributes"
          && nameEnd.target === input
          && nameEnd.attributeName === "name"
          && nameEnd.oldValue === ""
          && !input.hasAttribute("name")
          && input.getAttribute("type") === "checkbox"
          ? (cells.checkboxReconciliation = null, 3)
          : 0;
      },
    );
    if (!guard) return undefined;
    const predecessor = cells.active ?? cells.successorOf;
    if (
      predecessor
      && predecessor.presentation.mount === presentation.mount
      && predecessor.presentation.identity === presentation.identity
    ) {
      for (const name of SETTINGS_BUTTON_NAMES) {
        if (!predecessor.presentation.buttons[name] && presentation.buttons[name]) {
          introducedControlReplays.add(controls[name].owner);
        }
      }
      if (!predecessor.presentation.acknowledgement && presentation.acknowledgement) {
        introducedControlReplays.add(controls.acknowledgement.owner);
      }
    }
    const previous = cells.active;
    if (previous && previous !== publication) previous.retire();
    established = true;
    stableOwners = new Set(expectedOwners());
    replayRefs = [...stableOwners].map((owner) => ({
      owner,
      element: owner.element()!,
      detached: false,
      reattached: false,
    }));
    domSnapshot = snapshotSettingsDom(rootElement);
    placementSnapshot = placement;
    domGuard = guard;
    cells.active = publication;
    cells.successorOf = null;
    queueMicrotask(() => {
      introducedControlReplays.clear();
      if (cells.checkboxReconciliation === controls.acknowledgement.element()) {
        cells.checkboxReconciliation = null;
      }
    });
    return retireForLayout;
  };
  const reconcileReactCommit = () => {
    if (!retired && established && cells.active === publication) {
      domGuard?.acceptReactCommit();
    }
  };
  const ownsControl = (
    control: AnySettingsControl,
    changingAcknowledgement = false,
  ) => {
    const rootElement = root.element();
    const element = control.element();
    return !retired
      && cells.active === publication
      && !cells.claimedPresentations.has(presentation)
      && !cells.claimedControls.has(control.token)
      && publicationFactsAreCurrent()
      && exactDomIsCurrent(changingAcknowledgement)
      && publishedDomMatches()
      && !!rootElement
      && !!element
      && element.isConnected
      && rootElement.contains(element)
      && isEffectivelyEnabled(element);
  };
  const claim = (
    control: AnySettingsControl,
    reactEvent: object,
    nativeEvent: Event,
  ) => {
    if (
      cells.claimedReactEvents.has(reactEvent)
      || cells.claimedNativeEvents.has(nativeEvent)
      || !ownsControl(control, control.name === "acknowledgement")
    ) {
      return false;
    }
    cells.claimedPresentations.add(presentation);
    cells.claimedControls.add(control.token);
    cells.claimedReactEvents.add(reactEvent);
    cells.claimedNativeEvents.add(nativeEvent);
    if (control === controls.acknowledgement) {
      cells.checkboxReconciliation = controls.acknowledgement.element();
    }
    consumed = true;
    retire("other");
    return true;
  };
  const claimClick = (
    name: SettingsButtonName,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): SettingsButtonFacts | null => {
    const control = controls[name];
    const facts = presentation.buttons[name];
    const element = control.element();
    const rootElement = root.element();
    const ownerWindow = rootElement?.ownerDocument.defaultView;
    const nativeEvent = event?.nativeEvent;
    const target = event?.target;
    if (
      !facts
      || control.facts !== facts
      || !facts.eligible
      || !element
      || !rootElement
      || !ownerWindow
      || event.type !== "click"
      || event.button !== 0
      || !(nativeEvent instanceof ownerWindow.MouseEvent)
      || nativeEvent.type !== "click"
      || nativeEvent.button !== 0
      || nativeEvent.eventPhase === ownerWindow.Event.NONE
      || event.currentTarget !== element
      || nativeEvent.target !== target
      || !isNodeFromSettingsDocument(target, rootElement.ownerDocument)
      || !element.contains(target)
      || !nativeEvent.composedPath().includes(element)
      || !nativeEvent.composedPath().includes(rootElement)
      || event.defaultPrevented
      || nativeEvent.defaultPrevented
      || !claim(control, event, nativeEvent)
    ) {
      return null;
    }
    return facts;
  };
  const claimAcknowledgement = (event: ChangeEvent<HTMLInputElement>): boolean | null => {
    const control = controls.acknowledgement;
    const facts = presentation.acknowledgement;
    const element = control.element();
    const rootElement = root.element();
    const ownerWindow = rootElement?.ownerDocument.defaultView;
    const nativeEvent = event?.nativeEvent;
    if (
      !facts
      || control.facts !== facts
      || !facts.eligible
      || !element
      || !rootElement
      || !ownerWindow
      || event.type !== "change"
      || !(nativeEvent instanceof ownerWindow.Event)
      || !["click", "change", "input"].includes(nativeEvent.type)
      || (
       nativeEvent instanceof ownerWindow.MouseEvent
       && nativeEvent.button !== 0
      )
      || nativeEvent.eventPhase === ownerWindow.Event.NONE
      || event.currentTarget !== element
      || event.target !== element
      || nativeEvent.target !== element
      || !nativeEvent.composedPath().includes(element)
      || !nativeEvent.composedPath().includes(rootElement)
      || element.checked === presentation.acknowledged
      || event.defaultPrevented
      || nativeEvent.defaultPrevented
      || !claim(control, event, nativeEvent)
    ) {
      return null;
    }
    return element.checked;
  };

  const publication = Object.freeze({
    presentation,
    controls,
    captureRoot: root.capture,
    establish,
    reconcileReactCommit,
    claimClick,
    claimAcknowledgement,
    retire: () => retire("other"),
    isRetired: () => retired,
  });
  return publication;
}

function clearAuthorityTimer(authority: ControlAuthority) {
  if (authority.timer !== undefined) clearTimeout(authority.timer);
  authority.timer = undefined;
  authority.timerOwner = null;
}

export function GistAutoUpdateControl({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) {
  if (!isOwner || doc.storage !== "gist" || !doc.gistId || !doc.gistFile || !doc.githubUrl || !doc.publishedAt) return null;
  const identity = JSON.stringify([doc.id, doc.gistId, doc.gistFile, doc.githubUrl, doc.ownerId]);
  return (
    <AutoUpdateSettings
      key={identity}
      identity={identity}
      documentId={doc.id}
      gistId={doc.gistId}
      filename={doc.gistFile}
      url={doc.githubUrl}
    />
  );
}

function AutoUpdateSettings({ identity, documentId, gistId, filename, url }: {
  identity: string;
  documentId: string;
  gistId: string;
  filename: string;
  url: string;
}) {
  const id = useId();
  const [settingsMount] = useState(() => Symbol(identity));
  const [authority] = useState(() => new ControlAuthorityCell(new ControlAuthority(identity)));
  const [action, setAction] = useState<Action>({ kind: "status", serial: 0, explicit: false });
  const [busy, setBusy] = useState<Action["kind"] | null>("status");
  const [status, setStatus] = useState<GistAutoUpdateStatus | null>(null);
  const [preview, setPreview] = useState<GistAutoUpdateDestination | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [publicationCells] = useState(() => new SettingsPublicationCells());
  const [publicationRevision, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const statusRequest = api.documents.gistAutoUpdate;
  const previewRequest = api.documents.gistAutoUpdatePreview;
  const updateRequest = api.documents.setGistAutoUpdate;
  const retryRequest = api.documents.retryGistAutoUpdate;
  const requests = useMemo<SettingsRequestFacts>(() => Object.freeze({
    status: statusRequest,
    preview: previewRequest,
    update: updateRequest,
    retry: retryRequest,
  }), [previewRequest, retryRequest, statusRequest, updateRequest]);

  useLayoutEffect(() => {
    const current = authority.read();
    const mount = settingsMount;
    current.mount = mount;
    current.visible = document.visibilityState === "visible";

    const onVisibilityChange = () => {
      if (current.identity !== identity || current.mount !== mount) return;
      const visible = document.visibilityState === "visible";
      if (visible === current.visible) return;
      current.visible = visible;
      current.visibilityGeneration++;
      current.queuedStatus = null;
      clearAuthorityTimer(current);
      if (!visible) return;
      current.queuedStatus = {
        mount,
        serial: current.serial,
        visibilityGeneration: current.visibilityGeneration,
      };
      current.runQueuedStatus?.();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (current.identity !== identity || current.mount !== mount) return;
      current.mount = null;
      current.visibilityGeneration++;
      current.requestOwner = null;
      current.queuedStatus = null;
      current.runQueuedStatus = null;
      clearAuthorityTimer(current);
    };
  }, [authority, identity, settingsMount]);

  useEffect(() => {
    const current = authority.read();
    let statusInFlight = false;
    const stampIsCurrent = (stamp: AuthorityStamp, requireVisible = true) => {
      return current.identity === identity
        && current.mount === stamp.mount
        && current.serial === stamp.serial
        && current.visibilityGeneration === stamp.visibilityGeneration
        && (!requireVisible || current.visible);
    };
    const owns = (owner: RequestOwner) => {
      return current.requestOwner === owner && stampIsCurrent(owner);
    };
    const claim = (kind: Action["kind"], requireVisible: boolean) => {
      const mount = current.mount;
      if (
        current.identity !== identity
        || mount === null
        || current.serial !== action.serial
        || (requireVisible && !current.visible)
      ) return null;
      const owner: RequestOwner = {
        mount,
        serial: action.serial,
        visibilityGeneration: current.visibilityGeneration,
        token: Symbol(kind),
        kind,
      };
      current.requestOwner = owner;
      return owner;
    };
    const matches = (owner: RequestOwner, destination: GistAutoUpdateDestination | null) => {
      if (!owns(owner)) return false;
      if (!destination || (destination.gistId === gistId && destination.filename === filename)) return true;
      setPreview(null);
      setAcknowledged(false);
      setProblem({
        status: "conflict",
        source: "destination",
        message: "The linked gist changed. Close and reopen publishing controls to review the current destination.",
      });
      return false;
    };
    const fail = (owner: RequestOwner, error: unknown, source: Action["kind"]) => {
      if (!owns(owner)) return;
      setProblem({
        status: error instanceof ApiError && error.body?.status === "conflict" ? "conflict" : "failed",
        source,
        message: apiErrorText(error, "Could not update gist auto-update controls. Check the status before trying again."),
      });
    };
    const schedule = (owner: RequestOwner) => {
      if (!owns(owner)) return;
      if (current.queuedStatus && stampIsCurrent(current.queuedStatus)) return;
      clearAuthorityTimer(current);
      const timerOwner: TimerOwner = {
        mount: owner.mount,
        serial: owner.serial,
        visibilityGeneration: owner.visibilityGeneration,
        token: Symbol("timer"),
      };
      current.timerOwner = timerOwner;
      current.timer = setTimeout(() => {
        if (current.timerOwner !== timerOwner) return;
        current.timer = undefined;
        current.timerOwner = null;
        if (!stampIsCurrent(timerOwner)) return;
        current.queuedStatus = {
          mount: timerOwner.mount,
          serial: timerOwner.serial,
          visibilityGeneration: timerOwner.visibilityGeneration,
        };
        current.runQueuedStatus?.();
      }, 2_000);
    };
    const accept = (owner: RequestOwner, next: GistAutoUpdateStatus) => {
      if (!owns(owner) || !matches(owner, next.destination)) return false;
      setStatus(next);
      if (next.enabled) {
        setPreview(null);
        setAcknowledged(false);
      }
      return next.status !== "failed" && next.status !== "conflict";
    };

    function queueStatus() {
      const mount = current.mount;
      if (
        current.identity !== identity
        || mount === null
        || current.serial !== action.serial
        || !current.visible
      ) return;
      current.queuedStatus = {
        mount,
        serial: action.serial,
        visibilityGeneration: current.visibilityGeneration,
      };
      requestQueuedStatus();
    }

    function requestQueuedStatus() {
      const queued = current.queuedStatus;
      if (!queued || queued.serial !== action.serial || !stampIsCurrent(queued)) return;
      const currentOwner = current.requestOwner;
      if (currentOwner && currentOwner.mount === queued.mount && currentOwner.serial === queued.serial) return;
      current.queuedStatus = null;
      void poll();
    }

    function finish(owner: RequestOwner) {
      const ownsPhysicalRequest = current.identity === identity
        && current.mount === owner.mount
        && current.serial === owner.serial
        && current.requestOwner === owner;
      if (!ownsPhysicalRequest) return;
      const ownsCurrentGeneration = current.visible
        && current.visibilityGeneration === owner.visibilityGeneration;
      current.requestOwner = null;
      if (ownsCurrentGeneration && current.busy !== null) {
        current.busy = null;
        setBusy(null);
      }
      requestQueuedStatus();
    }

    async function poll() {
      if (statusInFlight) {
        queueStatus();
        return;
      }
      const currentOwner = current.requestOwner;
      if (
        currentOwner
        && currentOwner.mount === current.mount
        && currentOwner.serial === action.serial
      ) {
        queueStatus();
        return;
      }
      const owner = claim("status", true);
      if (!owner) return;
      statusInFlight = true;
      try {
        const next = await requests.status(documentId);
        if (!owns(owner)) return;
        setProblem(null);
        if (accept(owner, next)) schedule(owner);
      } catch (error) {
        fail(owner, error, "status");
      } finally {
        statusInFlight = false;
        finish(owner);
      }
    }

    async function run() {
      if (action.kind === "status") return poll();
      const owner = claim(action.kind, false);
      if (!owner) return;
      try {
        if (action.kind === "preview") {
          const result = await requests.preview(documentId);
          if (!owns(owner)) return;
          if (matches(owner, result.destination)) {
            setPreview(result.destination);
            schedule(owner);
          }
        } else {
          const next = action.kind === "retry"
            ? await requests.retry(documentId)
            : await requests.update(documentId, action.kind === "enable"
              ? { enabled: true, acknowledgeRisk: true, destination: action.destination }
              : { enabled: false });
          if (!owns(owner)) return;
          setPreview(null);
          setAcknowledged(false);
          if (accept(owner, next)) schedule(owner);
        }
      } catch (error) {
        if (!owns(owner)) return;
        fail(owner, error, action.kind);
        if (action.kind === "enable") {
          setPreview(null);
          setAcknowledged(false);
        }
      } finally {
        finish(owner);
      }
    }

    current.runQueuedStatus = requestQueuedStatus;
    const queued = current.queuedStatus;
    if (action.kind === "status" && queued?.serial === action.serial && stampIsCurrent(queued)) {
      current.queuedStatus = null;
    }
    void run();
    return () => {
      if (current.runQueuedStatus === requestQueuedStatus) current.runQueuedStatus = null;
    };
  }, [
    action,
    authority,
    documentId,
    filename,
    gistId,
    identity,
    requests,
  ]);

  const enabled = status?.enabled ?? false;
  const state = problem?.status ?? status?.status;
  const blocked = problem?.source === "destination";
  const canRetry = enabled && !blocked && (status?.status === "failed" || status?.status === "conflict" || problem?.source === "retry");
  const activate = useCallback((
    candidate: SettingsPresentation,
    control: SettingsButtonFacts,
  ) => {
    const current = authority.read();
    const mount = current.mount;
    if (
      mount !== candidate.mount
      || current.busy !== null
      || (
        control.kind === "enable"
        && (
          !control.destination
          || control.destination !== candidate.preview
          || !candidate.acknowledged
          || candidate.status?.enabled
        )
      )
    ) return;

    const kind = control.kind;
    current.busy = kind;
    const queued = current.queuedStatus;
    const preserveQueuedStatus = queued
      && queued.mount === mount
      && queued.serial === current.serial
      && queued.visibilityGeneration === current.visibilityGeneration;
    const nextSerial = ++current.serial;
    clearAuthorityTimer(current);
    current.queuedStatus = preserveQueuedStatus
      ? { mount, serial: nextSerial, visibilityGeneration: current.visibilityGeneration }
      : null;
    setBusy(kind);
    setProblem(null);
    if (kind === "preview") {
      setPreview(null);
      setAcknowledged(false);
    }
    setAction(kind === "enable"
      ? { kind, serial: nextSerial, destination: snapshotDestination(control.destination!) }
      : kind === "status"
        ? { kind, serial: nextSerial, explicit: true }
        : { kind, serial: nextSerial });
  }, [authority]);
  const acknowledge = useCallback((
    candidate: SettingsPresentation,
    checked: boolean,
  ) => {
    const current = authority.read();
    if (
      current.mount !== candidate.mount
      || current.identity !== candidate.identity
      || current.busy !== null
    ) {
      return;
    }
    setAcknowledged(checked);
  }, [authority]);

  const presentation = useMemo<SettingsPresentation>(() => {
    const refreshEligible = !busy;
    const previewEligible = !busy && !!status && !blocked;
    const acknowledgementEligible = !busy;
    const enableEligible = !busy && !!status && !!preview && acknowledged && !blocked && problem?.source !== "status";
    const retryEligible = !busy;
    const disableEligible = !busy;
    const statusSnapshot = snapshotStatus(status);
    const previewSnapshot = preview ? snapshotDestination(preview) : null;
    const problemSnapshot = snapshotProblem(problem);
    const buttons: SettingsPresentation["buttons"] = Object.freeze({
      refresh: problem && !blocked
        ? Object.freeze({
            name: "refresh",
            kind: "status",
            eligible: refreshEligible,
            destination: null,
          })
        : null,
      preview: !enabled
        ? Object.freeze({
            name: "preview",
            kind: "preview",
            eligible: previewEligible,
            destination: null,
          })
        : null,
      enable: !enabled
        ? Object.freeze({
            name: "enable",
            kind: "enable",
            eligible: enableEligible,
            destination: previewSnapshot,
          })
        : null,
      retry: canRetry
        ? Object.freeze({
            name: "retry",
            kind: "retry",
            eligible: retryEligible,
            destination: null,
          })
        : null,
      disable: enabled
        ? Object.freeze({
            name: "disable",
            kind: "disable",
            eligible: disableEligible,
            destination: null,
          })
        : null,
    });
    const acknowledgement = !enabled && previewSnapshot
      ? Object.freeze({
          name: "acknowledgement" as const,
          eligible: acknowledgementEligible,
          destination: previewSnapshot,
        })
      : null;
    const candidate: SettingsPresentation = Object.freeze({
      generation: publicationRevision,
      callbackToken: publicationCells.callbackToken,
      mount: settingsMount,
      identity,
      documentId,
      gistId,
      filename,
      url,
      statusSource: status,
      status: statusSnapshot,
      previewSource: preview,
      preview: previewSnapshot,
      problemSource: problem,
      problem: problemSnapshot,
      busy,
      acknowledged,
      enabled,
      state,
      blocked,
      canRetry,
      buttons,
      acknowledgement,
      requests,
    });
    return candidate;
  }, [
    acknowledged,
    blocked,
    busy,
    canRetry,
    documentId,
    enabled,
    filename,
    gistId,
    identity,
    preview,
    problem,
    publicationRevision,
    publicationCells,
    requests,
    settingsMount,
    state,
    status,
    url,
  ]);
  const publication = useMemo(
    () => createSettingsPublication(presentation, publicationCells, requestPublicationSuccessor),
    [presentation, publicationCells, requestPublicationSuccessor],
  );
  useLayoutEffect(() => publication.establish(), [publication]);
  useLayoutEffect(() => {
    publication.reconcileReactCommit();
  });
  const { captureRoot, claimAcknowledgement, claimClick, controls } = publication;
  const { capture: captureRefresh } = controls.refresh;
  const { capture: capturePreview } = controls.preview;
  const { capture: captureAcknowledgement } = controls.acknowledgement;
  const { capture: captureEnable } = controls.enable;
  const { capture: captureRetry } = controls.retry;
  const { capture: captureDisable } = controls.disable;
  const destination = enabled ? status?.destination : preview;
  return (
    <section ref={captureRoot} aria-labelledby={`${id}-title`} className="mb-4 flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3 text-sm" data-testid="gist-auto-update">
      <div className="flex items-center gap-2 font-medium text-ink">
        <h3 id={`${id}-title`}>Auto-update gist</h3>
        <span className="ml-auto text-xs text-ink-3" role="status" data-testid="gist-auto-update-state" data-status={state ?? "loading"}>
          {state ? LABELS[state] : "Checking status…"}
        </span>
      </div>
      <p id={`${id}-notice`} className="text-xs text-ink-3">{GIST_AUTO_UPDATE_NOTICE}</p>
      <p className="text-xs text-ink-3">This is best-effort publishing: checking GitHub and uploading are not one atomic operation.</p>
      <div id={`${id}-destination`} className="break-all text-xs text-ink-2" data-testid="gist-auto-update-destination">
        <p>Destination: <a href={destination?.url ?? url} target="_blank" rel="noopener noreferrer" className="underline">{destination?.url ?? url}</a></p>
        <p>File: {destination?.filename ?? filename}</p>
        {destination && (
          <>
            <p>Visibility: {destination.visibility === "public" ? "Public" : "Secret (unlisted, not private)"}</p>
            <p>GitHub account: @{destination.owner}</p>
          </>
        )}
      </div>
      <div role="status" aria-live="polite" className="text-xs text-ink-2">
        {status?.status === "pending" && <p>The latest saved version is waiting to publish.</p>}
        {status?.status === "syncing" && <p>Uploading a saved version to the gist.</p>}
        {status?.pending && status.status === "syncing" && <p data-testid="gist-auto-update-pending">The newest saved version is pending behind the current upload.</p>}
        {status?.syncedAt && <p>Last synced at <time dateTime={status.syncedAt}>{new Date(status.syncedAt).toLocaleString()}</time>.</p>}
        {status?.message && <p className="max-w-full wrap-anywhere">{status.message}</p>}
      </div>
      {problem && <p role="alert" className="max-w-full wrap-anywhere text-xs text-ink-2">{LABELS[problem.status]}: {problem.message}</p>}
      {problem && (problem.source === "enable" || problem.source === "disable" || problem.source === "retry") && (
        <p className="text-xs text-ink-3">Refresh status to confirm the setting and saved-version progress before trying again.</p>
      )}
      {state === "conflict" && <p className="text-xs text-ink-3">Publishing is paused for a conflict. Manually reconcile the Markdoc and GitHub versions before retrying. Retry does not force an overwrite or resolve a known conflict.</p>}
      {problem && !blocked && (
        <button ref={captureRefresh} type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={(event) => {
          const control = claimClick("refresh", event);
          if (control) activate(presentation, control);
        }}>Refresh status</button>
      )}
      {!enabled && (
        <>
          <p className="text-xs text-ink-3" data-testid="gist-auto-update-preview" data-status={busy === "preview" ? "checking" : preview ? "checked" : "unchecked"}>
            {busy === "preview" ? "Checking the linked gist (no publishing)…" : preview ? "Review this checked destination and acknowledge the risks before enabling." : "Check the linked gist to review its current visibility and GitHub account before enabling."}
          </p>
          <button ref={capturePreview} type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy || !status || blocked} onClick={(event) => {
            const control = claimClick("preview", event);
            if (control) activate(presentation, control);
          }}>
            {preview ? "Recheck linked gist" : "Check linked gist"}
          </button>
          {preview && (
            <label className="flex items-start gap-2 text-xs text-ink-2">
              <input ref={captureAcknowledgement} type="checkbox" checked={acknowledged} disabled={!!busy} aria-describedby={`${id}-notice ${id}-destination`} onChange={(event) => {
                const checked = claimAcknowledgement(event);
                if (checked !== null) acknowledge(presentation, checked);
              }} />
              I acknowledge the sharing and overwrite risks.
            </label>
          )}
          <button ref={captureEnable} type="button" className="btn btn-sm btn-primary self-start" disabled={!!busy || !status || !preview || !acknowledged || blocked || problem?.source === "status"} onClick={(event) => {
            const control = claimClick("enable", event);
            if (control) activate(presentation, control);
          }}>
            {busy === "enable" ? "Enabling…" : "Enable auto-update"}
          </button>
        </>
      )}
      {canRetry && (
        <button ref={captureRetry} type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={(event) => {
          const control = claimClick("retry", event);
          if (control) activate(presentation, control);
        }}>
          {busy === "retry" ? "Requesting retry…" : "Retry latest saved version"}
        </button>
      )}
      {enabled && (
        <button ref={captureDisable} type="button" className="btn btn-sm btn-outline self-start" disabled={!!busy} onClick={(event) => {
          const control = claimClick("disable", event);
          if (control) activate(presentation, control);
        }}>
          {busy === "disable" ? "Disabling…" : "Disable auto-update"}
        </button>
      )}
      <p className="text-xs text-ink-3">Turning auto-update off stops future updates. An update already in progress may still finish.</p>
    </section>
  );
}
