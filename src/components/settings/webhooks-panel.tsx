"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, Copy, Loader2, Plus, Power, Send, Trash2, Webhook } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import { useCopy } from "@/lib/hooks";
import { ApiError, apiErrorText } from "@/lib/api";

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  documentIds: string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
}

interface MountGeneration {
  readonly identity: symbol;
}

interface Operation {
  readonly sequence: number;
  readonly generation: MountGeneration;
}

interface RowOperation extends Operation {
  readonly webhookId: string;
  readonly kind: "test" | "enable" | "delete";
}

interface CreatedWebhook {
  id: string;
  secret: string;
  url: string;
}

type DeliveryTone = "ok" | "bad" | "muted";
type PanelActionKind = "add" | "cancel" | "copy" | "create" | "retry";
type RowActionKind = RowOperation["kind"];

type ActionFacts = Readonly<{
  kind: PanelActionKind;
  eligible: boolean;
  route: string | null;
}>;

type DraftInputFacts = Readonly<{
  kind: "url" | "docs";
  value: string;
  eligible: boolean;
}>;

type ChoiceFacts = Readonly<{
  kind: "choice";
  index: number;
  id: string;
  label: string;
  types: readonly string[];
  checked: boolean;
  eligible: boolean;
}>;

type DraftFacts = Readonly<{
  url: string;
  docs: string;
  choices: readonly string[];
  urlInput: DraftInputFacts;
  docsInput: DraftInputFacts;
  choiceInputs: readonly ChoiceFacts[];
}>;

type LastDeliveryFacts = Readonly<{
  status: number;
  at: string;
  attempt: number;
  event: string;
}>;

type RowActionFacts = Readonly<{
  kind: RowActionKind;
  eligible: boolean;
  route: string;
}>;

type WebhookRowFacts = Readonly<{
  source: WebhookRow;
  index: number;
  id: string;
  url: string;
  events: readonly string[];
  documentIds: readonly string[] | null;
  active: boolean;
  failures: number;
  createdAt: string;
  lastDelivery: LastDeliveryFacts | null;
  details: string;
  statusText: string;
  statusTone: DeliveryTone;
  operation: RowOperation | null;
  enable: RowActionFacts | null;
  test: RowActionFacts;
  delete: RowActionFacts;
}>;

type CreatedFacts = Readonly<{
  source: CreatedWebhook;
  id: string;
  secret: string;
  url: string;
}>;

type ListFacts = Readonly<{
  kind: "loading" | "unavailable" | "empty" | "rows";
  rows: readonly WebhookRowFacts[] | null;
}>;

type PanelPresentation = Readonly<{
  identity: symbol;
  revision: number;
  callbackToken: symbol;
  generation: MountGeneration;
  hooksSource: WebhookRow[] | null;
  choicesSource: string[];
  rowOperationsSource: Map<string, RowOperation>;
  createdSource: CreatedWebhook | null;
  adding: boolean;
  draft: DraftFacts;
  createOperation: Operation | null;
  retryOperation: Operation | null;
  feedbackOperation: Operation | null;
  listError: string | null;
  actionError: string | null;
  created: CreatedFacts | null;
  list: ListFacts;
  add: ActionFacts;
  create: ActionFacts | null;
  cancel: ActionFacts | null;
  retry: ActionFacts | null;
  copy: ActionFacts | null;
  copyLabel: string;
  copied: boolean;
}>;

interface InputDomOverride {
  input: HTMLInputElement;
  value?: string;
  checked?: boolean;
}

interface ElementSlot<T extends HTMLElement> {
  readonly key: string;
  element: T | null;
  last: T | null;
  mouseTargets: readonly Node[] | null;
}

interface RowElements {
  root: ElementSlot<HTMLLIElement>;
  enable: ElementSlot<HTMLButtonElement>;
  test: ElementSlot<HTMLButtonElement>;
  delete: ElementSlot<HTMLButtonElement>;
}

interface PanelPublication {
  presentation: PanelPresentation;
  card: ElementSlot<HTMLDivElement>;
  header: ElementSlot<HTMLDivElement>;
  guidance: ElementSlot<HTMLParagraphElement>;
  add: ElementSlot<HTMLButtonElement>;
  form: ElementSlot<HTMLFormElement>;
  url: ElementSlot<HTMLInputElement>;
  docs: ElementSlot<HTMLInputElement>;
  choices: ElementSlot<HTMLInputElement>[];
  create: ElementSlot<HTMLButtonElement>;
  cancel: ElementSlot<HTMLButtonElement>;
  listError: ElementSlot<HTMLDivElement>;
  listAlert: ElementSlot<HTMLSpanElement>;
  retry: ElementSlot<HTMLButtonElement>;
  actionError: ElementSlot<HTMLDivElement>;
  created: ElementSlot<HTMLDivElement>;
  secret: ElementSlot<HTMLElement>;
  copy: ElementSlot<HTMLButtonElement>;
  listContent: ElementSlot<HTMLElement>;
  rowsList: ElementSlot<HTMLUListElement>;
  rows: RowElements[];
  established: boolean;
  layoutRetired: boolean;
  consumed: boolean;
  successorRequested: boolean;
  invalidReplay: boolean;
  replayRefs: RefReplay[];
  stableSlots: Set<ElementSlot<HTMLElement>>;
  introducedSlots: Set<ElementSlot<HTMLElement>>;
  dom: PanelDomSnapshot | null;
  placement: PanelPlacement | null;
  guard: PanelDomGuard | null;
  guardExpiryQueued: boolean;
  factsAreCurrent: (() => boolean) | null;
  domIsExact: ((override?: InputDomOverride) => boolean) | null;
  requestSuccessor: (() => void) | null;
}

interface RefReplay {
  readonly owner: ElementSlot<HTMLElement>;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

type PanelDomSnapshot = Readonly<{
  node: Node;
  nodeValue: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly PanelDomSnapshot[];
}>;

type PanelPlacementLink = Readonly<{
  node: Node;
  parent: Node;
  previousSibling: Node | null;
  nextSibling: Node | null;
}>;

type PanelPlacement = Readonly<{
  document: Document;
  links: readonly PanelPlacementLink[];
}>;

type PanelDomGuard = Readonly<{
  acceptReactCommit: (
    inputs: readonly HTMLInputElement[],
    finalDomIsExact: () => boolean,
  ) => void;
  isClean: () => boolean;
  release: () => void;
}>;

type PanelReplay = Readonly<{
  source: PanelPublication;
  dom: PanelDomSnapshot;
  placement: PanelPlacement;
  historyIsClean: () => boolean;
  release: () => void;
}>;

class PanelPublicationCoordinator {
  readonly callbackToken = Symbol("webhooks-callbacks");
  readonly #mount: MountGeneration;
  #current: PanelPublication | null = null;
  #successorOf: PanelPublication | null = null;
  #replay: PanelReplay | null = null;
  #teardownRevision = 0;
  readonly #retired = new WeakSet<PanelPublication>();
  readonly #claimedPublications = new WeakSet<PanelPublication>();
  readonly #claimedRows = new WeakSet<object>();
  readonly #claimedActions = new WeakSet<object>();
  readonly #claimedReactEvents = new WeakSet<object>();
  readonly #claimedNativeEvents = new WeakSet<Event>();

  constructor(mount: MountGeneration) {
    this.#mount = mount;
  }

  activate() {
    this.#teardownRevision += 1;
  }

  scheduleTeardown() {
    const revision = ++this.#teardownRevision;
    queueMicrotask(() => {
      if (revision !== this.#teardownRevision) return;
      const replay = this.#replay;
      this.#replay = null;
      replay?.release();
      const publications = new Set([
        this.#current,
        this.#successorOf,
        replay?.source ?? null,
      ]);
      for (const publication of publications) {
        publication?.guard?.release();
        if (publication) publication.guard = null;
      }
      this.#current = null;
      this.#successorOf = null;
    });
  }

  bind<T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    element: T | null,
  ) {
    if (owner.element === element) return;
    const previous = owner.element;
    const last = owner.last;
    owner.mouseTargets = null;
    owner.element = element;
    if (element) owner.last = element;
    if (!candidate.established) return;

    const slotOwner = owner as ElementSlot<HTMLElement>;
    const proof = candidate.replayRefs.find((entry) => entry.owner === slotOwner);
    if (!proof) {
      candidate.invalidReplay = true;
      this.retire(candidate, "element");
      return;
    }
    if (element === null && previous === proof.element && proof.element.isConnected) {
      proof.detached = true;
      proof.reattached = false;
    } else if (
      element === proof.element &&
      previous === null &&
      proof.detached &&
      proof.element.isConnected
    ) {
      proof.reattached = true;
    } else {
      candidate.invalidReplay = true;
    }

    const introducedReplayCompleted =
      candidate.introducedSlots.has(slotOwner) &&
      proof.detached &&
      proof.reattached;
    if (
      candidate.stableSlots.has(slotOwner) &&
      (element === null || (element !== null && last !== null && element !== last)) &&
      !candidate.introducedSlots.has(slotOwner)
    ) {
      this.retire(candidate, "element");
    }
    if (introducedReplayCompleted) {
      candidate.introducedSlots.delete(slotOwner);
      proof.detached = false;
      proof.reattached = false;
      const ownerWindow = proof.element.ownerDocument.defaultView;
      if (ownerWindow && proof.element instanceof ownerWindow.HTMLButtonElement) {
        slotOwner.mouseTargets = snapshotMouseTargets(proof.element);
      }
    }
    this.#requestReplaySuccessor(candidate);
  }

  establish(
    candidate: PanelPublication,
    factsAreCurrent: () => boolean,
    domIsExact: (override?: InputDomOverride) => boolean,
    requestSuccessor: () => void,
  ): (() => void) | undefined {
    candidate.factsAreCurrent = factsAreCurrent;
    candidate.domIsExact = domIsExact;
    candidate.requestSuccessor = requestSuccessor;
    if (candidate.established) {
      this.#requestReplaySuccessor(candidate);
      return undefined;
    }
    if (
      candidate.presentation.generation !== this.#mount ||
      !factsAreCurrent() ||
      !domIsExact()
    ) {
      return undefined;
    }
    const root = candidate.card.element;
    const placement = root ? capturePanelPlacement(root) : null;
    if (!root || !placement) return undefined;

    const pendingReplay = this.#replay;
    if (pendingReplay) {
      const sameAuthority =
        candidate.presentation.revision === pendingReplay.source.presentation.revision + 1 &&
        panelPresentationsMatch(pendingReplay.source.presentation, candidate.presentation);
      const exactReplay =
        sameAuthority &&
        this.#acceptsSuccessorOf(pendingReplay.source) &&
        pendingReplay.historyIsClean() &&
        pendingReplay.dom.node === root &&
        panelPlacementMatches(root, pendingReplay.placement) &&
        panelDomMatches(pendingReplay.dom);
      this.#replay = null;
      pendingReplay.release();
      if (this.#successorOf === pendingReplay.source) this.#successorOf = null;
      if (sameAuthority && !exactReplay) return undefined;
    }

    const guard = createPanelDomGuard(root, placement);
    if (!guard) return undefined;
    const expected = expectedPanelSlots(candidate);
    if (expected.some((owner) => !owner.element)) {
      guard.release();
      return undefined;
    }
    const predecessor = this.#current ?? this.#successorOf;
    if (
      predecessor &&
      predecessor.presentation.generation === candidate.presentation.generation
    ) {
      const predecessorElements = new Map(
        expectedPanelSlots(predecessor).map((owner) => [owner.key, owner.element]),
      );
      for (const owner of expected) {
        if (
          !predecessorElements.has(owner.key) ||
          predecessorElements.get(owner.key) !== owner.element
        ) {
          candidate.introducedSlots.add(owner);
        }
      }
    }
    const previous = this.#current;
    if (previous && previous !== candidate) this.retire(previous, "other");
    if (
      this.#retired.has(candidate) ||
      candidate.presentation.generation !== this.#mount
    ) {
      guard.release();
      return undefined;
    }

    candidate.established = true;
    candidate.stableSlots = new Set(expected);
    candidate.replayRefs = expected.map((owner) => ({
      owner,
      element: owner.element!,
      detached: false,
      reattached: false,
    }));
    candidate.dom = snapshotPanelDom(root);
    candidate.placement = placement;
    candidate.guard = guard;
    for (const owner of panelButtonSlots(candidate)) {
      owner.mouseTargets = owner.element ? snapshotMouseTargets(owner.element) : null;
    }
    this.#current = candidate;
    this.#successorOf = null;
    queueMicrotask(() => {
      if (this.#current === candidate && !this.#retired.has(candidate)) {
        this.#acceptInputReconciliation(candidate);
      }
      root.ownerDocument.defaultView?.setTimeout(
        () => candidate.introducedSlots.clear(),
        0,
      );
    });
    return () => {
      candidate.layoutRetired = true;
      this.retire(candidate, "layout");
      this.#requestReplaySuccessor(candidate);
    };
  }

  retire(candidate: PanelPublication, reason: "element" | "layout" | "other" = "other") {
    if (this.#retired.has(candidate)) return false;
    candidate.guard?.isClean();
    this.#retired.add(candidate);
    const wasCurrent = this.#current === candidate;
    if (wasCurrent) {
      this.#current = null;
      this.#successorOf = candidate;
    }
    if (reason === "other") {
      candidate.guard?.release();
      candidate.guard = null;
    } else {
      this.#scheduleGuardExpiry(candidate);
    }
    return wasCurrent;
  }

  owns(candidate: PanelPublication) {
    const result =
      this.#current === candidate &&
      !this.#retired.has(candidate) &&
      !this.#claimedPublications.has(candidate) &&
      candidate.guard?.isClean() === true;
    return result;
  }

  reconcileReactCommit(candidate: PanelPublication) {
    if (
      this.#current !== candidate ||
      this.#retired.has(candidate) ||
      !candidate.dom
    ) {
      return;
    }
    this.#acceptInputReconciliation(candidate);
  }

  prepareControlClaim(candidate: PanelPublication, override?: InputDomOverride) {
    if (
      this.#current === candidate &&
      !this.#retired.has(candidate) &&
      !this.#claimedPublications.has(candidate)
    ) {
      this.#acceptInputReconciliation(candidate, override);
    }
  }

  #acceptInputReconciliation(candidate: PanelPublication, override?: InputDomOverride) {
    candidate.guard?.acceptReactCommit(
      [
        candidate.url.element,
        ...candidate.choices.map((choice) => choice.element),
        candidate.docs.element,
      ].filter((input): input is HTMLInputElement => input !== null),
      () =>
        candidate.factsAreCurrent?.() === true &&
        candidate.domIsExact?.(override) === true &&
        candidate.dom !== null &&
        panelDomMatches(candidate.dom),
    );
  }

  claim(
    candidate: PanelPublication,
    row: object | null,
    action: object,
    reactEvent: object,
    nativeEvent: Event,
  ) {
    if (
      !this.owns(candidate) ||
      (row !== null && this.#claimedRows.has(row)) ||
      this.#claimedActions.has(action) ||
      this.#claimedReactEvents.has(reactEvent) ||
      this.#claimedNativeEvents.has(nativeEvent)
    ) {
      return false;
    }
    this.#claimedPublications.add(candidate);
    if (row !== null) this.#claimedRows.add(row);
    this.#claimedActions.add(action);
    this.#claimedReactEvents.add(reactEvent);
    this.#claimedNativeEvents.add(nativeEvent);
    candidate.consumed = true;
    this.retire(candidate, "other");
    return true;
  }

  #acceptsSuccessorOf(candidate: PanelPublication) {
    return (
      this.#current === null &&
      this.#successorOf === candidate &&
      this.#retired.has(candidate) &&
      !this.#claimedPublications.has(candidate)
    );
  }

  #scheduleGuardExpiry(candidate: PanelPublication) {
    if (candidate.guardExpiryQueued) return;
    candidate.guardExpiryQueued = true;
    queueMicrotask(() => {
      if (this.#replay?.source !== candidate) {
        candidate.guard?.release();
        candidate.guard = null;
      }
    });
  }

  #requestReplaySuccessor(candidate: PanelPublication) {
    const exactReplay =
      this.#acceptsSuccessorOf(candidate) &&
      candidate.layoutRetired &&
      candidate.established &&
      !candidate.consumed &&
      !candidate.invalidReplay &&
      candidate.replayRefs.length > 0 &&
      candidate.replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element === entry.element &&
          entry.element.isConnected,
      ) &&
      candidate.factsAreCurrent?.() === true &&
      candidate.domIsExact?.() === true &&
      candidate.dom !== null &&
      candidate.placement !== null &&
      candidate.guard?.isClean() === true &&
      panelPlacementMatches(candidate.dom.node as HTMLElement, candidate.placement) &&
      panelDomMatches(candidate.dom);
    if (
      candidate.successorRequested ||
      !exactReplay ||
      !candidate.dom ||
      !candidate.placement ||
      !candidate.guard ||
      !candidate.requestSuccessor
    ) {
      return;
    }
    candidate.successorRequested = true;
    const guard = candidate.guard;
    this.#replay = Object.freeze({
      source: candidate,
      dom: candidate.dom,
      placement: candidate.placement,
      historyIsClean: guard.isClean,
      release: guard.release,
    });
    candidate.requestSuccessor();
  }
}

/** Checkbox labels; `suggestion` covers both decisions like the long-poll does. */
const EVENT_CHOICES = Object.freeze([
  Object.freeze({ id: "request.created", label: "request.created", types: Object.freeze(["request.created"]) }),
  Object.freeze({ id: "mention", label: "mention", types: Object.freeze(["mention"]) }),
  Object.freeze({ id: "comment.added", label: "comment.added", types: Object.freeze(["comment.added"]) }),
  Object.freeze({ id: "comment.replied", label: "comment.replied", types: Object.freeze(["comment.replied"]) }),
  Object.freeze({ id: "review.created", label: "review.created", types: Object.freeze(["review.created"]) }),
  Object.freeze({ id: "suggestion", label: "suggestion.accepted/rejected", types: Object.freeze(["suggestion.accepted", "suggestion.rejected"]) }),
  Object.freeze({ id: "content.changed", label: "content.changed", types: Object.freeze(["content.changed"]) }),
]);
const DEFAULT_CHOICES = Object.freeze(["request.created", "mention", "comment.added", "comment.replied"]);

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.text();
  const data = body ? JSON.parse(body) : null;
  if (!res.ok) {
    // Keep the 400's `issues` so the form can show the field's reason, not the bare "Invalid request".
    const err = (data ?? {}) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, err.error ?? res.statusText, err.issues);
  }
  return data as T;
}

function deliveryLabel(h: WebhookRow): { text: string; tone: DeliveryTone } {
  if (!h.active) return { text: `disabled after ${h.failures} failures`, tone: "bad" };
  if (!h.lastDelivery) return { text: "no deliveries yet", tone: "muted" };
  const d = h.lastDelivery;
  const ok = d.status >= 200 && d.status < 300;
  if (ok) return { text: `${d.status} · ${relativeTime(d.at)}`, tone: "ok" };
  if (h.failures === 0) return { text: `enabled · last attempt ${d.status || "no response"} · ${relativeTime(d.at)}`, tone: "muted" };
  return { text: `failed ×${h.failures}${d.status ? ` · ${d.status}` : " · no response"} · ${relativeTime(d.at)}`, tone: "bad" };
}

function snapshotRow(h: WebhookRow, index: number, operation: RowOperation | null): WebhookRowFacts {
  const events = Object.freeze([...h.events]);
  const documentIds = h.documentIds ? Object.freeze([...h.documentIds]) : null;
  const lastDelivery = h.lastDelivery
    ? Object.freeze({
        status: h.lastDelivery.status,
        at: h.lastDelivery.at,
        attempt: h.lastDelivery.attempt,
        event: h.lastDelivery.event,
      })
    : null;
  const status = deliveryLabel(h);
  const eligible = operation === null;
  return Object.freeze({
    source: h,
    index,
    id: h.id,
    url: h.url,
    events,
    documentIds,
    active: h.active,
    failures: h.failures,
    createdAt: h.createdAt,
    lastDelivery,
    details: `${events.join(", ")}${
      documentIds
        ? ` · ${documentIds.length} document${documentIds.length === 1 ? "" : "s"}`
        : " · all documents"
    } · added ${relativeTime(h.createdAt)}`,
    statusText: status.text,
    statusTone: status.tone,
    operation,
    enable: h.active
      ? null
      : Object.freeze({ kind: "enable" as const, eligible, route: `/api/webhooks/${h.id}/enable` }),
    test: Object.freeze({ kind: "test" as const, eligible, route: `/api/webhooks/${h.id}/test` }),
    delete: Object.freeze({ kind: "delete" as const, eligible, route: `/api/webhooks/${h.id}` }),
  });
}

function arraysMatch(current: readonly string[], snapshot: readonly string[]): boolean {
  return current.length === snapshot.length && current.every((value, index) => value === snapshot[index]);
}

function rowMatchesSnapshot(row: WebhookRow, snapshot: WebhookRowFacts): boolean {
  const delivery = row.lastDelivery;
  const frozenDelivery = snapshot.lastDelivery;
  return (
    row.id === snapshot.id &&
    row.url === snapshot.url &&
    arraysMatch(row.events, snapshot.events) &&
    (row.documentIds
      ? snapshot.documentIds !== null && arraysMatch(row.documentIds, snapshot.documentIds)
      : snapshot.documentIds === null) &&
    row.active === snapshot.active &&
    row.failures === snapshot.failures &&
    row.createdAt === snapshot.createdAt &&
    (delivery
      ? frozenDelivery !== null &&
        delivery.status === frozenDelivery.status &&
        delivery.at === frozenDelivery.at &&
        delivery.attempt === frozenDelivery.attempt &&
        delivery.event === frozenDelivery.event
      : frozenDelivery === null)
  );
}

function createdMatchesSnapshot(created: CreatedWebhook | null, snapshot: CreatedFacts | null): boolean {
  return created
    ? snapshot !== null &&
        created === snapshot.source &&
        created.id === snapshot.id &&
        created.secret === snapshot.secret &&
        created.url === snapshot.url
    : snapshot === null;
}

function snapshotMouseTargets(control: HTMLButtonElement): readonly Node[] {
  return Object.freeze([control, ...Array.from(control.querySelectorAll("*"))]);
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

function panelDomMatches(snapshot: PanelDomSnapshot): boolean {
  if (snapshot.node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = snapshotPanelAttributes(snapshot.node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some(([name, value], index) => {
      const expected = snapshot.attributes?.[index];
      return !expected || expected[0] !== name || expected[1] !== value;
    })
  ) {
    return false;
  }
  return (
    snapshot.node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        snapshot.node.childNodes.item(index) === child.node &&
        panelDomMatches(child),
    )
  );
}

function capturePanelPlacement(root: HTMLElement): PanelPlacement | null {
  const document = root.ownerDocument;
  if (!root.isConnected) return null;
  const links: PanelPlacementLink[] = [];
  let node: Node = root;
  while (node !== document) {
    const parent = node.parentNode;
    if (!parent) return null;
    links.push(Object.freeze({
      node,
      parent,
      previousSibling: node.previousSibling,
      nextSibling: node.nextSibling,
    }));
    node = parent;
  }
  if (links.length === 0) return null;
  return Object.freeze({
    document,
    links: Object.freeze(links),
  });
}

function panelPlacementMatches(root: HTMLElement, placement: PanelPlacement): boolean {
  return (
    root.ownerDocument === placement.document &&
    root.isConnected &&
    placement.links[0]?.node === root &&
    placement.links.every((link) =>
      link.node.isConnected &&
      link.node.parentNode === link.parent &&
      link.node.previousSibling === link.previousSibling &&
      link.node.nextSibling === link.nextSibling
    ) &&
    placement.links.at(-1)?.parent === placement.document
  );
}

function createPanelDomGuard(
  root: HTMLElement,
  placement: PanelPlacement,
): PanelDomGuard | null {
  const MutationObserverConstructor = placement.document.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  let released = false;
  const pendingRecords: MutationRecord[] = [];
  const takeRecords = () => {
    const records = [...pendingRecords, ...observer.takeRecords()];
    pendingRecords.length = 0;
    return records;
  };
  const recordChanges = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((record) => {
      if (record.target === root || root.contains(record.target)) return true;
      if (record.type !== "childList") return false;
      return placement.links.some((link) =>
        record.target === link.parent &&
        (
          record.previousSibling === link.node ||
          record.nextSibling === link.node ||
          [...record.addedNodes, ...record.removedNodes].includes(link.node)
        )
      );
    });
  };
  const observer = new MutationObserverConstructor((records) => {
    pendingRecords.push(...records);
  });
  observer.observe(root, {
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  for (const parent of new Set(placement.links.map((link) => link.parent))) {
    observer.observe(parent, { childList: true });
  }
  const exactReactInputRecords = (
    records: readonly MutationRecord[],
    inputs: readonly HTMLInputElement[],
  ) => {
    if (records.length === 0) return true;
    for (let index = 0; index < records.length;) {
      const nameStart = records[index];
      const possibleType = records[index + 1];
      const hasTypeReset =
        possibleType?.type === "attributes" &&
        possibleType.attributeName === "type" &&
        possibleType.target === nameStart?.target;
      const nameEnd = records[index + (hasTypeReset ? 2 : 1)];
      if (
        nameStart?.type !== "attributes" ||
        nameStart.attributeName !== "name" ||
        nameStart.oldValue !== null ||
        !(nameStart.target instanceof placement.document.defaultView!.HTMLInputElement) ||
        !inputs.includes(nameStart.target) ||
        nameEnd?.type !== "attributes" ||
        nameEnd.attributeName !== "name" ||
        nameEnd.target !== nameStart.target ||
        nameEnd.oldValue !== "" ||
        nameStart.target.hasAttribute("name") ||
        (hasTypeReset &&
          possibleType.oldValue !== nameStart.target.getAttribute("type"))
      ) {
        return false;
      }
      index += hasTypeReset ? 3 : 2;
    }
    return true;
  };
  return Object.freeze({
    acceptReactCommit: (inputs, finalDomIsExact) => {
      const records = takeRecords();
      if (
        records.length > 0 &&
        exactReactInputRecords(records, inputs) &&
        finalDomIsExact()
      ) {
        return;
      }
      recordChanges(records);
    },
    isClean: () => {
      recordChanges(takeRecords());
      return !changed;
    },
    release: () => {
      if (released) return;
      released = true;
      recordChanges(takeRecords());
      observer.disconnect();
    },
  });
}

function actionFactsMatch(
  left: ActionFacts | RowActionFacts | null,
  right: ActionFacts | RowActionFacts | null,
) {
  return left === null
    ? right === null
    : right !== null &&
        left.kind === right.kind &&
        left.eligible === right.eligible &&
        left.route === right.route;
}

function panelPresentationsMatch(
  left: PanelPresentation,
  right: PanelPresentation,
): boolean {
  if (
    left.callbackToken !== right.callbackToken ||
    left.generation !== right.generation ||
    left.hooksSource !== right.hooksSource ||
    left.choicesSource !== right.choicesSource ||
    left.rowOperationsSource !== right.rowOperationsSource ||
    left.createdSource !== right.createdSource ||
    left.adding !== right.adding ||
    left.draft.url !== right.draft.url ||
    left.draft.docs !== right.draft.docs ||
    !arraysMatch(left.draft.choices, right.draft.choices) ||
    left.createOperation !== right.createOperation ||
    left.retryOperation !== right.retryOperation ||
    left.feedbackOperation !== right.feedbackOperation ||
    left.listError !== right.listError ||
    left.actionError !== right.actionError ||
    !createdMatchesSnapshot(left.createdSource, right.created) ||
    !createdMatchesSnapshot(right.createdSource, left.created) ||
    left.list.kind !== right.list.kind ||
    left.copyLabel !== right.copyLabel ||
    left.copied !== right.copied ||
    !actionFactsMatch(left.add, right.add) ||
    !actionFactsMatch(left.create, right.create) ||
    !actionFactsMatch(left.cancel, right.cancel) ||
    !actionFactsMatch(left.retry, right.retry) ||
    !actionFactsMatch(left.copy, right.copy)
  ) {
    return false;
  }
  if (
    left.draft.choiceInputs.length !== right.draft.choiceInputs.length ||
    left.draft.choiceInputs.some((choice, index) => {
      const candidate = right.draft.choiceInputs[index];
      return (
        !candidate ||
        choice.index !== candidate.index ||
        choice.id !== candidate.id ||
        choice.label !== candidate.label ||
        !arraysMatch(choice.types, candidate.types) ||
        choice.checked !== candidate.checked ||
        choice.eligible !== candidate.eligible
      );
    })
  ) {
    return false;
  }
  const leftRows = left.list.rows;
  const rightRows = right.list.rows;
  if (leftRows === null || rightRows === null) return leftRows === rightRows;
  return (
    leftRows.length === rightRows.length &&
    leftRows.every((row, index) => {
      const candidate = rightRows[index];
      return (
        !!candidate &&
        row.source === candidate.source &&
        rowMatchesSnapshot(row.source, candidate) &&
        row.index === candidate.index &&
        row.details === candidate.details &&
        row.statusText === candidate.statusText &&
        row.statusTone === candidate.statusTone &&
        row.operation === candidate.operation &&
        actionFactsMatch(row.enable, candidate.enable) &&
        actionFactsMatch(row.test, candidate.test) &&
        actionFactsMatch(row.delete, candidate.delete)
      );
    })
  );
}

function isNativeReactMouseEvent(
  event: ReactMouseEvent<HTMLButtonElement>,
  control: HTMLButtonElement | null,
  mouseTargets: readonly Node[] | null,
  root: HTMLElement | null,
): MouseEvent | null {
  const ownerWindow = control?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  const target = event.target;
  return (
    !!control &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === control.ownerDocument &&
    event.currentTarget === control &&
    event.type === "click" &&
    event.button === 0 &&
    event.bubbles &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeEvent.type === "click" &&
    nativeEvent.button === 0 &&
    nativeEvent.bubbles &&
    nativeEvent.cancelable &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    nativeEvent.target === target &&
    target instanceof ownerWindow.Node &&
    target.ownerDocument === control.ownerDocument &&
    control.contains(target) &&
    root.contains(control) &&
    nativeEvent.composedPath().includes(control) &&
    nativeEvent.composedPath().includes(root) &&
    mouseTargets?.includes(target) === true
  ) ? nativeEvent : null;
}

function isNativeReactInputEvent(
  event: ChangeEvent<HTMLInputElement>,
  input: HTMLInputElement | null,
  root: HTMLElement | null,
): Event | null {
  const ownerWindow = input?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  return (
    !!input &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === input.ownerDocument &&
    (event.type === "input" || event.type === "change") &&
    event.currentTarget === input &&
    event.target === input &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    (nativeEvent.type === "input" ||
      nativeEvent.type === "change" ||
      nativeEvent.type === "click") &&
    (!(nativeEvent instanceof ownerWindow.MouseEvent) || nativeEvent.button === 0) &&
    nativeEvent.bubbles &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    !nativeEvent.defaultPrevented &&
    nativeEvent.target === input &&
    nativeEvent.composedPath().includes(input) &&
    nativeEvent.composedPath().includes(root)
  ) ? nativeEvent : null;
}

function isNativeReactSubmitEvent(
  event: FormEvent<HTMLFormElement>,
  form: HTMLFormElement | null,
  root: HTMLElement | null,
): Event | null {
  const ownerWindow = form?.ownerDocument.defaultView;
  const nativeEvent = event?.nativeEvent;
  return (
    !!form &&
    !!root &&
    !!ownerWindow &&
    root.ownerDocument === form.ownerDocument &&
    event.type === "submit" &&
    event.currentTarget === form &&
    event.target === form &&
    !event.defaultPrevented &&
    nativeEvent instanceof ownerWindow.Event &&
    nativeEvent.type === "submit" &&
    nativeEvent.bubbles &&
    nativeEvent.cancelable &&
    nativeEvent.eventPhase !== ownerWindow.Event.NONE &&
    nativeEvent.target === form &&
    nativeEvent.composedPath().includes(form) &&
    nativeEvent.composedPath().includes(root) &&
    !nativeEvent.defaultPrevented
  ) ? nativeEvent : null;
}

function slot<T extends HTMLElement>(key: string): ElementSlot<T> {
  return { key, element: null, last: null, mouseTargets: null };
}

function createPanelPublication(presentation: PanelPresentation): PanelPublication {
  const publication: PanelPublication = {
    presentation,
    card: slot("card"),
    header: slot("header"),
    guidance: slot("guidance"),
    add: slot("add"),
    form: slot("form"),
    url: slot("url"),
    docs: slot("docs"),
    choices: presentation.draft.choiceInputs.map((choice) =>
      slot<HTMLInputElement>(`choice:${choice.id}`)),
    create: slot("create"),
    cancel: slot("cancel"),
    listError: slot("list-error"),
    listAlert: slot("list-alert"),
    retry: slot("retry"),
    actionError: slot("action-error"),
    created: slot("created"),
    secret: slot("secret"),
    copy: slot("copy"),
    listContent: slot("list-content"),
    rowsList: slot("rows-list"),
    rows: presentation.list.rows?.map((row) => ({
      root: slot<HTMLLIElement>(`row:${row.index}:${row.id}`),
      enable: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:enable`),
      test: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:test`),
      delete: slot<HTMLButtonElement>(`row:${row.index}:${row.id}:delete`),
    })) ?? [],
    established: false,
    layoutRetired: false,
    consumed: false,
    successorRequested: false,
    invalidReplay: false,
    replayRefs: [],
    stableSlots: new Set(),
    introducedSlots: new Set(),
    dom: null,
    placement: null,
    guard: null,
    guardExpiryQueued: false,
    factsAreCurrent: null,
    domIsExact: null,
    requestSuccessor: null,
  };
  return publication;
}

function expectedPanelSlots(
  publication: PanelPublication,
): ElementSlot<HTMLElement>[] {
  const facts = publication.presentation;
  const slots: ElementSlot<HTMLElement>[] = [
    publication.card,
    publication.header,
    publication.guidance,
    publication.add,
  ];
  if (facts.adding) {
    slots.push(
      publication.form,
      publication.url,
      ...publication.choices,
      publication.docs,
      publication.create,
      publication.cancel,
    );
  }
  if (facts.listError) {
    slots.push(
      publication.listError,
      publication.listAlert,
      publication.retry,
    );
  }
  if (facts.actionError) slots.push(publication.actionError);
  if (facts.created) {
    slots.push(
      publication.created,
      publication.secret,
      publication.copy,
    );
  }
  if (facts.list.kind === "loading" || facts.list.kind === "empty") {
    slots.push(publication.listContent);
  } else if (facts.list.kind === "rows") {
    slots.push(publication.listContent, publication.rowsList);
    for (const row of facts.list.rows ?? []) {
      const elements = publication.rows[row.index];
      if (!elements) continue;
      slots.push(elements.root);
      if (row.enable) slots.push(elements.enable);
      slots.push(elements.test, elements.delete);
    }
  }
  return slots;
}

function panelButtonSlots(
  publication: PanelPublication,
): ElementSlot<HTMLButtonElement>[] {
  const facts = publication.presentation;
  const slots = [publication.add];
  if (facts.adding) slots.push(publication.cancel);
  if (facts.listError) slots.push(publication.retry);
  if (facts.created) slots.push(publication.copy);
  for (const row of facts.list.rows ?? []) {
    const elements = publication.rows[row.index];
    if (!elements) continue;
    if (row.enable) slots.push(elements.enable);
    slots.push(elements.test, elements.delete);
  }
  return slots;
}

export function WebhooksPanel() {
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [choices, setChoices] = useState<string[]>(() => [...DEFAULT_CHOICES]);
  const [docs, setDocs] = useState("");
  const [createOperation, setCreateOperation] = useState<Operation | null>(null);
  const [rowOperations, setRowOperations] = useState<Map<string, RowOperation>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [retryOperation, setRetryOperation] = useState<Operation | null>(null);
  const [feedbackOperation, setFeedbackOperation] = useState<Operation | null>(null);
  const [created, setCreated] = useState<CreatedWebhook | null>(null);
  const [mountGeneration] = useState<MountGeneration>(() => Object.freeze({ identity: Symbol("webhooks-mount") }));
  const [publicationRevision, setPublicationRevision] = useState(0);
  const activeMountRef = useRef<MountGeneration | null>(null);
  const operationSequence = useRef(0);
  const createOwner = useRef<Operation | null>(null);
  const rowOwners = useRef(new Map<string, RowOperation>());
  const feedbackOwner = useRef<Operation | null>(null);
  const retryOwner = useRef<Operation | null>(null);
  const listRequest = useRef(0);
  const [publicationCoordinator] = useState(
    () => new PanelPublicationCoordinator(mountGeneration),
  );
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const secretTarget = useRef<HTMLElement>(null);
  const {
    copy: currentCopySecret,
    label: copyLabel,
    copied,
  } = useCopy(created?.secret ?? "", secretTarget);
  const copyCallbackRef = useRef<(() => void) | null>(null);
  const [copySecret] = useState<() => void>(
    () => () => copyCallbackRef.current?.(),
  );

  useLayoutEffect(() => {
    copyCallbackRef.current = currentCopySecret;
    return () => {
      if (copyCallbackRef.current === currentCopySecret) {
        copyCallbackRef.current = null;
      }
    };
  }, [currentCopySecret]);

  useLayoutEffect(() => {
    const owners = rowOwners.current;
    publicationCoordinator.activate();
    activeMountRef.current = mountGeneration;
    return () => {
      publicationCoordinator.scheduleTeardown();
      if (activeMountRef.current !== mountGeneration) return;
      activeMountRef.current = null;
      listRequest.current += 1;
      if (retryOwner.current?.generation === mountGeneration) retryOwner.current = null;
      if (createOwner.current?.generation === mountGeneration) createOwner.current = null;
      for (const [webhookId, operation] of owners) {
        if (operation.generation === mountGeneration) owners.delete(webhookId);
      }
      if (feedbackOwner.current?.generation === mountGeneration) feedbackOwner.current = null;
    };
  }, [mountGeneration, publicationCoordinator]);

  const load = useCallback(async (continuationIsCurrent: () => boolean = () => true) => {
    const generation = activeMountRef.current;
    if (!generation) return;
    const currentRequest = ++listRequest.current;
    try {
      const res = await request<{ webhooks: WebhookRow[] }>("/api/webhooks");
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setHooks(res.webhooks);
      setListError(null);
    } catch (e) {
      if (generation !== activeMountRef.current || currentRequest !== listRequest.current || !continuationIsCurrent()) return;
      setListError(apiErrorText(e, "Failed to load webhooks"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isCreateCurrent = (operation: Operation) =>
    operation.generation === activeMountRef.current && createOwner.current === operation;

  const isRetryCurrent = (operation: Operation) =>
    operation.generation === activeMountRef.current && retryOwner.current === operation;

  const isRowCurrent = (operation: RowOperation) =>
    operation.generation === activeMountRef.current && rowOwners.current.get(operation.webhookId) === operation;

  const nextOperation = (): Operation | null => {
    const generation = activeMountRef.current;
    if (!generation) return null;
    return Object.freeze({
      sequence: ++operationSequence.current,
      generation,
    });
  };

  const claimFeedback = (operation: Operation) => {
    feedbackOwner.current = operation;
    setFeedbackOperation(operation);
    setError(null);
  };

  const beginRowOperation = (webhookId: string, kind: RowOperation["kind"]): RowOperation | null => {
    const generation = activeMountRef.current;
    if (!generation || rowOwners.current.has(webhookId)) return null;
    const operation = Object.freeze({
      sequence: ++operationSequence.current,
      generation,
      webhookId,
      kind,
    });
    claimFeedback(operation);
    rowOwners.current.set(webhookId, operation);
    setRowOperations((current) => new Map(current).set(webhookId, operation));
    return operation;
  };

  const finishRowOperation = (operation: RowOperation) => {
    if (!isRowCurrent(operation)) return;
    rowOwners.current.delete(operation.webhookId);
    setRowOperations((current) => {
      if (current.get(operation.webhookId) !== operation) return current;
      const next = new Map(current);
      next.delete(operation.webhookId);
      return next;
    });
  };

  const setOperationError = (operation: Operation, message: string) => {
    if (operation.generation === activeMountRef.current && feedbackOwner.current === operation) {
      setError(message);
    }
  };

  const startCreate = (presentation: PanelPresentation) => {
    if (createOwner.current) return;
    const operation = nextOperation();
    if (!operation) return;
    claimFeedback(operation);
    createOwner.current = operation;
    setCreateOperation(operation);
    const exactUrl = presentation.draft.url;
    const exactDocs = presentation.draft.docs;
    const exactChoices = presentation.draft.choiceInputs;
    const events = exactChoices.filter((choice) => choice.checked).flatMap((choice) => [...choice.types]);
    const documentIds = exactDocs
      .split(/[\s,]+/)
      .map((value) => value.trim().replace(/^.*\/d\//, ""))
      .filter(Boolean);
    void (async () => {
      try {
        const res = await request<{ webhook: WebhookRow & { secret: string } }>(presentation.create!.route!, {
          method: "POST",
          body: JSON.stringify({ url: exactUrl, events, documentIds: documentIds.length ? documentIds : null }),
        });
        if (!isCreateCurrent(operation)) return;
        setCreated({ id: res.webhook.id, secret: res.webhook.secret, url: res.webhook.url });
        setUrl("");
        setDocs("");
        setAdding(false);
        await load(() => isCreateCurrent(operation));
      } catch (e) {
        if (isCreateCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not add webhook"));
        }
      } finally {
        if (isCreateCurrent(operation)) {
          createOwner.current = null;
          setCreateOperation((current) => (current === operation ? null : current));
        }
      }
    })();
  };

  const startRetry = (route: string) => {
    if (route !== "/api/webhooks" || retryOwner.current) return;
    const operation = nextOperation();
    if (!operation) return;
    retryOwner.current = operation;
    setRetryOperation(operation);
    void load(() => isRetryCurrent(operation)).finally(() => {
      if (!isRetryCurrent(operation)) return;
      retryOwner.current = null;
      setRetryOperation((current) => (current === operation ? null : current));
    });
  };

  const startTest = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "test");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.test.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Test failed"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startEnable = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "enable");
    if (!operation || !row.enable) return;
    void (async () => {
      try {
        await request<{ webhook: WebhookRow }>(row.enable!.route, { method: "POST" });
        if (!isRowCurrent(operation)) return;
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not enable webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const startDelete = (row: WebhookRowFacts) => {
    const operation = beginRowOperation(row.id, "delete");
    if (!operation) return;
    void (async () => {
      try {
        await request(row.delete.route, { method: "DELETE" });
        if (!isRowCurrent(operation)) return;
        setCreated((current) => (current?.id === row.id ? null : current));
        await load(() => isRowCurrent(operation));
      } catch (e) {
        if (isRowCurrent(operation)) {
          setOperationError(operation, apiErrorText(e, "Could not delete webhook"));
        }
      } finally {
        finishRowOperation(operation);
      }
    })();
  };

  const presentation = useMemo<PanelPresentation>(() => {
    const choiceInputs = Object.freeze(
      EVENT_CHOICES.map((choice, index) =>
        Object.freeze<ChoiceFacts>({
          kind: "choice",
          index,
          id: choice.id,
          label: choice.label,
          types: choice.types,
          checked: choices.includes(choice.id),
          eligible: createOperation === null,
        }),
      ),
    );
    const draft = Object.freeze<DraftFacts>({
      url,
      docs,
      choices: Object.freeze([...choices]),
      urlInput: Object.freeze({ kind: "url", value: url, eligible: createOperation === null }),
      docsInput: Object.freeze({ kind: "docs", value: docs, eligible: createOperation === null }),
      choiceInputs,
    });
    const rowFacts = hooks
      ? Object.freeze(
          hooks.map((hook, index) =>
            snapshotRow(hook, index, rowOperations.get(hook.id) ?? null)),
        )
      : null;
    const list = Object.freeze<ListFacts>({
      kind: hooks === null
        ? (listError ? "unavailable" : "loading")
        : hooks.length === 0
          ? "empty"
          : "rows",
      rows: rowFacts,
    });
    const createdFacts = created
      ? Object.freeze<CreatedFacts>({
          source: created,
          id: created.id,
          secret: created.secret,
          url: created.url,
        })
      : null;
    return Object.freeze({
      identity: Symbol("webhooks-presentation"),
      revision: publicationRevision,
      callbackToken: publicationCoordinator.callbackToken,
      generation: mountGeneration,
      hooksSource: hooks,
      choicesSource: choices,
      rowOperationsSource: rowOperations,
      createdSource: created,
      adding,
      draft,
      createOperation,
      retryOperation,
      feedbackOperation,
      listError,
      actionError: error,
      created: createdFacts,
      list,
      add: Object.freeze({ kind: "add", eligible: createOperation === null, route: null }),
      create: adding
        ? Object.freeze({
            kind: "create",
            eligible: createOperation === null && url.trim().length > 0 && choices.length > 0,
            route: "/api/webhooks",
          })
        : null,
      cancel: adding
        ? Object.freeze({ kind: "cancel", eligible: createOperation === null, route: null })
        : null,
      retry: listError
        ? Object.freeze({
            kind: "retry",
            eligible: retryOperation === null,
            route: "/api/webhooks",
          })
        : null,
      copy: created
        ? Object.freeze({ kind: "copy", eligible: true, route: null })
        : null,
      copyLabel,
      copied,
    });
  }, [
    adding,
    choices,
    copied,
    copyLabel,
    createOperation,
    created,
    docs,
    error,
    feedbackOperation,
    hooks,
    listError,
    mountGeneration,
    publicationCoordinator,
    publicationRevision,
    retryOperation,
    rowOperations,
    url,
  ]);
  const publication = useMemo(
    () => createPanelPublication(presentation),
    [presentation],
  );

  const bindElement = <T extends HTMLElement>(
    candidate: PanelPublication,
    owner: ElementSlot<T>,
    element: T | null,
  ) => {
    publicationCoordinator.bind(candidate, owner, element);
  };

  const domIsExact = useCallback((
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean => {
    const facts = candidate.presentation;
    const card = candidate.card.element;
    const header = candidate.header.element;
    const guidance = candidate.guidance.element;
    const addButton = candidate.add.element;
    if (
      !card ||
      !header ||
      !guidance ||
      !addButton ||
      !card.ownerDocument.defaultView ||
      expectedPanelSlots(candidate).some(
        (owner) =>
          !owner.element ||
          owner.element.ownerDocument !== card.ownerDocument,
      ) ||
      !card.isConnected ||
      !header.isConnected ||
      !guidance.isConnected ||
      !addButton.isConnected ||
      card.id !== "webhooks" ||
      card.dataset.testid !== "webhooks-card" ||
      card.children.item(0) !== header ||
      card.children.item(1) !== guidance ||
      header.parentElement !== card ||
      guidance.parentElement !== card ||
      header.lastElementChild !== addButton ||
      addButton.parentElement !== header ||
      addButton.type !== "button" ||
      ((!focus || focus === addButton) && addButton.disabled !== !facts.add.eligible) ||
      addButton.dataset.testid !== "webhook-add" ||
      addButton.textContent?.trim() !== "Add webhook"
    ) {
      return false;
    }

    const directChildren: HTMLElement[] = [header, guidance];
    const form = candidate.form.element;
    if (facts.adding) {
      const urlInput = candidate.url.element;
      const docsInput = candidate.docs.element;
      const createButton = candidate.create.element;
      const cancelButton = candidate.cancel.element;
      if (
        !facts.create ||
        !facts.cancel ||
        !form ||
        !urlInput ||
        !docsInput ||
        !createButton ||
        !cancelButton ||
        !form.isConnected ||
        !urlInput.isConnected ||
        !docsInput.isConnected ||
        !createButton.isConnected ||
        !cancelButton.isConnected ||
        form.parentElement !== card ||
        form.dataset.testid !== "webhook-form" ||
        form.getAttribute("aria-busy") !== (facts.createOperation ? "true" : null) ||
        form.children.length !== 4 ||
        urlInput.form !== form ||
        docsInput.form !== form ||
        createButton.form !== form ||
        cancelButton.form !== form ||
        form.children.item(0) !== urlInput.parentElement ||
        form.children.item(2) !== docsInput.parentElement ||
        form.children.item(3) !== createButton.parentElement ||
        createButton.parentElement !== cancelButton.parentElement ||
        createButton.parentElement?.children.length !== 2 ||
        createButton.parentElement.children.item(0) !== createButton ||
        createButton.parentElement.children.item(1) !== cancelButton ||
        urlInput.dataset.testid !== "webhook-url" ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.value !== (override?.input === urlInput && override.value !== undefined ? override.value : facts.draft.url)) ||
        ((!focus || focus === createButton || focus === urlInput) &&
          urlInput.disabled !== !facts.draft.urlInput.eligible) ||
        !urlInput.required ||
        docsInput.dataset.testid !== "webhook-docs" ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.value !== (override?.input === docsInput && override.value !== undefined ? override.value : facts.draft.docs)) ||
        ((!focus || focus === createButton || focus === docsInput) &&
          docsInput.disabled !== !facts.draft.docsInput.eligible) ||
        createButton.dataset.testid !== "webhook-create" ||
        createButton.type !== "submit" ||
        ((!focus || focus === createButton) && createButton.disabled !== !facts.create.eligible) ||
        createButton.textContent?.trim() !== "Add webhook" ||
        cancelButton.type !== "button" ||
        ((!focus || focus === cancelButton) && cancelButton.disabled !== !facts.cancel.eligible) ||
        cancelButton.textContent?.trim() !== "Cancel"
      ) {
        return false;
      }
      const fieldset = form.children.item(1);
      const choicesContainer = fieldset?.children.item(1);
      if (
        !(fieldset instanceof card.ownerDocument.defaultView.HTMLFieldSetElement) ||
        fieldset.disabled !== (facts.createOperation !== null) ||
        !choicesContainer ||
        choicesContainer.children.length !== facts.draft.choiceInputs.length ||
        candidate.choices.length !== facts.draft.choiceInputs.length
      ) {
        return false;
      }
      for (const choice of facts.draft.choiceInputs) {
        const input = candidate.choices[choice.index]?.element;
        const label: Element | null = choicesContainer.children.item(choice.index);
        if (
          !input ||
          !input.isConnected ||
          input.form !== form ||
          input.parentElement !== label ||
          label?.parentElement !== choicesContainer ||
          input.type !== "checkbox" ||
          input.dataset.testid !== `webhook-event-${choice.id}` ||
          ((!focus || focus === createButton || focus === input) &&
            input.checked !== (override?.input === input && override.checked !== undefined ? override.checked : choice.checked)) ||
          input.disabled ||
          ((!focus || focus === createButton || focus === input) &&
            input.matches(":disabled") !== !choice.eligible) ||
          label.textContent?.trim() !== choice.label
        ) {
          return false;
        }
      }
      directChildren.push(form);
    } else if (
      form ||
      candidate.url.element ||
      candidate.docs.element ||
      candidate.create.element ||
      candidate.cancel.element ||
      candidate.choices.some((choice) => choice.element)
    ) {
      return false;
    }

    const listErrorBlock = candidate.listError.element;
    const listAlert = candidate.listAlert.element;
    const retryButton = candidate.retry.element;
    if (facts.listError) {
      if (
        !facts.retry ||
        !listErrorBlock ||
        !listAlert ||
        !retryButton ||
        !listErrorBlock.isConnected ||
        !listAlert.isConnected ||
        !retryButton.isConnected ||
        listErrorBlock.parentElement !== card ||
        listErrorBlock.dataset.testid !== "webhooks-list-error" ||
        listErrorBlock.children.length !== 2 ||
        listErrorBlock.children.item(0) !== listAlert ||
        listErrorBlock.children.item(1) !== retryButton ||
        listAlert.parentElement !== listErrorBlock ||
        listAlert.getAttribute("role") !== "alert" ||
        listAlert.getAttribute("aria-atomic") !== "true" ||
        listAlert.textContent !== facts.listError ||
        retryButton.parentElement !== listErrorBlock ||
        retryButton.type !== "button" ||
        ((!focus || focus === retryButton) && retryButton.disabled !== !facts.retry.eligible) ||
        retryButton.getAttribute("aria-busy") !== (facts.retryOperation ? "true" : null) ||
        retryButton.textContent?.trim() !== (facts.retryOperation ? "Retrying…" : "Retry")
      ) {
        return false;
      }
      directChildren.push(listErrorBlock);
    } else if (listErrorBlock || listAlert || retryButton || facts.retry) {
      return false;
    }

    const actionError = candidate.actionError.element;
    if (facts.actionError) {
      if (
        !actionError ||
        !actionError.isConnected ||
        actionError.parentElement !== card ||
        actionError.dataset.testid !== "webhook-action-error" ||
        actionError.getAttribute("role") !== "alert" ||
        actionError.getAttribute("aria-atomic") !== "true" ||
        actionError.textContent !== facts.actionError
      ) {
        return false;
      }
      directChildren.push(actionError);
    } else if (actionError) {
      return false;
    }

    const createdRoot = candidate.created.element;
    if (facts.created) {
      const secret = candidate.secret.element;
      const copyButton = candidate.copy.element;
      const secretRow = secret?.parentElement;
      if (
        !facts.copy ||
        !createdRoot ||
        !secret ||
        !copyButton ||
        !secretRow ||
        !createdRoot.isConnected ||
        !secret.isConnected ||
        !copyButton.isConnected ||
        createdRoot.parentElement !== card ||
        createdRoot.dataset.testid !== "webhook-created" ||
        createdRoot.getAttribute("role") !== "status" ||
        createdRoot.getAttribute("aria-live") !== "polite" ||
        createdRoot.getAttribute("aria-atomic") !== "true" ||
        createdRoot.children.length !== 3 ||
        createdRoot.children.item(0)?.textContent !== "Webhook added. Copy the signing secret now; it will not be shown again." ||
        createdRoot.children.item(1) !== secretRow ||
        secretRow.parentElement !== createdRoot ||
        secretRow.children.length !== 2 ||
        secretRow.children.item(0) !== secret ||
        secretRow.children.item(1) !== copyButton ||
        secret.parentElement !== secretRow ||
        secret.dataset.testid !== "webhook-secret" ||
        secret.textContent !== facts.created.secret ||
        copyButton.parentElement !== secretRow ||
        copyButton.type !== "button" ||
        copyButton.disabled ||
        copyButton.getAttribute("aria-label") !== "Copy secret" ||
        copyButton.textContent?.trim() !== facts.copyLabel
      ) {
        return false;
      }
      directChildren.push(createdRoot);
    } else if (
      createdRoot ||
      candidate.secret.element ||
      candidate.copy.element ||
      facts.copy
    ) {
      return false;
    }

    const listContent = candidate.listContent.element;
    const rowsList = candidate.rowsList.element;
    if (facts.list.kind === "unavailable") {
      if (listContent || rowsList || candidate.rows.length !== 0) return false;
    } else if (facts.list.kind === "loading") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.textContent !== "Loading…" ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else if (facts.list.kind === "empty") {
      if (
        !listContent ||
        !listContent.isConnected ||
        listContent.parentElement !== card ||
        listContent.dataset.testid !== "webhooks-empty" ||
        listContent.textContent?.trim() !== "No webhooks yet." ||
        rowsList ||
        candidate.rows.length !== 0
      ) {
        return false;
      }
      directChildren.push(listContent);
    } else {
      const rows = facts.list.rows;
      if (
        !rows ||
        !listContent ||
        !rowsList ||
        listContent !== rowsList ||
        !rowsList.isConnected ||
        rowsList.parentElement !== card ||
        rowsList.children.length !== rows.length ||
        candidate.rows.length !== rows.length
      ) {
        return false;
      }
      for (const row of rows) {
        const elements = candidate.rows[row.index];
        const root = elements?.root.element;
        const enableButton = elements?.enable.element;
        const testButton = elements?.test.element;
        const deleteButton = elements?.delete.element;
        const status = root?.children.item(1);
        const content = root?.children.item(0);
        const expectedChildren = row.enable ? 5 : 4;
        const validateEligibility = !focus || (root?.contains(focus) ?? false);
        if (
          !elements ||
          !root ||
          !testButton ||
          !deleteButton ||
          !root.isConnected ||
          !testButton.isConnected ||
          !deleteButton.isConnected ||
          rowsList.children.item(row.index) !== root ||
          root.parentElement !== rowsList ||
          root.dataset.testid !== "webhook-row" ||
          root.children.length !== expectedChildren ||
          !content ||
          content.children.length !== 2 ||
          content.children.item(0)?.textContent !== row.url ||
          content.children.item(1)?.textContent !== row.details ||
          status?.getAttribute("data-testid") !== "webhook-status" ||
          status.textContent?.trim() !== row.statusText ||
          !status.classList.contains(row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3") ||
          testButton.parentElement !== root ||
          testButton.type !== "button" ||
          testButton.dataset.testid !== "webhook-test" ||
          (validateEligibility && testButton.disabled !== !row.test.eligible) ||
          testButton.textContent?.trim() !== "Send test" ||
          deleteButton.parentElement !== root ||
          deleteButton.type !== "button" ||
          deleteButton.dataset.testid !== "webhook-delete" ||
          (validateEligibility && deleteButton.disabled !== !row.delete.eligible) ||
          deleteButton.getAttribute("aria-label") !== `Delete webhook ${row.url}` ||
          root.lastElementChild !== deleteButton
        ) {
          return false;
        }
        if (row.enable) {
          if (
            !enableButton ||
            !enableButton.isConnected ||
            enableButton.parentElement !== root ||
            enableButton.type !== "button" ||
            enableButton.dataset.testid !== "webhook-enable" ||
            (validateEligibility && enableButton.disabled !== !row.enable.eligible) ||
            enableButton.textContent?.trim() !== "Enable" ||
            root.children.item(2) !== enableButton ||
            root.children.item(3) !== testButton
          ) {
            return false;
          }
        } else if (enableButton || root.children.item(2) !== testButton) {
          return false;
        }
      }
      directChildren.push(rowsList);
    }

    return (
      card.children.length === directChildren.length &&
      directChildren.every((element, index) => card.children.item(index) === element)
    );
  }, []);

  const factsAreCurrent = useCallback((candidate: PanelPublication): boolean => {
    const facts = candidate.presentation;
    if (
      activeMountRef.current !== facts.generation ||
      facts.generation !== mountGeneration ||
      facts.revision !== publicationRevision ||
      facts.callbackToken !== publicationCoordinator.callbackToken ||
      facts.hooksSource !== hooks ||
      facts.choicesSource !== choices ||
      facts.rowOperationsSource !== rowOperations ||
      facts.createdSource !== created ||
      facts.adding !== adding ||
      facts.draft.url !== url ||
      facts.draft.docs !== docs ||
      !arraysMatch(choices, facts.draft.choices) ||
      facts.createOperation !== createOperation ||
      facts.retryOperation !== retryOperation ||
      facts.feedbackOperation !== feedbackOperation ||
      feedbackOperation !== feedbackOwner.current ||
      facts.listError !== listError ||
      facts.actionError !== error ||
      facts.copyLabel !== copyLabel ||
      facts.copied !== copied ||
      !createdMatchesSnapshot(created, facts.created) ||
      (createOperation
        ? createOwner.current !== createOperation || createOperation.generation !== mountGeneration
        : createOwner.current !== null) ||
      (retryOperation
        ? retryOwner.current !== retryOperation || retryOperation.generation !== mountGeneration
        : retryOwner.current !== null)
    ) {
      return false;
    }
    const rows = facts.list.rows;
    if (hooks === null) {
      if (rows !== null) return false;
    } else {
      if (!rows || hooks.length !== rows.length || rowOperations.size !== rows.length - rows.filter((row) => row.operation === null).length) {
        return false;
      }
      for (const row of rows) {
        const current = hooks[row.index];
        const stateOperation = rowOperations.get(row.id) ?? null;
        const ownerOperation = rowOwners.current.get(row.id) ?? null;
        if (
          !current ||
          !rowMatchesSnapshot(current, row) ||
          stateOperation !== row.operation ||
          ownerOperation !== row.operation ||
          (row.operation &&
            (row.operation.generation !== mountGeneration ||
              row.operation.webhookId !== row.id))
        ) {
          return false;
        }
      }
    }
    return true;
  }, [
    adding,
    choices,
    copied,
    copyLabel,
    createOperation,
    created,
    docs,
    error,
    feedbackOperation,
    hooks,
    listError,
    mountGeneration,
    publicationCoordinator,
    publicationRevision,
    retryOperation,
    rowOperations,
    url,
  ]);

  const ownsPanel = (
    candidate: PanelPublication,
    override?: InputDomOverride,
    focus?: HTMLElement,
  ): boolean =>
    publicationCoordinator.owns(candidate) &&
    factsAreCurrent(candidate) &&
    domIsExact(candidate, override, focus);

  const ownsPanelAction = (
    candidate: PanelPublication,
    action: ActionFacts | RowActionFacts,
    element: HTMLButtonElement,
    owner: ElementSlot<HTMLButtonElement>,
  ): boolean =>
    action.eligible &&
    owner.element === element &&
    element.isConnected &&
    !element.disabled &&
    ownsPanel(candidate, undefined, element);

  const claimPublishedClick = (
    candidate: PanelPublication,
    row: WebhookRowFacts | CreatedFacts | null,
    action: ActionFacts | RowActionFacts,
    event: ReactMouseEvent<HTMLButtonElement>,
    owner: ElementSlot<HTMLButtonElement>,
  ) => {
    const nativeEvent = isNativeReactMouseEvent(
      event,
      owner.element,
      owner.mouseTargets,
      candidate.card.element,
    );
    if (nativeEvent) publicationCoordinator.prepareControlClaim(candidate);
    return Boolean(
      nativeEvent &&
      ownsPanelAction(candidate, action, event.currentTarget, owner) &&
      publicationCoordinator.claim(
        candidate,
        row,
        action,
        event,
        nativeEvent,
      ),
    );
  };

  useLayoutEffect(() => {
    return publicationCoordinator.establish(
      publication,
      () => factsAreCurrent(publication),
      (override) => domIsExact(publication, override),
      requestPublicationSuccessor,
    );
  }, [
    domIsExact,
    factsAreCurrent,
    publication,
    publicationCoordinator,
    requestPublicationSuccessor,
  ]);
  useLayoutEffect(() => {
    publicationCoordinator.reconcileReactCommit(publication);
  });

  return (
    <div
      ref={(element) => bindElement(publication, publication.card, element)}
      className="rounded-2xl border border-line bg-surface"
      id="webhooks"
      data-testid="webhooks-card"
    >
      <div
        ref={(element) => bindElement(publication, publication.header, element)}
        className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold text-ink"
      >
        <Webhook size={16} className="text-ink-3" /> Webhooks
        <button
          ref={(element) => bindElement(publication, publication.add, element)}
          type="button"
          className="btn btn-outline btn-sm ml-auto gap-1.5"
          onClick={(event) => {
           if (!claimPublishedClick(
             publication,
             null,
             presentation.add,
             event,
             publication.add,
           )) return;
           requestPublicationSuccessor();
           setAdding(!presentation.adding);
          }}
          disabled={!presentation.add.eligible}
          data-testid="webhook-add"
        >
          <Plus size={14} /> Add webhook
        </button>
      </div>
      <p
        ref={(element) => bindElement(publication, publication.guidance, element)}
        className="px-5 pt-3 text-sm leading-6 text-ink-3"
      >
        Push the events <code className="text-xs">markdoc_watch</code> returns to an HTTP endpoint instead of long-polling: a GitHub Actions job, a bot, a Slack bridge. Each
        delivery is a JSON <code className="text-xs">POST</code> with <code className="text-xs">X-Markdoc-Event</code>, <code className="text-xs">X-Markdoc-Delivery</code> and{" "}
        <code className="text-xs">X-Markdoc-Signature: sha256=&lt;HMAC of the body&gt;</code>; failures are retried after 10 s, 1 min and 10 min, and a hook is disabled after 20 in a row. After fixing the receiver, enable the same hook here without changing its signing secret.
      </p>

      {presentation.adding && (
        <form
          ref={(element) => bindElement(publication, publication.form, element)}
          className="m-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
          data-testid="webhook-form"
          aria-busy={presentation.createOperation !== null || undefined}
          onSubmit={(event) => {
            const renderedForm = publication.form.element ?? publication.form.last;
            const renderedCreateButton = publication.create.element ?? publication.create.last;
            const renderedRoot = publication.card.element ?? publication.card.last;
            const nativeEvent = isNativeReactSubmitEvent(
              event,
              renderedForm,
              renderedRoot,
            );
            const submitter = nativeEvent && "submitter" in nativeEvent
              ? nativeEvent.submitter
              : null;
            if (
              !renderedForm ||
              !renderedCreateButton ||
              !renderedRoot ||
              !nativeEvent ||
              !renderedForm.isConnected ||
              !renderedCreateButton.isConnected ||
              !renderedRoot.isConnected ||
              renderedCreateButton.form !== renderedForm ||
              (submitter !== null && submitter !== renderedCreateButton)
            ) {
              return;
            }
            event.preventDefault();
            publicationCoordinator.prepareControlClaim(publication);
            const form = publication.form.element;
            const createButton = publication.create.element;
            if (
              !presentation.create ||
              !form ||
              !createButton ||
              !ownsPanelAction(publication, presentation.create, createButton, publication.create) ||
              !publicationCoordinator.claim(
                publication,
                null,
                presentation.create,
                event,
                nativeEvent,
              )
            ) {
              return;
            }
            requestPublicationSuccessor();
            startCreate(presentation);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            URL
            <input
              ref={(element) => bindElement(publication, publication.url, element)}
              className="input"
              value={presentation.draft.url}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.url.element;
                const next = event.currentTarget.value;
                const nativeEvent = isNativeReactInputEvent(
                  event,
                  input,
                  publication.card.element,
                );
                if (nativeEvent && input) {
                  publicationCoordinator.prepareControlClaim(publication, { input, value: next });
                }
                if (
                  !input ||
                  !nativeEvent ||
                  next !== input.value ||
                  !presentation.draft.urlInput.eligible ||
                  next === presentation.draft.url ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !publicationCoordinator.claim(
                    publication,
                    null,
                    presentation.draft.urlInput,
                    event,
                    nativeEvent,
                  )
                ) {
                  return;
                }
                requestPublicationSuccessor();
                setUrl(next);
              }}
              placeholder="https://example.com/markdoc"
              data-testid="webhook-url"
              disabled={!presentation.draft.urlInput.eligible}
              required
            />
          </label>
          <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink-3" disabled={presentation.createOperation !== null}>
            <legend className="mb-1">Events</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {presentation.draft.choiceInputs.map((choice) => (
                <label key={choice.id} className="flex min-h-6 items-center gap-1.5 font-mono text-xs text-ink-2">
                  <input
                    ref={(element) => bindElement(publication, publication.choices[choice.index]!, element)}
                    type="checkbox"
                    checked={choice.checked}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      const input = publication.choices[choice.index]?.element;
                      const checked = event.currentTarget.checked;
                      const nativeEvent = isNativeReactInputEvent(
                        event,
                        input ?? null,
                        publication.card.element,
                      );
                      if (nativeEvent && input) {
                        publicationCoordinator.prepareControlClaim(publication, { input, checked });
                      }
                      if (
                        !input ||
                        !nativeEvent ||
                        checked !== input.checked ||
                        !choice.eligible ||
                        checked === choice.checked ||
                        !ownsPanel(publication, { input, checked }, input) ||
                        !publicationCoordinator.claim(
                          publication,
                          null,
                          choice,
                          event,
                          nativeEvent,
                        )
                      ) {
                        return;
                      }
                      requestPublicationSuccessor();
                      setChoices(
                        checked
                          ? [...presentation.draft.choices, choice.id]
                          : presentation.draft.choices.filter((id) => id !== choice.id),
                      );
                    }}
                    data-testid={`webhook-event-${choice.id}`}
                  />
                  {choice.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-3">
            Only these documents (optional: ids or links, comma or space separated)
            <input
              ref={(element) => bindElement(publication, publication.docs, element)}
              className="input"
              value={presentation.draft.docs}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const input = publication.docs.element;
                const next = event.currentTarget.value;
                const nativeEvent = isNativeReactInputEvent(
                  event,
                  input,
                  publication.card.element,
                );
                if (nativeEvent && input) {
                  publicationCoordinator.prepareControlClaim(publication, { input, value: next });
                }
                if (
                  !input ||
                  !nativeEvent ||
                  next !== input.value ||
                  !presentation.draft.docsInput.eligible ||
                  next === presentation.draft.docs ||
                  !ownsPanel(publication, { input, value: next }, input) ||
                  !publicationCoordinator.claim(
                    publication,
                    null,
                    presentation.draft.docsInput,
                    event,
                    nativeEvent,
                  )
                ) {
                  return;
                }
                requestPublicationSuccessor();
                setDocs(next);
              }}
              placeholder="Leave empty for every document you can see"
              data-testid="webhook-docs"
              disabled={!presentation.draft.docsInput.eligible}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              ref={(element) => bindElement(publication, publication.create, element)}
              type="submit"
              className="btn btn-primary btn-sm gap-1.5"
              disabled={!presentation.create?.eligible}
              data-testid="webhook-create"
            >
              {presentation.createOperation ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add webhook
            </button>
            <button
              ref={(element) => bindElement(publication, publication.cancel, element)}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={(event) => {
                if (!presentation.cancel || !claimPublishedClick(
                  publication,
                  null,
                  presentation.cancel,
                  event,
                  publication.cancel,
                )) return;
                requestPublicationSuccessor();
                setAdding(false);
              }}
              disabled={!presentation.cancel?.eligible}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {presentation.listError && (
        <div
          ref={(element) => bindElement(publication, publication.listError, element)}
          className="mx-5 mt-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          data-testid="webhooks-list-error"
        >
          <span
            ref={(element) => bindElement(publication, publication.listAlert, element)}
            className="min-w-0 flex-1"
            role="alert"
            aria-atomic="true"
          >
            {presentation.listError}
          </span>
          <button
            ref={(element) => bindElement(publication, publication.retry, element)}
            type="button"
            className="btn btn-outline btn-sm shrink-0 gap-1.5"
            onClick={(event) => {
             if (!presentation.retry || !claimPublishedClick(
               publication,
               null,
               presentation.retry,
               event,
               publication.retry,
             )) return;
             requestPublicationSuccessor();
              startRetry(presentation.retry.route!);
            }}
            disabled={!presentation.retry?.eligible}
            aria-busy={presentation.retryOperation !== null || undefined}
          >
            {presentation.retryOperation && <Loader2 size={14} className="animate-spin" />}
            {presentation.retryOperation ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {presentation.actionError && (
        <div
          ref={(element) => bindElement(publication, publication.actionError, element)}
          className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="webhook-action-error"
        >
          {presentation.actionError}
        </div>
      )}

      {presentation.created && (
        <div
          ref={(element) => bindElement(publication, publication.created, element)}
          className="m-5 rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/40"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="webhook-created"
        >
          <div className="mb-2 text-sm font-medium text-green-900 dark:text-green-200">Webhook added. Copy the signing secret now; it will not be shown again.</div>
          <div className="flex items-center gap-2">
            <code
              ref={(element) => {
                bindElement(publication, publication.secret, element);
                if (element) secretTarget.current = element;
              }}
              className="min-w-0 flex-1 select-text break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-[13px] text-ink"
              data-testid="webhook-secret"
            >
              {presentation.created.secret}
            </code>
            <button
              ref={(element) => bindElement(publication, publication.copy, element)}
              type="button"
              className="btn btn-outline btn-sm shrink-0 gap-1.5"
              onClick={(event) => {
                if (!presentation.copy || !claimPublishedClick(
                  publication,
                  presentation.created,
                  presentation.copy,
                  event,
                  publication.copy,
                )) return;
                requestPublicationSuccessor();
                copySecret();
              }}
              aria-label="Copy secret"
            >
              {presentation.copied
                ? <Check size={14} className="text-success" />
                : <Copy size={14} />}
              {presentation.copyLabel}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Verify each delivery with <code>HMAC-SHA256(secret, raw body)</code> against <code>X-Markdoc-Signature</code>. Press <em>Send test</em> below to see a delivery land.
          </p>
        </div>
      )}

      {presentation.list.kind === "loading" ? (
        <div
          ref={(element) => bindElement(publication, publication.listContent, element)}
          className="px-5 py-6 text-sm text-ink-3"
        >
          Loading…
        </div>
      ) : presentation.list.kind === "unavailable" ? null : presentation.list.kind === "empty" ? (
        <div
          ref={(element) => bindElement(publication, publication.listContent, element)}
          className="px-5 py-6 text-sm text-ink-3"
          data-testid="webhooks-empty"
        >
          No webhooks yet.
        </div>
      ) : (
        <ul
          ref={(element) => {
            bindElement(publication, publication.listContent, element);
            bindElement(publication, publication.rowsList, element);
          }}
          className="mt-3 divide-y divide-line border-t border-line"
        >
          {presentation.list.rows!.map((row) => {
            const rowElements = publication.rows[row.index]!;
            return (
              <li
                key={row.id}
                ref={(element) => bindElement(publication, rowElements.root, element)}
                className="flex items-center gap-4 px-5 py-3"
                data-testid="webhook-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-ink">{row.url}</div>
                  <div className="truncate text-xs text-ink-3">{row.details}</div>
                </div>
                <div
                  className={`shrink-0 text-xs ${row.statusTone === "ok" ? "text-success" : row.statusTone === "bad" ? "text-danger" : "text-ink-3"}`}
                  data-testid="webhook-status"
                >
                  {row.statusText}
                </div>
                {row.enable && (
                  <button
                    ref={(element) => bindElement(publication, rowElements.enable, element)}
                    type="button"
                    className="btn btn-outline btn-sm gap-1.5"
                    onClick={(event) => {
                     if (!row.enable || !claimPublishedClick(
                       publication,
                       row,
                       row.enable,
                       event,
                       rowElements.enable,
                     )) return;
                     requestPublicationSuccessor();
                      startEnable(row);
                    }}
                    disabled={!row.enable.eligible}
                    data-testid="webhook-enable"
                  >
                    {row.operation?.kind === "enable" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />} Enable
                  </button>
                )}
                <button
                  ref={(element) => bindElement(publication, rowElements.test, element)}
                  type="button"
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={(event) => {
                   if (!claimPublishedClick(
                     publication,
                     row,
                     row.test,
                     event,
                     rowElements.test,
                   )) return;
                   requestPublicationSuccessor();
                   startTest(row);
                  }}
                  disabled={!row.test.eligible}
                  data-testid="webhook-test"
                >
                  {row.operation?.kind === "test" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send test
                </button>
                <button
                  ref={(element) => bindElement(publication, rowElements.delete, element)}
                  type="button"
                  className="icon-btn h-8 w-8 text-ink-3 hover:text-danger"
                  onClick={(event) => {
                   if (!claimPublishedClick(
                     publication,
                     row,
                     row.delete,
                     event,
                     rowElements.delete,
                   )) return;
                   requestPublicationSuccessor();
                   if (!confirm(`Delete the webhook to ${row.url}?`)) return;
                   startDelete(row);
                  }}
                  disabled={!row.delete.eligible}
                  aria-label={`Delete webhook ${row.url}`}
                  data-testid="webhook-delete"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
