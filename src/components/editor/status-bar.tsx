"use client";
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";

import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { AlertTriangle, ArrowUpDown, Check, ChevronDown, CircleHelp, GitBranch, HardDrive, Columns2, Code2, Eye, WrapText, MoreHorizontal } from "lucide-react";
import type { CollabSession } from "@/editor/collab/session";
import type { DocumentDto } from "@/server/dto";
import { lintMarkdown, type LintIssue } from "@/editor/markdown/lint";

import { cn } from "@/lib/utils";
import { ThemeToggle, useTheme } from "@/components/ui/theme-toggle";
import { isThemePreference, THEME_ORDER, themeLabel, type ThemePreference } from "@/lib/theme";
import { useHydrated } from "@/lib/hooks";
import { useDebouncedSessionValue } from "./use-session";
import { StatsPopover, useLocalSelection } from "./stats-popover";
import { STATUS_BOX } from "./chrome-classes";

export type { Layout } from "@/lib/viewport";
import type { Layout } from "@/lib/viewport";

export interface StatusBarProps {
  session: CollabSession;
  doc: DocumentDto;
  layout: Layout;
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage?: () => void;
  /** Phone: word count · storage · ⋯ menu (layout, wrap, sync scrolling and theme live inside). */
  compact?: boolean;
}

interface StatusBarDocumentPublication {
  value: DocumentDto;
  storage: DocumentDto["storage"];
  repoBranch: DocumentDto["repoBranch"];
  repoOwner: DocumentDto["repoOwner"];
  repoName: DocumentDto["repoName"];
  repoPath: DocumentDto["repoPath"];
  gistId: DocumentDto["gistId"];
  hasUnpublishedChanges: DocumentDto["hasUnpublishedChanges"];
}

interface StatusBarIssuePublication {
  snapshot: readonly LintIssue[];
  issue: LintIssue;
  index: number;
  line: number;
  column: number;
  offset: number;
  message: string;
  rule: string;
  severity: LintIssue["severity"];
}

interface StatusBarAuthority {
  mount: symbol;
  session: CollabSession;
  source: string;
  tree: unknown;
  document: StatusBarDocumentPublication;
  layout: Layout;
  layoutValues: readonly Layout[];
  onLayout: (layout: Layout) => void;
  lineWrapping: boolean;
  onLineWrapping: (wrap: boolean) => void;
  syncScroll: boolean;
  onSyncScroll: (on: boolean) => void;
  compact: boolean;
  hydrated: boolean;
  issueSnapshot: readonly LintIssue[];
  issueRows: readonly StatusBarIssuePublication[];
  onIssueSelect: (issue: LintIssue) => void;
  onShortcuts: () => void;
  onStorage: (() => void) | undefined;
  themePreference: ThemePreference;
  themeValues: readonly ThemePreference[];
  setThemePreference: (next: ThemePreference) => void;
  menuOpen: boolean;
  issuesOpen: boolean;
}

interface StatusBarControlPublication<T extends HTMLElement = HTMLElement> {
  authority: StatusBarAuthority;
  epoch: number;
  slot: string;
  root: HTMLElement;
  control: T;
  enabled: boolean;
  claimed: boolean;
}

interface StatusBarNativeEventPublication {
  event: Event;
  type: string;
  target: EventTarget | null;
  path: readonly EventTarget[];
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
  defaultPrevented: boolean;
  timeStamp: number;
  phase: number;
  key: string | undefined;
  button: number | undefined;
  ctrlKey: boolean | undefined;
  altKey: boolean | undefined;
  metaKey: boolean | undefined;
  shiftKey: boolean | undefined;
  pointerId: number | undefined;
  pointerType: string | undefined;
  isPrimary: boolean | undefined;
  extended: boolean;
  claimed: boolean;
  expired: boolean;
}

interface StatusBarReactEventPublication {
  event: SyntheticEvent<HTMLElement, Event>;
  native: StatusBarNativeEventPublication;
  type: string;
  target: EventTarget | null;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  timeStamp: number;
  phase: number;
  claimed: boolean;
}

interface StatusBarEventIntent {
  generation: StatusBarGeneration;
  publication: StatusBarControlPublication;
  nativeEvents: StatusBarNativeEventPublication[];
  reactEvents: StatusBarReactEventPublication[];
  claimedPublication: boolean;
  claims: Set<string>;
  pending: (() => void) | null;
  requiresReact: boolean;
}

interface StatusBarNodeSeal {
  node: Node;
  children: readonly Node[];
  attributes: readonly (readonly [string, string])[] | null;
  data: string | null;
  name: string | null;
  namespace: string | null;
}

interface StatusBarRelationSeal {
  node: Node;
  parent: Node | null;
  previous: Node | null;
  next: Node | null;
}

interface StatusBarObserverPublication {
  observer: MutationObserver;
}

interface StatusBarOutsidePointerChain {
  pointerDown: StatusBarNativeEventPublication;
  pointerUp: StatusBarNativeEventPublication | null;
  click: StatusBarNativeEventPublication | null;
}

interface StatusBarGeneration {
  authority: StatusBarAuthority;
  epoch: number;
  identity: symbol;
  root: HTMLElement;
  ownerDocument: Document;
  controls: Map<string, StatusBarControlPublication>;
  actions: Set<string>;
  nativeEvents: WeakMap<Event, StatusBarNativeEventPublication>;
  reactEvents: WeakMap<object, StatusBarReactEventPublication>;
  pendingIntents: Set<StatusBarEventIntent>;
  outsidePointerChain: StatusBarOutsidePointerChain | null;
  delegatedSubtrees: readonly HTMLElement[];
  nodeSeals: StatusBarNodeSeal[];
  relationSeals: StatusBarRelationSeal[];
  observers: StatusBarObserverPublication[];
  removeEventListeners: (() => void)[];
  retired: boolean;
}

interface StatusBarPublicationManager {
  mount: symbol;
  epoch: number;
  candidates: Map<string, StatusBarControlPublication>;
  active: StatusBarGeneration | null;
}

interface StatusBarValueIntent<T> {
  authority: StatusBarAuthority;
  value: T;
  event: StatusBarEventIntent;
}

interface StatusBarDisclosureIntent {
  authority: StatusBarAuthority;
  event: StatusBarEventIntent;
}

type StatusBarReactEvent =
  | ReactKeyboardEvent<HTMLElement>
  | ReactMouseEvent<HTMLElement>
  | ReactPointerEvent<HTMLElement>;

const DESKTOP_LAYOUTS: readonly Layout[] = Object.freeze(["split", "code", "rich"]);
const COMPACT_LAYOUTS: readonly Layout[] = Object.freeze(["code", "rich"]);
const STATUS_BAR_THEMES: readonly ThemePreference[] = Object.freeze([...THEME_ORDER]);
const STATUS_BAR_NATIVE_EVENTS = [
  "click",
  "keydown",
  "pointerdown",
  "pointerup",
  "focusin",
  "focusout",
  "menu.itemSelect",
  "dismissableLayer.pointerDownOutside",
  "dismissableLayer.focusOutside",
] as const;

function createPublicationManager(): StatusBarPublicationManager {
  return {
    mount: Symbol("status-bar"),
    epoch: 0,
    candidates: new Map(),
    active: null,
  };
}

function documentPublicationIsExact(document: StatusBarDocumentPublication) {
  const current = document.value;
  return (
    current.storage === document.storage
    && current.repoBranch === document.repoBranch
    && current.repoOwner === document.repoOwner
    && current.repoName === document.repoName
    && current.repoPath === document.repoPath
    && current.gistId === document.gistId
    && current.hasUnpublishedChanges === document.hasUnpublishedChanges
  );
}

function issuePublicationIsExact(authority: StatusBarAuthority, row: StatusBarIssuePublication) {
  const issue = row.issue;
  return (
    row.snapshot === authority.issueSnapshot
    && authority.issueRows[row.index] === row
    && row.snapshot[row.index] === issue
    && issue.line === row.line
    && issue.column === row.column
    && issue.offset === row.offset
    && issue.message === row.message
    && issue.rule === row.rule
    && issue.severity === row.severity
  );
}

function authorityIsExact(authority: StatusBarAuthority) {
  const expectedLayouts = authority.compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS;
  if (
    authority.layoutValues.length !== expectedLayouts.length
    || authority.layoutValues.some((value, index) => value !== expectedLayouts[index])
    || authority.themeValues.length !== STATUS_BAR_THEMES.length
    || authority.themeValues.some((value, index) => value !== STATUS_BAR_THEMES[index])
    || !documentPublicationIsExact(authority.document)
    || authority.issueRows.length !== authority.issueSnapshot.length
  )
    return false;
  return authority.issueRows.every((row, index) => row.index === index && issuePublicationIsExact(authority, row));
}

function expectedStatusBarSlots(authority: StatusBarAuthority) {
  const slots = ["root", "menu-trigger", "storage"];
  if (!authority.compact) slots.push("issues-trigger", "desktop-shortcuts");
  if (authority.menuOpen) {
    slots.push("menu-content");
    authority.layoutValues.forEach((value) => slots.push(`layout:${value}`));
    slots.push("line-wrapping", "sync-scroll");
    if (authority.compact) {
      authority.themeValues.forEach((value) => slots.push(`theme:${value}`));
      slots.push("compact-shortcuts");
    }
  }
  if (authority.issuesOpen && !authority.compact) {
    slots.push("issues-content");
    authority.issueRows.forEach((row) => slots.push(`issue:${row.index}`));
  }
  return slots;
}

function stableAttributes(element: Element) {
  const menuItem = element.getAttribute("role")?.startsWith("menuitem") ?? false;
  const placed = element.hasAttribute("data-radix-popper-content-wrapper")
    || element.hasAttribute("data-testid")
      && ["status-menu-content", "status-issues-content"].includes(element.getAttribute("data-testid") ?? "");
  return [...element.attributes]
    .filter((attribute) => {
      if (menuItem && ["data-highlighted", "tabindex"].includes(attribute.name)) return false;
      if (placed && ["style", "data-side", "data-align"].includes(attribute.name)) return false;
      if (["data-radix-popper-side", "data-radix-popper-align"].includes(attribute.name)) return false;
      return true;
    })
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function sealSubtree(
  root: Node,
  seals: StatusBarNodeSeal[],
  seen: Set<Node>,
  delegatedSubtrees: ReadonlySet<Node>,
) {
  if (seen.has(root)) return;
  seen.add(root);
  if (delegatedSubtrees.has(root)) return;
  const element = root instanceof Element ? root : null;
  const data = root instanceof CharacterData ? root.data : null;
  seals.push({
    node: root,
    children: Object.freeze([...root.childNodes]),
    attributes: element ? Object.freeze(stableAttributes(element)) : null,
    data,
    name: element?.tagName ?? null,
    namespace: element?.namespaceURI ?? null,
  });
  root.childNodes.forEach((child) => sealSubtree(child, seals, seen, delegatedSubtrees));
}

function sealRelations(
  node: Node,
  ownerDocument: Document,
  seals: StatusBarRelationSeal[],
  seen: Set<Node>,
) {
  let current: Node | null = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    seals.push({
      node: current,
      parent: current.parentNode,
      previous: current.previousSibling,
      next: current.nextSibling,
    });
    if (current === ownerDocument) return;
    current = current.parentNode;
  }
}

function arraysAreIdentical<T>(left: readonly T[], right: readonly T[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function controlIsEnabled(control: HTMLElement) {
  return (
    !("disabled" in control && control.disabled === true)
    && control.getAttribute("aria-disabled") !== "true"
    && !control.hasAttribute("data-disabled")
  );
}

function validateGeneration(generation: StatusBarGeneration, drain = true): boolean {
  if (generation.retired) return false;
  if (!authorityIsExact(generation.authority)) {
    retireGeneration(generation);
    return false;
  }
  if (drain) {
    for (const publication of generation.observers) {
      const records = publication.observer.takeRecords();
      if (records.some((record) => !mutationIsOwned(generation, record))) {
        retireGeneration(generation);
        return false;
      }
      if (records.some((record) => record.type === "childList"))
        refreshRelationSeals(generation);
    }
  }
  if (
    !generation.root.isConnected
    || generation.root.ownerDocument !== generation.ownerDocument
    || !generation.ownerDocument.documentElement.contains(generation.root)
  ) {
    retireGeneration(generation);
    return false;
  }
  for (const seal of generation.nodeSeals) {
    const element = seal.node instanceof Element ? seal.node : null;
    if (
      !arraysAreIdentical([...seal.node.childNodes], seal.children)
      || (seal.attributes && (!element || !arraysAreIdentical(
        stableAttributes(element).map(([name, value]) => `${name}\u0000${value}`),
        seal.attributes.map(([name, value]) => `${name}\u0000${value}`),
      )))
      || (seal.data !== null && (!(seal.node instanceof CharacterData) || seal.node.data !== seal.data))
      || (seal.name !== null && element?.tagName !== seal.name)
      || (seal.namespace !== null && element?.namespaceURI !== seal.namespace)
    ) {
      retireGeneration(generation);
      return false;
    }
  }
  const relationsAreExact = generation.relationSeals.every((seal) => (
    seal.node.parentNode === seal.parent
    && seal.node.previousSibling === seal.previous
    && seal.node.nextSibling === seal.next
  ));
  if (!relationsAreExact) retireGeneration(generation);
  return relationsAreExact;
}

function mutationIsRadixOwned(record: MutationRecord) {
  if (record.type === "childList") {
    const changed = [...record.addedNodes, ...record.removedNodes];
    return changed.length > 0 && changed.every((node) => (
      node instanceof HTMLElement
      && (
        node.tagName === "SPAN" && node.hasAttribute("data-radix-focus-guard")
        || node.hasAttribute("data-radix-popper-content-wrapper")
      )
    ));
  }
  if (record.type !== "attributes" || !(record.target instanceof Element) || !record.attributeName)
    return false;
  const role = record.target.getAttribute("role");
  if (role?.startsWith("menuitem") && ["data-highlighted", "tabindex"].includes(record.attributeName))
    return true;
  if (
    (
      record.target.hasAttribute("data-radix-popper-content-wrapper")
      || ["status-menu-content", "status-issues-content"].includes(
        record.target.getAttribute("data-testid") ?? "",
      )
    )
    && ["style", "data-side", "data-align"].includes(record.attributeName)
  )
    return true;
  if (["data-radix-popper-side", "data-radix-popper-align"].includes(record.attributeName))
    return true;
  return false;
}

function mutationIsOwned(generation: StatusBarGeneration, record: MutationRecord) {
  return generation.delegatedSubtrees.some((root) => (
    record.target === root || root.contains(record.target)
  )) || mutationIsRadixOwned(record);
}

function refreshRelationSeals(generation: StatusBarGeneration) {
  generation.relationSeals.length = 0;
  const seen = new Set<Node>();
  sealRelations(
    generation.root,
    generation.ownerDocument,
    generation.relationSeals,
    seen,
  );
  for (const slot of ["menu-content", "issues-content"]) {
    const content = generation.controls.get(slot)?.control;
    if (!content) continue;
    let top: Node = content;
    while (top.parentNode && top.parentNode !== generation.ownerDocument.body) top = top.parentNode;
    sealRelations(top, generation.ownerDocument, generation.relationSeals, seen);
  }
}

function retireGeneration(generation: StatusBarGeneration) {
  if (generation.retired) return;
  generation.retired = true;
  generation.pendingIntents.forEach((intent) => {
    intent.pending = null;
  });
  generation.pendingIntents.clear();
  retireOutsidePointerChain(generation);
  generation.removeEventListeners.forEach((remove) => remove());
  generation.removeEventListeners.length = 0;
  generation.observers.forEach(({ observer }) => {
    observer.takeRecords();
    observer.disconnect();
  });
  generation.observers.length = 0;
}

function retireManagerGeneration(
  manager: StatusBarPublicationManager,
  publication: StatusBarControlPublication,
) {
  if (manager.candidates.get(publication.slot) === publication)
    manager.candidates.delete(publication.slot);
  if (
    manager.active?.controls.get(publication.slot) !== publication
    && manager.candidates.size > 0
  )
    return;
  if (manager.active) retireGeneration(manager.active);
  manager.active = null;
  manager.candidates.clear();
  manager.epoch += 1;
}

function observeGeneration(generation: StatusBarGeneration) {
  const observe = (target: Node, options: MutationObserverInit) => {
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !mutationIsOwned(generation, record))) {
        retireGeneration(generation);
      } else if (records.some((record) => record.type === "childList")) {
        refreshRelationSeals(generation);
      }
    });
    observer.observe(target, options);
    generation.observers.push({ observer });
  };
  const subtreeRoots = [generation.root];
  for (const slot of ["menu-content", "issues-content"]) {
    const content = generation.controls.get(slot)?.control;
    if (!content) continue;
    let top: Node = content;
    while (top.parentNode && top.parentNode !== generation.ownerDocument.body) top = top.parentNode;
    subtreeRoots.push(top as HTMLElement);
  }
  [...new Set(subtreeRoots)].forEach((root) => observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  }));
  const parents = new Set<Node>();
  generation.relationSeals.forEach((seal) => {
    if (seal.parent) parents.add(seal.parent);
  });
  parents.forEach((parent) => {
    if (!subtreeRoots.some((root) => root === parent || root.contains(parent)))
      observe(parent, { childList: true });
  });
}

function retireOutsidePointerChain(generation: StatusBarGeneration) {
  const chain = generation.outsidePointerChain;
  if (!chain) return;
  chain.pointerDown.expired = true;
  if (chain.pointerUp) chain.pointerUp.expired = true;
  if (chain.click) chain.click.expired = true;
  generation.outsidePointerChain = null;
}

function pointerChainEventIsExact(
  pointerDown: StatusBarNativeEventPublication,
  next: StatusBarNativeEventPublication,
) {
  return (
    next.target === pointerDown.target
    && arraysAreIdentical(next.path, pointerDown.path)
    && next.button === pointerDown.button
    && next.ctrlKey === pointerDown.ctrlKey
    && next.altKey === pointerDown.altKey
    && next.metaKey === pointerDown.metaKey
    && next.shiftKey === pointerDown.shiftKey
    && (
      next.type !== "pointerup"
      || (
        next.pointerId === pointerDown.pointerId
        && next.pointerType === pointerDown.pointerType
        && next.isPrimary === pointerDown.isPrimary
      )
    )
  );
}

function recordNativeEvent(generation: StatusBarGeneration, event: Event) {
  if (!validateGeneration(generation)) return;
  const path = event.composedPath();
  const publication: StatusBarNativeEventPublication = {
    event,
    type: event.type,
    target: event.target,
    path: Object.freeze([...path]),
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    defaultPrevented: event.defaultPrevented,
    timeStamp: event.timeStamp,
    phase: event.eventPhase,
    key: "key" in event && typeof event.key === "string" ? event.key : undefined,
    button: "button" in event && typeof event.button === "number" ? event.button : undefined,
    ctrlKey: "ctrlKey" in event && typeof event.ctrlKey === "boolean" ? event.ctrlKey : undefined,
    altKey: "altKey" in event && typeof event.altKey === "boolean" ? event.altKey : undefined,
    metaKey: "metaKey" in event && typeof event.metaKey === "boolean" ? event.metaKey : undefined,
    shiftKey: "shiftKey" in event && typeof event.shiftKey === "boolean" ? event.shiftKey : undefined,
    pointerId: "pointerId" in event && typeof event.pointerId === "number" ? event.pointerId : undefined,
    pointerType: "pointerType" in event && typeof event.pointerType === "string" ? event.pointerType : undefined,
    isPrimary: "isPrimary" in event && typeof event.isPrimary === "boolean" ? event.isPrimary : undefined,
    extended: false,
    claimed: false,
    expired: false,
  };
  generation.nativeEvents.set(event, publication);
  let preserveForOutside = false;
  if (publication.type === "pointerdown" && publication.button === 0) {
    retireOutsidePointerChain(generation);
    generation.outsidePointerChain = {
      pointerDown: publication,
      pointerUp: null,
      click: null,
    };
    preserveForOutside = true;
  } else if (publication.type === "pointerup") {
    const chain = generation.outsidePointerChain;
    if (
      chain
      && !chain.pointerUp
      && !chain.click
      && publication.timeStamp >= chain.pointerDown.timeStamp
      && pointerChainEventIsExact(chain.pointerDown, publication)
    ) {
      chain.pointerUp = publication;
      preserveForOutside = true;
    } else if (chain) {
      retireOutsidePointerChain(generation);
    }
  } else if (publication.type === "click") {
    const chain = generation.outsidePointerChain;
    if (
      chain?.pointerUp
      && !chain.click
      && publication.timeStamp >= chain.pointerUp.timeStamp
      && pointerChainEventIsExact(chain.pointerDown, publication)
    ) {
      chain.click = publication;
      preserveForOutside = true;
      queueMicrotask(() => {
        if (generation.outsidePointerChain?.click === publication)
          retireOutsidePointerChain(generation);
      });
    } else if (chain) {
      retireOutsidePointerChain(generation);
    }
  }
  if (preserveForOutside) {
    publication.extended = true;
    return;
  }
  queueMicrotask(() => {
    publication.expired = true;
  });
}

function activateGeneration(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
) {
  if (manager.active || !authorityIsExact(authority)) return;
  const expected = expectedStatusBarSlots(authority);
  if (
    manager.candidates.size !== expected.length
    || expected.some((slot) => manager.candidates.get(slot)?.authority !== authority)
  ) {
    return;
  }
  const controls = new Map(manager.candidates);
  const root = controls.get("root")?.control;
  if (!(root instanceof HTMLElement) || !root.isConnected) return;
  const ownerDocument = root.ownerDocument;
  const statsTriggers = root.querySelectorAll<HTMLElement>('[data-testid="stats-button"]');
  const statsTrigger = statsTriggers.item(0);
  if (
    statsTriggers.length !== 1
    || !statsTrigger
    || statsTrigger.tagName !== "BUTTON"
    || statsTrigger.parentElement !== root
  )
    return;
  const delegatedSubtrees = Object.freeze([statsTrigger]);
  const portalContents = ["menu-content", "issues-content"]
    .map((slot) => controls.get(slot)?.control)
    .filter((control): control is HTMLElement => Boolean(control));
  if ([...controls.values()].some((publication) => (
    publication.epoch !== manager.epoch
    || publication.root !== root
    || publication.control.ownerDocument !== ownerDocument
    || !publication.control.isConnected
    || (
      publication.control !== root
      && !root.contains(publication.control)
      && !portalContents.some((content) => content.contains(publication.control))
    )
  )))
    return;
  const generation: StatusBarGeneration = {
    authority,
    epoch: manager.epoch,
    identity: Symbol("status-bar-publication"),
    root,
    ownerDocument,
    controls,
    actions: new Set(),
    nativeEvents: new WeakMap(),
    reactEvents: new WeakMap(),
    pendingIntents: new Set(),
    outsidePointerChain: null,
    delegatedSubtrees,
    nodeSeals: [],
    relationSeals: [],
    observers: [],
    removeEventListeners: [],
    retired: false,
  };
  const seenNodes = new Set<Node>();
  const delegatedSubtreeSet = new Set<Node>(delegatedSubtrees);
  const relationNodes = new Set<Node>();
  sealSubtree(root, generation.nodeSeals, seenNodes, delegatedSubtreeSet);
  sealRelations(root, ownerDocument, generation.relationSeals, relationNodes);
  portalContents.forEach((content) => {
    let top: Node = content;
    while (top.parentNode && top.parentNode !== ownerDocument.body) top = top.parentNode;
    sealSubtree(top, generation.nodeSeals, seenNodes, delegatedSubtreeSet);
    sealRelations(top, ownerDocument, generation.relationSeals, relationNodes);
  });
  manager.active = generation;
  STATUS_BAR_NATIVE_EVENTS.forEach((type) => {
    const listener = (event: Event) => recordNativeEvent(generation, event);
    ownerDocument.addEventListener(type, listener, true);
    generation.removeEventListeners.push(() => ownerDocument.removeEventListener(type, listener, true));
  });
  observeGeneration(generation);
}

function registerControl<T extends HTMLElement>(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  slot: string,
  root: HTMLElement,
  control: T,
) {
  const active = manager.active;
  if (
    active
    || authority.mount !== manager.mount
    || !expectedStatusBarSlots(authority).includes(slot)
    || manager.candidates.has(slot)
    || !root.isConnected
    || !control.isConnected
  )
    return null;
  const publication: StatusBarControlPublication<T> = {
    authority,
    epoch: manager.epoch,
    slot,
    root,
    control,
    enabled: controlIsEnabled(control),
    claimed: false,
  };
  manager.candidates.set(slot, publication);
  activateGeneration(manager, authority);
  return publication;
}

function nativeEventIsExact(publication: StatusBarNativeEventPublication) {
  const event = publication.event;
  const path = event.composedPath();
  return (
    !publication.expired
    && !publication.claimed
    && event.type === publication.type
    && event.target === publication.target
    && (
      arraysAreIdentical(path, publication.path)
      || (
        publication.extended
        && event.eventPhase === Event.NONE
        && path.length === 0
      )
    )
    && event.bubbles === publication.bubbles
    && event.cancelable === publication.cancelable
    && event.composed === publication.composed
    && event.defaultPrevented === publication.defaultPrevented
    && event.timeStamp === publication.timeStamp
    && publication.phase === Event.CAPTURING_PHASE
    && (!("key" in event) || event.key === publication.key)
    && (!("button" in event) || event.button === publication.button)
    && (!("ctrlKey" in event) || event.ctrlKey === publication.ctrlKey)
    && (!("altKey" in event) || event.altKey === publication.altKey)
    && (!("metaKey" in event) || event.metaKey === publication.metaKey)
    && (!("shiftKey" in event) || event.shiftKey === publication.shiftKey)
    && (!("pointerId" in event) || event.pointerId === publication.pointerId)
    && (!("pointerType" in event) || event.pointerType === publication.pointerType)
    && (!("isPrimary" in event) || event.isPrimary === publication.isPrimary)
  );
}

function reactEventIsExact(publication: StatusBarReactEventPublication) {
  const event = publication.event;
  return (
    !publication.claimed
    && event.nativeEvent === publication.native.event
    && event.type === publication.type
    && event.target === publication.target
    && event.bubbles === publication.bubbles
    && event.cancelable === publication.cancelable
    && event.defaultPrevented === publication.defaultPrevented
    && event.timeStamp === publication.timeStamp
  );
}

function rememberReactEvent(
  manager: StatusBarPublicationManager,
  event: StatusBarReactEvent,
) {
  const generation = manager.active;
  const native = generation?.nativeEvents.get(event.nativeEvent);
  if (
    !generation
    || !native
    || !nativeEventIsExact(native)
    || event.target !== native.target
    || event.type !== native.type
  )
    return;
  let publication = generation.reactEvents.get(event);
  if (!publication) {
    publication = {
      event,
      native,
      type: event.type,
      target: event.target,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      timeStamp: event.timeStamp,
      phase: event.eventPhase,
      claimed: false,
    };
    generation.reactEvents.set(event, publication);
  }
  for (const intent of generation.pendingIntents) {
    if (
      intent.nativeEvents[0] === native
      && native.target instanceof Node
      && intent.publication.control.contains(native.target as Node)
      && intent.reactEvents.length === 0
    ) {
      intent.reactEvents.push(publication);
      intent.requiresReact = false;
      generation.pendingIntents.delete(intent);
      const pending = intent.pending;
      intent.pending = null;
      pending?.();
      break;
    }
  }
}

function useStatusBarControl<T extends HTMLElement>(
  authority: StatusBarAuthority,
  rootRef: RefObject<HTMLElement | null>,
  manager: StatusBarPublicationManager,
  slot: string,
) {
  const controlRef = useRef<T | null>(null);
  const publicationRef = useRef<StatusBarControlPublication<T> | null>(null);
  const layoutAttemptedRef = useRef(false);
  const [refVersion, setRefVersion] = useState(0);
  const setControl = useCallback((control: T | null) => {
    if (!control) return;
    const publication = publicationRef.current;
    if (
      publication
      && manager.active?.controls.get(publication.slot) === publication
      && publication.control !== control
    )
      return;
    if (controlRef.current === control) return;
    controlRef.current = control;
    if (layoutAttemptedRef.current) setRefVersion((version) => version + 1);
  }, [manager]);

  useLayoutEffect(() => {
    layoutAttemptedRef.current = true;
    const root = rootRef.current;
    const control = controlRef.current;
    if (!root || !control) {
      return () => {
        layoutAttemptedRef.current = false;
      };
    }
    const publication = registerControl(manager, authority, slot, root, control);
    if (!publication) {
      return () => {
        layoutAttemptedRef.current = false;
      };
    }
    publicationRef.current = publication;
    return () => {
      layoutAttemptedRef.current = false;
      if (publicationRef.current === publication) publicationRef.current = null;
      retireManagerGeneration(manager, publication);
    };
  }, [authority, manager, refVersion, rootRef, slot]);

  const createReactIntent = useCallback((event: StatusBarReactEvent) => {
    const publication = publicationRef.current;
    const generation = manager.active;
    const reactEvent = generation?.reactEvents.get(event);
    const native = reactEvent?.native;
    if (
      !publication
      || !generation
      || generation.authority !== authority
      || generation.controls.get(slot) !== publication
      || publication.control !== event.currentTarget
      || !publication.enabled
      || !controlIsEnabled(publication.control)
      || !reactEvent
      || !native
      || !reactEventIsExact(reactEvent)
      || !nativeEventIsExact(native)
      || !native.path.includes(publication.control)
      || reactEvent.phase !== Event.CAPTURING_PHASE
      || !validateGeneration(generation)
    )
      return null;
    return {
      generation,
      publication,
      nativeEvents: [native],
      reactEvents: [reactEvent],
      claimedPublication: false,
      claims: new Set<string>(),
      pending: null,
      requiresReact: false,
    } satisfies StatusBarEventIntent;
  }, [authority, manager, slot]);

  const createSelectIntent = useCallback((
    activation: StatusBarEventIntent | null,
    event: Event,
  ) => {
    const publication = publicationRef.current;
    const generation = manager.active;
    const native = generation?.nativeEvents.get(event);
    if (
      !activation
      || !publication
      || !generation
      || activation.generation !== generation
      || activation.publication !== publication
      || generation.controls.get(slot) !== publication
      || event.currentTarget !== publication.control
      || !publication.enabled
      || !controlIsEnabled(publication.control)
      || native?.type !== "menu.itemSelect"
      || native.target !== publication.control
      || event.eventPhase !== Event.AT_TARGET
      || !nativeEventIsExact(native)
      || !validateGeneration(generation)
    )
      return null;
    activation.nativeEvents.push(native);
    return activation;
  }, [manager, slot]);

  return [setControl, createReactIntent, createSelectIntent, publicationRef] as const;
}

function claimIntent(intent: StatusBarEventIntent, action: string) {
  const { generation, publication } = intent;
  if (
    intent.requiresReact
    || generation.retired
    || generation.controls.get(publication.slot) !== publication
    || !validateGeneration(generation)
    || intent.nativeEvents.some((event) => (
      intent.claimedPublication ? event.expired || event.event.type !== event.type : !nativeEventIsExact(event)
    ))
    || intent.reactEvents.some((event) => (
      intent.claimedPublication ? event.event.nativeEvent !== event.native.event : !reactEventIsExact(event)
    ))
    || intent.claims.has(action)
    || generation.actions.has(action)
    || (publication.claimed && !intent.claimedPublication)
  )
    return false;
  if (!intent.claimedPublication) {
    publication.claimed = true;
    intent.claimedPublication = true;
    intent.nativeEvents.forEach((event) => {
      event.claimed = true;
    });
    intent.reactEvents.forEach((event) => {
      event.claimed = true;
    });
  }
  intent.claims.add(action);
  generation.actions.add(action);
  const outsidePointerChain = generation.outsidePointerChain;
  if (
    outsidePointerChain
    && intent.nativeEvents.includes(outsidePointerChain.pointerDown)
  )
    generation.outsidePointerChain = null;
  return true;
}

function useStatusBarIntent<T>(authority: StatusBarAuthority) {
  const intentRef = useRef<StatusBarValueIntent<T> | null>(null);
  useLayoutEffect(() => {
    if (intentRef.current?.authority !== authority) intentRef.current = null;
    return () => {
      if (intentRef.current?.authority === authority) intentRef.current = null;
    };
  }, [authority]);
  return intentRef;
}

function StatusBarRadioItem({
  authority,
  rootRef,
  manager,
  intentRef,
  disclosureIntentRef,
  slot,
  value,
  eligible,
  children,
  testId,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarValueIntent<string> | null>;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  slot: string;
  value: string;
  eligible: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [itemRef, createReactIntent, createSelectIntent] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    slot,
  );
  const activationRef = useRef<StatusBarEventIntent | null>(null);
  const authorize = useCallback((event: Event) => {
    if (!eligible) return;
    const intent = createSelectIntent(activationRef.current, event);
    if (!intent) return;
    activationRef.current = null;
    intentRef.current = { authority, value, event: intent };
    disclosureIntentRef.current = { authority, event: intent };
  }, [authority, createSelectIntent, disclosureIntentRef, eligible, intentRef, value]);

  return (
    <MenuRadioItem
      ref={itemRef}
      value={value}
      onClickCapture={(event) => {
        activationRef.current = createReactIntent(event);
      }}
      onSelect={authorize}
      data-testid={testId}
    >
      {children}
    </MenuRadioItem>
  );
}

function StatusBarCheckboxControl({
  authority,
  rootRef,
  manager,
  slot,
  action,
  disclosureIntentRef,
  checked,
  children,
  testId,
  onChange,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  slot: string;
  action: string;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  checked: boolean;
  children: ReactNode;
  testId?: string;
  onChange: (value: boolean) => void;
}) {
  const [itemRef, createReactIntent, createSelectIntent] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    slot,
  );
  const activationRef = useRef<StatusBarEventIntent | null>(null);
  const intentRef = useStatusBarIntent<boolean>(authority);
  const next = !checked;
  const authorize = useCallback((event: Event) => {
    const intent = createSelectIntent(activationRef.current, event);
    if (!intent) return;
    activationRef.current = null;
    intentRef.current = { authority, value: next, event: intent };
    disclosureIntentRef.current = { authority, event: intent };
  }, [authority, createSelectIntent, disclosureIntentRef, intentRef, next]);
  const change = useCallback((value: boolean | "indeterminate") => {
    const intent = intentRef.current;
    if (
      typeof value !== "boolean"
      || value !== next
      || intent?.authority !== authority
      || intent.value !== value
      || !claimIntent(intent.event, action)
    )
      return;
    intentRef.current = null;
    onChange(value);
  }, [action, authority, intentRef, next, onChange]);

  return (
    <MenuCheckboxItem
      ref={itemRef}
      checked={checked}
      onClickCapture={(event) => {
        activationRef.current = createReactIntent(event);
      }}
      onSelect={authorize}
      onCheckedChange={change}
      data-testid={testId}
    >
      {children}
    </MenuCheckboxItem>
  );
}

function StatusBarMenuControls({
  authority,
  rootRef,
  manager,
  disclosureIntentRef,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  disclosureIntentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
}) {
  const layoutIntentRef = useStatusBarIntent<string>(authority);
  const themeIntentRef = useStatusBarIntent<string>(authority);
  const shortcutsActivationRef = useRef<StatusBarEventIntent | null>(null);
  const [shortcutsRef, createShortcutsIntent, createShortcutsSelectIntent] =
    useStatusBarControl<HTMLDivElement>(
      authority,
      rootRef,
      manager,
      "compact-shortcuts",
    );

  const selectLayout = useCallback((value: string) => {
    const next = authority.layoutValues.find((candidate) => candidate === value);
    const intent = layoutIntentRef.current;
    if (
      !next
      || next === authority.layout
      || intent?.authority !== authority
      || intent.value !== next
      || !claimIntent(intent.event, "layout")
    )
      return;
    layoutIntentRef.current = null;
    authority.onLayout(next);
  }, [authority, layoutIntentRef]);

  const selectTheme = useCallback((value: string) => {
    const intent = themeIntentRef.current;
    if (
      !isThemePreference(value)
      || !authority.themeValues.includes(value)
      || value === authority.themePreference
      || intent?.authority !== authority
      || intent.value !== value
      || !claimIntent(intent.event, "theme")
    )
      return;
    themeIntentRef.current = null;
    authority.setThemePreference(value);
  }, [authority, themeIntentRef]);

  return (
    <>
      <MenuLabel>View</MenuLabel>
      <MenuRadioGroup value={authority.layout} onValueChange={selectLayout}>
        {!authority.compact && (
          <StatusBarRadioItem
            authority={authority}
            rootRef={rootRef}
            manager={manager}
            intentRef={layoutIntentRef}
            disclosureIntentRef={disclosureIntentRef}
            slot="layout:split"
            value="split"
            eligible={authority.layout !== "split"}
          >
            <span className="inline-flex items-center gap-2">
              <Columns2 size={14} /> Code and preview
            </span>
          </StatusBarRadioItem>
        )}
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={layoutIntentRef}
          disclosureIntentRef={disclosureIntentRef}
          slot="layout:code"
          value="code"
          eligible={authority.layout !== "code"}
        >
          <span className="inline-flex items-center gap-2">
            <Code2 size={14} /> Code only
          </span>
        </StatusBarRadioItem>
        <StatusBarRadioItem
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={layoutIntentRef}
          disclosureIntentRef={disclosureIntentRef}
          slot="layout:rich"
          value="rich"
          eligible={authority.layout !== "rich"}
        >
          <span className="inline-flex items-center gap-2">
            <Eye size={14} /> Preview only
          </span>
        </StatusBarRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        manager={manager}
        slot="line-wrapping"
        action="line-wrapping"
        disclosureIntentRef={disclosureIntentRef}
        checked={authority.lineWrapping}
        onChange={authority.onLineWrapping}
      >
        <span className="inline-flex items-center gap-2">
          <WrapText size={14} /> Wrap long lines
        </span>
      </StatusBarCheckboxControl>
      <StatusBarCheckboxControl
        authority={authority}
        rootRef={rootRef}
        manager={manager}
        slot="sync-scroll"
        action="sync-scroll"
        disclosureIntentRef={disclosureIntentRef}
        checked={authority.syncScroll}
        onChange={authority.onSyncScroll}
        testId="sync-scroll-toggle"
      >
        <span className="inline-flex items-center gap-2">
          <ArrowUpDown size={14} /> Sync scrolling
        </span>
      </StatusBarCheckboxControl>
      {authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Theme</MenuLabel>
          <MenuRadioGroup value={authority.themePreference} onValueChange={selectTheme}>
            {authority.themeValues.map((theme) => (
              <StatusBarRadioItem
                key={theme}
                authority={authority}
                rootRef={rootRef}
                manager={manager}
                intentRef={themeIntentRef}
                disclosureIntentRef={disclosureIntentRef}
                slot={`theme:${theme}`}
                value={theme}
                eligible={authority.themePreference !== theme}
                testId={`menu-theme-${theme}`}
              >
                {themeLabel(theme)}
              </StatusBarRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            ref={shortcutsRef}
            icon={<CircleHelp size={15} />}
            onClickCapture={(event) => {
              shortcutsActivationRef.current = createShortcutsIntent(event);
            }}
            onSelect={(event) => {
              const intent = createShortcutsSelectIntent(shortcutsActivationRef.current, event);
              if (!intent) return;
              shortcutsActivationRef.current = null;
              disclosureIntentRef.current = { authority, event: intent };
              if (claimIntent(intent, "shortcuts")) authority.onShortcuts();
            }}
          >
            Help and shortcuts
          </MenuItem>
        </>
      )}
      {!authority.compact && (
        <>
          <MenuSeparator />
          <MenuLabel>Flavor</MenuLabel>
          <div className="px-2.5 pb-2 text-xs text-ink-3">GitHub Flavored Markdown (tables, task lists, footnotes, strikethrough).</div>
        </>
      )}
    </>
  );
}

function StatusBarIssueRow({
  authority,
  row,
  rootRef,
  manager,
}: {
  authority: StatusBarAuthority;
  row: StatusBarIssuePublication;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
}) {
  const [buttonRef, createReactIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    `issue:${row.index}`,
  );
  const intentRef = useRef<StatusBarEventIntent | null>(null);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3"
      onClickCapture={(event) => {
        intentRef.current = createReactIntent(event);
      }}
      onClick={(event) => {
        const intent = intentRef.current;
        if (
          !intent
          || !completeReactIntent(intent, event)
          || !issuePublicationIsExact(authority, row)
          || !claimIntent(intent, `issue:${row.index}`)
        )
          return;
        intentRef.current = null;
        authority.onIssueSelect(row.issue);
      }}
    >
      <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", row.severity === "error" ? "bg-danger" : "bg-warning")} />
      <span className="flex-1 text-ink-2">{row.message}</span>
      <span className="shrink-0 font-mono text-xs text-ink-4">L{row.line}</span>
    </button>
  );
}

function completeReactIntent(
  intent: StatusBarEventIntent,
  event: ReactMouseEvent<HTMLElement>,
) {
  const { generation, publication } = intent;
  if (
    generation.retired
    || event.currentTarget !== publication.control
    || event.nativeEvent !== intent.nativeEvents[0]?.event
    || event.target !== intent.nativeEvents[0]?.target
    || !publication.enabled
    || !controlIsEnabled(publication.control)
    || (
      event.eventPhase !== Event.AT_TARGET
      && event.eventPhase !== Event.BUBBLING_PHASE
    )
    || !validateGeneration(generation)
  )
    return false;
  const existing = generation.reactEvents.get(event);
  if (existing) {
    if (!intent.reactEvents.includes(existing)) intent.reactEvents.push(existing);
    return reactEventIsExact(existing);
  }
  const reactEvent: StatusBarReactEventPublication = {
    event,
    native: intent.nativeEvents[0],
    type: event.type,
    target: event.target,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    timeStamp: event.timeStamp,
    phase: event.eventPhase,
    claimed: false,
  };
  generation.reactEvents.set(event, reactEvent);
  intent.reactEvents.push(reactEvent);
  return reactEventIsExact(reactEvent);
}

function createContentNativeIntent(
  manager: StatusBarPublicationManager,
  authority: StatusBarAuthority,
  publicationRef: MutableRefObject<StatusBarControlPublication<HTMLDivElement> | null>,
  event: Event,
  mode: "escape" | "outside",
) {
  const generation = manager.active;
  const publication = publicationRef.current;
  const native = generation?.nativeEvents.get(event);
  if (
    !generation
    || !publication
    || generation.authority !== authority
    || generation.controls.get(publication.slot) !== publication
    || !native
    || !nativeEventIsExact(native)
    || !validateGeneration(generation)
  )
    return null;
  const nativeEvents = [native];
  if (mode === "escape") {
    if (
      native.type !== "keydown"
      || native.key !== "Escape"
      || !native.path.includes(publication.control)
      || event.eventPhase !== Event.CAPTURING_PHASE
      || event.currentTarget !== generation.ownerDocument
    )
      return null;
  } else {
    const outside = event as CustomEvent<{ originalEvent?: Event }>;
    const originalEvent = outside.detail?.originalEvent;
    const original = originalEvent ? generation.nativeEvents.get(originalEvent) : null;
    const pointerChain = generation.outsidePointerChain;
    if (
      !["dismissableLayer.pointerDownOutside", "dismissableLayer.focusOutside"].includes(native.type)
      || !original
      || !nativeEventIsExact(original)
      || event.target !== original.target
      || event.currentTarget !== original.target
      || event.eventPhase !== Event.AT_TARGET
      || !(original.target instanceof Node)
      || publication.control.contains(original.target)
    )
      return null;
    nativeEvents.push(original);
    if (native.type === "dismissableLayer.pointerDownOutside" && original.button === 0) {
      if (
        original.type !== "pointerdown"
        || pointerChain?.pointerDown !== original
        || !pointerChain.pointerUp
        || !pointerChain.click
        || !nativeEventIsExact(pointerChain.pointerUp)
        || !nativeEventIsExact(pointerChain.click)
      )
        return null;
      nativeEvents.push(pointerChain.pointerUp, pointerChain.click);
    }
  }
  const intent: StatusBarEventIntent = {
    generation,
    publication,
    nativeEvents,
    reactEvents: [],
    claimedPublication: false,
    claims: new Set(),
    pending: null,
    requiresReact: false,
  };
  return intent;
}

function StatusBarMenuContent({
  authority,
  rootRef,
  manager,
  intentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  children: ReactNode;
}) {
  const [setContent, createReactIntent, , publicationRef] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    "menu-content",
  );
  const authorize = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    if ("key" in event && event.key === "Escape") return;
    const intent = createReactIntent(event);
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, createReactIntent, intentRef, manager]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "outside");
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "escape");
    if (intent && claimIntent(intent, "menu-disclosure"))
      intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);

  return (
    <MenuContent
      ref={setContent}
      align="end"
      className="w-60"
      data-testid="status-menu-content"
      onPointerDownCapture={authorize}
      onKeyDownCapture={authorize}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
    >
      {children}
    </MenuContent>
  );
}

function StatusBarIssuesContent({
  authority,
  rootRef,
  manager,
  intentRef,
  children,
}: {
  authority: StatusBarAuthority;
  rootRef: RefObject<HTMLElement | null>;
  manager: StatusBarPublicationManager;
  intentRef: MutableRefObject<StatusBarDisclosureIntent | null>;
  children: ReactNode;
}) {
  const [setContent, createReactIntent, , publicationRef] = useStatusBarControl<HTMLDivElement>(
    authority,
    rootRef,
    manager,
    "issues-content",
  );
  const authorize = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    if ("key" in event && event.key === "Escape") return;
    const intent = createReactIntent(event);
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, createReactIntent, intentRef, manager]);
  const authorizeOutside = useCallback((event: CustomEvent<{ originalEvent: Event }>) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "outside");
    if (intent) intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);
  const authorizeEscape = useCallback((event: KeyboardEvent) => {
    const intent = createContentNativeIntent(manager, authority, publicationRef, event, "escape");
    if (intent && claimIntent(intent, "issues-disclosure"))
      intentRef.current = { authority, event: intent };
  }, [authority, intentRef, manager, publicationRef]);

  return (
    <PopoverContent
      ref={setContent}
      align="end"
      className="w-80 p-0"
      data-testid="status-issues-content"
      onKeyDownCapture={authorize}
      onPointerDownCapture={authorize}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
      onPointerDownOutside={authorizeOutside}
      onFocusOutside={authorizeOutside}
      onEscapeKeyDown={authorizeEscape}
    >
      {children}
    </PopoverContent>
  );
}

export const StatusBar = memo(function StatusBar({ session, doc, layout, onLayout, lineWrapping, onLineWrapping, syncScroll, onSyncScroll, onIssueSelect, onShortcuts, onStorage, compact = false }: StatusBarProps) {
  // Linting walks the document and statistics count it: wait for a pause in typing. The tree is the
  // binding's incrementally maintained parse, so no second parse of the document happens here.
  const { text: source, tree } = useDebouncedSessionValue(session, (s) => s.binding.getTree(), 500, (a, b) => a.text === b.text);
  // The server renders an empty session; by the time this part of the page hydrates the client
  // may already hold the local copy. Show placeholders until hydrated so the markup matches.
  const hydrated = useHydrated();
  const issues = useMemo(() => (hydrated ? lintMarkdown(source, tree) : []), [hydrated, source, tree]);
  const selection = useLocalSelection(session);
  const errors = issues.filter((i) => i.severity === "error").length;

  const [themePreference, setThemePreference] = useTheme();
  const [manager] = useState(createPublicationManager);
  const [menuOpen, setMenuOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const documentValue = doc;
  const documentStorage = doc.storage;
  const documentRepoBranch = doc.repoBranch;
  const documentRepoOwner = doc.repoOwner;
  const documentRepoName = doc.repoName;
  const documentRepoPath = doc.repoPath;
  const documentGistId = doc.gistId;
  const documentHasUnpublishedChanges = doc.hasUnpublishedChanges;
  const documentPublication = useMemo<StatusBarDocumentPublication>(() => Object.freeze({
    value: documentValue,
    storage: documentStorage,
    repoBranch: documentRepoBranch,
    repoOwner: documentRepoOwner,
    repoName: documentRepoName,
    repoPath: documentRepoPath,
    gistId: documentGistId,
    hasUnpublishedChanges: documentHasUnpublishedChanges,
  }), [
    documentGistId,
    documentHasUnpublishedChanges,
    documentRepoBranch,
    documentRepoName,
    documentRepoOwner,
    documentRepoPath,
    documentStorage,
    documentValue,
  ]);
  const authority = useMemo<StatusBarAuthority>(() => {
    const issueRows = Object.freeze(issues.map((issue, index) => Object.freeze({
      snapshot: issues,
      issue,
      index,
      line: issue.line,
      column: issue.column,
      offset: issue.offset,
      message: issue.message,
      rule: issue.rule,
      severity: issue.severity,
    })));
    return Object.freeze({
      mount: manager.mount,
      session,
      source,
      tree,
      document: documentPublication,
      layout,
      layoutValues: compact ? COMPACT_LAYOUTS : DESKTOP_LAYOUTS,
      onLayout,
      lineWrapping,
      onLineWrapping,
      syncScroll,
      onSyncScroll,
      compact,
      hydrated,
      issueSnapshot: issues,
      issueRows,
      onIssueSelect,
      onShortcuts,
      onStorage,
      themePreference,
      themeValues: STATUS_BAR_THEMES,
      setThemePreference,
      menuOpen,
      issuesOpen,
    });
  }, [
    compact,
    documentPublication,
    hydrated,
    issues,
    issuesOpen,
    layout,
    lineWrapping,
    manager,
    menuOpen,
    onIssueSelect,
    onLayout,
    onLineWrapping,
    onShortcuts,
    onStorage,
    onSyncScroll,
    session,
    setThemePreference,
    source,
    syncScroll,
    themePreference,
    tree,
  ]);
  const rootRef = useRef<HTMLElement>(null);
  const menuIntentRef = useRef<StatusBarDisclosureIntent | null>(null);
  const issuesIntentRef = useRef<StatusBarDisclosureIntent | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const publication = registerControl(manager, authority, "root", root, root);
    if (!publication) return;
    if (menuIntentRef.current?.authority !== authority) menuIntentRef.current = null;
    if (issuesIntentRef.current?.authority !== authority) issuesIntentRef.current = null;
    return () => {
      if (menuIntentRef.current?.authority === authority) menuIntentRef.current = null;
      if (issuesIntentRef.current?.authority === authority) issuesIntentRef.current = null;
      retireManagerGeneration(manager, publication);
    };
  }, [authority, manager]);

  const [menuTriggerRef, createMenuIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "menu-trigger",
  );
  const [issuesTriggerRef, createIssuesIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "issues-trigger",
  );
  const [storageRef, createStorageIntent] = useStatusBarControl<HTMLButtonElement>(
    authority,
    rootRef,
    manager,
    "storage",
  );
  const [desktopShortcutsRef, createDesktopShortcutsIntent] =
    useStatusBarControl<HTMLButtonElement>(
      authority,
      rootRef,
      manager,
      "desktop-shortcuts",
    );
  const storageIntentRef = useRef<StatusBarEventIntent | null>(null);
  const desktopShortcutsIntentRef = useRef<StatusBarEventIntent | null>(null);

  const authorizeMenuChange = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    const intent = createMenuIntent(event);
    if (intent) menuIntentRef.current = { authority, event: intent };
  }, [authority, createMenuIntent, manager]);

  const authorizeIssuesChange = useCallback((event: StatusBarReactEvent) => {
    rememberReactEvent(manager, event);
    const intent = createIssuesIntent(event);
    if (intent) issuesIntentRef.current = { authority, event: intent };
  }, [authority, createIssuesIntent, manager]);

  const changeMenuOpen = useCallback((open: boolean) => {
    const intent = menuIntentRef.current;
    if (
      open === authority.menuOpen
      || intent?.authority !== authority
      || intent.event.generation !== manager.active
    )
      return;
    if (intent.event.requiresReact) {
      intent.event.pending = () => {
        if (
          menuIntentRef.current === intent
          && claimIntent(intent.event, "menu-disclosure")
        ) {
          menuIntentRef.current = null;
          setMenuOpen(open);
        }
      };
      return;
    }
    if (
      !intent.event.claims.has("menu-disclosure")
      && !claimIntent(intent.event, "menu-disclosure")
    )
      return;
    menuIntentRef.current = null;
    setMenuOpen(open);
  }, [authority, manager]);

  const changeIssuesOpen = useCallback((open: boolean) => {
    const intent = issuesIntentRef.current;
    if (
      open === authority.issuesOpen
      || intent?.authority !== authority
      || intent.event.generation !== manager.active
    )
      return;
    if (intent.event.requiresReact) {
      intent.event.pending = () => {
        if (
          issuesIntentRef.current === intent
          && claimIntent(intent.event, "issues-disclosure")
        ) {
          issuesIntentRef.current = null;
          setIssuesOpen(open);
        }
      };
      return;
    }
    if (
      !intent.event.claims.has("issues-disclosure")
      && !claimIntent(intent.event, "issues-disclosure")
    )
      return;
    issuesIntentRef.current = null;
    setIssuesOpen(open);
  }, [authority, manager]);

  const document = authority.document;
  const storageLabel =
    document.storage === "repo" ? (document.repoBranch ?? "main") : document.storage === "gist" ? "gist" : "local";
  const StorageIcon = document.storage === "repo" ? GitBranch : document.storage === "gist" ? GitHubIcon : HardDrive;

  return (
    <footer
      ref={rootRef}
      className={STATUS_BOX}
      data-testid="status-bar"
      data-compact={compact || undefined}
      onPointerDownCapture={(event) => rememberReactEvent(manager, event)}
      onKeyDownCapture={(event) => rememberReactEvent(manager, event)}
      onClickCapture={(event) => rememberReactEvent(manager, event)}
    >
      <StatsPopover session={session} source={source} selection={selection} hydrated={hydrated} />
      <div className="flex-1" />

      {/* One trigger for both layouts: `compact` is false on the server and during hydration, so the phone
          form (32 px ⋯ icon, last in the row) comes from `max-md:`/`md:` classes and nothing moves when
          `compact` flips (#1531). The menu's contents still branch on `compact` — a portal, not first paint. */}
      <Menu open={menuOpen} onOpenChange={changeMenuOpen}>
        <MenuTrigger asChild>
          <button
            ref={menuTriggerRef}
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-3 hover:text-ink max-md:order-last max-md:text-ink-2 max-md:transition-colors md:h-7 md:w-auto md:gap-1 md:px-2"
            aria-label={compact ? "View options" : undefined}
            onPointerDownCapture={authorizeMenuChange}
            onKeyDownCapture={authorizeMenuChange}
            data-testid="layout-menu"
          >
            {/* The phone name from the first byte: `compact` (and so `aria-label`) is false until hydration, and the
                visible "Markdown" text is `max-md:hidden` — without this the server markup has an unnamed button for ≈ 1 s.
                After hydration `aria-label` wins; from `md` the span is hidden and the visible text is the name (#1562). */}
            <span className="sr-only md:hidden">View options</span>
            <span className="inline-flex md:hidden">
              <MoreHorizontal size={18} />
            </span>
            <span className="inline-flex items-center gap-1 max-md:hidden">
              Markdown
              <ChevronDown size={14} />
            </span>
          </button>
        </MenuTrigger>
        <StatusBarMenuContent
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={menuIntentRef}
        >
          <StatusBarMenuControls
            authority={authority}
            rootRef={rootRef}
            manager={manager}
            disclosureIntentRef={menuIntentRef}
          />
        </StatusBarMenuContent>
      </Menu>

      {/* Desktop-only controls: hidden by CSS below `md` from the first paint, unmounted once `compact` is known
          (mobile.spec.ts asserts they are absent, not merely hidden). */}
      {compact ? null : (
      <Popover open={issuesOpen} onOpenChange={changeIssuesOpen}>
        <PopoverTrigger asChild>
          <button
            ref={issuesTriggerRef}
            type="button"
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 max-md:hidden", issues.length ? (errors ? "text-danger" : "text-warning") : "text-ink-3 hover:text-ink")}
            onClickCapture={authorizeIssuesChange}
            data-testid="issues-button"
          >
            {issues.length ? <AlertTriangle size={14} /> : <Check size={14} />}
            {issues.length === 0 ? "No issues" : `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
          </button>
        </PopoverTrigger>
        <StatusBarIssuesContent
          authority={authority}
          rootRef={rootRef}
          manager={manager}
          intentRef={issuesIntentRef}
        >
          <div className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Markdown issues</div>
          {issues.length === 0 ? (
            <div className="px-3 py-4 text-sm text-ink-3">Everything looks good.</div>
          ) : (
            <ul className="scrollbar-thin max-h-72 overflow-y-auto py-1">
              {authority.issueRows.map((row) => (
                <li key={row.index}>
                  <StatusBarIssueRow
                    authority={authority}
                    row={row}
                    rootRef={rootRef}
                    manager={manager}
                  />
                </li>
              ))}
            </ul>
          )}
        </StatusBarIssuesContent>
      </Popover>
      )}

      {/* Rendered once for both layouts (32 px tall on phones, 28 px from `md`), so it is already in place at first paint. */}
      <button
        ref={storageRef}
        type="button"
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 hover:bg-surface-3 hover:text-ink md:h-7"
        onClickCapture={authority.onStorage ? (event) => {
          storageIntentRef.current = createStorageIntent(event);
        } : undefined}
        onClick={authority.onStorage ? (event) => {
          const intent = storageIntentRef.current;
          if (
            !intent
            || !completeReactIntent(intent, event)
            || !claimIntent(intent, "storage")
          )
            return;
          storageIntentRef.current = null;
          authority.onStorage?.();
        } : undefined}
        disabled={!authority.onStorage}
        title={document.storage === "repo" ? `${document.repoOwner}/${document.repoName}: ${document.repoPath}` : document.storage === "gist" ? `Gist ${document.gistId}` : "Stored in Markdoc"}
        data-testid="storage-indicator"
      >
        <StorageIcon size={14} />
        {storageLabel}
        {document.hasUnpublishedChanges && document.storage !== "local" && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unpublished changes" />}
      </button>

      {compact ? null : (
        <>
          <ThemeToggle className="h-7 w-7 max-md:hidden" />
          <button
            ref={desktopShortcutsRef}
            type="button"
            className="icon-btn h-7 w-7 max-md:hidden"
            onClickCapture={(event) => {
              desktopShortcutsIntentRef.current = createDesktopShortcutsIntent(event);
            }}
            onClick={(event) => {
              const intent = desktopShortcutsIntentRef.current;
              if (
                !intent
                || !completeReactIntent(intent, event)
                || !claimIntent(intent, "shortcuts")
              )
                return;
              desktopShortcutsIntentRef.current = null;
              authority.onShortcuts();
            }}
            aria-label="Help and shortcuts"
          >
            <CircleHelp size={16} />
          </button>
        </>
      )}
    </footer>
  );
});
