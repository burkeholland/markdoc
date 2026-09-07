"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, ChevronLeft, ChevronRight, Code, Columns2, Copy, CornerDownLeft, Download, Eye,
  FileCode2, FilePlus2, FileText, Files, Hash, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard,
  LayoutTemplate, Link, List, ListChecks, ListOrdered, ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine,
  Quote, Radio, Redo2, Replace, Search, Share2, SquareCode, Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users, type LucideIcon,
} from "lucide-react";
import { Kbd } from "@/components/ui/primitives";
import { focusedElement, restoreFocus } from "@/lib/a11y";
import { apiErrorText } from "@/lib/api";
import { cn, shortcut } from "@/lib/utils";
import { filterCommands, groupCommands, loadRecent, pushRecent, saveRecent, withRecentFirst, type Command } from "./commands";

const ICONS: Record<string, LucideIcon> = {
  Activity, ArrowDownUp, ArrowLeft, Bold, BookOpen, Bot, Calendar, Code, Columns2, Copy, Download, Eye, FileCode2, FilePlus2, FileText, Files, Hash,
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, History, Image, Italic, Keyboard, LayoutTemplate, Link, List, ListChecks, ListOrdered,
  ListTree, LogOut, MessageSquare, MessageSquareDashed, MessageSquarePlus, Minus, Pencil, PenLine, Quote, Radio, Redo2, Replace, Search, Share2, SquareCode,
  Star, Strikethrough, SunMoon, Table, Trash2, Type, Undo2, UploadCloud, User, Users,
};

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

interface CommandSection {
  group: string | null;
  items: Command[];
}

interface PalettePresentation {
  authority: PaletteAuthority;
  visit: PaletteVisit | null;
  token: symbol;
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
  overlay: ElementPublication<HTMLDivElement>;
  content: ElementPublication<HTMLDivElement>;
  input: ElementPublication<HTMLInputElement>;
  list: ElementPublication<HTMLDivElement>;
  back: ControlPublication<HTMLButtonElement> | null;
  retry: ControlPublication<HTMLButtonElement> | null;
  rows: RowPublication[];
  active: boolean;
  retired: boolean;
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
  input: HTMLInputElement;
  list: HTMLDivElement;
  returnFocus: HTMLElement | null;
  command: Command | null;
  autoFocusClaimed: boolean;
  focusRestored: boolean;
}

interface DismissalProof {
  authority: PaletteAuthority;
  visit: PaletteVisit;
  token: symbol;
  presentation: PalettePresentation;
  content: HTMLDivElement;
  overlay: HTMLDivElement;
  event: Event;
  source: "escape" | "pointer";
  consumed: boolean;
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

function samePublication<T extends HTMLElement>(left: ElementPublication<T> | null, right: ElementPublication<T> | null): boolean {
  if (!left || !right) return left === right;
  const leftNode = publicationNode(left);
  return !!leftNode && leftNode === publicationNode(right);
}

function samePresentationProps(left: PalettePresentation, right: PalettePresentation): boolean {
  return (
    left.onOpenChange === right.onOpenChange &&
    left.commands === right.commands &&
    left.groupOrder === right.groupOrder &&
    left.placeholder === right.placeholder
  );
}

function samePrimaryElements(left: PalettePresentation, right: PalettePresentation): boolean {
  return (
    samePublication(left.overlay, right.overlay) &&
    samePublication(left.content, right.content) &&
    samePublication(left.input, right.input) &&
    samePublication(left.list, right.list)
  );
}

function sameChildElements(left: PalettePresentation, right: PalettePresentation): boolean {
  return (
    samePrimaryElements(left, right) &&
    samePublication(left.back, right.back) &&
    samePublication(left.retry, right.retry) &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const next = right.rows[index];
      return !!next && row.command === next.command && row.index === next.index && samePublication(row, next);
    })
  );
}

function presentationElementsReady(presentation: PalettePresentation): boolean {
  const overlay = presentation.overlay.element;
  const content = presentation.content.element;
  const input = presentation.input.element;
  const list = presentation.list.element;
  if (!overlay?.isConnected || !content?.isConnected || !input?.isConnected || !list?.isConnected) return false;
  if (!content.contains(input) || !content.contains(list)) return false;
  if (presentation.back && (!presentation.back.element?.isConnected || !content.contains(presentation.back.element))) return false;
  if (presentation.retry && (!presentation.retry.element?.isConnected || !content.contains(presentation.retry.element))) return false;
  return presentation.rows.every((row) => !!row.element?.isConnected && list.contains(row.element));
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
  const [, setDomRevision] = useState(0);
  const authority = useMemo<PaletteAuthority>(() => ({ token: Symbol("command-palette") }), []);
  const authorityRef = useRef<PaletteAuthority | null>(null);
  const visitRef = useRef<PaletteVisit | null>(null);
  const visitFocusRef = useRef<VisitFocus | null>(null);
  const presentationRef = useRef<PalettePresentation | null>(null);
  const committedPresentationRef = useRef<PalettePresentation | null>(null);
  const childRequestRef = useRef<ChildRequest | null>(null);
  const successorRef = useRef<PresentationSuccessor | null>(null);
  const dismissalRef = useRef<DismissalProof | null>(null);
  const closeRef = useRef<CloseTransition | null>(null);
  const commandTimersRef = useRef(new Set<CommandExecution>());
  const claimedControlsRef = useRef(new WeakSet<object>());
  const portalElementsRef = useRef<{ overlay: HTMLDivElement | null; content: HTMLDivElement | null }>({
    overlay: null,
    content: null,
  });
  const [portalElements, setPortalElements] = useState<{ overlay: HTMLDivElement | null; content: HTMLDivElement | null }>({
    overlay: null,
    content: null,
  });
  const retirePortalElement = useCallback((element: HTMLDivElement) => {
    const current = presentationRef.current;
    if (!current || (publicationNode(current.overlay) !== element && publicationNode(current.content) !== element)) return;
    current.active = false;
    current.retired = true;
    presentationRef.current = null;
    const request = childRequestRef.current;
    if (request?.owner === current) {
      request.active = false;
      childRequestRef.current = null;
      if (successorRef.current?.request === request) successorRef.current = null;
    }
  }, []);
  const bindOverlay = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const cleanup = () => {
        if (portalElementsRef.current.overlay !== element) return;
        retirePortalElement(element);
        portalElementsRef.current.overlay = null;
      };
      const previous = portalElementsRef.current.overlay;
      if (previous === element) return cleanup;
      if (previous) retirePortalElement(previous);
      portalElementsRef.current.overlay = element;
      if (portalElementsRef.current.content) {
        setPortalElements({ overlay: element, content: portalElementsRef.current.content });
      }
      return cleanup;
    },
    [retirePortalElement],
  );
  const bindContent = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const cleanup = () => {
        if (portalElementsRef.current.content !== element) return;
        retirePortalElement(element);
        portalElementsRef.current.content = null;
      };
      const previous = portalElementsRef.current.content;
      if (previous === element) return cleanup;
      if (previous) retirePortalElement(previous);
      portalElementsRef.current.content = element;
      if (portalElementsRef.current.overlay) {
        setPortalElements({ overlay: portalElementsRef.current.overlay, content: element });
      }
      return cleanup;
    },
    [retirePortalElement],
  );
  const visit = useMemo<PaletteVisit | null>(
    () =>
      open
        ? {
            authority,
            token: Symbol("command-palette-visit"),
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
      if (dismissalRef.current?.authority === authority) dismissalRef.current = null;
      if (closeRef.current?.authority === authority) closeRef.current = null;
      for (const execution of commandTimers) {
        if (execution.authority !== authority) continue;
        if (execution.timer !== null) clearTimeout(execution.timer);
        commandTimers.delete(execution);
      }
      if (presentationRef.current?.authority === authority) {
        presentationRef.current.active = false;
        presentationRef.current.retired = true;
        presentationRef.current = null;
      }
      if (committedPresentationRef.current?.authority === authority) committedPresentationRef.current = null;
    };
  }, [authority]);

  useLayoutEffect(() => {
    if (!visit || authorityRef.current !== authority) return;
    const claimedControls = claimedControlsRef.current;
    visitRef.current = visit;
    visitFocusRef.current = { visit, claimed: false, returnFocus: null };
    if (closeRef.current?.authority === authority) closeRef.current = null;
    for (const execution of commandTimersRef.current) {
      if (execution.authority !== authority) continue;
      if (execution.timer !== null) clearTimeout(execution.timer);
      commandTimersRef.current.delete(execution);
    }

    return () => {
      if (visitRef.current === visit) visitRef.current = null;

      const current = presentationRef.current;
      if (
        authorityRef.current === authority &&
        !closeRef.current &&
        current?.visit === visit &&
        current.active &&
        current.overlay.element &&
        current.content.element &&
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
  const presentation: PalettePresentation = {
    authority,
    visit,
    token: Symbol("command-palette-presentation"),
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
    overlay: publishedElement(portalElements.overlay),
    content: publishedElement(portalElements.content),
    input: publication<HTMLInputElement>(),
    list: publication<HTMLDivElement>(),
    back: atRoot ? null : controlPublication<HTMLButtonElement>(),
    retry: childError ? controlPublication<HTMLButtonElement>() : null,
    rows,
    active: false,
    retired: false,
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

  function retirePresentation(value: PalettePresentation): void {
    if (value.retired) return;
    value.retired = true;
    value.active = false;
    if (presentationRef.current === value) presentationRef.current = null;
    if (dismissalRef.current?.presentation === value) dismissalRef.current = null;
    const request = childRequestRef.current;
    if (request?.owner === value && successorRef.current?.from !== value) invalidateChildRequest(request);
  }

  function bindElement<T extends HTMLElement>(value: PalettePresentation, target: ElementPublication<T>, element: T | null): void {
    if (target.element === element) return;
    const replacing = !!element && !!target.lastElement && target.lastElement !== element;
    if (element) {
      target.element = element;
      target.lastElement = element;
      if (
        value.layoutAttempted &&
        (!value.active || replacing) &&
        !value.republishRequested &&
        value.open &&
        presentationElementsReady(value)
      ) {
        value.republishRequested = true;
        setDomRevision((revision) => revision + 1);
      }
      return;
    }
    if (target.element) {
      target.lastElement = target.element;
      target.element = null;
      retirePresentation(value);
    }
  }

  function ownsPresentation(value: PalettePresentation): boolean {
    return (
      value.active &&
      !value.retired &&
      value.open &&
      authorityRef.current === value.authority &&
      visitRef.current === value.visit &&
      !!value.visit &&
      presentationRef.current === value &&
      presentationElementsReady(value)
    );
  }

  function ownsElement<T extends HTMLElement>(value: PalettePresentation, target: ElementPublication<T>, currentTarget: EventTarget | null): currentTarget is T {
    return (
      ownsPresentation(value) &&
      target.element === currentTarget &&
      !!target.element?.isConnected &&
      !!value.content.element?.contains(target.element)
    );
  }

  function claimEvent(value: PalettePresentation, event: object): boolean {
    if (value.consumedEvents.has(event)) return false;
    value.consumedEvents.add(event);
    return true;
  }

  function publishDismissal(
    value: PalettePresentation,
    event: KeyboardEvent | CustomEvent<{ originalEvent: PointerEvent }>,
    source: DismissalProof["source"],
  ): void {
    const content = value.content.element;
    const overlay = value.overlay.element;
    const visit = value.visit;
    if (
      !content ||
      !overlay ||
      !visit ||
      !ownsPresentation(value) ||
      !content.isConnected ||
      !overlay.isConnected ||
      value.consumedEvents.has(event)
    ) {
      return;
    }
    if (source === "escape") {
      const target = event.target;
      if (
        event.currentTarget !== content.ownerDocument ||
        !(target instanceof Node) ||
        !target.isConnected ||
        target.ownerDocument !== content.ownerDocument ||
        !content.contains(target)
      ) {
        return;
      }
    } else {
      const target = (event as CustomEvent<{ originalEvent: PointerEvent }>).detail?.originalEvent?.target;
      if (
        event.currentTarget !== target ||
        !(target instanceof Node) ||
        !target.isConnected ||
        target.ownerDocument !== content.ownerDocument ||
        content.contains(target)
      ) {
        return;
      }
    }

    value.consumedEvents.add(event);
    dismissalRef.current = {
      authority: value.authority,
      visit,
      token: Symbol("command-palette-dismissal"),
      presentation: value,
      content,
      overlay,
      event,
      source,
      consumed: false,
    };
  }

  function ownsChildRequest(request: ChildRequest): boolean {
    const owner = request.owner;
    const transferring = successorRef.current?.request === request && successorRef.current.from === owner;
    return (
      request.active &&
      authorityRef.current === request.authority &&
      visitRef.current === request.visit &&
      childRequestRef.current === request &&
      presentationRef.current === owner &&
      owner.active &&
      !owner.retired &&
      owner.authority === request.authority &&
      owner.visit === request.visit &&
      request.command.children === request.provider &&
      (owner.state.childLoad?.request === request || transferring)
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

    void Promise.resolve()
      .then(() => {
        if (!ownsChildRequest(request)) return null;
        return Promise.resolve(provider()).then((items) => ({ items }));
      })
      .then((result) => {
        if (!result || !ownsChildRequest(request)) return;
        const owner = request.owner;
        focusInput(owner);
        invalidateChildRequest(request);
        setState({
          ...owner.state,
          query: "",
          stack: [...owner.state.stack, { title: command.title.replace(/…$/, ""), items: result.items }],
          highlight: 0,
          childLoad: null,
          childError: null,
        });
      })
      .catch((error: unknown) => {
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
      });
  }

  function beginClose(value: PalettePresentation, command: Command | null, nextState: PaletteState): void {
    const currentVisit = value.visit;
    const overlay = value.overlay.element;
    const content = value.content.element;
    const input = value.input.element;
    const list = value.list.element;
    if (
      !ownsPresentation(value) ||
      !currentVisit ||
      claimedControlsRef.current.has(value) ||
      closeRef.current ||
      !overlay ||
      !content ||
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

  function commitPresentation(value: PalettePresentation): void {
    value.layoutAttempted = true;
    if (authorityRef.current !== authority) return;
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

      value.active = true;
      presentationRef.current = value;
      if (dismissalRef.current?.presentation !== value) dismissalRef.current = null;
      const request = value.state.childLoad?.request;
      const successor = successorRef.current;
      const adoptsRequest =
        !!request &&
        successor?.request === request &&
        successor.from === request.owner &&
        request.active &&
        childRequestRef.current === request &&
        request.expectedState === value.state &&
        successor.from.visit === value.visit &&
        samePresentationProps(successor.from, value) &&
        successor.from.visible === value.visible &&
        successor.from.sections === value.sections &&
        successor.from.flat === value.flat &&
        sameChildElements(successor.from, value);
      if (request && adoptsRequest) {
        request.owner = value;
        successorRef.current = null;
      }

      if (request && !adoptsRequest && request.owner !== value) {
        invalidateChildRequest(request);
        setState({ ...value.state, childLoad: null });
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
      close.placeholder === value.placeholder &&
      publicationNode(value.overlay) === close.overlay &&
      publicationNode(value.content) === close.content &&
      publicationNode(value.input) === close.input &&
      publicationNode(value.list) === close.list
    ) {
      close.presentation = value;
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
    commitPresentation(presentation);
    return () => retirePresentation(presentation);
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
        const dismissal = dismissalRef.current;
        if (
          next ||
          !dismissal ||
          dismissal.consumed ||
          dismissal.authority !== presentation.authority ||
          dismissal.visit !== presentation.visit ||
          dismissal.presentation !== presentation ||
          dismissal.content !== presentation.content.element ||
          dismissal.overlay !== presentation.overlay.element ||
          !ownsPresentation(presentation)
        ) {
          return;
        }
        dismissal.consumed = true;
        if (dismissalRef.current === dismissal) dismissalRef.current = null;
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
          onEscapeKeyDown={(event) => publishDismissal(presentation, event, "escape")}
          onPointerDownOutside={(event) => publishDismissal(presentation, event, "pointer")}
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
              !claimEvent(presentation, event)
            ) {
              return;
            }
            event.preventDefault();
            visitFocusRef.current = { visit: currentVisit, claimed: true, returnFocus: focusedElement() };
            input.focus();
          }}
          onCloseAutoFocus={(event) => {
            const close = closeRef.current;
            const exactHandler = close?.presentation ? close.presentation === presentation : close?.origin === presentation;
            if (
              !close ||
              !exactHandler ||
              close.authority !== authority ||
              authorityRef.current !== authority ||
              close.content !== event.currentTarget ||
              close.autoFocusClaimed ||
              presentation.consumedEvents.has(event)
            ) {
              return;
            }
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
          <div className="flex items-center gap-2 border-b border-line px-3">
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
                  if (!control || !ownsElement(presentation, control, event.currentTarget) || !claimEvent(presentation, event)) return;
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
                if (!ownsElement(presentation, presentation.input, event.currentTarget) || !claimEvent(presentation, event)) return;
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
                if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(key) && !isBack) return;
                if (!claimEvent(presentation, event)) return;
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
          </div>
          {childError && (
            <div className="mx-1.5 mt-1.5 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" role="alert" aria-atomic="true">
              <span className="min-w-0 flex-1">{childError.message}</span>
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
                    !claimEvent(presentation, event) ||
                    presentation.state.childError !== childError ||
                    !childError.command.children ||
                    retrying
                  ) {
                    return;
                  }
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
                          if (
                            !ownsElement(presentation, row, event.currentTarget) ||
                            !claimEvent(presentation, event) ||
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
                          if (!ownsElement(presentation, row, event.currentTarget) || !claimEvent(presentation, event)) return;
                          event.preventDefault();
                        }}
                        onClick={(event) => {
                          if (!ownsElement(presentation, row, event.currentTarget) || !claimEvent(presentation, event)) return;
                          pickRow(presentation, row);
                        }}
                      >
                        <CommandIcon name={command.icon} />
                        <span className="flex-1 truncate">{command.title}</span>
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
