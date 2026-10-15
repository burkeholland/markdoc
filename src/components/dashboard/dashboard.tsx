"use client";
import { Avatar, Dialog, DialogContent, DialogTrigger, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";
import { ThemeToggle } from "@/components/ui/theme-toggle";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, FolderOpen, GitBranch, LayoutTemplate, ListChecks, Loader2, LogOut, MoreVertical, PenLine, RotateCcw, Scale, Search, FileText, Sparkles, Star, Trash2, Users, X } from "lucide-react";
import { api, apiErrorText, type DocumentSummaryDto, type SearchResultDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { PICKER_TEMPLATES, TEMPLATES, WELCOME_TEMPLATE_ID, getTemplate, type Template, type TemplateIcon } from "@/lib/templates";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, SORT_COOKIE_MAX_AGE, SORT_OPTIONS, SORT_STORAGE_KEY, isDashboardSort, type DashboardSort } from "@/lib/dashboard-sort";

import { Logo } from "@/components/ui/logo";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { isManagedGithubLogin } from "@/lib/github-login";
import { GITHUB_NOT_CONFIGURED } from "@/components/editor/labels";
import { NotificationsStrip } from "@/components/dashboard/notifications-strip";
import { ImportDialog, ImportDropzone, useFileImport } from "@/components/dashboard/import-dialog";
import {
  DOCUMENT_DRAG_TYPE,
  FolderRail,
  MoveToItems,
  SelectionBar,
  TOP_LEVEL,
  useFolders,
  type FolderSelection,
} from "@/components/dashboard/folders";
import { CommandPalette, isPaletteShortcut } from "@/components/editor/command-palette";
import { buildDashboardCommands } from "@/components/editor/commands";
import { signOutSafely } from "@/lib/sign-out";

const TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor.bind(Object);
const TRUSTED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf.bind(Object);
const TRUSTED_REFLECT_DEFINE_PROPERTY = Reflect.defineProperty.bind(Reflect);
const TRUSTED_REFLECT_APPLY = Reflect.apply.bind(Reflect);
const TRUSTED_IS_PROTOTYPE_OF = Function.prototype.call.bind(
  Object.prototype.isPrototypeOf,
) as (prototype: object, value: object) => boolean;

function capturePrototypeGetter<T>(
  prototype: object | null,
  property: PropertyKey,
): ((value: object) => T) | null {
  for (let current = prototype; current; current = TRUSTED_OBJECT_GET_PROTOTYPE_OF(current)) {
    const descriptor = TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      current,
      property,
    );
    if (descriptor?.get) {
      return Function.prototype.call.bind(descriptor.get) as (
        value: object,
      ) => T;
    }
  }
  return null;
}

function capturePrototypeMethod<T extends (...args: never[]) => unknown>(
  prototype: object | null,
  property: PropertyKey,
): T | null {
  for (let current = prototype; current; current = TRUSTED_OBJECT_GET_PROTOTYPE_OF(current)) {
    const descriptor = TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      current,
      property,
    );
    if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
      return Function.prototype.call.bind(descriptor.value) as unknown as T;
    }
  }
  return null;
}

const HTML_BUTTON_PROTOTYPE =
  typeof HTMLButtonElement === "undefined" ? null : HTMLButtonElement.prototype;
const ELEMENT_PROTOTYPE =
  typeof Element === "undefined" ? null : Element.prototype;

const TRUSTED_BUTTON_DISABLED = capturePrototypeGetter<boolean>(
  HTML_BUTTON_PROTOTYPE,
  "disabled",
);
const TRUSTED_ELEMENT_HAS_ATTRIBUTE = capturePrototypeMethod<
  (element: Element, name: string) => boolean
>(ELEMENT_PROTOTYPE, "hasAttribute");
const TRUSTED_ELEMENT_GET_ATTRIBUTE = capturePrototypeMethod<
  (element: Element, name: string) => string | null
>(ELEMENT_PROTOTYPE, "getAttribute");

type Doc = DocumentSummaryDto;
type SearchDoc = SearchResultDto;

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;
const STARRED_STRIP_MAX = 6;
const DASHBOARD_GROUPS = ["Recent", "Create", "Navigation", "Account"] as const;
const SEARCH_SHORTCUT_BLOCKED = 'input, textarea, select, dialog, [role="dialog"], [data-testid="command-palette"], [contenteditable]:not([contenteditable="false"])';

function isSearchShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  return !(event.target instanceof Element && event.target.closest(SEARCH_SHORTCUT_BLOCKED));
}

function readSortCookie(): string | null {
  const prefix = `${SORT_COOKIE}=`;
  const part = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : null;
}

function writeSortCookie(sort: DashboardSort) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SORT_COOKIE}=${sort}; Path=/; Max-Age=${SORT_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/** Most recently opened first; never-opened documents follow, most recently edited first. */
export function compareDocs(sort: DashboardSort): (a: Doc, b: Doc) => number {
  const byUpdated = (a: Doc, b: Doc) => b.updatedAt.localeCompare(a.updatedAt);
  switch (sort) {
    case "recent":
      return (a, b) => {
        if (a.lastOpenedAt && b.lastOpenedAt) return b.lastOpenedAt.localeCompare(a.lastOpenedAt) || byUpdated(a, b);
        if (a.lastOpenedAt) return -1;
        if (b.lastOpenedAt) return 1;
        return byUpdated(a, b);
      };
    case "modified":
      return byUpdated;
    case "title":
      return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || byUpdated(a, b);
    case "created":
      return (a, b) => b.createdAt.localeCompare(a.createdAt);
  }
}

/** Wrap each case-insensitive occurrence of `needle` in `text` in a <mark>, without touching HTML. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = needle.trim();
  if (!n) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  const target = n.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(target, from);
    if (idx < 0) break;
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <mark key={idx} className="rounded-sm bg-accent/20 px-0.5 text-ink">
        {text.slice(idx, idx + n.length)}
      </mark>,
    );
    from = idx + n.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

const TEMPLATE_ICONS: Record<TemplateIcon, typeof File> = {
  File,
  Users,
  BookOpen,
  DraftingCompass,
  CalendarCheck,
  PenLine,
  Scale,
  ListChecks,
  Sparkles,
};

// Helpers that the search, filter and account code further down still use.
interface TemplateGridAttributeSnapshot {
  readonly name: string;
  readonly localName: string;
  readonly prefix: string | null;
  readonly namespaceURI: string | null;
  readonly value: string;
}

interface TemplateGridDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly attributes: readonly TemplateGridAttributeSnapshot[] | null;
  readonly children: readonly TemplateGridDomSnapshot[];
}

interface TemplateGridNodePlacement {
  readonly node: Node;
  readonly parent: Node | null;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

type TemplateGridPlacement = readonly TemplateGridNodePlacement[];

function templateGridAttributes(
  node: Node,
): readonly TemplateGridAttributeSnapshot[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, localName, prefix, namespaceURI, value }) =>
        Object.freeze({ name, localName, prefix, namespaceURI, value }),
      )
      .sort((left, right) =>
        [
          left.namespaceURI ?? "",
          left.prefix ?? "",
          left.name,
          left.localName,
        ]
          .join("\0")
          .localeCompare(
            [
              right.namespaceURI ?? "",
              right.prefix ?? "",
              right.name,
              right.localName,
            ].join("\0"),
          ),
      ),
  );
}

function snapshotTemplateGridDom(node: Node): TemplateGridDomSnapshot {
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    attributes: templateGridAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map(snapshotTemplateGridDom),
    ),
  });
}

function templateGridDomMatches(snapshot: TemplateGridDomSnapshot): boolean {
  const { node } = snapshot;
  if (node.nodeValue !== snapshot.nodeValue) return false;
  const attributes = templateGridAttributes(node);
  if (attributes === null || snapshot.attributes === null) {
    if (attributes !== snapshot.attributes) return false;
  } else if (
    attributes.length !== snapshot.attributes.length ||
    attributes.some((attribute, index) => {
      const expected = snapshot.attributes?.[index];
      return (
        !expected ||
        attribute.name !== expected.name ||
        attribute.localName !== expected.localName ||
        attribute.prefix !== expected.prefix ||
        attribute.namespaceURI !== expected.namespaceURI ||
        attribute.value !== expected.value
      );
    })
  ) {
    return false;
  }
  return (
    node.childNodes.length === snapshot.children.length &&
    snapshot.children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        templateGridDomMatches(child),
    )
  );
}

function templateGridPlacementMatches(
  ownerDocument: Document,
  placement: TemplateGridPlacement,
) {
  if (placement.length === 0) return false;
  for (let index = 0; index < placement.length; index++) {
    const current = placement[index]!;
    const next = placement[index + 1];
    if (
      current.node.parentNode !== current.parent ||
      current.node.previousSibling !== current.previousSibling ||
      current.node.nextSibling !== current.nextSibling ||
      (next && current.parent !== next.node)
    ) {
      return false;
    }
  }
  const last = placement.at(-1)!;
  return (
    last.node === ownerDocument &&
    last.parent === null &&
    last.previousSibling === null &&
    last.nextSibling === null
  );
}

function templateGridEventPath(
  ownerDocument: Document,
  target: Node,
): readonly EventTarget[] | null {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return null;
  const path: EventTarget[] = [];
  let current: Node | null = target;
  while (current) {
    path.push(current);
    current = current.parentNode;
  }
  if (path.at(-1) !== ownerDocument) return null;
  path.push(ownerWindow);
  return Object.freeze(path);
}

/** Grid of template cards; `busy` is the id currently being created (disables the grid). */
export function TemplateGrid({ onPick, busy, compact }: { onPick: (t: Template) => void; busy: string | null; compact?: boolean }) {
  return (
    <ul className={cn("grid gap-3", compact ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3")} data-testid="template-grid">
      {PICKER_TEMPLATES.map((t) => {
        const Icon = TEMPLATE_ICONS[t.icon];
        const isBusy = busy === t.id;
        return (
          <li key={t.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onPick(t)}
              disabled={busy !== null}
              aria-busy={isBusy || undefined}
              className="group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent hover:shadow-sm focus-visible:border-accent disabled:cursor-default disabled:opacity-60"
              data-testid={`template-${t.id}`}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-2 transition group-hover:bg-accent group-hover:text-on-accent">
                {isBusy ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
              </span>
              <span className="block text-sm font-semibold text-ink">{t.name}</span>
              <span className="block text-xs leading-4 text-ink-3">{t.description}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface DashboardProps {
  user: { id: string; name: string; login: string | null; image: string | null };
  documents: Doc[];
  githubAvailable: boolean;
  /** The server has a GitHub OAuth app; without it the "Open from GitHub" card is disabled and says why (#162). */
  githubConfigured: boolean;
  /** Sort read from the `markdoc.dashboardSort` cookie by the server, so the first paint is already in the saved order (#165). */
  initialSort?: DashboardSort;
}

type Filter = "all" | "mine" | "shared" | "starred" | "trash";
type TrashActionKind = "restore" | "purge";

interface TrashActionOperation {
  visit: number;
  documentId: string;
  kind: TrashActionKind;
  document: Doc;
}

interface CreateOperation {
  ownerId: string;
  key: string;
}

interface SearchAuthority {
  mount: symbol;
  visit: symbol;
  user: DashboardProps["user"];
  userId: string;
}

interface SearchShortcutOwner {
  active: boolean;
  readonly authority: SearchAuthority;
  readonly user: DashboardProps["user"];
  readonly target: Window;
  readonly input: HTMLInputElement;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

interface PaletteShortcutOwner {
  active: boolean;
  open: boolean;
  readonly authority: SearchAuthority;
  readonly user: DashboardProps["user"];
  readonly target: Window;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

interface SearchDebounceOwner {
  authority: SearchAuthority;
  query: string;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SearchRequestOwner {
  authority: SearchAuthority;
  query: string;
  controller: AbortController;
}

interface SearchResults {
  authority: SearchAuthority;
  query: string;
  documents: SearchDoc[];
}

interface SearchError {
  authority: SearchAuthority;
  query: string;
  message: string;
}

interface SearchOwnerGetter<T> {
  readonly read: (receiver: object) => T;
  readonly isCurrent: () => boolean;
}

interface SearchOwnerMethod<Args extends unknown[], Result> {
  readonly call: (receiver: object, args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface SearchResultKeyboardAuthority {
  readonly trusted: FilterTrustedAuthority;
  readonly activeElement: FilterActiveElementAuthority;
  readonly currentTarget: (event: Event) => EventTarget | null;
  readonly defaultPrevented: (event: Event) => boolean;
  readonly target: (event: Event) => EventTarget | null;
  readonly type: (event: Event) => string;
  readonly phase: (event: Event) => number;
  readonly bubbles: (event: Event) => boolean;
  readonly cancelable: (event: Event) => boolean;
  readonly cancelBubble: (event: Event) => boolean;
  readonly key: (event: Event) => string;
  readonly ctrlKey: (event: Event) => boolean;
  readonly metaKey: (event: Event) => boolean;
  readonly altKey: (event: Event) => boolean;
  readonly shiftKey: (event: Event) => boolean;
  readonly repeat: (event: Event) => boolean;
  readonly composing: (event: Event) => boolean;
  readonly view: (event: Event) => Window | null;
  readonly composedPath: (event: Event) => EventTarget[];
  readonly preventDefault: (event: Event) => void;
  readonly stopPropagation: (event: Event) => void;
  readonly stopImmediatePropagation: (event: Event) => void;
  readonly focus: (element: HTMLElement, options: FocusOptions) => void;
  readonly isCurrent: () => boolean;
}

function captureSearchOwnerGetter<T>(
  view: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): SearchOwnerGetter<T> | null {
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  for (
    let owner: object | null = prototype;
    owner;
    owner = getPrototypeOf(owner) as object | null
  ) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (!descriptor) continue;
    if (typeof descriptor.get !== "function") return null;
    const expected = Object.freeze({ ...descriptor });
    const getter = descriptor.get;
    return Object.freeze({
      read: (receiver: object) => apply(getter, receiver, []) as T,
      isCurrent: () =>
        view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
        view.Object.getPrototypeOf === getPrototypeOf &&
        view.Reflect.apply === apply &&
        filterDescriptorsMatch(
          getOwnPropertyDescriptor(owner, property),
          expected,
        ),
    });
  }
  return null;
}

function captureSearchOwnerMethod<Args extends unknown[], Result>(
  view: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): SearchOwnerMethod<Args, Result> | null {
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  for (
    let owner: object | null = prototype;
    owner;
    owner = getPrototypeOf(owner) as object | null
  ) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      return null;
    }
    const expected = Object.freeze({ ...descriptor });
    const method = descriptor.value as (...args: Args) => Result;
    return Object.freeze({
      call: (receiver: object, args: Args) => apply(method, receiver, args),
      isCurrent: () =>
        view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
        view.Object.getPrototypeOf === getPrototypeOf &&
        view.Reflect.apply === apply &&
        filterDescriptorsMatch(
          getOwnPropertyDescriptor(owner, property),
          expected,
        ),
    });
  }
  return null;
}

function captureSearchResultKeyboardAuthority(
  view: Window & typeof globalThis,
): SearchResultKeyboardAuthority | null {
  const trusted = captureFilterTrustedAuthority(view);
  const activeElement = captureFilterActiveElementAuthority(view);
  const currentTarget = captureSearchOwnerGetter<EventTarget | null>(
    view,
    view.Event.prototype,
    "currentTarget",
  );
  const defaultPrevented = captureSearchOwnerGetter<boolean>(
    view,
    view.Event.prototype,
    "defaultPrevented",
  );
  const target = captureSearchOwnerGetter<EventTarget | null>(
    view,
    view.Event.prototype,
    "target",
  );
  const type = captureSearchOwnerGetter<string>(
    view,
    view.Event.prototype,
    "type",
  );
  const phase = captureSearchOwnerGetter<number>(
    view,
    view.Event.prototype,
    "eventPhase",
  );
  const bubbles = captureSearchOwnerGetter<boolean>(
    view,
    view.Event.prototype,
    "bubbles",
  );
  const cancelable = captureSearchOwnerGetter<boolean>(
    view,
    view.Event.prototype,
    "cancelable",
  );
  const cancelBubble = captureSearchOwnerGetter<boolean>(
    view,
    view.Event.prototype,
    "cancelBubble",
  );
  const key = captureSearchOwnerGetter<string>(
    view,
    view.KeyboardEvent.prototype,
    "key",
  );
  const ctrlKey = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "ctrlKey",
  );
  const metaKey = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "metaKey",
  );
  const altKey = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "altKey",
  );
  const shiftKey = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "shiftKey",
  );
  const repeat = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "repeat",
  );
  const composing = captureSearchOwnerGetter<boolean>(
    view,
    view.KeyboardEvent.prototype,
    "isComposing",
  );
  const eventView = captureSearchOwnerGetter<Window | null>(
    view,
    view.UIEvent.prototype,
    "view",
  );
  const composedPath = captureSearchOwnerMethod<[], EventTarget[]>(
    view,
    view.Event.prototype,
    "composedPath",
  );
  const preventDefault = captureSearchOwnerMethod<[], void>(
    view,
    view.Event.prototype,
    "preventDefault",
  );
  const stopPropagation = captureSearchOwnerMethod<[], void>(
    view,
    view.Event.prototype,
    "stopPropagation",
  );
  const stopImmediatePropagation = captureSearchOwnerMethod<[], void>(
    view,
    view.Event.prototype,
    "stopImmediatePropagation",
  );
  const focus = captureSearchOwnerMethod<[FocusOptions?], void>(
    view,
    view.HTMLElement.prototype,
    "focus",
  );
  if (
    !trusted ||
    !activeElement ||
    !currentTarget ||
    !defaultPrevented ||
    !target ||
    !type ||
    !phase ||
    !bubbles ||
    !cancelable ||
    !cancelBubble ||
    !key ||
    !ctrlKey ||
    !metaKey ||
    !altKey ||
    !shiftKey ||
    !repeat ||
    !composing ||
    !eventView ||
    !composedPath ||
    !preventDefault ||
    !stopPropagation ||
    !stopImmediatePropagation ||
    !focus
  ) {
    return null;
  }
  const authorities = [
    currentTarget,
    defaultPrevented,
    target,
    type,
    phase,
    bubbles,
    cancelable,
    cancelBubble,
    key,
    ctrlKey,
    metaKey,
    altKey,
    shiftKey,
    repeat,
    composing,
    eventView,
    composedPath,
    preventDefault,
    stopPropagation,
    stopImmediatePropagation,
    focus,
  ];
  return Object.freeze({
    trusted,
    activeElement,
    currentTarget: (event: Event) => currentTarget.read(event),
    defaultPrevented: (event: Event) => defaultPrevented.read(event),
    target: (event: Event) => target.read(event),
    type: (event: Event) => type.read(event),
    phase: (event: Event) => phase.read(event),
    bubbles: (event: Event) => bubbles.read(event),
    cancelable: (event: Event) => cancelable.read(event),
    cancelBubble: (event: Event) => cancelBubble.read(event),
    key: (event: Event) => key.read(event),
    ctrlKey: (event: Event) => ctrlKey.read(event),
    metaKey: (event: Event) => metaKey.read(event),
    altKey: (event: Event) => altKey.read(event),
    shiftKey: (event: Event) => shiftKey.read(event),
    repeat: (event: Event) => repeat.read(event),
    composing: (event: Event) => composing.read(event),
    view: (event: Event) => eventView.read(event),
    composedPath: (event: Event) => composedPath.call(event, []),
    preventDefault: (event: Event) => preventDefault.call(event, []),
    stopPropagation: (event: Event) => stopPropagation.call(event, []),
    stopImmediatePropagation: (event: Event) =>
      stopImmediatePropagation.call(event, []),
    focus: (element: HTMLElement, options: FocusOptions) =>
      focus.call(element, [options]),
    isCurrent: () =>
      trusted.isCurrent() &&
      activeElement.isCurrent() &&
      authorities.every((authority) => authority.isCurrent()),
  });
}

const SEARCH_CONTROL_MISSING = Symbol("search-control-missing");

function searchControlOwnValue(
  value: object,
  property: PropertyKey,
): unknown | typeof SEARCH_CONTROL_MISSING {
  const descriptor = TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, property);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : SEARCH_CONTROL_MISSING;
}

function searchControlPlacement(element: Element): TemplateGridPlacement | null {
  const placement: TemplateGridNodePlacement[] = [];
  const ownerDocument = element.ownerDocument;
  let current: Node | null = element;
  while (current) {
    placement.push(
      Object.freeze({
        node: current,
        parent: current.parentNode,
        previousSibling: current.previousSibling,
        nextSibling: current.nextSibling,
      }),
    );
    if (current === ownerDocument) return Object.freeze(placement);
    current = current.parentNode;
  }
  return null;
}

function searchControlPlacementMatches(
  ownerDocument: Document,
  placement: TemplateGridPlacement,
) {
  return templateGridPlacementMatches(ownerDocument, placement);
}

interface SearchControlDomGuard {
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

/** The busy key `create()` publishes for a blank document (no template). */
const CREATE_BLANK_KEY = "blank";
const CREATE_CARD_CLASS =
  "group flex items-stretch rounded-2xl border border-line bg-surface shadow-sm transition hover:border-accent hover:shadow-md";
const CREATE_BLANK_BUTTON_CLASS =
  "flex flex-1 items-center gap-4 rounded-l-2xl p-5 text-left";
const CREATE_BLANK_ICON_FRAME_CLASS =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent";
const CREATE_BLANK_NAME_CLASS = "block text-[15px] font-semibold text-ink";
const CREATE_BLANK_DESCRIPTION_CLASS = "block text-sm text-ink-3";
const CREATE_BLANK_NAME_TEXT = "New document";
const CREATE_BLANK_DESCRIPTION_TEXT = "Start with a blank Markdown page.";
const CREATE_GUIDED_ROOT_CLASS = "mb-5 text-center";
const CREATE_GUIDED_PRIMARY_CLASS = "text-sm font-medium text-ink-2";
const CREATE_GUIDED_SECONDARY_CLASS = "mt-1 text-sm text-ink-3";
const CREATE_GUIDED_PRIMARY_TEXT = "No documents yet";
const CREATE_GUIDED_SECONDARY_TEXT =
  "Start with a short guided document, pick a template, or open a Markdown file from GitHub.";
const CREATE_WELCOME_BUTTON_CLASS = "btn btn-primary mt-4 gap-2";

interface NoticeAuthority {
  mount: symbol;
  userId: string;
}

interface NoticePublication {
  authority: NoticeAuthority;
  notice: PendingNotice;
  timer: ReturnType<typeof setTimeout> | null;
}

interface FilterAuthority {
  readonly mount: symbol;
  readonly visit: symbol;
  readonly user: DashboardProps["user"];
  readonly userId: string;
}

interface FilterDefinition {
  readonly value: Filter;
  readonly label: string;
}

interface FilterTrustedAuthority {
  readonly matches: (event: object) => boolean;
  readonly read: (event: object) => boolean;
  readonly isCurrent: () => boolean;
}

interface FilterActiveElementAuthority {
  readonly read: (document: Document) => Element | null;
  readonly isCurrent: () => boolean;
}

interface FilterRenderPublication {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly authority: FilterAuthority;
  readonly user: DashboardProps["user"];
  readonly userId: string;
  readonly definitions: readonly FilterDefinition[];
  readonly filter: Filter;
  readonly currentFilter: () => Filter;
  readonly changeFilter: (next: Filter) => void;
}

type FilterElementRole = "group" | Filter;

interface FilterElementOwnerView {
  readonly role: FilterElementRole;
  readonly element: () => Element | null;
}

interface FilterRefReplay {
  readonly owner: FilterElementOwnerView;
  readonly element: Element;
  state: "attached" | "detached" | "reattached" | "invalid";
}

interface FilterActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly entryIdentity: symbol;
  readonly filter: Filter;
  readonly index: number;
}

interface FilterEntryPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly definition: FilterDefinition;
  readonly index: number;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: FilterActionPublication;
}

interface FilterPublication {
  readonly identity: symbol;
  readonly render: FilterRenderPublication;
  readonly ownerDocument: Document;
  readonly group: HTMLDivElement;
  readonly entries: readonly FilterEntryPublication[];
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface FilterReplay {
  readonly source: FilterPublication;
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface FilterReactKeyMethods {
  readonly preventDefault: (...args: never[]) => unknown;
  readonly isDefaultPrevented: (...args: never[]) => unknown;
  readonly isPropagationStopped: (...args: never[]) => unknown;
}

interface FilterReactKeyProof {
  readonly event: ReactKeyboardEvent<HTMLElement>;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLElement;
  readonly type: "keydown";
  readonly phase: number;
  readonly bubbles: true;
  readonly cancelable: true;
  readonly defaultPrevented: false;
  readonly trusted: true;
  readonly view: unknown;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly charCode: number;
  readonly keyCode: number;
  readonly repeat: false;
  readonly composing: false | undefined;
  readonly ctrlKey: false;
  readonly metaKey: false;
  readonly altKey: false;
  readonly shiftKey: false;
  readonly detail: number;
  readonly methods: FilterReactKeyMethods;
}

interface FilterDocumentKeyProof {
  readonly event: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly phase: number;
}

interface FilterWindowKeyProof {
  readonly publication: FilterPublication;
  readonly event: KeyboardEvent;
  readonly listener: EventListener;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
  readonly phase: number;
  readonly addEventListener: Window["addEventListener"];
  readonly removeEventListener: Window["removeEventListener"];
}

interface FilterKeyboardMovement {
  readonly identity: symbol;
  readonly publication: FilterPublication;
  readonly definitions: readonly FilterDefinition[];
  readonly source: FilterEntryPublication;
  readonly destination: FilterEntryPublication;
  readonly key: string;
}

interface FilterNativeKeyProof {
  readonly identity: symbol;
  readonly event: KeyboardEvent;
  readonly publication: FilterPublication;
  readonly entry: FilterEntryPublication;
  readonly action: FilterActionPublication;
  readonly target: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly windowReceiver: EventTarget;
  readonly key: string;
  readonly code: string;
  readonly location: number;
  readonly charCode: number;
  readonly keyCode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly bubbles: true;
  readonly cancelable: true;
  readonly composed: boolean;
  readonly timeStamp: number;
  readonly view: Window | null;
  readonly detail: number;
  readonly destination: Filter;
  readonly destinationButton: HTMLButtonElement;
  readonly trusted: true;
  readonly documentCapture: FilterDocumentKeyProof;
  readonly movement: FilterKeyboardMovement;
}

interface FilterKeyPair {
  readonly native: FilterNativeKeyProof;
  readonly token: symbol;
  state: "staged" | "paired" | "finalizing" | "consumed" | "replayed";
  buttonBoundary: FilterDocumentKeyProof | null;
  groupCapture: FilterReactKeyProof | null;
  buttonCapture: FilterReactKeyProof | null;
  buttonBubble: FilterReactKeyProof | null;
  bubbleDefaultQuery: ((...args: never[]) => unknown) | null;
  documentBubble: FilterDocumentKeyProof | null;
  windowProof: FilterWindowKeyProof | null;
}

interface FilterKeyClaim {
  readonly pair: FilterKeyPair;
  readonly native: FilterNativeKeyProof;
  readonly publication: FilterPublication;
  readonly definitions: readonly FilterDefinition[];
  readonly source: FilterEntryPublication;
  readonly destination: FilterEntryPublication;
  readonly movement: FilterKeyboardMovement;
  readonly groupCapture: FilterReactKeyProof;
  readonly buttonCapture: FilterReactKeyProof;
  readonly buttonBubble: FilterReactKeyProof;
  readonly documentCapture: FilterDocumentKeyProof;
  readonly buttonBoundary: FilterDocumentKeyProof;
  readonly documentBubble: FilterDocumentKeyProof;
  readonly windowProof: FilterWindowKeyProof;
  readonly authority: FilterAuthority;
  readonly changeFilter: (next: Filter) => void;
  readonly requestSuccessor: () => void;
  readonly focusContinuation: object;
  readonly bubbleDefaultQuery: (...args: never[]) => unknown;
}

interface FilterFocusRequest {
  readonly claim: FilterKeyClaim;
  readonly source: FilterPublication;
  readonly authority: FilterAuthority;
  readonly changeFilter: (next: Filter) => void;
  readonly destination: FilterEntryPublication;
  readonly button: HTMLButtonElement;
  readonly nativeEvent: KeyboardEvent;
  readonly continuation: object;
}

interface FilterPublicationCells {
  active: FilterPublication | null;
  successorOf: FilterPublication | null;
  replay: FilterReplay | null;
  delivery: symbol | null;
  pendingFocus: FilterFocusRequest | null;
  readonly claimedPublications: WeakSet<FilterPublication>;
  readonly claimedEntries: WeakSet<FilterEntryPublication>;
  readonly claimedActions: WeakSet<FilterActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedMovements: WeakSet<object>;
  readonly claimedWindowProofs: WeakSet<FilterWindowKeyProof>;
  readonly claimedFocusRequests: WeakSet<FilterFocusRequest>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
}

interface FilterPublicationRuntime {
  readonly publication: FilterPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: FilterElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => FilterReplay | null;
  readonly captureGroup: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly captureButton: (
    filter: Filter,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly bubbleButton: (
    filter: Filter,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}

interface FilterPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureGroup: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureButtons: ReadonlyMap<
    Filter,
    (element: HTMLButtonElement | null) => void | (() => void)
  >;
  readonly captureGroupKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly captureButtonKeyDown: (
    filter: Filter,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly keyDownButton: (
    filter: Filter,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
}

class FilterElementOwner<T extends Element> implements FilterElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: FilterElementRole,
    private readonly onChange: (
      owner: FilterElementOwnerView,
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

const FILTERS = Object.freeze([
  Object.freeze({ value: "all", label: "All" }),
  Object.freeze({ value: "mine", label: "Owned by me" }),
  Object.freeze({ value: "shared", label: "Shared with me" }),
  Object.freeze({ value: "starred", label: "Starred" }),
  Object.freeze({ value: "trash", label: "Trash" }),
] as const satisfies readonly FilterDefinition[]);
const FILTER_GROUP_CLASS =
  "flex shrink-0 rounded-lg border border-line bg-surface p-0.5 text-xs";
const FILTER_GROUP_LABEL = "Document filters";

function filterDescriptorsMatch(
  current: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
) {
  if (!current) return false;
  return (
    current.configurable === expected.configurable &&
    current.enumerable === expected.enumerable &&
    current.writable === expected.writable &&
    current.value === expected.value &&
    current.get === expected.get &&
    current.set === expected.set
  );
}

function captureFilterTrustedAuthority(
  view: Window & typeof globalThis,
): FilterTrustedAuthority | null {
  let probe: KeyboardEvent;
  try {
    probe = new view.KeyboardEvent("dashboard-filter-keyboard-intrinsic");
  } catch {
    return null;
  }
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const apply = view.Reflect.apply;
  const descriptor = getOwnPropertyDescriptor(probe, "isTrusted");
  if (
    !descriptor ||
    descriptor.configurable !== false ||
    typeof descriptor.get !== "function" ||
    descriptor.set !== undefined
  ) {
    return null;
  }
  const expected = Object.freeze({ ...descriptor });
  const matches = (event: object) =>
    filterDescriptorsMatch(
      getOwnPropertyDescriptor(event, "isTrusted"),
      expected,
    );
  return Object.freeze({
    matches,
    read: (event: object) =>
      apply(descriptor.get as (this: object) => boolean, event, []),
    isCurrent: () =>
      view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
      view.Reflect.apply === apply &&
      matches(probe),
  });
}

function captureFilterActiveElementAuthority(
  view: Window & typeof globalThis,
): FilterActiveElementAuthority | null {
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  let owner: object | null = view.Document.prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, "activeElement");
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      return Object.freeze({
        read: (document: Document) =>
          apply(descriptor.get as (this: Document) => Element | null, document, []),
        isCurrent: () =>
          view.Object.getOwnPropertyDescriptor === getOwnPropertyDescriptor &&
          view.Object.getPrototypeOf === getPrototypeOf &&
          view.Reflect.apply === apply &&
          filterDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, "activeElement"),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function filterButtonClass(selected: boolean) {
  return cn(
    "rounded-md px-2.5 py-1",
    selected
      ? "bg-inverse text-white"
      : "text-ink-3 hover:text-ink",
  );
}

function filterDestination(
  key: string,
  current: number,
): number | null {
  if (current < 0 || current >= FILTERS.length) return null;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (current + 1) % FILTERS.length;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (current - 1 + FILTERS.length) % FILTERS.length;
  }
  if (key === "Home") return current === 0 ? null : 0;
  if (key === "End") {
    return current === FILTERS.length - 1 ? null : FILTERS.length - 1;
  }
  return null;
}

function filterRenderIsExact(
  render: FilterRenderPublication,
  currentFilter: Filter = render.filter,
) {
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.authority) &&
    render.mount === render.authority.mount &&
    render.authority.user === render.user &&
    render.authority.userId === render.userId &&
    render.user.id === render.userId &&
    render.definitions === FILTERS &&
    Object.isFrozen(render.definitions) &&
    render.definitions.length === 5 &&
    render.definitions.every(
      (definition, index) =>
        definition === FILTERS[index] &&
        Object.isFrozen(definition),
    ) &&
    render.currentFilter() === currentFilter
  );
}

function filterRendersMatch(
  previous: FilterRenderPublication,
  current: FilterRenderPublication,
) {
  return (
    previous.mount === current.mount &&
    previous.authority === current.authority &&
    previous.user === current.user &&
    previous.userId === current.userId &&
    previous.definitions === current.definitions &&
    previous.filter === current.filter &&
    previous.currentFilter === current.currentFilter &&
    previous.changeFilter === current.changeFilter &&
    filterRenderIsExact(previous) &&
    filterRenderIsExact(current)
  );
}

function createFilterDomGuard(
  ownerDocument: Document,
  group: HTMLDivElement,
  placement: TemplateGridPlacement,
  onMutation: () => void,
): SearchControlDomGuard | null {
  const MutationObserverConstructor =
    ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const relevant = (mutation: MutationRecord) => {
    if (mutation.target === group || group.contains(mutation.target)) return true;
    if (mutation.type === "attributes") {
      return (
        (mutation.attributeName === "aria-disabled" ||
          mutation.attributeName === "hidden" ||
          mutation.attributeName === "inert") &&
        placement.some(({ node }) => mutation.target === node)
      );
    }
    if (mutation.type !== "childList") return false;
    return placement.some(
      ({ node, parent }) =>
        mutation.target === parent &&
        (mutation.previousSibling === node ||
          mutation.nextSibling === node ||
          [...mutation.addedNodes, ...mutation.removedNodes].some(
            (changedNode) =>
              changedNode === node ||
              (changedNode.nodeType === 1 &&
                (changedNode as Element).contains(node)),
          )),
    );
  };
  const record = (records: readonly MutationRecord[]) => {
    if (!changed && records.some(relevant)) {
      changed = true;
      onMutation();
    }
    return changed;
  };
  const observer = new MutationObserverConstructor(record);
  observer.observe(ownerDocument, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return Object.freeze({
    unchanged: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function createFilterPublication(
  render: FilterRenderPublication,
  cells: FilterPublicationCells,
  requestSuccessor: () => void,
): FilterPublicationSet {
  let currentRuntime: FilterPublicationRuntime | null = null;
  let lastRuntime: FilterPublicationRuntime | null = null;
  let successorRequested = false;

  const onElementChange = (
    owner: FilterElementOwnerView,
    element: Element | null,
    previous: Element | null,
    last: Element | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      !successorRequested &&
      runtime?.isExactReplay() &&
      cells.successorOf === runtime.publication
    ) {
      const replay = runtime.replay();
      if (
        replay &&
        filterElementsAreExact(render, owners) &&
        replay.source.group === owners.group.element()
      ) {
        cells.replay = replay;
        successorRequested = true;
        requestSuccessor();
      }
    }
  };

  const owners = {
    group: new FilterElementOwner<HTMLDivElement>("group", onElementChange),
    buttons: new Map(
      FILTERS.map(
        ({ value }) =>
          [
            value,
            new FilterElementOwner<HTMLButtonElement>(value, onElementChange),
          ] as const,
      ),
    ),
  };

  const expectedOwners = () =>
    Object.freeze([
      owners.group,
      ...FILTERS.map(({ value }) => owners.buttons.get(value)!),
    ] as FilterElementOwnerView[]);

  const filterAncestorsAreEnabled = (
    element: HTMLElement,
    ownerDocument: Document,
  ) => {
    if (!TRUSTED_ELEMENT_HAS_ATTRIBUTE || !TRUSTED_ELEMENT_GET_ATTRIBUTE) {
      return false;
    }
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        TRUSTED_ELEMENT_HAS_ATTRIBUTE(current, "inert") ||
        TRUSTED_ELEMENT_HAS_ATTRIBUTE(current, "hidden") ||
        TRUSTED_ELEMENT_GET_ATTRIBUTE(
          current,
          "aria-disabled",
        )?.toLowerCase() === "true"
      ) {
        return false;
      }
      if (current === ownerDocument.documentElement) return true;
    }
    return false;
  };

  function filterElementsAreExact(
    publicationRender: FilterRenderPublication,
    publicationOwners: typeof owners,
    currentFilter: Filter = publicationRender.filter,
  ) {
    const group = publicationOwners.group.element();
    const ownerDocument = group?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !filterRenderIsExact(publicationRender, currentFilter) ||
      !ownerDocument ||
      !ownerWindow ||
      !(group instanceof ownerWindow.HTMLDivElement) ||
      !group.isConnected ||
      group.className !== FILTER_GROUP_CLASS ||
      TRUSTED_ELEMENT_GET_ATTRIBUTE?.(group, "role") !== "toolbar" ||
      TRUSTED_ELEMENT_GET_ATTRIBUTE?.(group, "aria-label") !==
        FILTER_GROUP_LABEL ||
      group.children.length !== FILTERS.length ||
      !filterAncestorsAreEnabled(group, ownerDocument)
    ) {
      return false;
    }
    const elements: HTMLButtonElement[] = [];
    for (let index = 0; index < FILTERS.length; index++) {
      const definition = FILTERS[index]!;
      const button = publicationOwners.buttons.get(definition.value)?.element();
      const selected = publicationRender.filter === definition.value;
      if (
        !(button instanceof ownerWindow.HTMLButtonElement) ||
        !button.isConnected ||
        button.ownerDocument !== ownerDocument ||
        group.children.item(index) !== button ||
        button.parentElement !== group ||
        TRUSTED_BUTTON_DISABLED?.(button) !== false ||
        TRUSTED_ELEMENT_GET_ATTRIBUTE?.(button, "type") !== "button" ||
        TRUSTED_ELEMENT_GET_ATTRIBUTE?.(button, "data-testid") !==
          `filter-${definition.value}` ||
        TRUSTED_ELEMENT_GET_ATTRIBUTE?.(button, "aria-pressed") !==
          String(selected) ||
        TRUSTED_ELEMENT_GET_ATTRIBUTE?.(button, "tabindex") !==
          (selected ? "0" : "-1") ||
        button.className !== filterButtonClass(selected) ||
        button.textContent !== definition.label ||
        !filterAncestorsAreEnabled(button, ownerDocument)
      ) {
        return false;
      }
      elements.push(button);
    }
    return new Set(elements).size === FILTERS.length;
  }

  const createRuntime = (): FilterPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    if (!filterElementsAreExact(render, owners)) return null;
    const group = owners.group.element();
    if (!group) return null;
    const ownerDocument = group.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(group instanceof ownerWindow.HTMLDivElement)
    ) {
      return null;
    }
    const trustedAuthority = captureFilterTrustedAuthority(ownerWindow);
    const activeElementAuthority =
      captureFilterActiveElementAuthority(ownerWindow);
    const eventCurrentTarget = capturePrototypeGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "currentTarget",
    );
    const eventDefaultPrevented = capturePrototypeGetter<boolean>(
      ownerWindow.Event.prototype,
      "defaultPrevented",
    );
    const eventTarget = capturePrototypeGetter<EventTarget | null>(
      ownerWindow.Event.prototype,
      "target",
    );
    const eventType = capturePrototypeGetter<string>(
      ownerWindow.Event.prototype,
      "type",
    );
    const eventPhase = capturePrototypeGetter<number>(
      ownerWindow.Event.prototype,
      "eventPhase",
    );
    const eventBubbles = capturePrototypeGetter<boolean>(
      ownerWindow.Event.prototype,
      "bubbles",
    );
    const eventCancelable = capturePrototypeGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelable",
    );
    const eventComposed = capturePrototypeGetter<boolean>(
      ownerWindow.Event.prototype,
      "composed",
    );
    const eventTimeStamp = capturePrototypeGetter<number>(
      ownerWindow.Event.prototype,
      "timeStamp",
    );
    const eventCancelBubble = capturePrototypeGetter<boolean>(
      ownerWindow.Event.prototype,
      "cancelBubble",
    );
    const keyboardKey = capturePrototypeGetter<string>(
      ownerWindow.KeyboardEvent.prototype,
      "key",
    );
    const keyboardCtrl = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "ctrlKey",
    );
    const keyboardMeta = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "metaKey",
    );
    const keyboardAlt = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "altKey",
    );
    const keyboardShift = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "shiftKey",
    );
    const keyboardRepeat = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "repeat",
    );
    const keyboardComposing = capturePrototypeGetter<boolean>(
      ownerWindow.KeyboardEvent.prototype,
      "isComposing",
    );
    const keyboardCode = capturePrototypeGetter<string>(
      ownerWindow.KeyboardEvent.prototype,
      "code",
    );
    const keyboardLocation = capturePrototypeGetter<number>(
      ownerWindow.KeyboardEvent.prototype,
      "location",
    );
    const keyboardCharCode = capturePrototypeGetter<number>(
      ownerWindow.KeyboardEvent.prototype,
      "charCode",
    );
    const keyboardKeyCode = capturePrototypeGetter<number>(
      ownerWindow.KeyboardEvent.prototype,
      "keyCode",
    );
    const uiView = capturePrototypeGetter<Window | null>(
      ownerWindow.UIEvent.prototype,
      "view",
    );
    const uiDetail = capturePrototypeGetter<number>(
      ownerWindow.UIEvent.prototype,
      "detail",
    );
    const composedPath = capturePrototypeMethod<
      (event: Event) => EventTarget[]
    >(ownerWindow.Event.prototype, "composedPath");
    const eventTargetPrototype = ownerWindow.EventTarget.prototype;
    const addEventListener = eventTargetPrototype.addEventListener;
    const removeEventListener = eventTargetPrototype.removeEventListener;
    const addWindowEventListener = ownerWindow.addEventListener;
    const removeWindowEventListener = ownerWindow.removeEventListener;
    const focus = ownerWindow.HTMLElement.prototype.focus;
    const apply = ownerWindow.Reflect.apply;
    if (
      !eventCurrentTarget ||
      !trustedAuthority ||
      !activeElementAuthority ||
      !eventDefaultPrevented ||
      !eventTarget ||
      !eventType ||
      !eventPhase ||
      !eventBubbles ||
      !eventCancelable ||
      !eventComposed ||
      !eventTimeStamp ||
      !eventCancelBubble ||
      !keyboardKey ||
      !keyboardCtrl ||
      !keyboardMeta ||
      !keyboardAlt ||
      !keyboardShift ||
      !keyboardRepeat ||
      !keyboardComposing ||
      !keyboardCode ||
      !keyboardLocation ||
      !keyboardCharCode ||
      !keyboardKeyCode ||
      !uiView ||
      !uiDetail ||
      !composedPath ||
      typeof addEventListener !== "function" ||
      typeof removeEventListener !== "function" ||
      typeof addWindowEventListener !== "function" ||
      typeof removeWindowEventListener !== "function" ||
      typeof focus !== "function"
    ) {
      return null;
    }
    const nativeOwnerWindow = ownerWindow;
    const nativeEventCurrentTarget = eventCurrentTarget;
    const nativeEventPhase = eventPhase;
    const nativeEventDefaultPrevented = eventDefaultPrevented;
    const nativeEventCancelBubble = eventCancelBubble;
    const nativeComposedPath = composedPath;
    let keyboardAuthorityHistoryIsClean = true;
    const keyboardAuthorityIsCurrent = () => {
      if (!keyboardAuthorityHistoryIsClean) return false;
      keyboardAuthorityHistoryIsClean =
        ownerDocument.defaultView === ownerWindow &&
        trustedAuthority.isCurrent() &&
        activeElementAuthority.isCurrent();
      return keyboardAuthorityHistoryIsClean;
    };
    let listenerAuthorityHistoryIsClean = true;
    const listenerAuthorityIsCurrent = () => {
      if (!listenerAuthorityHistoryIsClean) return false;
      try {
        listenerAuthorityHistoryIsClean =
          ownerDocument.defaultView === ownerWindow &&
          ownerWindow.EventTarget.prototype === eventTargetPrototype &&
          eventTargetPrototype.addEventListener === addEventListener &&
          eventTargetPrototype.removeEventListener === removeEventListener &&
          ownerWindow.addEventListener === addWindowEventListener &&
          ownerWindow.removeEventListener === removeWindowEventListener &&
          ownerWindow.HTMLElement.prototype.focus === focus &&
          ownerWindow.Reflect.apply === apply;
      } catch {
        listenerAuthorityHistoryIsClean = false;
      }
      return listenerAuthorityHistoryIsClean;
    };

    const placement = searchControlPlacement(group);
    if (!placement) return null;
    const dom = snapshotTemplateGridDom(group);
    const identity = Symbol("dashboard-filter-publication");
    const entries: FilterEntryPublication[] = [];
    for (let index = 0; index < FILTERS.length; index++) {
      const definition = FILTERS[index]!;
      const element = owners.buttons.get(definition.value)?.element();
      if (!(element instanceof ownerWindow.HTMLButtonElement)) return null;
      const path = templateGridEventPath(ownerDocument, element);
      if (!path) return null;
      const entryIdentity = Symbol(`dashboard-filter-${definition.value}`);
      entries.push(
        Object.freeze({
          identity: entryIdentity,
          publicationIdentity: identity,
          definition,
          index,
          element,
          path,
          action: Object.freeze({
            identity: Symbol(
              `dashboard-filter-${definition.value}-keyboard-action`,
            ),
            publicationIdentity: identity,
            entryIdentity,
            filter: definition.value,
            index,
          }),
        }),
      );
    }
    const publishedEntries = Object.freeze(entries);

    let retired = false;
    let retirement: Retirement | null = null;
    let layoutRetired = false;
    let established = false;
    let refs: FilterRefReplay[] = [];
    let guard: SearchControlDomGuard | null = null;
    let keyPairs: WeakMap<KeyboardEvent, FilterKeyPair> | null = new WeakMap();
    let seenNativeEvents: WeakSet<Event> | null = new WeakSet();
    let publicCallbackPair: FilterKeyPair | null = null;
    let windowListenerAttached = false;
    let listenersAttached = false;

    const publication: FilterPublication = Object.freeze({
      identity,
      render,
      ownerDocument,
      group,
      entries: publishedEntries,
      dom,
      placement,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const releaseGuard = () => {
      guard?.release();
      guard = null;
    };
    const revokePairingAccess = () => {
      keyPairs = null;
      seenNativeEvents = null;
    };
    const retire = (reason: Retirement) => {
      if (reason === "layout") layoutRetired = true;
      if (retired) {
        if (reason === "layout" && cells.pendingFocus?.source === publication) {
          queueMicrotask(() => {
            if (cells.pendingFocus?.source === publication) {
              cells.pendingFocus = null;
            }
          });
        }
        return false;
      }
      retired = true;
      retirement = reason;
      revokePairingAccess();
      releaseNativeListeners();
      if (cells.active === publication) {
        cells.active = null;
        cells.successorOf = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (reason === "other") {
        releaseGuard();
      } else {
        queueMicrotask(() => {
          if (cells.replay?.source !== publication) releaseGuard();
        });
      }
      if (reason === "layout" && cells.pendingFocus?.source === publication) {
        queueMicrotask(() => {
          if (cells.pendingFocus?.source === publication) {
            cells.pendingFocus = null;
          }
        });
      }
      return true;
    };
    const groupMatches = () =>
      group.isConnected &&
      group.ownerDocument === ownerDocument &&
      publication.dom.node === group &&
      templateGridDomMatches(publication.dom) &&
      searchControlPlacementMatches(ownerDocument, publication.placement);
    const publicationOwnsCurrentDom = () => {
      if (
        retired ||
        cells.active !== publication ||
        publication.render !== render ||
        !filterElementsAreExact(render, owners) ||
        !groupMatches() ||
        !guard?.unchanged()
      ) {
        retire("other");
        return false;
      }
      return true;
    };

    const entryForEvent = (event: Event) => {
      if (!keyboardAuthorityIsCurrent()) {
        publication.retire();
        requestSuccessor();
        return null;
      }
      if (
        eventType(event) !== "keydown" ||
        !TRUSTED_IS_PROTOTYPE_OF(
          ownerWindow.KeyboardEvent.prototype,
          event,
        )
      ) {
        return null;
      }
      const target = eventTarget(event);
      return (
        publishedEntries.find(({ element }) => element === target) ?? null
      );
    };
    const pathsMatch = (
      expected: readonly EventTarget[],
      current: readonly EventTarget[],
    ) =>
      expected.length === current.length &&
      expected.every((entry, index) => current[index] === entry);
    const nativeStillMatches = (
      proof: FilterNativeKeyProof,
      expectedDefaultPrevented = false,
      completedDispatch = false,
    ) => {
      try {
        const path = composedPath(proof.event);
        const view = uiView(proof.event);
        const pathIsCurrent =
          pathsMatch(proof.path, path) &&
          path.at(-2) === ownerDocument &&
          path.at(-1) === proof.windowReceiver;
        const dispatchIsComplete =
          completedDispatch &&
          path.length === 0 &&
          eventCurrentTarget(proof.event) === null &&
          eventPhase(proof.event) === ownerWindow.Event.NONE;
        return (
          keyboardAuthorityIsCurrent() &&
          listenerAuthorityIsCurrent() &&
          proof.event instanceof ownerWindow.KeyboardEvent &&
          TRUSTED_OBJECT_GET_PROTOTYPE_OF(proof.event) ===
            ownerWindow.KeyboardEvent.prototype &&
          trustedAuthority.matches(proof.event) &&
          trustedAuthority.read(proof.event) === proof.trusted &&
          eventTarget(proof.event) === proof.target &&
          eventType(proof.event) === "keydown" &&
          eventBubbles(proof.event) === proof.bubbles &&
          eventCancelable(proof.event) === proof.cancelable &&
          eventComposed(proof.event) === proof.composed &&
          eventTimeStamp(proof.event) === proof.timeStamp &&
          eventDefaultPrevented(proof.event) === expectedDefaultPrevented &&
          eventCancelBubble(proof.event) === false &&
          keyboardKey(proof.event) === proof.key &&
          keyboardCode(proof.event) === proof.code &&
          keyboardLocation(proof.event) === proof.location &&
          keyboardCharCode(proof.event) === proof.charCode &&
          keyboardKeyCode(proof.event) === proof.keyCode &&
          keyboardCtrl(proof.event) === proof.ctrlKey &&
          keyboardMeta(proof.event) === proof.metaKey &&
          keyboardAlt(proof.event) === proof.altKey &&
          keyboardShift(proof.event) === proof.shiftKey &&
          keyboardRepeat(proof.event) === proof.repeat &&
          keyboardComposing(proof.event) === proof.composing &&
          uiDetail(proof.event) === proof.detail &&
          Object.is(view, proof.view) &&
          (view === null ||
            view === ownerWindow ||
            view === proof.windowReceiver) &&
          (pathIsCurrent || dispatchIsComplete)
        );
      } catch {
        return false;
      }
    };

    const exactNativeEvent = (
      event: Event,
      entry: FilterEntryPublication,
    ): FilterKeyPair | null => {
      try {
        if (
          !publicationOwnsCurrentDom() ||
          !keyboardAuthorityIsCurrent() ||
          !listenerAuthorityIsCurrent() ||
          !(event instanceof ownerWindow.KeyboardEvent) ||
          TRUSTED_OBJECT_GET_PROTOTYPE_OF(event) !==
            ownerWindow.KeyboardEvent.prototype ||
          !trustedAuthority.matches(event) ||
          trustedAuthority.read(event) !== true ||
          eventCurrentTarget(event) !== ownerDocument ||
          eventPhase(event) !== ownerWindow.Event.CAPTURING_PHASE ||
          !eventBubbles(event) ||
          !eventCancelable(event) ||
          eventDefaultPrevented(event) ||
          eventCancelBubble(event) ||
          activeElementAuthority.read(ownerDocument) !== entry.element ||
          entry.publicationIdentity !== identity ||
          entry.action.publicationIdentity !== identity ||
          entry.action.entryIdentity !== entry.identity ||
          render.filter !== entry.definition.value ||
          render.currentFilter() !== render.filter
        ) {
          return null;
        }
        const key = keyboardKey(event);
        const destinationIndex = filterDestination(key, entry.index);
        const destination =
          destinationIndex === null ? null : publishedEntries[destinationIndex];
        const path = composedPath(event);
        const view = uiView(event);
        if (
          !destination ||
          keyboardCtrl(event) ||
          keyboardMeta(event) ||
          keyboardAlt(event) ||
          keyboardShift(event) ||
          keyboardRepeat(event) ||
          keyboardComposing(event) ||
          path.length !== entry.path.length ||
          !entry.path
            .slice(0, -1)
            .every((target, index) => path[index] === target) ||
          path.at(-2) !== ownerDocument ||
          !path.at(-1) ||
          (view !== null &&
            view !== ownerWindow &&
            view !== path.at(-1))
        ) {
          return null;
        }
        const nativeEvent = event as KeyboardEvent;
        const documentCapture = Object.freeze<FilterDocumentKeyProof>({
          event: nativeEvent,
          receiver: ownerDocument,
          currentTarget: ownerDocument,
          phase: ownerWindow.Event.CAPTURING_PHASE,
        });
        const movement = Object.freeze<FilterKeyboardMovement>({
          identity: Symbol("dashboard-filter-keyboard-movement"),
          publication,
          definitions: render.definitions,
          source: entry,
          destination,
          key,
        });
        const native = Object.freeze<FilterNativeKeyProof>({
          identity: Symbol("dashboard-filter-native-key"),
          event: nativeEvent,
          publication,
          entry,
          action: entry.action,
          target: entry.element,
          path: Object.freeze([...path]),
          windowReceiver: path.at(-1)!,
          key,
          code: keyboardCode(event),
          location: keyboardLocation(event),
          charCode: keyboardCharCode(event),
          keyCode: keyboardKeyCode(event),
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          repeat: false,
          composing: false,
          bubbles: true,
          cancelable: true,
          composed: eventComposed(event),
          timeStamp: eventTimeStamp(event),
          view,
          detail: uiDetail(event),
          destination: destination.definition.value,
          destinationButton: destination.element,
          trusted: true,
          documentCapture,
          movement,
        });
        return {
          native,
          token: Symbol("dashboard-filter-keyboard-delivery"),
          state: "staged",
          buttonBoundary: null,
          groupCapture: null,
          buttonCapture: null,
          buttonBubble: null,
          bubbleDefaultQuery: null,
          documentBubble: null,
          windowProof: null,
        };
      } catch {
        return null;
      }
    };

    const beginNativeEvent = (event: Event) => {
      const pairs = keyPairs;
      const seen = seenNativeEvents;
      if (
        !pairs ||
        !seen ||
        retired ||
        publicCallbackPair !== null ||
        cells.delivery !== null ||
        cells.claimedNativeEvents.has(event)
      ) {
        return null;
      }
      const entry = entryForEvent(event);
      if (!entry) return null;
      const existing = pairs.get(event as KeyboardEvent);
      if (existing) {
        existing.state = "replayed";
        return null;
      }
      if (seen.has(event)) return null;
      const pair = exactNativeEvent(event, entry);
      if (!pair || keyPairs !== pairs || seenNativeEvents !== seen) return null;
      seen.add(event);
      pairs.set(pair.native.event, pair);
      try {
        apply(addWindowEventListener, ownerWindow, [
          "keydown",
          onNativeWindowBubble,
        ]);
        windowListenerAttached = true;
      } catch {
        abandonPair(pair);
        return null;
      }
      if (!listenerAuthorityIsCurrent()) {
        releaseWindowListener();
        abandonPair(pair);
        return null;
      }
      cells.delivery = pair.token;
      // Interrupted propagation must not strand route exclusion; the weak pair remains.
      queueMicrotask(() => {
        if (cells.delivery === pair.token) cells.delivery = null;
        if (pair.windowProof === null) releaseWindowListener();
      });
      return pair;
    };
    const abandonPair = (pair: FilterKeyPair) => {
      if (keyPairs?.get(pair.native.event) === pair) {
        keyPairs.delete(pair.native.event);
      }
      pair.state = "consumed";
      if (cells.delivery === pair.token) cells.delivery = null;
    };

    const captureReactProof = (
      event: ReactKeyboardEvent<HTMLElement>,
      pair: FilterKeyPair,
      currentTarget: HTMLElement,
      phase: number,
    ): FilterReactKeyProof | null => {
      try {
        const methods = Object.freeze<FilterReactKeyMethods>({
          preventDefault: event.preventDefault as (...args: never[]) => unknown,
          isDefaultPrevented: event.isDefaultPrevented as (
            ...args: never[]
          ) => unknown,
          isPropagationStopped: event.isPropagationStopped as (
            ...args: never[]
          ) => unknown,
        });
        const view: unknown = event.view;
        const eventWithComposing = event as ReactKeyboardEvent<HTMLElement> & {
          readonly isComposing?: unknown;
        };
        const composing =
          eventWithComposing.isComposing === undefined
            ? undefined
            : eventWithComposing.isComposing;
        if (
          event.nativeEvent !== pair.native.event ||
          event.type !== "keydown" ||
          event.target !== pair.native.target ||
          event.currentTarget !== currentTarget ||
          event.eventPhase !== phase ||
          event.bubbles !== true ||
          event.cancelable !== true ||
          event.defaultPrevented !== false ||
          event.isTrusted !== true ||
          event.key !== pair.native.key ||
          event.code !== pair.native.code ||
          event.location !== pair.native.location ||
          event.charCode !== pair.native.charCode ||
          event.keyCode !== pair.native.keyCode ||
          event.repeat !== false ||
          (composing !== undefined && composing !== false) ||
          event.ctrlKey !== false ||
          event.metaKey !== false ||
          event.altKey !== false ||
          event.shiftKey !== false ||
          event.detail !== pair.native.detail ||
          !Object.is(view, pair.native.view) ||
          (view !== null &&
            view !== ownerWindow &&
            view !== pair.native.windowReceiver) ||
          typeof methods.preventDefault !== "function" ||
          typeof methods.isDefaultPrevented !== "function" ||
          typeof methods.isPropagationStopped !== "function"
        ) {
          return null;
        }
        return Object.freeze({
          event,
          nativeEvent: pair.native.event,
          target: pair.native.target,
          currentTarget,
          type: "keydown",
          phase,
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          trusted: true,
          view,
          key: pair.native.key,
          code: pair.native.code,
          location: pair.native.location,
          charCode: pair.native.charCode,
          keyCode: pair.native.keyCode,
          repeat: false,
          composing,
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          detail: pair.native.detail,
          methods,
        });
      } catch {
        return null;
      }
    };

    const reactProofIsCurrent = (
      proof: FilterReactKeyProof,
      expectedDefaultPrevented = false,
      defaultQuery: (...args: never[]) => unknown =
        proof.methods.isDefaultPrevented,
      atDelivery = false,
    ) => {
      try {
        const event = proof.event;
        return (
          event.nativeEvent === proof.nativeEvent &&
          event.type === proof.type &&
          event.target === proof.target &&
          (!atDelivery || event.currentTarget === proof.currentTarget) &&
          event.eventPhase === proof.phase &&
          event.bubbles === proof.bubbles &&
          event.cancelable === proof.cancelable &&
          event.defaultPrevented === expectedDefaultPrevented &&
          event.isTrusted === proof.trusted &&
          Object.is(event.view, proof.view) &&
          event.key === proof.key &&
          event.code === proof.code &&
          event.location === proof.location &&
          event.charCode === proof.charCode &&
          event.keyCode === proof.keyCode &&
          event.repeat === proof.repeat &&
          (event as ReactKeyboardEvent<HTMLElement> & {
            readonly isComposing?: unknown;
          }).isComposing === proof.composing &&
          event.ctrlKey === proof.ctrlKey &&
          event.metaKey === proof.metaKey &&
          event.altKey === proof.altKey &&
          event.shiftKey === proof.shiftKey &&
          event.detail === proof.detail &&
          event.preventDefault === proof.methods.preventDefault &&
          event.isDefaultPrevented === defaultQuery &&
          event.isPropagationStopped ===
            proof.methods.isPropagationStopped
        );
      } catch {
        return false;
      }
    };

    const pairBaseIsCurrent = (
      pair: FilterKeyPair,
      expectedDefaultPrevented = false,
      expectedFilter: Filter = render.filter,
    ) => {
      const pairs = keyPairs;
      const native = pair.native;
      return Boolean(
        pairs &&
          pairs.get(native.event) === pair &&
          pair.state !== "replayed" &&
          currentRuntime?.publication === publication &&
          listenersAttached &&
          (cells.delivery === null || cells.delivery === pair.token) &&
          native.publication === publication &&
          native.entry === pair.native.movement.source &&
          native.action === native.entry.action &&
          native.destination === native.movement.destination.definition.value &&
          native.destinationButton === native.movement.destination.element &&
          native.movement.publication === publication &&
          native.movement.definitions === render.definitions &&
          native.movement.key === native.key &&
          render.definitions === FILTERS &&
          render.currentFilter() === expectedFilter &&
          filterElementsAreExact(render, owners, expectedFilter) &&
          publicationOwnsCurrentDom() &&
          activeElementAuthority.read(ownerDocument) === native.target &&
          nativeStillMatches(
            native,
            expectedDefaultPrevented,
            pair.windowProof !== null,
          ),
      );
    };

    const storedReactProofsAreCurrent = (
      pair: FilterKeyPair,
      expectedDefaultPrevented = false,
      bubbleDefaultQuery?: (...args: never[]) => unknown,
    ) => {
      const bubble = pair.buttonBubble;
      const proofs = [
        pair.groupCapture,
        pair.buttonCapture,
        bubble,
      ].filter((proof): proof is FilterReactKeyProof => proof !== null);
      return proofs.every((proof) => {
        const isBubbleEvent = Boolean(
          bubble && proof.event === bubble.event && expectedDefaultPrevented,
        );
        return reactProofIsCurrent(
          proof,
          isBubbleEvent,
          isBubbleEvent && bubbleDefaultQuery
            ? bubbleDefaultQuery
            : proof.methods.isDefaultPrevented,
        );
      });
    };

    const invokePairPublic = (
      pair: FilterKeyPair,
      callback: (...args: never[]) => unknown,
      receiver: object,
    ): { readonly value: unknown } | null => {
      if (
        publicCallbackPair !== null ||
        (cells.delivery !== null && cells.delivery !== pair.token)
      ) {
        return null;
      }
      const acquired = cells.delivery === null;
      if (acquired) cells.delivery = pair.token;
      publicCallbackPair = pair;
      try {
        return Object.freeze({
          value: apply(callback, receiver, []),
        });
      } catch {
        return null;
      } finally {
        if (publicCallbackPair === pair) publicCallbackPair = null;
        if (acquired && cells.delivery === pair.token) cells.delivery = null;
      }
    };

    const authenticateReactDelivery = (
      pair: FilterKeyPair,
      event: ReactKeyboardEvent<HTMLElement>,
      currentTarget: HTMLElement,
      phase: number,
    ) => {
      if (
        !event ||
        typeof event !== "object" ||
        cells.claimedReactEvents.has(event) ||
        !pairBaseIsCurrent(pair) ||
        !storedReactProofsAreCurrent(pair)
      ) {
        return null;
      }
      const proof = captureReactProof(event, pair, currentTarget, phase);
      if (!proof || !reactProofIsCurrent(proof, false, undefined, true)) {
        return null;
      }
      const defaultResult = invokePairPublic(
        pair,
        proof.methods.isDefaultPrevented,
        proof.event,
      );
      if (
        defaultResult?.value !== false ||
        !pairBaseIsCurrent(pair) ||
        !storedReactProofsAreCurrent(pair) ||
        !reactProofIsCurrent(proof, false, undefined, true)
      ) {
        return null;
      }
      const propagationResult = invokePairPublic(
        pair,
        proof.methods.isPropagationStopped,
        proof.event,
      );
      if (
        propagationResult?.value !== false ||
        !pairBaseIsCurrent(pair) ||
        !storedReactProofsAreCurrent(pair) ||
        !reactProofIsCurrent(proof, false, undefined, true)
      ) {
        return null;
      }
      return proof;
    };

    const captureGroup = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (publicCallbackPair !== null) return;
      let nativeEvent: KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      const pair = keyPairs?.get(nativeEvent);
      if (
        !pair ||
        pair.groupCapture ||
        pair.buttonCapture ||
        pair.buttonBubble
      ) {
        return;
      }
      const proof = authenticateReactDelivery(
        pair,
        event,
        group,
        ownerWindow.Event.CAPTURING_PHASE,
      );
      if (proof && keyPairs?.get(nativeEvent) === pair) {
        pair.groupCapture = proof;
      }
    };
    const captureButton = (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (publicCallbackPair !== null) return;
      let nativeEvent: KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      const pair = keyPairs?.get(nativeEvent);
      if (
        !pair ||
        !pair.groupCapture ||
        pair.buttonCapture ||
        pair.buttonBubble ||
        pair.native.entry.definition.value !== filter
      ) {
        return;
      }
      const proof = authenticateReactDelivery(
        pair,
        event,
        pair.native.target,
        ownerWindow.Event.CAPTURING_PHASE,
      );
      if (proof && keyPairs?.get(nativeEvent) === pair) {
        pair.buttonCapture = proof;
      }
    };
    const bubbleButton = (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (publicCallbackPair !== null) return;
      let nativeEvent: KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      const pair = keyPairs?.get(nativeEvent);
      if (
        !pair ||
        !pair.groupCapture ||
        !pair.buttonCapture ||
        pair.buttonBubble ||
        pair.native.entry.definition.value !== filter
      ) {
        return;
      }
      const proof = authenticateReactDelivery(
        pair,
        event,
        pair.native.target,
        ownerWindow.Event.BUBBLING_PHASE,
      );
      if (
        proof &&
        keyPairs?.get(nativeEvent) === pair &&
        storedReactProofsAreCurrent(pair)
      ) {
        pair.buttonBubble = proof;
        pair.bubbleDefaultQuery = proof.methods.isDefaultPrevented;
        pair.state = "paired";
        if (pair.documentBubble && pair.windowProof) finalizePair(pair);
      }
    };

    const pairIsCompleteAndCurrent = (
      pair: FilterKeyPair,
      expectedDefaultPrevented = false,
      bubbleDefaultQuery?: (...args: never[]) => unknown,
    ) =>
      Boolean(
        pair.state !== "replayed" &&
          pair.buttonBoundary &&
          pair.groupCapture &&
          pair.buttonCapture &&
          pair.buttonBubble &&
          pair.documentBubble &&
          pair.windowProof &&
          pairBaseIsCurrent(pair, expectedDefaultPrevented) &&
          storedReactProofsAreCurrent(
            pair,
            expectedDefaultPrevented,
            bubbleDefaultQuery,
          ),
      );

    const claimPair = (pair: FilterKeyPair): FilterKeyClaim | null => {
      const pairs = keyPairs;
      const native = pair.native;
      const groupCapture = pair.groupCapture;
      const buttonCapture = pair.buttonCapture;
      const buttonBubble = pair.buttonBubble;
      const buttonBoundary = pair.buttonBoundary;
      const documentBubble = pair.documentBubble;
      const windowProof = pair.windowProof;
      if (
        !pairs ||
        !groupCapture ||
        !buttonCapture ||
        !buttonBubble ||
        !buttonBoundary ||
        !documentBubble ||
        !windowProof ||
        !pairIsCompleteAndCurrent(pair) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedEntries.has(native.entry) ||
        cells.claimedActions.has(native.action) ||
        cells.claimedNativeEvents.has(native.event) ||
        cells.claimedMovements.has(native.movement) ||
        cells.claimedWindowProofs.has(windowProof) ||
        cells.claimedReactEvents.has(groupCapture.event) ||
        cells.claimedReactEvents.has(buttonCapture.event) ||
        cells.claimedReactEvents.has(buttonBubble.event)
      ) {
        return null;
      }
      const focusContinuation = Object.freeze({
        publication,
        movement: native.movement,
        destination: native.movement.destination,
        changeFilter: render.changeFilter,
      });
      const claim = Object.freeze<FilterKeyClaim>({
        pair,
        native,
        publication,
        definitions: render.definitions,
        source: native.entry,
        destination: native.movement.destination,
        movement: native.movement,
        groupCapture,
        buttonCapture,
        buttonBubble,
        documentCapture: native.documentCapture,
        buttonBoundary,
        documentBubble,
        windowProof,
        authority: render.authority,
        changeFilter: render.changeFilter,
        requestSuccessor,
        focusContinuation,
        bubbleDefaultQuery: buttonBubble.methods.isDefaultPrevented,
      });
      const focusRequest = Object.freeze<FilterFocusRequest>({
        claim,
        source: publication,
        authority: render.authority,
        changeFilter: render.changeFilter,
        destination: native.movement.destination,
        button: native.destinationButton,
        nativeEvent: native.event,
        continuation: focusContinuation,
      });
      if (!pairs.delete(native.event)) return null;
      pair.state = "finalizing";
      cells.claimedPublications.add(publication);
      cells.claimedEntries.add(native.entry);
      cells.claimedActions.add(native.action);
      cells.claimedNativeEvents.add(native.event);
      cells.claimedMovements.add(native.movement);
      cells.claimedWindowProofs.add(windowProof);
      cells.claimedReactEvents.add(groupCapture.event);
      cells.claimedReactEvents.add(buttonCapture.event);
      cells.claimedReactEvents.add(buttonBubble.event);
      cells.pendingFocus = focusRequest;
      return claim;
    };

    const claimIsCurrent = (
      claim: FilterKeyClaim,
      expectedDefaultPrevented: boolean,
      bubbleDefaultQuery: (...args: never[]) => unknown,
      expectedFilter: Filter = render.filter,
    ) => {
      const pair = claim.pair;
      const pending = cells.pendingFocus;
      return Boolean(
        cells.delivery === pair.token &&
          pair.state === "finalizing" &&
          keyPairs?.has(claim.native.event) === false &&
          claim.native === pair.native &&
          claim.publication === publication &&
          claim.definitions === render.definitions &&
          claim.source === claim.native.entry &&
          claim.destination === claim.movement.destination &&
          claim.movement === claim.native.movement &&
          claim.groupCapture === pair.groupCapture &&
          claim.buttonCapture === pair.buttonCapture &&
          claim.buttonBubble === pair.buttonBubble &&
          claim.documentCapture === claim.native.documentCapture &&
          claim.buttonBoundary === pair.buttonBoundary &&
          claim.documentBubble === pair.documentBubble &&
          claim.windowProof === pair.windowProof &&
          claim.authority === render.authority &&
          claim.changeFilter === render.changeFilter &&
          claim.requestSuccessor === requestSuccessor &&
          pair.bubbleDefaultQuery === bubbleDefaultQuery &&
          pending?.claim === claim &&
          pending.source === publication &&
          pending.authority === render.authority &&
          pending.changeFilter === render.changeFilter &&
          pending.destination === claim.destination &&
          pending.button === claim.destination.element &&
          pending.nativeEvent === claim.native.event &&
          pending.continuation === claim.focusContinuation &&
          cells.claimedPublications.has(publication) &&
          cells.claimedEntries.has(claim.source) &&
          cells.claimedActions.has(claim.source.action) &&
          cells.claimedNativeEvents.has(claim.native.event) &&
          cells.claimedMovements.has(claim.movement) &&
          cells.claimedWindowProofs.has(claim.windowProof) &&
          cells.claimedReactEvents.has(claim.groupCapture.event) &&
          cells.claimedReactEvents.has(claim.buttonCapture.event) &&
          cells.claimedReactEvents.has(claim.buttonBubble.event) &&
          listenersAttached &&
          listenerAuthorityIsCurrent() &&
          currentRuntime?.publication === publication &&
          render.currentFilter() === expectedFilter &&
          filterElementsAreExact(render, owners, expectedFilter) &&
          groupMatches() &&
          Boolean(guard?.unchanged()) &&
          activeElementAuthority.read(ownerDocument) === claim.source.element &&
          nativeStillMatches(claim.native, expectedDefaultPrevented, true) &&
          storedReactProofsAreCurrent(
            pair,
            expectedDefaultPrevented,
            bubbleDefaultQuery,
          ) &&
          ((eventCurrentTarget(claim.native.event) ===
            claim.native.windowReceiver &&
            eventPhase(claim.native.event) ===
              ownerWindow.Event.BUBBLING_PHASE) ||
            (eventCurrentTarget(claim.native.event) === null &&
              eventPhase(claim.native.event) === ownerWindow.Event.NONE)) &&
          claim.windowProof.receiver === claim.native.windowReceiver &&
          claim.windowProof.currentTarget === claim.native.windowReceiver &&
          claim.windowProof.terminal === claim.native.windowReceiver &&
          claim.windowProof.listener === onNativeWindowBubble &&
          claim.windowProof.addEventListener === addWindowEventListener &&
          claim.windowProof.removeEventListener === removeWindowEventListener,
      );
    };

    const invokeClaimPublic = <Args extends readonly unknown[]>(
      claim: FilterKeyClaim,
      callback: (...args: Args) => unknown,
      receiver: unknown,
      args: Args,
    ): { readonly value: unknown } | null => {
      if (
        publicCallbackPair !== null ||
        cells.delivery !== claim.pair.token
      ) {
        return null;
      }
      publicCallbackPair = claim.pair;
      try {
        return Object.freeze({ value: apply(callback, receiver, args) });
      } catch {
        return null;
      } finally {
        if (publicCallbackPair === claim.pair) publicCallbackPair = null;
      }
    };

    const postCleanupClaimIsCurrent = (
      claim: FilterKeyClaim,
      bubbleDefaultQuery: (...args: never[]) => unknown,
    ) => {
      const pending = cells.pendingFocus;
      return Boolean(
        cells.delivery === claim.pair.token &&
          claim.pair.state === "finalizing" &&
          publication.isRetired() &&
          currentRuntime?.publication !== publication &&
          cells.active !== publication &&
          cells.successorOf === publication &&
          keyPairs === null &&
          seenNativeEvents === null &&
          !listenersAttached &&
          render.currentFilter() === claim.destination.definition.value &&
          render.changeFilter === claim.changeFilter &&
          pending?.claim === claim &&
          pending.source === publication &&
          pending.destination === claim.destination &&
          pending.button === claim.destination.element &&
          pending.continuation === claim.focusContinuation &&
          cells.claimedNativeEvents.has(claim.native.event) &&
          cells.claimedMovements.has(claim.movement) &&
          cells.claimedWindowProofs.has(claim.windowProof) &&
          nativeStillMatches(claim.native, true, true) &&
          storedReactProofsAreCurrent(
            claim.pair,
            true,
            bubbleDefaultQuery,
          ),
      );
    };

    const finalizePair = (pair: FilterKeyPair) => {
      if (cells.delivery !== null && cells.delivery !== pair.token) return;
      cells.delivery = pair.token;
      const claim = claimPair(pair);
      if (!claim) {
        if (cells.delivery === pair.token) cells.delivery = null;
        return;
      }
      let selected = false;
      let requested = false;
      let bubbleDefaultQuery = claim.bubbleDefaultQuery;
      try {
        if (!claimIsCurrent(claim, false, bubbleDefaultQuery)) return;
        const prevented = invokeClaimPublic(
          claim,
          claim.buttonBubble.methods.preventDefault,
          claim.buttonBubble.event,
          [],
        );
        if (!prevented) return;
        try {
          bubbleDefaultQuery = claim.buttonBubble.event
            .isDefaultPrevented as (...args: never[]) => unknown;
        } catch {
          return;
        }
        if (
          typeof bubbleDefaultQuery !== "function" ||
          claim.buttonBubble.event.preventDefault !==
            claim.buttonBubble.methods.preventDefault ||
          claim.buttonBubble.event.isPropagationStopped !==
            claim.buttonBubble.methods.isPropagationStopped
        ) {
          return;
        }
        pair.bubbleDefaultQuery = bubbleDefaultQuery;
        if (!claimIsCurrent(claim, true, bubbleDefaultQuery)) return;
        const defaultResult = invokeClaimPublic(
          claim,
          bubbleDefaultQuery,
          claim.buttonBubble.event,
          [],
        );
        if (
          defaultResult?.value !== true ||
          !claimIsCurrent(claim, true, bubbleDefaultQuery)
        ) {
          return;
        }
        const propagationResult = invokeClaimPublic(
          claim,
          claim.buttonBubble.methods.isPropagationStopped,
          claim.buttonBubble.event,
          [],
        );
        if (
          propagationResult?.value !== false ||
          !claimIsCurrent(claim, true, bubbleDefaultQuery)
        ) {
          return;
        }
        const changed = invokeClaimPublic(
          claim,
          claim.changeFilter,
          undefined,
          [claim.destination.definition.value],
        );
        if (
          !changed ||
          !claimIsCurrent(
            claim,
            true,
            bubbleDefaultQuery,
            claim.destination.definition.value,
          )
        ) {
          return;
        }
        selected = true;
        publication.retire();
        if (!postCleanupClaimIsCurrent(claim, bubbleDefaultQuery)) return;
        requested = true;
        if (
          !invokeClaimPublic(
            claim,
            claim.requestSuccessor,
            undefined,
            [],
          ) ||
          !postCleanupClaimIsCurrent(claim, bubbleDefaultQuery)
        ) {
          return;
        }
      } finally {
        pair.state = "consumed";
        if (!selected) {
          if (cells.pendingFocus?.claim === claim) cells.pendingFocus = null;
          publication.retire();
          if (!requested && render.currentFilter() === render.filter) {
            requested = true;
            invokeClaimPublic(
              claim,
              claim.requestSuccessor,
              undefined,
              [],
            );
          }
        }
        if (cells.delivery === pair.token) cells.delivery = null;
      }
    };

    function onNativeWindowBubble(this: EventTarget, event: Event) {
      const pairs = keyPairs;
      if (
        !pairs ||
        retired ||
        publicCallbackPair !== null ||
        cells.claimedNativeEvents.has(event) ||
        !(event instanceof nativeOwnerWindow.KeyboardEvent)
      ) {
        return;
      }
      const pair = pairs.get(event);
      if (!pair || cells.delivery !== pair.token) return;
      if (
        (pair.state !== "staged" && pair.state !== "paired") ||
        !pair.buttonBoundary ||
        !pair.documentBubble ||
        pair.windowProof ||
        nativeEventCurrentTarget(event) !== this ||
        this !== pair.native.windowReceiver ||
        nativeEventPhase(event) !== nativeOwnerWindow.Event.BUBBLING_PHASE ||
        nativeEventDefaultPrevented(event) ||
        nativeEventCancelBubble(event) ||
        !pairBaseIsCurrent(pair)
      ) {
        releaseWindowListener();
        abandonPair(pair);
        return;
      }
      const path = nativeComposedPath(event);
      if (
        !pathsMatch(pair.native.path, path) ||
        path.at(-2) !== ownerDocument ||
        path.at(-1) !== this
      ) {
        releaseWindowListener();
        abandonPair(pair);
        return;
      }
      pair.windowProof = Object.freeze({
        publication,
        event,
        listener: onNativeWindowBubble,
        receiver: this,
        currentTarget: this,
        terminal: path.at(-1)!,
        path: Object.freeze([...path]),
        phase: nativeOwnerWindow.Event.BUBBLING_PHASE,
        addEventListener: addWindowEventListener,
        removeEventListener: removeWindowEventListener,
      });
      releaseWindowListener();
      if (
        pair.state === "paired" &&
        pair.groupCapture &&
        pair.buttonCapture &&
        pair.buttonBubble &&
        storedReactProofsAreCurrent(pair)
      ) {
        finalizePair(pair);
      } else if (cells.delivery === pair.token) {
        cells.delivery = null;
      }
    }

    function onNativeCapture(this: EventTarget, event: Event) {
      if (
        publicCallbackPair !== null ||
        this !== ownerDocument ||
        nativeEventCurrentTarget(event) !== ownerDocument ||
        nativeEventPhase(event) !== nativeOwnerWindow.Event.CAPTURING_PHASE
      ) {
        return;
      }
      beginNativeEvent(event);
    }
    function onNativeBubble(this: EventTarget, event: Event) {
      if (publicCallbackPair !== null) return;
      const pair = keyPairs?.get(event as KeyboardEvent);
      if (
        !pair ||
        (pair.state !== "staged" && pair.state !== "paired") ||
        !pair.buttonBoundary ||
        pair.documentBubble ||
        this !== ownerDocument ||
        nativeEventCurrentTarget(event) !== ownerDocument ||
        nativeEventPhase(event) !== nativeOwnerWindow.Event.BUBBLING_PHASE ||
        nativeEventDefaultPrevented(event) ||
        nativeEventCancelBubble(event) ||
        !pairBaseIsCurrent(pair)
      ) {
        if (pair) abandonPair(pair);
        return;
      }
      pair.documentBubble = Object.freeze({
        event: pair.native.event,
        receiver: ownerDocument,
        currentTarget: ownerDocument,
        phase: nativeOwnerWindow.Event.BUBBLING_PHASE,
      });
    }
    const boundaryListeners = publishedEntries.map((entry) => {
      const listener = function (this: EventTarget, event: Event) {
        if (publicCallbackPair !== null) return;
        const pair = keyPairs?.get(event as KeyboardEvent);
        if (
          pair &&
          !pair.buttonBoundary &&
          pair.native.entry === entry &&
          this === entry.element &&
          nativeEventCurrentTarget(event) === entry.element &&
          (nativeEventPhase(event) ===
            nativeOwnerWindow.Event.CAPTURING_PHASE ||
            nativeEventPhase(event) === nativeOwnerWindow.Event.AT_TARGET) &&
          pairBaseIsCurrent(pair) &&
          publicationOwnsCurrentDom() &&
          keyboardAuthorityIsCurrent() &&
          activeElementAuthority.read(ownerDocument) === entry.element
        ) {
          pair.buttonBoundary = Object.freeze({
            event: pair.native.event,
            receiver: entry.element,
            currentTarget: entry.element,
            phase: eventPhase(event),
          });
        }
      };
      return Object.freeze({ entry, listener });
    });
    const addNativeListeners = () => {
      if (listenersAttached || !listenerAuthorityIsCurrent()) return false;
      try {
        apply(addEventListener, ownerDocument, [
          "keydown",
          onNativeCapture,
          true,
        ]);
        apply(addEventListener, ownerDocument, ["keydown", onNativeBubble]);
        for (const { entry, listener } of boundaryListeners) {
          apply(addEventListener, entry.element, ["keydown", listener, true]);
        }
        listenersAttached = true;
        if (listenerAuthorityIsCurrent()) return true;
        releaseNativeListeners();
        return false;
      } catch {
        releaseNativeListeners();
        return false;
      }
    };
    function releaseWindowListener() {
      if (!windowListenerAttached) return;
      windowListenerAttached = false;
      try {
        apply(removeWindowEventListener, ownerWindow, [
          "keydown",
          onNativeWindowBubble,
        ]);
      } catch {
        listenerAuthorityHistoryIsClean = false;
      }
    }
    function releaseNativeListeners() {
      releaseWindowListener();
      if (!listenersAttached) return;
      listenersAttached = false;
      try {
        apply(removeEventListener, ownerDocument, [
          "keydown",
          onNativeCapture,
          true,
        ]);
        apply(removeEventListener, ownerDocument, [
          "keydown",
          onNativeBubble,
        ]);
        for (const { entry, listener } of boundaryListeners) {
          apply(removeEventListener, entry.element, [
            "keydown",
            listener,
            true,
          ]);
        }
      } catch {
        listenerAuthorityHistoryIsClean = false;
      }
    }

    const completePendingFocus = () => {
      const pending = cells.pendingFocus;
      const destination = publishedEntries.find(
        ({ definition }) => definition.value === render.filter,
      );
      if (!pending) return;
      const claim = pending.claim;
      const bubbleDefaultQuery = claim.pair.bubbleDefaultQuery;
      if (
        !destination ||
        typeof bubbleDefaultQuery !== "function" ||
        pending.claim !== claim ||
        pending.authority !== render.authority ||
        pending.changeFilter !== render.changeFilter ||
        pending.destination.definition.value !== render.filter ||
        pending.destination !== claim.destination ||
        pending.button !== destination.element ||
        pending.button !== claim.destination.element ||
        pending.source.ownerDocument !== ownerDocument ||
        pending.source.group !== group ||
        !pending.source.isRetired() ||
        claim.pair.state !== "consumed" ||
        claim.publication !== pending.source ||
        claim.authority !== render.authority ||
        claim.changeFilter !== render.changeFilter ||
        claim.destination.definition.value !== render.filter ||
        claim.destination.element !== destination.element ||
        claim.focusContinuation !== pending.continuation ||
        claim.native.destinationButton !== destination.element ||
        !cells.claimedPublications.has(pending.source) ||
        !cells.claimedNativeEvents.has(pending.nativeEvent) ||
        !cells.claimedEntries.has(claim.source) ||
        !cells.claimedActions.has(claim.source.action) ||
        !cells.claimedMovements.has(claim.movement) ||
        !cells.claimedWindowProofs.has(claim.windowProof) ||
        !cells.claimedReactEvents.has(claim.groupCapture.event) ||
        !cells.claimedReactEvents.has(claim.buttonCapture.event) ||
        !cells.claimedReactEvents.has(claim.buttonBubble.event) ||
        cells.claimedFocusRequests.has(pending) ||
        cells.active !== publication ||
        cells.delivery !== null ||
        currentRuntime?.publication !== publication ||
        render.currentFilter() !== render.filter ||
        activeElementAuthority.read(ownerDocument) !== claim.source.element ||
        !storedReactProofsAreCurrent(claim.pair, true, bubbleDefaultQuery) ||
        !listenerAuthorityIsCurrent() ||
        !publicationOwnsCurrentDom()
      ) {
        cells.pendingFocus = null;
        return;
      }
      cells.claimedFocusRequests.add(pending);
      cells.pendingFocus = null;
      cells.delivery = claim.pair.token;
      try {
        const focused = invokeClaimPublic(
          claim,
          focus,
          destination.element,
          [{ preventScroll: true }],
        );
        if (
          !focused ||
          cells.delivery !== claim.pair.token ||
          cells.pendingFocus !== null ||
          !cells.claimedFocusRequests.has(pending) ||
          cells.active !== publication ||
          currentRuntime?.publication !== publication ||
          render.currentFilter() !== render.filter ||
          activeElementAuthority.read(ownerDocument) !== destination.element ||
          !storedReactProofsAreCurrent(claim.pair, true, bubbleDefaultQuery) ||
          !listenerAuthorityIsCurrent() ||
          !publicationOwnsCurrentDom()
        ) {
          return;
        }
      } catch {
        return;
      } finally {
        if (cells.delivery === claim.pair.token) cells.delivery = null;
      }
    };

    const runtime: FilterPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        refs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish dashboard filters without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        guard = createFilterDomGuard(
          ownerDocument,
          group,
          placement,
          () => {
            retire("other");
            requestSuccessor();
          },
        );
        if (
          !guard ||
          cells.active ||
          !filterElementsAreExact(render, owners) ||
          !groupMatches() ||
          !guard.unchanged()
        ) {
          releaseGuard();
          return false;
        }
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        if (!addNativeListeners()) {
          if (cells.active === publication) cells.active = null;
          releaseGuard();
          return false;
        }
        completePendingFocus();
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: FilterElementOwnerView,
        element: Element | null,
        previous: Element | null,
      ) => {
        if (!established) return;
        const proof = refs.find((entry) => entry.owner === owner);
        if (!proof) return;
        if (
          proof.state === "attached" &&
          element === null &&
          previous === proof.element
        ) {
          proof.state = "detached";
        } else if (
          proof.state === "detached" &&
          element === proof.element &&
          previous === null
        ) {
          proof.state = "reattached";
        } else if (element !== previous) {
          proof.state = "invalid";
        }
      },
      isExactReplay: () =>
        retired &&
        established &&
        ((layoutRetired &&
          (retirement === "layout" || retirement === "element")) ||
          (!layoutRetired && retirement === "element")) &&
        refs.length === expectedOwners().length &&
        refs.every(
          (entry) =>
            entry.state === "reattached" &&
            entry.owner.element() === entry.element,
        ) &&
        filterElementsAreExact(render, owners) &&
        groupMatches() &&
        Boolean(guard?.unchanged()),
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              unchanged: guard.unchanged,
              release: releaseGuard,
            })
          : null,
      captureGroup,
      captureButton,
      bubbleButton,
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        !successorRequested &&
        lastRuntime.isExactReplay() &&
        cells.successorOf === lastRuntime.publication
      ) {
        const replay = lastRuntime.replay();
        if (replay) {
          cells.replay = replay;
          successorRequested = true;
          requestSuccessor();
        }
      }
      return;
    }
    if (!filterElementsAreExact(render, owners)) return;
    const replay = cells.replay;
    if (replay) {
      const sameFacts = filterRendersMatch(replay.source.render, render);
      const exact =
        sameFacts &&
        replay.source.isRetired() &&
        cells.successorOf === replay.source &&
        replay.dom.node === owners.group.element() &&
        replay.unchanged() &&
        templateGridDomMatches(replay.dom) &&
        searchControlPlacementMatches(
          replay.source.ownerDocument,
          replay.placement,
        );
      cells.replay = null;
      replay.release();
      if (cells.successorOf === replay.source) cells.successorOf = null;
      if (sameFacts && !exact) return;
    }
    const runtime = createRuntime();
    if (!runtime) return;
    const previous = cells.active;
    if (previous) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return;
    }
    return runtime.retireForLayout;
  };

  return Object.freeze({
    establish,
    captureGroup: owners.group.capture,
    captureButtons: new Map(
      FILTERS.map(
        ({ value }) => [value, owners.buttons.get(value)!.capture] as const,
      ),
    ),
    captureGroupKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) =>
      currentRuntime?.captureGroup(event),
    captureButtonKeyDown: (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) =>
      currentRuntime?.captureButton(filter, event),
    keyDownButton: (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) =>
      currentRuntime?.bubbleButton(filter, event),
  });
}

type AccountDirection = "first" | "last";
type AccountKeyRoute = "block" | "radix";

interface AccountMenuState {
  readonly identity: symbol;
  readonly open: boolean;
}

interface AccountAuthority {
  readonly mount: symbol;
  readonly visit: symbol;
  readonly user: DashboardProps["user"];
  readonly userId: string;
}

interface AccountRenderPublication {
  readonly identity: symbol;
  readonly authority: AccountAuthority;
  readonly user: DashboardProps["user"];
  readonly userId: string;
  readonly router: ReturnType<typeof useRouter>;
  readonly routerPush: ReturnType<typeof useRouter>["push"];
  readonly openSettings: () => void;
  readonly signOut: () => void;
  readonly state: AccountMenuState;
  readonly open: boolean;
  readonly setState: Dispatch<SetStateAction<AccountMenuState>>;
  readonly changeOpen: (open: boolean) => void;
}

type AccountElementRole = "trigger" | "content" | "settings" | "sign-out";

interface AccountElementOwnerView {
  readonly role: AccountElementRole;
  readonly element: () => HTMLElement | null;
}

interface AccountRefReplay {
  readonly owner: AccountElementOwnerView;
  readonly element: HTMLElement;
  state: "attached" | "detached" | "reattached" | "invalid";
}

interface AccountDirectionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly direction: AccountDirection;
  readonly key: "ArrowDown" | "ArrowUp";
  readonly code: "ArrowDown" | "ArrowUp";
  readonly destination: "settings" | "sign-out";
}

interface AccountKeyboardAuthority {
  readonly base: SearchResultKeyboardAuthority;
  readonly code: (event: Event) => string;
  readonly location: (event: Event) => number;
  readonly composed: (event: Event) => boolean;
  readonly detail: (event: Event) => number;
  readonly isKeyboardEvent: (event: object) => boolean;
  readonly addEventListener: (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  readonly removeEventListener: (
    target: EventTarget,
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ) => void;
  readonly addWindowEventListener: (
    type: string,
    listener: (event: Event) => void,
  ) => void;
  readonly removeWindowEventListener: (
    type: string,
    listener: (event: Event) => void,
  ) => void;
  readonly isCurrent: () => boolean;
}

interface AccountRouteProof {
  readonly event: KeyboardEvent;
  readonly key: string;
  readonly direction: AccountDirection | null;
  readonly path: readonly EventTarget[];
}

interface AccountNativeKeyProof extends AccountRouteProof {
  readonly publication: AccountPublication;
  readonly action: AccountDirectionPublication;
  readonly code: string;
  readonly location: number;
  readonly view: Window | null;
  readonly reactCaptureEvent: object;
  readonly reactPrototype: object;
  readonly propagationStopped: () => boolean;
  crossed: boolean;
  boundary: boolean;
  reactBubbleEvent: object | null;
}

interface AccountFocusRequest {
  readonly source: AccountPublication;
  readonly authority: AccountAuthority;
  readonly state: AccountMenuState;
  readonly nextState: AccountMenuState;
  readonly direction: AccountDirectionPublication;
  readonly trigger: HTMLButtonElement;
  readonly triggerChild: TemplateGridDomSnapshot;
  readonly settingsAction: () => void;
  readonly signOutAction: () => void;
  readonly nativeEvent: KeyboardEvent;
  readonly reactCaptureEvent: object;
  readonly reactBubbleEvent: object;
}

interface AccountPublication {
  readonly identity: symbol;
  readonly render: AccountRenderPublication;
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly trigger: HTMLButtonElement;
  readonly content: HTMLDivElement | null;
  readonly settings: HTMLDivElement | null;
  readonly signOut: HTMLDivElement | null;
  readonly triggerDom: TemplateGridDomSnapshot;
  readonly triggerPlacement: TemplateGridPlacement;
  readonly contentDom: TemplateGridDomSnapshot | null;
  readonly contentPlacement: TemplateGridPlacement | null;
  readonly actions: Readonly<Record<AccountDirection, AccountDirectionPublication>>;
  readonly focus: (element: HTMLElement, options: FocusOptions) => void;
  readonly intrinsicsAreCurrent: () => boolean;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface AccountReplayGuard {
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface AccountPublicationRuntime {
  readonly publication: AccountPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: AccountElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly isExactNoRefLayoutReplay: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly captureKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly routeKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => AccountKeyRoute;
  readonly openAutoFocus: (event: Event) => void;
}

interface AccountPublicationCells {
  active: AccountPublication | null;
  successorOf: AccountPublication | null;
  pendingFocus: AccountFocusRequest | null;
  delivery: symbol | null;
  readonly claimedPublications: WeakSet<AccountPublication>;
  readonly claimedDirections: WeakSet<AccountDirectionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly claimedAutoFocusEvents: WeakSet<Event>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
  readonly attemptedAutoFocusEvents: WeakSet<Event>;
}

interface AccountPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureTrigger: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureContent: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureSettings: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureSignOut: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  readonly routeKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => AccountKeyRoute;
  readonly openAutoFocus: (event: Event) => void;
}

class AccountElementOwner<T extends HTMLElement>
  implements AccountElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: AccountElementRole,
    private readonly onChange: (
      owner: AccountElementOwnerView,
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

function captureAccountKeyboardAuthority(
  view: Window & typeof globalThis,
): AccountKeyboardAuthority | null {
  const base = captureSearchResultKeyboardAuthority(view);
  const code = captureSearchOwnerGetter<string>(
    view,
    view.KeyboardEvent.prototype,
    "code",
  );
  const location = captureSearchOwnerGetter<number>(
    view,
    view.KeyboardEvent.prototype,
    "location",
  );
  const composed = captureSearchOwnerGetter<boolean>(
    view,
    view.Event.prototype,
    "composed",
  );
  const detail = captureSearchOwnerGetter<number>(
    view,
    view.UIEvent.prototype,
    "detail",
  );
  const isPrototypeOf = captureSearchOwnerMethod<[object], boolean>(
    view,
    view.Object.prototype,
    "isPrototypeOf",
  );
  const addEventListener = captureSearchOwnerMethod<
    [
      type: string,
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ],
    void
  >(view, view.EventTarget.prototype, "addEventListener");
  const removeEventListener = captureSearchOwnerMethod<
    [
      type: string,
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ],
    void
  >(view, view.EventTarget.prototype, "removeEventListener");
  const addWindowEventListener = captureSearchOwnerGetter<
    Window["addEventListener"]
  >(view, view, "addEventListener");
  const removeWindowEventListener = captureSearchOwnerGetter<
    Window["removeEventListener"]
  >(view, view, "removeEventListener");
  const addWindowListener = addWindowEventListener?.read(view);
  const removeWindowListener = removeWindowEventListener?.read(view);
  if (
    !base ||
    !code ||
    !location ||
    !composed ||
    !detail ||
    !isPrototypeOf ||
    !addEventListener ||
    !removeEventListener ||
    !addWindowEventListener ||
    !removeWindowEventListener ||
    typeof addWindowListener !== "function" ||
    typeof removeWindowListener !== "function"
  ) {
    return null;
  }
  const authorities = [
    code,
    location,
    composed,
    detail,
    isPrototypeOf,
    addEventListener,
    removeEventListener,
    addWindowEventListener,
    removeWindowEventListener,
  ];
  return Object.freeze({
    base,
    code: (event: Event) => code.read(event),
    location: (event: Event) => location.read(event),
    composed: (event: Event) => composed.read(event),
    detail: (event: Event) => detail.read(event),
    isKeyboardEvent: (event: object) =>
      isPrototypeOf.call(view.KeyboardEvent.prototype, [event]),
    addEventListener: (
      target: EventTarget,
      type: string,
      listener: (event: Event) => void,
      options?: boolean | AddEventListenerOptions,
    ) =>
      addEventListener.call(target, [type, listener, options]),
    removeEventListener: (
      target: EventTarget,
      type: string,
      listener: (event: Event) => void,
      options?: boolean | EventListenerOptions,
    ) =>
      removeEventListener.call(target, [type, listener, options]),
    addWindowEventListener: (
      type: string,
      listener: (event: Event) => void,
    ) =>
      TRUSTED_REFLECT_APPLY(addWindowListener, view, [type, listener]),
    removeWindowEventListener: (
      type: string,
      listener: (event: Event) => void,
    ) =>
      TRUSTED_REFLECT_APPLY(removeWindowListener, view, [type, listener]),
    isCurrent: () =>
      base.isCurrent() &&
      authorities.every((authority) => authority.isCurrent()),
  });
}

function accountRenderIsExact(render: AccountRenderPublication) {
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.authority) &&
    Object.isFrozen(render.state) &&
    typeof render.authority.mount === "symbol" &&
    typeof render.authority.visit === "symbol" &&
    render.authority.user === render.user &&
    render.authority.userId === render.userId &&
    render.user.id === render.userId &&
    render.router.push === render.routerPush &&
    typeof render.openSettings === "function" &&
    typeof render.signOut === "function" &&
    typeof render.setState === "function" &&
    typeof render.changeOpen === "function" &&
    typeof render.state.identity === "symbol" &&
    render.open === render.state.open
  );
}

function captureAccountPath(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
  ownerWindow: Window & typeof globalThis,
): readonly EventTarget[] | null {
  const actualWindow = actual.at(-1);
  if (
    expected.at(-1) !== ownerWindow ||
    !(actualWindow instanceof ownerWindow.Window) ||
    expected.length !== actual.length ||
    !expected
      .slice(0, -1)
      .every((entry, index) => actual[index] === entry)
  ) {
    return null;
  }
  return Object.freeze([...actual]);
}

function accountPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
) {
  return (
    expected.length === actual.length &&
    expected.every((entry, index) => actual[index] === entry)
  );
}

function accountAncestorsAreEnabled(
  element: HTMLElement,
  ownerDocument: Document,
) {
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.matches(":disabled") ||
      current.hasAttribute("inert") ||
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
    if (current === ownerDocument.documentElement) return true;
  }
  return false;
}

function accountElementsAreExact(
  render: AccountRenderPublication,
  owners: {
    trigger: AccountElementOwner<HTMLButtonElement>;
    content: AccountElementOwner<HTMLDivElement>;
    settings: AccountElementOwner<HTMLDivElement>;
    signOut: AccountElementOwner<HTMLDivElement>;
  },
  requireCurrentRender = true,
) {
  const trigger = owners.trigger.element();
  const ownerDocument = trigger?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (
    (requireCurrentRender && !accountRenderIsExact(render)) ||
    !ownerDocument ||
    !ownerWindow ||
    !(trigger instanceof ownerWindow.HTMLButtonElement) ||
    !trigger.isConnected ||
    trigger.type !== "button" ||
    trigger.className !== "rounded-full" ||
    trigger.getAttribute("aria-label") !== "Account" ||
    trigger.getAttribute("aria-haspopup") !== "menu" ||
    trigger.getAttribute("aria-expanded") !== String(render.open) ||
    trigger.getAttribute("data-state") !== (render.open ? "open" : "closed") ||
    trigger.id.length === 0 ||
    trigger.children.length !== 1 ||
    !accountAncestorsAreEnabled(trigger, ownerDocument)
  ) {
    return false;
  }
  const content = owners.content.element();
  const settings = owners.settings.element();
  const signOut = owners.signOut.element();
  if (!render.open) {
    return (
      content === null &&
      settings === null &&
      signOut === null &&
      trigger.getAttribute("aria-controls") === null
    );
  }
  if (
    !(content instanceof ownerWindow.HTMLDivElement) ||
    !(settings instanceof ownerWindow.HTMLDivElement) ||
    !(signOut instanceof ownerWindow.HTMLDivElement) ||
    !content.isConnected ||
    !settings.isConnected ||
    !signOut.isConnected ||
    content.ownerDocument !== ownerDocument ||
    settings.ownerDocument !== ownerDocument ||
    signOut.ownerDocument !== ownerDocument ||
    content.getAttribute("role") !== "menu" ||
    content.getAttribute("data-state") !== "open" ||
    content.getAttribute("aria-labelledby") !== trigger.id ||
    content.id.length === 0 ||
    trigger.getAttribute("aria-controls") !== content.id ||
    content.className !==
      "menu animate-fade-in max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto w-56" ||
    content.children.length !== 3 ||
    content.children.item(1) !== settings ||
    content.children.item(2) !== signOut ||
    settings.parentElement !== content ||
    signOut.parentElement !== content ||
    settings.getAttribute("role") !== "menuitem" ||
    signOut.getAttribute("role") !== "menuitem" ||
    settings.className !== "menu-item" ||
    signOut.className !== "menu-item" ||
    settings.textContent?.trim() !== "Agents & API tokens" ||
    signOut.textContent?.trim() !== "Sign out" ||
    !accountAncestorsAreEnabled(content, ownerDocument) ||
    !accountAncestorsAreEnabled(settings, ownerDocument) ||
    !accountAncestorsAreEnabled(signOut, ownerDocument)
  ) {
    return false;
  }
  return true;
}

function createAccountDomGuard(
  ownerDocument: Document,
  trigger: HTMLButtonElement,
  content: HTMLDivElement | null,
  triggerPlacement: TemplateGridPlacement,
  contentPlacement: TemplateGridPlacement | null,
  onMutation: () => void,
): AccountReplayGuard | null {
  const MutationObserverConstructor =
    ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const roots = [trigger, content].filter(
    (
      element,
    ): element is HTMLButtonElement | HTMLDivElement => element !== null,
  );
  const placements = contentPlacement
    ? [...triggerPlacement, ...contentPlacement]
    : triggerPlacement;
  const relevant = (mutation: MutationRecord) => {
    if (
      roots.some(
        (root) => mutation.target === root || root.contains(mutation.target),
      )
    ) {
      return true;
    }
    if (mutation.type === "attributes") {
      return (
        (mutation.attributeName === "aria-disabled" ||
          mutation.attributeName === "hidden" ||
          mutation.attributeName === "inert") &&
        placements.some(({ node }) => mutation.target === node)
      );
    }
    if (mutation.type !== "childList") return false;
    return placements.some(
      ({ node, parent }) =>
        mutation.target === parent &&
        (mutation.previousSibling === node ||
          mutation.nextSibling === node ||
          [...mutation.addedNodes, ...mutation.removedNodes].some(
            (changedNode) =>
              changedNode === node ||
              (changedNode.nodeType === 1 &&
                (changedNode as Element).contains(node)),
          )),
    );
  };
  const record = (records: readonly MutationRecord[]) => {
    if (!changed && records.some(relevant)) {
      changed = true;
      onMutation();
    }
    return changed;
  };
  const observer = new MutationObserverConstructor(record);
  observer.observe(ownerDocument, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return Object.freeze({
    unchanged: () => {
      record(observer.takeRecords());
      return !changed;
    },
    release: () => {
      record(observer.takeRecords());
      observer.disconnect();
    },
  });
}

function createAccountPublication(
  render: AccountRenderPublication,
  cells: AccountPublicationCells,
  requestSuccessor: () => void,
): AccountPublicationSet {
  let currentRuntime: AccountPublicationRuntime | null = null;
  let lastRuntime: AccountPublicationRuntime | null = null;
  let successorRequested = false;
  let noRefLayoutReplayUsed = false;

  const onElementChange = (
    owner: AccountElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
    last: HTMLElement | null,
  ) => {
    const runtime = currentRuntime ?? lastRuntime;
    runtime?.noteRef(owner, element, previous);
    if (
      element === null ||
      (element !== null && last !== null && element !== last)
    ) {
      currentRuntime?.retireForElement();
      currentRuntime = null;
    }
    if (
      !successorRequested &&
      runtime?.isExactReplay() &&
      cells.successorOf === runtime.publication
    ) {
      successorRequested = true;
      requestSuccessor();
    }
  };

  const owners = {
    trigger: new AccountElementOwner<HTMLButtonElement>(
      "trigger",
      onElementChange,
    ),
    content: new AccountElementOwner<HTMLDivElement>(
      "content",
      onElementChange,
    ),
    settings: new AccountElementOwner<HTMLDivElement>(
      "settings",
      onElementChange,
    ),
    signOut: new AccountElementOwner<HTMLDivElement>(
      "sign-out",
      onElementChange,
    ),
  };
  const expectedOwners = () =>
    render.open
      ? [owners.trigger, owners.content, owners.settings, owners.signOut]
      : [owners.trigger];

  const createRuntime = (): AccountPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    if (!accountElementsAreExact(render, owners)) return null;
    const trigger = owners.trigger.element();
    if (!trigger) return null;
    const ownerDocument = trigger.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const content = owners.content.element();
    const settings = owners.settings.element();
    const signOut = owners.signOut.element();
    const triggerPlacement = searchControlPlacement(trigger);
    const contentPlacement = content ? searchControlPlacement(content) : null;
    const keyboard = ownerWindow
      ? captureAccountKeyboardAuthority(ownerWindow)
      : null;
    const triggerPath = templateGridEventPath(ownerDocument, trigger);
    if (
      !ownerWindow ||
      !keyboard ||
      !triggerPlacement ||
      !triggerPath ||
      (render.open && (!content || !settings || !signOut || !contentPlacement))
    ) {
      return null;
    }

    const identity = Symbol("dashboard-account-publication");
    const actions = Object.freeze({
      first: Object.freeze({
        identity: Symbol("dashboard-account-first"),
        publicationIdentity: identity,
        direction: "first" as const,
        key: "ArrowDown" as const,
        code: "ArrowDown" as const,
        destination: "settings" as const,
      }),
      last: Object.freeze({
        identity: Symbol("dashboard-account-last"),
        publicationIdentity: identity,
        direction: "last" as const,
        key: "ArrowUp" as const,
        code: "ArrowUp" as const,
        destination: "sign-out" as const,
      }),
    });
    const triggerDom = snapshotTemplateGridDom(trigger);
    const contentDom = content ? snapshotTemplateGridDom(content) : null;
    let retired = false;
    let retirement: Retirement | null = null;
    let layoutRetired = false;
    let established = false;
    let refs: AccountRefReplay[] = [];
    let guard: AccountReplayGuard | null = null;
    let keyboardHistoryIsClean = true;
    let routeProof: AccountRouteProof | null = null;
    let nativeProof: AccountNativeKeyProof | null = null;
    let nativeListening = false;
    let terminalListening = false;
    const reactCaptureCandidates = new WeakMap<Event, object>();

    const intrinsicsAreCurrent = () => {
      if (!keyboardHistoryIsClean) return false;
      keyboardHistoryIsClean =
        ownerDocument.defaultView === ownerWindow && keyboard.isCurrent();
      return keyboardHistoryIsClean;
    };
    const publication: AccountPublication = Object.freeze({
      identity,
      render,
      ownerDocument,
      ownerWindow,
      trigger,
      content,
      settings,
      signOut,
      triggerDom,
      triggerPlacement,
      contentDom,
      contentPlacement,
      actions,
      focus: keyboard.base.focus,
      intrinsicsAreCurrent,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const exactDomMatches = () =>
      accountElementsAreExact(render, owners) &&
      templateGridDomMatches(triggerDom) &&
      searchControlPlacementMatches(ownerDocument, triggerPlacement) &&
      (render.open
        ? Boolean(
            contentDom &&
              contentPlacement &&
              templateGridDomMatches(contentDom) &&
              searchControlPlacementMatches(ownerDocument, contentPlacement),
          )
        : true);
    const replayDomMatches = () =>
      accountElementsAreExact(render, owners, false) &&
      templateGridDomMatches(triggerDom) &&
      searchControlPlacementMatches(ownerDocument, triggerPlacement) &&
      (render.open
        ? Boolean(
            contentDom &&
              contentPlacement &&
              templateGridDomMatches(contentDom) &&
              searchControlPlacementMatches(ownerDocument, contentPlacement),
          )
        : true);
    const publicationOwnsCurrentDom = () => {
      if (
        retired ||
        cells.active !== publication ||
        publication.render !== render ||
        !accountRenderIsExact(render) ||
        !exactDomMatches() ||
        !guard?.unchanged()
      ) {
        if (retire("other")) requestSuccessor();
        return false;
      }
      return true;
    };
    const removeTerminalListener = () => {
      if (!terminalListening) return;
      terminalListening = false;
      keyboard.removeWindowEventListener("keydown", onWindowTerminal);
    };
    const clearProof = () => {
      removeTerminalListener();
      routeProof = null;
      nativeProof = null;
    };
    const releaseNativeListeners = () => {
      if (!nativeListening) {
        removeTerminalListener();
        return;
      }
      nativeListening = false;
      keyboard.removeEventListener(
        trigger,
        "keydown",
        onNativeCapture,
        true,
      );
      keyboard.removeEventListener(trigger, "keydown", onNativeBoundary);
      removeTerminalListener();
    };
    const releaseGuard = () => {
      guard?.release();
      guard = null;
    };
    const retire = (reason: Retirement) => {
      if (reason === "layout") layoutRetired = true;
      if (retired) return false;
      retired = true;
      retirement = reason;
      clearProof();
      releaseNativeListeners();
      if (cells.active === publication) {
        cells.active = null;
        cells.successorOf = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (reason === "other") releaseGuard();
      else {
        queueMicrotask(() => {
          releaseGuard();
        });
      }
      if (
        reason === "layout" &&
        cells.pendingFocus?.source === publication
      ) {
        queueMicrotask(() => {
          if (cells.pendingFocus?.source === publication) {
            cells.pendingFocus = null;
          }
        });
      }
      return true;
    };

    const routeEvent = (event: Event): AccountRouteProof | null => {
      try {
        if (!intrinsicsAreCurrent()) {
          if (retire("other")) requestSuccessor();
          return null;
        }
        const path = captureAccountPath(
          triggerPath,
          keyboard.base.composedPath(event),
          ownerWindow,
        );
        if (
          !publicationOwnsCurrentDom() ||
          !keyboard.isKeyboardEvent(event) ||
          keyboard.base.type(event) !== "keydown" ||
          keyboard.base.currentTarget(event) !== trigger ||
          (keyboard.base.phase(event) !== ownerWindow.Event.AT_TARGET &&
            keyboard.base.phase(event) !==
              ownerWindow.Event.CAPTURING_PHASE) ||
          keyboard.base.target(event) !== trigger ||
          !keyboard.base.bubbles(event) ||
          !path
        ) {
          return null;
        }
        const key = keyboard.base.key(event);
        return Object.freeze({
          event: event as KeyboardEvent,
          key,
          direction:
            key === "ArrowDown" ? "first" : key === "ArrowUp" ? "last" : null,
          path,
        });
      } catch {
        return null;
      }
    };
    const reactEventMatches = (
      event: object,
      proof: AccountRouteProof,
      phase: number,
      requireTrusted: boolean,
      expectedView?: Window | null,
      expectedCurrentTarget: EventTarget | null = trigger,
    ) => {
      const reactPrototype = TRUSTED_OBJECT_GET_PROTOTYPE_OF(event);
      const isDefaultPrevented = searchControlOwnValue(
        event,
        "isDefaultPrevented",
      );
      const isPropagationStopped = searchControlOwnValue(
        event,
        "isPropagationStopped",
      );
      try {
        return (
          reactPrototype !== null &&
          reactPrototype !== ownerWindow.Object.prototype &&
          searchControlOwnValue(event, "type") === "keydown" &&
          searchControlOwnValue(event, "nativeEvent") === proof.event &&
          searchControlOwnValue(event, "target") === trigger &&
          searchControlOwnValue(event, "currentTarget") ===
            expectedCurrentTarget &&
          searchControlOwnValue(event, "eventPhase") === phase &&
          searchControlOwnValue(event, "bubbles") === true &&
          searchControlOwnValue(event, "cancelable") === true &&
          searchControlOwnValue(event, "defaultPrevented") === false &&
          (!requireTrusted ||
            searchControlOwnValue(event, "isTrusted") === true) &&
          searchControlOwnValue(event, "key") === proof.key &&
          searchControlOwnValue(event, "code") ===
            keyboard.code(proof.event) &&
          searchControlOwnValue(event, "location") ===
            keyboard.location(proof.event) &&
          searchControlOwnValue(event, "ctrlKey") ===
            keyboard.base.ctrlKey(proof.event) &&
          searchControlOwnValue(event, "metaKey") ===
            keyboard.base.metaKey(proof.event) &&
          searchControlOwnValue(event, "altKey") ===
            keyboard.base.altKey(proof.event) &&
          searchControlOwnValue(event, "shiftKey") ===
            keyboard.base.shiftKey(proof.event) &&
          searchControlOwnValue(event, "repeat") ===
            keyboard.base.repeat(proof.event) &&
          searchControlOwnValue(event, "view") ===
            (expectedView === undefined
              ? keyboard.base.view(proof.event)
              : expectedView) &&
          typeof isDefaultPrevented === "function" &&
          !isDefaultPrevented() &&
          typeof isPropagationStopped === "function" &&
          !isPropagationStopped()
        );
      } catch {
        return false;
      }
    };
    const exactNativeEvent = (
      proof: AccountRouteProof,
    ): AccountNativeKeyProof | null => {
      const event = proof.event;
      const action = proof.direction ? actions[proof.direction] : null;
      const reactCaptureEvent = reactCaptureCandidates.get(event);
      if (!action || !reactCaptureEvent) return null;
      try {
        const eventView = keyboard.base.view(event);
        if (
          render.open ||
          render.state.open ||
          action.publicationIdentity !== identity ||
          keyboard.base.defaultPrevented(event) ||
          keyboard.base.cancelBubble(event) ||
          !keyboard.base.cancelable(event) ||
          !keyboard.composed(event) ||
          keyboard.detail(event) !== 0 ||
          keyboard.code(event) !== action.code ||
          keyboard.location(event) !== 0 ||
          keyboard.base.ctrlKey(event) ||
          keyboard.base.metaKey(event) ||
          keyboard.base.altKey(event) ||
          keyboard.base.shiftKey(event) ||
          keyboard.base.repeat(event) ||
          keyboard.base.composing(event) ||
          !keyboard.base.trusted.matches(event) ||
          keyboard.base.trusted.read(event) !== true ||
          (eventView !== null && eventView !== ownerWindow) ||
          keyboard.base.activeElement.read(ownerDocument) !== trigger ||
          TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
            event,
            "preventDefault",
          ) ||
          TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
            event,
            "stopPropagation",
          ) ||
          TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
            event,
            "stopImmediatePropagation",
          ) ||
          !reactEventMatches(
            reactCaptureEvent,
            proof,
            ownerWindow.Event.CAPTURING_PHASE,
            true,
            eventView,
            null,
          )
        ) {
          return null;
        }
        let propagationStopped = false;
        if (
          !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopPropagation", {
            configurable: false,
            enumerable: false,
            writable: false,
            value: () => {
              propagationStopped = true;
              keyboard.base.stopPropagation(event);
            },
          }) ||
          !TRUSTED_REFLECT_DEFINE_PROPERTY(
            event,
            "stopImmediatePropagation",
            {
              configurable: false,
              enumerable: false,
              writable: false,
              value: () => {
                propagationStopped = true;
                keyboard.base.stopImmediatePropagation(event);
              },
            },
          )
        ) {
          return null;
        }
        return {
          ...proof,
          publication,
          action,
          code: action.code,
          location: 0,
          view: eventView,
          reactCaptureEvent,
          reactPrototype: TRUSTED_OBJECT_GET_PROTOTYPE_OF(
            reactCaptureEvent,
          )!,
          propagationStopped: () => propagationStopped,
          crossed: false,
          boundary: false,
          reactBubbleEvent: null,
        };
      } catch {
        return null;
      }
    };
    const nativeStillMatches = (proof: AccountNativeKeyProof) => {
      try {
        return (
          intrinsicsAreCurrent() &&
          keyboard.base.trusted.matches(proof.event) &&
          keyboard.base.trusted.read(proof.event) === true &&
          keyboard.base.type(proof.event) === "keydown" &&
          keyboard.base.target(proof.event) === trigger &&
          keyboard.base.bubbles(proof.event) &&
          keyboard.base.cancelable(proof.event) &&
          keyboard.composed(proof.event) &&
          keyboard.detail(proof.event) === 0 &&
          keyboard.base.key(proof.event) === proof.action.key &&
          keyboard.code(proof.event) === proof.code &&
          keyboard.location(proof.event) === proof.location &&
          keyboard.base.view(proof.event) === proof.view &&
          !keyboard.base.ctrlKey(proof.event) &&
          !keyboard.base.metaKey(proof.event) &&
          !keyboard.base.altKey(proof.event) &&
          !keyboard.base.shiftKey(proof.event) &&
          !keyboard.base.repeat(proof.event) &&
          !keyboard.base.composing(proof.event) &&
          accountPathMatches(
            proof.path,
            keyboard.base.composedPath(proof.event),
          )
        );
      } catch {
        return false;
      }
    };
    const claim = (proof: AccountNativeKeyProof) => {
      const bubble = proof.reactBubbleEvent;
      if (
        !bubble ||
        cells.claimedPublications.has(publication) ||
        cells.claimedDirections.has(proof.action) ||
        cells.claimedNativeEvents.has(proof.event) ||
        cells.claimedReactEvents.has(proof.reactCaptureEvent) ||
        cells.claimedReactEvents.has(bubble)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedDirections.add(proof.action);
      cells.claimedNativeEvents.add(proof.event);
      cells.claimedReactEvents.add(proof.reactCaptureEvent);
      cells.claimedReactEvents.add(bubble);
      return true;
    };
    const openAutoFocus = (event: Event) => {
      const pending = cells.pendingFocus;
      if (
        !pending ||
        !(event instanceof ownerWindow.CustomEvent) ||
        cells.attemptedAutoFocusEvents.has(event) ||
        cells.claimedAutoFocusEvents.has(event)
      ) {
        return;
      }
      cells.attemptedAutoFocusEvents.add(event);
      const destination =
        pending.direction.destination === "settings" ? settings : signOut;
      if (
        !render.open ||
        !content ||
        !settings ||
        !signOut ||
        !destination ||
        pending.authority !== render.authority ||
        pending.state !== pending.source.render.state ||
        pending.nextState !== render.state ||
        pending.nextState.open !== true ||
        pending.trigger !== trigger ||
        pending.settingsAction !== render.openSettings ||
        pending.signOutAction !== render.signOut ||
        pending.source.trigger.children.item(0) !==
          pending.triggerChild.node ||
        !templateGridDomMatches(pending.triggerChild) ||
        !pending.source.isRetired() ||
        !pending.source.intrinsicsAreCurrent() ||
        !cells.claimedPublications.has(pending.source) ||
        !cells.claimedDirections.has(pending.direction) ||
        !cells.claimedNativeEvents.has(pending.nativeEvent) ||
        !cells.claimedReactEvents.has(pending.reactCaptureEvent) ||
        !cells.claimedReactEvents.has(pending.reactBubbleEvent) ||
        cells.active !== publication ||
        cells.delivery !== null ||
        !publicationOwnsCurrentDom() ||
        keyboard.base.type(event) !== "focusScope.autoFocusOnMount" ||
        keyboard.base.target(event) !== content ||
        keyboard.base.currentTarget(event) !== content ||
        keyboard.base.phase(event) !== ownerWindow.Event.AT_TARGET ||
        keyboard.base.bubbles(event) ||
        !keyboard.base.cancelable(event) ||
        keyboard.base.defaultPrevented(event) ||
        keyboard.base.cancelBubble(event) ||
        keyboard.base.activeElement.read(ownerDocument) !== trigger
      ) {
        return;
      }
      cells.claimedAutoFocusEvents.add(event);
      keyboard.base.preventDefault(event);
      if (!keyboard.base.defaultPrevented(event)) return;
      cells.pendingFocus = null;
      pending.source.focus(destination, { preventScroll: true });
    };
    const onWindowTerminal = (event: Event) => {
      const proof = nativeProof;
      if (
        !proof ||
        proof.event !== event ||
        !proof.boundary ||
        !proof.reactBubbleEvent ||
        proof.crossed ||
        proof.propagationStopped() ||
        cells.delivery !== null
      ) {
        return;
      }
      try {
        if (
          keyboard.base.currentTarget(event) !== proof.path.at(-1) ||
          keyboard.base.phase(event) !== ownerWindow.Event.BUBBLING_PHASE ||
          keyboard.base.defaultPrevented(event) ||
          keyboard.base.cancelBubble(event) ||
          searchControlOwnValue(
            proof.reactCaptureEvent,
            "currentTarget",
          ) !== null ||
          searchControlOwnValue(
            proof.reactBubbleEvent,
            "currentTarget",
          ) !== null ||
          keyboard.base.activeElement.read(ownerDocument) !== trigger ||
          render.state.open ||
          !nativeStillMatches(proof) ||
          !publicationOwnsCurrentDom() ||
          !claim(proof)
        ) {
          return;
        }
        const triggerChild = trigger.children.item(0);
        if (!(triggerChild instanceof ownerWindow.HTMLElement)) return;
        const nextState = Object.freeze({
          identity: Symbol("dashboard-account-open"),
          open: true,
        });
        cells.delivery = publication.identity;
        cells.pendingFocus = Object.freeze({
          source: publication,
          authority: render.authority,
          state: render.state,
          nextState,
          direction: proof.action,
          trigger,
          triggerChild: snapshotTemplateGridDom(triggerChild),
          settingsAction: render.openSettings,
          signOutAction: render.signOut,
          nativeEvent: proof.event,
          reactCaptureEvent: proof.reactCaptureEvent,
          reactBubbleEvent: proof.reactBubbleEvent,
        });
        publication.retire();
        keyboard.base.preventDefault(event);
        if (!keyboard.base.defaultPrevented(event)) {
          cells.pendingFocus = null;
          return;
        }
        render.setState((current) =>
          current === render.state && !current.open ? nextState : current,
        );
        requestSuccessor();
      } finally {
        if (cells.delivery === publication.identity) cells.delivery = null;
      }
    };
    const onNativeCapture = (event: Event) => {
      const proof = routeEvent(event);
      if (!proof) return;
      if (routeProof) {
        if (routeProof.event !== event && nativeProof) {
          nativeProof.crossed = true;
        }
        if (proof.direction) cells.attemptedNativeEvents.add(event);
        return;
      }
      routeProof = proof;
      if (!proof.direction) return;
      if (cells.attemptedNativeEvents.has(event)) return;
      cells.attemptedNativeEvents.add(event);
      nativeProof = exactNativeEvent(proof);
      if (nativeProof) {
        terminalListening = true;
        keyboard.addWindowEventListener("keydown", onWindowTerminal);
      }
      queueMicrotask(() => {
        if (routeProof !== proof) return;
        const directional = proof.direction !== null;
        clearProof();
        if (directional && !retired) {
          publication.retire();
          requestSuccessor();
        }
      });
    };
    const onNativeBoundary = (event: Event) => {
      if (
        nativeProof?.event === event &&
        keyboard.base.currentTarget(event) === trigger &&
        keyboard.base.phase(event) === ownerWindow.Event.AT_TARGET &&
        publicationOwnsCurrentDom() &&
        intrinsicsAreCurrent() &&
        keyboard.base.activeElement.read(ownerDocument) === trigger
      ) {
        nativeProof.boundary = true;
      }
    };
    const captureKeyDown = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      if (
        !event ||
        typeof event !== "object" ||
        cells.claimedReactEvents.has(event) ||
        cells.attemptedReactEvents.has(event)
      ) {
        return;
      }
      cells.attemptedReactEvents.add(event);
      const nativeEvent = searchControlOwnValue(event, "nativeEvent");
      if (
        nativeEvent instanceof ownerWindow.Event &&
        searchControlOwnValue(event, "currentTarget") === trigger &&
        searchControlOwnValue(event, "eventPhase") ===
          ownerWindow.Event.CAPTURING_PHASE
      ) {
        reactCaptureCandidates.set(nativeEvent, event);
      }
    };
    const routeKeyDown = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ): AccountKeyRoute => {
      if (!event || typeof event !== "object") return "block";
      const nativeEvent = searchControlOwnValue(event, "nativeEvent");
      const route = routeProof;
      if (
        !route ||
        nativeEvent !== route.event ||
        searchControlOwnValue(event, "currentTarget") !== trigger
      ) {
        return "block";
      }
      if (!route.direction) {
        const exact = reactEventMatches(
          event,
          route,
          ownerWindow.Event.BUBBLING_PHASE,
          false,
        );
        routeProof = null;
        return exact ? "radix" : "block";
      }
      const proof = nativeProof;
      const isNewWrapper = event !== proof?.reactCaptureEvent;
      if (
        !proof ||
        proof.event !== nativeEvent ||
        !proof.boundary ||
        proof.reactBubbleEvent ||
        (isNewWrapper &&
          (cells.claimedReactEvents.has(event) ||
            cells.attemptedReactEvents.has(event)))
      ) {
        return "block";
      }
      if (isNewWrapper) cells.attemptedReactEvents.add(event);
      if (
        TRUSTED_OBJECT_GET_PROTOTYPE_OF(event) !== proof.reactPrototype ||
        !reactEventMatches(
          event,
          proof,
          isNewWrapper
            ? ownerWindow.Event.BUBBLING_PHASE
            : ownerWindow.Event.CAPTURING_PHASE,
          true,
        ) ||
        !nativeStillMatches(proof) ||
        !publicationOwnsCurrentDom()
      ) {
        return "block";
      }
      proof.reactBubbleEvent = event;
      return "block";
    };

    const runtime: AccountPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        refs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish the Account menu without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        guard = createAccountDomGuard(
          ownerDocument,
          trigger,
          content,
          triggerPlacement,
          contentPlacement,
          () => {
            retire("other");
            requestSuccessor();
          },
        );
        if (
          !guard ||
          cells.active ||
          !exactDomMatches() ||
          !guard.unchanged()
        ) {
          releaseGuard();
          return false;
        }
        cells.active = publication;
        cells.successorOf = null;
        if (!render.open) {
          nativeListening = true;
          keyboard.addEventListener(
            trigger,
            "keydown",
            onNativeCapture,
            true,
          );
          keyboard.addEventListener(trigger, "keydown", onNativeBoundary);
        }
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: AccountElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = refs.find((entry) => entry.owner === owner);
        if (!proof) return;
        if (
          proof.state === "attached" &&
          element === null &&
          previous === proof.element
        ) {
          proof.state = "detached";
        } else if (
          proof.state === "detached" &&
          element === proof.element &&
          previous === null
        ) {
          proof.state = "reattached";
        } else if (element !== previous) {
          proof.state = "invalid";
        }
      },
      isExactReplay: () =>
        retired &&
        established &&
        ((layoutRetired &&
          (retirement === "layout" || retirement === "element")) ||
          (!layoutRetired && retirement === "element")) &&
        refs.length === expectedOwners().length &&
        refs.every(
          (entry) =>
            entry.state === "reattached" &&
            entry.owner.element() === entry.element,
        ) &&
        replayDomMatches() &&
        Boolean(guard?.unchanged()),
      isExactNoRefLayoutReplay: () =>
        retired &&
        established &&
        retirement === "layout" &&
        layoutRetired &&
        publication.render === render &&
        publication.render.authority === render.authority &&
        refs.length === expectedOwners().length &&
        refs.every(
          (entry) =>
            entry.state === "attached" &&
            entry.owner.element() === entry.element,
        ) &&
        intrinsicsAreCurrent() &&
        exactDomMatches() &&
        Boolean(guard?.unchanged()),
      releaseReplayGuard: releaseGuard,
      captureKeyDown,
      routeKeyDown,
      openAutoFocus,
    });
    return runtime;
  };

  const establish = () => {
    if (
      currentRuntime &&
      currentRuntime === lastRuntime &&
      cells.active === currentRuntime.publication &&
      !currentRuntime.publication.isRetired()
    ) {
      return currentRuntime.retireForLayout;
    }
    if (lastRuntime) {
      if (
        !noRefLayoutReplayUsed &&
        lastRuntime.isExactNoRefLayoutReplay() &&
        cells.successorOf === lastRuntime.publication
      ) {
        noRefLayoutReplayUsed = true;
        lastRuntime.releaseReplayGuard();
        const runtime = createRuntime();
        if (!runtime) return;
        currentRuntime = runtime;
        lastRuntime = runtime;
        if (!runtime.publish()) {
          runtime.retireForElement();
          currentRuntime = null;
          return;
        }
        return runtime.retireForLayout;
      }
      if (
        !successorRequested &&
        lastRuntime.isExactReplay() &&
        cells.successorOf === lastRuntime.publication
      ) {
        successorRequested = true;
        requestSuccessor();
      }
      return;
    }
    if (!accountElementsAreExact(render, owners)) return;
    const runtime = createRuntime();
    if (!runtime) return;
    const previous = cells.active;
    previous?.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    if (!runtime.publish()) {
      runtime.retireForElement();
      currentRuntime = null;
      return;
    }
    return runtime.retireForLayout;
  };

  return Object.freeze({
    establish,
    captureTrigger: owners.trigger.capture,
    captureContent: owners.content.capture,
    captureSettings: owners.settings.capture,
    captureSignOut: owners.signOut.capture,
    captureKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      currentRuntime?.captureKeyDown(event),
    routeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
      currentRuntime?.routeKeyDown(event) ?? "block",
    openAutoFocus: (event: Event) => {
      if (!currentRuntime) establish();
      currentRuntime?.openAutoFocus(event);
    },
  });
}

interface AccountMenuTriggerProps
  extends ComponentPropsWithoutRef<"button"> {
  readonly routeAccountKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => AccountKeyRoute;
}

const AccountMenuTrigger = forwardRef<
  HTMLButtonElement,
  AccountMenuTriggerProps
>(function AccountMenuTrigger(
  { onKeyDown, routeAccountKeyDown, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      onKeyDown={(event) => {
        if (routeAccountKeyDown(event) === "radix") onKeyDown?.(event);
      }}
    />
  );
});

const TRASH_RETENTION_DAYS = 30;

/** Star toggle for a document card; hover-visible unless starred. */
function StarButton({ starred, pending, onToggle, className }: { starred: boolean; pending: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      disabled={pending}
      aria-busy={pending || undefined}
      aria-pressed={starred}
      aria-label={starred ? "Unstar" : "Star"}
      title={starred ? "Unstar" : "Star"}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-surface-3 focus-visible:opacity-100",
        starred ? "text-amber-500" : "text-ink-4 opacity-0 group-hover:opacity-100 hover:text-ink-2",
        className,
      )}
      data-testid="star-toggle"
      data-starred={starred}
    >
      <Star size={15} fill={starred ? "currentColor" : "none"} />
    </button>
  );
}

/**
 * Source chip for GitHub-linked documents only; plain Markdoc documents render nothing (#114 — with
 * nothing linked, 52 identical "Markdoc" chips said nothing and wrapped titles early on phone).
 */
function StorageBadge({ doc }: { doc: Doc }) {
  if (doc.storage === "local") return null;
  const detail = doc.storage === "repo" ? `${doc.repoOwner}/${doc.repoName}: ${doc.repoPath}` : `Gist${doc.gistId ? ` ${doc.gistId}` : ""}`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2"
      title={detail}
      data-testid="storage-badge"
      data-storage={doc.storage}
    >
      {doc.storage === "repo" ? <GitBranch size={11} /> : <GitHubIcon size={11} />} GitHub
    </span>
  );
}

export function Dashboard({ user, documents: initialDocuments, githubAvailable, githubConfigured, initialSort = DEFAULT_DASHBOARD_SORT }: DashboardProps) {
  const router = useRouter();
  const [accountMount] = useState(() => Symbol("dashboard-account"));
  const accountAuthority = useMemo<AccountAuthority>(
    () =>
      Object.freeze({
        mount: accountMount,
        visit: Symbol("dashboard-account-user-visit"),
        user,
        userId: user.id,
      }),
    [accountMount, user],
  );
  const [accountState, setAccountState] = useState<AccountMenuState>(() =>
    Object.freeze({
      identity: Symbol("dashboard-account-closed"),
      open: false,
    }),
  );
  const [accountCells] = useState<AccountPublicationCells>(() => ({
    active: null,
    successorOf: null,
    pendingFocus: null,
    delivery: null,
    claimedPublications: new WeakSet(),
    claimedDirections: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedAutoFocusEvents: new WeakSet(),
    attemptedReactEvents: new WeakSet(),
    attemptedNativeEvents: new WeakSet(),
    attemptedAutoFocusEvents: new WeakSet(),
  }));
  const [, setAccountRevision] = useState(0);
  const requestAccountSuccessor = useCallback(() => {
    setAccountRevision((revision) => revision + 1);
  }, []);
  const changeAccountOpen = useCallback((open: boolean) => {
    setAccountState((current) =>
      current.open === open
        ? current
        : Object.freeze({
            identity: Symbol(
              open ? "dashboard-account-open" : "dashboard-account-closed",
            ),
            open,
          }),
    );
  }, []);
  const openAccountSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);
  const signOutAccount = useCallback(() => {
    void signOutSafely();
  }, []);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchResultListRef = useRef<HTMLUListElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  const [openPicker, setOpenPicker] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const filterRef = useRef<Filter>("all");
  const currentFilter = useCallback(() => filterRef.current, []);
  const [filterMount] = useState(() => Symbol("dashboard-filters"));
  const filterAuthority = useMemo<FilterAuthority>(
    () =>
      Object.freeze({
        mount: filterMount,
        visit: Symbol("dashboard-filter-user-visit"),
        user,
        userId: user.id,
      }),
    [filterMount, user],
  );
  const [filterCells] = useState<FilterPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    delivery: null,
    pendingFocus: null,
    claimedPublications: new WeakSet(),
    claimedEntries: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    claimedMovements: new WeakSet(),
    claimedWindowProofs: new WeakSet(),
    claimedFocusRequests: new WeakSet(),
    attemptedReactEvents: new WeakSet(),
    attemptedNativeEvents: new WeakSet(),
  }));
  const [, setFilterRevision] = useState(0);
  const requestFilterSuccessor = useCallback(() => {
    setFilterRevision((revision) => revision + 1);
  }, []);
  const [searchMount] = useState(() => Symbol("dashboard-search"));
  const searchAuthority = useMemo<SearchAuthority>(
    () =>
      Object.freeze({
        mount: searchMount,
        visit: Symbol("dashboard-user-visit"),
        user,
        userId: user.id,
      }),
    [searchMount, user],
  );
  const searchAuthorityRef = useRef<SearchAuthority | null>(null);
  const searchShortcutOwnerRef = useRef<SearchShortcutOwner | null>(null);
  const paletteShortcutOwnerRef = useRef<PaletteShortcutOwner | null>(null);
  const searchDebounceOwner = useRef<SearchDebounceOwner | null>(null);
  const searchRequestOwner = useRef<SearchRequestOwner | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState<SearchDebounceOwner | null>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searchingOwner, setSearchingOwner] = useState<SearchRequestOwner | null>(null);
  const [searchError, setSearchError] = useState<SearchError | null>(null);

  const [noticeMount] = useState(() => Symbol("dashboard-notice"));
  const noticeAuthority = useMemo<NoticeAuthority>(
    () => ({ mount: noticeMount, userId: user.id }),
    [noticeMount, user.id],
  );
  const noticeAuthorityRef = useRef<NoticeAuthority | null>(null);
  const pendingNoticeConsumedRef = useRef<NoticeAuthority | null>(null);
  const noticePublicationRef = useRef<NoticePublication | null>(null);
  const pendingNoticeTimerRef = useRef<NoticePublication | null>(null);
  const [noticePublication, setNoticePublication] = useState<NoticePublication | null>(null);
  const retireNoticeTimer = useCallback((publication: NoticePublication) => {
    if (publication.timer !== null) {
      clearTimeout(publication.timer);
      publication.timer = null;
    }
    if (pendingNoticeTimerRef.current === publication) pendingNoticeTimerRef.current = null;
  }, []);
  const dismissNotice = useCallback(
    (publication: NoticePublication) => {
      if (noticeAuthorityRef.current !== publication.authority || noticePublicationRef.current !== publication) return;
      retireNoticeTimer(publication);
      noticePublicationRef.current = null;
      setNoticePublication((current) => (current === publication ? null : current));
    },
    [retireNoticeTimer],
  );
  const publishNotice = useCallback(
    (notice: PendingNotice) => {
      if (noticeAuthorityRef.current !== noticeAuthority) return null;
      const publication: NoticePublication = { authority: noticeAuthority, notice, timer: null };
      noticePublicationRef.current = publication;
      setNoticePublication(publication);
      return publication;
    },
    [noticeAuthority],
  );

  useLayoutEffect(() => {
    noticeAuthorityRef.current = noticeAuthority;
    if (noticePublicationRef.current?.authority !== noticeAuthority) noticePublicationRef.current = null;
    setNoticePublication((current) => (current?.authority === noticeAuthority ? current : null));
    return () => {
      if (noticeAuthorityRef.current === noticeAuthority) noticeAuthorityRef.current = null;
      const timerOwner = pendingNoticeTimerRef.current;
      if (timerOwner?.authority === noticeAuthority) retireNoticeTimer(timerOwner);
      if (noticePublicationRef.current?.authority === noticeAuthority) noticePublicationRef.current = null;
    };
  }, [noticeAuthority, retireNoticeTimer]);

  // One-shot message from the page we came from (e.g. the editor after "Move to trash").
  useEffect(() => {
    if (noticeAuthorityRef.current !== noticeAuthority || pendingNoticeConsumedRef.current === noticeAuthority) return;
    pendingNoticeConsumedRef.current = noticeAuthority;
    const pending = takePendingNotice();
    if (!pending) return;
    const publication = publishNotice(pending);
    if (!publication) return;
    const timer = setTimeout(() => {
      if (publication.timer !== timer) return;
      publication.timer = null;
      if (pendingNoticeTimerRef.current === publication) pendingNoticeTimerRef.current = null;
      dismissNotice(publication);
    }, 5000);
    publication.timer = timer;
    pendingNoticeTimerRef.current = publication;
    return () => retireNoticeTimer(publication);
  }, [dismissNotice, noticeAuthority, publishNotice, retireNoticeTimer]);
  const currentNotice = noticePublication?.authority === noticeAuthority ? noticePublication : null;

  // The trash is loaded on demand; `initialDocuments` never contains trashed documents.
  const [trash, setTrash] = useState<Doc[] | null>(null);
  const trashRef = useRef<Doc[] | null>(null);
  const [trashBusyOperation, setTrashBusyOperation] = useState<TrashActionOperation | null>(null);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const trashErrorRef = useRef<string | null>(null);
  const trashVisitId = useRef(0);
  const trashRequestId = useRef(0);
  const trashRequestPending = useRef(false);
  const trashAction = useRef<TrashActionOperation | null>(null);
  const trashBusy = trashBusyOperation?.documentId ?? null;
  const replaceTrashError = useCallback((error: string | null) => {
    trashErrorRef.current = error;
    setTrashError(error);
  }, []);

  const replaceTrash = useCallback((documents: Doc[]) => {
    const operation = trashAction.current;
    trashRef.current = documents;
    if (operation && !documents.some((document) => document === operation.document)) {
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
    }
    setTrash(documents);
  }, []);

  const loadTrash = useCallback(() => {
    if (filterRef.current !== "trash" || trashRequestPending.current || trashAction.current) return;
    const visit = trashVisitId.current;
    const requestId = ++trashRequestId.current;
    trashRequestPending.current = true;
    setTrashLoading(true);
    const isCurrent = () => filterRef.current === "trash" && visit === trashVisitId.current && requestId === trashRequestId.current;

    void api.documents
      .list({ trash: true })
      .then((res) => {
        if (!isCurrent()) return;
        replaceTrash(res.documents);
        replaceTrashError(null);
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        console.error(err);
        replaceTrashError(apiErrorText(err, "Could not load trash"));
      })
      .finally(() => {
        if (!isCurrent()) return;
        trashRequestPending.current = false;
        setTrashLoading(false);
      });
  }, [replaceTrash, replaceTrashError]);

  const changeFilter = useCallback((next: Filter) => {
    const previous = filterRef.current;
    const leavingTrash = previous === "trash" && next !== "trash";
    const enteringTrash = previous !== "trash" && next === "trash";
    filterRef.current = next;
    if (enteringTrash) trashVisitId.current += 1;
    if (leavingTrash) {
      trashRequestId.current += 1;
      trashRequestPending.current = false;
      const operation = trashAction.current;
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
      setTrashLoading(false);
      replaceTrashError(null);
    }
    setFilter(next);
  }, [replaceTrashError]);

  useEffect(() => {
    if (filter !== "trash") return;
    loadTrash();
  }, [filter, loadTrash]);

  useLayoutEffect(
    () => () => {
      filterRef.current = "all";
      trashVisitId.current += 1;
      trashRequestId.current += 1;
      trashRequestPending.current = false;
      trashAction.current = null;
      trashRef.current = null;
      trashErrorRef.current = null;
    },
    [],
  );

  const canRetryTrash = useCallback(
    (error: string) =>
      filterRef.current === "trash" &&
      trashErrorRef.current === error &&
      !trashRequestPending.current &&
      trashAction.current === null,
    [],
  );
  const retryTrash = useCallback(() => {
    const error = trashErrorRef.current;
    if (error === null || !canRetryTrash(error)) return;
    loadTrash();
  }, [canRetryTrash, loadTrash]);

  const canRunTrashAction = useCallback(
    (doc: Doc) =>
      filterRef.current === "trash" &&
      trashAction.current === null &&
      trashRef.current?.some((document) => document === doc) === true,
    [],
  );
  const runTrashAction = useCallback(async (doc: Doc, kind: TrashActionKind) => {
    if (!canRunTrashAction(doc)) return;
    const operation: TrashActionOperation = { visit: trashVisitId.current, documentId: doc.id, kind, document: doc };
    trashAction.current = operation;
    trashRequestId.current += 1;
    trashRequestPending.current = false;
    setTrashLoading(false);
    setTrashBusyOperation(operation);
    const isCurrent = () =>
      filterRef.current === "trash" &&
      operation.visit === trashVisitId.current &&
      trashAction.current === operation &&
      trashRef.current?.some((document) => document === operation.document);

    try {
      if (kind === "restore") await api.documents.restore(doc.id);
      else await api.documents.delete(doc.id, { permanent: true });
      if (!isCurrent()) return;
      const documents = trashRef.current!.filter((document) => document.id !== operation.documentId);
      trashRef.current = documents;
      setTrash(documents);
      if (kind === "restore") {
        publishNotice({ message: `“${doc.title}” was restored.`, kind: "success" });
        router.refresh();
      }
    } catch (err) {
      if (!isCurrent()) return;
      console.error(err);
      publishNotice({
        message: apiErrorText(err, kind === "restore" ? "Could not restore the document" : "Could not delete the document"),
        kind: "error",
      });
    } finally {
      if (trashAction.current !== operation) return;
      trashAction.current = null;
      setTrashBusyOperation((current) => (current === operation ? null : current));
    }
  }, [canRunTrashAction, publishNotice, router]);
  const restore = useCallback((doc: Doc) => void runTrashAction(doc, "restore"), [runTrashAction]);
  const purge = useCallback(
    (doc: Doc) => {
      if (!canRunTrashAction(doc)) return;
      if (!confirm(`Delete “${doc.title}” forever? This cannot be undone.`)) return;
      void runTrashAction(doc, "purge");
    },
    [canRunTrashAction, runTrashAction],
  );

  // One shared state per id keeps duplicate cards in lockstep and synchronously rejects overlapping writes.
  const [starStates, setStarStates] = useState<Record<string, { confirmed: boolean; value: boolean; pending: boolean }>>({});
  const starStatesRef = useRef(starStates);
  const starRequests = useRef(new Map<string, number>());
  const starRequestId = useRef(0);
  const starPropsRef = useRef(initialDocuments);
  const updateStarState = useCallback((id: string, state: { confirmed: boolean; value: boolean; pending: boolean }) => {
    const next = { ...starStatesRef.current, [id]: state };
    starStatesRef.current = next;
    setStarStates(next);
  }, []);
  /**
   * Folders a document has been moved to in this session, by document id. The page is server-rendered
   * with its documents, so a move has to show immediately here — the same shape `starStates` uses for
   * stars. Cleared when the server sends a fresh list (#2377).
   */
  const [folderOverrides, setFolderOverrides] = useState<Record<string, string | null>>({});
  const folderPropsRef = useRef(initialDocuments);
  useEffect(() => {
    if (folderPropsRef.current === initialDocuments) return;
    folderPropsRef.current = initialDocuments;
    setFolderOverrides({});
  }, [initialDocuments]);

  const documents = useMemo(
    () =>
      initialDocuments.map((d) => {
        const starred = starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d;
        return d.id in folderOverrides ? { ...starred, folderId: folderOverrides[d.id] } : starred;
      }),
    [initialDocuments, starStates, folderOverrides],
  );
  const toggleStar = useCallback(
    (doc: Doc) => {
      if (starRequests.current.has(doc.id)) return;
      const current = starStatesRef.current[doc.id];
      const confirmed = current?.confirmed ?? doc.starred;
      const next = !(current?.value ?? doc.starred);
      const request = ++starRequestId.current;
      starRequests.current.set(doc.id, request);
      updateStarState(doc.id, { confirmed, value: next, pending: true });

      const update: Promise<{ starred: boolean }> = next ? api.documents.star(doc.id) : api.documents.unstar(doc.id);
      void update.then(
        ({ starred }) => {
          if (starRequests.current.get(doc.id) !== request) return;
          starRequests.current.delete(doc.id);
          updateStarState(doc.id, { confirmed: starred, value: starred, pending: false });
        },
        (error: unknown) => {
          if (starRequests.current.get(doc.id) !== request) return;
          starRequests.current.delete(doc.id);
          updateStarState(doc.id, { confirmed, value: confirmed, pending: false });
          publishNotice({ message: apiErrorText(error, next ? "Could not star document" : "Could not unstar document"), kind: "error" });
        },
      );
    },
    [publishNotice, updateStarState],
  );

  // Sort is remembered per browser in a cookie the server reads (`initialSort`), so the markup already
  // has the saved order and the select's value. localStorage is the fallback for browsers that stored
  // the sort before the cookie existed: when no cookie is set yet, adopt the stored value and write the
  // cookie so the next load is right from the first paint.
  const [sort, setSort] = useState<DashboardSort>(initialSort);
  useEffect(() => {
    try {
      if (readSortCookie() !== null) return;
      const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (!isDashboardSort(saved)) return;
      writeSortCookie(saved);
      setSort(saved);
    } catch {
      // storage unavailable: keep the server's value
    }
  }, []);
  const changeSort = (next: DashboardSort) => {
    setSort(next);
    try {
      writeSortCookie(next);
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  };

  const trimmed = query.trim();

  const retireSearchDebounce = useCallback((owner: SearchDebounceOwner) => {
    if (owner.timer !== null) {
      clearTimeout(owner.timer);
      owner.timer = null;
    }
    if (searchDebounceOwner.current === owner) searchDebounceOwner.current = null;
  }, []);

  const retireSearchRequest = useCallback((owner: SearchRequestOwner) => {
    if (searchRequestOwner.current !== owner) return;
    searchRequestOwner.current = null;
    owner.controller.abort();
  }, []);

  useLayoutEffect(() => {
    searchAuthorityRef.current = searchAuthority;
    return () => {
      if (searchAuthorityRef.current === searchAuthority) searchAuthorityRef.current = null;
      const debounce = searchDebounceOwner.current;
      if (debounce?.authority === searchAuthority) retireSearchDebounce(debounce);
      const request = searchRequestOwner.current;
      if (request?.authority === searchAuthority) retireSearchRequest(request);
    };
  }, [retireSearchDebounce, retireSearchRequest, searchAuthority]);

  useLayoutEffect(() => {
    const target = window;
    const input = searchRef.current;
    if (!input) return;
    const ownsListener = () =>
      owner.active &&
      owner.target === window &&
      owner.input.isConnected &&
      searchRef.current === owner.input &&
      searchShortcutOwnerRef.current === owner &&
      searchAuthorityRef.current === owner.authority &&
      owner.authority === searchAuthority &&
      owner.authority.user === owner.user &&
      owner.user === user &&
      owner.authority.userId === user.id;
    const owner: SearchShortcutOwner = {
      active: true,
      authority: searchAuthority,
      user,
      target,
      input,
      onKeyDown: (event) => {
        if (!ownsListener() || paletteOpenRef.current || !isSearchShortcut(event)) return;
        event.preventDefault();
        if (!ownsListener() || paletteOpenRef.current) return;
        owner.input.focus();
        if (!ownsListener() || paletteOpenRef.current) return;
        owner.input.select();
      },
    };
    searchShortcutOwnerRef.current = owner;
    target.addEventListener("keydown", owner.onKeyDown);
    return () => {
      owner.active = false;
      if (searchShortcutOwnerRef.current === owner) searchShortcutOwnerRef.current = null;
      owner.target.removeEventListener("keydown", owner.onKeyDown);
    };
  }, [searchAuthority, user]);

  // Query and user changes synchronously retire their exact timer and request before parent layout effects run.
  useLayoutEffect(() => {
    setSearchingOwner((current) => (current?.authority === searchAuthority && current.query === trimmed ? current : null));
    if (searchAuthorityRef.current !== searchAuthority || trimmed.length < MIN_QUERY_LENGTH) return;
    const owner: SearchDebounceOwner = { authority: searchAuthority, query: trimmed, timer: null };
    owner.timer = setTimeout(() => {
      if (searchAuthorityRef.current !== searchAuthority || searchDebounceOwner.current !== owner) return;
      owner.timer = null;
      searchDebounceOwner.current = null;
      setDebouncedSearch(owner);
    }, SEARCH_DEBOUNCE_MS);
    searchDebounceOwner.current = owner;
    return () => {
      retireSearchDebounce(owner);
      const request = searchRequestOwner.current;
      if (request?.authority === searchAuthority && request.query === owner.query) retireSearchRequest(request);
    };
  }, [retireSearchDebounce, retireSearchRequest, searchAuthority, trimmed]);

  const runSearch = useCallback(
    (authority: SearchAuthority, requestedQuery: string) => {
      if (searchAuthorityRef.current !== authority || authority !== searchAuthority || authority.userId !== user.id) return;
      const previous = searchRequestOwner.current;
      if (previous) {
        if (previous.authority === authority && previous.query === requestedQuery) return;
        retireSearchRequest(previous);
      }

      const owner: SearchRequestOwner = { authority, query: requestedQuery, controller: new AbortController() };
      searchRequestOwner.current = owner;
      setSearchingOwner(owner);
      const ownsRequest = () =>
        searchAuthorityRef.current === authority &&
        searchRequestOwner.current === owner &&
        !owner.controller.signal.aborted;

      void api.documents
        .search(requestedQuery, { signal: owner.controller.signal })
        .then((res) => {
          if (!ownsRequest()) return;
          setResults({ authority, query: res.query, documents: res.documents });
          setSearchError(null);
        })
        .catch((err: unknown) => {
          if (!ownsRequest()) return;
          console.error(err);
          setSearchError({ authority, query: requestedQuery, message: apiErrorText(err, "Could not search document content") });
        })
        .finally(() => {
          if (!ownsRequest()) return;
          searchRequestOwner.current = null;
          setSearchingOwner((current) => (current === owner ? null : current));
        });

      return () => retireSearchRequest(owner);
    },
    [retireSearchRequest, searchAuthority, user.id],
  );

  useEffect(() => {
    if (debouncedSearch?.authority !== searchAuthority || debouncedSearch.query !== trimmed) return;
    return runSearch(debouncedSearch.authority, debouncedSearch.query);
  }, [debouncedSearch, runSearch, searchAuthority, trimmed]);

  useEffect(() => {
    setSearchError((current) => (current?.authority === searchAuthority && current.query === trimmed ? current : null));
  }, [searchAuthority, trimmed]);

  const searching =
    searchingOwner?.authority === searchAuthority &&
    searchingOwner.query === trimmed;
  const currentSearchError = searchError?.authority === searchAuthority && searchError.query === trimmed ? searchError : null;
  // runSearch sets searchRequestOwner synchronously, so a second click before the re-render sends nothing.
  const retrySearch = useCallback(() => {
    if (!currentSearchError || searchRequestOwner.current) return;
    runSearch(searchAuthority, currentSearchError.query);
  }, [currentSearchError, runSearch, searchAuthority]);

  // Server results for the current query win; otherwise filter the loaded list by title so typing
  // feels instant while the request is in flight (or for queries too short to send).
  const serverResults =
    !currentSearchError &&
    results?.authority === searchAuthority &&
    trimmed.length >= MIN_QUERY_LENGTH &&
    results.query === trimmed
      ? results.documents
      : null;
  const pending =
    trimmed.length >= MIN_QUERY_LENGTH &&
    !serverResults &&
    (searching || debouncedSearch?.authority !== searchAuthority || debouncedSearch.query !== trimmed);
  useEffect(() => {
    if (starPropsRef.current !== initialDocuments) {
      starPropsRef.current = initialDocuments;
      starRequests.current.clear();
      starStatesRef.current = {};
      setStarStates({});
      return;
    }

    const currentIds = new Set(initialDocuments.map((doc) => doc.id));
    for (const doc of serverResults ?? []) currentIds.add(doc.id);
    const removed = Object.keys(starStatesRef.current).filter((id) => !currentIds.has(id));
    if (removed.length === 0) return;
    const next = { ...starStatesRef.current };
    for (const id of removed) {
      starRequests.current.delete(id);
      delete next[id];
    }
    starStatesRef.current = next;
    setStarStates(next);
  }, [initialDocuments, serverResults]);
  useEffect(
    () => () => {
      starRequests.current.clear();
    },
    [],
  );
  const noticeFromFolders = useCallback(
    (message: string, kind: "error" | "info" = "info") => void publishNotice({ message, kind }),
    [publishNotice],
  );
  const folders = useFolders(noticeFromFolders);
  const folderSelection: FolderSelection = folders.selection;
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [moving, setMoving] = useState(false);

  // Only a document the person owns can be filed: a folder belongs to one person, so there is nowhere
  // to put a document shared with them.
  const canFile = useCallback((doc: Doc) => doc.ownerId === user.id, [user.id]);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      if (filter === "starred" && !d.starred) return false;
      // A folder selection narrows the list the same way a chip does. "All documents" (`null`) keeps
      // everything; `TOP_LEVEL` keeps what is not filed, which includes documents shared with this
      // person — their `folderId` is always null, since the folder would be someone else's (#2377).
      if (folderSelection === TOP_LEVEL && d.folderId !== null) return false;
      if (typeof folderSelection === "string" && d.folderId !== folderSelection) return false;
      return true;
    };
    // Search results keep their relevance order (title matches first); the sort applies to the browsing list.
    if (serverResults) return serverResults.map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d)).filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q))).sort(compareDocs(sort));
  }, [documents, serverResults, trimmed, filter, sort, user.id, starStates, folderSelection]);

  const starred = useMemo(() => documents.filter((d) => d.starred).sort(compareDocs(sort)), [documents, sort]);
  const showStrip = filter === "all" && !trimmed && starred.length > 0;

  /**
   * File documents under a folder (or back to the top level for `null`). The server answers with the
   * ids it actually moved, so a document that was trashed or un-owned in between is simply left alone
   * rather than shown in the wrong place.
   */
  const moveDocuments = useCallback(
    async (documentIds: readonly string[], folderId: string | null) => {
      if (documentIds.length === 0 || moving) return;
      setMoving(true);
      try {
        const { moved } = await api.documents.move(documentIds, folderId);
        setFolderOverrides((current) => {
          const next = { ...current };
          for (const id of moved) next[id] = folderId;
          return next;
        });
        clearSelection();
        // The chip counts live on the server; refresh them rather than guessing the arithmetic.
        void folders.refresh();
        const where = folderId ? (folders.folders.find((f) => f.id === folderId)?.name ?? "the folder") : "Not in a folder";
        if (moved.length > 0) {
          publishNotice({ message: `Moved ${moved.length} document${moved.length === 1 ? "" : "s"} to ${where}`, kind: "info" });
        }
      } catch (err) {
        publishNotice({ message: apiErrorText(err, "Could not move the document"), kind: "error" });
      } finally {
        setMoving(false);
      }
    },
    [moving, clearSelection, folders, publishNotice],
  );

  const createOwner = useRef(user.id);
  const createOperation = useRef<CreateOperation | null>(null);
  const [createBusyOperation, setCreateBusyOperation] = useState<CreateOperation | null>(null);
  const creating = createBusyOperation?.ownerId === user.id ? createBusyOperation.key : null;
  const [openTemplates, setOpenTemplates] = useState(false);

  useLayoutEffect(() => {
    const previousOwner = createOwner.current;
    createOwner.current = user.id;
    if (previousOwner === user.id) return;
    const operation = createOperation.current;
    createOperation.current = null;
    setCreateBusyOperation((current) => (current === operation ? null : current));
  }, [user.id]);

  useLayoutEffect(
    () => () => {
      createOperation.current = null;
    },
    [],
  );

  const create = useCallback(
    async (template?: Template) => {
      if (createOperation.current || createOwner.current !== user.id) return;
      const key = template?.id ?? "blank";
      const operation: CreateOperation = { ownerId: user.id, key };
      createOperation.current = operation;
      setCreateBusyOperation(operation);
      const isCurrent = () => createOwner.current === user.id && createOperation.current === operation;
      try {
        const res = await api.documents.create(template ? { template: template.id } : {});
        if (!isCurrent()) return;
        // Stay busy after a success: router.push() returns before the document page replaces the
        // dashboard, and a second click in that gap would create a second document. Unmount clears it.
        router.push(`/d/${res.document.id}`);
      } catch (err) {
        if (!isCurrent()) return;
        createOperation.current = null;
        setCreateBusyOperation((current) => (current === operation ? null : current));
        console.error(err);
        publishNotice({ message: apiErrorText(err, "Could not create the document"), kind: "error" });
      }
    },
    [publishNotice, router, user.id],
  );

  // Command palette (Mod-Shift-P, or Mod-K outside the search box), scoped to dashboard actions.
  // Local files dropped on the page or picked with "Open file…": one file opens straight away,
  // several stay listed in the dialog while the list behind it refreshes — as does a batch with a
  // failure in it, so the failed file stays visible.
  const fileImport = useFileImport({
    onDone: (created, failed) => {
      if (created.length === 1 && failed.length === 0) router.push(`/d/${created[0].id}`);
      else if (created.length > 0) router.refresh();
    },
    onError: (message) => publishNotice({ message, kind: "error" }),
  });
  const pickFile = fileImport.pick;
  useLayoutEffect(() => {
    paletteOpenRef.current = paletteOpen;
    const owner = paletteShortcutOwnerRef.current;
    if (
      owner?.active &&
      owner.authority === searchAuthority &&
      owner.user === user &&
      searchAuthorityRef.current === searchAuthority
    ) {
      owner.open = paletteOpen;
    }
  }, [paletteOpen, searchAuthority, user]);
  useLayoutEffect(() => {
    const target = window;
    const ownsListener = () =>
      owner.active &&
      owner.target === window &&
      paletteShortcutOwnerRef.current === owner &&
      searchAuthorityRef.current === owner.authority &&
      owner.authority === searchAuthority &&
      owner.authority.user === owner.user &&
      owner.user === user &&
      owner.authority.userId === user.id;
    const owner: PaletteShortcutOwner = {
      active: true,
      open: paletteOpenRef.current,
      authority: searchAuthority,
      user,
      target,
      onKeyDown: (event) => {
        if (!ownsListener() || owner.open || paletteOpenRef.current || !isPaletteShortcut(event)) return;
        owner.open = true;
        paletteOpenRef.current = true;
        event.preventDefault();
        if (!ownsListener() || !owner.open || !paletteOpenRef.current) return;
        event.stopPropagation();
        if (!ownsListener() || !owner.open || !paletteOpenRef.current) return;
        setPaletteOpen(true);
      },
    };
    paletteShortcutOwnerRef.current = owner;
    target.addEventListener("keydown", owner.onKeyDown, true);
    return () => {
      owner.active = false;
      if (paletteShortcutOwnerRef.current === owner) paletteShortcutOwnerRef.current = null;
      owner.target.removeEventListener("keydown", owner.onKeyDown, true);
    };
  }, [searchAuthority, user]);
  const listDocs = useCallback(async (qs: string) => {
    const res = await fetch(`/api/documents${qs}`);
    if (!res.ok) throw new Error(`Could not load documents (${res.status})`);
    const data = (await res.json()) as { documents: { id: string; title: string }[] };
    return data.documents.map((d) => ({ id: d.id, title: d.title }));
  }, []);
  const paletteCommands = useCallback(
    () =>
      buildDashboardCommands({
        createDocument: (templateId) => void create(templateId ? TEMPLATES.find((t) => t.id === templateId) : undefined),
        templates: async () => {
          const res = await fetch("/api/templates");
          if (!res.ok) throw new Error(`Could not load templates (${res.status})`);
          const data = (await res.json()) as { templates: { id: string; name: string; description: string }[] };
          return data.templates;
        },
        recentDocuments: () => listDocs("?limit=8"),
        starredDocuments: () => listDocs("?starred=1"),
        showTrash: () => changeFilter("trash"),
        openFile: pickFile,
        navigate: (href) => router.push(href),
        signOut: () => void signOutSafely(),
      }),
    [create, listDocs, router, pickFile, changeFilter],
  );
  const changeSearch = (event: ReactChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };
  const clearSearch = () => {
    setQuery("");
    searchRef.current?.focus();
  };
  // Escape clears the box, then leaves it. ArrowDown/ArrowUp move from the box to the first/last search result.
  const keyDownSearch = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.repeat || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else event.currentTarget.blur();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !trimmed) return;
    const links = Array.from(searchResultListRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-testid="document-card"]') ?? []);
    const destination = event.key === "ArrowDown" ? links[0] : links.at(-1);
    if (!destination) return;
    event.preventDefault();
    destination.focus({ preventScroll: true });
  };
  const showCreateEmptyState =
    filter !== "trash" &&
    filtered.length === 0 &&
    !trimmed &&
    documents.length === 0;
  const welcomeTemplate = getTemplate(WELCOME_TEMPLATE_ID);
  // The factory stores these callbacks for committed event delivery; it never reads a ref or invokes a callback during render.
  // eslint-disable-next-line react-hooks/refs
  const filterRender: FilterRenderPublication = Object.freeze({
    identity: Symbol("dashboard-filter-render"),
    mount: filterMount,
    authority: filterAuthority,
    user,
    userId: user.id,
    definitions: FILTERS,
    filter,
    currentFilter,
    changeFilter,
  });
  const {
    establish: establishFilters,
    captureGroup: captureFilterGroup,
    captureButtons: captureFilterButtons,
    captureGroupKeyDown: captureFilterGroupKeyDown,
    captureButtonKeyDown,
    keyDownButton,
  } = createFilterPublication(
    filterRender,
    filterCells,
    requestFilterSuccessor,
  );
  useLayoutEffect(
    () => establishFilters(),
    [establishFilters],
  );
  const accountRender: AccountRenderPublication = Object.freeze({
    identity: Symbol("dashboard-account-render"),
    authority: accountAuthority,
    user,
    userId: user.id,
    router,
    routerPush: router.push,
    openSettings: openAccountSettings,
    signOut: signOutAccount,
    state: accountState,
    open: accountState.open,
    setState: setAccountState,
    changeOpen: changeAccountOpen,
  });
  const {
    establish: establishAccount,
    captureTrigger: captureAccountTrigger,
    captureContent: captureAccountContent,
    captureSettings: captureAccountSettings,
    captureSignOut: captureAccountSignOut,
    captureKeyDown: captureAccountKeyDown,
    routeKeyDown: routeAccountKeyDown,
    openAutoFocus: openAccountAutoFocus,
  } = createAccountPublication(
    accountRender,
    accountCells,
    requestAccountSuccessor,
  );
  const accountOpenAutoFocusProps = {
    onOpenAutoFocus: openAccountAutoFocus,
  };
  useLayoutEffect(
    () => establishAccount(),
    [establishAccount],
  );

  return (
    <TooltipProvider>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={paletteCommands} groupOrder={DASHBOARD_GROUPS} />
      <ImportDropzone active={fileImport.dragging} />
      {fileImport.input}
      <ImportDialog open={fileImport.open} onOpenChange={fileImport.setOpen} items={fileImport.items} ignored={fileImport.ignored} />
      <main className="min-h-screen bg-surface-2">
        <header className="app-header sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
          <div className="safe-x mx-auto flex h-16 max-w-6xl items-center gap-3 sm:gap-4 sm:[--safe-pad:1.5rem]">
            <Link href="/" className="flex items-center gap-2.5" aria-label="Markdoc — all documents">
              <Logo className="h-8 w-8" />
              <span className="wordmark hidden text-lg font-semibold text-ink sm:inline">Markdoc</span>
            </Link>
            <div className="relative mx-auto w-full max-w-xl">
              <Search size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input
                ref={searchRef}
                className={cn("input pl-9", query && searching ? "pr-16" : query ? "pr-9" : "pr-9 sm:pr-12")}
                placeholder="Search documents"
                aria-label="Search documents"
                value={query}
                onChange={changeSearch}
                onKeyDown={keyDownSearch}
                data-testid="search"
              />
              {!query && (
                <span className="pointer-events-none absolute right-3 top-2 hidden text-ink-4 sm:block" aria-hidden="true">
                  <Kbd>/</Kbd>
                </span>
              )}
              {searching && <Loader2 size={16} className={cn("pointer-events-none absolute top-2.5 animate-spin text-ink-4", query ? "right-9" : "right-3")} data-testid="search-loading" />}
              {query && (
                <button
                  type="button"
                  className="absolute right-0 top-0 inline-flex h-9 w-9 items-center justify-center text-ink-3 transition-colors hover:text-ink max-sm:-right-1 max-sm:-top-1 max-sm:h-11 max-sm:w-11"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  data-testid="search-clear"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <ThemeToggle className="shrink-0" />
            <Menu open={accountState.open} onOpenChange={changeAccountOpen}>
              <MenuTrigger asChild>
                <AccountMenuTrigger
                  ref={captureAccountTrigger}
                  type="button"
                  className="rounded-full"
                  aria-label="Account"
                  onKeyDownCapture={captureAccountKeyDown}
                  routeAccountKeyDown={routeAccountKeyDown}
                >
                  <Avatar name={user.name} src={user.image} size={36} />
                </AccountMenuTrigger>
              </MenuTrigger>
              <MenuContent
                ref={captureAccountContent}
                align="end"
                className="w-56"
                {...accountOpenAutoFocusProps}
              >
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-medium text-ink" title={user.name}>{user.name}</div>
                  {user.login && <div className="truncate text-xs text-ink-3" title={`@${user.login}`}>@{user.login}</div>}
                </div>
                <MenuItem ref={captureAccountSettings} icon={<Bot size={15} />} onSelect={openAccountSettings}>
                  Agents &amp; API tokens
                </MenuItem>
                <MenuItem ref={captureAccountSignOut} icon={<LogOut size={15} />} onSelect={signOutAccount}>
                  Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>

        <section className="safe-x mx-auto max-w-6xl py-6 sm:py-8 sm:[--safe-pad:1.5rem]">
          <NotificationsStrip />
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <div className={CREATE_CARD_CLASS}>
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating !== null}
                className={CREATE_BLANK_BUTTON_CLASS}
                data-testid="new-document"
              >
                <span className={CREATE_BLANK_ICON_FRAME_CLASS}>{creating === CREATE_BLANK_KEY ? <Loader2 className="animate-spin" /> : <FilePlus2 size={22} />}</span>
                <span>
                  <span className={CREATE_BLANK_NAME_CLASS}>{CREATE_BLANK_NAME_TEXT}</span>
                  <span className={CREATE_BLANK_DESCRIPTION_CLASS}>{CREATE_BLANK_DESCRIPTION_TEXT}</span>
                </span>
              </button>
              <Dialog open={openTemplates} onOpenChange={(open) => !creating && setOpenTemplates(open)}>
                <DialogTrigger asChild>
                  <button
                    type="button"
                    disabled={creating !== null}
                    className="flex items-center gap-1 border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                    aria-label="New document from template"
                    title="From template"
                    data-testid="new-from-template"
                  >
                    <LayoutTemplate size={16} />
                    <ChevronDown size={14} />
                  </button>
                </DialogTrigger>
                <DialogContent title="New from template" description="Pick a starting point. Everything is plain Markdown you can change afterwards." wide>
                  <div data-testid="template-dialog">
                    <TemplateGrid onPick={(t) => void create(t)} busy={creating} />
                  </div>
                </DialogContent>
              </Dialog>
              <button
                type="button"
                onClick={fileImport.pick}
                disabled={creating !== null}
                className="flex items-center gap-1 rounded-r-2xl border-l border-line px-4 text-ink-3 transition hover:bg-surface-2 hover:text-ink"
                aria-label="Open file…"
                title="Open file… (.md, .txt, .html)"
                data-testid="open-file"
              >
                <FolderOpen size={16} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setOpenPicker(true)}
              disabled={!githubConfigured}
              title={githubConfigured ? undefined : GITHUB_NOT_CONFIGURED}
              className="group flex items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition hover:border-accent hover:shadow-md disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:shadow-sm"
              data-testid="open-github"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-inverse text-white">
                <GitHubIcon size={22} />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">Open from GitHub</span>
                <span className="block text-sm text-ink-3">{githubConfigured ? "Edit a Markdown file from a gist or repository." : GITHUB_NOT_CONFIGURED}</span>
              </span>
            </button>
          </div>

          {showStrip && (
            <div className="mb-6" data-testid="starred-strip">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Star size={14} className="text-amber-500" fill="currentColor" /> Starred
                </h2>
                {starred.length > STARRED_STRIP_MAX && (
                  // ≥ 44 px hit area on phone, ≥ 24 px on desktop (WCAG 2.2 target size, #116); negative
                  // margins pull the padding back so the strip header barely moves.
                  <button
                    type="button"
                    className="-my-2 ml-auto inline-flex min-h-11 items-center px-3 py-2 text-xs font-medium text-accent hover:underline md:-my-0.5 md:min-h-6 md:px-2 md:py-1"
                    onClick={() => changeFilter("starred")}
                    data-testid="show-all-starred"
                  >
                    Show all starred ({starred.length})
                  </button>
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {starred.slice(0, STARRED_STRIP_MAX).map((d) => (
                  <li key={d.id} className="group relative min-w-0">
                    <Link
                      href={`/d/${d.id}`}
                      className="flex h-full flex-col gap-1 rounded-xl border border-line bg-surface px-3 py-2.5 pr-9 shadow-sm transition hover:border-accent hover:shadow-md"
                      data-testid="starred-card"
                    >
                      <span className="line-clamp-2 break-words text-[13px] font-semibold leading-4 text-ink">{d.title}</span>
                      <span className="text-[11px] text-ink-4">{d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                    </Link>
                    <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute right-1.5 top-1.5" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Folders organize what a person owns, so the rail is out of the way in the trash and while
              searching, where the list is not a folder's contents. */}
          {filter !== "trash" && !trimmed && (
            <FolderRail
              state={folders}
              totalCount={documents.length}
              unfiledCount={documents.filter((d) => canFile(d) && d.folderId === null).length}
              onDropDocuments={moveDocuments}
            />
          )}

          {selectedIds.size > 0 && filter !== "trash" && (
            <SelectionBar
              count={selectedIds.size}
              folders={folders.folders}
              busy={moving}
              onClear={clearSelection}
              onMove={(folderId) => void moveDocuments([...selectedIds], folderId)}
            />
          )}

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Documents</h2>
            <div className="ml-auto flex min-h-8 max-w-full items-center gap-2 overflow-x-auto max-sm:basis-full" data-testid="dashboard-chips">
              <label className="flex items-center gap-1.5 text-xs text-ink-3">
                <span className="sr-only">Sort by</span>
                <select
                  className="h-7 rounded-lg border border-line bg-surface px-2 text-xs text-ink-2 outline-none focus-visible:border-accent"
                  value={sort}
                  onChange={(e) => changeSort(e.target.value as DashboardSort)}
                  aria-label="Sort by"
                  data-testid="sort-select"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <div
                ref={captureFilterGroup}
                className={FILTER_GROUP_CLASS}
                role="toolbar"
                aria-label={FILTER_GROUP_LABEL}
                onKeyDownCapture={captureFilterGroupKeyDown}
              >
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    ref={captureFilterButtons.get(f.value)}
                    type="button"
                    className={filterButtonClass(filter === f.value)}
                    onClick={() => changeFilter(f.value)}
                    onKeyDownCapture={(event) =>
                      captureButtonKeyDown(f.value, event)
                    }
                    onKeyDown={(event) => keyDownButton(f.value, event)}
                    tabIndex={filter === f.value ? 0 : -1}
                    aria-pressed={filter === f.value}
                    data-testid={`filter-${f.value}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {currentSearchError && (
            <div
              className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
              role="alert"
              aria-atomic="true"
              data-testid="search-error"
            >
              <span className="min-w-0 flex-1 wrap-anywhere">
                Content search failed: {currentSearchError.message}. Showing title matches only.
              </span>
              <button
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClick={retrySearch}
                disabled={searching}
                aria-busy={searching || undefined}
              >
                {searching ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}

          {filter === "trash" ? (
            <TrashView
              documents={trash}
              busy={trashBusy}
              loading={trashLoading}
              error={trashError}
              canRetry={canRetryTrash}
              canAct={canRunTrashAction}
              onRetry={retryTrash}
              onRestore={restore}
              onPurge={purge}
            />
          ) : showCreateEmptyState ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-8" data-testid="empty-state">
              <div className={CREATE_GUIDED_ROOT_CLASS}>
                <FileText className="mx-auto mb-3 text-ink-4" size={28} />
                <p className={CREATE_GUIDED_PRIMARY_CLASS}>{CREATE_GUIDED_PRIMARY_TEXT}</p>
                <p className={CREATE_GUIDED_SECONDARY_CLASS}>{CREATE_GUIDED_SECONDARY_TEXT}</p>
                <button
                  type="button"
                  className={CREATE_WELCOME_BUTTON_CLASS}
                  onClick={() => void create(welcomeTemplate)}
                  disabled={creating !== null}
                  aria-busy={creating === WELCOME_TEMPLATE_ID || undefined}
                  data-testid="start-guided-doc"
                >
                  {creating === WELCOME_TEMPLATE_ID ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Start with a guided doc
                </button>
              </div>
              <TemplateGrid compact onPick={(t) => void create(t)} busy={creating} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
              <FileText className="mx-auto mb-3 text-ink-4" size={28} />
              <p className="text-sm font-medium text-ink-2">
                {pending ? `Searching for "${trimmed}"…` : currentSearchError ? `No title matches for "${trimmed}"` : trimmed ? `No matches for "${trimmed}"` : filter === "starred" ? "No starred documents" : "No matches"}
              </p>
              <p className="mt-1 text-sm text-ink-3">
                {pending ? "Looking through titles and content." : currentSearchError ? "Content results are unavailable. Retry the search above." : filter === "starred" && !trimmed ? "Hover a document and click the star to keep it close." : "Try a different search."}
              </p>
              {trimmed && !pending && (
                <button
                  type="button"
                  className="mt-3 text-sm font-medium text-accent hover:underline"
                  onClick={clearSearch}
                  data-testid="empty-state-clear-search"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <ul ref={searchResultListRef} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="document-list">
              {filtered.map((d) => (
                <li
                  key={d.id}
                  className="group relative min-w-0"
                  data-testid={trimmed ? "search-result" : undefined}
                  // Dragging a selected card takes the whole selection; dragging an unselected one takes
                  // just it, so a drag never silently moves documents the person forgot were ticked.
                  draggable={canFile(d)}
                  onDragStart={(event) => {
                    if (!canFile(d)) return;
                    const ids = selectedIds.has(d.id) ? [...selectedIds] : [d.id];
                    event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, JSON.stringify(ids));
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  data-selected={selectedIds.has(d.id) || undefined}
                >
                  <Link
                    href={`/d/${d.id}`}
                    className={cn(
                      "flex h-full flex-col rounded-2xl border bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md",
                      selectedIds.has(d.id) ? "border-accent ring-1 ring-accent" : "border-line",
                    )}
                    data-testid="document-card"
                  >
                    {/* `pr-8` on an own-document card keeps the storage badge clear of the ⋮ menu. */}
                    <div className={cn("mb-2 flex items-start justify-between gap-2", canFile(d) && "pr-8")}>
                      <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">
                        <Highlight text={d.title} needle={trimmed} />
                      </h3>
                      <StorageBadge doc={d} />
                    </div>
                    {d.snippet ? (
                      <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-2" data-testid="search-snippet">
                        <Highlight text={d.snippet} needle={trimmed} />
                      </p>
                    ) : (
                      <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3">{d.excerpt || "Empty document"}</p>
                    )}
                    {/* Room for the star, plus the select box beside it on an own-document card. */}
                    <div className={cn("mt-3 flex items-center gap-2 text-xs text-ink-4", canFile(d) ? "pr-16" : "pr-8")}>
                      <span>{sort === "recent" && d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                      {d.ownerId !== user.id && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {d.ownerName ?? d.ownerLogin} · {d.role}
                        </span>
                      )}
                    </div>
                  </Link>
                  <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute bottom-3 right-3" />
                  {canFile(d) && (
                    <>
                      {/* A real checkbox, so the card is selectable from the keyboard and screen readers
                          read its state. Shown once anything is selected, on hover, or on focus. */}
                      <label
                        className={cn(
                          "absolute bottom-3 right-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-line bg-surface/95 transition",
                          "focus-within:opacity-100 group-hover:opacity-100",
                          selectedIds.has(d.id) ? "border-accent opacity-100" : "opacity-0",
                        )}
                      >
                        <span className="sr-only">Select {d.title}</span>
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-[var(--accent)]"
                          checked={selectedIds.has(d.id)}
                          onChange={() => toggleSelected(d.id)}
                          data-testid="select-document"
                          data-document-id={d.id}
                        />
                      </label>
                      <Menu>
                        <MenuTrigger asChild>
                          <button
                            type="button"
                            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-3 opacity-0 transition hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                            aria-label={`Actions for ${d.title}`}
                            data-testid="document-menu"
                            data-document-id={d.id}
                          >
                            <MoreVertical size={15} />
                          </button>
                        </MenuTrigger>
                        <MenuContent className="w-52">
                          <MoveToItems
                            folders={folders.folders}
                            currentFolderId={d.folderId}
                            onMove={(folderId) => void moveDocuments([d.id], folderId)}
                          />
                        </MenuContent>
                      </Menu>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <Dialog open={openPicker} onOpenChange={setOpenPicker}>
          <DialogContent title="Open from GitHub" description="Pick a Markdown file. Markdoc keeps a live copy and publishes back when you ask it to." wide>
            <GitHubPicker mode="import" githubAvailable={githubAvailable} githubConfigured={githubConfigured} managedAccount={isManagedGithubLogin(user.login)} onImported={(id) => router.push(`/d/${id}`)} />
          </DialogContent>
        </Dialog>

        {currentNotice && (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
            <div
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-white shadow-xl animate-fade-in",
                currentNotice.notice.kind === "error" ? "bg-red-600" : "bg-inverse",
              )}
              role="status"
              data-testid="toast"
              data-kind={currentNotice.notice.kind}
            >
              <span>{currentNotice.notice.message}</span>
              <button type="button" className="text-white/60 hover:text-white" onClick={() => dismissNotice(currentNotice)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}

interface TrashCardPresentation {
  readonly index: number;
  readonly document: Doc;
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly storage: Doc["storage"];
  readonly repoOwner: string | null;
  readonly repoName: string | null;
  readonly repoPath: string | null;
  readonly gistId: string | null;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly busy: boolean;
}

interface TrashRenderPresentation {
  readonly mount: symbol;
  readonly documents: Doc[] | null;
  readonly busy: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retentionDays: number;
  readonly canRetry: (error: string) => boolean;
  readonly canAct: (document: Doc, kind: TrashActionKind) => boolean;
  readonly onRetry: () => void;
  readonly onRestore: (document: Doc) => void;
  readonly onPurge: (document: Doc) => void;
  readonly cards: readonly TrashCardPresentation[];
}

type TrashPublishedActionKind = "retry" | TrashActionKind;

interface TrashActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly kind: TrashPublishedActionKind;
  readonly cardIndex: number | null;
}

interface TrashControlPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: TrashPublishedActionKind;
  readonly cardIndex: number | null;
  readonly element: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly action: TrashActionPublication;
}

interface TrashCardPublication {
  readonly identity: symbol;
  readonly authority: TrashCardPresentation;
  readonly element: HTMLLIElement;
  readonly restore: TrashControlPublication;
  readonly purge: TrashControlPublication;
  readonly actions: readonly TrashControlPublication[];
}

interface TrashDomSnapshot {
  readonly node: Node;
  readonly nodeValue: string | null;
  readonly relativeTimeText: boolean;
  readonly attributes: readonly (readonly [string, string])[] | null;
  readonly children: readonly TrashDomSnapshot[];
}

interface TrashPlacement {
  readonly document: Document;
  readonly parent: Node;
  readonly previousSibling: Node | null;
  readonly nextSibling: Node | null;
}

interface TrashPublication {
  readonly identity: symbol;
  readonly render: TrashRenderPresentation;
  readonly root: HTMLDivElement;
  readonly note: HTMLParagraphElement;
  readonly error: HTMLDivElement | null;
  readonly retry: TrashControlPublication | null;
  readonly loading: HTMLDivElement | null;
  readonly empty: HTMLDivElement | null;
  readonly list: HTMLUListElement | null;
  readonly cards: readonly TrashCardPublication[];
  readonly ownerDocument: Document;
  readonly retire: () => void;
  readonly isRetired: () => boolean;
}

interface TrashElementOwnerView {
  readonly element: () => HTMLElement | null;
}

interface TrashRefReplay {
  readonly owner: TrashElementOwnerView;
  readonly element: HTMLElement;
  detached: boolean;
  reattached: boolean;
}

interface TrashReplay {
  readonly source: TrashPublication;
  readonly dom: TrashDomSnapshot;
  readonly placement: TrashPlacement;
  readonly partialElements: ReadonlySet<HTMLElement>;
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface TrashPublicationCells {
  active: TrashPublication | null;
  successorOf: TrashPublication | null;
  replay: TrashReplay | null;
  readonly retiredPublications: WeakSet<TrashPublication>;
  readonly retiredCards: WeakSet<TrashCardPublication>;
  readonly retiredControls: WeakSet<TrashControlPublication>;
  readonly retiredActions: WeakSet<TrashActionPublication>;
  readonly claimedPublications: WeakSet<TrashPublication>;
  readonly claimedCards: WeakSet<TrashCardPublication>;
  readonly claimedControls: WeakSet<TrashControlPublication>;
  readonly claimedActions: WeakSet<TrashActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
  readonly claimedMovements: WeakSet<TrashKeyboardMovement>;
  readonly claimedWindowProofs: WeakSet<TrashKeyboardWindowProof>;
  readonly evaluatingPublications: WeakSet<TrashPublication>;
}

interface TrashPublicationRuntime {
  readonly publication: TrashPublication;
  readonly publish: (
    dom: TrashDomSnapshot,
    placement: TrashPlacement,
    owners: readonly TrashElementOwnerView[],
    partialReplayElements: ReadonlySet<HTMLElement>,
  ) => void;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: TrashElementOwnerView,
    element: HTMLElement | null,
    previous: HTMLElement | null,
  ) => void;
  readonly isRetired: () => boolean;
  readonly publishedDomMatches: () => boolean;
  readonly isExactElementReplay: () => boolean;
  readonly isExactLayoutReplay: () => boolean;
  readonly replayDomUnchanged: () => boolean;
  readonly releaseReplayGuard: () => void;
  readonly snapshot: () => TrashDomSnapshot | null;
  readonly placement: () => TrashPlacement | null;
  readonly partialReplayElements: () => ReadonlySet<HTMLElement>;
  readonly captureCardKeyDown: (
    card: TrashCardPresentation,
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => void;
  readonly bubbleCardKeyDown: (
    card: TrashCardPresentation,
    event: ReactKeyboardEvent<HTMLLIElement>,
  ) => void;
}

interface TrashPublicationSet {
  readonly captureRoot: (element: HTMLDivElement | null) => void;
  readonly captureNote: (element: HTMLParagraphElement | null) => void;
  readonly captureError: (element: HTMLDivElement | null) => void;
  readonly captureRetry: (element: HTMLButtonElement | null) => void;
  readonly captureLoading: (element: HTMLDivElement | null) => void;
  readonly captureEmpty: (element: HTMLDivElement | null) => void;
  readonly captureList: (element: HTMLUListElement | null) => void;
  readonly cards: readonly {
    readonly authority: TrashCardPresentation;
    readonly captureCard: (element: HTMLLIElement | null) => void;
    readonly captureRestore: (element: HTMLButtonElement | null) => void;
    readonly capturePurge: (element: HTMLButtonElement | null) => void;
    readonly captureKeyDown: (
      event: ReactKeyboardEvent<HTMLLIElement>,
    ) => void;
    readonly bubbleKeyDown: (
      event: ReactKeyboardEvent<HTMLLIElement>,
    ) => void;
  }[];
  readonly establish: () => void | (() => void);
}

type TrashNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

interface TrashPropertyAuthority<T> {
  readonly read: (value: object) => T;
  readonly isCurrent: () => boolean;
}

interface TrashMethodAuthority<Args extends readonly unknown[], Result> {
  readonly value: (...args: Args) => Result;
  readonly call: (receiver: object, ...args: Args) => Result;
  readonly isCurrent: () => boolean;
}

interface TrashWindowMethodAuthority<Method> {
  readonly value: Method;
  readonly isCurrent: () => boolean;
}

interface TrashKeyboardWindowProof {
  readonly registration: TrashKeyboardWindowRegistration;
  readonly nativeEvent: KeyboardEvent;
  readonly receiver: EventTarget;
  readonly currentTarget: EventTarget;
  readonly terminal: EventTarget;
  readonly path: readonly EventTarget[];
}

interface TrashKeyboardWindowRegistration {
  readonly proofFor: (
    event: KeyboardEvent,
  ) => TrashKeyboardWindowProof | null;
  readonly claim: (proof: TrashKeyboardWindowProof) => boolean;
  readonly release: () => void;
  readonly isCurrent: () => boolean;
}

interface TrashKeyboardAuthority {
  readonly ownerWindow: Window & typeof globalThis;
  readonly Event: typeof Event;
  readonly KeyboardEvent: typeof KeyboardEvent;
  readonly HTMLElement: typeof HTMLElement;
  readonly keyboardPrototype: object;
  readonly prototypeOf: typeof Object.getPrototypeOf;
  readonly apply: typeof Reflect.apply;
  readonly trusted: FilterTrustedAuthority;
  readonly activeElement: FilterActiveElementAuthority;
  readonly type: TrashPropertyAuthority<string>;
  readonly target: TrashPropertyAuthority<EventTarget | null>;
  readonly currentTarget: TrashPropertyAuthority<EventTarget | null>;
  readonly phase: TrashPropertyAuthority<number>;
  readonly bubbles: TrashPropertyAuthority<boolean>;
  readonly cancelable: TrashPropertyAuthority<boolean>;
  readonly composed: TrashPropertyAuthority<boolean>;
  readonly defaultPrevented: TrashPropertyAuthority<boolean>;
  readonly cancelBubble: TrashPropertyAuthority<boolean>;
  readonly key: TrashPropertyAuthority<string>;
  readonly code: TrashPropertyAuthority<string>;
  readonly location: TrashPropertyAuthority<number>;
  readonly ctrlKey: TrashPropertyAuthority<boolean>;
  readonly metaKey: TrashPropertyAuthority<boolean>;
  readonly altKey: TrashPropertyAuthority<boolean>;
  readonly shiftKey: TrashPropertyAuthority<boolean>;
  readonly repeat: TrashPropertyAuthority<boolean>;
  readonly composing: TrashPropertyAuthority<boolean>;
  readonly view: TrashPropertyAuthority<Window | null>;
  readonly composedPath: TrashMethodAuthority<readonly [], EventTarget[]>;
  readonly preventDefault: TrashMethodAuthority<readonly [], void>;
  readonly focus: TrashMethodAuthority<
    readonly [options?: FocusOptions],
    void
  >;
  readonly addWindowEventListener: TrashWindowMethodAuthority<
    Window["addEventListener"]
  >;
  readonly removeWindowEventListener: TrashWindowMethodAuthority<
    Window["removeEventListener"]
  >;
  readonly terminal: TrashKeyboardWindowRegistration;
  readonly isCurrent: () => boolean;
}

interface TrashReactKeyProof {
  readonly event: object;
  readonly nativeEvent: KeyboardEvent;
  readonly target: HTMLButtonElement;
  readonly currentTarget: HTMLElement;
  readonly phase: number;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
  readonly isDefaultPrevented: () => boolean;
  readonly isPropagationStopped: () => boolean;
  readonly defaultPreventedResult: false;
  readonly propagationStoppedResult: false;
}

interface TrashKeyboardMovement {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly cardIdentity: symbol;
  readonly sourceIdentity: symbol;
  readonly sourceActionIdentity: symbol;
  readonly destinationIdentity: symbol;
  readonly destinationActionIdentity: symbol;
  readonly key: TrashNavigationKey;
  readonly source: TrashControlPublication;
  readonly destination: TrashControlPublication;
}

interface TrashKeyboardNativeProof {
  readonly event: KeyboardEvent;
  readonly publication: TrashPublication;
  readonly card: TrashCardPublication;
  readonly movement: TrashKeyboardMovement;
  readonly delegatedRoot: EventTarget;
  readonly path: readonly EventTarget[];
  readonly terminal: EventTarget;
  readonly window: TrashKeyboardWindowProof;
  readonly key: TrashNavigationKey;
  readonly code: string;
  readonly location: number;
  readonly capture: TrashReactKeyProof;
  bubble: TrashReactKeyProof | null;
  crossed: boolean;
}

const allowTrashRetry = () => true;
const allowTrashAction = () => true;

function captureTrashPropertyAuthority<T>(
  view: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): TrashPropertyAuthority<T> | null {
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (typeof descriptor.get !== "function") return null;
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      const getter = descriptor.get;
      return Object.freeze({
        read: (value: object) =>
          apply(getter as (this: object) => T, value, []),
        isCurrent: () =>
          view.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          view.Object.getPrototypeOf === getPrototypeOf &&
          view.Reflect.apply === apply &&
          filterDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureTrashMethodAuthority<
  Args extends readonly unknown[],
  Result,
>(
  view: Window & typeof globalThis,
  prototype: object,
  property: PropertyKey,
): TrashMethodAuthority<Args, Result> | null {
  const getOwnPropertyDescriptor = view.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = view.Object.getPrototypeOf;
  const apply = view.Reflect.apply;
  let owner: object | null = prototype;
  while (owner) {
    const descriptor = getOwnPropertyDescriptor(owner, property);
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function"
      ) {
        return null;
      }
      const descriptorOwner = owner;
      const expected = Object.freeze({ ...descriptor });
      const method = descriptor.value as (...args: Args) => Result;
      return Object.freeze({
        value: method,
        call: (receiver: object, ...args: Args) =>
          apply(method, receiver, args),
        isCurrent: () =>
          view.Object.getOwnPropertyDescriptor ===
            getOwnPropertyDescriptor &&
          view.Object.getPrototypeOf === getPrototypeOf &&
          view.Reflect.apply === apply &&
          filterDescriptorsMatch(
            getOwnPropertyDescriptor(descriptorOwner, property),
            expected,
          ),
      });
    }
    owner = getPrototypeOf(owner) as object | null;
  }
  return null;
}

function captureTrashWindowMethod<
  Property extends "addEventListener" | "removeEventListener",
>(
  ownerWindow: Window & typeof globalThis,
  property: Property,
): TrashWindowMethodAuthority<Window[Property]> | null {
  const getOwnPropertyDescriptor =
    ownerWindow.Object.getOwnPropertyDescriptor;
  const getPrototypeOf = ownerWindow.Object.getPrototypeOf;
  const reflectGet = ownerWindow.Reflect.get;
  const path: {
    readonly target: object;
    readonly descriptor: Readonly<PropertyDescriptor> | null;
    readonly prototype: object | null;
  }[] = [];
  let target: object | null = ownerWindow;
  let found = false;
  while (target) {
    const descriptor = getOwnPropertyDescriptor(target, property);
    const prototype = getPrototypeOf(target) as object | null;
    path.push(
      Object.freeze({
        target,
        descriptor: descriptor
          ? Object.freeze({ ...descriptor })
          : null,
        prototype,
      }),
    );
    if (descriptor) {
      found = true;
      break;
    }
    target = prototype;
  }
  const value = reflectGet(
    ownerWindow,
    property,
    ownerWindow,
  ) as Window[Property];
  if (!found || typeof value !== "function") return null;
  const isCurrent = () =>
    ownerWindow.Object.getOwnPropertyDescriptor ===
      getOwnPropertyDescriptor &&
    ownerWindow.Object.getPrototypeOf === getPrototypeOf &&
    ownerWindow.Reflect.get === reflectGet &&
    path.every(({ target: entry, descriptor, prototype }) => {
      if (getPrototypeOf(entry) !== prototype) return false;
      const current = getOwnPropertyDescriptor(entry, property);
      return descriptor
        ? filterDescriptorsMatch(current, descriptor)
        : current === undefined;
    }) &&
    reflectGet(ownerWindow, property, ownerWindow) === value;
  return isCurrent() ? Object.freeze({ value, isCurrent }) : null;
}

function createTrashKeyboardWindowRegistration(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
  KeyboardEventConstructor: typeof KeyboardEvent,
  keyboardPrototype: object,
  currentTarget: TrashPropertyAuthority<EventTarget | null>,
  phase: TrashPropertyAuthority<number>,
  composedPath: TrashMethodAuthority<readonly [], EventTarget[]>,
  addEventListener: TrashWindowMethodAuthority<
    Window["addEventListener"]
  >,
  removeEventListener: TrashWindowMethodAuthority<
    Window["removeEventListener"]
  >,
  apply: typeof Reflect.apply,
  prototypeOf: typeof Object.getPrototypeOf,
  intrinsicsAreCurrent: () => boolean,
): TrashKeyboardWindowRegistration | null {
  const proofs = new WeakMap<
    KeyboardEvent,
    TrashKeyboardWindowProof
  >();
  const invalidEvents = new WeakSet<Event>();
  let claimed: TrashKeyboardWindowProof | null = null;
  let active = false;
  let released = false;
  const listener: EventListener = function (
    this: EventTarget,
    event: Event,
  ) {
    if (
      !active ||
      released ||
      !(event instanceof KeyboardEventConstructor) ||
      prototypeOf(event) !== keyboardPrototype ||
      invalidEvents.has(event) ||
      !intrinsicsAreCurrent()
    ) {
      return;
    }
    if (proofs.has(event)) {
      invalidEvents.add(event);
      return;
    }
    try {
      const eventCurrentTarget = currentTarget.read(event);
      const eventPhase = phase.read(event);
      const path = composedPath.call(event);
      const terminal = path.at(-1);
      if (
        !eventCurrentTarget ||
        eventCurrentTarget !== this ||
        terminal !== this ||
        eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        path.at(-2) !== ownerDocument
      ) {
        invalidEvents.add(event);
        return;
      }
      proofs.set(
        event,
        Object.freeze({
          registration,
          nativeEvent: event,
          receiver: this,
          currentTarget: eventCurrentTarget,
          terminal,
          path: Object.freeze([...path]),
        }),
      );
    } catch {
      invalidEvents.add(event);
    }
  };
  const proofFor = (event: KeyboardEvent) => {
    const proof = proofs.get(event);
    if (
      !proof ||
      !active ||
      released ||
      claimed !== null ||
      invalidEvents.has(event) ||
      proof.registration !== registration ||
      proof.nativeEvent !== event ||
      proof.receiver !== proof.currentTarget ||
      proof.receiver !== proof.terminal ||
      !intrinsicsAreCurrent()
    ) {
      return null;
    }
    try {
      const path = composedPath.call(event);
      return path.length === proof.path.length &&
        path.every((entry, index) => entry === proof.path[index]) &&
        path.at(-2) === ownerDocument &&
        path.at(-1) === proof.receiver
        ? proof
        : null;
    } catch {
      invalidEvents.add(event);
      return null;
    }
  };
  const registration: TrashKeyboardWindowRegistration =
    Object.freeze({
      proofFor,
      claim: (proof: TrashKeyboardWindowProof) => {
        if (claimed || proofFor(proof.nativeEvent) !== proof) {
          return false;
        }
        claimed = proof;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        active = false;
        apply(removeEventListener.value, ownerWindow, [
          "keydown",
          listener,
          true,
        ]);
      },
      isCurrent: () =>
        active &&
        !released &&
        intrinsicsAreCurrent() &&
        addEventListener.isCurrent() &&
        removeEventListener.isCurrent(),
    });
  active = true;
  try {
    apply(addEventListener.value, ownerWindow, [
      "keydown",
      listener,
      true,
    ]);
    if (registration.isCurrent()) return registration;
    registration.release();
    return null;
  } catch {
    active = false;
    released = true;
    return null;
  }
}

function captureTrashKeyboardAuthority(
  ownerWindow: Window & typeof globalThis,
  ownerDocument: Document,
): TrashKeyboardAuthority | null {
  try {
    const EventConstructor = ownerWindow.Event;
    const UIEventConstructor = ownerWindow.UIEvent;
    const KeyboardEventConstructor = ownerWindow.KeyboardEvent;
    const DocumentConstructor = ownerWindow.Document;
    const HTMLElementConstructor = ownerWindow.HTMLElement;
    const eventPrototype = EventConstructor.prototype;
    const uiEventPrototype = UIEventConstructor.prototype;
    const keyboardPrototype = KeyboardEventConstructor.prototype;
    const documentPrototype = DocumentConstructor.prototype;
    const htmlElementPrototype = HTMLElementConstructor.prototype;
    const prototypeOf = ownerWindow.Object.getPrototypeOf;
    const apply = ownerWindow.Reflect.apply;
    const prototypeLinks = [
      [keyboardPrototype, prototypeOf(keyboardPrototype)],
      [uiEventPrototype, prototypeOf(uiEventPrototype)],
      [eventPrototype, prototypeOf(eventPrototype)],
      [documentPrototype, prototypeOf(documentPrototype)],
      [htmlElementPrototype, prototypeOf(htmlElementPrototype)],
    ] as const;
    const trusted = captureFilterTrustedAuthority(ownerWindow);
    const activeElement =
      captureFilterActiveElementAuthority(ownerWindow);
    const type = captureTrashPropertyAuthority<string>(
      ownerWindow,
      eventPrototype,
      "type",
    );
    const target =
      captureTrashPropertyAuthority<EventTarget | null>(
        ownerWindow,
        eventPrototype,
        "target",
      );
    const currentTarget =
      captureTrashPropertyAuthority<EventTarget | null>(
        ownerWindow,
        eventPrototype,
        "currentTarget",
      );
    const phase = captureTrashPropertyAuthority<number>(
      ownerWindow,
      eventPrototype,
      "eventPhase",
    );
    const bubbles = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "bubbles",
    );
    const cancelable = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "cancelable",
    );
    const composed = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "composed",
    );
    const defaultPrevented =
      captureTrashPropertyAuthority<boolean>(
        ownerWindow,
        eventPrototype,
        "defaultPrevented",
      );
    const cancelBubble = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      eventPrototype,
      "cancelBubble",
    );
    const key = captureTrashPropertyAuthority<string>(
      ownerWindow,
      keyboardPrototype,
      "key",
    );
    const code = captureTrashPropertyAuthority<string>(
      ownerWindow,
      keyboardPrototype,
      "code",
    );
    const location = captureTrashPropertyAuthority<number>(
      ownerWindow,
      keyboardPrototype,
      "location",
    );
    const ctrlKey = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "ctrlKey",
    );
    const metaKey = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "metaKey",
    );
    const altKey = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "altKey",
    );
    const shiftKey = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "shiftKey",
    );
    const repeat = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "repeat",
    );
    const composing = captureTrashPropertyAuthority<boolean>(
      ownerWindow,
      keyboardPrototype,
      "isComposing",
    );
    const view = captureTrashPropertyAuthority<Window | null>(
      ownerWindow,
      uiEventPrototype,
      "view",
    );
    const composedPath = captureTrashMethodAuthority<
      readonly [],
      EventTarget[]
    >(ownerWindow, eventPrototype, "composedPath");
    const preventDefault = captureTrashMethodAuthority<
      readonly [],
      void
    >(ownerWindow, eventPrototype, "preventDefault");
    const focus = captureTrashMethodAuthority<
      readonly [options?: FocusOptions],
      void
    >(ownerWindow, htmlElementPrototype, "focus");
    const addWindowEventListener = captureTrashWindowMethod(
      ownerWindow,
      "addEventListener",
    );
    const removeWindowEventListener = captureTrashWindowMethod(
      ownerWindow,
      "removeEventListener",
    );
    const authorities = [
      type,
      target,
      currentTarget,
      phase,
      bubbles,
      cancelable,
      composed,
      defaultPrevented,
      cancelBubble,
      key,
      code,
      location,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
      repeat,
      composing,
      view,
      composedPath,
      preventDefault,
      focus,
    ];
    if (
      !trusted ||
      !activeElement ||
      !addWindowEventListener ||
      !removeWindowEventListener ||
      authorities.some((authority) => authority === null)
    ) {
      return null;
    }
    let stale = false;
    const intrinsicsAreCurrent = () => {
      if (stale) return false;
      const current =
        ownerDocument.defaultView === ownerWindow &&
        ownerWindow.Event === EventConstructor &&
        ownerWindow.UIEvent === UIEventConstructor &&
        ownerWindow.KeyboardEvent === KeyboardEventConstructor &&
        ownerWindow.Document === DocumentConstructor &&
        ownerWindow.HTMLElement === HTMLElementConstructor &&
        ownerWindow.Object.getPrototypeOf === prototypeOf &&
        ownerWindow.Reflect.apply === apply &&
        EventConstructor.prototype === eventPrototype &&
        UIEventConstructor.prototype === uiEventPrototype &&
        KeyboardEventConstructor.prototype === keyboardPrototype &&
        DocumentConstructor.prototype === documentPrototype &&
        HTMLElementConstructor.prototype ===
          htmlElementPrototype &&
        prototypeLinks.every(
          ([prototype, parent]) =>
            prototypeOf(prototype) === parent,
        ) &&
        prototypeOf(keyboardPrototype) === uiEventPrototype &&
        prototypeOf(uiEventPrototype) === eventPrototype &&
        trusted.isCurrent() &&
        activeElement.isCurrent() &&
        addWindowEventListener.isCurrent() &&
        removeWindowEventListener.isCurrent() &&
        authorities.every((candidate) =>
          candidate?.isCurrent(),
        );
      if (!current) stale = true;
      return current;
    };
    const terminal = createTrashKeyboardWindowRegistration(
      ownerWindow,
      ownerDocument,
      KeyboardEventConstructor,
      keyboardPrototype,
      currentTarget!,
      phase!,
      composedPath!,
      addWindowEventListener,
      removeWindowEventListener,
      apply,
      prototypeOf,
      intrinsicsAreCurrent,
    );
    if (!terminal) return null;
    const authority: TrashKeyboardAuthority = {
      ownerWindow,
      Event: EventConstructor,
      KeyboardEvent: KeyboardEventConstructor,
      HTMLElement: HTMLElementConstructor,
      keyboardPrototype,
      prototypeOf,
      apply,
      trusted,
      activeElement,
      type: type!,
      target: target!,
      currentTarget: currentTarget!,
      phase: phase!,
      bubbles: bubbles!,
      cancelable: cancelable!,
      composed: composed!,
      defaultPrevented: defaultPrevented!,
      cancelBubble: cancelBubble!,
      key: key!,
      code: code!,
      location: location!,
      ctrlKey: ctrlKey!,
      metaKey: metaKey!,
      altKey: altKey!,
      shiftKey: shiftKey!,
      repeat: repeat!,
      composing: composing!,
      view: view!,
      composedPath: composedPath!,
      preventDefault: preventDefault!,
      focus: focus!,
      addWindowEventListener,
      removeWindowEventListener,
      terminal,
      isCurrent: () =>
        intrinsicsAreCurrent() && terminal.isCurrent(),
    };
    return Object.freeze(authority);
  } catch {
    return null;
  }
}

function trashEventPath(
  source: Node,
  ownerDocument: Document,
): readonly EventTarget[] | null {
  const path: EventTarget[] = [];
  for (let current: Node | null = source; current; current = current.parentNode) {
    path.push(current);
    if (current === ownerDocument) return Object.freeze(path);
  }
  return null;
}

function trashNavigationKey(key: string): TrashNavigationKey | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
    case "ArrowRight":
    case "ArrowDown":
    case "Home":
    case "End":
      return key;
    default:
      return null;
  }
}

function trashMovement(
  publication: TrashPublication,
  card: TrashCardPublication,
  source: TrashControlPublication,
  key: TrashNavigationKey,
): TrashKeyboardMovement | null {
  const sourceIndex = card.actions.indexOf(source);
  if (sourceIndex < 0) return null;
  let destinationIndex: number;
  if (key === "ArrowLeft" || key === "ArrowUp") {
    destinationIndex = sourceIndex - 1;
  } else if (key === "ArrowRight" || key === "ArrowDown") {
    destinationIndex = sourceIndex + 1;
  } else if (key === "Home") {
    destinationIndex = 0;
  } else {
    destinationIndex = card.actions.length - 1;
  }
  const destination = card.actions[destinationIndex];
  if (!destination || destination === source) return null;
  return Object.freeze({
    identity: Symbol("trash-keyboard-movement"),
    publicationIdentity: publication.identity,
    cardIdentity: card.identity,
    sourceIdentity: source.identity,
    sourceActionIdentity: source.action.identity,
    destinationIdentity: destination.identity,
    destinationActionIdentity: destination.action.identity,
    key,
    source,
    destination,
  });
}

function captureTrashReactKeyProof(
  event: ReactKeyboardEvent<HTMLElement>,
  nativeEvent: KeyboardEvent,
  target: HTMLButtonElement,
  currentTarget: HTMLElement,
  phase: number,
  key: TrashNavigationKey,
): TrashReactKeyProof | null {
  try {
    const preventDefault = event.preventDefault;
    const stopPropagation = event.stopPropagation;
    const isDefaultPrevented = event.isDefaultPrevented;
    const isPropagationStopped = event.isPropagationStopped;
    if (
      event.nativeEvent !== nativeEvent ||
      event.type !== "keydown" ||
      event.target !== target ||
      event.currentTarget !== currentTarget ||
      event.eventPhase !== phase ||
      event.key !== key ||
      !event.bubbles ||
      !event.cancelable ||
      event.defaultPrevented ||
      !event.isTrusted ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.repeat ||
      typeof preventDefault !== "function" ||
      typeof stopPropagation !== "function" ||
      typeof isDefaultPrevented !== "function" ||
      typeof isPropagationStopped !== "function" ||
      TRUSTED_REFLECT_APPLY(isDefaultPrevented, event, []) !==
        false ||
      TRUSTED_REFLECT_APPLY(isPropagationStopped, event, []) !==
        false
    ) {
      return null;
    }
    return Object.freeze({
      event,
      nativeEvent,
      target,
      currentTarget,
      phase,
      preventDefault,
      stopPropagation,
      isDefaultPrevented,
      isPropagationStopped,
      defaultPreventedResult: false,
      propagationStoppedResult: false,
    });
  } catch {
    return null;
  }
}

function trashReactKeyProofIsCurrent(
  proof: TrashReactKeyProof,
): boolean {
  try {
    const event = proof.event as ReactKeyboardEvent<HTMLElement>;
    return (
      event.preventDefault === proof.preventDefault &&
      event.stopPropagation === proof.stopPropagation &&
      event.isDefaultPrevented === proof.isDefaultPrevented &&
      event.isPropagationStopped === proof.isPropagationStopped &&
      TRUSTED_REFLECT_APPLY(
        proof.isDefaultPrevented,
        proof.event,
        [],
      ) === proof.defaultPreventedResult &&
      TRUSTED_REFLECT_APPLY(
        proof.isPropagationStopped,
        proof.event,
        [],
      ) === proof.propagationStoppedResult
    );
  } catch {
    return false;
  }
}

function trashReactKeyProofWasPrevented(
  proof: TrashReactKeyProof,
): boolean {
  try {
    const event = proof.event as ReactKeyboardEvent<HTMLElement>;
    const isDefaultPrevented = event.isDefaultPrevented;
    return (
      event.preventDefault === proof.preventDefault &&
      event.stopPropagation === proof.stopPropagation &&
      event.isPropagationStopped === proof.isPropagationStopped &&
      event.defaultPrevented === true &&
      typeof isDefaultPrevented === "function" &&
      TRUSTED_REFLECT_APPLY(
        isDefaultPrevented,
        proof.event,
        [],
      ) === true &&
      TRUSTED_REFLECT_APPLY(
        proof.isPropagationStopped,
        proof.event,
        [],
      ) === proof.propagationStoppedResult
    );
  } catch {
    return false;
  }
}

class TrashElementOwner<T extends HTMLElement> implements TrashElementOwnerView {
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    private readonly onChange: (
      owner: TrashElementOwnerView,
      element: HTMLElement | null,
      previous: HTMLElement | null,
      last: HTMLElement | null,
    ) => void,
  ) {}

  readonly element = () => this.current;

  readonly capture = (element: T | null) => {
    if (this.current === element) return;
    if (element && this.last && element !== this.last && !element.isConnected) return;
    const previous = this.current;
    const last = this.last;
    this.current = element;
    if (element) this.last = element;
    this.onChange(this, element, previous, last);
  };
}

function snapshotTrashAttributes(node: Node): readonly (readonly [string, string])[] | null {
  if (node.nodeType !== 1) return null;
  return Object.freeze(
    [...(node as Element).attributes]
      .map(({ name, value }) => Object.freeze([name, value] as const))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function snapshotTrashDom(
  node: Node,
  withinRelativeTime = false,
): TrashDomSnapshot {
  const nextWithinRelativeTime =
    withinRelativeTime ||
    (node.nodeType === node.ELEMENT_NODE &&
      (node as Element).tagName === "TIME");
  return Object.freeze({
    node,
    nodeValue: node.nodeValue,
    relativeTimeText:
      nextWithinRelativeTime && node.nodeType === node.TEXT_NODE,
    attributes: snapshotTrashAttributes(node),
    children: Object.freeze(
      [...node.childNodes].map((child) =>
        snapshotTrashDom(child, nextWithinRelativeTime),
      ),
    ),
  });
}

function trashDomMatches(snapshot: TrashDomSnapshot, ownerDocument: Document): boolean {
  const { node, children } = snapshot;
  if (
    !node.isConnected ||
    node.ownerDocument !== ownerDocument ||
    (!snapshot.relativeTimeText && node.nodeValue !== snapshot.nodeValue)
  ) {
    return false;
  }
  const attributes = snapshotTrashAttributes(node);
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
    node.childNodes.length === children.length &&
    children.every(
      (child, index) =>
        node.childNodes.item(index) === child.node &&
        trashDomMatches(child, ownerDocument),
    )
  );
}

function captureTrashPlacement(node: HTMLElement): TrashPlacement | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return Object.freeze({
    document: node.ownerDocument,
    parent,
    previousSibling: node.previousSibling,
    nextSibling: node.nextSibling,
  });
}

function trashPlacementMatches(node: HTMLElement, placement: TrashPlacement): boolean {
  return (
    node.ownerDocument === placement.document &&
    node.parentNode === placement.parent &&
    node.previousSibling === placement.previousSibling &&
    node.nextSibling === placement.nextSibling
  );
}

function trashCardMatches(
  card: TrashCardPresentation,
  document: Doc | undefined,
  index: number,
  busy: string | null,
): boolean {
  return (
    Object.isFrozen(card) &&
    card.index === index &&
    document === card.document &&
    document?.id === card.id &&
    document.title === card.title &&
    document.excerpt === card.excerpt &&
    document.storage === card.storage &&
    document.repoOwner === card.repoOwner &&
    document.repoName === card.repoName &&
    document.repoPath === card.repoPath &&
    document.gistId === card.gistId &&
    document.updatedAt === card.updatedAt &&
    document.deletedAt === card.deletedAt &&
    card.busy === (busy === card.id)
  );
}

function trashRenderMatches(render: TrashRenderPresentation): boolean {
  if (
    !Object.isFrozen(render) ||
    !Object.isFrozen(render.cards) ||
    render.retentionDays !== TRASH_RETENTION_DAYS
  ) {
    return false;
  }
  const { documents } = render;
  if (documents === null) return render.cards.length === 0;
  if (documents.length !== render.cards.length) return false;
  return render.cards.every((card, index) =>
    trashCardMatches(card, documents[index], index, render.busy),
  );
}

function trashAuthoritiesMatch(
  previous: TrashRenderPresentation,
  current: TrashRenderPresentation,
): boolean {
  return (
    previous.mount === current.mount &&
    previous.documents === current.documents &&
    previous.busy === current.busy &&
    previous.loading === current.loading &&
    previous.error === current.error &&
    previous.retentionDays === current.retentionDays &&
    previous.canRetry === current.canRetry &&
    previous.canAct === current.canAct &&
    previous.onRetry === current.onRetry &&
    previous.onRestore === current.onRestore &&
    previous.onPurge === current.onPurge &&
    previous.cards.length === current.cards.length &&
    previous.cards.every((card, index) => {
      const candidate = current.cards[index];
      return Boolean(
        candidate &&
          card.index === candidate.index &&
          card.document === candidate.document &&
          card.id === candidate.id &&
          card.title === candidate.title &&
          card.excerpt === candidate.excerpt &&
          card.storage === candidate.storage &&
          card.repoOwner === candidate.repoOwner &&
          card.repoName === candidate.repoName &&
          card.repoPath === candidate.repoPath &&
          card.gistId === candidate.gistId &&
          card.updatedAt === candidate.updatedAt &&
          card.deletedAt === candidate.deletedAt &&
          card.busy === candidate.busy,
      );
    }) &&
    trashRenderMatches(previous) &&
    trashRenderMatches(current)
  );
}

function trashIsEffectivelyEnabled(element: HTMLElement): boolean {
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled")?.toLowerCase() === "true" ||
    element.getAttribute("aria-busy")?.toLowerCase() === "true"
  ) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute("inert") ||
      current.getAttribute("aria-disabled")?.toLowerCase() === "true"
    ) {
      return false;
    }
  }
  return true;
}

function createTrashPublication(
  render: TrashRenderPresentation,
  cells: TrashPublicationCells,
  requestSuccessor: () => void,
): TrashPublicationSet {
  const mount = render.mount;
  const documents = render.documents;
  const busy = render.busy;
  const loading = render.loading;
  const error = render.error;
  const retentionDays = render.retentionDays;
  const canRetry = render.canRetry;
  const canAct = render.canAct;
  const onRetry = render.onRetry;
  const onRestore = render.onRestore;
  const onPurge = render.onPurge;
  const cards = render.cards;
  let currentRuntime: TrashPublicationRuntime | null = null;
  let lastRuntime: TrashPublicationRuntime | null = null;
  let successorRequested = false;

  const factsAreCurrent = () =>
    render.mount === mount &&
    render.documents === documents &&
    render.busy === busy &&
    render.loading === loading &&
    render.error === error &&
    render.retentionDays === retentionDays &&
    render.canRetry === canRetry &&
    render.canAct === canAct &&
    render.onRetry === onRetry &&
    render.onRestore === onRestore &&
    render.onPurge === onPurge &&
    render.cards === cards &&
    trashRenderMatches(render);

  const onElementChange = (
    owner: TrashElementOwnerView,
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
      cells.successorOf === runtime.publication
    ) {
      requestReplaySuccessor(runtime);
    }
  };

  const rootOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const noteOwner = new TrashElementOwner<HTMLParagraphElement>(onElementChange);
  const errorOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const retryOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
  const loadingOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const emptyOwner = new TrashElementOwner<HTMLDivElement>(onElementChange);
  const listOwner = new TrashElementOwner<HTMLUListElement>(onElementChange);
  const cardOwners = Object.freeze(
    cards.map((card) => {
      const cardOwner = new TrashElementOwner<HTMLLIElement>(onElementChange);
      const restoreOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
      const purgeOwner = new TrashElementOwner<HTMLButtonElement>(onElementChange);
      return Object.freeze({
        authority: card,
        captureCard: cardOwner.capture,
        captureRestore: restoreOwner.capture,
        capturePurge: purgeOwner.capture,
        captureKeyDown: (
          event: ReactKeyboardEvent<HTMLLIElement>,
        ) => currentRuntime?.captureCardKeyDown(card, event),
        bubbleKeyDown: (
          event: ReactKeyboardEvent<HTMLLIElement>,
        ) => currentRuntime?.bubbleCardKeyDown(card, event),
        cardOwner,
        restoreOwner,
        purgeOwner,
      });
    }),
  );

  const hasError = Boolean(error);
  const hasLoading = documents === null && !hasError;
  const hasEmpty = documents !== null && documents.length === 0;
  const hasList = documents !== null && documents.length > 0;
  const expectedOwners = (): readonly TrashElementOwnerView[] => [
    rootOwner,
    noteOwner,
    ...(hasError ? [errorOwner, retryOwner] : []),
    ...(hasLoading ? [loadingOwner] : []),
    ...(hasEmpty ? [emptyOwner] : []),
    ...(hasList ? [listOwner] : []),
    ...cardOwners.flatMap(({ cardOwner, restoreOwner, purgeOwner }) => [
      cardOwner,
      restoreOwner,
      purgeOwner,
    ]),
  ];

  const exactDomIsCurrent = () => {
    if (!factsAreCurrent()) return false;
    const root = rootOwner.element();
    const note = noteOwner.element();
    const errorElement = errorOwner.element();
    const retry = retryOwner.element();
    const loadingElement = loadingOwner.element();
    const empty = emptyOwner.element();
    const list = listOwner.element();
    const ownerDocument = root?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !root ||
      !root.isConnected ||
      !root.parentNode ||
      !ownerDocument ||
      !ownerWindow ||
      !(root instanceof ownerWindow.HTMLDivElement) ||
      root.dataset.testid !== "trash-view" ||
      root.getAttribute("aria-busy") !== (loading ? "true" : null) ||
      !(note instanceof ownerWindow.HTMLParagraphElement) ||
      !note.isConnected ||
      note.ownerDocument !== ownerDocument ||
      note.parentElement !== root ||
      root.firstElementChild !== note ||
      note.className !== "mb-3 flex items-center gap-1.5 text-xs text-ink-3" ||
      note.dataset.testid !== "trash-note" ||
      note.textContent?.trim() !== `Items are deleted forever after ${retentionDays} days.`
    ) {
      return false;
    }

    let rootIndex = 1;
    if (hasError) {
      const errorText = errorElement?.firstElementChild;
      if (
        !(errorElement instanceof ownerWindow.HTMLDivElement) ||
        !errorElement.isConnected ||
        errorElement.ownerDocument !== ownerDocument ||
        errorElement.parentElement !== root ||
        root.children.item(rootIndex++) !== errorElement ||
        errorElement.className !== "mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" ||
        errorElement.getAttribute("role") !== "alert" ||
        errorElement.getAttribute("aria-atomic") !== "true" ||
        errorElement.dataset.testid !== "trash-error" ||
        errorElement.children.length !== 2 ||
        !(errorText instanceof ownerWindow.HTMLSpanElement) ||
        errorText.className !== "min-w-0 flex-1 wrap-anywhere" ||
        errorText.textContent !== error ||
        !(retry instanceof ownerWindow.HTMLButtonElement) ||
        !retry.isConnected ||
        retry.ownerDocument !== ownerDocument ||
        retry.parentElement !== errorElement ||
        errorElement.lastElementChild !== retry ||
        retry.type !== "button" ||
        retry.className !== "btn btn-sm btn-outline shrink-0 gap-1.5" ||
        retry.disabled !== loading ||
        retry.getAttribute("aria-busy") !== (loading ? "true" : null) ||
        retry.textContent?.trim() !== (loading ? "Retrying…" : "Retry") ||
        (!loading && !trashIsEffectivelyEnabled(retry))
      ) {
        return false;
      }
    } else if (errorElement !== null || retry !== null) {
      return false;
    }

    const stateElement = hasLoading ? loadingElement : hasEmpty ? empty : hasList ? list : null;
    if (stateElement !== null) {
      if (
        !stateElement.isConnected ||
        stateElement.ownerDocument !== ownerDocument ||
        stateElement.parentElement !== root ||
        root.children.item(rootIndex) !== stateElement
      ) {
        return false;
      }
      rootIndex++;
    }
    if (
      root.children.length !== rootIndex ||
      (hasLoading ? loadingElement === null : loadingElement !== null) ||
      (hasEmpty ? empty === null : empty !== null) ||
      (hasList ? list === null : list !== null)
    ) {
      return false;
    }

    if (hasLoading) {
      if (
        !(loadingElement instanceof ownerWindow.HTMLDivElement) ||
        loadingElement.className !== "flex items-center gap-2 py-10 text-sm text-ink-3" ||
        loadingElement.textContent?.trim() !== "Loading trash…"
      ) {
        return false;
      }
    } else if (hasEmpty) {
      if (
        !(empty instanceof ownerWindow.HTMLDivElement) ||
        empty.className !== "rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" ||
        empty.dataset.testid !== "empty-state" ||
        empty.children.length !== 3 ||
        empty.children.item(1)?.textContent !== "The trash is empty" ||
        empty.children.item(2)?.textContent !==
          `Documents you move to the trash can be restored here for ${retentionDays} days.`
      ) {
        return false;
      }
    } else if (
      hasList &&
      (!(list instanceof ownerWindow.HTMLUListElement) ||
        list.className !== "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ||
        list.dataset.testid !== "trash-list" ||
        list.children.length !== cards.length)
    ) {
      return false;
    }

    if (!hasList) return cardOwners.length === 0;
    if (!list) return false;
    return cardOwners.every((owned, index) => {
      const card = owned.authority;
      const item = owned.cardOwner.element();
      const restore = owned.restoreOwner.element();
      const purge = owned.purgeOwner.element();
      if (
        cards[index] !== card ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        !item.isConnected ||
        item.ownerDocument !== ownerDocument ||
        item.parentElement !== list ||
        list.children.item(index) !== item ||
        item.className !== "flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm" ||
        item.dataset.testid !== "trash-card" ||
        item.getAttribute("aria-busy") !== (card.busy ? "true" : null) ||
        item.children.length !== 3
      ) {
        return false;
      }
      const header = item.children.item(0);
      const excerpt = item.children.item(1);
      const footer = item.children.item(2);
      const storageBadge = header?.children.item(1);
      const storageDetail =
        card.storage === "repo"
          ? `${card.repoOwner}/${card.repoName}: ${card.repoPath}`
          : `Gist${card.gistId ? ` ${card.gistId}` : ""}`;
      if (
        !(header instanceof ownerWindow.HTMLDivElement) ||
        header.className !== "mb-2 flex items-start justify-between gap-2" ||
        header.children.length !== (card.storage === "local" ? 1 : 2) ||
        header.firstElementChild?.tagName !== "H3" ||
        header.firstElementChild.className !== "line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink" ||
        header.firstElementChild.textContent !== card.title ||
        (card.storage === "local"
          ? storageBadge !== null
          : !(storageBadge instanceof ownerWindow.HTMLSpanElement) ||
            storageBadge.className !== "inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" ||
            storageBadge.getAttribute("title") !== storageDetail ||
            storageBadge.dataset.testid !== "storage-badge" ||
            storageBadge.dataset.storage !== card.storage ||
            storageBadge.textContent?.trim() !== "GitHub") ||
        !(excerpt instanceof ownerWindow.HTMLParagraphElement) ||
        excerpt.className !== "line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3" ||
        excerpt.textContent !== (card.excerpt || "Empty document") ||
        !(footer instanceof ownerWindow.HTMLDivElement) ||
        footer.className !== "mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4" ||
        footer.children.length !== 2
      ) {
        return false;
      }
      const timeContainer = footer.children.item(0);
      const controls = footer.children.item(1);
      const time = timeContainer?.firstElementChild;
      const displayedDate = card.deletedAt ?? card.updatedAt;
      if (
        !(timeContainer instanceof ownerWindow.HTMLSpanElement) ||
        timeContainer.className !== "whitespace-nowrap" ||
        timeContainer.children.length !== 1 ||
        !(time instanceof ownerWindow.HTMLTimeElement) ||
        time.getAttribute("datetime") !== new Date(displayedDate).toISOString() ||
        !(controls instanceof ownerWindow.HTMLDivElement) ||
        controls.className !== "ml-auto flex items-center gap-1.5" ||
        controls.children.length !== 2 ||
        !(restore instanceof ownerWindow.HTMLButtonElement) ||
        !restore.isConnected ||
        restore.ownerDocument !== ownerDocument ||
        restore.parentElement !== controls ||
        controls.firstElementChild !== restore ||
        restore.type !== "button" ||
        restore.className !== "btn btn-sm btn-outline gap-1 whitespace-nowrap" ||
        restore.disabled !== (busy !== null) ||
        restore.dataset.testid !== "restore-button" ||
        restore.textContent?.trim() !== "Restore" ||
        !(purge instanceof ownerWindow.HTMLButtonElement) ||
        !purge.isConnected ||
        purge.ownerDocument !== ownerDocument ||
        purge.parentElement !== controls ||
        controls.lastElementChild !== purge ||
        purge.type !== "button" ||
        purge.className !== "btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40" ||
        purge.disabled !== (busy !== null) ||
        purge.dataset.testid !== "purge-button" ||
        purge.textContent?.trim() !== "Delete forever" ||
        (busy === null &&
          (!trashIsEffectivelyEnabled(restore) || !trashIsEffectivelyEnabled(purge)))
      ) {
        return false;
      }
      return true;
    });
  };

  const publicationWasClaimed = (publication: TrashPublication) =>
    cells.claimedPublications.has(publication);

  const requestReplaySuccessor = (runtime: TrashPublicationRuntime) => {
    const dom = runtime.snapshot();
    const placement = runtime.placement();
    if (
      successorRequested ||
      !dom ||
      !placement ||
      cells.successorOf !== runtime.publication ||
      publicationWasClaimed(runtime.publication) ||
      !factsAreCurrent() ||
      !exactDomIsCurrent() ||
      !runtime.publishedDomMatches()
    ) {
      return;
    }
    successorRequested = true;
    cells.replay = Object.freeze({
      source: runtime.publication,
      dom,
      placement,
      partialElements: runtime.partialReplayElements(),
      unchanged: runtime.replayDomUnchanged,
      release: runtime.releaseReplayGuard,
    });
    requestSuccessor();
  };

  const createRuntime = (): TrashPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const root = rootOwner.element();
    const note = noteOwner.element();
    const errorElement = errorOwner.element();
    const retryElement = retryOwner.element();
    const loadingElement = loadingOwner.element();
    const emptyElement = emptyOwner.element();
    const listElement = listOwner.element();
    const placement = root ? captureTrashPlacement(root) : null;
    if (
      !root ||
      !note ||
      !placement ||
      (hasError ? !errorElement || !retryElement : Boolean(errorElement || retryElement)) ||
      (hasLoading ? !loadingElement : Boolean(loadingElement)) ||
      (hasEmpty ? !emptyElement : Boolean(emptyElement)) ||
      (hasList ? !listElement : Boolean(listElement)) ||
      cardOwners.some(
        ({ cardOwner, restoreOwner, purgeOwner }) =>
          !cardOwner.element() || !restoreOwner.element() || !purgeOwner.element(),
      )
    ) {
      return null;
    }

    const identity = Symbol("trash-publication");
    const control = (
      kind: TrashPublishedActionKind,
      cardIndex: number | null,
      element: HTMLButtonElement,
    ): TrashControlPublication => {
      const controlIdentity = Symbol(`trash-${kind}-control`);
      const path = trashEventPath(element, root.ownerDocument);
      if (!path) {
        throw new Error(
          "Cannot publish a Trash control outside its owner document",
        );
      }
      return Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        kind,
        cardIndex,
        element,
        path,
        action: Object.freeze({
          identity: Symbol(`trash-${kind}-action`),
          publicationIdentity: identity,
          controlIdentity,
          kind,
          cardIndex,
        }),
      });
    };
    const publishedCards = Object.freeze(
      cardOwners.map((owned) => {
        const element = owned.cardOwner.element();
        const restore = owned.restoreOwner.element();
        const purge = owned.purgeOwner.element();
        if (!element || !restore || !purge) {
          throw new Error("Cannot publish a Trash row without every committed ref");
        }
        const restoreControl = control(
          "restore",
          owned.authority.index,
          restore,
        );
        const purgeControl = control(
          "purge",
          owned.authority.index,
          purge,
        );
        return Object.freeze({
          identity: Symbol("trash-card"),
          authority: owned.authority,
          element,
          restore: restoreControl,
          purge: purgeControl,
          actions: Object.freeze(
            [restoreControl, purgeControl].filter(({ element }) =>
              trashIsEffectivelyEnabled(element),
            ),
          ),
        });
      }),
    );
    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let layoutRetired = false;
    let domChanged = false;
    let domObserver: MutationObserver | null = null;
    let domSnapshot: TrashDomSnapshot | null = null;
    let relativeTimeTextNodes = new WeakSet<Node>();
    let publishedPlacement: TrashPlacement | null = null;
    let replayRefs: TrashRefReplay[] = [];
    let partialReplayOwners = new Set<TrashElementOwnerView>();
    let invalidReplay = false;
    const keyboardProofs = new WeakMap<
      KeyboardEvent,
      TrashKeyboardNativeProof
    >();
    const invalidKeyboardEvents = new WeakSet<Event>();
    const keyboardOwnerWindow = root.ownerDocument.defaultView;
    const keyboardAuthority = keyboardOwnerWindow
      ? captureTrashKeyboardAuthority(
          keyboardOwnerWindow,
          root.ownerDocument,
        )
      : null;
    const publication: TrashPublication = Object.freeze({
      identity,
      render,
      root,
      note,
      error: hasError ? errorElement : null,
      retry: hasError && retryElement ? control("retry", null, retryElement) : null,
      loading: hasLoading ? loadingElement : null,
      empty: hasEmpty ? emptyElement : null,
      list: hasList ? listElement : null,
      cards: publishedCards,
      ownerDocument: root.ownerDocument,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const publishedActionsAreCurrent = (
      card: TrashCardPublication,
    ) => {
      const expected = [card.restore, card.purge].filter(
        ({ element }) => trashIsEffectivelyEnabled(element),
      );
      return (
        Object.isFrozen(card.actions) &&
        card.actions.length <= 2 &&
        card.actions.length === expected.length &&
        card.actions.every(
          (action, index) =>
            action === expected[index] &&
            action.publicationIdentity === publication.identity &&
            action.cardIndex === card.authority.index &&
            action.action.publicationIdentity ===
              publication.identity &&
            action.action.controlIdentity === action.identity &&
            action.action.cardIndex === card.authority.index &&
            action.action.kind === action.kind &&
            trashIsEffectivelyEnabled(action.element),
        )
      );
    };

    const keyboardCandidateIsCurrent = (
      card: TrashCardPublication,
      movement: TrashKeyboardMovement,
    ) => {
      const source = movement.source;
      const destination = movement.destination;
      return (
        currentRuntime === runtime &&
        movement.publicationIdentity === publication.identity &&
        movement.cardIdentity === card.identity &&
        movement.sourceIdentity === source.identity &&
        movement.sourceActionIdentity === source.action.identity &&
        movement.destinationIdentity === destination.identity &&
        movement.destinationActionIdentity ===
          destination.action.identity &&
        source !== destination &&
        card.actions.includes(source) &&
        card.actions.includes(destination) &&
        publishedActionsAreCurrent(card) &&
        candidateIsCurrent(
          runtime,
          publication,
          card,
          source,
          source.action,
        ) &&
        candidateIsCurrent(
          runtime,
          publication,
          card,
          destination,
          destination.action,
        ) &&
        keyboardAuthority?.ownerWindow ===
          publication.ownerDocument.defaultView &&
        keyboardAuthority.isCurrent() &&
        keyboardAuthority.activeElement.read(
          publication.ownerDocument,
        ) === source.element
      );
    };

    const pathsMatch = (
      expected: readonly EventTarget[],
      current: readonly EventTarget[],
    ) =>
      expected.length === current.length &&
      expected.every((entry, index) => current[index] === entry);

    const delegatedRootIsCurrent = (
      card: TrashCardPublication,
      path: readonly EventTarget[],
      delegatedRoot: EventTarget,
    ) => {
      const cardIndex = path.indexOf(card.element);
      const publicationRootIndex = path.indexOf(publication.root);
      const delegatedRootIndex = path.indexOf(delegatedRoot);
      return (
        cardIndex >= 0 &&
        publicationRootIndex > cardIndex &&
        delegatedRootIndex > publicationRootIndex &&
        delegatedRootIndex < path.length - 1 &&
        path.lastIndexOf(delegatedRoot) === delegatedRootIndex
      );
    };

    const nativeKeyboardIsCurrent = (
      proof: TrashKeyboardNativeProof,
      expectedPhase: number,
    ) => {
      const authority = keyboardAuthority;
      if (!authority) return false;
      try {
        const event = proof.event;
        const path = authority.composedPath.call(event);
        const view = authority.view.read(event);
        return (
          authority.isCurrent() &&
          event instanceof authority.KeyboardEvent &&
          authority.prototypeOf(event) ===
            authority.keyboardPrototype &&
          publication.ownerDocument.defaultView ===
            authority.ownerWindow &&
          authority.trusted.matches(event) &&
          authority.trusted.read(event) === true &&
          authority.type.read(event) === "keydown" &&
          authority.target.read(event) ===
            proof.movement.source.element &&
          authority.currentTarget.read(event) ===
            proof.delegatedRoot &&
          authority.phase.read(event) === expectedPhase &&
          authority.bubbles.read(event) &&
          authority.cancelable.read(event) &&
          !authority.defaultPrevented.read(event) &&
          !authority.cancelBubble.read(event) &&
          authority.key.read(event) === proof.key &&
          authority.code.read(event) === proof.code &&
          authority.location.read(event) === proof.location &&
          !authority.ctrlKey.read(event) &&
          !authority.metaKey.read(event) &&
          !authority.altKey.read(event) &&
          !authority.shiftKey.read(event) &&
          !authority.repeat.read(event) &&
          !authority.composing.read(event) &&
          (view === authority.ownerWindow ||
            view === proof.window.receiver) &&
          pathsMatch(proof.path, path) &&
          pathsMatch(proof.window.path, path) &&
          delegatedRootIsCurrent(
            proof.card,
            path,
            proof.delegatedRoot,
          ) &&
          path.at(-2) === publication.ownerDocument &&
          path.at(-1) === proof.terminal &&
          proof.window.registration === authority.terminal &&
          proof.window.nativeEvent === event &&
          proof.window.receiver ===
            proof.window.currentTarget &&
          proof.window.receiver === proof.window.terminal &&
          proof.window.receiver === proof.terminal &&
          authority.terminal.proofFor(event) === proof.window &&
          keyboardCandidateIsCurrent(proof.card, proof.movement)
        );
      } catch {
        return false;
      }
    };

    const releaseKeyboardClaims = (
      proof: TrashKeyboardNativeProof,
    ) => {
      cells.claimedPublications.delete(publication);
      cells.claimedCards.delete(proof.card);
      cells.claimedControls.delete(proof.movement.source);
      cells.claimedControls.delete(proof.movement.destination);
      cells.claimedActions.delete(proof.movement.source.action);
      cells.claimedActions.delete(
        proof.movement.destination.action,
      );
    };

    const claimKeyboard = (
      proof: TrashKeyboardNativeProof,
    ) => {
      const authority = keyboardAuthority;
      const capture = proof.capture;
      const bubble = proof.bubble;
      if (
        !authority ||
        !bubble ||
        cells.claimedPublications.has(publication) ||
        cells.claimedCards.has(proof.card) ||
        cells.claimedControls.has(proof.movement.source) ||
        cells.claimedControls.has(proof.movement.destination) ||
        cells.claimedActions.has(proof.movement.source.action) ||
        cells.claimedActions.has(
          proof.movement.destination.action,
        ) ||
        cells.claimedNativeEvents.has(proof.event) ||
        cells.claimedReactEvents.has(capture.event) ||
        cells.claimedReactEvents.has(bubble.event) ||
        cells.claimedMovements.has(proof.movement) ||
        cells.claimedWindowProofs.has(proof.window) ||
        !cells.evaluatingPublications.has(publication) ||
        proof.window.registration !== authority.terminal ||
        !authority.terminal.claim(proof.window)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedCards.add(proof.card);
      cells.claimedControls.add(proof.movement.source);
      cells.claimedControls.add(proof.movement.destination);
      cells.claimedActions.add(proof.movement.source.action);
      cells.claimedActions.add(
        proof.movement.destination.action,
      );
      cells.claimedNativeEvents.add(proof.event);
      cells.claimedReactEvents.add(capture.event);
      cells.claimedReactEvents.add(bubble.event);
      cells.claimedMovements.add(proof.movement);
      cells.claimedWindowProofs.add(proof.window);
      return true;
    };

    const captureCardKeyDown = (
      cardAuthority: TrashCardPresentation,
      event: ReactKeyboardEvent<HTMLLIElement>,
    ) => {
      const authority = keyboardAuthority;
      if (!authority || !event || typeof event !== "object") return;
      let nativeEvent: KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      if (!nativeEvent || typeof nativeEvent !== "object") {
        return;
      }
      const existing = keyboardProofs.get(nativeEvent);
      if (
        existing ||
        cells.attemptedNativeEvents.has(nativeEvent) ||
        cells.attemptedReactEvents.has(event)
      ) {
        if (existing) existing.crossed = true;
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
        if (nativeEvent && typeof nativeEvent === "object")
          cells.attemptedNativeEvents.add(nativeEvent);
        cells.attemptedReactEvents.add(event);
        return;
      }
      cells.attemptedNativeEvents.add(nativeEvent);
      cells.attemptedReactEvents.add(event);
      try {
        const card =
          publication.cards[cardAuthority.index];
        const target = authority.target.read(nativeEvent);
        const source =
          card?.restore.element === target
            ? card.restore
            : card?.purge.element === target
              ? card.purge
              : null;
        const key = trashNavigationKey(
          authority.key.read(nativeEvent),
        );
        const windowProof =
          authority.terminal.proofFor(nativeEvent);
        const view = authority.view.read(nativeEvent);
        const delegatedRoot =
          authority.currentTarget.read(nativeEvent);
        const code = authority.code.read(nativeEvent);
        const location = authority.location.read(nativeEvent);
        if (
          !card ||
          card.authority !== cardAuthority ||
          !source ||
          !key ||
          !windowProof ||
          !authority.isCurrent() ||
          publication.ownerDocument.defaultView !==
            authority.ownerWindow ||
          !(nativeEvent instanceof authority.KeyboardEvent) ||
          authority.prototypeOf(nativeEvent) !==
            authority.keyboardPrototype ||
          !authority.trusted.matches(nativeEvent) ||
          authority.trusted.read(nativeEvent) !== true ||
          authority.type.read(nativeEvent) !== "keydown" ||
          authority.target.read(nativeEvent) !== source.element ||
          !delegatedRoot ||
          authority.phase.read(nativeEvent) !==
            authority.Event.CAPTURING_PHASE ||
          !authority.bubbles.read(nativeEvent) ||
          !authority.cancelable.read(nativeEvent) ||
          authority.defaultPrevented.read(nativeEvent) ||
          authority.cancelBubble.read(nativeEvent) ||
          authority.key.read(nativeEvent) !== key ||
          authority.ctrlKey.read(nativeEvent) ||
          authority.metaKey.read(nativeEvent) ||
          authority.altKey.read(nativeEvent) ||
          authority.shiftKey.read(nativeEvent) ||
          authority.repeat.read(nativeEvent) ||
          authority.composing.read(nativeEvent) ||
          (view !== authority.ownerWindow &&
            view !== windowProof.receiver) ||
          authority.activeElement.read(
            publication.ownerDocument,
          ) !== source.element ||
          !publishedActionsAreCurrent(card)
        ) {
          return;
        }
        const movement = trashMovement(
          publication,
          card,
          source,
          key,
        );
        if (
          !movement ||
          !keyboardCandidateIsCurrent(card, movement)
        ) {
          return;
        }
        const path = authority.composedPath.call(nativeEvent);
        const terminal = path.at(-1);
        if (
          !terminal ||
          path.length !== source.path.length + 1 ||
          !pathsMatch(path, windowProof.path) ||
          path.at(-2) !== publication.ownerDocument ||
          terminal !== windowProof.receiver ||
          windowProof.receiver !== windowProof.currentTarget ||
          windowProof.receiver !== windowProof.terminal ||
          !source.path.every(
            (entry, index) => path[index] === entry,
          ) ||
          !delegatedRootIsCurrent(card, path, delegatedRoot)
        ) {
          return;
        }
        const capture = captureTrashReactKeyProof(
          event,
          nativeEvent,
          source.element,
          card.element,
          authority.Event.CAPTURING_PHASE,
          key,
        );
        if (!capture) return;
        const proof: TrashKeyboardNativeProof = {
          event: nativeEvent,
          publication,
          card,
          movement,
          delegatedRoot,
          path: Object.freeze([...path]),
          terminal,
          window: windowProof,
          key,
          code,
          location,
          capture,
          bubble: null,
          crossed: false,
        };
        keyboardProofs.set(nativeEvent, proof);
        queueMicrotask(() => {
          if (keyboardProofs.get(nativeEvent) !== proof) return;
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
        });
      } catch {
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
      }
    };

    const bubbleCardKeyDown = (
      cardAuthority: TrashCardPresentation,
      event: ReactKeyboardEvent<HTMLLIElement>,
    ) => {
      const authority = keyboardAuthority;
      if (!authority) return;
      if (!event || typeof event !== "object") {
        return;
      }
      let nativeEvent: KeyboardEvent;
      try {
        nativeEvent = event.nativeEvent;
      } catch {
        return;
      }
      if (!nativeEvent || typeof nativeEvent !== "object") return;
      const proof = keyboardProofs.get(nativeEvent);
      if (!proof) return;
      cells.attemptedReactEvents.add(event);
      try {
        if (
          proof.crossed ||
          invalidKeyboardEvents.has(nativeEvent) ||
          proof.bubble ||
          event === proof.capture.event ||
          event.nativeEvent !== proof.event ||
          proof.card.authority !== cardAuthority ||
          authority.phase.read(proof.event) !==
            authority.Event.BUBBLING_PHASE ||
          !nativeKeyboardIsCurrent(
            proof,
            authority.Event.BUBBLING_PHASE,
          )
        ) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        const bubble = captureTrashReactKeyProof(
          event,
          proof.event,
          proof.movement.source.element,
          proof.card.element,
          authority.Event.BUBBLING_PHASE,
          proof.key,
        );
        if (!bubble) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        proof.bubble = bubble;
        if (
          !trashReactKeyProofIsCurrent(proof.capture) ||
          !trashReactKeyProofIsCurrent(bubble) ||
          !nativeKeyboardIsCurrent(
            proof,
            authority.Event.BUBBLING_PHASE,
          ) ||
          keyboardProofs.get(nativeEvent) !== proof
        ) {
          proof.crossed = true;
          invalidKeyboardEvents.add(nativeEvent);
          keyboardProofs.delete(nativeEvent);
          return;
        }
        cells.evaluatingPublications.add(publication);
        let claimed = false;
        try {
          claimed =
            nativeKeyboardIsCurrent(
              proof,
              authority.Event.BUBBLING_PHASE,
            ) &&
            trashReactKeyProofIsCurrent(proof.capture) &&
            trashReactKeyProofIsCurrent(bubble) &&
            keyboardProofs.get(nativeEvent) === proof &&
            claimKeyboard(proof);
        } finally {
          cells.evaluatingPublications.delete(publication);
        }
        keyboardProofs.delete(nativeEvent);
        if (!claimed) return;
        try {
          TRUSTED_REFLECT_APPLY(
            bubble.preventDefault,
            bubble.event,
            [],
          );
          if (
            !authority.defaultPrevented.read(proof.event) ||
            !trashReactKeyProofWasPrevented(bubble)
          ) {
            return;
          }
          authority.focus.call(
            proof.movement.destination.element,
            { preventScroll: true },
          );
          requestSuccessor();
        } finally {
          releaseKeyboardClaims(proof);
        }
      } catch {
        proof.crossed = true;
        invalidKeyboardEvents.add(nativeEvent);
        keyboardProofs.delete(nativeEvent);
      }
    };

    const releaseKeyboardListener = () => {
      const authority = keyboardAuthority;
      if (!authority) return;
      try {
        authority.terminal.release();
      } catch {
        return;
      }
    };

    const mutationIsRelevant = (record: MutationRecord) => {
      if (
        record.type === "characterData" &&
        relativeTimeTextNodes.has(record.target)
      ) {
        return false;
      }
      if (record.target === root || root.contains(record.target)) return true;
      if (
        record.type === "attributes" &&
        (record.attributeName === "inert" ||
          record.attributeName === "aria-disabled" ||
          record.attributeName === "aria-busy" ||
          record.attributeName === "disabled") &&
        record.target.contains(root)
      ) {
        return true;
      }
      if (record.type !== "childList") return false;
      if (publishedPlacement && record.target === publishedPlacement.parent) return true;
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) => node === root || node.contains(root) || root.contains(node),
      );
    };
    const recordMutations = (records: readonly MutationRecord[]) => {
      if (!domChanged && records.some(mutationIsRelevant)) domChanged = true;
      return domChanged;
    };
    const releaseReplayGuard = () => {
      if (!domObserver) return;
      recordMutations(domObserver.takeRecords());
      domObserver.disconnect();
      domObserver = null;
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      if (domObserver) recordMutations(domObserver.takeRecords());
      retired = true;
      retirement = reason;
      releaseKeyboardListener();
      cells.retiredPublications.add(publication);
      for (const card of publication.cards) {
        cells.retiredCards.add(card);
        for (const publishedControl of [card.restore, card.purge]) {
          cells.retiredControls.add(publishedControl);
          cells.retiredActions.add(publishedControl.action);
        }
      }
      if (publication.retry) {
        cells.retiredControls.add(publication.retry);
        cells.retiredActions.add(publication.retry.action);
      }
      const wasActive = cells.active === publication;
      if (wasActive) {
        cells.active = null;
        cells.successorOf = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      if (reason === "layout" || reason === "element") {
        queueMicrotask(() => {
          if (!domObserver) return;
          recordMutations(domObserver.takeRecords());
          domChanged = true;
          domObserver.disconnect();
          domObserver = null;
        });
      } else {
        releaseReplayGuard();
      }
      return wasActive;
    };
    const noteMutations = (records: readonly MutationRecord[]) => {
      if (recordMutations(records)) retire("element");
    };
    const publishedDomMatches = () => {
      if (domObserver) noteMutations(domObserver.takeRecords());
      return Boolean(
        !domChanged &&
          domSnapshot &&
          publishedPlacement &&
          rootOwner.element() === root &&
          noteOwner.element() === note &&
          root.isConnected &&
          trashPlacementMatches(root, publishedPlacement) &&
          trashDomMatches(domSnapshot, publication.ownerDocument),
      );
    };
    const refsHaveExactReplay = () =>
      !invalidReplay &&
      replayRefs.length > 0 &&
      replayRefs.every(
        (entry) =>
          entry.detached &&
          entry.reattached &&
          entry.owner.element() === entry.element,
      );
    const refsHaveExactPartialReplay = () =>
      !invalidReplay &&
      partialReplayOwners.size > 0 &&
      replayRefs.every(
        (entry) =>
          entry.owner.element() === entry.element &&
          (partialReplayOwners.has(entry.owner)
            ? entry.detached && entry.reattached
            : !entry.detached && !entry.reattached),
      );
    const runtime: TrashPublicationRuntime = Object.freeze({
      publication,
      publish: (
        nextDom: TrashDomSnapshot,
        nextPlacement: TrashPlacement,
        owners: readonly TrashElementOwnerView[],
        partialReplayElements: ReadonlySet<HTMLElement>,
      ) => {
        established = true;
        domSnapshot = nextDom;
        relativeTimeTextNodes = new WeakSet<Node>();
        const rememberRelativeTimeText = (snapshot: TrashDomSnapshot) => {
          if (snapshot.relativeTimeText) {
            relativeTimeTextNodes.add(snapshot.node);
          }
          snapshot.children.forEach(rememberRelativeTimeText);
        };
        rememberRelativeTimeText(nextDom);
        publishedPlacement = nextPlacement;
        replayRefs = owners.map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error("Cannot publish Trash without every committed ref");
          }
          return { owner, element, detached: false, reattached: false };
        });
        partialReplayOwners = new Set(
          replayRefs
            .filter(({ element }) => partialReplayElements.has(element))
            .map(({ owner }) => owner),
        );
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        const MutationObserverConstructor =
          publication.ownerDocument.defaultView?.MutationObserver;
        if (MutationObserverConstructor) {
          domObserver = new MutationObserverConstructor((records) => {
            noteMutations(records);
          });
          domObserver.observe(publication.ownerDocument, {
            attributeOldValue: true,
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        layoutRetired = true;
        retire("layout");
      },
      noteRef: (
        owner: TrashElementOwnerView,
        element: HTMLElement | null,
        previous: HTMLElement | null,
      ) => {
        if (!established) return;
        const proof = replayRefs.find((entry) => entry.owner === owner);
        if (!proof) {
          invalidReplay = true;
          return;
        }
        if (
          element === null &&
          previous === proof.element &&
          proof.element.isConnected
        ) {
          proof.detached = true;
          proof.reattached = false;
        } else if (
          element === proof.element &&
          previous === null &&
          proof.detached &&
          proof.element.isConnected
        ) {
          proof.reattached = true;
        } else if (element !== previous) {
          invalidReplay = true;
        }
      },
      isRetired: () => retired,
      publishedDomMatches,
      isExactElementReplay: () =>
          retired &&
          retirement === "element" &&
          established &&
          (layoutRetired ? refsHaveExactReplay() : refsHaveExactPartialReplay()) &&
          publishedDomMatches(),
      isExactLayoutReplay: () =>
        retired &&
        retirement === "layout" &&
        established &&
        refsHaveExactReplay() &&
        publishedDomMatches(),
      replayDomUnchanged: () => {
        if (!domObserver) return false;
        recordMutations(domObserver.takeRecords());
        return Boolean(
          !domChanged &&
            domSnapshot &&
            publishedPlacement &&
            root.isConnected &&
            trashPlacementMatches(root, publishedPlacement) &&
            trashDomMatches(domSnapshot, publication.ownerDocument),
        );
      },
      releaseReplayGuard,
      snapshot: () => domSnapshot,
      placement: () => publishedPlacement,
      partialReplayElements: () =>
        new Set(
          replayRefs
            .filter(({ owner }) => partialReplayOwners.has(owner))
            .map(({ element }) => element),
        ),
      captureCardKeyDown,
        bubbleCardKeyDown,
    });
    return runtime;
  };

  const publishedElements = (publication: TrashPublication): readonly HTMLElement[] => [
    publication.root,
    publication.note,
    ...(publication.error ? [publication.error] : []),
    ...(publication.retry ? [publication.retry.element] : []),
    ...(publication.loading ? [publication.loading] : []),
    ...(publication.empty ? [publication.empty] : []),
    ...(publication.list ? [publication.list] : []),
    ...publication.cards.flatMap((card) => [
      card.element,
      card.restore.element,
      card.purge.element,
    ]),
  ];

  const establish = () => {
    if (lastRuntime) {
      if (
        (lastRuntime.isExactLayoutReplay() ||
          lastRuntime.isExactElementReplay()) &&
        cells.successorOf === lastRuntime.publication
      ) {
        requestReplaySuccessor(lastRuntime);
      }
      return undefined;
    }
    if (!factsAreCurrent() || !exactDomIsCurrent()) return undefined;
    const root = rootOwner.element();
    if (!root) return undefined;
    const placement = captureTrashPlacement(root);
    if (!placement) return undefined;
    const replay = cells.replay;
    if (
      replay &&
      (cells.successorOf !== replay.source ||
        publicationWasClaimed(replay.source) ||
        !trashAuthoritiesMatch(replay.source.render, render) ||
        replay.dom.node !== root ||
        !trashPlacementMatches(root, replay.placement) ||
        !trashDomMatches(replay.dom, root.ownerDocument) ||
        !replay.unchanged())
    ) {
      const exactDomStillCommitted =
        replay.dom.node === root &&
        trashPlacementMatches(root, replay.placement) &&
        trashDomMatches(replay.dom, root.ownerDocument) &&
        replay.unchanged();
      replay.release();
      cells.replay = null;
      if (cells.successorOf === replay.source) cells.successorOf = null;
      if (exactDomStillCommitted) requestSuccessor();
      return undefined;
    }

    const runtime = createRuntime();
    if (!runtime) return undefined;
    const publication = runtime.publication;
    const previous = cells.active;
    const predecessor = previous ?? cells.successorOf;
    const predecessorElements = new Set<HTMLElement>(
      predecessor?.render.mount === mount ? publishedElements(predecessor) : [],
    );
    const partialReplayElements = new Set<HTMLElement>(
      expectedOwners()
        .map((owner) => owner.element())
        .filter(
          (element): element is HTMLElement =>
            Boolean(
              element &&
                (!predecessorElements.has(element) ||
                  replay?.partialElements.has(element)),
            ),
        ),
    );
    if (previous && previous !== publication) previous.retire();
    currentRuntime = runtime;
    lastRuntime = runtime;
    runtime.publish(
      snapshotTrashDom(root),
      placement,
      expectedOwners(),
      partialReplayElements,
    );
    replay?.release();
    return runtime.retireForLayout;
  };

  const candidateIsCurrent = (
    runtime: TrashPublicationRuntime,
    publication: TrashPublication,
    card: TrashCardPublication | null,
    control: TrashControlPublication,
    action: TrashActionPublication,
  ) =>
    currentRuntime === runtime &&
    !runtime.isRetired() &&
    !publication.isRetired() &&
    cells.active === publication &&
    publication.render === render &&
    control.publicationIdentity === publication.identity &&
    action.publicationIdentity === publication.identity &&
    action.controlIdentity === control.identity &&
    action.kind === control.kind &&
    action.cardIndex === control.cardIndex &&
    !cells.retiredPublications.has(publication) &&
    !cells.retiredControls.has(control) &&
    !cells.retiredActions.has(action) &&
    !cells.claimedPublications.has(publication) &&
    !cells.claimedControls.has(control) &&
    !cells.claimedActions.has(action) &&
    (card === null
      ? control === publication.retry &&
        control.kind === "retry" &&
        control.cardIndex === null
      : publication.cards[card.authority.index] === card &&
        card.authority === cards[card.authority.index] &&
        control === (control.kind === "restore" ? card.restore : card.purge) &&
        control.cardIndex === card.authority.index &&
        !cells.retiredCards.has(card) &&
        !cells.claimedCards.has(card)) &&
    factsAreCurrent() &&
    exactDomIsCurrent() &&
    runtime.publishedDomMatches();

  return Object.freeze({
    captureRoot: rootOwner.capture,
    captureNote: noteOwner.capture,
    captureError: errorOwner.capture,
    captureRetry: retryOwner.capture,
    captureLoading: loadingOwner.capture,
    captureEmpty: emptyOwner.capture,
    captureList: listOwner.capture,
    cards: cardOwners,
    establish,
  });
}

/** The caller's trashed documents: not openable; restore or delete forever. `documents` is null until the first successful load. */
export function TrashView({
  documents,
  busy,
  loading,
  error,
  canRetry = allowTrashRetry,
  canAct = allowTrashAction,
  onRetry,
  onRestore,
  onPurge,
}: {
  documents: Doc[] | null;
  busy: string | null;
  loading: boolean;
  error: string | null;
  canRetry?: (error: string) => boolean;
  canAct?: (document: Doc, kind: TrashActionKind) => boolean;
  onRetry: () => void;
  onRestore: (d: Doc) => void;
  onPurge: (d: Doc) => void;
}) {
  const [mount] = useState(() => Symbol("trash-view"));
  const [cells] = useState<TrashPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    retiredPublications: new WeakSet(),
    retiredCards: new WeakSet(),
    retiredControls: new WeakSet(),
    retiredActions: new WeakSet(),
    claimedPublications: new WeakSet(),
    claimedCards: new WeakSet(),
    claimedControls: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    attemptedReactEvents: new WeakSet(),
    attemptedNativeEvents: new WeakSet(),
    claimedMovements: new WeakSet(),
    claimedWindowProofs: new WeakSet(),
    evaluatingPublications: new WeakSet(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestPublicationSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const cards = Object.freeze(
    (documents ?? []).map(
      (document, index): TrashCardPresentation =>
        Object.freeze({
          index,
          document,
          id: document.id,
          title: document.title,
          excerpt: document.excerpt,
          storage: document.storage,
          repoOwner: document.repoOwner,
          repoName: document.repoName,
          repoPath: document.repoPath,
          gistId: document.gistId,
          updatedAt: document.updatedAt,
          deletedAt: document.deletedAt,
          busy: busy === document.id,
        }),
    ),
  );
  const presentation: TrashRenderPresentation = Object.freeze({
    mount,
    documents,
    busy,
    loading,
    error,
    retentionDays: TRASH_RETENTION_DAYS,
    canRetry,
    canAct,
    onRetry,
    onRestore,
    onPurge,
    cards,
  });
  const publication = createTrashPublication(
    presentation,
    cells,
    requestPublicationSuccessor,
  );
  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureRoot,
    captureNote,
    captureError,
    captureRetry,
    captureLoading,
    captureEmpty,
    captureList,
    cards: publishedCards,
  } = publication;
  const retry = () => {
    if (error && !loading && canRetry(error)) onRetry();
  };
  const act = (kind: TrashActionKind, document: Doc) => {
    if (busy !== null || !canAct(document, kind)) return;
    if (kind === "restore") onRestore(document);
    else onPurge(document);
  };

  return (
    <div ref={captureRoot} data-testid="trash-view" aria-busy={presentation.loading || undefined}>
      <p ref={captureNote} className="mb-3 flex items-center gap-1.5 text-xs text-ink-3" data-testid="trash-note">
        <Trash2 size={12} /> Items are deleted forever after {presentation.retentionDays} days.
      </p>
      {presentation.error && (
        <div
          ref={captureError}
          className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
          role="alert"
          aria-atomic="true"
          data-testid="trash-error"
        >
          <span className="min-w-0 flex-1 wrap-anywhere">{presentation.error}</span>
          <button
            ref={captureRetry}
            type="button"
            className="btn btn-sm btn-outline shrink-0 gap-1.5"
            onClick={retry}
            disabled={presentation.loading}
            aria-busy={presentation.loading || undefined}
          >
            {presentation.loading && <Loader2 size={13} className="animate-spin" />}
            {presentation.loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {presentation.documents === null && !presentation.error ? (
        <div ref={captureLoading} className="flex items-center gap-2 py-10 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" /> Loading trash…
        </div>
      ) : presentation.documents?.length === 0 ? (
        <div ref={captureEmpty} className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" data-testid="empty-state">
          <Trash2 className="mx-auto mb-3 text-ink-4" size={28} />
          <p className="text-sm font-medium text-ink-2">The trash is empty</p>
          <p className="mt-1 text-sm text-ink-3">Documents you move to the trash can be restored here for {presentation.retentionDays} days.</p>
        </div>
      ) : presentation.documents ? (
        <ul ref={captureList} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash-list">
          {publishedCards.map((publishedCard) => {
            const card = publishedCard.authority;
            const d = card.document;
            return (
              <li
                ref={publishedCard.captureCard}
                key={card.id}
                className="flex h-full min-w-0 flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm"
                data-testid="trash-card"
                aria-busy={card.busy || undefined}
                onKeyDownCapture={publishedCard.captureKeyDown}
                onKeyDown={publishedCard.bubbleKeyDown}
              >
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="line-clamp-2 break-words text-[15px] font-semibold leading-5 text-ink">{card.title}</h3>
                  <StorageBadge doc={d} />
                </div>
                <p className="line-clamp-3 flex-1 break-words text-[13px] leading-5 text-ink-3">{card.excerpt || "Empty document"}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-4">
                  <span className="whitespace-nowrap">
                    {card.deletedAt ? <RelativeTime date={card.deletedAt} prefix="Trashed " /> : <RelativeTime date={card.updatedAt} prefix="Edited " />}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      ref={publishedCard.captureRestore}
                      type="button"
                      className="btn btn-sm btn-outline gap-1 whitespace-nowrap"
                      disabled={presentation.busy !== null}
                      onClick={() => act("restore", d)}
                      data-testid="restore-button"
                    >
                      {card.busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                    <button
                      ref={publishedCard.capturePurge}
                      type="button"
                      className="btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40"
                      disabled={presentation.busy !== null}
                      onClick={() => act("purge", d)}
                      data-testid="purge-button"
                    >
                      <Trash2 size={13} /> Delete forever
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
