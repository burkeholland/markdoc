"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, ChevronLeft, ChevronRight, Code, Columns2, Copy, CornerDownLeft, Download, Eye,
  FileCode2, FilePlus2, FileText, Files, Hash, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine,
  Quote, Redo2, Replace, Search, Share2, SquareCode, Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users, type LucideIcon,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { focusedElement, focusReturnTarget, restoreFocus } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { cn, shortcut } from "@/lib/utils";
import { filterCommands, groupCommands, loadRecent, pushRecent, saveRecent, withRecentFirst, type Command } from "./commands";

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, Code, Columns2, Copy, Download, Eye, FileCode2, FilePlus2, FileText, Files, Hash,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard, LayoutTemplate, Link, List, ListChecks, ListOrdered,
  ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine, Quote, Redo2, Replace, Search, Share2, SquareCode,
  Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users,
};

const RADIX_SETTLING_ATTRIBUTES = new Set([
  "aria-describedby",
  "aria-hidden",
  "aria-labelledby",
  "data-aria-hidden",
  "style",
]);

interface Level {
  title: string | null;
  items: Command[];
}

interface ChildLoad {
  request: ChildRequest;
  command: Command;
  retry: boolean;
}

interface ChildLoadError {
  command: Command;
  message: string;
}

interface PaletteAuthority {
  token: symbol;
}

interface PaletteVisit {
  authority: PaletteAuthority;
  token: symbol;
  returnFocus: HTMLElement | null;
}

interface PaletteState {
  visit: PaletteVisit | null;
  commands: (() => Command[]) | null;
  query: string;
  stack: Level[];
  highlight: number;
  recent: string[];
  childLoad: ChildLoad | null;
  childError: ChildLoadError | null;
}

interface ElementPublication<T extends HTMLElement> {
  token: symbol;
  element: T | null;
  lastElement: T | null;
}

type ControlPublication<T extends HTMLElement> = ElementPublication<T>;

interface RowPublication extends ControlPublication<HTMLDivElement> {
  command: Command;
  index: number;
}

interface CommandFacts {
  source: Command;
  keywords: string[];
  id: string;
  title: string;
  group: string;
  shortcut: string | undefined;
  icon: string | undefined;
  when: Command["when"];
  run: Command["run"];
  children: Command["children"];
}

interface LevelFacts {
  source: Level;
  items: Command[];
  title: string | null;
}

interface PaletteStateFacts {
  source: PaletteState;
  visit: PaletteVisit | null;
  commands: (() => Command[]) | null;
  query: string;
  stack: LevelFacts[];
  highlight: number;
  recent: string[];
  childLoad: ChildLoad | null;
  childError: ChildLoadError | null;
}

interface DomSnapshot {
  node: Node;
  value: string | null;
  attributes: readonly (readonly [string, string])[] | null;
  children: readonly DomSnapshot[];
}

interface AncestorPlacement {
  node: Node;
  parent: Node;
  previous: Node | null;
  next: Node | null;
}

interface PalettePlacement {
  document: Document;
  parent: Node;
  overlayPrevious: Node | null;
  overlayNext: Node | null;
  contentPrevious: Node | null;
  contentNext: Node | null;
  ancestors: readonly AncestorPlacement[];
}

interface PaletteDomGuard {
  isClean: () => boolean;
  release: () => void;
}

interface CommittedElement {
  publication: ElementPublication<HTMLElement>;
  element: HTMLElement;
}

interface CommittedPresentation {
  token: symbol;
  source: PalettePresentation;
  elements: readonly CommittedElement[];
  overlay: HTMLDivElement;
  content: HTMLDivElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLDivElement;
  back: HTMLButtonElement | null;
  retry: HTMLButtonElement | null;
  rows: readonly HTMLDivElement[];
  placement: PalettePlacement;
  overlayTree: DomSnapshot;
  contentTree: DomSnapshot;
  guard: PaletteDomGuard;
  retired: boolean;
  claimed: boolean;
}

interface RefReplay {
  publication: ElementPublication<HTMLElement>;
  element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface PresentationReplay {
  source: CommittedPresentation;
  layoutRetired: boolean;
  invalid: boolean;
  refs: RefReplay[];
}

interface CommandSection {
  group: string | null;
  items: Command[];
}

interface PalettePresentation {
  authority: PaletteAuthority;
  visit: PaletteVisit | null;
  token: symbol;
  generation: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: () => Command[];
  groupOrder: readonly string[] | undefined;
  placeholder: string;
  state: PaletteState;
  root: Level | undefined;
  level: Level | undefined;
  atRoot: boolean;
  visible: Command[];
  sections: CommandSection[];
  flat: Command[];
  stateFacts: PaletteStateFacts;
  commandFacts: CommandFacts[];
  groupOrderFacts: readonly string[] | undefined;
  overlay: ElementPublication<HTMLDivElement>;
  content: ElementPublication<HTMLDivElement>;
  form: ElementPublication<HTMLFormElement>;
  input: ElementPublication<HTMLInputElement>;
  list: ElementPublication<HTMLDivElement>;
  back: ControlPublication<HTMLButtonElement> | null;
  retry: ControlPublication<HTMLButtonElement> | null;
  rows: RowPublication[];
  layoutAttempted: boolean;
  republishRequested: boolean;
  consumedEvents: WeakSet<object>;
}

interface ChildRequest {
  authority: PaletteAuthority;
  visit: PaletteVisit;
  token: symbol;
  command: Command;
  provider: NonNullable<Command["children"]>;
  active: boolean;
  owner: PalettePresentation;
  expectedState: PaletteState;
}

interface PresentationSuccessor {
  from: PalettePresentation;
  request: ChildRequest;
}

interface CloseTransition {
  authority: PaletteAuthority;
  visit: PaletteVisit;
  token: symbol;
  origin: PalettePresentation;
  presentation: PalettePresentation | null;
  onOpenChange: (open: boolean) => void;
  commands: () => Command[];
  groupOrder: readonly string[] | undefined;
  placeholder: string;
  expectedState: PaletteState;
  overlay: HTMLDivElement;
  content: HTMLDivElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLDivElement;
  returnFocus: HTMLElement | null;
  command: Command | null;
  autoFocusClaimed: boolean;
  focusRestored: boolean;
}

interface CommandExecution {
  authority: PaletteAuthority;
  visit: PaletteVisit;
  token: symbol;
  presentation: PalettePresentation;
  onOpenChange: (open: boolean) => void;
  commands: () => Command[];
  groupOrder: readonly string[] | undefined;
  placeholder: string;
  expectedState: PaletteState;
  command: Command;
  timer: ReturnType<typeof setTimeout> | null;
}

interface VisitFocus {
  visit: PaletteVisit;
  claimed: boolean;
  returnFocus: HTMLElement | null;
}

function publication<T extends HTMLElement>(): ElementPublication<T> {
  return { token: Symbol("command-palette-element"), element: null, lastElement: null };
}

function publishedElement<T extends HTMLElement>(element: T | null): ElementPublication<T> {
  return { token: Symbol("command-palette-element"), element, lastElement: element };
}

function controlPublication<T extends HTMLElement>(): ControlPublication<T> {
  return publication<T>();
}

function publicationNode<T extends HTMLElement>(value: ElementPublication<T>): T | null {
  return value.element ?? value.lastElement;
}

function commandFacts(command: Command): CommandFacts {
  return {
    source: command,
    keywords: [...command.keywords],
    id: command.id,
    title: command.title,
    group: command.group,
    shortcut: command.shortcut,
    icon: command.icon,
    when: command.when,
    run: command.run,
    children: command.children,
  };
}

function commandFactsAreCurrent(facts: CommandFacts): boolean {
  const command = facts.source;
  return (
    command.id === facts.id &&
    command.title === facts.title &&
    command.group === facts.group &&
    command.shortcut === facts.shortcut &&
    command.icon === facts.icon &&
    command.when === facts.when &&
    command.run === facts.run &&
    command.children === facts.children &&
    command.keywords.length === facts.keywords.length &&
    command.keywords.every((keyword, index) => keyword === facts.keywords[index])
  );
}

function paletteStateFacts(state: PaletteState): PaletteStateFacts {
  return {
    source: state,
    visit: state.visit,
    commands: state.commands,
    query: state.query,
    stack: state.stack.map((level) => ({ source: level, title: level.title, items: [...level.items] })),
    highlight: state.highlight,
    recent: [...state.recent],
    childLoad: state.childLoad,
    childError: state.childError,
  };
}

function stateFactsAreCurrent(facts: PaletteStateFacts, state: PaletteState): boolean {
  return (
    facts.source === state &&
    facts.visit === state.visit &&
    facts.commands === state.commands &&
    facts.query === state.query &&
    facts.highlight === state.highlight &&
    facts.childLoad === state.childLoad &&
    facts.childError === state.childError &&
    facts.recent.length === state.recent.length &&
    facts.recent.every((id, index) => id === state.recent[index]) &&
    facts.stack.length === state.stack.length &&
    facts.stack.every((level, index) => {
      const current = state.stack[index];
      return (
        current === level.source &&
        current.title === level.title &&
        current.items.length === level.items.length &&
        current.items.every((command, itemIndex) => command === level.items[itemIndex])
      );
    })
  );
}

function snapshotAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  return Object.freeze(
    [...element.attributes]
      .filter(
        ({ name }) =>
          !(
            (element.getAttribute("role") === "dialog" &&
              RADIX_SETTLING_ATTRIBUTES.has(name)) ||
            (element.classList.contains("dialog-overlay") &&
              (name === "aria-hidden" ||
                name === "data-aria-hidden" ||
                name === "style"))
          ),
      )
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotDom(node: Node): DomSnapshot {
  return Object.freeze({
    node,
    value: node.nodeValue,
    attributes: snapshotAttributes(node),
    children: Object.freeze([...node.childNodes].map(snapshotDom)),
  });
}

function domMatches(snapshot: DomSnapshot): boolean {
  const node = snapshot.node;
  if (node.nodeValue !== snapshot.value) return false;
  const attributes = snapshotAttributes(node);
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
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) => node.childNodes.item(index) === child.node && domMatches(child),
    )
  );
}

function isRadixFocusGuard(node: Node | null): boolean {
  return (
    node instanceof Element &&
    node.tagName === "SPAN" &&
    node.hasAttribute("data-radix-focus-guard")
  );
}

function previousCommittedSibling(node: Node): Node | null {
  let sibling = node.previousSibling;
  while (isRadixFocusGuard(sibling)) sibling = sibling?.previousSibling ?? null;
  return sibling;
}

function nextCommittedSibling(node: Node): Node | null {
  let sibling = node.nextSibling;
  while (isRadixFocusGuard(sibling)) sibling = sibling?.nextSibling ?? null;
  return sibling;
}

function capturePlacement(
  overlay: HTMLDivElement,
  content: HTMLDivElement,
): PalettePlacement | null {
  const parent = content.parentNode;
  const document = content.ownerDocument;
  if (
    !parent ||
    overlay.parentNode !== parent ||
    overlay.ownerDocument !== document ||
    !overlay.isConnected ||
    !content.isConnected
  ) {
    return null;
  }
  const ancestors: AncestorPlacement[] = [];
  let node = parent;
  while (node !== document) {
    const ancestorParent = node.parentNode;
    if (!ancestorParent) return null;
    ancestors.push(
      Object.freeze({
        node,
        parent: ancestorParent,
        previous: node.previousSibling,
        next: node.nextSibling,
      }),
    );
    node = ancestorParent;
  }
  return Object.freeze({
    document,
    parent,
    overlayPrevious: previousCommittedSibling(overlay),
    overlayNext: nextCommittedSibling(overlay),
    contentPrevious: previousCommittedSibling(content),
    contentNext: nextCommittedSibling(content),
    ancestors: Object.freeze(ancestors),
  });
}

function placementMatches(
  overlay: HTMLDivElement,
  content: HTMLDivElement,
  placement: PalettePlacement,
): boolean {
  return (
    overlay.isConnected &&
    content.isConnected &&
    overlay.ownerDocument === placement.document &&
    content.ownerDocument === placement.document &&
    overlay.parentNode === placement.parent &&
    content.parentNode === placement.parent &&
    previousCommittedSibling(overlay) === placement.overlayPrevious &&
    nextCommittedSibling(overlay) === placement.overlayNext &&
    previousCommittedSibling(content) === placement.contentPrevious &&
    nextCommittedSibling(content) === placement.contentNext &&
    placement.ancestors.every(
      (ancestor) =>
        ancestor.node.isConnected &&
        ancestor.node.parentNode === ancestor.parent &&
        ancestor.node.previousSibling === ancestor.previous &&
        ancestor.node.nextSibling === ancestor.next,
    )
  );
}

function createDomGuard(
  overlay: HTMLDivElement,
  content: HTMLDivElement,
  placement: PalettePlacement,
): PaletteDomGuard | null {
  const ownerWindow = placement.document.defaultView;
  const Observer = ownerWindow?.MutationObserver;
  if (!ownerWindow || !Observer) return null;
  let changed = false;
  const settling = new Set(
    [...RADIX_SETTLING_ATTRIBUTES].filter(
      (attribute) => !content.hasAttribute(attribute),
    ),
  );
  const record = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some((mutation) => {
      if (
        mutation.type === "attributes" &&
        mutation.target === content &&
        mutation.attributeName &&
        settling.delete(mutation.attributeName)
      ) {
        return false;
      }
      if (
        mutation.type === "attributes" &&
        mutation.target === overlay &&
        (mutation.attributeName === "aria-hidden" ||
          mutation.attributeName === "data-aria-hidden")
      ) {
        return false;
      }
      if (
        mutation.type === "attributes" &&
        mutation.attributeName === "name" &&
        mutation.target instanceof ownerWindow.HTMLInputElement &&
        mutation.target.getAttribute("role") === "combobox" &&
        !mutation.target.hasAttribute("name")
      ) {
        return false;
      }
      if (
        mutation.type === "childList" &&
        mutation.target === placement.parent &&
        [...mutation.addedNodes, ...mutation.removedNodes].length > 0 &&
        [...mutation.addedNodes, ...mutation.removedNodes].every(isRadixFocusGuard)
      ) {
        return false;
      }
      if (
        mutation.target === overlay ||
        mutation.target === content ||
        content.contains(mutation.target)
      ) {
        return true;
      }
      if (mutation.type !== "childList") {
        return false;
      }
      if (mutation.target === placement.parent) {
        if (
          mutation.previousSibling === overlay ||
          mutation.nextSibling === overlay ||
          mutation.previousSibling === content ||
          mutation.nextSibling === content
        ) {
          return true;
        }
        if (
          [...mutation.addedNodes, ...mutation.removedNodes].some(
            (node) =>
              node === overlay ||
              node === content ||
              (node instanceof Element &&
                (node.contains(overlay) || node.contains(content))),
          )
        ) {
          return true;
        }
      }
      return placement.ancestors.some(
        (ancestor) =>
          mutation.target === ancestor.parent &&
          (mutation.previousSibling === ancestor.node ||
            mutation.nextSibling === ancestor.node ||
            [...mutation.addedNodes, ...mutation.removedNodes].includes(
              ancestor.node,
            )),
      );
    });
  };
  const observer = new Observer(record);
  observer.observe(overlay, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(content, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  observer.observe(placement.parent, { childList: true });
  for (const ancestor of placement.ancestors) {
    observer.observe(ancestor.parent, { childList: true });
  }
  return Object.freeze({
    isClean: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function presentationElementsReady(presentation: PalettePresentation): boolean {
  const overlay = presentation.overlay.element;
  const content = presentation.content.element;
  const form = presentation.form.element;
  const input = presentation.input.element;
  const list = presentation.list.element;
  const ownerWindow = content?.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(overlay instanceof ownerWindow.HTMLDivElement) ||
    !(content instanceof ownerWindow.HTMLDivElement) ||
    !(form instanceof ownerWindow.HTMLFormElement) ||
    !(input instanceof ownerWindow.HTMLInputElement) ||
    !(list instanceof ownerWindow.HTMLDivElement) ||
    !overlay.isConnected ||
    !content.isConnected ||
    !form.isConnected ||
    !input.isConnected ||
    !list.isConnected ||
    overlay.ownerDocument !== content.ownerDocument ||
    overlay.parentNode !== content.parentNode ||
    overlay.nextElementSibling !== content ||
    content.getAttribute("role") !== "dialog" ||
    content.dataset.testid !== "command-palette" ||
    form.parentElement !== content ||
    form !== content.children.item(2) &&
      form !== content.firstElementChild?.nextElementSibling ||
    !form.contains(input) ||
    list.parentElement !== content ||
    list.getAttribute("role") !== "listbox" ||
    list.id !== "command-palette-list" ||
    input.getAttribute("role") !== "combobox" ||
    input.getAttribute("aria-controls") !== list.id ||
    input.disabled
  ) {
    return false;
  }
  const back = presentation.back?.element ?? null;
  if (
    (presentation.back
      ? !(back instanceof ownerWindow.HTMLButtonElement) ||
        !back.isConnected ||
        back.disabled ||
        back.type !== "button" ||
        back.parentElement !== form ||
        form.firstElementChild !== back
      : form.querySelector('[data-testid="palette-back"]') !== null)
  ) {
    return false;
  }
  const retry = presentation.retry?.element ?? null;
  if (
    (presentation.retry
      ? !(retry instanceof ownerWindow.HTMLButtonElement) ||
        !retry.isConnected ||
        retry.parentElement?.getAttribute("role") !== "alert"
      : content.querySelector('[role="alert"] button') !== null)
  ) {
    return false;
  }
  const domRows = [...list.querySelectorAll<HTMLDivElement>('[role="option"]')];
  return (
    domRows.length === presentation.rows.length &&
    presentation.rows.every((row, index) => {
      const element = row.element;
      const unavailable =
        presentation.state.childLoad?.command.id === row.command.id ||
        presentation.state.childError?.command.id === row.command.id;
      return (
        element instanceof ownerWindow.HTMLDivElement &&
        element.isConnected &&
        element.parentElement?.getAttribute("role") === "group" &&
        domRows[index] === element &&
        element.dataset.index === String(index) &&
        element.dataset.testid === `palette-item-${row.command.id}` &&
        element.getAttribute("aria-disabled") ===
          (unavailable ? "true" : null)
      );
    })
  );
}

function exactNativeClick(
  event: ReactMouseEvent<HTMLElement>,
  control: HTMLElement,
): MouseEvent | null {
  const ownerWindow = control.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  return event.type === "click" &&
    !event.defaultPrevented &&
    ownerWindow &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeEvent.type === "click" &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    target instanceof ownerWindow.Node &&
    target === nativeEvent.target &&
    target.isConnected &&
    target.ownerDocument === control.ownerDocument &&
    control.contains(target)
    ? nativeEvent
    : null;
}

function exactNativeMouse(
  event: ReactMouseEvent<HTMLElement>,
  control: HTMLElement,
  reactType: "mouseenter" | "mousedown",
  nativeType: "mouseover" | "mousedown",
): MouseEvent | null {
  const ownerWindow = control.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  const target = event.target;
  return event.type === reactType &&
    !event.defaultPrevented &&
    ownerWindow &&
    nativeEvent instanceof ownerWindow.MouseEvent &&
    nativeEvent.type === nativeType &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === control &&
    target instanceof ownerWindow.Node &&
    target === nativeEvent.target &&
    target.isConnected &&
    target.ownerDocument === control.ownerDocument &&
    control.contains(target)
    ? nativeEvent
    : null;
}

function exactNativeInput(
  event: ReactChangeEvent<HTMLInputElement>,
  input: HTMLInputElement,
): Event | null {
  const ownerWindow = input.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  return (event.type === "change" || event.type === "input") &&
    !event.defaultPrevented &&
    ownerWindow &&
    nativeEvent instanceof ownerWindow.Event &&
    (nativeEvent.type === "change" || nativeEvent.type === "input") &&
    !nativeEvent.defaultPrevented &&
    event.currentTarget === input &&
    event.target === input &&
    nativeEvent.target === input &&
    input.isConnected
    ? nativeEvent
    : null;
}

function exactNativeKey(
  event: ReactKeyboardEvent<HTMLInputElement>,
  input: HTMLInputElement,
): KeyboardEvent | null {
  const ownerDocument = input.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  if (
    !ownerWindow ||
    !(nativeEvent instanceof ownerWindow.KeyboardEvent) ||
    Object.getPrototypeOf(nativeEvent) !== ownerWindow.KeyboardEvent.prototype
  ) {
    return null;
  }
  const path = nativeEvent.composedPath();
  return event.type === "keydown" &&
    !event.defaultPrevented &&
    !event.isDefaultPrevented() &&
    !event.isPropagationStopped() &&
    event.bubbles &&
    event.cancelable &&
    event.isTrusted &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.repeat &&
    nativeEvent.type === "keydown" &&
    !nativeEvent.defaultPrevented &&
    !nativeEvent.cancelBubble &&
    nativeEvent.bubbles &&
    nativeEvent.cancelable &&
    nativeEvent.isTrusted &&
    !nativeEvent.altKey &&
    !nativeEvent.ctrlKey &&
    !nativeEvent.metaKey &&
    !nativeEvent.shiftKey &&
    !nativeEvent.repeat &&
    !nativeEvent.isComposing &&
    nativeEvent.key === event.key &&
    nativeEvent.view === ownerWindow &&
    event.currentTarget === input &&
    event.target === input &&
    nativeEvent.target === input &&
    input.isConnected &&
    ownerDocument.activeElement === input &&
    path[0] === input &&
    path.includes(ownerDocument) &&
    path.at(-1) === ownerWindow
    ? nativeEvent
    : null;
}

function exactNativeSubmit(
  event: ReactFormEvent<HTMLFormElement>,
  form: HTMLFormElement,
  input: HTMLInputElement,
): Event | null {
  const ownerWindow = form.ownerDocument.defaultView;
  const nativeEvent = event.nativeEvent;
  if (
    event.type !== "submit" ||
    event.defaultPrevented ||
    !ownerWindow ||
    !(nativeEvent instanceof ownerWindow.Event) ||
    nativeEvent.type !== "submit" ||
    nativeEvent.defaultPrevented ||
    event.currentTarget !== form ||
    event.target !== form ||
    nativeEvent.target !== form ||
    !form.isConnected ||
    input.form !== form ||
    input.disabled
  ) {
    return null;
  }
  if (
    typeof ownerWindow.SubmitEvent === "function" &&
    nativeEvent instanceof ownerWindow.SubmitEvent &&
    nativeEvent.submitter !== null
  ) {
    return null;
  }
  return nativeEvent;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called on every open so the list reflects the current editor state. */
  commands: () => Command[];
  /** Group display order for the root list. */
  groupOrder?: readonly string[];
  placeholder?: string;
}

function CommandIcon({ name }: { name?: string }) {
  const Icon = name ? ICONS[name] : undefined;
  if (!Icon) return <span className="inline-block h-4 w-4" aria-hidden />;
  return <Icon size={16} className="shrink-0 text-ink-3" aria-hidden />;
}

export const CommandPalette = memo(function CommandPalette({ open, onOpenChange, commands, groupOrder, placeholder = "Type a command…" }: CommandPaletteProps) {
  const [state, setState] = useState<PaletteState>({
    visit: null,
    commands: null,
    query: "",
    stack: [],
    highlight: 0,
    recent: [],
    childLoad: null,
    childError: null,
  });
  const authority = useMemo<PaletteAuthority>(() => ({ token: Symbol("command-palette") }), []);
  const authorityRef = useRef<PaletteAuthority | null>(null);
  const visitRef = useRef<PaletteVisit | null>(null);
  const visitFocusRef = useRef<VisitFocus | null>(null);
  const presentationRef = useRef<PalettePresentation | null>(null);
  const committedPresentationRef = useRef<PalettePresentation | null>(null);
  const activeCommitRef = useRef<CommittedPresentation | null>(null);
  const replayRef = useRef<PresentationReplay | null>(null);
  const layoutActiveRef = useRef(new WeakSet<PalettePresentation>());
  const renderGenerationRef = useRef(0);
  const claimedEventsRef = useRef(new WeakSet<object>());
  const childRequestRef = useRef<ChildRequest | null>(null);
  const successorRef = useRef<PresentationSuccessor | null>(null);
  const closeRef = useRef<CloseTransition | null>(null);
  const commandTimersRef = useRef(new Set<CommandExecution>());
  const claimedControlsRef = useRef(new WeakSet<object>());
  const portalElementsRef = useRef<{ overlay: HTMLDivElement | null; content: HTMLDivElement | null }>({
    overlay: null,
    content: null,
  });
  const portalTokensRef = useRef<{ overlay: symbol | null; content: symbol | null }>({
    overlay: null,
    content: null,
  });
  const [portalElements, setPortalElements] = useState<{ overlay: HTMLDivElement | null; content: HTMLDivElement | null }>({
    overlay: null,
    content: null,
  });
  const retirePortalElement = useCallback((element: HTMLDivElement) => {
    const commit = activeCommitRef.current;
    if (!commit) return;
    const publication =
      commit.overlay === element
        ? commit.source.overlay
        : commit.content === element
          ? commit.source.content
          : null;
    if (!publication) return;
    retireCommittedPresentation(commit, "ref", publication);
    // This callback is mount-stable; retirement reads current authority through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const bindOverlay = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const token = Symbol("command-palette-overlay-ref");
      portalTokensRef.current.overlay = token;
      const cleanup = () => {
        if (
          portalElementsRef.current.overlay !== element ||
          portalTokensRef.current.overlay !== token
        ) {
          return;
        }
        retirePortalElement(element);
        portalElementsRef.current.overlay = null;
        portalTokensRef.current.overlay = null;
      };
      const previous = portalElementsRef.current.overlay;
      if (previous === element) {
        noteRefReplay(element, portalElementsRef.current.overlay, "overlay");
        return cleanup;
      }
      if (previous) retirePortalElement(previous);
      portalElementsRef.current.overlay = element;
      noteRefReplay(element, previous, "overlay");
      if (portalElementsRef.current.content) {
        setPortalElements({ overlay: element, content: portalElementsRef.current.content });
      }
      return cleanup;
    },
    // Ref publication is mount-stable and resolves replay state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [retirePortalElement],
  );
  const bindContent = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const token = Symbol("command-palette-content-ref");
      portalTokensRef.current.content = token;
      const cleanup = () => {
        if (
          portalElementsRef.current.content !== element ||
          portalTokensRef.current.content !== token
        ) {
          return;
        }
        retirePortalElement(element);
        portalElementsRef.current.content = null;
        portalTokensRef.current.content = null;
      };
      const previous = portalElementsRef.current.content;
      if (previous === element) {
        noteRefReplay(element, portalElementsRef.current.content, "content");
        return cleanup;
      }
      if (previous) retirePortalElement(previous);
      portalElementsRef.current.content = element;
      noteRefReplay(element, previous, "content");
      if (portalElementsRef.current.overlay) {
        setPortalElements({ overlay: portalElementsRef.current.overlay, content: element });
      }
      return cleanup;
    },
    // Ref publication is mount-stable and resolves replay state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [retirePortalElement],
  );
  const visit = useMemo<PaletteVisit | null>(
    () =>
      open
        ? {
            authority,
            token: Symbol("command-palette-visit"),
            // A menu item that opened the palette unmounts with its menu, so this resolves it to the menu's trigger.
            returnFocus: focusReturnTarget(),
          }
        : null,
    [authority, open],
  );

  useLayoutEffect(() => {
    authorityRef.current = authority;
    const commandTimers = commandTimersRef.current;

    return () => {
      if (authorityRef.current === authority) authorityRef.current = null;
      if (visitRef.current?.authority === authority) visitRef.current = null;
      if (visitFocusRef.current?.visit.authority === authority) visitFocusRef.current = null;
      const request = childRequestRef.current;
      if (request?.authority === authority) {
        request.active = false;
        childRequestRef.current = null;
      }
      if (successorRef.current?.request.authority === authority) successorRef.current = null;
      if (closeRef.current?.authority === authority) closeRef.current = null;
      for (const execution of commandTimers) {
        if (execution.authority !== authority) continue;
        if (execution.timer !== null) clearTimeout(execution.timer);
        commandTimers.delete(execution);
      }
      const active = activeCommitRef.current;
      if (active?.source.authority === authority) retireCommittedPresentation(active, "layout");
      if (committedPresentationRef.current?.authority === authority) committedPresentationRef.current = null;
    };
    // Authority teardown must not restart for each render-local retirement closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority]);

  useLayoutEffect(() => {
    if (!visit || authorityRef.current !== authority) return;
    const claimedControls = claimedControlsRef.current;
    visitRef.current = visit;
    visitFocusRef.current = { visit, claimed: false, returnFocus: visit.returnFocus };
    if (closeRef.current?.authority === authority) closeRef.current = null;
    for (const execution of commandTimersRef.current) {
      if (execution.authority !== authority) continue;
      if (execution.timer !== null) clearTimeout(execution.timer);
      commandTimersRef.current.delete(execution);
    }

    return () => {
      if (visitRef.current === visit) visitRef.current = null;

      const current = activeCommitRef.current?.source ?? null;
      if (
        authorityRef.current === authority &&
        !closeRef.current &&
        current?.visit === visit &&
        ownsPresentation(current) &&
        current.overlay.element &&
        current.content.element &&
        current.form.element &&
        current.input.element &&
        current.list.element
      ) {
        claimedControls.add(current);
        const visitFocus = visitFocusRef.current;
        closeRef.current = {
          authority,
          visit,
          token: Symbol("command-palette-close"),
          origin: current,
          presentation: null,
          onOpenChange: current.onOpenChange,
          commands: current.commands,
          groupOrder: current.groupOrder,
          placeholder: current.placeholder,
          expectedState: current.state,
          overlay: current.overlay.element,
          content: current.content.element,
          form: current.form.element,
          input: current.input.element,
          list: current.list.element,
          returnFocus: visitFocus?.visit === visit ? visitFocus.returnFocus : null,
          command: null,
          autoFocusClaimed: false,
          focusRestored: false,
        };
      }

      const request = childRequestRef.current;
      if (request?.visit === visit) {
        request.active = false;
        childRequestRef.current = null;
        if (successorRef.current?.request === request) successorRef.current = null;
      }
      if (visitFocusRef.current?.visit === visit) visitFocusRef.current = null;
    };
    // Visit teardown validates the current presentation through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authority, visit]);

  const { query, stack, highlight, recent, childLoad, childError } = state;
  const root = stack[0];
  const level = stack[stack.length - 1];
  const atRoot = stack.length <= 1;
  const trimmed = query.trim();
  const visible = useMemo(() => {
    if (!level) return [];
    const matched = filterCommands(query, level.items);
    return !trimmed && atRoot ? withRecentFirst(matched, recent) : matched;
  }, [level, query, trimmed, atRoot, recent]);
  const sections = useMemo<CommandSection[]>(
    () => (trimmed ? [{ group: null, items: visible }] : groupCommands(visible, groupOrder)),
    [visible, trimmed, groupOrder],
  );
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const rows = flat.map<RowPublication>((command, index) => ({
    ...controlPublication<HTMLDivElement>(),
    command,
    index,
  }));
  const publishedCommands = [
    ...new Set([...stack.flatMap((entry) => entry.items), ...flat]),
  ];
  const generation = ++renderGenerationRef.current;
  const presentation: PalettePresentation = {
    authority,
    visit,
    token: Symbol("command-palette-presentation"),
    generation,
    open,
    onOpenChange,
    commands,
    groupOrder,
    placeholder,
    state,
    root,
    level,
    atRoot,
    visible,
    sections,
    flat,
    stateFacts: paletteStateFacts(state),
    commandFacts: publishedCommands.map(commandFacts),
    groupOrderFacts: groupOrder ? Object.freeze([...groupOrder]) : undefined,
    overlay: publishedElement(portalElements.overlay),
    content: publishedElement(portalElements.content),
    form: publication<HTMLFormElement>(),
    input: publication<HTMLInputElement>(),
    list: publication<HTMLDivElement>(),
    back: atRoot ? null : controlPublication<HTMLButtonElement>(),
    retry: childError ? controlPublication<HTMLButtonElement>() : null,
    rows,
    layoutAttempted: false,
    republishRequested: false,
    consumedEvents: new WeakSet<object>(),
  };

  function invalidateChildRequest(request: ChildRequest | null): void {
    if (!request) return;
    request.active = false;
    if (childRequestRef.current === request) childRequestRef.current = null;
    if (successorRef.current?.request === request) successorRef.current = null;
  }

  function releaseReplay(replay: PresentationReplay): void {
    if (replayRef.current === replay) replayRef.current = null;
    replay.source.guard.release();
  }

  function retireCommittedPresentation(
    commit: CommittedPresentation,
    reason: "layout" | "ref" | "ordinary",
    detached?: ElementPublication<HTMLElement>,
  ): void {
    let replay = replayRef.current?.source === commit ? replayRef.current : null;
    if (!commit.retired) {
      commit.retired = true;
      if (activeCommitRef.current === commit) activeCommitRef.current = null;
      if (presentationRef.current === commit.source) presentationRef.current = null;
      replay = {
        source: commit,
        layoutRetired: false,
        invalid: reason === "ordinary",
        refs: commit.elements.map(({ publication, element }) => ({
          publication,
          element,
          detached: false,
          reattached: false,
        })),
      };
      replayRef.current = replay;
    }
    if (!replay) return;
    if (reason === "layout") replay.layoutRetired = true;
    if (reason === "ordinary") {
      replay.invalid = true;
      releaseReplay(replay);
      return;
    }
    if (detached) {
      const ref = replay.refs.find((entry) => entry.publication === detached);
      if (!ref || detached.element !== null && detached.element !== ref.element) {
        replay.invalid = true;
      } else {
        ref.detached = true;
        ref.reattached = false;
      }
    }
    queueMicrotask(() => {
      if (
        replayRef.current === replay &&
        !layoutActiveRef.current.has(commit.source) &&
        activeCommitRef.current !== commit
      ) {
        releaseReplay(replay);
      }
    });
  }

  function noteRefReplay(
    element: HTMLElement,
    _previous: HTMLElement | null,
    kind: "overlay" | "content",
  ): void {
    const replay = replayRef.current;
    if (!replay) return;
    const publication =
      kind === "overlay" ? replay.source.source.overlay : replay.source.source.content;
    const ref = replay.refs.find((entry) => entry.publication === publication);
    if (!ref || !ref.detached || ref.element !== element) {
      replay.invalid = true;
      return;
    }
    ref.reattached = true;
    if (layoutActiveRef.current.has(replay.source.source)) {
      commitPresentation(replay.source.source);
    }
  }

  function bindElement<T extends HTMLElement>(
    value: PalettePresentation,
    target: ElementPublication<T>,
    element: T | null,
  ): void {
    if (target.element === element) return;
    const previous = target.element;
    if (element) {
      const replay = replayRef.current;
      const ref =
        replay?.source.source === value
          ? replay.refs.find((entry) => entry.publication === target)
          : null;
      if (target.lastElement && target.lastElement !== element) {
        if (replay) replay.invalid = true;
        const active = activeCommitRef.current;
        if (active?.source === value) {
          retireCommittedPresentation(
            active,
            "ordinary",
          );
        }
      }
      target.element = element;
      target.lastElement = element;
      if (ref) {
        if (!ref.detached || ref.element !== element || previous !== null) {
          replay!.invalid = true;
        } else {
          ref.reattached = true;
        }
      }
      if (value.layoutAttempted && layoutActiveRef.current.has(value)) {
        commitPresentation(value);
      }
      return;
    }
    if (!previous) return;
    target.lastElement = previous;
    target.element = null;
    const active = activeCommitRef.current;
    if (active?.source === value) {
      retireCommittedPresentation(
        active,
        "ref",
        target as ElementPublication<HTMLElement>,
      );
      return;
    }
    const replay = replayRef.current;
    if (replay?.source.source !== value) return;
    const ref = replay.refs.find((entry) => entry.publication === target);
    if (!ref || ref.element !== previous) replay.invalid = true;
    else {
      ref.detached = true;
      ref.reattached = false;
    }
  }

  function presentationFactsAreCurrent(value: PalettePresentation): boolean {
    const request = value.state.childLoad?.request;
    const commandSet = new Set(value.commandFacts.map((facts) => facts.source));
    return (
      committedPresentationRef.current === value &&
      authorityRef.current === value.authority &&
      visitRef.current === value.visit &&
      !!value.visit &&
      value.open &&
      stateFactsAreCurrent(value.stateFacts, value.state) &&
      value.root === value.state.stack[0] &&
      value.level === value.state.stack[value.state.stack.length - 1] &&
      value.atRoot === (value.state.stack.length <= 1) &&
      value.rows.length === value.flat.length &&
      value.rows.every(
        (row, index) =>
          row.index === index &&
          row.command === value.flat[index] &&
          commandSet.has(row.command),
      ) &&
      value.commandFacts.every(commandFactsAreCurrent) &&
      value.groupOrderFacts?.length === value.groupOrder?.length &&
      (value.groupOrderFacts?.every((group, index) => group === value.groupOrder?.[index]) ??
        value.groupOrder === undefined) &&
      (!request ||
        (request.authority === value.authority &&
          request.visit === value.visit &&
          request.command === value.state.childLoad?.command &&
          request.provider === request.command.children &&
          request.expectedState === value.state &&
          request.active &&
          childRequestRef.current === request))
    );
  }

  function committedDomIsCurrent(commit: CommittedPresentation): boolean {
    return (
      !commit.retired &&
      commit.guard.isClean() &&
      presentationElementsReady(commit.source) &&
      commit.source.overlay.element === commit.overlay &&
      commit.source.content.element === commit.content &&
      commit.source.form.element === commit.form &&
      commit.source.input.element === commit.input &&
      commit.source.list.element === commit.list &&
      (commit.source.back?.element ?? null) === commit.back &&
      (commit.source.retry?.element ?? null) === commit.retry &&
      commit.source.rows.every((row, index) => row.element === commit.rows[index]) &&
      placementMatches(commit.overlay, commit.content, commit.placement) &&
      domMatches(commit.overlayTree) &&
      domMatches(commit.contentTree)
    );
  }

  function ownsPresentation(value: PalettePresentation): boolean {
    const commit = activeCommitRef.current;
    if (
      !commit ||
      commit.source !== value ||
      commit.retired ||
      presentationRef.current !== value
    ) {
      return false;
    }
    if (
      !presentationFactsAreCurrent(value) ||
      !committedDomIsCurrent(commit)
    ) {
      retireCommittedPresentation(commit, "ordinary");
      return false;
    }
    return true;
  }

  function ownsElement<T extends HTMLElement>(
    value: PalettePresentation,
    target: ElementPublication<T>,
    currentTarget: EventTarget | null,
  ): currentTarget is T {
    const commit = activeCommitRef.current;
    return (
      ownsPresentation(value) &&
      !!commit &&
      commit.elements.some(
        (entry) =>
          entry.publication === target &&
          entry.element === currentTarget,
      ) &&
      target.element === currentTarget &&
      !!target.element?.isConnected &&
      !!value.content.element?.contains(target.element)
    );
  }

  function claimEvent(
    value: PalettePresentation,
    event: object,
    nativeEvent: object,
    relatedEvent?: object,
  ): boolean {
    const commit = activeCommitRef.current;
    if (
      !commit ||
      !ownsPresentation(value) ||
      commit.source !== value ||
      claimedEventsRef.current.has(event) ||
      claimedEventsRef.current.has(nativeEvent) ||
      (relatedEvent !== undefined && claimedEventsRef.current.has(relatedEvent))
    ) {
      return false;
    }
    commit.claimed = true;
    claimedEventsRef.current.add(event);
    claimedEventsRef.current.add(nativeEvent);
    if (relatedEvent !== undefined) claimedEventsRef.current.add(relatedEvent);
    value.consumedEvents.add(event);
    value.consumedEvents.add(nativeEvent);
    if (relatedEvent !== undefined) value.consumedEvents.add(relatedEvent);
    return true;
  }

  function ownsChildRequest(request: ChildRequest): boolean {
    const owner = request.owner;
    const transferring = successorRef.current?.request === request && successorRef.current.from === owner;
    const current = activeCommitRef.current?.source ?? null;
    const transferCommit = activeCommitRef.current;
    const ownsTransfer =
      transferring &&
      !!transferCommit &&
      transferCommit.source === owner &&
      !transferCommit.retired &&
      presentationRef.current === owner &&
      committedDomIsCurrent(transferCommit);
    const committedOwner =
      current?.state.childLoad?.request === request &&
      current.state === request.expectedState &&
      ownsPresentation(current)
        ? current
        : null;
    if (committedOwner) request.owner = committedOwner;
    return (
      request.active &&
      authorityRef.current === request.authority &&
      visitRef.current === request.visit &&
      childRequestRef.current === request &&
      ((!!committedOwner &&
        committedOwner.authority === request.authority &&
        committedOwner.visit === request.visit) ||
        (ownsTransfer &&
          owner.authority === request.authority &&
          owner.visit === request.visit)) &&
      request.command.children === request.provider &&
      (committedOwner?.state.childLoad?.request === request || transferring)
    );
  }

  function focusInput(value: PalettePresentation): void {
    const input = value.input.element;
    if (ownsPresentation(value) && input?.isConnected && value.content.element?.contains(input)) input.focus();
  }

  function startChildren(value: PalettePresentation, command: Command, retry: boolean): void {
    const provider = command.children;
    if (!ownsPresentation(value) || !provider) return;
    const currentRequest = childRequestRef.current;
    if (currentRequest?.active && currentRequest.command === command && currentRequest.provider === provider) return;
    invalidateChildRequest(currentRequest);

    const request: ChildRequest = {
      authority: value.authority,
      visit: value.visit!,
      token: Symbol("command-palette-child"),
      command,
      provider,
      active: true,
      owner: value,
      expectedState: value.state,
    };
    const load: ChildLoad = { request, command, retry };
    const nextState: PaletteState = {
      ...value.state,
      childLoad: load,
      childError: retry ? value.state.childError : null,
    };
    request.expectedState = nextState;
    childRequestRef.current = request;
    successorRef.current = { from: value, request };
    setState(nextState);

    let pending: Promise<Command[]>;
    try {
      if (!ownsChildRequest(request)) return;
      pending = Promise.resolve(provider());
    } catch (error: unknown) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (items) => {
        if (!ownsChildRequest(request)) return;
        const owner = request.owner;
        focusInput(owner);
        invalidateChildRequest(request);
        setState({
          ...owner.state,
          query: "",
          stack: [...owner.state.stack, { title: command.title.replace(/…$/, ""), items }],
          highlight: 0,
          childLoad: null,
          childError: null,
        });
      },
      (error: unknown) => {
        if (!ownsChildRequest(request)) return;
        const owner = request.owner;
        const title = command.title.replace(/…$/, "").trim();
        focusInput(owner);
        invalidateChildRequest(request);
        setState({
          ...owner.state,
          childLoad: null,
          childError: { command, message: apiErrorText(error, `Could not load ${title || "commands"}`) },
        });
      },
    );
  }

  function beginClose(value: PalettePresentation, command: Command | null, nextState: PaletteState): void {
    const currentVisit = value.visit;
    const overlay = value.overlay.element;
    const content = value.content.element;
    const form = value.form.element;
    const input = value.input.element;
    const list = value.list.element;
    // Running a command needs the exact presentation the user picked from; a dismissal just closes.
    if (
      (command !== null && !ownsPresentation(value)) ||
      !currentVisit ||
      claimedControlsRef.current.has(value) ||
      closeRef.current ||
      !overlay ||
      !content ||
      !form ||
      !input ||
      !list
    ) {
      return;
    }

    claimedControlsRef.current.add(value);
    const visitFocus = visitFocusRef.current;
    closeRef.current = {
      authority: value.authority,
      visit: currentVisit,
      token: Symbol("command-palette-close"),
      origin: value,
      presentation: null,
      onOpenChange: value.onOpenChange,
      commands: value.commands,
      groupOrder: value.groupOrder,
      placeholder: value.placeholder,
      expectedState: nextState,
      overlay,
      content,
      form,
      input,
      list,
      returnFocus: visitFocus?.visit === currentVisit ? visitFocus.returnFocus : null,
      command,
      autoFocusClaimed: false,
      focusRestored: false,
    };
    if (nextState !== value.state) setState(nextState);
    value.onOpenChange(false);
  }

  function back(value: PalettePresentation): void {
    const control = value.back;
    if (!control || claimedControlsRef.current.has(control) || !ownsPresentation(value) || value.atRoot || value.state.stack.length <= 1) return;
    claimedControlsRef.current.add(control);
    invalidateChildRequest(value.state.childLoad?.request ?? null);
    setState({
      ...value.state,
      query: "",
      stack: value.state.stack.slice(0, -1),
      highlight: 0,
      childLoad: null,
      childError: null,
    });
  }

  function pickRow(value: PalettePresentation, row: RowPublication): void {
    if (
      !ownsPresentation(value) ||
      value.rows[row.index] !== row ||
      row.command !== value.flat[row.index] ||
      !row.element?.isConnected ||
      !value.list.element?.contains(row.element) ||
      claimedControlsRef.current.has(row) ||
      value.state.childLoad?.command.id === row.command.id ||
      value.state.childError?.command.id === row.command.id
    ) {
      return;
    }

    claimedControlsRef.current.add(row);
    if (row.command.children) {
      startChildren(value, row.command, false);
      return;
    }

    invalidateChildRequest(value.state.childLoad?.request ?? null);
    const nextRecent = pushRecent(value.state.recent, row.command.id);
    saveRecent(nextRecent);
    beginClose(
      value,
      row.command,
      {
        ...value.state,
        recent: nextRecent,
        childLoad: null,
        childError: null,
      },
    );
  }

  function presentationElements(
    value: PalettePresentation,
  ): CommittedElement[] | null {
    const elements: CommittedElement[] = [];
    const append = <T extends HTMLElement>(
      publication: ElementPublication<T> | null,
    ) => {
      const element = publication?.element;
      if (!publication || !element) return false;
      elements.push({
        publication: publication as ElementPublication<HTMLElement>,
        element,
      });
      return true;
    };
    if (
      !append(value.overlay) ||
      !append(value.content) ||
      !append(value.form) ||
      !append(value.input) ||
      !append(value.list) ||
      (value.back !== null && !append(value.back)) ||
      (value.retry !== null && !append(value.retry)) ||
      value.rows.some((row) => !append(row))
    ) {
      return null;
    }
    return elements;
  }

  function createCommittedPresentation(
    value: PalettePresentation,
  ): CommittedPresentation | null {
    if (!presentationElementsReady(value)) return null;
    const elements = presentationElements(value);
    const overlay = value.overlay.element;
    const content = value.content.element;
    const form = value.form.element;
    const input = value.input.element;
    const list = value.list.element;
    const placement =
      overlay && content ? capturePlacement(overlay, content) : null;
    if (
      !elements ||
      !overlay ||
      !content ||
      !form ||
      !input ||
      !list ||
      !placement
    ) {
      return null;
    }
    const guard = createDomGuard(overlay, content, placement);
    if (!guard) return null;
    return {
      token: Symbol("command-palette-commit"),
      source: value,
      elements,
      overlay,
      content,
      form,
      input,
      list,
      back: value.back?.element ?? null,
      retry: value.retry?.element ?? null,
      rows: value.rows.map((row) => row.element!),
      placement,
      overlayTree: snapshotDom(overlay),
      contentTree: snapshotDom(content),
      guard,
      retired: false,
      claimed: false,
    };
  }

  function exactReplayAllows(
    value: PalettePresentation,
    next: CommittedPresentation,
  ): boolean {
    const replay = replayRef.current;
    if (!replay) return true;
    if (replay.source.source !== value) {
      releaseReplay(replay);
      return true;
    }
    const noRefReplay = replay.refs.every(
      (entry) => !entry.detached && !entry.reattached,
    );
    const noPartialRefReplay = replay.refs.every(
      (entry) => entry.detached === entry.reattached,
    );
    const refWasReplayed = (publication: ElementPublication<HTMLElement>) =>
      replay.refs.some(
        (entry) => entry.publication === publication && entry.detached && entry.reattached,
      );
    const completeGroupReplay = (
      publications: readonly ElementPublication<HTMLElement>[],
    ) => {
      const replayed = publications.filter(refWasReplayed).length;
      return replayed === 0 || replayed === publications.length;
    };
    const primaryGroups = [
      [value.overlay, value.content],
      [value.form, value.input, value.list],
    ] as readonly (readonly ElementPublication<HTMLElement>[])[];
    // Rows are not a group: Strict Mode replays newly placed rows one subtree at a time,
    // so a reopen after a dismissal can replay only some of them.
    const completeRefReplay =
      noPartialRefReplay &&
      replay.refs.some((entry) => entry.detached) &&
      primaryGroups.every(completeGroupReplay);
    const exact =
      !replay.invalid &&
      !replay.source.claimed &&
      (completeRefReplay || (replay.layoutRetired && noRefReplay)) &&
      replay.refs.length === next.elements.length &&
      replay.refs.every((entry, index) => {
        const current = next.elements[index];
        return (
          current?.publication === entry.publication &&
          current.element === entry.element
        );
      }) &&
      replay.source.guard.isClean() &&
      placementMatches(
        replay.source.overlay,
        replay.source.content,
        replay.source.placement,
      ) &&
      domMatches(replay.source.overlayTree) &&
      domMatches(replay.source.contentTree);
    releaseReplay(replay);
    return exact;
  }

  function commitPresentation(value: PalettePresentation): void {
    value.layoutAttempted = true;
    if (
      authorityRef.current !== authority ||
      value.generation !== renderGenerationRef.current
    ) {
      return;
    }
    committedPresentationRef.current = value;

    if (value.open) {
      if (!value.visit || visitRef.current !== value.visit || !presentationElementsReady(value)) return;
      if (value.state.visit !== value.visit || value.state.commands !== value.commands) {
        invalidateChildRequest(childRequestRef.current);
        const loadedRecent = loadRecent();
        if (
          authorityRef.current !== value.authority ||
          visitRef.current !== value.visit ||
          committedPresentationRef.current !== value ||
          !presentationElementsReady(value)
        ) {
          return;
        }
        const items = value.commands();
        if (
          authorityRef.current !== value.authority ||
          visitRef.current !== value.visit ||
          committedPresentationRef.current !== value ||
          !presentationElementsReady(value)
        ) {
          return;
        }
        setState({
          visit: value.visit,
          commands: value.commands,
          query: "",
          stack: [{ title: null, items }],
          highlight: 0,
          recent: loadedRecent,
          childLoad: null,
          childError: null,
        });
        return;
      }

      if (closeRef.current?.authority === authority) closeRef.current = null;
      for (const execution of commandTimersRef.current) {
        if (execution.authority !== authority) continue;
        if (execution.timer !== null) clearTimeout(execution.timer);
        commandTimersRef.current.delete(execution);
      }

      if (!presentationFactsAreCurrent(value)) return;
      const active = activeCommitRef.current;
      if (active?.source === value && !active.retired) return;
      const commit = createCommittedPresentation(value);
      if (!commit || !exactReplayAllows(value, commit)) {
        commit?.guard.release();
        return;
      }
      if (active && active !== commit) {
        retireCommittedPresentation(active, "ordinary");
        const staged = replayRef.current;
        if (staged?.source === active) releaseReplay(staged);
      }
      activeCommitRef.current = commit;
      presentationRef.current = value;
      if (
        !commit.content.ownerDocument.defaultView ||
        !presentationFactsAreCurrent(value) ||
        !committedDomIsCurrent(commit)
      ) {
        retireCommittedPresentation(commit, "ordinary");
        const staged = replayRef.current;
        if (staged?.source === commit) releaseReplay(staged);
        return;
      }
      const request = value.state.childLoad?.request;
      const requestOwner = request?.owner;
      const adoptsRequest =
        !!request &&
        request.active &&
        childRequestRef.current === request &&
        request.expectedState === value.state &&
        !!requestOwner &&
        request.authority === value.authority &&
        request.visit === value.visit &&
        request.command === value.state.childLoad?.command &&
        request.provider === request.command.children;
      if (request && adoptsRequest) {
        request.owner = value;
        successorRef.current = null;
      }
      return;
    }

    const close = closeRef.current;
    if (
      close?.authority === authority &&
      close.expectedState === value.state &&
      close.onOpenChange === value.onOpenChange &&
      close.commands === value.commands &&
      close.groupOrder === value.groupOrder &&
      close.placeholder === value.placeholder
    ) {
      if (
        publicationNode(value.overlay) === close.overlay &&
        publicationNode(value.content) === close.content &&
        publicationNode(value.form) === close.form &&
        publicationNode(value.input) === close.input &&
        publicationNode(value.list) === close.list
      ) {
        close.presentation = value;
      }
    } else if (close?.authority === authority) {
      closeRef.current = null;
    }

    for (const execution of commandTimersRef.current) {
      if (execution.authority !== authority) continue;
      const exact =
        execution.expectedState === value.state &&
        execution.onOpenChange === value.onOpenChange &&
        execution.commands === value.commands &&
        execution.groupOrder === value.groupOrder &&
        execution.placeholder === value.placeholder;
      if (exact) continue;
      if (execution.timer !== null) clearTimeout(execution.timer);
      commandTimersRef.current.delete(execution);
    }
  }

  useLayoutEffect(() => {
    const layoutActive = layoutActiveRef.current;
    layoutActive.add(presentation);
    commitPresentation(presentation);
    return () => {
      layoutActive.delete(presentation);
      const active = activeCommitRef.current;
      if (active?.source === presentation) {
        retireCommittedPresentation(active, "layout");
      } else {
        const replay = replayRef.current;
        if (replay?.source.source === presentation) replay.layoutRetired = true;
      }
    };
  });

  useEffect(() => {
    if (!ownsPresentation(presentation)) return;
    const selected = presentation.rows[presentation.state.highlight];
    if (selected?.element?.isConnected && presentation.list.element?.contains(selected.element)) {
      selected.element.scrollIntoView({ block: "nearest" });
    }
  });

  let index = -1;
  const retrying = !!childError && childLoad?.retry === true && childLoad.command.id === childError.command.id;
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        invalidateChildRequest(presentation.state.childLoad?.request ?? null);
        const nextState =
          presentation.state.childLoad || presentation.state.childError
            ? { ...presentation.state, childLoad: null, childError: null }
            : presentation.state;
        beginClose(presentation, null, nextState);
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          ref={bindOverlay}
          className="dialog-overlay animate-fade-in"
        />
        <RadixDialog.Content
          ref={bindContent}
          className="fixed left-1/2 top-[12vh] z-50 w-[min(92vw,600px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/20 outline-none animate-fade-in"
          aria-label="Command palette"
          data-testid="command-palette"
          onOpenAutoFocus={(event) => {
            const input = presentation.input.element;
            const currentVisit = presentation.visit;
            const exactBoundary =
              presentation.open &&
              !!currentVisit &&
              authorityRef.current === presentation.authority &&
              visitRef.current === currentVisit &&
              committedPresentationRef.current === presentation &&
              presentation.content.element === event.currentTarget &&
              !!presentation.content.element?.isConnected &&
              !!input?.isConnected &&
              presentation.content.element.contains(input) &&
              presentationElementsReady(presentation);
            if (
              !exactBoundary ||
              !currentVisit ||
              visitFocusRef.current?.visit !== currentVisit ||
              visitFocusRef.current.claimed ||
              !(event instanceof (presentation.content.element?.ownerDocument.defaultView?.Event ?? Event)) ||
              !claimEvent(presentation, event, event)
            ) {
              return;
            }
            event.preventDefault();
            visitFocusRef.current = {
              visit: currentVisit,
              claimed: true,
              returnFocus: visitFocusRef.current.returnFocus ?? focusedElement(),
            };
            input.focus();
          }}
          onCloseAutoFocus={(event) => {
            const close = closeRef.current;
            const exactHandler = close?.presentation ? close.presentation === presentation : close?.origin === presentation;
            const ownerWindow = close?.content.ownerDocument.defaultView;
            if (
              !close ||
              !exactHandler ||
              !ownerWindow ||
              close.authority !== authority ||
              authorityRef.current !== authority ||
              close.content !== event.currentTarget ||
              close.autoFocusClaimed ||
              !(event instanceof ownerWindow.Event) ||
              claimedEventsRef.current.has(event)
            ) {
              return;
            }
            claimedEventsRef.current.add(event);
            presentation.consumedEvents.add(event);
            close.autoFocusClaimed = true;
            event.preventDefault();
            if (!close.focusRestored) {
              close.focusRestored = true;
              restoreFocus(close.returnFocus);
            }
            if (closeRef.current === close) closeRef.current = null;
            if (!close.command) return;

            const execution: CommandExecution = {
              authority,
              visit: close.visit,
              token: Symbol("command-palette-execution"),
              presentation,
              onOpenChange: close.onOpenChange,
              commands: close.commands,
              groupOrder: close.groupOrder,
              placeholder: close.placeholder,
              expectedState: close.expectedState,
              command: close.command,
              timer: null,
            };
            commandTimersRef.current.add(execution);
            execution.timer = setTimeout(() => {
              const committed = committedPresentationRef.current;
              const exact =
                authorityRef.current === execution.authority &&
                !!committed &&
                !committed.open &&
                committed.state === execution.expectedState &&
                committed.onOpenChange === execution.onOpenChange &&
                committed.commands === execution.commands &&
                committed.groupOrder === execution.groupOrder &&
                committed.placeholder === execution.placeholder;
              if (!exact || !commandTimersRef.current.delete(execution)) return;
              execution.timer = null;
              void execution.command.run();
            }, 0);
          }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Search every action, heading and recent document.</RadixDialog.Description>
          <form
            ref={(element) => bindElement(presentation, presentation.form, element)}
            className="flex items-center gap-2 border-b border-line px-3"
            onSubmit={(event) => {
              const form = presentation.form.element;
              const input = presentation.input.element;
              if (!form || !input) return;
              const nativeEvent = exactNativeSubmit(event, form, input);
              if (!nativeEvent) return;
              event.preventDefault();
              if (
                !ownsElement(presentation, presentation.form, event.currentTarget) ||
                !claimEvent(presentation, event, nativeEvent)
              ) {
                return;
              }
              const row = presentation.rows[presentation.state.highlight];
              if (row) pickRow(presentation, row);
            }}
          >
            {atRoot ? (
              <Search size={16} className="shrink-0 text-ink-3" aria-hidden />
            ) : (
              <button
                ref={(element) => {
                  if (presentation.back) bindElement(presentation, presentation.back, element);
                }}
                type="button"
                className="icon-btn -ml-1 h-7 w-7"
                onClick={(event) => {
                  const control = presentation.back;
                  if (!control || !ownsElement(presentation, control, event.currentTarget)) return;
                  const nativeEvent = exactNativeClick(event, control.element!);
                  if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                  back(presentation);
                }}
                aria-label="Back"
                data-testid="palette-back"
              >
                <ChevronLeft size={16} />
              </button>
            )}
            {!atRoot && level?.title && <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-ink-2">{level.title}</span>}
            <input
              ref={(element) => bindElement(presentation, presentation.input, element)}
              className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4"
              placeholder={atRoot ? placeholder : "Filter…"}
              value={query}
              onChange={(event) => {
                if (!ownsElement(presentation, presentation.input, event.currentTarget)) return;
                const nativeEvent = exactNativeInput(event, event.currentTarget);
                if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                const value = event.currentTarget.value;
                invalidateChildRequest(presentation.state.childLoad?.request ?? null);
                setState({
                  ...presentation.state,
                  query: value,
                  highlight: 0,
                  childLoad: null,
                });
              }}
              onKeyDown={(event) => {
                if (!ownsElement(presentation, presentation.input, event.currentTarget)) return;
                const key = event.key;
                const isBack = key === "Backspace" && !presentation.state.query && !presentation.atRoot;
                const isPage = key === "PageDown" || key === "PageUp";
                if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(key) && !isBack && !isPage) return;
                if (isPage && presentation.flat.length === 0) return;
                const nativeEvent = exactNativeKey(event, event.currentTarget);
                if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                event.preventDefault();

                if (key === "Enter") {
                  const row = presentation.rows[presentation.state.highlight];
                  if (row) pickRow(presentation, row);
                  return;
                }
                if (isBack) {
                  back(presentation);
                  return;
                }

                let nextHighlight = presentation.state.highlight;
                if (key === "ArrowDown" && presentation.flat.length) {
                  nextHighlight = (presentation.state.highlight + 1) % presentation.flat.length;
                } else if (key === "ArrowUp" && presentation.flat.length) {
                  nextHighlight = (presentation.state.highlight - 1 + presentation.flat.length) % presentation.flat.length;
                } else if (key === "Home") {
                  nextHighlight = 0;
                } else if (key === "End") {
                  nextHighlight = Math.max(0, presentation.flat.length - 1);
                } else if (key === "PageDown" && presentation.flat.length) {
                  nextHighlight = Math.min(
                    presentation.state.highlight + 10,
                    presentation.flat.length - 1,
                  );
                } else if (key === "PageUp" && presentation.flat.length) {
                  nextHighlight = Math.max(presentation.state.highlight - 10, 0);
                }
                if (nextHighlight === presentation.state.highlight) return;
                invalidateChildRequest(presentation.state.childLoad?.request ?? null);
                setState({
                  ...presentation.state,
                  highlight: nextHighlight,
                  childLoad: null,
                });
              }}
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-activedescendant={flat[highlight] ? `palette-item-${flat[highlight].id}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              data-testid="palette-input"
            />
            <Kbd>Esc</Kbd>
          </form>
          {childError && (
            <div className="mx-1.5 mt-1.5 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <span className="min-w-0 flex-1 wrap-anywhere">{childError.message}</span>
              <button
                ref={(element) => {
                  if (presentation.retry) bindElement(presentation, presentation.retry, element);
                }}
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={(event) => {
                  const control = presentation.retry;
                  if (
                    !control ||
                    claimedControlsRef.current.has(control) ||
                    !ownsElement(presentation, control, event.currentTarget) ||
                    presentation.state.childError !== childError ||
                    !childError.command.children ||
                    retrying
                  ) {
                    return;
                  }
                  const nativeEvent = exactNativeClick(event, control.element!);
                  if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                  claimedControlsRef.current.add(control);
                  startChildren(presentation, childError.command, true);
                }}
                disabled={retrying}
                aria-busy={retrying || undefined}
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          <div
            ref={(element) => bindElement(presentation, presentation.list, element)}
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            aria-busy={!!childLoad || undefined}
            className="scrollbar-thin max-h-[min(60vh,420px)] overflow-y-auto p-1.5"
          >
            {childLoad && !childError && (
              <div className="px-3 py-3 text-center text-sm text-ink-3" role="status" aria-live="polite" aria-atomic="true">
                Loading…
              </div>
            )}
            {flat.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-ink-3" data-testid="palette-empty">
                No matching commands
              </div>
            ) : (
              sections.map((section, sectionIndex) => (
                <div key={section.group ?? `q-${sectionIndex}`} role="group" aria-label={section.group ?? undefined}>
                  {section.group && <div className="menu-label">{section.group}</div>}
                  {section.items.map((command) => {
                    index += 1;
                    const itemIndex = index;
                    const row = presentation.rows[itemIndex];
                    const selected = itemIndex === highlight;
                    const unavailable = childLoad?.command.id === command.id || childError?.command.id === command.id;
                    return (
                      <div
                        ref={(element) => bindElement(presentation, row, element)}
                        key={command.id}
                        id={`palette-item-${command.id}`}
                        role="option"
                        aria-selected={selected}
                        aria-disabled={unavailable || undefined}
                        data-index={itemIndex}
                        data-testid={`palette-item-${command.id}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink select-none",
                          selected && "bg-surface-3",
                          unavailable && "cursor-default opacity-60",
                        )}
                        onMouseEnter={(event) => {
                          const nativeEvent = exactNativeMouse(event, row.element!, "mouseenter", "mouseover");
                          if (
                            !ownsElement(presentation, row, event.currentTarget) ||
                            !nativeEvent ||
                            !claimEvent(presentation, event, nativeEvent) ||
                            itemIndex === presentation.state.highlight
                          ) {
                            return;
                          }
                          invalidateChildRequest(presentation.state.childLoad?.request ?? null);
                          setState({
                            ...presentation.state,
                            highlight: itemIndex,
                            childLoad: null,
                          });
                        }}
                        onMouseDown={(event) => {
                          if (!ownsElement(presentation, row, event.currentTarget)) return;
                          const nativeEvent = exactNativeMouse(event, row.element!, "mousedown", "mousedown");
                          if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                          event.preventDefault();
                        }}
                        onClick={(event) => {
                          if (!ownsElement(presentation, row, event.currentTarget)) return;
                          const nativeEvent = exactNativeClick(event, row.element!);
                          if (!nativeEvent || !claimEvent(presentation, event, nativeEvent)) return;
                          pickRow(presentation, row);
                        }}
                      >
                        <CommandIcon name={command.icon} />
                        <span className="flex-1 truncate" title={command.title}>{command.title}</span>
                        {command.shortcut && <Kbd>{shortcut(command.shortcut)}</Kbd>}
                        {command.children && <ChevronRight size={14} className="text-ink-4" aria-hidden />}
                        {selected && !command.children && <CornerDownLeft size={13} className="text-ink-4" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
});

// The dashboard imports the shortcut test together with the palette; the editor shell takes it from
// `./palette-shortcut` directly so its keydown handler does not pin this module to the route's entry JS.
export { isPaletteShortcut } from "./palette-shortcut";
