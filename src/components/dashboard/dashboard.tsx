"use client";
import { Avatar, Dialog, DialogContent, DialogTrigger, Kbd, Menu, MenuContent, MenuItem, MenuTrigger, TooltipProvider } from "@/components/ui/primitives";
import { GitHubIcon } from "@/components/ui/github-icon";
import { ThemeToggle } from "@/components/ui/theme-toggle";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
  type SyntheticEvent as ReactSyntheticEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, BookOpen, CalendarCheck, ChevronDown, DraftingCompass, File, FilePlus2, FolderOpen, GitBranch, LayoutTemplate, ListChecks, Loader2, LogOut, PenLine, RotateCcw, Scale, Search, FileText, Sparkles, Star, Trash2, Users, X } from "lucide-react";
import { api, apiErrorText, type DocumentSummaryDto, type SearchResultDto } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/ui/relative-time";
import { takePendingNotice, type PendingNotice } from "@/lib/notice";
import { PICKER_TEMPLATES, TEMPLATES, WELCOME_TEMPLATE_ID, getTemplate, type Template, type TemplateIcon } from "@/lib/templates";
import { DEFAULT_DASHBOARD_SORT, SORT_COOKIE, SORT_COOKIE_MAX_AGE, SORT_OPTIONS, SORT_STORAGE_KEY, isDashboardSort, type DashboardSort } from "@/lib/dashboard-sort";

import { Logo } from "@/components/ui/logo";
import { GitHubPicker } from "@/components/editor/github-dialog";
import { GITHUB_NOT_CONFIGURED } from "@/components/editor/labels";
import { NotificationsStrip } from "@/components/dashboard/notifications-strip";
import { ImportDialog, ImportDropzone, useFileImport } from "@/components/dashboard/import-dialog";
import { CommandPalette, isPaletteShortcut } from "@/components/editor/command-palette";
import { buildDashboardCommands } from "@/components/editor/commands";
import { signOutSafely } from "@/lib/sign-out";

const EVENT_CURRENT_TARGET_GETTER = Object.getOwnPropertyDescriptor(
  Event.prototype,
  "currentTarget",
)?.get;
const EVENT_DEFAULT_PREVENTED_GETTER = Object.getOwnPropertyDescriptor(
  Event.prototype,
  "defaultPrevented",
)?.get;
const EVENT_TARGET_GETTER = Object.getOwnPropertyDescriptor(
  Event.prototype,
  "target",
)?.get;
const TRUSTED_EVENT_CURRENT_TARGET = EVENT_CURRENT_TARGET_GETTER
  ? (Function.prototype.call.bind(
      EVENT_CURRENT_TARGET_GETTER,
    ) as (event: Event) => EventTarget | null)
  : null;
const TRUSTED_EVENT_DEFAULT_PREVENTED = EVENT_DEFAULT_PREVENTED_GETTER
  ? (Function.prototype.call.bind(
      EVENT_DEFAULT_PREVENTED_GETTER,
    ) as (event: Event) => boolean)
  : null;
const TRUSTED_EVENT_TARGET = EVENT_TARGET_GETTER
  ? (Function.prototype.call.bind(
      EVENT_TARGET_GETTER,
    ) as (event: Event) => EventTarget | null)
  : null;
const TRUSTED_EVENT_COMPOSED_PATH = Function.prototype.call.bind(
  Event.prototype.composedPath,
) as (event: Event) => EventTarget[];
const TRUSTED_ADD_EVENT_LISTENER = Function.prototype.call.bind(
  EventTarget.prototype.addEventListener,
) as <E extends Event>(
  target: EventTarget,
  type: string,
  listener: (event: E) => void,
  options?: boolean | AddEventListenerOptions,
) => void;
const TRUSTED_REMOVE_EVENT_LISTENER = Function.prototype.call.bind(
  EventTarget.prototype.removeEventListener,
) as <E extends Event>(
  target: EventTarget,
  type: string,
  listener: (event: E) => void,
  options?: boolean | EventListenerOptions,
) => void;
const TRUSTED_PREVENT_DEFAULT = Function.prototype.call.bind(
  Event.prototype.preventDefault,
) as (event: Event) => void;
const TRUSTED_STOP_IMMEDIATE_PROPAGATION = Function.prototype.call.bind(
  Event.prototype.stopImmediatePropagation,
) as (event: Event) => void;
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

const EVENT_PROTOTYPE = typeof Event === "undefined" ? null : Event.prototype;
const UI_EVENT_PROTOTYPE =
  typeof UIEvent === "undefined" ? null : UIEvent.prototype;
const KEYBOARD_EVENT_PROTOTYPE =
  typeof KeyboardEvent === "undefined" ? null : KeyboardEvent.prototype;
const MOUSE_EVENT_PROTOTYPE =
  typeof MouseEvent === "undefined" ? null : MouseEvent.prototype;
const INPUT_EVENT_PROTOTYPE =
  typeof InputEvent === "undefined" ? null : InputEvent.prototype;
const HTML_INPUT_PROTOTYPE =
  typeof HTMLInputElement === "undefined" ? null : HTMLInputElement.prototype;
const HTML_BUTTON_PROTOTYPE =
  typeof HTMLButtonElement === "undefined" ? null : HTMLButtonElement.prototype;
const HTML_ELEMENT_PROTOTYPE =
  typeof HTMLElement === "undefined" ? null : HTMLElement.prototype;
const ELEMENT_PROTOTYPE =
  typeof Element === "undefined" ? null : Element.prototype;

const TRUSTED_EVENT_TYPE = capturePrototypeGetter<string>(
  EVENT_PROTOTYPE,
  "type",
);
const TRUSTED_EVENT_PHASE = capturePrototypeGetter<number>(
  EVENT_PROTOTYPE,
  "eventPhase",
);
const TRUSTED_EVENT_BUBBLES = capturePrototypeGetter<boolean>(
  EVENT_PROTOTYPE,
  "bubbles",
);
const TRUSTED_EVENT_CANCELABLE = capturePrototypeGetter<boolean>(
  EVENT_PROTOTYPE,
  "cancelable",
);
const TRUSTED_EVENT_CANCEL_BUBBLE = capturePrototypeGetter<boolean>(
  EVENT_PROTOTYPE,
  "cancelBubble",
);
const TRUSTED_KEYBOARD_KEY = capturePrototypeGetter<string>(
  KEYBOARD_EVENT_PROTOTYPE,
  "key",
);
const TRUSTED_KEYBOARD_CTRL = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "ctrlKey",
);
const TRUSTED_KEYBOARD_META = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "metaKey",
);
const TRUSTED_KEYBOARD_ALT = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "altKey",
);
const TRUSTED_KEYBOARD_SHIFT = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "shiftKey",
);
const TRUSTED_KEYBOARD_REPEAT = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "repeat",
);
const TRUSTED_KEYBOARD_COMPOSING = capturePrototypeGetter<boolean>(
  KEYBOARD_EVENT_PROTOTYPE,
  "isComposing",
);
const TRUSTED_MOUSE_BUTTON = capturePrototypeGetter<number>(
  MOUSE_EVENT_PROTOTYPE,
  "button",
);
const TRUSTED_MOUSE_BUTTONS = capturePrototypeGetter<number>(
  MOUSE_EVENT_PROTOTYPE,
  "buttons",
);
const TRUSTED_MOUSE_CTRL = capturePrototypeGetter<boolean>(
  MOUSE_EVENT_PROTOTYPE,
  "ctrlKey",
);
const TRUSTED_MOUSE_META = capturePrototypeGetter<boolean>(
  MOUSE_EVENT_PROTOTYPE,
  "metaKey",
);
const TRUSTED_MOUSE_ALT = capturePrototypeGetter<boolean>(
  MOUSE_EVENT_PROTOTYPE,
  "altKey",
);
const TRUSTED_MOUSE_SHIFT = capturePrototypeGetter<boolean>(
  MOUSE_EVENT_PROTOTYPE,
  "shiftKey",
);
const TRUSTED_UI_DETAIL = capturePrototypeGetter<number>(
  UI_EVENT_PROTOTYPE,
  "detail",
);
const TRUSTED_INPUT_COMPOSING = capturePrototypeGetter<boolean>(
  INPUT_EVENT_PROTOTYPE,
  "isComposing",
);
const TRUSTED_INPUT_VALUE = capturePrototypeGetter<string>(
  HTML_INPUT_PROTOTYPE,
  "value",
);
const TRUSTED_INPUT_DISABLED = capturePrototypeGetter<boolean>(
  HTML_INPUT_PROTOTYPE,
  "disabled",
);
const TRUSTED_INPUT_READ_ONLY = capturePrototypeGetter<boolean>(
  HTML_INPUT_PROTOTYPE,
  "readOnly",
);
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
const TRUSTED_FOCUS = capturePrototypeMethod<
  (element: HTMLElement, options?: FocusOptions) => void
>(HTML_ELEMENT_PROTOTYPE, "focus");
const TRUSTED_BLUR = capturePrototypeMethod<(element: HTMLElement) => void>(
  HTML_ELEMENT_PROTOTYPE,
  "blur",
);

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

const TEMPLATE_GRID_CLASS = "grid gap-3";
const TEMPLATE_GRID_COMPACT_CLASS = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
const TEMPLATE_GRID_DEFAULT_CLASS = "sm:grid-cols-2 lg:grid-cols-3";
const TEMPLATE_CARD_CLASS = "min-w-0";
const TEMPLATE_BUTTON_CLASS =
  "group flex h-full w-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 text-left transition hover:border-accent hover:shadow-sm focus-visible:border-accent disabled:cursor-default disabled:opacity-60";
const TEMPLATE_ICON_CONTAINER_CLASS =
  "flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3 text-ink-2 transition group-hover:bg-accent group-hover:text-on-accent";
const TEMPLATE_NAME_CLASS = "block text-sm font-semibold text-ink";
const TEMPLATE_DESCRIPTION_CLASS = "block text-xs leading-4 text-ink-3";

type TemplateGridExpectedAttributes = readonly (readonly [string, string])[];
type TemplateGridExpectedIconNode = readonly [
  localName: string,
  attributes: TemplateGridExpectedAttributes,
];
interface TemplateGridAttributeSnapshot {
  readonly name: string;
  readonly localName: string;
  readonly prefix: string | null;
  readonly namespaceURI: string | null;
  readonly value: string;
}

const TEMPLATE_GRID_XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const TEMPLATE_ICON_CHILDREN = {
  File: [
    ["path", [["d", "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"]]],
    ["path", [["d", "M14 2v5a1 1 0 0 0 1 1h5"]]],
  ],
  Users: [
    ["path", [["d", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"]]],
    ["path", [["d", "M16 3.128a4 4 0 0 1 0 7.744"]]],
    ["path", [["d", "M22 21v-2a4 4 0 0 0-3-3.87"]]],
    ["circle", [["cx", "9"], ["cy", "7"], ["r", "4"]]],
  ],
  BookOpen: [
    ["path", [["d", "M12 5v16"]]],
    ["path", [["d", "M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"]]],
  ],
  DraftingCompass: [
    ["path", [["d", "m12.99 6.74 1.93 3.44"]]],
    ["path", [["d", "M19.136 12a10 10 0 0 1-14.271 0"]]],
    ["path", [["d", "m21 21-2.16-3.84"]]],
    ["path", [["d", "m3 21 8.02-14.26"]]],
    ["circle", [["cx", "12"], ["cy", "5"], ["r", "2"]]],
  ],
  CalendarCheck: [
    ["path", [["d", "M8 2v3"]]],
    ["path", [["d", "M16 2v3"]]],
    ["rect", [["x", "3"], ["y", "3"], ["width", "18"], ["height", "18"], ["rx", "2"]]],
    ["path", [["d", "M3 9h18"]]],
    ["path", [["d", "m9 15 2 2 4-4"]]],
  ],
  PenLine: [
    ["path", [["d", "M13 21h8"]]],
    ["path", [["d", "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"]]],
  ],
  Scale: [
    ["path", [["d", "M12 3v18"]]],
    ["path", [["d", "m19 8 3 8a5 5 0 0 1-6 0zV7"]]],
    ["path", [["d", "M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1"]]],
    ["path", [["d", "m5 8 3 8a5 5 0 0 1-6 0zV7"]]],
    ["path", [["d", "M7 21h10"]]],
  ],
  ListChecks: [
    ["path", [["d", "M13 5h8"]]],
    ["path", [["d", "M13 12h8"]]],
    ["path", [["d", "M13 19h8"]]],
    ["path", [["d", "m3 17 2 2 4-4"]]],
    ["path", [["d", "m3 7 2 2 4-4"]]],
  ],
  Sparkles: [
    ["path", [["d", "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"]]],
    ["path", [["d", "M20 2v4"]]],
    ["path", [["d", "M22 4h-4"]]],
    ["circle", [["cx", "4"], ["cy", "20"], ["r", "2"]]],
  ],
} as const satisfies Record<TemplateIcon, readonly TemplateGridExpectedIconNode[]>;

const TEMPLATE_BUSY_ICON_CHILDREN = [
  ["path", [["d", "M21 12a9 9 0 1 1-6.219-8.56"]]],
] as const satisfies readonly TemplateGridExpectedIconNode[];

interface TemplateGridEntryPublication {
  readonly identity: symbol;
  readonly index: number;
  readonly template: Template;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: TemplateIcon;
  readonly isBusy: boolean;
  readonly Icon: typeof File;
  readonly iconClassName: string | undefined;
}

interface TemplateGridRenderPublication {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly templates: readonly Template[];
  readonly onPick: (template: Template) => void;
  readonly busy: string | null;
  readonly compact: boolean | undefined;
  readonly gridClassName: string;
  readonly entries: readonly TemplateGridEntryPublication[];
}

type TemplateGridElementRole =
  | "grid"
  | "card"
  | "button"
  | "icon"
  | "name"
  | "description";

interface TemplateGridElementOwnerView {
  readonly role: TemplateGridElementRole;
  readonly index: number | null;
  readonly element: () => Element | null;
}

interface TemplateGridRefReplay {
  readonly owner: TemplateGridElementOwnerView;
  readonly element: Element;
  state: "attached" | "detached" | "reattached" | "invalid";
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

interface TemplateGridDomGuard {
  readonly isClean: () => boolean;
  readonly release: () => void;
}

interface TemplateGridActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly entryIdentity: symbol;
  readonly index: number;
}

interface TemplateGridDomPublication {
  readonly identity: symbol;
  readonly entry: TemplateGridEntryPublication;
  readonly card: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly icon: SVGSVGElement;
  readonly name: HTMLSpanElement;
  readonly description: HTMLSpanElement;
  readonly action: TemplateGridActionPublication;
  readonly targets: readonly Node[];
}

interface TemplateGridPublication {
  readonly identity: symbol;
  readonly render: TemplateGridRenderPublication;
  readonly grid: HTMLUListElement;
  readonly ownerDocument: Document;
  readonly entries: readonly TemplateGridDomPublication[];
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface TemplateGridReplay {
  readonly source: TemplateGridPublication;
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
  readonly historyIsClean: () => boolean;
  readonly release: () => void;
}

interface TemplateGridPublicationCells {
  readonly active: { current: TemplateGridPublication | null };
  readonly successorOf: { current: TemplateGridPublication | null };
  readonly replay: { current: TemplateGridReplay | null };
  readonly delivery: { current: symbol | null };
  readonly claimedPublications: WeakSet<TemplateGridPublication>;
  readonly claimedEntries: WeakSet<TemplateGridDomPublication>;
  readonly claimedActions: WeakSet<TemplateGridActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
}

interface TemplateGridNativeClickProof {
  readonly attempt: symbol;
  readonly origin: "document-capture" | "document-root-react-capture";
  readonly event: MouseEvent;
  readonly entry: TemplateGridDomPublication;
  readonly action: TemplateGridActionPublication;
  readonly target: Node;
  readonly path: readonly EventTarget[];
}

interface TemplateGridReactClickProof {
  readonly event: object;
  readonly native: TemplateGridNativeClickProof;
}

interface TemplateGridReactEntryClickProof extends TemplateGridReactClickProof {
  readonly entry: TemplateGridDomPublication;
  readonly action: TemplateGridActionPublication;
  readonly dispatchTarget: Node;
}

interface TemplateGridTerminalClickProof {
  readonly attempt: symbol;
  readonly react: TemplateGridReactEntryClickProof;
  readonly native: TemplateGridNativeClickProof;
  readonly event: MouseEvent;
  readonly ownerDocument: Document;
}

interface TemplateGridTerminalClickBarrier {
  readonly event: MouseEvent;
  readonly listener: (event: Event) => void;
}

interface TemplateGridPublicationRuntime {
  readonly publication: TemplateGridPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: TemplateGridElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => TemplateGridReplay | null;
  readonly captureReactClick: (
    event: ReactMouseEvent<HTMLUListElement>,
  ) => void;
  readonly captureReactCardClick: (
    entry: TemplateGridEntryPublication,
    event: ReactMouseEvent<HTMLLIElement>,
  ) => void;
  readonly captureReactButtonClick: (
    entry: TemplateGridEntryPublication,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activate: (
    entry: TemplateGridEntryPublication,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => boolean;
}

interface TemplateGridEntryOwnerSet {
  readonly entry: TemplateGridEntryPublication;
  readonly card: TemplateGridElementOwner<HTMLLIElement>;
  readonly button: TemplateGridElementOwner<HTMLButtonElement>;
  readonly icon: TemplateGridElementOwner<SVGSVGElement>;
  readonly name: TemplateGridElementOwner<HTMLSpanElement>;
  readonly description: TemplateGridElementOwner<HTMLSpanElement>;
}

interface TemplateGridPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureGrid: (
    element: HTMLUListElement | null,
  ) => void | (() => void);
  readonly captureClick: (
    event: ReactMouseEvent<HTMLUListElement>,
  ) => void;
  readonly entries: readonly {
    readonly entry: TemplateGridEntryPublication;
    readonly captureCard: (
      element: HTMLLIElement | null,
    ) => void | (() => void);
    readonly captureButton: (
      element: HTMLButtonElement | null,
    ) => void | (() => void);
    readonly captureIcon: (
      element: SVGSVGElement | null,
    ) => void | (() => void);
    readonly captureName: (
      element: HTMLSpanElement | null,
    ) => void | (() => void);
    readonly captureDescription: (
      element: HTMLSpanElement | null,
    ) => void | (() => void);
    readonly captureClick: (
      event: ReactMouseEvent<HTMLLIElement>,
    ) => void;
    readonly captureButtonClick: (
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => void;
    readonly activate: (
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => boolean;
  }[];
}

class TemplateGridElementOwner<T extends Element>
  implements TemplateGridElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: TemplateGridElementRole,
    readonly index: number | null,
    private readonly onChange: (
      owner: TemplateGridElementOwnerView,
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

function snapshotTemplateGridPlacement(
  grid: HTMLUListElement,
): TemplateGridPlacement | null {
  const placement: TemplateGridNodePlacement[] = [];
  const ownerDocument = grid.ownerDocument;
  let current: Node | null = grid;
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

function templateGridMutationTouchesPlacement(
  placement: TemplateGridPlacement,
  mutation: MutationRecord,
) {
  if (mutation.type === "attributes") {
    return (
      (mutation.attributeName === "aria-disabled" ||
        mutation.attributeName === "disabled" ||
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
          (changed) =>
            changed === node ||
            (changed.nodeType === 1 && (changed as Element).contains(node)),
        )),
  );
}

function createTemplateGridDomGuard(
  grid: HTMLUListElement,
  placement: TemplateGridPlacement,
): TemplateGridDomGuard | null {
  const MutationObserverConstructor =
    grid.ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const record = (records: readonly MutationRecord[]) => {
    if (changed) return;
    changed = records.some(
      (mutation) =>
        mutation.target === grid ||
        grid.contains(mutation.target) ||
        templateGridMutationTouchesPlacement(placement, mutation),
    );
  };
  const observer = new MutationObserverConstructor(record);
  observer.observe(grid, {
    attributeOldValue: true,
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const observedParents = new Set<Node>();
  for (const { parent } of placement) {
    if (parent && !observedParents.has(parent)) {
      observedParents.add(parent);
      observer.observe(parent, {
        ...(parent.nodeType === 1
          ? {
              attributeFilter: [
                "aria-disabled",
                "disabled",
                "hidden",
                "inert",
              ],
              attributeOldValue: true,
              attributes: true,
            }
          : {}),
        childList: true,
      });
    }
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

function templateGridNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
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

function templateGridEventPathMatches(
  ownerDocument: Document,
  target: Node,
  actual: readonly EventTarget[],
) {
  const expected = templateGridEventPath(ownerDocument, target);
  const actualView = actual.at(-1);
  const expectedView = expected?.at(-1);
  const hasOwnerDocumentView =
    actualView === expectedView ||
    (typeof actualView === "object" &&
      actualView !== null &&
      "document" in actualView &&
      actualView.document === ownerDocument &&
      "window" in actualView &&
      actualView.window === actualView);
  return Boolean(
    expected &&
      actual.length === expected.length &&
      hasOwnerDocumentView &&
      actual
        .slice(0, -1)
        .every((entry, index) => entry === expected[index]),
  );
}

function templateGridRenderMatches(
  previous: TemplateGridRenderPublication,
  current: TemplateGridRenderPublication,
) {
  return (
    previous.mount === current.mount &&
    previous.templates === current.templates &&
    previous.onPick === current.onPick &&
    previous.busy === current.busy &&
    previous.compact === current.compact &&
    previous.gridClassName === current.gridClassName &&
    previous.entries.length === current.entries.length &&
    previous.entries.every((entry, index) => {
      const next = current.entries[index];
      return (
        next &&
        entry.index === next.index &&
        entry.template === next.template &&
        entry.id === next.id &&
        entry.name === next.name &&
        entry.description === next.description &&
        entry.icon === next.icon &&
        entry.isBusy === next.isBusy &&
        entry.Icon === next.Icon &&
        entry.iconClassName === next.iconClassName
      );
    })
  );
}

function templateGridFactsAreCurrent(
  render: TemplateGridRenderPublication,
) {
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.entries) &&
    render.templates === PICKER_TEMPLATES &&
    render.gridClassName ===
      cn(
        TEMPLATE_GRID_CLASS,
        render.compact
          ? TEMPLATE_GRID_COMPACT_CLASS
          : TEMPLATE_GRID_DEFAULT_CLASS,
      ) &&
    render.entries.length === render.templates.length &&
    render.entries.every((entry, index) => {
      const template = render.templates[index];
      const isBusy = render.busy === entry.id;
      return (
        Object.isFrozen(entry) &&
        entry.index === index &&
        template === entry.template &&
        entry.template.id === entry.id &&
        entry.template.name === entry.name &&
        entry.template.description === entry.description &&
        entry.template.icon === entry.icon &&
        entry.isBusy === isBusy &&
        entry.Icon ===
          (isBusy ? Loader2 : TEMPLATE_ICONS[entry.icon]) &&
        entry.iconClassName === (isBusy ? "animate-spin" : undefined)
      );
    })
  );
}

function templateGridIsEffectivelyEnabled(
  grid: HTMLUListElement,
  button: HTMLButtonElement,
) {
  if (button.disabled || button.matches(":disabled")) return false;
  let reachedGrid = false;
  let current: Element | null = button;
  while (current) {
    if (
      current.hasAttribute("inert") ||
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-disabled") === "true"
    ) {
      return false;
    }
    if (current === grid) reachedGrid = true;
    current = current.parentElement;
  }
  return reachedGrid;
}

function templateGridHasExactAttributes(
  element: Element,
  expected: TemplateGridExpectedAttributes,
) {
  const actual = [...element.attributes];
  return (
    actual.length === expected.length &&
    expected.every(([name, value]) =>
      actual.some(
        (attribute) =>
          attribute.name === name &&
          attribute.localName === name &&
          attribute.prefix === null &&
          (attribute.namespaceURI === null ||
            (name === "xmlns" &&
              attribute.namespaceURI === TEMPLATE_GRID_XMLNS_NAMESPACE)) &&
          attribute.value === value,
      ),
    )
  );
}

function templateGridIconIsExact(
  entry: TemplateGridEntryPublication,
  icon: SVGSVGElement,
) {
  const iconName = entry.isBusy
    ? "loader-circle"
    : entry.icon.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const expectedChildren = entry.isBusy
    ? TEMPLATE_BUSY_ICON_CHILDREN
    : TEMPLATE_ICON_CHILDREN[entry.icon];
  const expectedAttributes = [
    ["xmlns", "http://www.w3.org/2000/svg"],
    ["width", "18"],
    ["height", "18"],
    ["viewBox", "0 0 24 24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    [
      "class",
      `lucide lucide-${iconName}${entry.isBusy ? " animate-spin" : ""}`,
    ],
    ["aria-hidden", "true"],
  ] as const satisfies TemplateGridExpectedAttributes;
  return (
    icon.localName === "svg" &&
    icon.namespaceURI === "http://www.w3.org/2000/svg" &&
    templateGridHasExactAttributes(icon, expectedAttributes) &&
    icon.childNodes.length === expectedChildren.length &&
    icon.children.length === expectedChildren.length &&
    expectedChildren.every(([localName, attributes], index) => {
      const child = icon.children.item(index);
      return (
        child?.localName === localName &&
        child.namespaceURI === "http://www.w3.org/2000/svg" &&
        child.parentNode === icon &&
        child.childNodes.length === 0 &&
        templateGridHasExactAttributes(child, attributes)
      );
    })
  );
}

function templateGridTextIsExact(element: HTMLSpanElement, value: string) {
  const text = element.firstChild;
  return (
    element.childNodes.length === 1 &&
    element.children.length === 0 &&
    text !== null &&
    text.nodeType === element.ownerDocument.defaultView?.Node.TEXT_NODE &&
    text.nodeValue === value
  );
}

function templateGridElementsAreCurrent(
  render: TemplateGridRenderPublication,
  gridOwner: TemplateGridElementOwnerView,
  entryOwners: readonly TemplateGridEntryOwnerSet[],
) {
  const grid = gridOwner.element();
  const ownerWindow = grid?.ownerDocument.defaultView;
  if (
    !ownerWindow ||
    !(grid instanceof ownerWindow.HTMLUListElement) ||
    !grid.isConnected ||
    grid.tagName !== "UL" ||
    grid.className !== render.gridClassName ||
    grid.dataset.testid !== "template-grid" ||
    !templateGridHasExactAttributes(grid, [
      ["class", render.gridClassName],
      ["data-testid", "template-grid"],
    ]) ||
    grid.childNodes.length !== render.entries.length ||
    grid.children.length !== render.entries.length ||
    entryOwners.length !== render.entries.length
  ) {
    return false;
  }

  const elements: Element[] = [grid];
  for (const owned of entryOwners) {
    const entry = owned.entry;
    const card = owned.card.element();
    const button = owned.button.element();
    const icon = owned.icon.element();
    const name = owned.name.element();
    const description = owned.description.element();
    if (
      render.entries[entry.index] !== entry ||
      !(card instanceof ownerWindow.HTMLLIElement) ||
      !(button instanceof ownerWindow.HTMLButtonElement) ||
      !(icon instanceof ownerWindow.SVGSVGElement) ||
      !(name instanceof ownerWindow.HTMLSpanElement) ||
      !(description instanceof ownerWindow.HTMLSpanElement) ||
      !card.isConnected ||
      !button.isConnected ||
      !icon.isConnected ||
      !name.isConnected ||
      !description.isConnected ||
      [card, button, icon, name, description].some(
        (element) => element.ownerDocument !== grid.ownerDocument,
      ) ||
      grid.children.item(entry.index) !== card ||
      card.parentElement !== grid ||
      card.tagName !== "LI" ||
      card.className !== TEMPLATE_CARD_CLASS ||
      !templateGridHasExactAttributes(card, [["class", TEMPLATE_CARD_CLASS]]) ||
      card.childNodes.length !== 1 ||
      card.children.length !== 1 ||
      card.firstElementChild !== button ||
      button.parentElement !== card ||
      button.tagName !== "BUTTON" ||
      button.getAttribute("type") !== "button" ||
      button.type !== "button" ||
      button.disabled !== (render.busy !== null) ||
      button.matches(":disabled") !== (render.busy !== null) ||
      button.getAttribute("aria-busy") !==
        (entry.isBusy ? "true" : null) ||
      button.className !== TEMPLATE_BUTTON_CLASS ||
      button.dataset.testid !== `template-${entry.id}` ||
      !templateGridHasExactAttributes(button, [
        ["type", "button"],
        ...(render.busy !== null
          ? ([["disabled", ""]] as const)
          : []),
        ...(entry.isBusy
          ? ([["aria-busy", "true"]] as const)
          : []),
        ["class", TEMPLATE_BUTTON_CLASS],
        ["data-testid", `template-${entry.id}`],
      ]) ||
      button.childNodes.length !== 3 ||
      button.children.length !== 3
    ) {
      return false;
    }

    const iconContainer = button.children.item(0);
    if (
      !(iconContainer instanceof ownerWindow.HTMLSpanElement) ||
      iconContainer.parentElement !== button ||
      iconContainer.className !== TEMPLATE_ICON_CONTAINER_CLASS ||
      !templateGridHasExactAttributes(iconContainer, [
        ["class", TEMPLATE_ICON_CONTAINER_CLASS],
      ]) ||
      iconContainer.childNodes.length !== 1 ||
      iconContainer.children.length !== 1 ||
      iconContainer.firstElementChild !== icon ||
      icon.parentElement !== iconContainer ||
      !templateGridIconIsExact(entry, icon) ||
      button.children.item(1) !== name ||
      name.parentElement !== button ||
      name.className !== TEMPLATE_NAME_CLASS ||
      !templateGridHasExactAttributes(name, [["class", TEMPLATE_NAME_CLASS]]) ||
      !templateGridTextIsExact(name, entry.name) ||
      button.children.item(2) !== description ||
      description.parentElement !== button ||
      description.className !== TEMPLATE_DESCRIPTION_CLASS ||
      !templateGridHasExactAttributes(description, [
        ["class", TEMPLATE_DESCRIPTION_CLASS],
      ]) ||
      !templateGridTextIsExact(description, entry.description)
    ) {
      return false;
    }
    elements.push(card, button, icon, name, description);
  }
  return new Set(elements).size === elements.length;
}

function createTemplateGridPublication(
  render: TemplateGridRenderPublication,
  cells: TemplateGridPublicationCells,
  requestSuccessor: () => void,
): TemplateGridPublicationSet {
  let currentRuntime: TemplateGridPublicationRuntime | null = null;
  let lastRuntime: TemplateGridPublicationRuntime | null = null;
  let successorRequested = false;

  const onElementChange = (
    owner: TemplateGridElementOwnerView,
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
      cells.successorOf.current === runtime.publication
    ) {
      const replay = runtime.replay();
      if (
        replay &&
        templateGridFactsAreCurrent(render) &&
        templateGridElementsAreCurrent(render, gridOwner, entryOwners) &&
        runtime.publication.grid === gridOwner.element()
      ) {
        cells.replay.current = replay;
        successorRequested = true;
        requestSuccessor();
      }
    }
  };

  const gridOwner = new TemplateGridElementOwner<HTMLUListElement>(
    "grid",
    null,
    onElementChange,
  );
  const entryOwners: readonly TemplateGridEntryOwnerSet[] =
    render.entries.map((entry) =>
      Object.freeze({
        entry,
        card: new TemplateGridElementOwner<HTMLLIElement>(
          "card",
          entry.index,
          onElementChange,
        ),
        button: new TemplateGridElementOwner<HTMLButtonElement>(
          "button",
          entry.index,
          onElementChange,
        ),
        icon: new TemplateGridElementOwner<SVGSVGElement>(
          "icon",
          entry.index,
          onElementChange,
        ),
        name: new TemplateGridElementOwner<HTMLSpanElement>(
          "name",
          entry.index,
          onElementChange,
        ),
        description: new TemplateGridElementOwner<HTMLSpanElement>(
          "description",
          entry.index,
          onElementChange,
        ),
      }),
    );
  const expectedOwners = () =>
    Object.freeze([
      gridOwner,
      ...entryOwners.flatMap((owned) => [
        owned.card,
        owned.button,
        owned.icon,
        owned.name,
        owned.description,
      ]),
    ]);

  const createRuntime = (): TemplateGridPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    const grid = gridOwner.element();
    if (!grid) return null;
    const ownerDocument = grid.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placement = snapshotTemplateGridPlacement(grid);
    if (
      !ownerWindow ||
      !(grid instanceof ownerWindow.HTMLUListElement) ||
      !TRUSTED_EVENT_CURRENT_TARGET ||
      !TRUSTED_EVENT_DEFAULT_PREVENTED ||
      !TRUSTED_EVENT_TARGET ||
      !placement ||
      !templateGridElementsAreCurrent(render, gridOwner, entryOwners)
    ) {
      return null;
    }
    const nativeCurrentTarget = TRUSTED_EVENT_CURRENT_TARGET;
    const nativeWasPrevented = TRUSTED_EVENT_DEFAULT_PREVENTED;
    const nativeTarget = TRUSTED_EVENT_TARGET;
    const predecessor = cells.active.current ?? cells.successorOf.current;
    const predecessorElements =
      predecessor?.render.mount === render.mount
        ? new Set<Element>([
            predecessor.grid,
            ...predecessor.entries.flatMap((entry) => [
              entry.card,
              entry.button,
              entry.icon,
              entry.name,
              entry.description,
            ]),
          ])
        : null;
    const identity = Symbol("template-grid-publication");
    const entries = entryOwners.map((owned) => {
      const card = owned.card.element();
      const button = owned.button.element();
      const icon = owned.icon.element();
      const name = owned.name.element();
      const description = owned.description.element();
      if (
        !(card instanceof ownerWindow.HTMLLIElement) ||
        !(button instanceof ownerWindow.HTMLButtonElement) ||
        !(icon instanceof ownerWindow.SVGSVGElement) ||
        !(name instanceof ownerWindow.HTMLSpanElement) ||
        !(description instanceof ownerWindow.HTMLSpanElement)
      ) {
        throw new Error(
          "Cannot publish TemplateGrid without every committed entry ref",
        );
      }
      const entryIdentity = Symbol("template-grid-entry");
      return Object.freeze({
        identity: entryIdentity,
        entry: owned.entry,
        card,
        button,
        icon,
        name,
        description,
        action: Object.freeze({
          identity: Symbol("template-grid-action"),
          publicationIdentity: identity,
          entryIdentity,
          index: owned.entry.index,
        }),
        targets: templateGridNodes(button),
      });
    });
    if (!templateGridElementsAreCurrent(render, gridOwner, entryOwners)) {
      return null;
    }
    const dom = snapshotTemplateGridDom(grid);
    let retired = false;
    let retirement: Retirement | null = null;
    let layoutRetired = false;
    let established = false;
    let refs: TemplateGridRefReplay[] = [];
    let partialReplayOwners =
      new Set<TemplateGridElementOwnerView>();
    let guard: TemplateGridDomGuard | null = null;
    let nativeClick: TemplateGridNativeClickProof | null = null;
    let reactGridClick: TemplateGridReactClickProof | null = null;
    let reactCardClick: TemplateGridReactEntryClickProof | null = null;
    let reactButtonClick: TemplateGridReactEntryClickProof | null = null;
    let reactBubbleClick: TemplateGridReactEntryClickProof | null = null;
    let nativeBoundaryClick: TemplateGridNativeClickProof | null = null;
    const terminalClickBarriers =
      new Set<TemplateGridTerminalClickBarrier>();
    const terminalBarrierRejects = (event: Event) => {
      for (const barrier of terminalClickBarriers) {
        if (barrier.event !== event) return true;
      }
      return false;
    };

    const publicationOwnsCurrentDom = () => {
      if (retired || cells.active.current !== publication) return false;
      if (
        !templateGridFactsAreCurrent(render) ||
        !templateGridElementsAreCurrent(render, gridOwner, entryOwners) ||
        !publication.publishedDomMatches()
      ) {
        retire("other");
        return false;
      }
      return true;
    };
    const controlForTarget = (target: Node) =>
      entries.find((entry) => entry.targets.includes(target)) ?? null;
    const eventPath = (event: Event, target: Node) => {
      const path = TRUSTED_EVENT_COMPOSED_PATH(event);
      return templateGridEventPathMatches(ownerDocument, target, path)
        ? Object.freeze([...path])
        : null;
    };
    const nativeReactDispatchIsCurrent = (
      native: Event,
      phase:
        | typeof ownerWindow.Event.CAPTURING_PHASE
        | typeof ownerWindow.Event.BUBBLING_PHASE,
    ) => {
      const currentTarget = nativeCurrentTarget(native);
      return (
        native.eventPhase === phase &&
        currentTarget instanceof ownerWindow.Node &&
        currentTarget !== grid &&
        (currentTarget === ownerDocument ||
          currentTarget.ownerDocument === ownerDocument) &&
        currentTarget.contains(grid)
      );
    };
    const exactNativeClick = (
      event: MouseEvent,
      origin: TemplateGridNativeClickProof["origin"],
    ) => {
      const target = nativeTarget(event);
      if (
        !publicationOwnsCurrentDom() ||
        !(event instanceof ownerWindow.MouseEvent) ||
        event.type !== "click" ||
        event.button !== 0 ||
        event.buttons !== 0 ||
        event.detail < 0 ||
        event.eventPhase !== ownerWindow.Event.CAPTURING_PHASE ||
        nativeCurrentTarget(event) !== ownerDocument ||
        !event.bubbles ||
        nativeWasPrevented(event) ||
        !(target instanceof ownerWindow.Node) ||
        !target.isConnected ||
        target.ownerDocument !== ownerDocument
      ) {
        return null;
      }
      const entry = controlForTarget(target);
      const path = eventPath(event, target);
      return entry &&
        templateGridIsEffectivelyEnabled(grid, entry.button) &&
        path &&
        path.includes(entry.button) &&
        path.includes(entry.card) &&
        path.includes(grid) &&
        path.includes(ownerDocument)
        ? Object.freeze({
            attempt: Symbol("template-grid-native-attempt"),
            origin,
            event,
            entry,
            action: entry.action,
            target,
            path,
          })
        : null;
    };
    const onNativeClickCapture = (event: MouseEvent) => {
      if (terminalBarrierRejects(event)) {
        TRUSTED_PREVENT_DEFAULT(event);
        TRUSTED_STOP_IMMEDIATE_PROPAGATION(event);
        return;
      }
      const reactNative = reactGridClick?.native;
      if (
        reactNative &&
        reactNative.origin === "document-root-react-capture" &&
        nativeClick === reactNative &&
        reactNative.event === event &&
        reactNative.target === nativeTarget(event) &&
        nativeCurrentTarget(event) === ownerDocument &&
        event.eventPhase === ownerWindow.Event.CAPTURING_PHASE
      ) {
        nativeBoundaryClick = null;
        return;
      }
      nativeClick = null;
      reactGridClick = null;
      reactCardClick = null;
      reactButtonClick = null;
      reactBubbleClick = null;
      nativeBoundaryClick = null;
      nativeClick = exactNativeClick(event, "document-capture");
    };
    const onNativeClickBubble = (event: MouseEvent) => {
      const proof = reactBubbleClick;
      const capturedNative = nativeClick;
      if (
        proof &&
        capturedNative?.event === event &&
        cells.delivery.current === null &&
        nativeCurrentTarget(event) === ownerDocument &&
        event.eventPhase === ownerWindow.Event.BUBBLING_PHASE &&
        !nativeWasPrevented(event)
      ) {
        const terminal = Object.freeze({
          attempt: capturedNative.attempt,
          react: proof,
          native: capturedNative,
          event,
          ownerDocument,
        });
        const listener = (nextEvent: Event) => {
          if (nextEvent === event) return;
          TRUSTED_PREVENT_DEFAULT(nextEvent);
          TRUSTED_STOP_IMMEDIATE_PROPAGATION(nextEvent);
        };
        const barrier = Object.freeze({ event, listener });
        terminalClickBarriers.add(barrier);
        TRUSTED_ADD_EVENT_LISTENER(
          ownerDocument,
          "click",
          listener,
          true,
        );
        queueMicrotask(() => {
          TRUSTED_REMOVE_EVENT_LISTENER(
            ownerDocument,
            "click",
            listener,
            true,
          );
          terminalClickBarriers.delete(barrier);
          if (nativeClick === capturedNative) {
            deliver(terminal);
          }
          if (nativeClick === capturedNative) {
            nativeClick = null;
            reactGridClick = null;
            reactCardClick = null;
            reactButtonClick = null;
            reactBubbleClick = null;
            nativeBoundaryClick = null;
          }
        });
        return;
      }
      if (nativeClick?.event === event) {
        nativeClick = null;
        reactGridClick = null;
        reactCardClick = null;
        reactButtonClick = null;
        reactBubbleClick = null;
        nativeBoundaryClick = null;
      }
    };
    const nativeBoundaryListeners = entries.map((entry) => {
      const listener = (event: MouseEvent) => {
        nativeBoundaryClick = null;
        if (
          nativeClick?.event === event &&
          reactButtonClick?.native === nativeClick &&
          reactButtonClick.entry === entry &&
          reactButtonClick.action === entry.action &&
          nativeCurrentTarget(event) === entry.button &&
          (event.eventPhase === ownerWindow.Event.CAPTURING_PHASE ||
            event.eventPhase === ownerWindow.Event.AT_TARGET) &&
          nativeTarget(event) === nativeClick.target &&
          templateGridIsEffectivelyEnabled(grid, entry.button) &&
          publicationOwnsCurrentDom()
        ) {
          nativeBoundaryClick = nativeClick;
        }
      };
      return Object.freeze({ entry, listener });
    });
    const addNativeListeners = () => {
      TRUSTED_ADD_EVENT_LISTENER(
        ownerDocument,
        "click",
        onNativeClickCapture,
        true,
      );
      TRUSTED_ADD_EVENT_LISTENER(
        ownerDocument,
        "click",
        onNativeClickBubble,
      );
      for (const { entry, listener } of nativeBoundaryListeners) {
        TRUSTED_ADD_EVENT_LISTENER(
          entry.button,
          "click",
          listener,
          true,
        );
      }
    };
    const releaseNativeListeners = () => {
      TRUSTED_REMOVE_EVENT_LISTENER(
        ownerDocument,
        "click",
        onNativeClickCapture,
        true,
      );
      TRUSTED_REMOVE_EVENT_LISTENER(
        ownerDocument,
        "click",
        onNativeClickBubble,
      );
      for (const { entry, listener } of nativeBoundaryListeners) {
        TRUSTED_REMOVE_EVENT_LISTENER(
          entry.button,
          "click",
          listener,
          true,
        );
      }
      for (const barrier of terminalClickBarriers) {
        TRUSTED_REMOVE_EVENT_LISTENER(
          ownerDocument,
          "click",
          barrier.listener,
          true,
        );
      }
      terminalClickBarriers.clear();
    };
    const publishedDomMatches = () =>
      Boolean(
        guard &&
          guard.isClean() &&
          gridOwner.element() === grid &&
          grid === dom.node &&
          grid.isConnected &&
          templateGridPlacementMatches(ownerDocument, placement) &&
          templateGridDomMatches(dom),
      );
    const release = () => {
      nativeClick = null;
      reactGridClick = null;
      reactCardClick = null;
      reactButtonClick = null;
      reactBubbleClick = null;
      nativeBoundaryClick = null;
      guard?.release();
      guard = null;
      releaseNativeListeners();
    };
    const retire = (reason: Retirement) => {
      if (reason === "layout") layoutRetired = true;
      if (retired) return false;
      retired = true;
      retirement = reason;
      nativeClick = null;
      reactGridClick = null;
      reactCardClick = null;
      reactButtonClick = null;
      reactBubbleClick = null;
      nativeBoundaryClick = null;
      releaseNativeListeners();
      if (cells.active.current === publication) {
        cells.active.current = null;
        cells.successorOf.current = publication;
      }
      if (currentRuntime?.publication === publication) currentRuntime = null;
      queueMicrotask(() => {
        if (cells.replay.current?.source !== publication) release();
      });
      return true;
    };
    const publication: TemplateGridPublication & {
      readonly publishedDomMatches: () => boolean;
    } = Object.freeze({
      identity,
      render,
      grid,
      ownerDocument,
      entries: Object.freeze(entries),
      dom,
      placement,
      retire: () => retire("other"),
      isRetired: () => retired,
      publishedDomMatches,
    });
    const exactReactCaptureProof = (
      event: ReactMouseEvent<HTMLButtonElement>,
      entry: TemplateGridDomPublication,
    ) =>
      Boolean(
        reactCardClick &&
          nativeClick &&
          reactCardClick.native === nativeClick &&
          reactCardClick.event === event &&
          reactCardClick.entry === entry &&
          reactCardClick.action === entry.action &&
          event.nativeEvent === nativeClick.event &&
          nativeCurrentTarget(nativeClick.event) ===
            reactCardClick.dispatchTarget &&
          nativeReactDispatchIsCurrent(
            nativeClick.event,
            ownerWindow.Event.CAPTURING_PHASE,
          ) &&
          event.type === "click" &&
          event.button === 0 &&
          event.buttons === 0 &&
          event.detail === nativeClick.event.detail &&
          event.bubbles &&
          !event.defaultPrevented &&
          event.currentTarget === entry.button &&
          event.target === nativeClick.target &&
          nativeClick.entry === entry &&
          nativeClick.action === entry.action &&
          entry.targets.includes(nativeClick.target),
      );
    const exactReactBubbleProof = (
      event: ReactMouseEvent<HTMLButtonElement>,
      entry: TemplateGridDomPublication,
    ): TemplateGridReactEntryClickProof | null => {
      const dispatchTarget = nativeClick
        ? nativeCurrentTarget(nativeClick.event)
        : null;
      return nativeClick &&
        nativeBoundaryClick === nativeClick &&
        reactButtonClick?.native === nativeClick &&
        reactButtonClick.entry === entry &&
        reactButtonClick.action === entry.action &&
        dispatchTarget instanceof ownerWindow.Node &&
        dispatchTarget === reactButtonClick.dispatchTarget &&
        event.nativeEvent === nativeClick.event &&
        nativeReactDispatchIsCurrent(
          nativeClick.event,
          ownerWindow.Event.BUBBLING_PHASE,
        ) &&
        event.type === "click" &&
        event.button === 0 &&
        event.buttons === 0 &&
        event.detail === nativeClick.event.detail &&
        event.eventPhase === ownerWindow.Event.BUBBLING_PHASE &&
        event.bubbles &&
        !event.defaultPrevented &&
        !nativeWasPrevented(nativeClick.event) &&
        event.currentTarget === entry.button &&
        event.target === nativeClick.target &&
        nativeClick.entry === entry &&
        nativeClick.action === entry.action &&
        entry.targets.includes(nativeClick.target)
        ? Object.freeze({
            event,
            native: nativeClick,
            entry,
            action: entry.action,
            dispatchTarget,
          })
        : null;
    };
    const deliver = (terminal: TemplateGridTerminalClickProof) => {
      if (cells.delivery.current !== null) return false;
      const { react: proof, native, event } = terminal;
      const { entry, action } = proof;
      const finalTarget = nativeTarget(event);
      if (
        !publicationOwnsCurrentDom() ||
        publication.render !== render ||
        render.busy !== null ||
        render.entries[entry.entry.index] !== entry.entry ||
        action.publicationIdentity !== publication.identity ||
        action.entryIdentity !== entry.identity ||
        action.index !== entry.entry.index ||
        !templateGridIsEffectivelyEnabled(grid, entry.button) ||
        terminal.ownerDocument !== ownerDocument ||
        terminal.attempt !== native.attempt ||
        native !== nativeClick ||
        proof.native !== native ||
        native.event !== event ||
        finalTarget !== native.target ||
        !(finalTarget instanceof ownerWindow.Node) ||
        !finalTarget.isConnected ||
        finalTarget.ownerDocument !== ownerDocument ||
        !entry.targets.includes(finalTarget) ||
        !templateGridEventPathMatches(
          ownerDocument,
          finalTarget,
          native.path,
        ) ||
        nativeWasPrevented(event) ||
        nativeWasPrevented(native.event) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedEntries.has(entry) ||
        cells.claimedActions.has(action) ||
        cells.claimedReactEvents.has(proof.event) ||
        cells.claimedNativeEvents.has(event)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedEntries.add(entry);
      cells.claimedActions.add(action);
      cells.claimedReactEvents.add(proof.event);
      cells.claimedNativeEvents.add(event);
      cells.delivery.current = publication.identity;
      publication.retire();
      release();
      try {
        render.onPick(entry.entry.template);
      } finally {
        if (cells.delivery.current === publication.identity) {
          cells.delivery.current = null;
        }
      }
      return true;
    };
    const runtime: TemplateGridPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        refs = expectedOwners().map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish TemplateGrid without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        partialReplayOwners = new Set(
          predecessorElements
            ? refs
                .filter(
                  ({ element }) => !predecessorElements.has(element),
                )
                .map(({ owner }) => owner)
            : [],
        );
        guard = createTemplateGridDomGuard(grid, placement);
        if (
          !guard ||
          cells.active.current ||
          !templateGridElementsAreCurrent(render, gridOwner, entryOwners) ||
          !templateGridPlacementMatches(ownerDocument, placement) ||
          !templateGridDomMatches(dom)
        ) {
          release();
          return false;
        }
        cells.active.current = publication;
        cells.successorOf.current = null;
        cells.replay.current = null;
        addNativeListeners();
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: TemplateGridElementOwnerView,
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
        refs.length === expectedOwners().length &&
        ((layoutRetired &&
          (retirement === "element" || retirement === "layout") &&
          refs.every((entry) => entry.state === "reattached")) ||
          (!layoutRetired &&
            retirement === "element" &&
            partialReplayOwners.size > 0 &&
            refs.every((entry) =>
              partialReplayOwners.has(entry.owner)
                ? entry.state === "reattached"
                : entry.state === "attached",
            ))) &&
        refs.every(
          (entry) => entry.owner.element() === entry.element,
        ) &&
        publishedDomMatches(),
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              dom,
              placement,
              historyIsClean: guard.isClean,
              release,
            })
          : null,
      captureReactClick: (event: ReactMouseEvent<HTMLUListElement>) => {
        const nativeEvent = event.nativeEvent;
        if (terminalBarrierRejects(nativeEvent)) return;
        reactGridClick = null;
        reactCardClick = null;
        reactButtonClick = null;
        reactBubbleClick = null;
        const atOwnerDocument =
          nativeEvent instanceof ownerWindow.MouseEvent &&
          nativeCurrentTarget(nativeEvent) === ownerDocument &&
          nativeEvent.eventPhase === ownerWindow.Event.CAPTURING_PHASE;
        const capturedNative =
          atOwnerDocument
            ? exactNativeClick(
                nativeEvent,
                "document-root-react-capture",
              )
            : nativeClick?.event === nativeEvent
              ? nativeClick
              : null;
        if (capturedNative) nativeClick = capturedNative;
        if (
          !capturedNative ||
          !publicationOwnsCurrentDom() ||
          event.nativeEvent !== capturedNative.event ||
          !nativeReactDispatchIsCurrent(
            capturedNative.event,
            ownerWindow.Event.CAPTURING_PHASE,
          ) ||
          event.type !== "click" ||
          event.button !== 0 ||
          event.buttons !== 0 ||
          event.detail !== capturedNative.event.detail ||
          event.currentTarget !== grid ||
          event.target !== capturedNative.target ||
          !event.bubbles ||
          event.defaultPrevented
        ) {
          return;
        }
        const dispatchTarget = nativeCurrentTarget(capturedNative.event);
        if (
          !(dispatchTarget instanceof ownerWindow.Node) ||
          dispatchTarget === grid
        ) {
          return;
        }
        reactGridClick = Object.freeze({ event, native: capturedNative });
      },
      captureReactCardClick: (
        entryAuthority: TemplateGridEntryPublication,
        event: ReactMouseEvent<HTMLLIElement>,
      ) => {
        if (terminalBarrierRejects(event.nativeEvent)) return;
        reactCardClick = null;
        const entry = publication.entries[entryAuthority.index];
        const gridProof = reactGridClick;
        const dispatchTarget = gridProof
          ? nativeCurrentTarget(gridProof.native.event)
          : null;
        if (
          !entry ||
          !gridProof ||
          !(dispatchTarget instanceof ownerWindow.Node) ||
          !publicationOwnsCurrentDom() ||
          publication.render !== render ||
          render.entries[entryAuthority.index] !== entryAuthority ||
          entry.entry !== entryAuthority ||
          gridProof.event !== event ||
          gridProof.native !== nativeClick ||
          event.nativeEvent !== gridProof.native.event ||
          !nativeReactDispatchIsCurrent(
            gridProof.native.event,
            ownerWindow.Event.CAPTURING_PHASE,
          ) ||
          event.type !== "click" ||
          event.button !== 0 ||
          event.buttons !== 0 ||
          event.detail !== gridProof.native.event.detail ||
          event.currentTarget !== entry.card ||
          event.target !== gridProof.native.target ||
          gridProof.native.entry !== entry ||
          gridProof.native.action !== entry.action ||
          !event.bubbles ||
          event.defaultPrevented
        ) {
          return;
        }
        reactCardClick = Object.freeze({
          event,
          native: gridProof.native,
          entry,
          action: entry.action,
          dispatchTarget,
        });
      },
      captureReactButtonClick: (
        entryAuthority: TemplateGridEntryPublication,
        event: ReactMouseEvent<HTMLButtonElement>,
      ) => {
        if (terminalBarrierRejects(event.nativeEvent)) return;
        reactButtonClick = null;
        const entry = publication.entries[entryAuthority.index];
        const cardProof = reactCardClick;
        if (
          entry &&
          cardProof &&
          render.entries[entryAuthority.index] === entryAuthority &&
          entry.entry === entryAuthority &&
          exactReactCaptureProof(event, entry)
        ) {
          reactButtonClick = Object.freeze({
            event,
            native: cardProof.native,
            entry,
            action: entry.action,
            dispatchTarget: cardProof.dispatchTarget,
          });
        }
      },
      activate: (
        entryAuthority: TemplateGridEntryPublication,
        event: ReactMouseEvent<HTMLButtonElement>,
      ) => {
        if (terminalBarrierRejects(event.nativeEvent)) return false;
        const entry = publication.entries[entryAuthority.index];
        reactBubbleClick = entry ? exactReactBubbleProof(event, entry) : null;
        return reactBubbleClick !== null;
      },
    });
    return runtime;
  };

  const establish = () => {
    if (lastRuntime) {
      if (
        !successorRequested &&
        lastRuntime.isExactReplay() &&
        cells.successorOf.current === lastRuntime.publication
      ) {
        const replay = lastRuntime.replay();
        if (
          replay &&
          templateGridFactsAreCurrent(render) &&
          templateGridElementsAreCurrent(render, gridOwner, entryOwners) &&
          lastRuntime.publication.grid === gridOwner.element()
        ) {
          cells.replay.current = replay;
          successorRequested = true;
          requestSuccessor();
        }
      }
      return;
    }
    if (
      !templateGridFactsAreCurrent(render) ||
      !templateGridElementsAreCurrent(render, gridOwner, entryOwners)
    ) {
      return;
    }
    const grid = gridOwner.element();
    const ownerWindow = grid?.ownerDocument.defaultView;
    if (
      !ownerWindow ||
      !(grid instanceof ownerWindow.HTMLUListElement)
    ) {
      return;
    }
    const replay = cells.replay.current;
    if (replay) {
      const sameFacts = templateGridRenderMatches(
        replay.source.render,
        render,
      );
      const exact =
        sameFacts &&
        replay.source.isRetired() &&
        cells.successorOf.current === replay.source &&
        replay.historyIsClean() &&
        grid === replay.dom.node &&
        templateGridPlacementMatches(grid.ownerDocument, replay.placement) &&
        templateGridDomMatches(replay.dom);
      cells.replay.current = null;
      replay.release();
      if (cells.successorOf.current === replay.source) {
        cells.successorOf.current = null;
      }
      if (sameFacts && !exact) return;
    }
    const runtime = createRuntime();
    if (!runtime) return;
    const previous = cells.active.current;
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
    captureGrid: gridOwner.capture,
    captureClick: (event: ReactMouseEvent<HTMLUListElement>) => {
      currentRuntime?.captureReactClick(event);
    },
    entries: Object.freeze(
      entryOwners.map((owned) =>
        Object.freeze({
          entry: owned.entry,
          captureCard: owned.card.capture,
          captureButton: owned.button.capture,
          captureIcon: owned.icon.capture,
          captureName: owned.name.capture,
          captureDescription: owned.description.capture,
          captureClick: (event: ReactMouseEvent<HTMLLIElement>) => {
            currentRuntime?.captureReactCardClick(owned.entry, event);
          },
          captureButtonClick: (
            event: ReactMouseEvent<HTMLButtonElement>,
          ) => {
            currentRuntime?.captureReactButtonClick(owned.entry, event);
          },
          activate: (event: ReactMouseEvent<HTMLButtonElement>) =>
            currentRuntime?.activate(owned.entry, event) ?? false,
        }),
      ),
    ),
  });
}

/** Grid of template cards; `busy` is the id currently being created (disables the grid). */
export function TemplateGrid({ onPick, busy, compact }: { onPick: (t: Template) => void; busy: string | null; compact?: boolean }) {
  const [mount] = useState(() => Symbol("template-grid-mount"));
  const [cells] = useState<TemplateGridPublicationCells>(() => ({
    active: { current: null },
    successorOf: { current: null },
    replay: { current: null },
    delivery: { current: null },
    claimedPublications: new WeakSet(),
    claimedEntries: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
  }));
  const [, setPublicationRevision] = useState(0);
  const requestSuccessor = useCallback(() => {
    setPublicationRevision((revision) => revision + 1);
  }, []);
  const entries = Object.freeze(
    PICKER_TEMPLATES.map((template, index) => {
      const isBusy = busy === template.id;
      return Object.freeze({
        identity: Symbol("template-grid-entry-render"),
        index,
        template,
        id: template.id,
        name: template.name,
        description: template.description,
        icon: template.icon,
        isBusy,
        Icon: isBusy ? Loader2 : TEMPLATE_ICONS[template.icon],
        iconClassName: isBusy ? "animate-spin" : undefined,
      });
    }),
  );
  const render: TemplateGridRenderPublication = Object.freeze({
    identity: Symbol("template-grid-render"),
    mount,
    templates: PICKER_TEMPLATES,
    onPick,
    busy,
    compact,
    gridClassName: cn(
      TEMPLATE_GRID_CLASS,
      compact ? TEMPLATE_GRID_COMPACT_CLASS : TEMPLATE_GRID_DEFAULT_CLASS,
    ),
    entries,
  });
  const publication = createTemplateGridPublication(
    render,
    cells,
    requestSuccessor,
  );

  useLayoutEffect(() => publication.establish(), [publication]);
  const {
    captureGrid,
    captureClick,
    entries: publishedEntries,
  } = publication;

  return (
    <ul
      ref={captureGrid}
      className={render.gridClassName}
      data-testid="template-grid"
      onClickCapture={captureClick}
    >
      {publishedEntries.map((owned) => {
        const { entry } = owned;
        const Icon = entry.Icon;
        return (
          <li
            key={entry.id}
            ref={owned.captureCard}
            className={TEMPLATE_CARD_CLASS}
            onClickCapture={owned.captureClick}
          >
            <button
              ref={owned.captureButton}
              type="button"
              onClickCapture={(event: ReactMouseEvent<HTMLButtonElement>) => {
                owned.captureButtonClick(event);
              }}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                owned.activate(event);
              }}
              disabled={render.busy !== null}
              aria-busy={entry.isBusy || undefined}
              className={TEMPLATE_BUTTON_CLASS}
              data-testid={`template-${entry.id}`}
            >
              <span className={TEMPLATE_ICON_CONTAINER_CLASS}>
                <Icon
                  ref={owned.captureIcon}
                  size={18}
                  className={entry.iconClassName}
                />
              </span>
              <span ref={owned.captureName} className={TEMPLATE_NAME_CLASS}>
                {entry.name}
              </span>
              <span
                ref={owned.captureDescription}
                className={TEMPLATE_DESCRIPTION_CLASS}
              >
                {entry.description}
              </span>
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

type SearchControlActionKind =
  | "change"
  | "escape"
  | "focus-result"
  | "inline-clear"
  | "empty-clear"
  | "retry";

type SearchControlElementRole =
  | "search-root"
  | "search-icon"
  | "input"
  | "hint"
  | "loading-icon"
  | "inline-clear"
  | "inline-clear-icon"
  | "error-root"
  | "error-message"
  | "retry"
  | "empty-root"
  | "empty-icon"
  | "empty-primary"
  | "empty-secondary"
  | "empty-clear"
  | "result-root"
  | "result-link";

interface SearchControlRenderPublication {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly authority: SearchAuthority;
  readonly user: DashboardProps["user"];
  readonly userId: string;
  readonly query: string;
  readonly trimmed: string;
  readonly results: SearchResults | null;
  readonly serverResults: readonly SearchDoc[] | null;
  readonly request: SearchRequestOwner | null;
  readonly error: SearchError | null;
  readonly searching: boolean;
  readonly pending: boolean;
  readonly filter: Filter;
  readonly filtered: readonly (Doc & { snippet?: string | null })[];
  readonly resultOrder: readonly (Doc & { snippet?: string | null })[];
  readonly setQuery: Dispatch<SetStateAction<string>>;
  readonly retry: () => void;
}

interface SearchControlElementOwnerView {
  readonly role: SearchControlElementRole;
  readonly element: () => Element | null;
}

interface SearchControlRefReplay {
  readonly owner: SearchControlElementOwnerView;
  readonly element: Element;
  state: "attached" | "detached" | "reattached" | "invalid";
}

interface SearchControlActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly kind: SearchControlActionKind;
}

interface SearchControlPublication {
  readonly identity: symbol;
  readonly render: SearchControlRenderPublication;
  readonly ownerDocument: Document;
  readonly searchRoot: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly resultLinks: readonly HTMLAnchorElement[];
  readonly controls: ReadonlyMap<
    SearchControlActionKind,
    SearchPublishedControl
  >;
  readonly roots: readonly SearchControlRootPublication[];
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface SearchPublishedControl {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly element: HTMLInputElement | HTMLButtonElement;
  readonly root: HTMLDivElement;
  readonly targets: readonly Node[];
  readonly paths: ReadonlyMap<Node, readonly EventTarget[]>;
  readonly action: SearchControlActionPublication;
}

interface SearchControlRootPublication {
  readonly role: "search-root" | "error-root" | "empty-root" | "result-root";
  readonly element: HTMLDivElement | HTMLUListElement;
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
}

interface SearchControlReplay {
  readonly source: SearchControlPublication;
  readonly roots: readonly SearchControlRootPublication[];
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface SearchControlDomBarrier {
  readonly attempted: () => boolean;
  readonly noteAttempt: () => void;
  readonly release: () => void;
}

interface SearchControlPublicationCells {
  active: SearchControlPublication | null;
  successorOf: SearchControlPublication | null;
  replay: SearchControlReplay | null;
  domBarrier: SearchControlDomBarrier | null;
  delivery: symbol | null;
  readonly claimedPublications: WeakSet<SearchControlPublication>;
  readonly claimedControls: WeakSet<SearchPublishedControl>;
  readonly claimedActions: WeakSet<SearchControlActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
}

interface SearchNativeEventProof {
  readonly identity: symbol;
  readonly origin: "document-capture" | "document-root-react-capture";
  readonly event: Event;
  readonly publication: SearchControlPublication;
  readonly control: SearchPublishedControl;
  readonly action: SearchControlActionPublication;
  readonly target: Node;
  readonly path: readonly EventTarget[];
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly value: string | null;
  readonly composing: boolean | null;
  readonly key: string | null;
  readonly ctrlKey: boolean | null;
  readonly metaKey: boolean | null;
  readonly altKey: boolean | null;
  readonly shiftKey: boolean | null;
  readonly repeat: boolean | null;
  readonly button: number | null;
  readonly buttons: number | null;
  readonly detail: number | null;
  readonly trusted: boolean | null;
  readonly view: Window | null;
  readonly focusDestination: HTMLAnchorElement | null;
  readonly propagationStopped: () => boolean;
  crossed: boolean;
}

interface SearchReactEventProof {
  readonly event: object;
  readonly native: SearchNativeEventProof;
  readonly dispatchTarget: EventTarget;
  readonly nativePhase: number;
}

interface SearchTerminalEventProof {
  readonly native: SearchNativeEventProof;
  readonly capture: SearchReactEventProof;
  readonly bubble: SearchReactEventProof;
}

interface SearchControlPublicationRuntime {
  readonly publication: SearchControlPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: SearchControlElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly canSettleSynchronousRefReplay: () => boolean;
  readonly settleSynchronousRefReplay: () => boolean;
  readonly isExactReplay: () => boolean;
  readonly replay: () => SearchControlReplay | null;
  readonly captureRoot: (
    role: "search-root" | "error-root" | "empty-root" | "result-root",
    event: ReactSyntheticEvent,
  ) => void;
  readonly captureControl: (
    kind: SearchControlActionKind,
    event: ReactSyntheticEvent,
  ) => void;
  readonly bubbleControl: (
    kind: SearchControlActionKind,
    event: ReactSyntheticEvent,
  ) => void;
}

interface SearchControlPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureSearchRoot: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureSearchIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureInput: (
    element: HTMLInputElement | null,
  ) => void | (() => void);
  readonly captureHint: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureLoadingIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureInlineClear: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureInlineClearIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureErrorRoot: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureErrorMessage: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureRetry: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureEmptyRoot: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureEmptyIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureEmptyPrimary: (
    element: HTMLParagraphElement | null,
  ) => void | (() => void);
  readonly captureEmptySecondary: (
    element: HTMLParagraphElement | null,
  ) => void | (() => void);
  readonly captureEmptyClear: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureResultRoot: (
    element: HTMLUListElement | null,
  ) => void | (() => void);
  readonly captureResultLinks: readonly ((
    element: HTMLAnchorElement | null,
  ) => void | (() => void))[];
  readonly captureRootChange: (
    event: ReactChangeEvent<HTMLDivElement>,
  ) => void;
  readonly captureInputChange: (
    event: ReactChangeEvent<HTMLInputElement>,
  ) => void;
  readonly changeInput: (event: ReactChangeEvent<HTMLInputElement>) => void;
  readonly captureRootKeyDown: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly captureInputKeyDown: (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => void;
  readonly keyDownInput: (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => void;
  readonly captureSearchClick: (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  readonly captureInlineClearClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activateInlineClear: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly captureErrorClick: (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  readonly captureRetryClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activateRetry: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly captureEmptyClick: (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  readonly captureEmptyClearClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activateEmptyClear: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
}

class SearchControlElementOwner<T extends Element>
  implements SearchControlElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: SearchControlElementRole,
    private readonly onChange: (
      owner: SearchControlElementOwnerView,
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

function searchControlNodes(element: HTMLElement): readonly Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node) => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(element);
  return Object.freeze(nodes);
}

function searchControlPaths(
  ownerDocument: Document,
  targets: readonly Node[],
) {
  const entries: [Node, readonly EventTarget[]][] = [];
  for (const target of targets) {
    const path = templateGridEventPath(ownerDocument, target);
    if (!path) return null;
    entries.push([target, path]);
  }
  return new Map(entries);
}

function searchControlRenderIsExact(render: SearchControlRenderPublication) {
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.authority) &&
    render.authority.mount === render.mount &&
    render.authority.user === render.user &&
    render.authority.userId === render.userId &&
    render.user.id === render.userId &&
    render.trimmed === render.query.trim() &&
    (render.results === null ||
      (render.results.authority === render.authority &&
        render.results.query === render.trimmed)) &&
    (render.serverResults === null ||
      (render.results?.documents === render.serverResults &&
        render.trimmed.length >= MIN_QUERY_LENGTH &&
        render.error === null)) &&
    (render.request === null ||
      (render.request.authority === render.authority &&
        render.request.query === render.trimmed)) &&
    render.searching === (render.request !== null) &&
    (render.error === null ||
      (render.error.authority === render.authority &&
        render.error.query === render.trimmed)) &&
    Object.isFrozen(render.resultOrder) &&
    render.resultOrder.length === render.filtered.length &&
    render.resultOrder.every(
      (document, index) => document === render.filtered[index],
    )
  );
}

function searchControlRendersMatch(
  previous: SearchControlRenderPublication,
  current: SearchControlRenderPublication,
) {
  return (
    previous.mount === current.mount &&
    previous.authority === current.authority &&
    previous.user === current.user &&
    previous.userId === current.userId &&
    previous.query === current.query &&
    previous.trimmed === current.trimmed &&
    previous.results === current.results &&
    previous.serverResults === current.serverResults &&
    previous.request === current.request &&
    previous.error === current.error &&
    previous.searching === current.searching &&
    previous.pending === current.pending &&
    previous.filter === current.filter &&
    previous.filtered === current.filtered &&
    previous.resultOrder === current.resultOrder &&
    previous.setQuery === current.setQuery &&
    previous.retry === current.retry &&
    searchControlRenderIsExact(previous) &&
    searchControlRenderIsExact(current)
  );
}

function searchControlExpectedText(render: SearchControlRenderPublication) {
  return {
    error: render.error
      ? `Content search failed: ${render.error.message}. Showing title matches only.`
      : null,
    primary: render.pending
      ? `Searching for "${render.trimmed}"…`
      : render.error
        ? `No title matches for "${render.trimmed}"`
        : `No matches for "${render.trimmed}"`,
    secondary: render.pending
      ? "Looking through titles and content."
      : render.error
        ? "Content results are unavailable. Retry the search above."
        : "Try a different search.",
  };
}

interface SearchControlOwners {
  readonly searchRoot: SearchControlElementOwner<HTMLDivElement>;
  readonly searchIcon: SearchControlElementOwner<SVGSVGElement>;
  readonly input: SearchControlElementOwner<HTMLInputElement>;
  readonly hint: SearchControlElementOwner<HTMLSpanElement>;
  readonly loadingIcon: SearchControlElementOwner<SVGSVGElement>;
  readonly inlineClear: SearchControlElementOwner<HTMLButtonElement>;
  readonly inlineClearIcon: SearchControlElementOwner<SVGSVGElement>;
  readonly errorRoot: SearchControlElementOwner<HTMLDivElement>;
  readonly errorMessage: SearchControlElementOwner<HTMLSpanElement>;
  readonly retry: SearchControlElementOwner<HTMLButtonElement>;
  readonly emptyRoot: SearchControlElementOwner<HTMLDivElement>;
  readonly emptyIcon: SearchControlElementOwner<SVGSVGElement>;
  readonly emptyPrimary: SearchControlElementOwner<HTMLParagraphElement>;
  readonly emptySecondary: SearchControlElementOwner<HTMLParagraphElement>;
  readonly emptyClear: SearchControlElementOwner<HTMLButtonElement>;
  readonly resultRoot: SearchControlElementOwner<HTMLUListElement>;
  readonly resultLinks: readonly {
    readonly index: number;
    readonly document: Doc & { snippet?: string | null };
    readonly owner: SearchControlElementOwner<HTMLAnchorElement>;
  }[];
}

function searchControlHasResults(render: SearchControlRenderPublication) {
  return (
    render.filter !== "trash" &&
    render.trimmed.length > 0 &&
    render.resultOrder.length > 0
  );
}

function searchControlHasEmptyState(render: SearchControlRenderPublication) {
  return (
    render.filter !== "trash" &&
    render.trimmed.length > 0 &&
    render.filtered.length === 0
  );
}

function searchControlHasEmptyClear(render: SearchControlRenderPublication) {
  return searchControlHasEmptyState(render) && !render.pending;
}

function searchControlExpectedOwners(
  render: SearchControlRenderPublication,
  owners: SearchControlOwners,
): readonly SearchControlElementOwnerView[] {
  return Object.freeze([
    owners.searchRoot,
    owners.searchIcon,
    owners.input,
    ...(render.query ? [owners.inlineClear, owners.inlineClearIcon] : [owners.hint]),
    ...(render.searching ? [owners.loadingIcon] : []),
    ...(render.error
      ? [owners.errorRoot, owners.errorMessage, owners.retry]
      : []),
    ...(searchControlHasEmptyState(render)
      ? [
          owners.emptyRoot,
          owners.emptyIcon,
          owners.emptyPrimary,
          owners.emptySecondary,
          ...(searchControlHasEmptyClear(render) ? [owners.emptyClear] : []),
        ]
      : []),
    ...(searchControlHasResults(render)
      ? [
          owners.resultRoot,
          ...owners.resultLinks.map(({ owner }) => owner),
        ]
      : []),
  ]);
}

function searchControlAncestorsAreEnabled(
  element: HTMLElement,
  root: HTMLElement,
) {
  if (!TRUSTED_ELEMENT_HAS_ATTRIBUTE || !TRUSTED_ELEMENT_GET_ATTRIBUTE) {
    return false;
  }
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      TRUSTED_ELEMENT_HAS_ATTRIBUTE(current, "inert") ||
      TRUSTED_ELEMENT_HAS_ATTRIBUTE(current, "hidden") ||
      TRUSTED_ELEMENT_GET_ATTRIBUTE(current, "aria-disabled")?.toLowerCase() ===
        "true"
    ) {
      return false;
    }
    if (current === root) return true;
  }
  return false;
}

function searchControlIsEnabled(
  control: HTMLInputElement | HTMLButtonElement,
  root: HTMLDivElement,
) {
  const ownerWindow = control.ownerDocument.defaultView;
  if (!ownerWindow) return false;
  const disabled =
    control instanceof ownerWindow.HTMLInputElement
      ? TRUSTED_INPUT_DISABLED?.(control)
      : TRUSTED_BUTTON_DISABLED?.(control);
  return (
    disabled === false &&
    searchControlAncestorsAreEnabled(control, root)
  );
}

function searchControlElementsAreExact(
  render: SearchControlRenderPublication,
  owners: SearchControlOwners,
  allowChangedInputValue = false,
) {
  if (
    !TRUSTED_INPUT_VALUE ||
    !TRUSTED_INPUT_DISABLED ||
    !TRUSTED_INPUT_READ_ONLY ||
    !TRUSTED_BUTTON_DISABLED
  ) {
    return false;
  }
  const searchRoot = owners.searchRoot.element();
  const searchIcon = owners.searchIcon.element();
  const input = owners.input.element();
  const hint = owners.hint.element();
  const loadingIcon = owners.loadingIcon.element();
  const inlineClear = owners.inlineClear.element();
  const inlineClearIcon = owners.inlineClearIcon.element();
  const errorRoot = owners.errorRoot.element();
  const errorMessage = owners.errorMessage.element();
  const retry = owners.retry.element();
  const emptyRoot = owners.emptyRoot.element();
  const emptyIcon = owners.emptyIcon.element();
  const emptyPrimary = owners.emptyPrimary.element();
  const emptySecondary = owners.emptySecondary.element();
  const emptyClear = owners.emptyClear.element();
  const resultRoot = owners.resultRoot.element();
  const resultLinks = owners.resultLinks.map(({ owner }) => owner.element());
  const ownerDocument = searchRoot?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (
    !searchControlRenderIsExact(render) ||
    !ownerWindow ||
    !(searchRoot instanceof ownerWindow.HTMLDivElement) ||
    !(searchIcon instanceof ownerWindow.SVGSVGElement) ||
    !(input instanceof ownerWindow.HTMLInputElement) ||
    !searchRoot.isConnected ||
    searchRoot.className !== "relative mx-auto w-full max-w-xl" ||
    searchRoot.children.item(0) !== searchIcon ||
    searchRoot.children.item(1) !== input ||
    searchIcon.parentElement !== searchRoot ||
    searchIcon.getAttribute("width") !== "16" ||
    searchIcon.getAttribute("height") !== "16" ||
    searchIcon.getAttribute("aria-hidden") !== "true" ||
    !searchIcon.classList.contains("lucide-search") ||
    searchIcon.className.baseVal !==
      "lucide lucide-search pointer-events-none absolute left-3 top-2.5 text-ink-4" ||
    input.parentElement !== searchRoot ||
    input.className !==
      cn(
        "input pl-9",
        render.query && render.searching
          ? "pr-16"
          : render.query
            ? "pr-9"
            : "pr-9 sm:pr-12",
      ) ||
    input.getAttribute("placeholder") !== "Search documents" ||
    input.getAttribute("aria-label") !== "Search documents" ||
    input.dataset.testid !== "search" ||
    TRUSTED_INPUT_DISABLED(input) ||
    TRUSTED_INPUT_READ_ONLY(input) ||
    (!allowChangedInputValue && TRUSTED_INPUT_VALUE(input) !== render.query) ||
    !searchControlIsEnabled(input, searchRoot)
  ) {
    return false;
  }

  let searchIndex = 2;
  if (!render.query) {
    if (
      !(hint instanceof ownerWindow.HTMLSpanElement) ||
      hint.parentElement !== searchRoot ||
      searchRoot.children.item(searchIndex++) !== hint ||
      hint.className !==
        "pointer-events-none absolute right-3 top-2 hidden text-ink-4 sm:block" ||
      hint.getAttribute("aria-hidden") !== "true" ||
      hint.children.length !== 1 ||
      hint.firstElementChild?.tagName !== "KBD" ||
      hint.textContent !== "/"
    ) {
      return false;
    }
  } else if (hint !== null) {
    return false;
  }

  if (render.searching) {
    if (
      !(loadingIcon instanceof ownerWindow.SVGSVGElement) ||
      loadingIcon.parentElement !== searchRoot ||
      searchRoot.children.item(searchIndex++) !== loadingIcon ||
      loadingIcon.getAttribute("width") !== "16" ||
      loadingIcon.getAttribute("height") !== "16" ||
      loadingIcon.dataset.testid !== "search-loading" ||
      !loadingIcon.classList.contains("lucide-loader-circle") ||
      !loadingIcon.classList.contains("animate-spin")
    ) {
      return false;
    }
  } else if (loadingIcon !== null) {
    return false;
  }

  if (render.query) {
    if (
      !(inlineClear instanceof ownerWindow.HTMLButtonElement) ||
      !(inlineClearIcon instanceof ownerWindow.SVGSVGElement) ||
      inlineClear.parentElement !== searchRoot ||
      searchRoot.children.item(searchIndex++) !== inlineClear ||
      inlineClear.type !== "button" ||
      inlineClear.className !==
        "absolute right-0 top-0 inline-flex h-9 w-9 items-center justify-center text-ink-3 transition-colors hover:text-ink max-sm:-right-1 max-sm:-top-1 max-sm:h-11 max-sm:w-11" ||
      inlineClear.getAttribute("aria-label") !== "Clear search" ||
      inlineClear.dataset.testid !== "search-clear" ||
      TRUSTED_BUTTON_DISABLED(inlineClear) ||
      inlineClear.children.length !== 1 ||
      inlineClear.firstElementChild !== inlineClearIcon ||
      inlineClearIcon.parentElement !== inlineClear ||
      inlineClearIcon.getAttribute("width") !== "16" ||
      inlineClearIcon.getAttribute("height") !== "16" ||
      !inlineClearIcon.classList.contains("lucide-x") ||
      !searchControlIsEnabled(inlineClear, searchRoot)
    ) {
      return false;
    }
  } else if (inlineClear !== null || inlineClearIcon !== null) {
    return false;
  }
  if (searchRoot.children.length !== searchIndex) return false;

  if (render.error) {
    const text = searchControlExpectedText(render);
    if (
      !(errorRoot instanceof ownerWindow.HTMLDivElement) ||
      !(errorMessage instanceof ownerWindow.HTMLSpanElement) ||
      !(retry instanceof ownerWindow.HTMLButtonElement) ||
      !errorRoot.isConnected ||
      errorRoot.ownerDocument !== ownerDocument ||
      errorRoot.className !==
        "mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40" ||
      errorRoot.getAttribute("role") !== "alert" ||
      errorRoot.getAttribute("aria-atomic") !== "true" ||
      errorRoot.dataset.testid !== "search-error" ||
      errorRoot.children.length !== 2 ||
      errorRoot.firstElementChild !== errorMessage ||
      errorMessage.parentElement !== errorRoot ||
      errorMessage.className !== "min-w-0 flex-1" ||
      errorMessage.textContent?.trim() !== text.error ||
      errorRoot.lastElementChild !== retry ||
      retry.parentElement !== errorRoot ||
      retry.type !== "button" ||
      retry.className !== "btn btn-sm btn-outline shrink-0" ||
      TRUSTED_BUTTON_DISABLED(retry) !== render.searching ||
      retry.getAttribute("aria-busy") !==
        (render.searching ? "true" : null) ||
      retry.textContent?.trim() !==
        (render.searching ? "Retrying…" : "Retry") ||
      (!render.searching && !searchControlIsEnabled(retry, errorRoot))
    ) {
      return false;
    }
  } else if (errorRoot !== null || errorMessage !== null || retry !== null) {
    return false;
  }

  if (searchControlHasEmptyState(render)) {
    const text = searchControlExpectedText(render);
    const hasClear = searchControlHasEmptyClear(render);
    if (
      !(emptyRoot instanceof ownerWindow.HTMLDivElement) ||
      !(emptyIcon instanceof ownerWindow.SVGSVGElement) ||
      !(emptyPrimary instanceof ownerWindow.HTMLParagraphElement) ||
      !(emptySecondary instanceof ownerWindow.HTMLParagraphElement) ||
      !emptyRoot.isConnected ||
      emptyRoot.ownerDocument !== ownerDocument ||
      emptyRoot.className !==
        "rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center" ||
      emptyRoot.dataset.testid !== "empty-state" ||
      emptyRoot.children.length !== (hasClear ? 4 : 3) ||
      emptyRoot.children.item(0) !== emptyIcon ||
      emptyIcon.parentElement !== emptyRoot ||
      emptyIcon.getAttribute("width") !== "28" ||
      emptyIcon.getAttribute("height") !== "28" ||
      !emptyIcon.classList.contains("lucide-file-text") ||
      emptyIcon.className.baseVal !==
        "lucide lucide-file-text mx-auto mb-3 text-ink-4" ||
      emptyRoot.children.item(1) !== emptyPrimary ||
      emptyPrimary.parentElement !== emptyRoot ||
      emptyPrimary.className !== "text-sm font-medium text-ink-2" ||
      emptyPrimary.textContent?.trim() !== text.primary ||
      emptyRoot.children.item(2) !== emptySecondary ||
      emptySecondary.parentElement !== emptyRoot ||
      emptySecondary.className !== "mt-1 text-sm text-ink-3" ||
      emptySecondary.textContent?.trim() !== text.secondary
    ) {
      return false;
    }
    if (hasClear) {
      if (
        !(emptyClear instanceof ownerWindow.HTMLButtonElement) ||
        emptyRoot.children.item(3) !== emptyClear ||
        emptyClear.parentElement !== emptyRoot ||
        emptyClear.type !== "button" ||
        emptyClear.className !==
          "mt-3 text-sm font-medium text-accent hover:underline" ||
        emptyClear.dataset.testid !== "empty-state-clear-search" ||
        emptyClear.textContent?.trim() !== "Clear search" ||
        TRUSTED_BUTTON_DISABLED(emptyClear) ||
        !searchControlIsEnabled(emptyClear, emptyRoot)
      ) {
        return false;
      }
    } else if (emptyClear !== null) {
      return false;
    }
  } else if (
    emptyRoot !== null ||
    emptyIcon !== null ||
    emptyPrimary !== null ||
    emptySecondary !== null ||
    emptyClear !== null
  ) {
    return false;
  }

  if (searchControlHasResults(render)) {
    if (
      !(resultRoot instanceof ownerWindow.HTMLUListElement) ||
      !resultRoot.isConnected ||
      resultRoot.ownerDocument !== ownerDocument ||
      resultRoot.className !== "grid gap-3 sm:grid-cols-2 lg:grid-cols-3" ||
      resultRoot.dataset.testid !== "document-list" ||
      resultRoot.children.length !== render.resultOrder.length ||
      owners.resultLinks.length !== render.resultOrder.length
    ) {
      return false;
    }
    for (const entry of owners.resultLinks) {
      const item: Element | null = resultRoot.children.item(entry.index);
      const link = entry.owner.element();
      if (
        entry.document !== render.resultOrder[entry.index] ||
        !(item instanceof ownerWindow.HTMLLIElement) ||
        !(link instanceof ownerWindow.HTMLAnchorElement) ||
        item.parentElement !== resultRoot ||
        item.className !== "group relative min-w-0" ||
        item.dataset.testid !== "search-result" ||
        item.children.item(0) !== link ||
        link.parentElement !== item ||
        link.ownerDocument !== ownerDocument ||
        link.getAttribute("href") !== `/d/${entry.document.id}` ||
        link.className !==
          "flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md" ||
        link.dataset.testid !== "document-card" ||
        !searchControlAncestorsAreEnabled(link, resultRoot)
      ) {
        return false;
      }
    }
  } else if (
    resultRoot !== null ||
    owners.resultLinks.length !== 0 ||
    resultLinks.some((link) => link !== null)
  ) {
    return false;
  }

  const expectedOwners = searchControlExpectedOwners(render, owners);
  const elements = expectedOwners.map((owner) => owner.element());
  return (
    elements.every(
      (element): element is Element =>
        Boolean(
          element &&
            element.isConnected &&
            element.ownerDocument === ownerDocument,
        ),
    ) && new Set(elements).size === elements.length
  );
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

function searchControlRootsMatch(
  ownerDocument: Document,
  roots: readonly SearchControlRootPublication[],
) {
  return roots.every(
    ({ element, dom, placement }) =>
      element.isConnected &&
      element.ownerDocument === ownerDocument &&
      dom.node === element &&
      templateGridDomMatches(dom) &&
      searchControlPlacementMatches(ownerDocument, placement),
  );
}

interface SearchControlDomGuard {
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

function createSearchControlDomGuard(
  ownerDocument: Document,
  roots: readonly SearchControlRootPublication[],
  onMutation: () => void,
  allowReactInputNameReplay: (
    records: readonly MutationRecord[],
  ) => boolean,
): SearchControlDomGuard | null {
  const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const rootElements = roots.map(({ element }) => element);
  const placements = roots.flatMap(({ placement }) => placement);
  const relevant = (mutation: MutationRecord) => {
    if (
      rootElements.some(
        (root) => mutation.target === root || root.contains(mutation.target),
      )
    ) {
      return true;
    }
    if (mutation.type === "attributes") {
      return (
        (mutation.attributeName === "aria-disabled" ||
          mutation.attributeName === "disabled" ||
          mutation.attributeName === "hidden" ||
          mutation.attributeName === "inert" ||
          mutation.attributeName === "readonly") &&
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
    const relevantRecords = records.filter(relevant);
    if (
      !changed &&
      relevantRecords.length > 0 &&
      !allowReactInputNameReplay(relevantRecords)
    ) {
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

function searchControlPathMatches(
  expected: readonly EventTarget[],
  actual: readonly EventTarget[],
  ownerDocument: Document,
) {
  const actualView = actual.at(-1);
  const expectedView = expected.at(-1);
  const hasOwnerDocumentView =
    actualView === expectedView ||
    (typeof actualView === "object" &&
      actualView !== null &&
      "document" in actualView &&
      actualView.document === ownerDocument &&
      "window" in actualView &&
      actualView.window === actualView);
  return (
    actual.length === expected.length &&
    hasOwnerDocumentView &&
    actual
      .slice(0, -1)
      .every((entry, index) => entry === expected[index])
  );
}

function searchControlNativeSupportIsAvailable() {
  return Boolean(
    TRUSTED_EVENT_CURRENT_TARGET &&
      TRUSTED_EVENT_DEFAULT_PREVENTED &&
      TRUSTED_EVENT_TARGET &&
      TRUSTED_EVENT_TYPE &&
      TRUSTED_EVENT_PHASE &&
      TRUSTED_EVENT_BUBBLES &&
      TRUSTED_EVENT_CANCELABLE &&
      TRUSTED_EVENT_CANCEL_BUBBLE &&
      TRUSTED_KEYBOARD_KEY &&
      TRUSTED_KEYBOARD_CTRL &&
      TRUSTED_KEYBOARD_META &&
      TRUSTED_KEYBOARD_ALT &&
      TRUSTED_KEYBOARD_SHIFT &&
      TRUSTED_KEYBOARD_REPEAT &&
      TRUSTED_KEYBOARD_COMPOSING &&
      TRUSTED_MOUSE_BUTTON &&
      TRUSTED_MOUSE_BUTTONS &&
      TRUSTED_UI_DETAIL &&
      TRUSTED_INPUT_VALUE &&
      TRUSTED_FOCUS &&
      TRUSTED_BLUR,
  );
}

function armSearchControlDomBarrier(
  cells: SearchControlPublicationCells,
  ownerDocument: Document,
  roots: readonly SearchControlRootPublication[],
  requestSuccessor: () => void,
) {
  cells.domBarrier?.release();
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) return;
  let attempted = false;
  let successorQueued = false;
  let released = false;
  const noteAttempt = () => {
    if (released || attempted) return;
    attempted = true;
    successorQueued = true;
    queueMicrotask(() => {
      if (
        released ||
        !successorQueued ||
        cells.domBarrier !== barrier
      ) {
        return;
      }
      successorQueued = false;
      requestSuccessor();
    });
  };
  const listener = (event: Event) => {
    if (
      released ||
      !TRUSTED_EVENT_TARGET ||
      !TRUSTED_EVENT_TYPE ||
      !["input", "change", "keydown", "click"].includes(
        TRUSTED_EVENT_TYPE(event),
      )
    ) {
      return;
    }
    const target = TRUSTED_EVENT_TARGET(event);
    if (
      target !== null &&
      TRUSTED_IS_PROTOTYPE_OF(ownerWindow.Node.prototype, target) &&
      (target as Node).ownerDocument === ownerDocument &&
      roots.some(({ element }) => element.contains(target as Node))
    ) {
      noteAttempt();
    }
  };
  const barrier: SearchControlDomBarrier = Object.freeze({
    attempted: () => attempted,
    noteAttempt,
    release: () => {
      if (released) return;
      released = true;
      successorQueued = false;
      for (const type of ["input", "change", "keydown", "click"]) {
        TRUSTED_REMOVE_EVENT_LISTENER(ownerDocument, type, listener, true);
      }
    },
  });
  for (const type of ["input", "change", "keydown", "click"]) {
    TRUSTED_ADD_EVENT_LISTENER(ownerDocument, type, listener, true);
  }
  cells.domBarrier = barrier;
  cells.replay?.release();
  cells.replay = null;
}

function createSearchControlPublication(
  render: SearchControlRenderPublication,
  cells: SearchControlPublicationCells,
  requestSuccessor: () => void,
): SearchControlPublicationSet {
  let currentRuntime: SearchControlPublicationRuntime | null = null;
  let lastRuntime: SearchControlPublicationRuntime | null = null;
  let successorRequested = false;
  let synchronousRefCheckRuntime: SearchControlPublicationRuntime | null = null;

  const onElementChange = (
    owner: SearchControlElementOwnerView,
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
      const retiringRuntime = currentRuntime;
      if (
        element === null &&
        retiringRuntime?.canSettleSynchronousRefReplay()
      ) {
        if (!synchronousRefCheckRuntime) {
          synchronousRefCheckRuntime = retiringRuntime;
          queueMicrotask(() => {
            if (synchronousRefCheckRuntime !== retiringRuntime) return;
            synchronousRefCheckRuntime = null;
            if (
              currentRuntime === retiringRuntime &&
              retiringRuntime.settleSynchronousRefReplay()
            ) {
              return;
            }
            retiringRuntime.retireForElement();
            if (currentRuntime === retiringRuntime) currentRuntime = null;
          });
        }
      } else {
        retiringRuntime?.retireForElement();
        if (currentRuntime === retiringRuntime) currentRuntime = null;
      }
    }
    if (
      element !== null &&
      currentRuntime?.settleSynchronousRefReplay()
    ) {
      synchronousRefCheckRuntime = null;
    }
    if (
      !successorRequested &&
      runtime?.isExactReplay() &&
      cells.successorOf === runtime.publication
    ) {
      const replay = runtime.replay();
      if (
        replay &&
        searchControlElementsAreExact(render, owners) &&
        replay.source.searchRoot === owners.searchRoot.element()
      ) {
        cells.replay = replay;
        successorRequested = true;
        requestSuccessor();
      }
    }
  };

  const owners: SearchControlOwners = {
    searchRoot: new SearchControlElementOwner<HTMLDivElement>(
      "search-root",
      onElementChange,
    ),
    searchIcon: new SearchControlElementOwner<SVGSVGElement>(
      "search-icon",
      onElementChange,
    ),
    input: new SearchControlElementOwner<HTMLInputElement>(
      "input",
      onElementChange,
    ),
    hint: new SearchControlElementOwner<HTMLSpanElement>(
      "hint",
      onElementChange,
    ),
    loadingIcon: new SearchControlElementOwner<SVGSVGElement>(
      "loading-icon",
      onElementChange,
    ),
    inlineClear: new SearchControlElementOwner<HTMLButtonElement>(
      "inline-clear",
      onElementChange,
    ),
    inlineClearIcon: new SearchControlElementOwner<SVGSVGElement>(
      "inline-clear-icon",
      onElementChange,
    ),
    errorRoot: new SearchControlElementOwner<HTMLDivElement>(
      "error-root",
      onElementChange,
    ),
    errorMessage: new SearchControlElementOwner<HTMLSpanElement>(
      "error-message",
      onElementChange,
    ),
    retry: new SearchControlElementOwner<HTMLButtonElement>(
      "retry",
      onElementChange,
    ),
    emptyRoot: new SearchControlElementOwner<HTMLDivElement>(
      "empty-root",
      onElementChange,
    ),
    emptyIcon: new SearchControlElementOwner<SVGSVGElement>(
      "empty-icon",
      onElementChange,
    ),
    emptyPrimary: new SearchControlElementOwner<HTMLParagraphElement>(
      "empty-primary",
      onElementChange,
    ),
    emptySecondary: new SearchControlElementOwner<HTMLParagraphElement>(
      "empty-secondary",
      onElementChange,
    ),
    emptyClear: new SearchControlElementOwner<HTMLButtonElement>(
      "empty-clear",
      onElementChange,
    ),
    resultRoot: new SearchControlElementOwner<HTMLUListElement>(
      "result-root",
      onElementChange,
    ),
    resultLinks: searchControlHasResults(render)
      ? render.resultOrder.map((document, index) => ({
          index,
          document,
          owner: new SearchControlElementOwner<HTMLAnchorElement>(
            "result-link",
            onElementChange,
          ),
        }))
      : [],
  };

  const createRuntime = (): SearchControlPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    if (
      !searchControlNativeSupportIsAvailable() ||
      !searchControlElementsAreExact(render, owners)
    ) {
      return null;
    }
    const searchRoot = owners.searchRoot.element();
    const input = owners.input.element();
    if (!searchRoot || !input) return null;
    const ownerDocument = searchRoot.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const addOwnerWindowListener = ownerWindow
      ? capturePrototypeMethod<
          (
            target: EventTarget,
            type: string,
            listener: (event: Event) => void,
            options?: boolean | AddEventListenerOptions,
          ) => void
        >(ownerWindow.EventTarget.prototype, "addEventListener")
      : null;
    const removeOwnerWindowListener = ownerWindow
      ? capturePrototypeMethod<
          (
            target: EventTarget,
            type: string,
            listener: (event: Event) => void,
            options?: boolean | EventListenerOptions,
          ) => void
        >(ownerWindow.EventTarget.prototype, "removeEventListener")
      : null;
    const preventOwnerDefault = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "preventDefault",
        )
      : null;
    const stopOwnerPropagation = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "stopPropagation",
        )
      : null;
    const stopOwnerImmediatePropagation = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "stopImmediatePropagation",
        )
      : null;
    const resultKeyboardAuthority =
      ownerWindow && searchControlHasResults(render)
        ? captureSearchResultKeyboardAuthority(ownerWindow)
        : null;
    if (
      !ownerWindow ||
      !addOwnerWindowListener ||
      !removeOwnerWindowListener ||
      !preventOwnerDefault ||
      !stopOwnerPropagation ||
      !stopOwnerImmediatePropagation ||
      (searchControlHasResults(render) && !resultKeyboardAuthority) ||
      !(searchRoot instanceof ownerWindow.HTMLDivElement) ||
      !(input instanceof ownerWindow.HTMLInputElement)
    ) {
      return null;
    }
    let resultKeyboardAuthorityHistoryIsClean = true;
    const resultKeyboardAuthorityIsCurrent = () => {
      if (!resultKeyboardAuthority) return false;
      resultKeyboardAuthorityHistoryIsClean =
        resultKeyboardAuthorityHistoryIsClean &&
        ownerDocument.defaultView === ownerWindow &&
        resultKeyboardAuthority.isCurrent();
      return resultKeyboardAuthorityHistoryIsClean;
    };
    const rootEntries: [
      SearchControlRootPublication["role"],
      HTMLDivElement | HTMLUListElement | null,
    ][] = [
      ["search-root", searchRoot],
      [
        "error-root",
        render.error
          ? (owners.errorRoot.element() as HTMLDivElement | null)
          : null,
      ],
      [
        "empty-root",
        searchControlHasEmptyState(render)
          ? (owners.emptyRoot.element() as HTMLDivElement | null)
          : null,
      ],
      [
        "result-root",
        searchControlHasResults(render)
          ? owners.resultRoot.element()
          : null,
      ],
    ];
    const roots: SearchControlRootPublication[] = [];
    for (const [role, element] of rootEntries) {
      if (!element) continue;
      const placement = searchControlPlacement(element);
      if (!placement) return null;
      roots.push(
        Object.freeze({
          role,
          element,
          dom: snapshotTemplateGridDom(element),
          placement,
        }),
      );
    }
    const publishedRoots = Object.freeze(roots);
    if (!searchControlRootsMatch(ownerDocument, publishedRoots)) return null;

    const identity = Symbol("dashboard-search-controls-publication");
    const resultLinks = owners.resultLinks.map(({ owner }) => owner.element());
    if (
      searchControlHasResults(render) &&
      resultLinks.some(
        (link) => !(link instanceof ownerWindow.HTMLAnchorElement),
      )
    ) {
      return null;
    }
    const publishedResultLinks = Object.freeze(
      resultLinks.filter(
        (link): link is HTMLAnchorElement =>
          link instanceof ownerWindow.HTMLAnchorElement,
      ),
    );
    const controls = new Map<SearchControlActionKind, SearchPublishedControl>();
    const addControl = (
      kind: SearchControlActionKind,
      element: HTMLInputElement | HTMLButtonElement,
      root: HTMLDivElement,
    ) => {
      const targets =
        element instanceof ownerWindow.HTMLInputElement
          ? Object.freeze([element] as Node[])
          : searchControlNodes(element);
      const paths = searchControlPaths(ownerDocument, targets);
      if (!paths) return false;
      const controlIdentity = Symbol(`dashboard-search-${kind}-control`);
      const control: SearchPublishedControl = Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        element,
        root,
        targets,
        paths,
        action: Object.freeze({
          identity: Symbol(`dashboard-search-${kind}-action`),
          publicationIdentity: identity,
          controlIdentity,
          kind,
        }),
      });
      controls.set(kind, control);
      return true;
    };
    if (
      !addControl("change", input, searchRoot) ||
      !addControl("escape", input, searchRoot)
    ) {
      return null;
    }
    if (
      searchControlHasResults(render) &&
      !addControl("focus-result", input, searchRoot)
    ) {
      return null;
    }
    const focusWindowTarget = searchControlHasResults(render)
      ? (controls.get("focus-result")?.paths.get(input)?.at(-1) ?? null)
      : null;
    if (searchControlHasResults(render) && !focusWindowTarget) {
      return null;
    }
    const addFocusWindowEventListener = focusWindowTarget
      ? focusWindowTarget.addEventListener.bind(focusWindowTarget)
      : null;
    const removeFocusWindowEventListener = focusWindowTarget
      ? focusWindowTarget.removeEventListener.bind(focusWindowTarget)
      : null;
    const inlineClear = owners.inlineClear.element();
    if (
      render.query &&
      (!(inlineClear instanceof ownerWindow.HTMLButtonElement) ||
        !addControl("inline-clear", inlineClear, searchRoot))
    ) {
      return null;
    }
    const errorRoot = owners.errorRoot.element();
    const retry = owners.retry.element();
    if (
      render.error &&
      (!(errorRoot instanceof ownerWindow.HTMLDivElement) ||
        !(retry instanceof ownerWindow.HTMLButtonElement) ||
        !addControl("retry", retry, errorRoot))
    ) {
      return null;
    }
    const emptyRoot = owners.emptyRoot.element();
    const emptyClear = owners.emptyClear.element();
    if (
      searchControlHasEmptyClear(render) &&
      (!(emptyRoot instanceof ownerWindow.HTMLDivElement) ||
        !(emptyClear instanceof ownerWindow.HTMLButtonElement) ||
        !addControl("empty-clear", emptyClear, emptyRoot))
    ) {
      return null;
    }

    let retired = false;
    let retirement: Retirement | null = null;
    let established = false;
    let partialReplayWindowOpen = false;
    let synchronousRefReplayPending = false;
    let refs: SearchControlRefReplay[] = [];
    let guard: SearchControlDomGuard | null = null;
    let nativeProof: SearchNativeEventProof | null = null;
    let reactRootProof: SearchReactEventProof | null = null;
    let reactCaptureProof: SearchReactEventProof | null = null;
    let reactBubbleProof: SearchReactEventProof | null = null;
    let nativeBoundaryProof: SearchNativeEventProof | null = null;
    let terminal: SearchTerminalEventProof | null = null;
    let windowTerminal: SearchTerminalEventProof | null = null;
    let terminalWindowListener: Readonly<{
      target: EventTarget;
      type: string;
    }> | null = null;
    let focusWindowListenerAttached = false;
    const publication: SearchControlPublication = Object.freeze({
      identity,
      render,
      ownerDocument,
      searchRoot,
      input,
      resultLinks: publishedResultLinks,
      controls,
      roots: publishedRoots,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const removeTerminalWindowListener = () => {
      if (!terminalWindowListener) return;
      removeOwnerWindowListener(
        terminalWindowListener.target,
        terminalWindowListener.type,
        onNativeWindowBubble,
      );
      terminalWindowListener = null;
    };
    const clearEventProof = (proof?: SearchNativeEventProof) => {
      if (proof && nativeProof !== proof) return;
      removeTerminalWindowListener();
      nativeProof = null;
      reactRootProof = null;
      reactCaptureProof = null;
      reactBubbleProof = null;
      nativeBoundaryProof = null;
      terminal = null;
      windowTerminal = null;
    };
    const releaseGuard = () => {
      guard?.release();
      guard = null;
    };
    const retire = (reason: Retirement) => {
      if (retired) return false;
      retired = true;
      retirement = reason;
      clearEventProof();
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
      return true;
    };
    const publicationOwnsCurrentDom = (allowChangedInputValue = false) => {
      if (
        retired ||
        cells.active !== publication ||
        publication.render !== render ||
        !searchControlRenderIsExact(render) ||
        !searchControlElementsAreExact(
          render,
          owners,
          allowChangedInputValue,
        ) ||
        !searchControlRootsMatch(ownerDocument, publishedRoots) ||
        !guard?.unchanged()
      ) {
        retire("other");
        return false;
      }
      return true;
    };
    const controlForNative = (
      event: Event,
    ): SearchPublishedControl | null => {
      if (!TRUSTED_EVENT_TYPE || !TRUSTED_EVENT_TARGET) return null;
      const type = TRUSTED_EVENT_TYPE(event);
      const target = TRUSTED_EVENT_TARGET(event);
      if (!(target instanceof ownerWindow.Node)) return null;
      if ((type === "input" || type === "change") && target === input) {
        return controls.get("change") ?? null;
      }
      if (type === "keydown" && target === input) {
        if (
          resultKeyboardAuthority &&
          resultKeyboardAuthorityIsCurrent() &&
          TRUSTED_IS_PROTOTYPE_OF(
            ownerWindow.KeyboardEvent.prototype,
            event,
          )
        ) {
          const key = resultKeyboardAuthority.key(event);
          if (key === "ArrowDown" || key === "ArrowUp") {
            return controls.get("focus-result") ?? null;
          }
        }
        return TRUSTED_KEYBOARD_KEY?.(event) === "Escape"
          ? (controls.get("escape") ?? null)
          : null;
      }
      if (type !== "click") return null;
      for (const kind of [
        "inline-clear",
        "empty-clear",
        "retry",
      ] as const) {
        const control = controls.get(kind);
        if (control?.targets.includes(target)) return control;
      }
      return null;
    };
    const exactNativeEvent = (
      event: Event,
      origin: SearchNativeEventProof["origin"],
      control: SearchPublishedControl,
    ): SearchNativeEventProof | null => {
      const isResultFocus = control.action.kind === "focus-result";
      if (
        !TRUSTED_EVENT_CURRENT_TARGET ||
        !TRUSTED_EVENT_DEFAULT_PREVENTED ||
        !TRUSTED_EVENT_TARGET ||
        !TRUSTED_EVENT_TYPE ||
        !TRUSTED_EVENT_PHASE ||
        !TRUSTED_EVENT_BUBBLES ||
        !TRUSTED_EVENT_CANCELABLE ||
        !TRUSTED_EVENT_CANCEL_BUBBLE ||
        !TRUSTED_INPUT_VALUE ||
        !TRUSTED_IS_PROTOTYPE_OF(ownerWindow.Event.prototype, event) ||
        (isResultFocus && !resultKeyboardAuthorityIsCurrent()) ||
        !publicationOwnsCurrentDom(control.action.kind === "change")
      ) {
        return null;
      }
      const type =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.type(event)
          : TRUSTED_EVENT_TYPE(event);
      const target =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.target(event)
          : TRUSTED_EVENT_TARGET(event);
      if (!(target instanceof ownerWindow.Node)) return null;
      const expectedPath = control.paths.get(target);
      const path =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.composedPath(event)
          : TRUSTED_EVENT_COMPOSED_PATH(event);
      const currentTarget =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.currentTarget(event)
          : TRUSTED_EVENT_CURRENT_TARGET(event);
      const phase =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.phase(event)
          : TRUSTED_EVENT_PHASE(event);
      const bubbles =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.bubbles(event)
          : TRUSTED_EVENT_BUBBLES(event);
      const cancelable =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.cancelable(event)
          : TRUSTED_EVENT_CANCELABLE(event);
      const defaultPrevented =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.defaultPrevented(event)
          : TRUSTED_EVENT_DEFAULT_PREVENTED(event);
      const cancelBubble =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.cancelBubble(event)
          : TRUSTED_EVENT_CANCEL_BUBBLE(event);
      if (
        !expectedPath ||
        !searchControlPathMatches(expectedPath, path, ownerDocument) ||
        currentTarget !== ownerDocument ||
        phase !== ownerWindow.Event.CAPTURING_PHASE ||
        !bubbles ||
        defaultPrevented ||
        cancelBubble ||
        control.publicationIdentity !== identity ||
        control.action.publicationIdentity !== identity ||
        control.action.controlIdentity !== control.identity ||
        !searchControlIsEnabled(control.element, control.root)
      ) {
        return null;
      }

      let value: string | null = null;
      let composing: boolean | null = null;
      let key: string | null = null;
      let ctrlKey: boolean | null = null;
      let metaKey: boolean | null = null;
      let altKey: boolean | null = null;
      let shiftKey: boolean | null = null;
      let repeat: boolean | null = null;
      let button: number | null = null;
      let buttons: number | null = null;
      let detail: number | null = null;
      let trusted: boolean | null = null;
      let view: Window | null = null;
      let focusDestination: HTMLAnchorElement | null = null;
      if (control.action.kind === "change") {
        if (type !== "input" && type !== "change") return null;
        value = TRUSTED_INPUT_VALUE(input);
        if (
          type === "input" &&
          TRUSTED_INPUT_COMPOSING &&
          "InputEvent" in ownerWindow &&
          TRUSTED_IS_PROTOTYPE_OF(ownerWindow.InputEvent.prototype, event)
        ) {
          composing = TRUSTED_INPUT_COMPOSING(event);
        }
      } else if (
        control.action.kind === "escape" ||
        control.action.kind === "focus-result"
      ) {
        if (
          type !== "keydown" ||
          !TRUSTED_IS_PROTOTYPE_OF(ownerWindow.KeyboardEvent.prototype, event)
        ) {
          return null;
        }
        if (control.action.kind === "escape") {
          if (
            !TRUSTED_KEYBOARD_KEY ||
            !TRUSTED_KEYBOARD_CTRL ||
            !TRUSTED_KEYBOARD_META ||
            !TRUSTED_KEYBOARD_ALT ||
            !TRUSTED_KEYBOARD_SHIFT ||
            !TRUSTED_KEYBOARD_REPEAT ||
            !TRUSTED_KEYBOARD_COMPOSING ||
            !TRUSTED_UI_DETAIL
          ) {
            return null;
          }
          key = TRUSTED_KEYBOARD_KEY(event);
          ctrlKey = TRUSTED_KEYBOARD_CTRL(event);
          metaKey = TRUSTED_KEYBOARD_META(event);
          altKey = TRUSTED_KEYBOARD_ALT(event);
          shiftKey = TRUSTED_KEYBOARD_SHIFT(event);
          repeat = TRUSTED_KEYBOARD_REPEAT(event);
          composing = TRUSTED_KEYBOARD_COMPOSING(event);
          detail = TRUSTED_UI_DETAIL(event);
          if (key !== "Escape" || repeat || composing) return null;
        } else {
          if (
            !resultKeyboardAuthority ||
            !resultKeyboardAuthorityIsCurrent() ||
            !resultKeyboardAuthority.trusted.matches(event) ||
            resultKeyboardAuthority.trusted.read(event) !== true ||
            !cancelable ||
            resultKeyboardAuthority.activeElement.read(ownerDocument) !== input
          ) {
            return null;
          }
          key = resultKeyboardAuthority.key(event);
          ctrlKey = resultKeyboardAuthority.ctrlKey(event);
          metaKey = resultKeyboardAuthority.metaKey(event);
          altKey = resultKeyboardAuthority.altKey(event);
          shiftKey = resultKeyboardAuthority.shiftKey(event);
          repeat = resultKeyboardAuthority.repeat(event);
          composing = resultKeyboardAuthority.composing(event);
          trusted = true;
          view = resultKeyboardAuthority.view(event);
          focusDestination =
            key === "ArrowDown"
              ? (publication.resultLinks[0] ?? null)
              : key === "ArrowUp"
                ? (publication.resultLinks.at(-1) ?? null)
                : null;
          if (
            !focusDestination ||
            ctrlKey ||
            metaKey ||
            altKey ||
            shiftKey ||
            repeat ||
            composing ||
            view !== ownerWindow
          ) {
            return null;
          }
        }
      } else {
        if (
          type !== "click" ||
          !TRUSTED_IS_PROTOTYPE_OF(ownerWindow.MouseEvent.prototype, event) ||
          !TRUSTED_MOUSE_BUTTON ||
          !TRUSTED_MOUSE_BUTTONS ||
          !TRUSTED_UI_DETAIL
        ) {
          return null;
        }
        button = TRUSTED_MOUSE_BUTTON(event);
        buttons = TRUSTED_MOUSE_BUTTONS(event);
        detail = TRUSTED_UI_DETAIL(event);
        if (button !== 0 || buttons !== 0 || detail < 0) return null;
      }
      if (
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          event,
          "stopPropagation",
        ) ||
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          event,
          "stopImmediatePropagation",
        )
      ) {
        return null;
      }
      let propagationStopped = false;
      const stopPropagation = () => {
        propagationStopped = true;
        if (isResultFocus && resultKeyboardAuthority) {
          resultKeyboardAuthority.stopPropagation(event);
        } else {
          stopOwnerPropagation(event);
        }
      };
      const stopImmediatePropagation = () => {
        propagationStopped = true;
        if (isResultFocus && resultKeyboardAuthority) {
          resultKeyboardAuthority.stopImmediatePropagation(event);
        } else {
          stopOwnerImmediatePropagation(event);
        }
      };
      if (
        !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopPropagation", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: stopPropagation,
        }) ||
        !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopImmediatePropagation", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: stopImmediatePropagation,
        })
      ) {
        return null;
      }
      return {
        identity: Symbol("dashboard-search-native-event"),
        origin,
        event,
        publication,
        control,
        action: control.action,
        target,
        path: Object.freeze([...path]),
        type,
        bubbles,
        cancelable,
        value,
        composing,
        key,
        ctrlKey,
        metaKey,
        altKey,
        shiftKey,
        repeat,
        button,
        buttons,
        detail,
        trusted,
        view,
        focusDestination,
        propagationStopped: () => propagationStopped,
        crossed: false,
      };
    };

    const blockCrossedEvent = (event: Event) => {
      preventOwnerDefault(event);
      stopOwnerImmediatePropagation(event);
    };
    const beginNativeEvent = (
      event: Event,
      origin: SearchNativeEventProof["origin"],
    ) => {
      if (nativeProof) {
        if (nativeProof.event === event) return nativeProof;
        const crossedControl = controlForNative(event);
        if (crossedControl) {
          if (
            nativeProof.action.kind === "focus-result" ||
            crossedControl.action.kind === "focus-result"
          ) {
            nativeProof.crossed = true;
          }
          cells.attemptedNativeEvents.add(event);
          if (
            nativeProof.action.kind !== "focus-result" &&
            crossedControl.action.kind !== "focus-result"
          ) {
            blockCrossedEvent(event);
          }
        }
        return null;
      }
      const control = controlForNative(event);
      if (!control) return null;
      if (cells.attemptedNativeEvents.has(event)) {
        if (control.action.kind !== "focus-result") blockCrossedEvent(event);
        return null;
      }
      cells.attemptedNativeEvents.add(event);
      const proof = exactNativeEvent(event, origin, control);
      if (!proof) {
        cells.domBarrier?.noteAttempt();
        return null;
      }
      nativeProof = proof;
      queueMicrotask(() => {
        if (nativeProof !== proof || terminal !== null) return;
        clearEventProof(proof);
        publication.retire();
        requestSuccessor();
      });
      return proof;
    };

    const nativeEventStillMatches = (proof: SearchNativeEventProof) => {
      if (proof.action.kind === "focus-result") {
        if (
          !resultKeyboardAuthority ||
          !resultKeyboardAuthorityIsCurrent() ||
          !resultKeyboardAuthority.trusted.matches(proof.event) ||
          resultKeyboardAuthority.trusted.read(proof.event) !== proof.trusted ||
          resultKeyboardAuthority.target(proof.event) !== proof.target ||
          resultKeyboardAuthority.type(proof.event) !== proof.type ||
          resultKeyboardAuthority.bubbles(proof.event) !== proof.bubbles ||
          resultKeyboardAuthority.cancelable(proof.event) !== proof.cancelable ||
          resultKeyboardAuthority.key(proof.event) !== proof.key ||
          resultKeyboardAuthority.ctrlKey(proof.event) !== proof.ctrlKey ||
          resultKeyboardAuthority.metaKey(proof.event) !== proof.metaKey ||
          resultKeyboardAuthority.altKey(proof.event) !== proof.altKey ||
          resultKeyboardAuthority.shiftKey(proof.event) !== proof.shiftKey ||
          resultKeyboardAuthority.repeat(proof.event) !== proof.repeat ||
          resultKeyboardAuthority.composing(proof.event) !== proof.composing ||
          resultKeyboardAuthority.view(proof.event) !== proof.view ||
          resultKeyboardAuthority.activeElement.read(ownerDocument) !== input ||
          proof.crossed
        ) {
          return false;
        }
        const destination =
          proof.key === "ArrowDown"
            ? publication.resultLinks[0]
            : publication.resultLinks.at(-1);
        const resultRoot = owners.resultRoot.element();
        return Boolean(
          destination &&
            destination === proof.focusDestination &&
            resultRoot &&
            searchControlAncestorsAreEnabled(destination, resultRoot),
        );
      }
      if (
        !TRUSTED_EVENT_TARGET ||
        !TRUSTED_EVENT_TYPE ||
        !TRUSTED_EVENT_BUBBLES ||
        !TRUSTED_EVENT_CANCELABLE ||
        TRUSTED_EVENT_TARGET(proof.event) !== proof.target ||
        TRUSTED_EVENT_TYPE(proof.event) !== proof.type ||
        TRUSTED_EVENT_BUBBLES(proof.event) !== proof.bubbles ||
        TRUSTED_EVENT_CANCELABLE(proof.event) !== proof.cancelable
      ) {
        return false;
      }
      if (proof.crossed) return false;
      if (proof.action.kind === "escape") {
        return Boolean(
          TRUSTED_KEYBOARD_KEY &&
            TRUSTED_KEYBOARD_CTRL &&
            TRUSTED_KEYBOARD_META &&
            TRUSTED_KEYBOARD_ALT &&
            TRUSTED_KEYBOARD_SHIFT &&
            TRUSTED_KEYBOARD_REPEAT &&
            TRUSTED_KEYBOARD_COMPOSING &&
            TRUSTED_UI_DETAIL &&
            TRUSTED_KEYBOARD_KEY(proof.event) === proof.key &&
            TRUSTED_KEYBOARD_CTRL(proof.event) === proof.ctrlKey &&
            TRUSTED_KEYBOARD_META(proof.event) === proof.metaKey &&
            TRUSTED_KEYBOARD_ALT(proof.event) === proof.altKey &&
            TRUSTED_KEYBOARD_SHIFT(proof.event) === proof.shiftKey &&
            TRUSTED_KEYBOARD_REPEAT(proof.event) === proof.repeat &&
            TRUSTED_KEYBOARD_COMPOSING(proof.event) === proof.composing &&
            TRUSTED_UI_DETAIL(proof.event) === proof.detail,
        );
      }
      if (
        proof.action.kind === "inline-clear" ||
        proof.action.kind === "empty-clear" ||
        proof.action.kind === "retry"
      ) {
        return Boolean(
          TRUSTED_MOUSE_BUTTON &&
            TRUSTED_MOUSE_BUTTONS &&
            TRUSTED_UI_DETAIL &&
            TRUSTED_MOUSE_BUTTON(proof.event) === proof.button &&
            TRUSTED_MOUSE_BUTTONS(proof.event) === proof.buttons &&
            TRUSTED_UI_DETAIL(proof.event) === proof.detail,
        );
      }
      if (
        proof.type === "input" &&
        proof.composing !== null &&
        TRUSTED_INPUT_COMPOSING
      ) {
        return TRUSTED_INPUT_COMPOSING(proof.event) === proof.composing;
      }
      return true;
    };

    const expectedReactName = (kind: SearchControlActionKind) =>
      kind === "change"
        ? "onChange"
        : kind === "escape" || kind === "focus-result"
          ? "onKeyDown"
          : "onClick";
    const expectedReactType = (kind: SearchControlActionKind) =>
      kind === "change"
        ? "change"
        : kind === "escape" || kind === "focus-result"
          ? "keydown"
          : "click";
    const reactEventMatches = (
      event: object,
      proof: SearchNativeEventProof,
      currentTarget: Element,
    ): SearchReactEventProof | null => {
      if (
        !TRUSTED_EVENT_CURRENT_TARGET ||
        !TRUSTED_EVENT_PHASE ||
        !TRUSTED_EVENT_DEFAULT_PREVENTED ||
        searchControlOwnValue(event, "_reactName") !==
          expectedReactName(proof.action.kind) ||
        searchControlOwnValue(event, "type") !==
          expectedReactType(proof.action.kind) ||
        searchControlOwnValue(event, "nativeEvent") !== proof.event ||
        searchControlOwnValue(event, "target") !== proof.target ||
        searchControlOwnValue(event, "currentTarget") !== currentTarget ||
        searchControlOwnValue(event, "bubbles") !== proof.bubbles
      ) {
        return null;
      }
      const isResultFocus = proof.action.kind === "focus-result";
      const dispatchTarget =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.currentTarget(proof.event)
          : TRUSTED_EVENT_CURRENT_TARGET(proof.event);
      const nativePhase =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.phase(proof.event)
          : TRUSTED_EVENT_PHASE(proof.event);
      const nativeDefaultPrevented =
        isResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.defaultPrevented(proof.event)
          : TRUSTED_EVENT_DEFAULT_PREVENTED(proof.event);
      if (
        !dispatchTarget ||
        nativePhase === ownerWindow.Event.NONE ||
        searchControlOwnValue(event, "defaultPrevented") !==
          nativeDefaultPrevented ||
        (dispatchTarget !== ownerDocument &&
          (!(dispatchTarget instanceof ownerWindow.Node) ||
            dispatchTarget.ownerDocument !== ownerDocument ||
            !dispatchTarget.contains(searchRoot)))
      ) {
        return null;
      }
      if (
        proof.action.kind === "escape" ||
        proof.action.kind === "focus-result"
      ) {
        const reactComposing = searchControlOwnValue(event, "isComposing");
        if (
          searchControlOwnValue(event, "key") !== proof.key ||
          searchControlOwnValue(event, "ctrlKey") !== proof.ctrlKey ||
          searchControlOwnValue(event, "metaKey") !== proof.metaKey ||
          searchControlOwnValue(event, "altKey") !== proof.altKey ||
          searchControlOwnValue(event, "shiftKey") !== proof.shiftKey ||
          searchControlOwnValue(event, "repeat") !== proof.repeat ||
          (reactComposing !== SEARCH_CONTROL_MISSING &&
            reactComposing !== proof.composing)
        ) {
          return null;
        }
        if (
          proof.action.kind === "focus-result" &&
          (searchControlOwnValue(event, "cancelable") !== proof.cancelable ||
            searchControlOwnValue(event, "isTrusted") !== proof.trusted ||
            searchControlOwnValue(event, "view") !== proof.view)
        ) {
          return null;
        }
      } else if (proof.action.kind !== "change") {
        if (
          searchControlOwnValue(event, "button") !== proof.button ||
          searchControlOwnValue(event, "buttons") !== proof.buttons ||
          searchControlOwnValue(event, "detail") !== proof.detail
        ) {
          return null;
        }
      }
      return Object.freeze({ event, native: proof, dispatchTarget, nativePhase });
    };

    const rootForAction = (kind: SearchControlActionKind) =>
      kind === "retry"
        ? "error-root"
        : kind === "empty-clear"
          ? "empty-root"
          : "search-root";
    const startReactWrapper = (
      event: object,
      allowCurrent: object | null,
    ) => {
      if (event === allowCurrent) return true;
      if (
        cells.claimedReactEvents.has(event) ||
        cells.attemptedReactEvents.has(event)
      ) {
        return false;
      }
      cells.attemptedReactEvents.add(event);
      return true;
    };
    const captureRoot = (
      role: "search-root" | "error-root" | "empty-root" | "result-root",
      event: ReactSyntheticEvent,
    ) => {
      if (!event || typeof event !== "object") return;
      if (!startReactWrapper(event, null)) return;
      const nativeEvent = searchControlOwnValue(event, "nativeEvent");
      if (!(nativeEvent instanceof ownerWindow.Event)) return;
      const candidate = controlForNative(nativeEvent);
      const candidateIsResultFocus =
        candidate?.action.kind === "focus-result";
      const nativeCurrentTarget =
        candidateIsResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.currentTarget(nativeEvent)
          : TRUSTED_EVENT_CURRENT_TARGET?.(nativeEvent);
      const nativePhase =
        candidateIsResultFocus && resultKeyboardAuthority
          ? resultKeyboardAuthority.phase(nativeEvent)
          : TRUSTED_EVENT_PHASE?.(nativeEvent);
      const proof =
        nativeProof?.event === nativeEvent
          ? nativeProof
          : nativeCurrentTarget === ownerDocument &&
              nativePhase === ownerWindow.Event.CAPTURING_PHASE
            ? beginNativeEvent(nativeEvent, "document-root-react-capture")
            : null;
      if (
        !proof ||
        rootForAction(proof.action.kind) !== role ||
        reactRootProof ||
        !publicationOwnsCurrentDom(proof.action.kind === "change")
      ) {
        return;
      }
      const root = proof.control.root;
      const matched = reactEventMatches(event, proof, root);
      if (matched) reactRootProof = matched;
    };
    const captureControl = (
      kind: SearchControlActionKind,
      event: ReactSyntheticEvent,
    ) => {
      if (
        !event ||
        typeof event !== "object" ||
        !nativeProof ||
        nativeProof.action.kind !== kind ||
        !reactRootProof ||
        reactCaptureProof ||
        !startReactWrapper(event, reactRootProof.event)
      ) {
        return;
      }
      const matched = reactEventMatches(
        event,
        nativeProof,
        nativeProof.control.element,
      );
      if (
        matched &&
        matched.event === reactRootProof.event &&
        matched.dispatchTarget === reactRootProof.dispatchTarget &&
        matched.nativePhase === reactRootProof.nativePhase
      ) {
        reactCaptureProof = matched;
      }
    };
    const bubbleControl = (
      kind: SearchControlActionKind,
      event: ReactSyntheticEvent,
    ) => {
      if (
        !event ||
        typeof event !== "object" ||
        !nativeProof ||
        nativeProof.action.kind !== kind ||
        !reactCaptureProof ||
        reactBubbleProof ||
        !startReactWrapper(event, reactCaptureProof.event)
      ) {
        return;
      }
      const matched = reactEventMatches(
        event,
        nativeProof,
        nativeProof.control.element,
      );
      if (
        matched &&
        matched.nativePhase === ownerWindow.Event.BUBBLING_PHASE &&
        (matched.event !== reactCaptureProof.event ||
          (matched.dispatchTarget === reactCaptureProof.dispatchTarget &&
            matched.nativePhase === reactCaptureProof.nativePhase))
      ) {
        reactBubbleProof = matched;
      }
    };

    const releaseClaim = (proof: SearchNativeEventProof) => {
      cells.claimedPublications.delete(publication);
      cells.claimedControls.delete(proof.control);
      cells.claimedActions.delete(proof.action);
    };
    const authenticateTerminal = (proof: SearchNativeEventProof) => {
      const capture = reactCaptureProof;
      const bubble = reactBubbleProof;
      if (
        !capture ||
        !bubble ||
        nativeBoundaryProof !== proof ||
        cells.claimedPublications.has(publication) ||
        cells.claimedControls.has(proof.control) ||
        cells.claimedActions.has(proof.action) ||
        cells.claimedNativeEvents.has(proof.event) ||
        cells.claimedReactEvents.has(capture.event) ||
        cells.claimedReactEvents.has(bubble.event)
      ) {
        return null;
      }
      if (
        !publicationOwnsCurrentDom(proof.action.kind === "change") ||
        !nativeEventStillMatches(proof) ||
        !searchControlIsEnabled(proof.control.element, proof.control.root)
      ) {
        return null;
      }
      return Object.freeze({
        native: proof,
        capture,
        bubble,
      });
    };
    const claimTerminal = (proof: SearchTerminalEventProof) => {
      const native = proof.native;
      if (
        cells.claimedPublications.has(publication) ||
        cells.claimedControls.has(native.control) ||
        cells.claimedActions.has(native.action) ||
        cells.claimedNativeEvents.has(native.event) ||
        cells.claimedReactEvents.has(proof.capture.event) ||
        cells.claimedReactEvents.has(proof.bubble.event)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedControls.add(native.control);
      cells.claimedActions.add(native.action);
      cells.claimedNativeEvents.add(native.event);
      cells.claimedReactEvents.add(proof.capture.event);
      cells.claimedReactEvents.add(proof.bubble.event);
      return true;
    };
    const deliver = (proof: SearchTerminalEventProof) => {
      const native = proof.native;
      if (
        terminal !== proof ||
        nativeProof !== native ||
        cells.delivery !== null ||
        cells.active !== publication ||
        !cells.claimedPublications.has(publication) ||
        !cells.claimedControls.has(native.control) ||
        !cells.claimedActions.has(native.action) ||
        !cells.claimedNativeEvents.has(native.event) ||
        !cells.claimedReactEvents.has(proof.capture.event) ||
        !cells.claimedReactEvents.has(proof.bubble.event) ||
        !nativeEventStillMatches(native) ||
        !publicationOwnsCurrentDom(native.action.kind === "change") ||
        !searchControlIsEnabled(native.control.element, native.control.root)
      ) {
        releaseClaim(native);
        clearEventProof(native);
        return false;
      }
      cells.delivery = publication.identity;
      publication.retire();
      try {
        if (native.action.kind === "change") {
          if (native.value === null || native.value === render.query) return false;
          render.setQuery(native.value);
        } else if (native.action.kind === "escape") {
          if (render.query) render.setQuery("");
          else {
            TRUSTED_BLUR?.(publication.input);
            requestSuccessor();
          }
        } else if (native.action.kind === "focus-result") {
          if (
            !resultKeyboardAuthority ||
            !native.focusDestination ||
            !resultKeyboardAuthorityIsCurrent()
          ) {
            return false;
          }
          resultKeyboardAuthority.preventDefault(native.event);
          resultKeyboardAuthority.focus(native.focusDestination, {
            preventScroll: true,
          });
          requestSuccessor();
        } else if (
          native.action.kind === "inline-clear" ||
          native.action.kind === "empty-clear"
        ) {
          render.setQuery("");
          TRUSTED_FOCUS?.(publication.input);
        } else {
          if (!render.error || render.searching) return false;
          render.retry();
        }
      } finally {
        if (cells.delivery === publication.identity) cells.delivery = null;
      }
      return true;
    };
    const rejectTerminal = (proof: SearchTerminalEventProof) => {
      releaseClaim(proof.native);
      clearEventProof(proof.native);
      publication.retire();
      requestSuccessor();
    };
    const proofCurrentTarget = (proof: SearchNativeEventProof) =>
      proof.action.kind === "focus-result" && resultKeyboardAuthority
        ? resultKeyboardAuthority.currentTarget(proof.event)
        : TRUSTED_EVENT_CURRENT_TARGET?.(proof.event);
    const proofPhase = (proof: SearchNativeEventProof) =>
      proof.action.kind === "focus-result" && resultKeyboardAuthority
        ? resultKeyboardAuthority.phase(proof.event)
        : TRUSTED_EVENT_PHASE?.(proof.event);
    const proofDefaultPrevented = (proof: SearchNativeEventProof) =>
      proof.action.kind === "focus-result" && resultKeyboardAuthority
        ? resultKeyboardAuthority.defaultPrevented(proof.event)
        : TRUSTED_EVENT_DEFAULT_PREVENTED?.(proof.event);
    const proofCancelBubble = (proof: SearchNativeEventProof) =>
      proof.action.kind === "focus-result" && resultKeyboardAuthority
        ? resultKeyboardAuthority.cancelBubble(proof.event)
        : TRUSTED_EVENT_CANCEL_BUBBLE?.(proof.event);
    const proofComposedPath = (proof: SearchNativeEventProof) =>
      proof.action.kind === "focus-result" && resultKeyboardAuthority
        ? resultKeyboardAuthority.composedPath(proof.event)
        : TRUSTED_EVENT_COMPOSED_PATH(proof.event);
    const settleTerminal = (proof: SearchTerminalEventProof) => {
      const native = proof.native;
      if (
        terminal !== proof ||
        windowTerminal !== proof ||
        nativeProof !== native ||
        cells.delivery !== null ||
        cells.active !== publication ||
        !TRUSTED_EVENT_CURRENT_TARGET ||
        !TRUSTED_EVENT_PHASE ||
        !TRUSTED_EVENT_DEFAULT_PREVENTED ||
        !TRUSTED_EVENT_CANCEL_BUBBLE ||
        proofCurrentTarget(native) !== null ||
        proofPhase(native) !== ownerWindow.Event.NONE ||
        proofDefaultPrevented(native) ||
        proofCancelBubble(native) ||
        native.propagationStopped() ||
        !nativeEventStillMatches(native) ||
        !publicationOwnsCurrentDom(native.action.kind === "change") ||
        !searchControlIsEnabled(native.control.element, native.control.root) ||
        !claimTerminal(proof)
      ) {
        rejectTerminal(proof);
        return;
      }
      if (native.action.kind === "escape") {
        preventOwnerDefault(native.event);
      }
      if (!deliver(proof)) {
        publication.retire();
        requestSuccessor();
      }
    };

    const onNativeCapture = (event: Event) => {
      beginNativeEvent(event, "document-capture");
    };
    const onNativeBubble = (event: Event) => {
      const proof = nativeProof;
      if (
        !proof ||
        proof.event !== event ||
        !TRUSTED_EVENT_CURRENT_TARGET ||
        !TRUSTED_EVENT_PHASE ||
        !TRUSTED_EVENT_DEFAULT_PREVENTED ||
        !TRUSTED_EVENT_CANCEL_BUBBLE ||
        proofCurrentTarget(proof) !== ownerDocument ||
        proofPhase(proof) !== ownerWindow.Event.BUBBLING_PHASE ||
        proofDefaultPrevented(proof) ||
        proofCancelBubble(proof)
      ) {
        return;
      }
      const authenticated = authenticateTerminal(proof);
      if (!authenticated) return;
      const windowTarget =
        authenticated.native.path[authenticated.native.path.length - 1];
      if (
        !windowTarget ||
        (authenticated.native.action.kind === "focus-result"
          ? !focusWindowTarget ||
            !searchControlPathMatches(
              [focusWindowTarget],
              [windowTarget],
              ownerDocument,
            )
          : !TRUSTED_IS_PROTOTYPE_OF(
              ownerWindow.EventTarget.prototype,
              windowTarget,
            ))
      ) {
        return;
      }
      terminal = authenticated;
      if (authenticated.native.action.kind === "focus-result") {
        if (
          !focusWindowListenerAttached ||
          !focusWindowTarget ||
          !searchControlPathMatches(
            [focusWindowTarget],
            [windowTarget],
            ownerDocument,
          ) ||
          authenticated.native.type !== "keydown"
        ) {
          terminal = null;
          return;
        }
      } else {
        removeTerminalWindowListener();
        addOwnerWindowListener(
          windowTarget,
          authenticated.native.type,
          onNativeWindowBubble,
        );
        terminalWindowListener = Object.freeze({
          target: windowTarget,
          type: authenticated.native.type,
        });
      }
      queueMicrotask(() => {
        if (terminal === authenticated) settleTerminal(authenticated);
      });
    };
    const onNativeWindowBubble = (event: Event) => {
      const authenticated = terminal;
      const currentTarget = authenticated
        ? proofCurrentTarget(authenticated.native)
        : null;
      if (
        !authenticated ||
        authenticated.native.event !== event ||
        !TRUSTED_EVENT_CURRENT_TARGET ||
        !TRUSTED_EVENT_PHASE ||
        !TRUSTED_EVENT_DEFAULT_PREVENTED ||
        !TRUSTED_EVENT_CANCEL_BUBBLE ||
        (authenticated.native.action.kind === "focus-result"
          ? !focusWindowTarget ||
            !currentTarget ||
            !searchControlPathMatches(
              [focusWindowTarget],
              [currentTarget],
              ownerDocument,
            )
          : currentTarget !== terminalWindowListener?.target) ||
        proofPhase(authenticated.native) !== ownerWindow.Event.BUBBLING_PHASE ||
        proofDefaultPrevented(authenticated.native) ||
        proofCancelBubble(authenticated.native) ||
        authenticated.native.propagationStopped() ||
        !searchControlPathMatches(
          authenticated.native.path,
          proofComposedPath(authenticated.native),
          ownerDocument,
        )
      ) {
        return;
      }
      windowTerminal = authenticated;
    };
    const addFocusWindowListener = () => {
      if (
        focusWindowListenerAttached ||
        !resultKeyboardAuthority ||
        !focusWindowTarget ||
        !addFocusWindowEventListener ||
        !resultKeyboardAuthorityIsCurrent() ||
        cells.active !== publication ||
        resultKeyboardAuthority.activeElement.read(ownerDocument) !== input
      ) {
        return;
      }
      addFocusWindowEventListener("keydown", onNativeWindowBubble);
      focusWindowListenerAttached = true;
    };
    const removeFocusWindowListener = () => {
      if (!focusWindowListenerAttached) return;
      removeFocusWindowEventListener?.("keydown", onNativeWindowBubble);
      focusWindowListenerAttached = false;
    };
    const onInputFocus = () => addFocusWindowListener();
    const onInputBlur = () => removeFocusWindowListener();
    const boundaryListeners = [...controls.values()].map((control) => {
      const type =
        control.action.kind === "change"
          ? ["input", "change"]
          : control.action.kind === "escape" ||
              control.action.kind === "focus-result"
            ? ["keydown"]
            : ["click"];
      const listener = (event: Event) => {
        if (
          nativeProof?.event === event &&
          nativeProof.control === control &&
          proofCurrentTarget(nativeProof) === control.element &&
          (proofPhase(nativeProof) ===
            ownerWindow.Event.CAPTURING_PHASE ||
            proofPhase(nativeProof) === ownerWindow.Event.AT_TARGET) &&
          publicationOwnsCurrentDom(control.action.kind === "change") &&
          searchControlIsEnabled(control.element, control.root) &&
          (control.action.kind !== "focus-result" ||
            (resultKeyboardAuthorityIsCurrent() &&
              resultKeyboardAuthority?.activeElement.read(ownerDocument) ===
                input))
        ) {
          nativeBoundaryProof = nativeProof;
        }
      };
      return Object.freeze({ control, type, listener });
    });
    const addNativeListeners = () => {
      for (const type of ["input", "change", "keydown", "click"]) {
        TRUSTED_ADD_EVENT_LISTENER(
          ownerDocument,
          type,
          onNativeCapture,
          true,
        );
        TRUSTED_ADD_EVENT_LISTENER(ownerDocument, type, onNativeBubble);
      }
      for (const { control, type, listener } of boundaryListeners) {
        for (const eventType of type) {
          TRUSTED_ADD_EVENT_LISTENER(
            control.element,
            eventType,
            listener,
            true,
          );
        }
      }
      if (resultKeyboardAuthority) {
        TRUSTED_ADD_EVENT_LISTENER(input, "focus", onInputFocus);
        TRUSTED_ADD_EVENT_LISTENER(input, "blur", onInputBlur);
        addFocusWindowListener();
      }
    };
    const releaseNativeListeners = () => {
      for (const type of ["input", "change", "keydown", "click"]) {
        TRUSTED_REMOVE_EVENT_LISTENER(
          ownerDocument,
          type,
          onNativeCapture,
          true,
        );
        TRUSTED_REMOVE_EVENT_LISTENER(ownerDocument, type, onNativeBubble);
      }
      removeTerminalWindowListener();
      if (resultKeyboardAuthority) {
        TRUSTED_REMOVE_EVENT_LISTENER(input, "focus", onInputFocus);
        TRUSTED_REMOVE_EVENT_LISTENER(input, "blur", onInputBlur);
        removeFocusWindowListener();
      }
      for (const { control, type, listener } of boundaryListeners) {
        for (const eventType of type) {
          TRUSTED_REMOVE_EVENT_LISTENER(
            control.element,
            eventType,
            listener,
            true,
          );
        }
      }
    };

    const runtime: SearchControlPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        partialReplayWindowOpen = true;
        queueMicrotask(() => {
          partialReplayWindowOpen = false;
        });
        refs = searchControlExpectedOwners(render, owners).map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish dashboard search controls without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        guard = createSearchControlDomGuard(
          ownerDocument,
          publishedRoots,
          () => {
            const ownedActivePublication = cells.active === publication;
            retire("other");
            if (ownedActivePublication) {
              armSearchControlDomBarrier(
                cells,
                ownerDocument,
                publishedRoots,
                requestSuccessor,
              );
            }
          },
          (records) =>
            ((nativeProof?.action.kind === "change" &&
              nativeBoundaryProof === nativeProof &&
              reactRootProof?.native === nativeProof &&
              reactCaptureProof?.native === nativeProof &&
              reactBubbleProof?.native === nativeProof) ||
              cells.replay?.source === publication) &&
            records.length === 2 &&
            records[0]?.type === "attributes" &&
            records[0].target === input &&
            records[0].attributeName === "name" &&
            records[0].oldValue === null &&
            records[1]?.type === "attributes" &&
            records[1].target === input &&
            records[1].attributeName === "name" &&
            records[1].oldValue === "" &&
            TRUSTED_ELEMENT_HAS_ATTRIBUTE?.(input, "name") === false,
        );
        if (
          !guard ||
          cells.active ||
          !searchControlElementsAreExact(render, owners) ||
          !searchControlRootsMatch(ownerDocument, publishedRoots) ||
          !guard.unchanged()
        ) {
          releaseGuard();
          return false;
        }
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        addNativeListeners();
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: SearchControlElementOwnerView,
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
          synchronousRefReplayPending =
            synchronousRefReplayPending || partialReplayWindowOpen;
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
      canSettleSynchronousRefReplay: () =>
        established && partialReplayWindowOpen,
      settleSynchronousRefReplay: () => {
        const exact =
          !retired &&
          synchronousRefReplayPending &&
          refs.some((entry) => entry.state === "reattached") &&
          refs.every(
            (entry) =>
              entry.state === "attached" || entry.state === "reattached",
          ) &&
          refs.every((entry) => entry.owner.element() === entry.element) &&
          searchControlElementsAreExact(render, owners) &&
          searchControlRootsMatch(ownerDocument, publishedRoots) &&
          Boolean(guard?.unchanged());
        if (!exact) return false;
        for (const entry of refs) entry.state = "attached";
        synchronousRefReplayPending = false;
        return true;
      },
      isExactReplay: () =>
        retired &&
        established &&
        (retirement === "layout" || retirement === "element") &&
        refs.every((entry) => entry.state === "reattached") &&
        refs.length === searchControlExpectedOwners(render, owners).length &&
        refs.every(
          (entry) =>
            entry.owner.element() === entry.element,
        ) &&
        searchControlElementsAreExact(render, owners) &&
        searchControlRootsMatch(ownerDocument, publishedRoots) &&
        Boolean(guard?.unchanged()),
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              roots: publishedRoots,
              unchanged: guard.unchanged,
              release: releaseGuard,
            })
          : null,
      captureRoot,
      captureControl,
      bubbleControl,
    });
    return runtime;
  };

  const establish = () => {
    const domBarrier = cells.domBarrier;
    if (domBarrier) {
      if (!domBarrier.attempted()) return;
      domBarrier.release();
      cells.domBarrier = null;
      cells.successorOf = null;
    }
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
    if (!searchControlElementsAreExact(render, owners)) return;
    const replay = cells.replay;
    if (replay) {
      const sameFacts = searchControlRendersMatch(replay.source.render, render);
      const exact =
        sameFacts &&
        replay.source.isRetired() &&
        cells.successorOf === replay.source &&
        replay.unchanged() &&
        replay.roots.length > 0 &&
        replay.roots.every((root) => {
          const currentRoot =
            root.role === "search-root"
              ? owners.searchRoot.element()
              : root.role === "error-root"
                ? owners.errorRoot.element()
                : root.role === "empty-root"
                  ? owners.emptyRoot.element()
                  : owners.resultRoot.element();
          return (
            currentRoot === root.element &&
            publishedRootStillMatches(root)
          );
        });
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

    function publishedRootStillMatches(
      root: SearchControlRootPublication,
    ) {
      return (
        root.dom.node === root.element &&
        templateGridDomMatches(root.dom) &&
        searchControlPlacementMatches(root.element.ownerDocument, root.placement)
      );
    }
  };

  const root = (
    role: "search-root" | "error-root" | "empty-root" | "result-root",
    event: ReactSyntheticEvent,
  ) => currentRuntime?.captureRoot(role, event);
  const capture = (
    kind: SearchControlActionKind,
    event: ReactSyntheticEvent,
  ) => currentRuntime?.captureControl(kind, event);
  const bubble = (
    kind: SearchControlActionKind,
    event: ReactSyntheticEvent,
  ) => currentRuntime?.bubbleControl(kind, event);

  return Object.freeze({
    establish,
    captureSearchRoot: owners.searchRoot.capture,
    captureSearchIcon: owners.searchIcon.capture,
    captureInput: owners.input.capture,
    captureHint: owners.hint.capture,
    captureLoadingIcon: owners.loadingIcon.capture,
    captureInlineClear: owners.inlineClear.capture,
    captureInlineClearIcon: owners.inlineClearIcon.capture,
    captureErrorRoot: owners.errorRoot.capture,
    captureErrorMessage: owners.errorMessage.capture,
    captureRetry: owners.retry.capture,
    captureEmptyRoot: owners.emptyRoot.capture,
    captureEmptyIcon: owners.emptyIcon.capture,
    captureEmptyPrimary: owners.emptyPrimary.capture,
    captureEmptySecondary: owners.emptySecondary.capture,
    captureEmptyClear: owners.emptyClear.capture,
    captureResultRoot: owners.resultRoot.capture,
    captureResultLinks: Object.freeze(
      owners.resultLinks.map(({ owner }) => owner.capture),
    ),
    captureRootChange: (event: ReactChangeEvent<HTMLDivElement>) =>
      root("search-root", event),
    captureInputChange: (event: ReactChangeEvent<HTMLInputElement>) =>
      capture("change", event),
    changeInput: (event: ReactChangeEvent<HTMLInputElement>) =>
      bubble("change", event),
    captureRootKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) =>
      root("search-root", event),
    captureInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      capture("escape", event);
      capture("focus-result", event);
    },
    keyDownInput: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      bubble("escape", event);
      bubble("focus-result", event);
    },
    captureSearchClick: (event: ReactMouseEvent<HTMLDivElement>) =>
      root("search-root", event),
    captureInlineClearClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      capture("inline-clear", event),
    activateInlineClear: (event: ReactMouseEvent<HTMLButtonElement>) =>
      bubble("inline-clear", event),
    captureErrorClick: (event: ReactMouseEvent<HTMLDivElement>) =>
      root("error-root", event),
    captureRetryClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      capture("retry", event),
    activateRetry: (event: ReactMouseEvent<HTMLButtonElement>) =>
      bubble("retry", event),
    captureEmptyClick: (event: ReactMouseEvent<HTMLDivElement>) =>
      root("empty-root", event),
    captureEmptyClearClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      capture("empty-clear", event),
    activateEmptyClear: (event: ReactMouseEvent<HTMLButtonElement>) =>
      bubble("empty-clear", event),
  });
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
const CREATE_BLANK_ICON_CLASS = "lucide lucide-file-plus-corner";
const CREATE_BUSY_ICON_CLASS = "lucide lucide-loader-circle animate-spin";
const CREATE_GUIDED_ROOT_CLASS = "mb-5 text-center";
const CREATE_GUIDED_ICON_CLASS =
  "lucide lucide-file-text mx-auto mb-3 text-ink-4";
const CREATE_GUIDED_PRIMARY_CLASS = "text-sm font-medium text-ink-2";
const CREATE_GUIDED_SECONDARY_CLASS = "mt-1 text-sm text-ink-3";
const CREATE_GUIDED_PRIMARY_TEXT = "No documents yet";
const CREATE_GUIDED_SECONDARY_TEXT =
  "Start with a short guided document, pick a template, or open a Markdown file from GitHub.";
const CREATE_WELCOME_BUTTON_CLASS = "btn btn-primary mt-4 gap-2";
const CREATE_WELCOME_ICON_CLASS = "lucide lucide-sparkles";
const CREATE_WELCOME_LABEL_TEXT = " Start with a guided doc";

type CreateControlActionKind = "blank" | "welcome";
type CreateControlRootRole = "create-card" | "guided-root";

type CreateControlElementRole =
  | CreateControlRootRole
  | "blank"
  | "blank-icon-frame"
  | "blank-icon"
  | "blank-label"
  | "blank-name"
  | "blank-description"
  | "guided-icon"
  | "guided-primary"
  | "guided-secondary"
  | "welcome"
  | "welcome-icon";

interface CreateAuthority {
  readonly mount: symbol;
  readonly visit: symbol;
  readonly user: DashboardProps["user"];
  readonly userId: string;
}

interface CreateControlRenderPublication {
  readonly identity: symbol;
  readonly mount: symbol;
  readonly authority: CreateAuthority;
  readonly user: DashboardProps["user"];
  readonly userId: string;
  readonly create: (template?: Template) => Promise<void>;
  readonly createDocument: typeof api.documents.create;
  readonly router: ReturnType<typeof useRouter>;
  readonly routerPush: ReturnType<typeof useRouter>["push"];
  readonly operation: CreateOperation | null;
  readonly creating: string | null;
  readonly welcome: Template | undefined;
  readonly hasGuided: boolean;
}

interface CreateControlElementOwnerView {
  readonly role: CreateControlElementRole;
  readonly element: () => Element | null;
}

interface CreateControlRefReplay {
  readonly owner: CreateControlElementOwnerView;
  readonly element: Element;
  state: "attached" | "detached" | "reattached" | "invalid";
}

interface CreateControlActionPublication {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly controlIdentity: symbol;
  readonly kind: CreateControlActionKind;
  readonly template: Template | null;
}

interface CreatePublishedControl {
  readonly identity: symbol;
  readonly publicationIdentity: symbol;
  readonly kind: CreateControlActionKind;
  readonly element: HTMLButtonElement;
  readonly root: HTMLDivElement;
  readonly targets: readonly Node[];
  readonly paths: ReadonlyMap<Node, readonly EventTarget[]>;
  readonly action: CreateControlActionPublication;
}

interface CreateControlRootPublication {
  readonly role: CreateControlRootRole;
  readonly element: HTMLDivElement;
  readonly dom: TemplateGridDomSnapshot;
  readonly placement: TemplateGridPlacement;
}

interface CreateControlPublication {
  readonly identity: symbol;
  readonly render: CreateControlRenderPublication;
  readonly ownerDocument: Document;
  readonly card: HTMLDivElement;
  readonly controls: ReadonlyMap<CreateControlActionKind, CreatePublishedControl>;
  readonly roots: readonly CreateControlRootPublication[];
  readonly retire: () => boolean;
  readonly isRetired: () => boolean;
}

interface CreateControlReplay {
  readonly source: CreateControlPublication;
  readonly roots: readonly CreateControlRootPublication[];
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface CreateControlPublicationCells {
  active: CreateControlPublication | null;
  successorOf: CreateControlPublication | null;
  replay: CreateControlReplay | null;
  delivery: symbol | null;
  readonly claimedPublications: WeakSet<CreateControlPublication>;
  readonly claimedControls: WeakSet<CreatePublishedControl>;
  readonly claimedActions: WeakSet<CreateControlActionPublication>;
  readonly claimedReactEvents: WeakSet<object>;
  readonly claimedNativeEvents: WeakSet<Event>;
  readonly attemptedReactEvents: WeakSet<object>;
  readonly attemptedNativeEvents: WeakSet<Event>;
}

interface CreateNativeClickProof {
  readonly identity: symbol;
  readonly origin: "document-capture" | "document-root-react-capture";
  readonly event: MouseEvent;
  readonly publication: CreateControlPublication;
  readonly control: CreatePublishedControl;
  readonly action: CreateControlActionPublication;
  readonly target: Node;
  readonly path: readonly EventTarget[];
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly detail: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly propagationStopped: () => boolean;
}

interface CreateReactClickProof {
  readonly event: object;
  readonly native: CreateNativeClickProof;
  readonly dispatchTarget: EventTarget;
  readonly nativePhase: number;
}

interface CreateTerminalClickProof {
  readonly native: CreateNativeClickProof;
  readonly root: CreateReactClickProof;
  readonly capture: CreateReactClickProof;
  readonly bubble: CreateReactClickProof;
}

interface CreateControlDomGuard {
  readonly unchanged: () => boolean;
  readonly release: () => void;
}

interface CreateControlPublicationRuntime {
  readonly publication: CreateControlPublication;
  readonly publish: () => boolean;
  readonly retireForElement: () => void;
  readonly retireForLayout: () => void;
  readonly noteRef: (
    owner: CreateControlElementOwnerView,
    element: Element | null,
    previous: Element | null,
  ) => void;
  readonly isExactReplay: () => boolean;
  readonly replay: () => CreateControlReplay | null;
  readonly captureRoot: (
    role: CreateControlRootRole,
    event: ReactSyntheticEvent,
  ) => void;
  readonly captureControl: (
    kind: CreateControlActionKind,
    event: ReactSyntheticEvent,
  ) => void;
  readonly activate: (
    kind: CreateControlActionKind,
    event: ReactSyntheticEvent,
  ) => boolean;
}

interface CreateControlPublicationSet {
  readonly establish: () => void | (() => void);
  readonly captureCard: (element: HTMLDivElement | null) => void | (() => void);
  readonly captureBlank: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureBlankIconFrame: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureBlankIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureBlankLabel: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureBlankName: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureBlankDescription: (
    element: HTMLSpanElement | null,
  ) => void | (() => void);
  readonly captureGuidedRoot: (
    element: HTMLDivElement | null,
  ) => void | (() => void);
  readonly captureGuidedIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureGuidedPrimary: (
    element: HTMLParagraphElement | null,
  ) => void | (() => void);
  readonly captureGuidedSecondary: (
    element: HTMLParagraphElement | null,
  ) => void | (() => void);
  readonly captureWelcome: (
    element: HTMLButtonElement | null,
  ) => void | (() => void);
  readonly captureWelcomeIcon: (
    element: SVGSVGElement | null,
  ) => void | (() => void);
  readonly captureCardClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly captureBlankClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activateBlank: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly captureGuidedClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly captureWelcomeClick: (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  readonly activateWelcome: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

class CreateControlElementOwner<T extends Element>
  implements CreateControlElementOwnerView
{
  private current: T | null = null;
  private last: T | null = null;

  constructor(
    readonly role: CreateControlElementRole,
    private readonly onChange: (
      owner: CreateControlElementOwnerView,
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

interface CreateControlOwners {
  readonly card: CreateControlElementOwner<HTMLDivElement>;
  readonly blank: CreateControlElementOwner<HTMLButtonElement>;
  readonly blankIconFrame: CreateControlElementOwner<HTMLSpanElement>;
  readonly blankIcon: CreateControlElementOwner<SVGSVGElement>;
  readonly blankLabel: CreateControlElementOwner<HTMLSpanElement>;
  readonly blankName: CreateControlElementOwner<HTMLSpanElement>;
  readonly blankDescription: CreateControlElementOwner<HTMLSpanElement>;
  readonly guidedRoot: CreateControlElementOwner<HTMLDivElement>;
  readonly guidedIcon: CreateControlElementOwner<SVGSVGElement>;
  readonly guidedPrimary: CreateControlElementOwner<HTMLParagraphElement>;
  readonly guidedSecondary: CreateControlElementOwner<HTMLParagraphElement>;
  readonly welcome: CreateControlElementOwner<HTMLButtonElement>;
  readonly welcomeIcon: CreateControlElementOwner<SVGSVGElement>;
}

function createControlRenderIsExact(render: CreateControlRenderPublication) {
  return (
    Object.isFrozen(render) &&
    Object.isFrozen(render.authority) &&
    render.authority.mount === render.mount &&
    render.authority.user === render.user &&
    render.authority.userId === render.userId &&
    render.user.id === render.userId &&
    typeof render.create === "function" &&
    render.createDocument === api.documents.create &&
    typeof render.router.push === "function" &&
    render.router.push === render.routerPush &&
    render.welcome === getTemplate(WELCOME_TEMPLATE_ID) &&
    render.welcome?.id === WELCOME_TEMPLATE_ID &&
    render.creating ===
      (render.operation && render.operation.ownerId === render.userId
        ? render.operation.key
        : null)
  );
}

function createControlRendersMatch(
  previous: CreateControlRenderPublication,
  current: CreateControlRenderPublication,
) {
  return (
    previous.mount === current.mount &&
    previous.authority === current.authority &&
    previous.user === current.user &&
    previous.userId === current.userId &&
    previous.create === current.create &&
    previous.createDocument === current.createDocument &&
    previous.router === current.router &&
    previous.routerPush === current.routerPush &&
    previous.operation === current.operation &&
    previous.creating === current.creating &&
    previous.welcome === current.welcome &&
    previous.hasGuided === current.hasGuided &&
    createControlRenderIsExact(previous) &&
    createControlRenderIsExact(current)
  );
}

function createControlExpectedOwners(
  render: CreateControlRenderPublication,
  owners: CreateControlOwners,
): readonly CreateControlElementOwnerView[] {
  return Object.freeze([
    owners.card,
    owners.blank,
    owners.blankIconFrame,
    owners.blankIcon,
    owners.blankLabel,
    owners.blankName,
    owners.blankDescription,
    ...(render.hasGuided
      ? [
          owners.guidedRoot,
          owners.guidedIcon,
          owners.guidedPrimary,
          owners.guidedSecondary,
          owners.welcome,
          owners.welcomeIcon,
        ]
      : []),
  ]);
}

function createControlIsEnabled(
  control: HTMLButtonElement,
  root: HTMLElement,
) {
  return (
    TRUSTED_BUTTON_DISABLED?.(control) === false &&
    TRUSTED_ELEMENT_GET_ATTRIBUTE?.(control, "aria-busy")?.toLowerCase() !==
      "true" &&
    searchControlAncestorsAreEnabled(control, root)
  );
}

function createControlIconIsExact(
  icon: Element | null,
  ownerWindow: Window & typeof globalThis,
  className: string,
  size: string,
) {
  return Boolean(
    icon instanceof ownerWindow.SVGSVGElement &&
      icon.namespaceURI === "http://www.w3.org/2000/svg" &&
      icon.className.baseVal === className &&
      icon.getAttribute("width") === size &&
      icon.getAttribute("height") === size &&
      icon.getAttribute("aria-hidden") === "true",
  );
}

function createControlElementsAreExact(
  render: CreateControlRenderPublication,
  owners: CreateControlOwners,
) {
  if (!TRUSTED_BUTTON_DISABLED || !createControlRenderIsExact(render)) {
    return false;
  }
  const card = owners.card.element();
  const blank = owners.blank.element();
  const blankIconFrame = owners.blankIconFrame.element();
  const blankIcon = owners.blankIcon.element();
  const blankLabel = owners.blankLabel.element();
  const blankName = owners.blankName.element();
  const blankDescription = owners.blankDescription.element();
  const guidedRoot = owners.guidedRoot.element();
  const guidedIcon = owners.guidedIcon.element();
  const guidedPrimary = owners.guidedPrimary.element();
  const guidedSecondary = owners.guidedSecondary.element();
  const welcome = owners.welcome.element();
  const welcomeIcon = owners.welcomeIcon.element();
  const ownerDocument = card?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  const busy = render.creating !== null;
  if (
    !ownerWindow ||
    !(card instanceof ownerWindow.HTMLDivElement) ||
    !card.isConnected ||
    card.className !== CREATE_CARD_CLASS ||
    !templateGridHasExactAttributes(card, [["class", CREATE_CARD_CLASS]]) ||
    card.children.length !== 3
  ) {
    return false;
  }

  const templateTrigger = card.children.item(1);
  const openFile = card.children.item(2);
  if (
    !(blank instanceof ownerWindow.HTMLButtonElement) ||
    card.children.item(0) !== blank ||
    blank.parentElement !== card ||
    blank.type !== "button" ||
    blank.className !== CREATE_BLANK_BUTTON_CLASS ||
    blank.dataset.testid !== "new-document" ||
    TRUSTED_BUTTON_DISABLED(blank) !== busy ||
    blank.matches(":disabled") !== busy ||
    !templateGridHasExactAttributes(blank, [
      ["type", "button"],
      ...(busy ? ([["disabled", ""]] as const) : []),
      ["class", CREATE_BLANK_BUTTON_CLASS],
      ["data-testid", "new-document"],
    ]) ||
    blank.childNodes.length !== 2 ||
    blank.children.length !== 2 ||
    !(templateTrigger instanceof ownerWindow.HTMLButtonElement) ||
    templateTrigger.dataset.testid !== "new-from-template" ||
    TRUSTED_BUTTON_DISABLED(templateTrigger) !== busy ||
    !(openFile instanceof ownerWindow.HTMLButtonElement) ||
    openFile.dataset.testid !== "open-file" ||
    TRUSTED_BUTTON_DISABLED(openFile) !== busy
  ) {
    return false;
  }

  if (
    !(blankIconFrame instanceof ownerWindow.HTMLSpanElement) ||
    blank.children.item(0) !== blankIconFrame ||
    blankIconFrame.parentElement !== blank ||
    blankIconFrame.className !== CREATE_BLANK_ICON_FRAME_CLASS ||
    !templateGridHasExactAttributes(blankIconFrame, [
      ["class", CREATE_BLANK_ICON_FRAME_CLASS],
    ]) ||
    blankIconFrame.childNodes.length !== 1 ||
    blankIconFrame.children.length !== 1 ||
    blankIconFrame.firstElementChild !== blankIcon ||
    blankIcon?.parentElement !== blankIconFrame ||
    !createControlIconIsExact(
      blankIcon,
      ownerWindow,
      render.creating === CREATE_BLANK_KEY
        ? CREATE_BUSY_ICON_CLASS
        : CREATE_BLANK_ICON_CLASS,
      render.creating === CREATE_BLANK_KEY ? "24" : "22",
    ) ||
    !(blankLabel instanceof ownerWindow.HTMLSpanElement) ||
    blank.children.item(1) !== blankLabel ||
    blankLabel.parentElement !== blank ||
    blankLabel.attributes.length !== 0 ||
    blankLabel.childNodes.length !== 2 ||
    blankLabel.children.length !== 2 ||
    !(blankName instanceof ownerWindow.HTMLSpanElement) ||
    blankLabel.children.item(0) !== blankName ||
    blankName.parentElement !== blankLabel ||
    blankName.className !== CREATE_BLANK_NAME_CLASS ||
    !templateGridHasExactAttributes(blankName, [
      ["class", CREATE_BLANK_NAME_CLASS],
    ]) ||
    !templateGridTextIsExact(blankName, CREATE_BLANK_NAME_TEXT) ||
    !(blankDescription instanceof ownerWindow.HTMLSpanElement) ||
    blankLabel.children.item(1) !== blankDescription ||
    blankDescription.parentElement !== blankLabel ||
    blankDescription.className !== CREATE_BLANK_DESCRIPTION_CLASS ||
    !templateGridHasExactAttributes(blankDescription, [
      ["class", CREATE_BLANK_DESCRIPTION_CLASS],
    ]) ||
    !templateGridTextIsExact(blankDescription, CREATE_BLANK_DESCRIPTION_TEXT) ||
    createControlIsEnabled(blank, card) === busy
  ) {
    return false;
  }

  if (render.hasGuided) {
    const welcomeBusy = render.creating === WELCOME_TEMPLATE_ID;
    const label = welcome?.childNodes.item(1) ?? null;
    if (
      !(guidedRoot instanceof ownerWindow.HTMLDivElement) ||
      !guidedRoot.isConnected ||
      guidedRoot.ownerDocument !== ownerDocument ||
      guidedRoot.className !== CREATE_GUIDED_ROOT_CLASS ||
      !templateGridHasExactAttributes(guidedRoot, [
        ["class", CREATE_GUIDED_ROOT_CLASS],
      ]) ||
      guidedRoot.childNodes.length !== 4 ||
      guidedRoot.children.length !== 4 ||
      guidedRoot.children.item(0) !== guidedIcon ||
      guidedIcon?.parentElement !== guidedRoot ||
      !createControlIconIsExact(
        guidedIcon,
        ownerWindow,
        CREATE_GUIDED_ICON_CLASS,
        "28",
      ) ||
      !(guidedPrimary instanceof ownerWindow.HTMLParagraphElement) ||
      guidedRoot.children.item(1) !== guidedPrimary ||
      guidedPrimary.parentElement !== guidedRoot ||
      guidedPrimary.className !== CREATE_GUIDED_PRIMARY_CLASS ||
      guidedPrimary.textContent !== CREATE_GUIDED_PRIMARY_TEXT ||
      !(guidedSecondary instanceof ownerWindow.HTMLParagraphElement) ||
      guidedRoot.children.item(2) !== guidedSecondary ||
      guidedSecondary.parentElement !== guidedRoot ||
      guidedSecondary.className !== CREATE_GUIDED_SECONDARY_CLASS ||
      guidedSecondary.textContent !== CREATE_GUIDED_SECONDARY_TEXT ||
      !(welcome instanceof ownerWindow.HTMLButtonElement) ||
      guidedRoot.children.item(3) !== welcome ||
      welcome.parentElement !== guidedRoot ||
      welcome.type !== "button" ||
      welcome.className !== CREATE_WELCOME_BUTTON_CLASS ||
      welcome.dataset.testid !== "start-guided-doc" ||
      TRUSTED_BUTTON_DISABLED(welcome) !== busy ||
      welcome.matches(":disabled") !== busy ||
      welcome.getAttribute("aria-busy") !== (welcomeBusy ? "true" : null) ||
      !templateGridHasExactAttributes(welcome, [
        ["type", "button"],
        ["class", CREATE_WELCOME_BUTTON_CLASS],
        ...(busy ? ([["disabled", ""]] as const) : []),
        ...(welcomeBusy ? ([["aria-busy", "true"]] as const) : []),
        ["data-testid", "start-guided-doc"],
      ]) ||
      welcome.childNodes.length !== 2 ||
      welcome.children.length !== 1 ||
      welcome.children.item(0) !== welcomeIcon ||
      welcomeIcon?.parentElement !== welcome ||
      !createControlIconIsExact(
        welcomeIcon,
        ownerWindow,
        welcomeBusy ? CREATE_BUSY_ICON_CLASS : CREATE_WELCOME_ICON_CLASS,
        "16",
      ) ||
      label === null ||
      label.nodeType !== ownerWindow.Node.TEXT_NODE ||
      label.nodeValue !== CREATE_WELCOME_LABEL_TEXT ||
      createControlIsEnabled(welcome, guidedRoot) === busy
    ) {
      return false;
    }
  } else if (
    guidedRoot !== null ||
    guidedIcon !== null ||
    guidedPrimary !== null ||
    guidedSecondary !== null ||
    welcome !== null ||
    welcomeIcon !== null
  ) {
    return false;
  }

  const expectedOwners = createControlExpectedOwners(render, owners);
  const elements = expectedOwners.map((owner) => owner.element());
  return (
    elements.every(
      (element): element is Element =>
        Boolean(
          element &&
            element.isConnected &&
            element.ownerDocument === ownerDocument,
        ),
    ) && new Set(elements).size === elements.length
  );
}

function createControlRootsMatch(
  ownerDocument: Document,
  roots: readonly CreateControlRootPublication[],
) {
  return roots.every(
    ({ element, dom, placement }) =>
      element.isConnected &&
      element.ownerDocument === ownerDocument &&
      dom.node === element &&
      templateGridDomMatches(dom) &&
      searchControlPlacementMatches(ownerDocument, placement),
  );
}

function createControlDomGuard(
  ownerDocument: Document,
  roots: readonly CreateControlRootPublication[],
  onMutation: () => void,
): CreateControlDomGuard | null {
  const MutationObserverConstructor =
    ownerDocument.defaultView?.MutationObserver;
  if (!MutationObserverConstructor) return null;
  let changed = false;
  const rootElements = roots.map(({ element }) => element);
  const placements = roots.flatMap(({ placement }) => placement);
  const relevant = (mutation: MutationRecord) => {
    if (
      rootElements.some(
        (root) => mutation.target === root || root.contains(mutation.target),
      )
    ) {
      return true;
    }
    if (mutation.type === "attributes") {
      return (
        (mutation.attributeName === "aria-disabled" ||
          mutation.attributeName === "disabled" ||
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

function createControlNativeSupportIsAvailable() {
  return Boolean(
    TRUSTED_EVENT_CURRENT_TARGET &&
      TRUSTED_EVENT_DEFAULT_PREVENTED &&
      TRUSTED_EVENT_TARGET &&
      TRUSTED_EVENT_TYPE &&
      TRUSTED_EVENT_PHASE &&
      TRUSTED_EVENT_BUBBLES &&
      TRUSTED_EVENT_CANCELABLE &&
      TRUSTED_EVENT_CANCEL_BUBBLE &&
      TRUSTED_MOUSE_BUTTON &&
      TRUSTED_MOUSE_BUTTONS &&
      TRUSTED_MOUSE_CTRL &&
      TRUSTED_MOUSE_META &&
      TRUSTED_MOUSE_ALT &&
      TRUSTED_MOUSE_SHIFT &&
      TRUSTED_UI_DETAIL &&
      TRUSTED_BUTTON_DISABLED &&
      TRUSTED_ELEMENT_GET_ATTRIBUTE &&
      TRUSTED_ELEMENT_HAS_ATTRIBUTE,
  );
}

/**
 * Publication authority for the two direct create buttons ("New document" and "Start with a guided
 * doc"). Every activation must present the exact current user, callbacks, button, action, owner
 * document, committed DOM, placement, enabled facts, React wrapper chain and genuine native click
 * before the shared `create()` runs once.
 */
function createCreateControlPublication(
  render: CreateControlRenderPublication,
  cells: CreateControlPublicationCells,
  requestSuccessor: () => void,
): CreateControlPublicationSet {
  let currentRuntime: CreateControlPublicationRuntime | null = null;
  let lastRuntime: CreateControlPublicationRuntime | null = null;
  let successorRequested = false;

  const onElementChange = (
    owner: CreateControlElementOwnerView,
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
        createControlElementsAreExact(render, owners) &&
        replay.source.card === owners.card.element()
      ) {
        cells.replay = replay;
        successorRequested = true;
        requestSuccessor();
      }
    }
  };

  const owners: CreateControlOwners = {
    card: new CreateControlElementOwner<HTMLDivElement>(
      "create-card",
      onElementChange,
    ),
    blank: new CreateControlElementOwner<HTMLButtonElement>(
      "blank",
      onElementChange,
    ),
    blankIconFrame: new CreateControlElementOwner<HTMLSpanElement>(
      "blank-icon-frame",
      onElementChange,
    ),
    blankIcon: new CreateControlElementOwner<SVGSVGElement>(
      "blank-icon",
      onElementChange,
    ),
    blankLabel: new CreateControlElementOwner<HTMLSpanElement>(
      "blank-label",
      onElementChange,
    ),
    blankName: new CreateControlElementOwner<HTMLSpanElement>(
      "blank-name",
      onElementChange,
    ),
    blankDescription: new CreateControlElementOwner<HTMLSpanElement>(
      "blank-description",
      onElementChange,
    ),
    guidedRoot: new CreateControlElementOwner<HTMLDivElement>(
      "guided-root",
      onElementChange,
    ),
    guidedIcon: new CreateControlElementOwner<SVGSVGElement>(
      "guided-icon",
      onElementChange,
    ),
    guidedPrimary: new CreateControlElementOwner<HTMLParagraphElement>(
      "guided-primary",
      onElementChange,
    ),
    guidedSecondary: new CreateControlElementOwner<HTMLParagraphElement>(
      "guided-secondary",
      onElementChange,
    ),
    welcome: new CreateControlElementOwner<HTMLButtonElement>(
      "welcome",
      onElementChange,
    ),
    welcomeIcon: new CreateControlElementOwner<SVGSVGElement>(
      "welcome-icon",
      onElementChange,
    ),
  };

  const createRuntime = (): CreateControlPublicationRuntime | null => {
    type Retirement = "element" | "layout" | "other";
    if (
      !createControlNativeSupportIsAvailable() ||
      !createControlElementsAreExact(render, owners)
    ) {
      return null;
    }
    const nativeCurrentTarget = TRUSTED_EVENT_CURRENT_TARGET;
    const nativeWasPrevented = TRUSTED_EVENT_DEFAULT_PREVENTED;
    const nativeTarget = TRUSTED_EVENT_TARGET;
    const nativeType = TRUSTED_EVENT_TYPE;
    const nativePhaseOf = TRUSTED_EVENT_PHASE;
    const nativeBubbles = TRUSTED_EVENT_BUBBLES;
    const nativeCancelable = TRUSTED_EVENT_CANCELABLE;
    const nativeCancelBubble = TRUSTED_EVENT_CANCEL_BUBBLE;
    const nativeButton = TRUSTED_MOUSE_BUTTON;
    const nativeButtons = TRUSTED_MOUSE_BUTTONS;
    const nativeCtrl = TRUSTED_MOUSE_CTRL;
    const nativeMeta = TRUSTED_MOUSE_META;
    const nativeAlt = TRUSTED_MOUSE_ALT;
    const nativeShift = TRUSTED_MOUSE_SHIFT;
    const nativeDetail = TRUSTED_UI_DETAIL;
    const card = owners.card.element();
    const blank = owners.blank.element();
    if (
      !nativeCurrentTarget ||
      !nativeWasPrevented ||
      !nativeTarget ||
      !nativeType ||
      !nativePhaseOf ||
      !nativeBubbles ||
      !nativeCancelable ||
      !nativeCancelBubble ||
      !nativeButton ||
      !nativeButtons ||
      !nativeCtrl ||
      !nativeMeta ||
      !nativeAlt ||
      !nativeShift ||
      !nativeDetail ||
      !card ||
      !blank
    ) {
      return null;
    }
    const ownerDocument = card.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const stopOwnerPropagation = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "stopPropagation",
        )
      : null;
    const stopOwnerImmediatePropagation = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "stopImmediatePropagation",
        )
      : null;
    const preventOwnerDefault = ownerWindow
      ? capturePrototypeMethod<(event: Event) => void>(
          ownerWindow.Event.prototype,
          "preventDefault",
        )
      : null;
    if (
      !ownerWindow ||
      !stopOwnerPropagation ||
      !stopOwnerImmediatePropagation ||
      !preventOwnerDefault ||
      !(card instanceof ownerWindow.HTMLDivElement) ||
      !(blank instanceof ownerWindow.HTMLButtonElement)
    ) {
      return null;
    }

    const guidedRoot = owners.guidedRoot.element();
    const welcome = owners.welcome.element();
    if (
      render.hasGuided &&
      (!(guidedRoot instanceof ownerWindow.HTMLDivElement) ||
        !(welcome instanceof ownerWindow.HTMLButtonElement))
    ) {
      return null;
    }

    const rootEntries: [CreateControlRootRole, HTMLDivElement | null][] = [
      ["create-card", card],
      [
        "guided-root",
        render.hasGuided ? (guidedRoot as HTMLDivElement | null) : null,
      ],
    ];
    const roots: CreateControlRootPublication[] = [];
    for (const [role, element] of rootEntries) {
      if (!element) continue;
      const placement = searchControlPlacement(element);
      if (!placement) return null;
      roots.push(
        Object.freeze({
          role,
          element,
          dom: snapshotTemplateGridDom(element),
          placement,
        }),
      );
    }
    const publishedRoots = Object.freeze(roots);
    if (!createControlRootsMatch(ownerDocument, publishedRoots)) return null;

    const identity = Symbol("dashboard-create-controls-publication");
    const controls = new Map<
      CreateControlActionKind,
      CreatePublishedControl
    >();
    const addControl = (
      kind: CreateControlActionKind,
      element: HTMLButtonElement,
      root: HTMLDivElement,
      template: Template | null,
    ) => {
      const targets = searchControlNodes(element);
      const paths = searchControlPaths(ownerDocument, targets);
      if (!paths) return false;
      const controlIdentity = Symbol(`dashboard-create-${kind}-control`);
      controls.set(
        kind,
        Object.freeze({
          identity: controlIdentity,
          publicationIdentity: identity,
          kind,
          element,
          root,
          targets,
          paths,
          action: Object.freeze({
            identity: Symbol(`dashboard-create-${kind}-action`),
            publicationIdentity: identity,
            controlIdentity,
            kind,
            template,
          }),
        }),
      );
      return true;
    };
    if (!addControl("blank", blank, card, null)) return null;
    if (
      render.hasGuided &&
      (!render.welcome ||
        !addControl(
          "welcome",
          welcome as HTMLButtonElement,
          guidedRoot as HTMLDivElement,
          render.welcome,
        ))
    ) {
      return null;
    }

    let retired = false;
    let retirement: Retirement | null = null;
    let layoutRetired = false;
    let established = false;
    let refs: CreateControlRefReplay[] = [];
    let guard: CreateControlDomGuard | null = null;
    let nativeProof: CreateNativeClickProof | null = null;
    let reactRootProof: CreateReactClickProof | null = null;
    let reactCaptureProof: CreateReactClickProof | null = null;
    let reactBubbleProof: CreateReactClickProof | null = null;
    let nativeBoundaryProof: CreateNativeClickProof | null = null;

    const publication: CreateControlPublication = Object.freeze({
      identity,
      render,
      ownerDocument,
      card,
      controls,
      roots: publishedRoots,
      retire: () => retire("other"),
      isRetired: () => retired,
    });

    const clearEventProof = (proof?: CreateNativeClickProof) => {
      if (proof && nativeProof !== proof) return;
      nativeProof = null;
      reactRootProof = null;
      reactCaptureProof = null;
      reactBubbleProof = null;
      nativeBoundaryProof = null;
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
      clearEventProof();
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
      return true;
    };
    const publicationOwnsCurrentDom = () => {
      if (
        retired ||
        cells.active !== publication ||
        publication.render !== render ||
        !createControlRenderIsExact(render) ||
        !createControlElementsAreExact(render, owners) ||
        !createControlRootsMatch(ownerDocument, publishedRoots) ||
        !guard?.unchanged()
      ) {
        retire("other");
        return false;
      }
      return true;
    };
    const controlForNative = (event: Event): CreatePublishedControl | null => {
      if (nativeType(event) !== "click") return null;
      const target = nativeTarget(event);
      if (!(target instanceof ownerWindow.Node)) return null;
      for (const control of controls.values()) {
        if (control.targets.includes(target)) return control;
      }
      return null;
    };
    const exactNativeClick = (
      event: Event,
      origin: CreateNativeClickProof["origin"],
      control: CreatePublishedControl,
    ): CreateNativeClickProof | null => {
      if (
        !TRUSTED_IS_PROTOTYPE_OF(ownerWindow.MouseEvent.prototype, event) ||
        !publicationOwnsCurrentDom()
      ) {
        return null;
      }
      const target = nativeTarget(event);
      if (!(target instanceof ownerWindow.Node)) return null;
      const expectedPath = control.paths.get(target);
      const path = TRUSTED_EVENT_COMPOSED_PATH(event);
      const button = nativeButton(event);
      const buttons = nativeButtons(event);
      const ctrlKey = nativeCtrl(event);
      const metaKey = nativeMeta(event);
      const altKey = nativeAlt(event);
      const shiftKey = nativeShift(event);
      const detail = nativeDetail(event);
      if (
        !expectedPath ||
        !searchControlPathMatches(expectedPath, path, ownerDocument) ||
        nativeCurrentTarget(event) !== ownerDocument ||
        nativePhaseOf(event) !== ownerWindow.Event.CAPTURING_PHASE ||
        !nativeBubbles(event) ||
        !nativeCancelable(event) ||
        nativeWasPrevented(event) ||
        nativeCancelBubble(event) ||
        !target.isConnected ||
        target.ownerDocument !== ownerDocument ||
        button !== 0 ||
        buttons !== 0 ||
        ctrlKey ||
        metaKey ||
        altKey ||
        shiftKey ||
        detail < 0 ||
        control.publicationIdentity !== identity ||
        control.action.publicationIdentity !== identity ||
        control.action.controlIdentity !== control.identity ||
        control.action.kind !== control.kind ||
        !createControlIsEnabled(control.element, control.root)
      ) {
        return null;
      }
      if (
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(event, "stopPropagation") ||
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          event,
          "stopImmediatePropagation",
        )
      ) {
        return null;
      }
      let propagationStopped = false;
      const stopPropagation = () => {
        propagationStopped = true;
        stopOwnerPropagation(event);
      };
      const stopImmediatePropagation = () => {
        propagationStopped = true;
        stopOwnerImmediatePropagation(event);
      };
      if (
        !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopPropagation", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: stopPropagation,
        }) ||
        !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopImmediatePropagation", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: stopImmediatePropagation,
        })
      ) {
        return null;
      }
      return Object.freeze({
        identity: Symbol("dashboard-create-native-click"),
        origin,
        event: event as MouseEvent,
        publication,
        control,
        action: control.action,
        target,
        path: Object.freeze([...path]),
        bubbles: true,
        cancelable: nativeCancelable(event),
        button,
        buttons,
        detail,
        ctrlKey,
        metaKey,
        altKey,
        shiftKey,
        propagationStopped: () => propagationStopped,
      });
    };
    const blockCrossedEvent = (event: Event) => {
      preventOwnerDefault(event);
      stopOwnerImmediatePropagation(event);
    };
    const beginNativeEvent = (
      event: Event,
      origin: CreateNativeClickProof["origin"],
    ) => {
      if (nativeProof) {
        if (nativeProof.event === event) return nativeProof;
        if (controlForNative(event)) {
          cells.attemptedNativeEvents.add(event);
          blockCrossedEvent(event);
        }
        return null;
      }
      const control = controlForNative(event);
      if (!control) return null;
      if (cells.attemptedNativeEvents.has(event)) {
        blockCrossedEvent(event);
        return null;
      }
      cells.attemptedNativeEvents.add(event);
      const proof = exactNativeClick(event, origin, control);
      if (!proof) return null;
      nativeProof = proof;
      queueMicrotask(() => {
        if (nativeProof !== proof) return;
        clearEventProof(proof);
        publication.retire();
        requestSuccessor();
      });
      return proof;
    };
    const nativeEventStillMatches = (proof: CreateNativeClickProof) =>
      nativeTarget(proof.event) === proof.target &&
      nativeType(proof.event) === "click" &&
      nativeBubbles(proof.event) === proof.bubbles &&
      nativeCancelable(proof.event) === proof.cancelable &&
      nativeButton(proof.event) === proof.button &&
      nativeButtons(proof.event) === proof.buttons &&
      nativeCtrl(proof.event) === proof.ctrlKey &&
      nativeMeta(proof.event) === proof.metaKey &&
      nativeAlt(proof.event) === proof.altKey &&
      nativeShift(proof.event) === proof.shiftKey &&
      nativeDetail(proof.event) === proof.detail &&
      !nativeWasPrevented(proof.event) &&
      !nativeCancelBubble(proof.event) &&
      !proof.propagationStopped() &&
      searchControlPathMatches(
        proof.path,
        TRUSTED_EVENT_COMPOSED_PATH(proof.event),
        ownerDocument,
      );

    const reactClickMatches = (
      event: object,
      proof: CreateNativeClickProof,
      currentTarget: Element,
    ): CreateReactClickProof | null => {
      if (
        searchControlOwnValue(event, "_reactName") !== "onClick" ||
        searchControlOwnValue(event, "type") !== "click" ||
        searchControlOwnValue(event, "nativeEvent") !== proof.event ||
        searchControlOwnValue(event, "target") !== proof.target ||
        searchControlOwnValue(event, "currentTarget") !== currentTarget ||
        searchControlOwnValue(event, "bubbles") !== proof.bubbles ||
        searchControlOwnValue(event, "cancelable") !== proof.cancelable ||
        searchControlOwnValue(event, "button") !== proof.button ||
        searchControlOwnValue(event, "buttons") !== proof.buttons ||
        searchControlOwnValue(event, "ctrlKey") !== proof.ctrlKey ||
        searchControlOwnValue(event, "metaKey") !== proof.metaKey ||
        searchControlOwnValue(event, "altKey") !== proof.altKey ||
        searchControlOwnValue(event, "shiftKey") !== proof.shiftKey ||
        searchControlOwnValue(event, "detail") !== proof.detail ||
        searchControlOwnValue(event, "defaultPrevented") !==
          nativeWasPrevented(proof.event)
      ) {
        return null;
      }
      const dispatchTarget = nativeCurrentTarget(proof.event);
      const nativePhase = nativePhaseOf(proof.event);
      if (
        !dispatchTarget ||
        nativePhase === ownerWindow.Event.NONE ||
        (dispatchTarget !== ownerDocument &&
          (!(dispatchTarget instanceof ownerWindow.Node) ||
            dispatchTarget.ownerDocument !== ownerDocument ||
            !dispatchTarget.contains(proof.control.element)))
      ) {
        return null;
      }
      return Object.freeze({ event, native: proof, dispatchTarget, nativePhase });
    };

    const startReactWrapper = (event: object, allowCurrent: object | null) => {
      if (event === allowCurrent) return true;
      if (
        cells.claimedReactEvents.has(event) ||
        cells.attemptedReactEvents.has(event)
      ) {
        return false;
      }
      cells.attemptedReactEvents.add(event);
      return true;
    };
    const rootForAction = (kind: CreateControlActionKind): CreateControlRootRole =>
      kind === "welcome" ? "guided-root" : "create-card";
    const captureRoot = (
      role: CreateControlRootRole,
      event: ReactSyntheticEvent,
    ) => {
      if (!event || typeof event !== "object") return;
      if (!startReactWrapper(event, null)) return;
      const nativeEvent = searchControlOwnValue(event, "nativeEvent");
      if (!(nativeEvent instanceof ownerWindow.Event)) return;
      const proof =
        nativeProof?.event === nativeEvent
          ? nativeProof
          : nativeCurrentTarget(nativeEvent) === ownerDocument &&
              nativePhaseOf(nativeEvent) === ownerWindow.Event.CAPTURING_PHASE
            ? beginNativeEvent(nativeEvent, "document-root-react-capture")
            : null;
      if (
        !proof ||
        rootForAction(proof.action.kind) !== role ||
        reactRootProof ||
        !publicationOwnsCurrentDom()
      ) {
        return;
      }
      const matched = reactClickMatches(event, proof, proof.control.root);
      if (matched) reactRootProof = matched;
    };
    const captureControl = (
      kind: CreateControlActionKind,
      event: ReactSyntheticEvent,
    ) => {
      if (
        !event ||
        typeof event !== "object" ||
        !nativeProof ||
        nativeProof.action.kind !== kind ||
        !reactRootProof ||
        reactRootProof.native !== nativeProof ||
        reactCaptureProof ||
        !startReactWrapper(event, reactRootProof.event)
      ) {
        return;
      }
      const matched = reactClickMatches(
        event,
        nativeProof,
        nativeProof.control.element,
      );
      if (
        matched &&
        matched.event === reactRootProof.event &&
        matched.dispatchTarget === reactRootProof.dispatchTarget &&
        matched.nativePhase === reactRootProof.nativePhase
      ) {
        reactCaptureProof = matched;
      }
    };

    const rejectTerminal = (proof: CreateNativeClickProof) => {
      clearEventProof(proof);
      publication.retire();
      requestSuccessor();
    };
    const deliver = (terminal: CreateTerminalClickProof) => {
      const { native, capture, bubble } = terminal;
      const control = native.control;
      const action = native.action;
      const template = action.template;
      if (
        cells.delivery !== null ||
        cells.active !== publication ||
        retired ||
        publication.render !== render ||
        render.creating !== null ||
        render.operation !== null ||
        action.publicationIdentity !== identity ||
        action.controlIdentity !== control.identity ||
        action.kind !== control.kind ||
        controls.get(action.kind) !== control ||
        template !== (action.kind === "welcome" ? render.welcome : null) ||
        (action.kind === "welcome" &&
          (!render.hasGuided || template?.id !== WELCOME_TEMPLATE_ID)) ||
        !publicationOwnsCurrentDom() ||
        !nativeEventStillMatches(native) ||
        !createControlIsEnabled(control.element, control.root) ||
        cells.claimedPublications.has(publication) ||
        cells.claimedControls.has(control) ||
        cells.claimedActions.has(action) ||
        cells.claimedNativeEvents.has(native.event) ||
        cells.claimedReactEvents.has(capture.event) ||
        cells.claimedReactEvents.has(bubble.event)
      ) {
        rejectTerminal(native);
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedControls.add(control);
      cells.claimedActions.add(action);
      cells.claimedNativeEvents.add(native.event);
      cells.claimedReactEvents.add(capture.event);
      cells.claimedReactEvents.add(bubble.event);
      cells.delivery = identity;
      const create = render.create;
      publication.retire();
      clearEventProof();
      try {
        void create(template ?? undefined);
      } finally {
        if (cells.delivery === identity) cells.delivery = null;
      }
      return true;
    };
    const activate = (
      kind: CreateControlActionKind,
      event: ReactSyntheticEvent,
    ) => {
      const proof = nativeProof;
      const rootProof = reactRootProof;
      const captureProof = reactCaptureProof;
      if (
        !event ||
        typeof event !== "object" ||
        !proof ||
        proof.action.kind !== kind ||
        !rootProof ||
        !captureProof ||
        rootProof.native !== proof ||
        captureProof.native !== proof ||
        nativeBoundaryProof !== proof ||
        reactBubbleProof ||
        !startReactWrapper(event, captureProof.event)
      ) {
        return false;
      }
      if (
        event !== captureProof.event &&
        TRUSTED_OBJECT_GET_PROTOTYPE_OF(event) !==
          TRUSTED_OBJECT_GET_PROTOTYPE_OF(captureProof.event)
      ) {
        return false;
      }
      const matched = reactClickMatches(event, proof, proof.control.element);
      if (
        !matched ||
        matched.nativePhase !== ownerWindow.Event.BUBBLING_PHASE ||
        (matched.event === captureProof.event &&
          (matched.dispatchTarget !== captureProof.dispatchTarget ||
            matched.nativePhase !== captureProof.nativePhase))
      ) {
        rejectTerminal(proof);
        return false;
      }
      reactBubbleProof = matched;
      return deliver(
        Object.freeze({
          native: proof,
          root: rootProof,
          capture: captureProof,
          bubble: matched,
        }),
      );
    };

    const onNativeCapture = (event: Event) => {
      beginNativeEvent(event, "document-capture");
    };
    const onNativeBubble = (event: Event) => {
      if (nativeProof?.event !== event) return;
      clearEventProof(nativeProof);
    };
    const boundaryListeners = [...controls.values()].map((control) => {
      const listener = (event: Event) => {
        if (
          nativeProof?.event === event &&
          nativeProof.control === control &&
          nativeCurrentTarget(event) === control.element &&
          (nativePhaseOf(event) === ownerWindow.Event.CAPTURING_PHASE ||
            nativePhaseOf(event) === ownerWindow.Event.AT_TARGET) &&
          publicationOwnsCurrentDom() &&
          createControlIsEnabled(control.element, control.root)
        ) {
          nativeBoundaryProof = nativeProof;
        }
      };
      return Object.freeze({ control, listener });
    });
    const addNativeListeners = () => {
      TRUSTED_ADD_EVENT_LISTENER(ownerDocument, "click", onNativeCapture, true);
      TRUSTED_ADD_EVENT_LISTENER(ownerDocument, "click", onNativeBubble);
      for (const { control, listener } of boundaryListeners) {
        TRUSTED_ADD_EVENT_LISTENER(control.element, "click", listener, true);
      }
    };
    const releaseNativeListeners = () => {
      TRUSTED_REMOVE_EVENT_LISTENER(
        ownerDocument,
        "click",
        onNativeCapture,
        true,
      );
      TRUSTED_REMOVE_EVENT_LISTENER(ownerDocument, "click", onNativeBubble);
      for (const { control, listener } of boundaryListeners) {
        TRUSTED_REMOVE_EVENT_LISTENER(control.element, "click", listener, true);
      }
    };

    const runtime: CreateControlPublicationRuntime = Object.freeze({
      publication,
      publish: () => {
        established = true;
        refs = createControlExpectedOwners(render, owners).map((owner) => {
          const element = owner.element();
          if (!element) {
            throw new Error(
              "Cannot publish dashboard create controls without every committed ref",
            );
          }
          return { owner, element, state: "attached" as const };
        });
        guard = createControlDomGuard(ownerDocument, publishedRoots, () =>
          retire("other"),
        );
        if (
          !guard ||
          cells.active ||
          !createControlElementsAreExact(render, owners) ||
          !createControlRootsMatch(ownerDocument, publishedRoots) ||
          !guard.unchanged()
        ) {
          releaseGuard();
          return false;
        }
        cells.active = publication;
        cells.successorOf = null;
        cells.replay = null;
        addNativeListeners();
        return true;
      },
      retireForElement: () => {
        retire("element");
      },
      retireForLayout: () => {
        retire("layout");
      },
      noteRef: (
        owner: CreateControlElementOwnerView,
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
          (retirement === "layout" || retirement === "element") &&
          refs.every((entry) => entry.state === "reattached")) ||
          (!layoutRetired &&
            retirement === "element" &&
            refs.some((entry) => entry.state === "reattached") &&
            refs.every(
              (entry) =>
                entry.state === "attached" || entry.state === "reattached",
            ))) &&
        refs.length === createControlExpectedOwners(render, owners).length &&
        refs.every((entry) => entry.owner.element() === entry.element) &&
        createControlElementsAreExact(render, owners) &&
        createControlRootsMatch(ownerDocument, publishedRoots) &&
        Boolean(guard?.unchanged()),
      replay: () =>
        guard
          ? Object.freeze({
              source: publication,
              roots: publishedRoots,
              unchanged: guard.unchanged,
              release: releaseGuard,
            })
          : null,
      captureRoot,
      captureControl,
      activate,
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
    if (!createControlElementsAreExact(render, owners)) return;
    const replay = cells.replay;
    if (replay) {
      const sameFacts = createControlRendersMatch(replay.source.render, render);
      const exact =
        sameFacts &&
        replay.source.isRetired() &&
        cells.successorOf === replay.source &&
        replay.unchanged() &&
        replay.roots.length > 0 &&
        replay.roots.every((root) => {
          const currentRoot =
            root.role === "create-card"
              ? owners.card.element()
              : owners.guidedRoot.element();
          return (
            currentRoot === root.element &&
            root.dom.node === root.element &&
            templateGridDomMatches(root.dom) &&
            searchControlPlacementMatches(
              root.element.ownerDocument,
              root.placement,
            )
          );
        });
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

  const root = (role: CreateControlRootRole, event: ReactSyntheticEvent) =>
    currentRuntime?.captureRoot(role, event);
  const capture = (
    kind: CreateControlActionKind,
    event: ReactSyntheticEvent,
  ) => currentRuntime?.captureControl(kind, event);
  const bubble = (kind: CreateControlActionKind, event: ReactSyntheticEvent) => {
    currentRuntime?.activate(kind, event);
  };

  return Object.freeze({
    establish,
    captureCard: owners.card.capture,
    captureBlank: owners.blank.capture,
    captureBlankIconFrame: owners.blankIconFrame.capture,
    captureBlankIcon: owners.blankIcon.capture,
    captureBlankLabel: owners.blankLabel.capture,
    captureBlankName: owners.blankName.capture,
    captureBlankDescription: owners.blankDescription.capture,
    captureGuidedRoot: owners.guidedRoot.capture,
    captureGuidedIcon: owners.guidedIcon.capture,
    captureGuidedPrimary: owners.guidedPrimary.capture,
    captureGuidedSecondary: owners.guidedSecondary.capture,
    captureWelcome: owners.welcome.capture,
    captureWelcomeIcon: owners.welcomeIcon.capture,
    captureCardClick: (event: ReactMouseEvent<HTMLDivElement>) =>
      root("create-card", event),
    captureBlankClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      capture("blank", event),
    activateBlank: (event: ReactMouseEvent<HTMLButtonElement>) =>
      bubble("blank", event),
    captureGuidedClick: (event: ReactMouseEvent<HTMLDivElement>) =>
      root("guided-root", event),
    captureWelcomeClick: (event: ReactMouseEvent<HTMLButtonElement>) =>
      capture("welcome", event),
    activateWelcome: (event: ReactMouseEvent<HTMLButtonElement>) =>
      bubble("welcome", event),
  });
}

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

interface FilterNativeKeyProof {
  readonly identity: symbol;
  readonly event: KeyboardEvent;
  readonly publication: FilterPublication;
  readonly entry: FilterEntryPublication;
  readonly action: FilterActionPublication;
  readonly target: HTMLButtonElement;
  readonly path: readonly EventTarget[];
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly composing: boolean;
  readonly destination: Filter;
  readonly destinationButton: HTMLButtonElement;
  readonly trusted: true;
  readonly propagationStopped: () => boolean;
  crossed: boolean;
}

interface FilterTerminalKeyProof {
  readonly native: FilterNativeKeyProof;
  readonly reactCaptureEvent: object;
  readonly reactBubbleEvent: object;
}

interface FilterFocusRequest {
  readonly source: FilterPublication;
  readonly authority: FilterAuthority;
  readonly changeFilter: (next: Filter) => void;
  readonly destination: Filter;
  readonly button: HTMLButtonElement;
  readonly nativeEvent: KeyboardEvent;
  readonly reactCaptureEvent: object;
  readonly reactBubbleEvent: object;
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

function filterRenderIsExact(render: FilterRenderPublication) {
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
    render.currentFilter() === render.filter
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
  ) {
    const group = publicationOwners.group.element();
    const ownerDocument = group?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (
      !filterRenderIsExact(publicationRender) ||
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
    const composedPath = capturePrototypeMethod<
      (event: Event) => EventTarget[]
    >(ownerWindow.Event.prototype, "composedPath");
    const addEventListener = capturePrototypeMethod<
      (
        target: EventTarget,
        type: string,
        listener: (event: Event) => void,
        options?: boolean | AddEventListenerOptions,
      ) => void
    >(ownerWindow.EventTarget.prototype, "addEventListener");
    const removeEventListener = capturePrototypeMethod<
      (
        target: EventTarget,
        type: string,
        listener: (event: Event) => void,
        options?: boolean | EventListenerOptions,
      ) => void
    >(ownerWindow.EventTarget.prototype, "removeEventListener");
    const addWindowEventListener =
      capturePrototypeGetter<Window["addEventListener"]>(
        ownerWindow,
        "addEventListener",
      )?.(ownerWindow) ?? null;
    const removeWindowEventListener =
      capturePrototypeGetter<Window["removeEventListener"]>(
        ownerWindow,
        "removeEventListener",
      )?.(ownerWindow) ?? null;
    const preventDefault = capturePrototypeMethod<(event: Event) => void>(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const stopPropagation = capturePrototypeMethod<(event: Event) => void>(
      ownerWindow.Event.prototype,
      "stopPropagation",
    );
    const stopImmediatePropagation = capturePrototypeMethod<
      (event: Event) => void
    >(ownerWindow.Event.prototype, "stopImmediatePropagation");
    const focus = capturePrototypeMethod<
      (element: HTMLElement, options?: FocusOptions) => void
    >(ownerWindow.HTMLElement.prototype, "focus");
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
      !eventCancelBubble ||
      !keyboardKey ||
      !keyboardCtrl ||
      !keyboardMeta ||
      !keyboardAlt ||
      !keyboardShift ||
      !keyboardRepeat ||
      !keyboardComposing ||
      !composedPath ||
      !addEventListener ||
      !removeEventListener ||
      !addWindowEventListener ||
      !removeWindowEventListener ||
      !preventDefault ||
      !stopPropagation ||
      !stopImmediatePropagation ||
      !focus
    ) {
      return null;
    }
    let keyboardAuthorityHistoryIsClean = true;
    const keyboardAuthorityIsCurrent = () => {
      if (!keyboardAuthorityHistoryIsClean) return false;
      keyboardAuthorityHistoryIsClean =
        ownerDocument.defaultView === ownerWindow &&
        trustedAuthority.isCurrent() &&
        activeElementAuthority.isCurrent();
      return keyboardAuthorityHistoryIsClean;
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
    let nativeProof: FilterNativeKeyProof | null = null;
    let reactGroupProof: object | null = null;
    let reactCaptureProof: object | null = null;
    let reactBubbleProof: object | null = null;
    let boundaryProof: FilterNativeKeyProof | null = null;
    let terminal: FilterTerminalKeyProof | null = null;
    let windowTerminal: FilterTerminalKeyProof | null = null;
    let terminalWindow: Window | null = null;

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
    const removeWindowListener = () => {
      if (!terminalWindow) return;
      TRUSTED_REFLECT_APPLY(removeWindowEventListener, terminalWindow, [
        "keydown",
        onNativeWindowBubble,
      ]);
      terminalWindow = null;
    };
    const clearProof = (proof?: FilterNativeKeyProof) => {
      if (proof && nativeProof !== proof) return;
      removeWindowListener();
      nativeProof = null;
      reactGroupProof = null;
      reactCaptureProof = null;
      reactBubbleProof = null;
      boundaryProof = null;
      terminal = null;
      windowTerminal = null;
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
      clearProof();
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
    const nativeStillMatches = (proof: FilterNativeKeyProof) =>
      keyboardAuthorityIsCurrent() &&
      trustedAuthority.matches(proof.event) &&
      trustedAuthority.read(proof.event) === proof.trusted &&
      eventTarget(proof.event) === proof.target &&
      eventType(proof.event) === "keydown" &&
      eventBubbles(proof.event) &&
      eventCancelable(proof.event) &&
      keyboardKey(proof.event) === proof.key &&
      keyboardCtrl(proof.event) === proof.ctrlKey &&
      keyboardMeta(proof.event) === proof.metaKey &&
      keyboardAlt(proof.event) === proof.altKey &&
      keyboardShift(proof.event) === proof.shiftKey &&
      keyboardRepeat(proof.event) === proof.repeat &&
      keyboardComposing(proof.event) === proof.composing;

    const exactNativeEvent = (
      event: Event,
      entry: FilterEntryPublication,
    ): FilterNativeKeyProof | null => {
      if (
        !publicationOwnsCurrentDom() ||
        !keyboardAuthorityIsCurrent() ||
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
      const destination = destinationIndex === null
        ? null
        : publishedEntries[destinationIndex];
      if (
        !destination ||
        keyboardCtrl(event) ||
        keyboardMeta(event) ||
        keyboardAlt(event) ||
        keyboardShift(event) ||
        keyboardRepeat(event) ||
        keyboardComposing(event) ||
        !searchControlPathMatches(
          entry.path,
          composedPath(event),
          ownerDocument,
        ) ||
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          event,
          "stopPropagation",
        ) ||
        TRUSTED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          event,
          "stopImmediatePropagation",
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
            stopPropagation(event);
          },
        }) ||
        !TRUSTED_REFLECT_DEFINE_PROPERTY(event, "stopImmediatePropagation", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: () => {
            propagationStopped = true;
            stopImmediatePropagation(event);
          },
        })
      ) {
        return null;
      }
      return {
        identity: Symbol("dashboard-filter-native-key"),
        event: event as KeyboardEvent,
        publication,
        entry,
        action: entry.action,
        target: entry.element,
        path: entry.path,
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        composing: false,
        destination: destination.definition.value,
        destinationButton: destination.element,
        trusted: true,
        propagationStopped: () => propagationStopped,
        crossed: false,
      };
    };

    const beginNativeEvent = (event: Event) => {
      const entry = entryForEvent(event);
      if (!entry) return null;
      if (nativeProof) {
        if (nativeProof.event === event) return nativeProof;
        nativeProof.crossed = true;
        cells.attemptedNativeEvents.add(event);
        return null;
      }
      if (cells.attemptedNativeEvents.has(event)) return null;
      cells.attemptedNativeEvents.add(event);
      const proof = exactNativeEvent(event, entry);
      if (!proof) return null;
      nativeProof = proof;
      queueMicrotask(() => {
        if (nativeProof !== proof || terminal) return;
        clearProof(proof);
        publication.retire();
        requestSuccessor();
      });
      return proof;
    };

    const reactEventMatches = (
      event: object,
      proof: FilterNativeKeyProof,
      currentTarget: Element,
    ) => {
      const composing = searchControlOwnValue(event, "isComposing");
      return (
        searchControlOwnValue(event, "_reactName") === "onKeyDown" &&
        searchControlOwnValue(event, "type") === "keydown" &&
        searchControlOwnValue(event, "nativeEvent") === proof.event &&
        searchControlOwnValue(event, "target") === proof.target &&
        searchControlOwnValue(event, "currentTarget") === currentTarget &&
        searchControlOwnValue(event, "bubbles") === true &&
        searchControlOwnValue(event, "cancelable") === true &&
        searchControlOwnValue(event, "defaultPrevented") === false &&
        searchControlOwnValue(event, "isTrusted") === proof.trusted &&
        searchControlOwnValue(event, "key") === proof.key &&
        searchControlOwnValue(event, "ctrlKey") === false &&
        searchControlOwnValue(event, "metaKey") === false &&
        searchControlOwnValue(event, "altKey") === false &&
        searchControlOwnValue(event, "shiftKey") === false &&
        searchControlOwnValue(event, "repeat") === false &&
        (composing === SEARCH_CONTROL_MISSING || composing === false)
      );
    };

    const captureGroup = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        !event ||
        typeof event !== "object" ||
        cells.claimedReactEvents.has(event) ||
        cells.attemptedReactEvents.has(event)
      ) {
        return;
      }
      cells.attemptedReactEvents.add(event);
      const proof = nativeProof;
      if (
        !proof ||
        reactGroupProof ||
        !reactEventMatches(event, proof, group) ||
        !publicationOwnsCurrentDom()
      ) {
        return;
      }
      reactGroupProof = event;
    };
    const captureButton = (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const proof = nativeProof;
      if (
        !proof ||
        !reactGroupProof ||
        reactCaptureProof ||
        event !== reactGroupProof ||
        proof.entry.definition.value !== filter ||
        !reactEventMatches(event, proof, proof.entry.element)
      ) {
        return;
      }
      reactCaptureProof = event;
    };
    const bubbleButton = (
      filter: Filter,
      event: ReactKeyboardEvent<HTMLButtonElement>,
    ) => {
      const proof = nativeProof;
      const isNewWrapper =
        Boolean(event) &&
        typeof event === "object" &&
        event !== reactCaptureProof;
      if (
        !proof ||
        !reactCaptureProof ||
        reactBubbleProof ||
        (isNewWrapper &&
          (cells.claimedReactEvents.has(event) ||
            cells.attemptedReactEvents.has(event))) ||
        proof.entry.definition.value !== filter ||
        !reactEventMatches(event, proof, proof.entry.element)
      ) {
        return;
      }
      if (isNewWrapper) cells.attemptedReactEvents.add(event);
      reactBubbleProof = event;
    };

    const claim = (proof: FilterTerminalKeyProof) => {
      const native = proof.native;
      if (
        cells.claimedPublications.has(publication) ||
        cells.claimedEntries.has(native.entry) ||
        cells.claimedActions.has(native.action) ||
        cells.claimedNativeEvents.has(native.event) ||
        cells.claimedReactEvents.has(proof.reactCaptureEvent) ||
        cells.claimedReactEvents.has(proof.reactBubbleEvent)
      ) {
        return false;
      }
      cells.claimedPublications.add(publication);
      cells.claimedEntries.add(native.entry);
      cells.claimedActions.add(native.action);
      cells.claimedNativeEvents.add(native.event);
      cells.claimedReactEvents.add(proof.reactCaptureEvent);
      cells.claimedReactEvents.add(proof.reactBubbleEvent);
      return true;
    };

    const authenticateTerminal = (proof: FilterNativeKeyProof) => {
      if (
        proof.crossed ||
        boundaryProof !== proof ||
        !reactGroupProof ||
        reactCaptureProof !== reactGroupProof ||
        !reactBubbleProof ||
        !nativeStillMatches(proof) ||
        !publicationOwnsCurrentDom() ||
        activeElementAuthority.read(ownerDocument) !== proof.target
      ) {
        return null;
      }
      return Object.freeze({
        native: proof,
        reactCaptureEvent: reactGroupProof,
        reactBubbleEvent: reactBubbleProof,
      });
    };

    const settleTerminal = (proof: FilterTerminalKeyProof) => {
      const native = proof.native;
      if (
        terminal !== proof ||
        windowTerminal !== proof ||
        nativeProof !== native ||
        cells.delivery !== null ||
        cells.active !== publication ||
        eventCurrentTarget(native.event) !== null ||
        eventPhase(native.event) !== ownerWindow.Event.NONE ||
        eventDefaultPrevented(native.event) ||
        eventCancelBubble(native.event) ||
        native.propagationStopped() ||
        native.crossed ||
        activeElementAuthority.read(ownerDocument) !== native.target ||
        render.currentFilter() !== render.filter ||
        !nativeStillMatches(native) ||
        !publicationOwnsCurrentDom() ||
        !claim(proof)
      ) {
        clearProof(native);
        publication.retire();
        requestSuccessor();
        return;
      }
      cells.delivery = publication.identity;
      cells.pendingFocus = Object.freeze({
        source: publication,
        authority: render.authority,
        changeFilter: render.changeFilter,
        destination: native.destination,
        button: native.destinationButton,
        nativeEvent: native.event,
        reactCaptureEvent: proof.reactCaptureEvent,
        reactBubbleEvent: proof.reactBubbleEvent,
      });
      publication.retire();
      try {
        preventDefault(native.event);
        render.changeFilter(native.destination);
        requestSuccessor();
      } finally {
        if (cells.delivery === publication.identity) cells.delivery = null;
      }
    };

    const onNativeWindowBubble = (event: Event) => {
      if (
        !terminal ||
        terminal.native.event !== event ||
        eventCurrentTarget(event) === null ||
        eventPhase(event) !== ownerWindow.Event.BUBBLING_PHASE ||
        eventDefaultPrevented(event) ||
        eventCancelBubble(event) ||
        terminal.native.propagationStopped() ||
        !searchControlPathMatches(
          terminal.native.path,
          composedPath(event),
          ownerDocument,
        )
      ) {
        return;
      };
      windowTerminal = terminal;
    }
    const onNativeCapture = (event: Event) => {
      beginNativeEvent(event);
    };
    const onNativeBubble = (event: Event) => {
      const proof = nativeProof;
      if (
        !proof ||
        proof.event !== event ||
        eventCurrentTarget(event) !== ownerDocument ||
        eventPhase(event) !== ownerWindow.Event.BUBBLING_PHASE ||
        eventDefaultPrevented(event) ||
        eventCancelBubble(event)
      ) {
        return;
      }
      const authenticated = authenticateTerminal(proof);
      const windowTarget = proof.path.at(-1);
      if (!authenticated || windowTarget !== ownerWindow) {
        return;
      }
      terminal = authenticated;
      terminalWindow = ownerWindow;
      TRUSTED_REFLECT_APPLY(addWindowEventListener, ownerWindow, [
        "keydown",
        onNativeWindowBubble,
      ]);
      queueMicrotask(() => {
        if (terminal === authenticated) settleTerminal(authenticated);
      });
    };
    const boundaryListeners = publishedEntries.map((entry) => {
      const listener = (event: Event) => {
        if (
          nativeProof?.event === event &&
          nativeProof.entry === entry &&
          eventCurrentTarget(event) === entry.element &&
          (eventPhase(event) === ownerWindow.Event.CAPTURING_PHASE ||
            eventPhase(event) === ownerWindow.Event.AT_TARGET) &&
          publicationOwnsCurrentDom() &&
          keyboardAuthorityIsCurrent() &&
          activeElementAuthority.read(ownerDocument) === entry.element
        ) {
          boundaryProof = nativeProof;
        }
      };
      return Object.freeze({ entry, listener });
    });
    const addNativeListeners = () => {
      addEventListener(ownerDocument, "keydown", onNativeCapture, true);
      addEventListener(ownerDocument, "keydown", onNativeBubble);
      for (const { entry, listener } of boundaryListeners) {
        addEventListener(entry.element, "keydown", listener, true);
      }
    };
    const releaseNativeListeners = () => {
      removeEventListener(ownerDocument, "keydown", onNativeCapture, true);
      removeEventListener(ownerDocument, "keydown", onNativeBubble);
      removeWindowListener();
      for (const { entry, listener } of boundaryListeners) {
        removeEventListener(entry.element, "keydown", listener, true);
      };
    }

    const completePendingFocus = () => {
      const pending = cells.pendingFocus;
      const destination = publishedEntries.find(
        ({ definition }) => definition.value === render.filter,
      );
      if (!pending) return;
      if (
        pending.authority !== render.authority ||
        pending.changeFilter !== render.changeFilter ||
        pending.destination !== render.filter ||
        pending.button !== destination?.element ||
        pending.source.ownerDocument !== ownerDocument ||
        !pending.source.isRetired() ||
        !cells.claimedPublications.has(pending.source) ||
        !cells.claimedNativeEvents.has(pending.nativeEvent) ||
        !cells.claimedReactEvents.has(pending.reactCaptureEvent) ||
        !cells.claimedReactEvents.has(pending.reactBubbleEvent) ||
        cells.active !== publication ||
        cells.delivery !== null ||
        !publicationOwnsCurrentDom()
      ) {
        cells.pendingFocus = null;
        return;
      }
      cells.pendingFocus = null;
      focus(destination.element, { preventScroll: true });
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
        addNativeListeners();
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
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRefOwner = useRef<object | null>(null);
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
  const [searchControlCells] = useState<SearchControlPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    domBarrier: null,
    delivery: null,
    claimedPublications: new WeakSet(),
    claimedControls: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    attemptedReactEvents: new WeakSet(),
    attemptedNativeEvents: new WeakSet(),
  }));
  const [, setSearchControlRevision] = useState(0);
  const requestSearchControlSuccessor = useCallback(() => {
    setSearchControlRevision((revision) => revision + 1);
  }, []);
  useLayoutEffect(
    () => () => {
      searchControlCells.domBarrier?.release();
      searchControlCells.domBarrier = null;
    },
    [searchControlCells],
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
  const documents = useMemo(
    () => initialDocuments.map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d)),
    [initialDocuments, starStates],
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
  const retrySearch = useCallback(() => {
    if (!currentSearchError || currentSearchError.authority !== searchAuthority || currentSearchError.query !== trimmed || searchRequestOwner.current) return;
    runSearch(searchAuthority, currentSearchError.query);
  }, [currentSearchError, trimmed, runSearch, searchAuthority]);

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
  const filtered = useMemo<(Doc & { snippet?: string | null })[]>(() => {
    const matchesFilter = (d: Doc) => {
      if (filter === "mine" && d.ownerId !== user.id) return false;
      if (filter === "shared" && d.ownerId === user.id) return false;
      if (filter === "starred" && !d.starred) return false;
      return true;
    };
    // Search results keep their relevance order (title matches first); the sort applies to the browsing list.
    if (serverResults) return serverResults.map((d) => (starStates[d.id] ? { ...d, starred: starStates[d.id].value } : d)).filter(matchesFilter);
    const q = trimmed.toLowerCase();
    return documents.filter((d) => matchesFilter(d) && (!q || d.title.toLowerCase().includes(q))).sort(compareDocs(sort));
  }, [documents, serverResults, trimmed, filter, sort, user.id, starStates]);

  const starred = useMemo(() => documents.filter((d) => d.starred).sort(compareDocs(sort)), [documents, sort]);
  const showStrip = filter === "all" && !trimmed && starred.length > 0;

  const createOwner = useRef(user.id);
  const createOperation = useRef<CreateOperation | null>(null);
  const [createBusyOperation, setCreateBusyOperation] = useState<CreateOperation | null>(null);
  const creating = createBusyOperation?.ownerId === user.id ? createBusyOperation.key : null;
  const [openTemplates, setOpenTemplates] = useState(false);
  const [createMount] = useState(() => Symbol("dashboard-create"));
  const createAuthority = useMemo<CreateAuthority>(
    () =>
      Object.freeze({
        mount: createMount,
        visit: Symbol("dashboard-create-visit"),
        user,
        userId: user.id,
      }),
    [createMount, user],
  );
  const [createControlCells] = useState<CreateControlPublicationCells>(() => ({
    active: null,
    successorOf: null,
    replay: null,
    delivery: null,
    claimedPublications: new WeakSet(),
    claimedControls: new WeakSet(),
    claimedActions: new WeakSet(),
    claimedReactEvents: new WeakSet(),
    claimedNativeEvents: new WeakSet(),
    attemptedReactEvents: new WeakSet(),
    attemptedNativeEvents: new WeakSet(),
  }));
  const [, setCreateControlRevision] = useState(0);
  const requestCreateControlSuccessor = useCallback(() => {
    setCreateControlRevision((revision) => revision + 1);
  }, []);

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
        router.push(`/d/${res.document.id}`);
      } catch (err) {
        if (!isCurrent()) return;
        console.error(err);
        publishNotice({ message: apiErrorText(err, "Could not create the document"), kind: "error" });
      } finally {
        if (createOperation.current !== operation) return;
        createOperation.current = null;
        setCreateBusyOperation((current) => (current === operation ? null : current));
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
  const currentSearchResults =
    results?.authority === searchAuthority && results.query === trimmed
      ? results
      : null;
  const currentSearchRequest = searching ? searchingOwner : null;
  const resultOrder = Object.freeze([...filtered]);
  // The factory stores these callbacks for committed event delivery; it never reads a ref or invokes a callback during render.
  // eslint-disable-next-line react-hooks/refs
  const searchControlRender: SearchControlRenderPublication = Object.freeze({
    identity: Symbol("dashboard-search-controls-render"),
    mount: searchMount,
    authority: searchAuthority,
    user,
    userId: user.id,
    query,
    trimmed,
    results: currentSearchResults,
    serverResults,
    request: currentSearchRequest,
    error: currentSearchError,
    searching,
    pending,
    filter,
    filtered,
    resultOrder,
    setQuery,
    retry: retrySearch,
  });
  const {
    establish: establishSearchControls,
    captureSearchRoot,
    captureSearchIcon,
    captureInput: capturePublishedSearchInput,
    captureHint,
    captureLoadingIcon,
    captureInlineClear,
    captureInlineClearIcon,
    captureErrorRoot,
    captureErrorMessage,
    captureRetry,
    captureEmptyRoot,
    captureEmptyIcon,
    captureEmptyPrimary,
    captureEmptySecondary,
    captureEmptyClear,
    captureResultRoot,
    captureResultLinks,
    captureRootChange,
    captureInputChange,
    changeInput,
    captureRootKeyDown,
    captureInputKeyDown,
    keyDownInput,
    captureSearchClick,
    captureInlineClearClick,
    activateInlineClear,
    captureErrorClick,
    captureRetryClick,
    activateRetry,
    captureEmptyClick,
    captureEmptyClearClick,
    activateEmptyClear,
  } = createSearchControlPublication(
    searchControlRender,
    searchControlCells,
    requestSearchControlSuccessor,
  );
  const captureSearchInput = useCallback(
    (element: HTMLInputElement | null) => {
      const cleanup = capturePublishedSearchInput(element);
      if (element) {
        searchRefOwner.current = capturePublishedSearchInput;
        searchRef.current = element;
      } else if (searchRefOwner.current === capturePublishedSearchInput) {
        searchRefOwner.current = null;
        searchRef.current = null;
      }
      if (!element) return cleanup;
      return () => {
        cleanup?.();
        if (searchRefOwner.current === capturePublishedSearchInput) {
          searchRefOwner.current = null;
          searchRef.current = null;
        }
      };
    },
    [capturePublishedSearchInput],
  );
  useLayoutEffect(
    () => establishSearchControls(),
    [establishSearchControls],
  );
  const showCreateEmptyState =
    filter !== "trash" &&
    filtered.length === 0 &&
    !trimmed &&
    documents.length === 0;
  const welcomeTemplate = getTemplate(WELCOME_TEMPLATE_ID);
  // The factory stores these callbacks for committed event delivery; it never reads a ref or invokes a callback during render.
  // eslint-disable-next-line react-hooks/refs
  const createControlRender: CreateControlRenderPublication = Object.freeze({
    identity: Symbol("dashboard-create-controls-render"),
    mount: createMount,
    authority: createAuthority,
    user,
    userId: user.id,
    create,
    createDocument: api.documents.create,
    router,
    routerPush: router.push,
    operation: createBusyOperation,
    creating,
    welcome: welcomeTemplate,
    hasGuided: showCreateEmptyState,
  });
  const {
    establish: establishCreateControls,
    captureCard: captureCreateCard,
    captureBlank: captureCreateBlank,
    captureBlankIconFrame: captureCreateBlankIconFrame,
    captureBlankIcon: captureCreateBlankIcon,
    captureBlankLabel: captureCreateBlankLabel,
    captureBlankName: captureCreateBlankName,
    captureBlankDescription: captureCreateBlankDescription,
    captureGuidedRoot: captureCreateGuidedRoot,
    captureGuidedIcon: captureCreateGuidedIcon,
    captureGuidedPrimary: captureCreateGuidedPrimary,
    captureGuidedSecondary: captureCreateGuidedSecondary,
    captureWelcome: captureCreateWelcome,
    captureWelcomeIcon: captureCreateWelcomeIcon,
    captureCardClick: captureCreateCardClick,
    captureBlankClick: captureCreateBlankClick,
    activateBlank: activateCreateBlank,
    captureGuidedClick: captureCreateGuidedClick,
    captureWelcomeClick: captureCreateWelcomeClick,
    activateWelcome: activateCreateWelcome,
  } = createCreateControlPublication(
    createControlRender,
    createControlCells,
    requestCreateControlSuccessor,
  );
  useLayoutEffect(
    () => establishCreateControls(),
    [establishCreateControls],
  );
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
            <div
              ref={captureSearchRoot}
              className="relative mx-auto w-full max-w-xl"
              onChangeCapture={captureRootChange}
              onKeyDownCapture={captureRootKeyDown}
              onClickCapture={captureSearchClick}
            >
              <Search ref={captureSearchIcon} size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input
                ref={captureSearchInput}
                className={cn("input pl-9", query && searching ? "pr-16" : query ? "pr-9" : "pr-9 sm:pr-12")}
                placeholder="Search documents"
                aria-label="Search documents"
                value={query}
                onChangeCapture={captureInputChange}
                onChange={changeInput}
                onKeyDownCapture={captureInputKeyDown}
                onKeyDown={keyDownInput}
                data-testid="search"
              />
              {!query && (
                <span ref={captureHint} className="pointer-events-none absolute right-3 top-2 hidden text-ink-4 sm:block" aria-hidden="true">
                  <Kbd>/</Kbd>
                </span>
              )}
              {searching && <Loader2 ref={captureLoadingIcon} size={16} className={cn("pointer-events-none absolute top-2.5 animate-spin text-ink-4", query ? "right-9" : "right-3")} data-testid="search-loading" />}
              {query && (
                <button
                  ref={captureInlineClear}
                  type="button"
                  className="absolute right-0 top-0 inline-flex h-9 w-9 items-center justify-center text-ink-3 transition-colors hover:text-ink max-sm:-right-1 max-sm:-top-1 max-sm:h-11 max-sm:w-11"
                  onClickCapture={captureInlineClearClick}
                  onClick={activateInlineClear}
                  aria-label="Clear search"
                  data-testid="search-clear"
                >
                  <X ref={captureInlineClearIcon} size={16} />
                </button>
              )}
            </div>
            <ThemeToggle className="shrink-0" />
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="rounded-full" aria-label="Account">
                  <Avatar name={user.name} src={user.image} size={36} />
                </button>
              </MenuTrigger>
              <MenuContent align="end" className="w-56">
                <div className="px-2.5 py-2">
                  <div className="truncate text-sm font-medium text-ink">{user.name}</div>
                  {user.login && <div className="truncate text-xs text-ink-3">@{user.login}</div>}
                </div>
                <MenuItem icon={<Bot size={15} />} onSelect={() => router.push("/settings")}>
                  Agents &amp; API tokens
                </MenuItem>
                <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOutSafely()}>
                  Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>

        <section className="safe-x mx-auto max-w-6xl py-6 sm:py-8 sm:[--safe-pad:1.5rem]">
          <NotificationsStrip />
          <div className="mb-8 grid gap-3 sm:grid-cols-2">
            <div
              ref={captureCreateCard}
              className={CREATE_CARD_CLASS}
              onClickCapture={captureCreateCardClick}
            >
              <button
                ref={captureCreateBlank}
                type="button"
                onClickCapture={captureCreateBlankClick}
                onClick={activateCreateBlank}
                disabled={creating !== null}
                className={CREATE_BLANK_BUTTON_CLASS}
                data-testid="new-document"
              >
                <span ref={captureCreateBlankIconFrame} className={CREATE_BLANK_ICON_FRAME_CLASS}>{creating === CREATE_BLANK_KEY ? <Loader2 ref={captureCreateBlankIcon} className="animate-spin" /> : <FilePlus2 ref={captureCreateBlankIcon} size={22} />}</span>
                <span ref={captureCreateBlankLabel}>
                  <span ref={captureCreateBlankName} className={CREATE_BLANK_NAME_CLASS}>{CREATE_BLANK_NAME_TEXT}</span>
                  <span ref={captureCreateBlankDescription} className={CREATE_BLANK_DESCRIPTION_CLASS}>{CREATE_BLANK_DESCRIPTION_TEXT}</span>
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
              ref={captureErrorRoot}
              className="mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40"
              role="alert"
              aria-atomic="true"
              data-testid="search-error"
              onClickCapture={captureErrorClick}
            >
              <span ref={captureErrorMessage} className="min-w-0 flex-1">
                Content search failed: {currentSearchError.message}. Showing title matches only.
              </span>
              <button
                ref={captureRetry}
                type="button"
                className="btn btn-sm btn-outline shrink-0"
                onClickCapture={captureRetryClick}
                onClick={activateRetry}
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
              <div
                ref={captureCreateGuidedRoot}
                className={CREATE_GUIDED_ROOT_CLASS}
                onClickCapture={captureCreateGuidedClick}
              >
                <FileText ref={captureCreateGuidedIcon} className="mx-auto mb-3 text-ink-4" size={28} />
                <p ref={captureCreateGuidedPrimary} className={CREATE_GUIDED_PRIMARY_CLASS}>{CREATE_GUIDED_PRIMARY_TEXT}</p>
                <p ref={captureCreateGuidedSecondary} className={CREATE_GUIDED_SECONDARY_CLASS}>{CREATE_GUIDED_SECONDARY_TEXT}</p>
                <button
                  ref={captureCreateWelcome}
                  type="button"
                  className={CREATE_WELCOME_BUTTON_CLASS}
                  onClickCapture={captureCreateWelcomeClick}
                  onClick={activateCreateWelcome}
                  disabled={creating !== null}
                  aria-busy={creating === WELCOME_TEMPLATE_ID || undefined}
                  data-testid="start-guided-doc"
                >
                  {creating === WELCOME_TEMPLATE_ID ? <Loader2 ref={captureCreateWelcomeIcon} size={16} className="animate-spin" /> : <Sparkles ref={captureCreateWelcomeIcon} size={16} />} Start with a guided doc
                </button>
              </div>
              <TemplateGrid compact onPick={(t) => void create(t)} busy={creating} />
            </div>
          ) : filtered.length === 0 ? (
            <div
              ref={trimmed ? captureEmptyRoot : undefined}
              className="rounded-2xl border border-dashed border-line-2 bg-surface px-6 py-16 text-center"
              data-testid="empty-state"
              onClickCapture={trimmed ? captureEmptyClick : undefined}
            >
              <FileText ref={trimmed ? captureEmptyIcon : undefined} className="mx-auto mb-3 text-ink-4" size={28} />
              <p ref={trimmed ? captureEmptyPrimary : undefined} className="text-sm font-medium text-ink-2">
                {pending ? `Searching for "${trimmed}"…` : currentSearchError ? `No title matches for "${trimmed}"` : trimmed ? `No matches for "${trimmed}"` : filter === "starred" ? "No starred documents" : "No matches"}
              </p>
              <p ref={trimmed ? captureEmptySecondary : undefined} className="mt-1 text-sm text-ink-3">
                {pending ? "Looking through titles and content." : currentSearchError ? "Content results are unavailable. Retry the search above." : filter === "starred" && !trimmed ? "Hover a document and click the star to keep it close." : "Try a different search."}
              </p>
              {trimmed && !pending && (
                <button
                  ref={captureEmptyClear}
                  type="button"
                  className="mt-3 text-sm font-medium text-accent hover:underline"
                  onClickCapture={captureEmptyClearClick}
                  onClick={activateEmptyClear}
                  data-testid="empty-state-clear-search"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <ul
              ref={trimmed ? captureResultRoot : undefined}
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="document-list"
            >
              {filtered.map((d, index) => (
                <li key={d.id} className="group relative min-w-0" data-testid={trimmed ? "search-result" : undefined}>
                  <Link
                    ref={trimmed ? captureResultLinks[index] : undefined}
                    href={`/d/${d.id}`}
                    className="flex h-full flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md"
                    data-testid="document-card"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
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
                    <div className="mt-3 flex items-center gap-2 pr-8 text-xs text-ink-4">
                      <span>{sort === "recent" && d.lastOpenedAt ? <RelativeTime date={d.lastOpenedAt} prefix="Opened " /> : <RelativeTime date={d.updatedAt} prefix="Edited " />}</span>
                      {d.ownerId !== user.id && (
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} /> {d.ownerName ?? d.ownerLogin} · {d.role}
                        </span>
                      )}
                    </div>
                  </Link>
                  <StarButton starred={d.starred} pending={starStates[d.id]?.pending ?? false} onToggle={() => toggleStar(d)} className="absolute bottom-3 right-3" />
                </li>
              ))}
            </ul>
          )}
        </section>

        <Dialog open={openPicker} onOpenChange={setOpenPicker}>
          <DialogContent title="Open from GitHub" description="Pick a Markdown file. Markdoc keeps a live copy and publishes back when you ask it to." wide>
            <GitHubPicker mode="import" githubAvailable={githubAvailable} githubConfigured={githubConfigured} onImported={(id) => router.push(`/d/${id}`)} />
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
  readonly action: TrashActionPublication;
}

interface TrashCardPublication {
  readonly identity: symbol;
  readonly authority: TrashCardPresentation;
  readonly element: HTMLLIElement;
  readonly restore: TrashControlPublication;
  readonly purge: TrashControlPublication;
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
  }[];
  readonly establish: () => void | (() => void);
  readonly onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onRestore: (card: TrashCardPresentation, event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly onPurge: (card: TrashCardPresentation, event: ReactMouseEvent<HTMLButtonElement>) => void;
}

const allowTrashRetry = () => true;
const allowTrashAction = () => true;

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
        errorText.className !== "min-w-0 flex-1" ||
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
      return Object.freeze({
        identity: controlIdentity,
        publicationIdentity: identity,
        kind,
        cardIndex,
        element,
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
        return Object.freeze({
          identity: Symbol("trash-card"),
          authority: owned.authority,
          element,
          restore: control("restore", owned.authority.index, restore),
          purge: control("purge", owned.authority.index, purge),
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

  const nativeClick = (
    publication: TrashPublication,
    control: HTMLButtonElement,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): MouseEvent | null => {
    if (!event || typeof event !== "object") return null;
    const ownerWindow = publication.ownerDocument.defaultView;
    const nativeEvent = event.nativeEvent;
    const target = event.target;
    const reactEvent = event as ReactMouseEvent<HTMLButtonElement> & {
      _reactName?: unknown;
      isDefaultPrevented?: unknown;
      isPropagationStopped?: unknown;
      persist?: unknown;
    };
    const reactEventPrototype = Object.getPrototypeOf(event) as {
      constructor?: { name?: unknown };
    } | null;
    if (
      !ownerWindow ||
      !(nativeEvent instanceof ownerWindow.MouseEvent) ||
      !(target instanceof ownerWindow.Node) ||
      nativeEvent.type !== "click" ||
      nativeEvent.button !== 0 ||
      nativeEvent.eventPhase === ownerWindow.Event.NONE ||
      event.type !== "click" ||
      event.button !== 0 ||
      !event.bubbles ||
      event.currentTarget !== control ||
      target !== nativeEvent.target ||
      target.ownerDocument !== publication.ownerDocument ||
      !control.isConnected ||
      control.ownerDocument !== publication.ownerDocument ||
      !control.contains(target) ||
      !nativeEvent.composedPath().includes(control) ||
      !nativeEvent.composedPath().includes(publication.root) ||
      reactEventPrototype?.constructor?.name !== "SyntheticBaseEvent" ||
      reactEvent._reactName !== "onClick" ||
      typeof reactEvent.isDefaultPrevented !== "function" ||
      typeof reactEvent.isPropagationStopped !== "function" ||
      typeof reactEvent.persist !== "function"
    ) {
      return null;
    }
    const targetWasCommitted = (snapshot: TrashDomSnapshot): boolean =>
      snapshot.node === target ||
      snapshot.children.some(targetWasCommitted);
    const snapshot = currentRuntime?.snapshot();
    return snapshot && targetWasCommitted(snapshot) ? nativeEvent : null;
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

  const claim = (
    kind: TrashPublishedActionKind,
    card: TrashCardPresentation | null,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): {
    publication: TrashPublication;
    card: TrashCardPublication | null;
    release: () => void;
  } | null => {
    const runtime = currentRuntime;
    const publication = runtime?.publication;
    const publishedCard =
      publication && card && cards[card.index] === card
        ? publication.cards[card.index]
        : null;
    const control =
      kind === "retry"
        ? publication?.retry
        : kind === "restore"
          ? publishedCard?.restore
          : publishedCard?.purge;
    const action = control?.action;
    if (
      !runtime ||
      !publication ||
      !control ||
      !action ||
      control.kind !== kind ||
      !candidateIsCurrent(runtime, publication, publishedCard, control, action)
    ) {
      return null;
    }
    const nativeEvent = nativeClick(publication, control.element, event);
    if (
      !nativeEvent ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent) ||
      cells.evaluatingPublications.has(publication)
    ) {
      return null;
    }

    cells.evaluatingPublications.add(publication);
    let eligible = false;
    try {
      eligible =
        kind === "retry"
          ? Boolean(error) && !loading && render.canRetry(error!)
          : publishedCard !== null &&
            busy === null &&
            render.canAct(publishedCard.authority.document, kind);
    } finally {
      cells.evaluatingPublications.delete(publication);
    }
    if (
      !eligible ||
      !candidateIsCurrent(runtime, publication, publishedCard, control, action) ||
      cells.claimedReactEvents.has(event) ||
      cells.claimedNativeEvents.has(nativeEvent)
    ) {
      return null;
    }

    cells.claimedPublications.add(publication);
    if (publishedCard) cells.claimedCards.add(publishedCard);
    cells.claimedControls.add(control);
    cells.claimedActions.add(action);
    cells.claimedReactEvents.add(event);
    cells.claimedNativeEvents.add(nativeEvent);
    return {
      publication,
      card: publishedCard,
      release: () => {
        cells.claimedPublications.delete(publication);
        if (publishedCard) cells.claimedCards.delete(publishedCard);
        cells.claimedControls.delete(control);
        cells.claimedActions.delete(action);
      },
    };
  };

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
    onRetry: (event: ReactMouseEvent<HTMLButtonElement>) => {
      const claimed = claim("retry", null, event);
      if (!claimed) return;
      try {
        claimed.publication.render.onRetry();
      } finally {
        claimed.release();
      }
    },
    onRestore: (
      card: TrashCardPresentation,
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => {
      const claimed = claim("restore", card, event);
      if (claimed?.card) {
        try {
          claimed.publication.render.onRestore(claimed.card.authority.document);
        } finally {
          claimed.release();
        }
      }
    },
    onPurge: (
      card: TrashCardPresentation,
      event: ReactMouseEvent<HTMLButtonElement>,
    ) => {
      const claimed = claim("purge", card, event);
      if (claimed?.card) {
        try {
          claimed.publication.render.onPurge(claimed.card.authority.document);
        } finally {
          claimed.release();
        }
      }
    },
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
    onRetry: publishRetry,
    onRestore: publishRestore,
    onPurge: publishPurge,
  } = publication;

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
          <span className="min-w-0 flex-1">{presentation.error}</span>
          <button
            ref={captureRetry}
            type="button"
            className="btn btn-sm btn-outline shrink-0 gap-1.5"
            onClick={publishRetry}
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
                      onClick={(event) => publishRestore(card, event)}
                      data-testid="restore-button"
                    >
                      {card.busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                    </button>
                    <button
                      ref={publishedCard.capturePurge}
                      type="button"
                      className="btn btn-sm gap-1 whitespace-nowrap text-danger hover:bg-red-50 dark:hover:bg-red-950/40"
                      disabled={presentation.busy !== null}
                      onClick={(event) => publishPurge(card, event)}
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
