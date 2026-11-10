// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  StrictMode,
  startTransition,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSummaryDto, FolderDto, SearchResultDto } from "@/lib/api";
import type { PendingNotice } from "@/lib/notice";

type SearchResponse = { query: string; documents: SearchResultDto[] };
type ListOptions = { starred?: boolean; trash?: boolean };
type ListResponse = { documents: DocumentSummaryDto[] };
type CreateResponse = { document: { id: string; title: string } };
const searchDocuments = vi.fn<(query: string, init?: RequestInit) => Promise<SearchResponse>>();
const listDocuments = vi.fn<(options?: ListOptions) => Promise<ListResponse>>();
const createDocument = vi.fn<(body?: { template?: string }) => Promise<CreateResponse>>();
const restoreDocument = vi.fn<(id: string) => Promise<{ ok: true }>>();
const purgeDocument = vi.fn<(id: string, options?: { permanent?: boolean }) => Promise<{ ok: true; permanent: boolean }>>();
const starDocument = vi.fn<(id: string) => Promise<{ starred: true }>>();
const unstarDocument = vi.fn<(id: string) => Promise<{ starred: false }>>();
const listFolders = vi.fn<() => Promise<{ folders: FolderDto[] }>>();
const takePendingNotice = vi.fn<() => PendingNotice | null>();
const signOutSafely = vi.fn<() => Promise<boolean>>();
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard/notifications-strip", () => ({ NotificationsStrip: () => null }));
vi.mock("@/components/ui/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/lib/notice", () => ({ takePendingNotice: () => takePendingNotice() }));
vi.mock("@/lib/sign-out", () => ({
  signOutSafely: () => signOutSafely(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        search: (query: string, init?: RequestInit) => searchDocuments(query, init),
        list: (options?: ListOptions) => listDocuments(options),
        create: (body?: { template?: string }) => createDocument(body),
        restore: (id: string) => restoreDocument(id),
        delete: (id: string, options?: { permanent?: boolean }) =>
          options === undefined ? purgeDocument(id) : purgeDocument(id, options),
        star: (id: string) => starDocument(id),
        unstar: (id: string) => unstarDocument(id),
      },
      // The dashboard asks for folders on mount. Stubbed so these tests never reach the network;
      // the folder UI itself is covered in folders.test.tsx.
      folders: { ...actual.api.folders, list: () => listFolders() },
    },
  };
});

import { ApiError } from "@/lib/api";
import { PICKER_TEMPLATES, type Template } from "@/lib/templates";
import { Dashboard, TemplateGrid, TrashView, type DashboardProps } from "./dashboard";

const SEARCH_DEBOUNCE_MS = 250;
const USER = { id: "owner", name: "Owner", login: "owner", image: null };

function doc(id: string, title: string, excerpt = ""): DocumentSummaryDto {
  return {
    id,
    title,
    excerpt,
    storage: "local",
    updatedAt: "2026-09-07T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z",
    lastOpenedAt: null,
    deletedAt: null,
    ownerId: USER.id,
    ownerName: USER.name,
    ownerLogin: USER.login,
    role: "owner",
    repoOwner: null,
    repoName: null,
    repoPath: null,
    gistId: null,
    starred: false,
    folderId: null,
    folderName: null,
  };
}

function result(id: string, title: string, snippet: string | null): SearchResultDto {
  return { ...doc(id, title), snippet };
}

function trashedDoc(id: string, title: string): DocumentSummaryDto {
  return { ...doc(id, title), deletedAt: "2026-09-07T13:00:00.000Z" };
}

function folder(id: string, name: string, documentCount: number): FolderDto {
  return {
    id,
    name,
    documentCount,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
    ownerId: USER.id,
    ownerName: USER.name,
    ownerLogin: USER.login,
    role: "owner",
    linkAccess: "private",
  };
}

const DOCUMENTS = [
  doc("alpha-title", "Alpha planning", "Safe title match"),
  doc("notes", "Meeting notes", "An ordinary excerpt"),
];

function renderDashboard(children?: React.ReactNode, documents = DOCUMENTS) {
  return render(
    <>
      <Dashboard user={USER} documents={documents} githubAvailable githubConfigured />
      {children}
    </>,
  );
}

function TransitionUnmount({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button type="button" data-testid="unmount-dashboard" onClick={() => startTransition(() => setMounted(false))}>
        Unmount dashboard
      </button>
      {mounted ? children : null}
    </>
  );
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}


function DashboardBoundary({
  user = USER,
  documents = DOCUMENTS,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup = () => {},
}: {
  user?: typeof USER;
  documents?: DocumentSummaryDto[];
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <>
      <Dashboard user={user} documents={documents} githubAvailable githubConfigured />
      <PassiveCleanupProbe key={user.id} onCleanup={onPassiveCleanup} />
    </>
  ) : null;
}

function openTrash() {
  fireEvent.click(screen.getByTestId("filter-trash"));
}

function leaveTrash() {
  fireEvent.click(screen.getByTestId("filter-all"));
}

function trashButton(title: string, action: "restore-button" | "purge-button") {
  return within(screen.getByText(title).closest('[data-testid="trash-card"]')!).getByTestId(action);
}

async function settleSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  });
}

async function dispatchSearchAction(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledSearch<T>() {
  type Chain = {
    then: (handler: (value: T) => unknown) => Chain;
    catch: (handler: (reason: unknown) => unknown) => Chain;
    finally: (handler: () => unknown) => Chain;
  };
  let success: ((value: T) => unknown) | undefined;
  let failure: ((reason: unknown) => unknown) | undefined;
  let finalizer: (() => unknown) | undefined;
  const chain: Chain = {
    then(handler) {
      success = handler;
      return chain;
    },
    catch(handler) {
      failure = handler;
      return chain;
    },
    finally(handler) {
      finalizer = handler;
      return chain;
    },
  };
  return {
    promise: chain as unknown as Promise<T>,
    resolve: (value: T) => success?.(value),
    reject: (reason: unknown) => failure?.(reason),
    finalize: () => finalizer?.(),
  };
}

function documentStar(title: string) {
  const list = screen.getByTestId("document-list");
  const link = within(list).getByRole("link", { name: new RegExp(title) });
  return within(link.closest("li")!).getByTestId("star-toggle");
}

function openDocumentMenu(title: string) {
  const list = screen.getByTestId("document-list");
  const link = within(list).getByRole("link", { name: new RegExp(title) });
  const card = link.closest("li");
  if (!card) throw new Error(`Document card ${title} was not rendered`);
  fireEvent.pointerDown(within(card).getByTestId("document-menu"), { button: 0, ctrlKey: false });
  return screen.getByRole("menu");
}

type CapturedClick = (event?: unknown) => void;
type CapturedReactClick = (event: unknown) => void;
type CapturedReactRef = (node: Element | null) => void;

function captureClick(element: HTMLElement): CapturedClick {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the button");
  const props = (element as unknown as Record<string, { onClick?: CapturedClick } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The button did not have an onClick handler");
  return props.onClick;
}

function reactPropsEntry(element: Element): {
  key: string;
  record: Record<string, ReactTestProps>;
  props: ReactTestProps;
} {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const record = element as unknown as Record<
    string,
    {
      onClick?: CapturedReactClick;
      onClickCapture?: CapturedReactClick;
      onChange?: CapturedReactClick;
      onChangeCapture?: CapturedReactClick;
      onKeyDown?: CapturedReactClick;
      onKeyDownCapture?: CapturedReactClick;
      ref?: CapturedReactRef;
    }
  >;
  return { key: propsKey, record, props: record[propsKey]! };
}

function reactProps(element: Element): {
  onClick?: CapturedReactClick;
  onClickCapture?: CapturedReactClick;
  onChange?: CapturedReactClick;
  onChangeCapture?: CapturedReactClick;
  onKeyDown?: CapturedReactClick;
  onKeyDownCapture?: CapturedReactClick;
  ref?: CapturedReactRef;
} {
  return reactPropsEntry(element).props;
}

interface ReactTestProps {
  onClick?: CapturedReactClick;
  onClickCapture?: CapturedReactClick;
  onChange?: CapturedReactClick;
  onChangeCapture?: CapturedReactClick;
  onKeyDown?: CapturedReactClick;
  onKeyDownCapture?: CapturedReactClick;
  ref?: CapturedReactRef;
}

type ReactEventHandlerName =
  | "onClick"
  | "onChange"
  | "onKeyDownCapture"
  | "onKeyDown";

function captureReactHandler(
  element: Element,
  name: ReactEventHandlerName,
): CapturedReactClick {
  const handler = reactProps(element)[name];
  if (!handler) throw new Error(`${name} was not attached to the element`);
  return handler;
}

function interceptReactHandler(
  element: Element,
  name: ReactEventHandlerName,
  invoke: (original: CapturedReactClick, event: unknown) => void,
): () => void {
  const { key, record, props } = reactPropsEntry(element);
  const original = props[name];
  if (!original) throw new Error(`${name} was not attached to the element`);
  const intercepted = {
    ...props,
    [name]: (event: unknown) => invoke(original, event),
  };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}


function captureReactClick(element: HTMLButtonElement): CapturedReactClick {
  const onClick = reactProps(element).onClick;
  if (!onClick) throw new Error("The button did not have an onClick handler");
  return onClick;
}

function captureReactRef(element: Element): CapturedReactRef {
  const ref = reactProps(element).ref;
  if (!ref) throw new Error("The element did not have a callback ref");
  return ref;
}

function interceptReactClick(
  element: HTMLButtonElement,
  invoke: (original: CapturedReactClick, event: unknown) => void,
): () => void {
  const { key, record, props } = reactPropsEntry(element);
  const original = props.onClick;
  if (!original) throw new Error("The button did not have an onClick handler");
  const intercepted = { ...props, onClick: (event: unknown) => invoke(original, event) };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

// A production build minifies React's SyntheticBaseEvent class name, so the event's constructor is named "a" or similar.
const MangledSyntheticEvent = class a {};

function interceptMangledReactClick(element: HTMLButtonElement): () => void {
  return interceptReactClick(element, (original, event) => {
    if (!event || typeof event !== "object") {
      throw new Error("The React click event was not an object");
    }
    const prototype = Object.create(Object.getPrototypeOf(event), {
      constructor: { value: MangledSyntheticEvent },
    });
    const mangled = Object.assign(Object.create(prototype), event);
    expect(Object.getPrototypeOf(mangled).constructor).toBe(MangledSyntheticEvent);
    expect(Object.getPrototypeOf(mangled).constructor.name).toBe("a");
    original(mangled);
  });
}

function directTrashCard(host: HTMLElement, title: string): HTMLLIElement {
  const heading = Array.from(host.querySelectorAll("h3")).find((candidate) => candidate.textContent === title);
  const card = heading?.closest<HTMLLIElement>('[data-testid="trash-card"]');
  if (!card) throw new Error(`Trash card ${title} was not rendered`);
  return card;
}

function directTrashButton(host: HTMLElement, title: string, action: "restore-button" | "purge-button"): HTMLButtonElement {
  const button = directTrashCard(host, title).querySelector<HTMLButtonElement>(`[data-testid="${action}"]`);
  if (!button) throw new Error(`${action} was not rendered for ${title}`);
  return button;
}

function directRetryButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="trash-error"] button');
  if (!button) throw new Error("Trash Retry was not rendered");
  return button;
}


function createTrashKeyboardEvent(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Trash key target has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: ownerWindow,
    ...init,
  });
  if (trusted) markSearchResultEventTrusted(event, ownerWindow);
  return event;
}

function dispatchTrashKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const event = createTrashKeyboardEvent(target, key, init, trusted);
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const first = trashedDoc("keyboard-first", "Keyboard first");
const second = trashedDoc("keyboard-second", "Keyboard second");
const trash = (
  documents: DocumentSummaryDto[] = [first, second],
  busy: string | null = null,
  error: string | null = "Trash warning",
  callbacks: {
    onRetry: () => void;
    onRestore: (document: DocumentSummaryDto) => void;
    onPurge: (document: DocumentSummaryDto) => void;
  } = {
    onRetry: () => {},
    onRestore: () => {},
    onPurge: () => {},
  },
  key?: string,
) => (
  <StrictMode>
    <TrashView
      key={key}
      documents={documents}
      busy={busy}
      loading={false}
      error={error}
      onRetry={callbacks.onRetry}
      onRestore={callbacks.onRestore}
      onPurge={callbacks.onPurge}
    />
  </StrictMode>
);

function renderTrashKeyboard<Setup>(
  node: ReactNode,
  setup: (ownerWindow: Window & typeof globalThis) => Setup,
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const ownerDocument = frame.contentDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (!ownerDocument || !ownerWindow) {
    frame.remove();
    throw new Error("The Trash keyboard frame has no owner realm");
  }
  const host = ownerDocument.createElement("div");
  ownerDocument.body.append(host);
  const configured = setup(ownerWindow);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    frame,
    host,
    ownerDocument,
    ownerWindow,
    root,
    setup: configured,
    dispose: () => {
      act(() => root.unmount());
      frame.remove();
    },
  };
}

function trackTrashNavigationEffects(
  ownerWindow: Window & typeof globalThis,
) {
  const nativePreventDefault =
    ownerWindow.Event.prototype.preventDefault;
  const nativeFocus = ownerWindow.HTMLElement.prototype.focus;
  const focusCalls: {
    target: HTMLElement;
    options: FocusOptions | undefined;
  }[] = [];
  const preventDefault = vi
    .spyOn(ownerWindow.Event.prototype, "preventDefault")
    .mockImplementation(function (this: Event) {
      Reflect.apply(nativePreventDefault, this, []);
    });
  const focus = vi
    .spyOn(ownerWindow.HTMLElement.prototype, "focus")
    .mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      focusCalls.push({ target: this, options });
      Reflect.apply(
        nativeFocus,
        this,
        options === undefined ? [] : [options],
      );
    });
  const scrollTo = vi
    .spyOn(ownerWindow, "scrollTo")
    .mockImplementation(() => undefined);
  const scrollBy = vi
    .spyOn(ownerWindow, "scrollBy")
    .mockImplementation(() => undefined);
  return {
    nativePreventDefault,
    nativeFocus,
    preventDefault,
    focus,
    focusCalls,
    scrollTo,
    scrollBy,
  };
}


function templateButton(host: HTMLElement, id: string): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="template-${id}"]`);
  if (!button) throw new Error(`Template button ${id} was not rendered`);
  return button;
}

type CreateControlTestId = "new-document" | "start-guided-doc";
type FilterValue = "all" | "mine" | "shared" | "starred" | "trash";

function directCreateButton(host: HTMLElement, testid: CreateControlTestId): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
  if (!button) throw new Error(`${testid} was not rendered`);
  return button;
}

function filterGroup(host: ParentNode = document): HTMLDivElement {
  const group = host.querySelector<HTMLDivElement>(
    '[role="toolbar"][aria-label="Document filters"]',
  );
  if (!group) throw new Error("The document filter toolbar was not rendered");
  return group;
}

function directFilterButton(
  host: ParentNode,
  filter: FilterValue,
): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    `[data-testid="filter-${filter}"]`,
  );
  if (!button) throw new Error(`The ${filter} filter was not rendered`);
  return button;
}


function markFilterEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) => (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

function markFilterEventView(event: KeyboardEvent, view: unknown) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) => (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find(
      (candidate): candidate is { view: unknown } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "view" in candidate,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "view")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set jsdom's internal event view slot");
  }
  implementation.view = view;
  if (event.view !== view) {
    throw new Error("The jsdom event view slot did not update");
  }
}

function markSearchResultEventTrusted(
  event: KeyboardEvent,
  ownerWindow: Window,
) {
  markFilterEventTrusted(event);
  markFilterEventView(event, ownerWindow);
}

async function dispatchFilterKey(
  button: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const KeyboardEventConstructor =
    button.ownerDocument.defaultView!.KeyboardEvent;
  const event = new KeyboardEventConstructor("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markFilterEventTrusted(event);
  await act(async () => {
    button.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}




function expectCurrentFilter(
  host: ParentNode,
  filter: FilterValue,
) {
  const group = filterGroup(host);
  const buttons = Array.from(
    group.querySelectorAll<HTMLButtonElement>("button"),
  );
  expect(buttons).toHaveLength(5);
  expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([
    directFilterButton(host, filter),
  ]);
  for (const button of buttons) {
    expect(button).toHaveAttribute(
      "aria-pressed",
      String(button === directFilterButton(host, filter)),
    );
  }
}

function createCardRoot(host: HTMLElement): HTMLDivElement {
  const card = directCreateButton(host, "new-document").parentElement;
  if (!(card instanceof HTMLDivElement)) throw new Error("The create card was not rendered");
  return card;
}

function guidedRootElement(host: HTMLElement): HTMLDivElement {
  const guided = directCreateButton(host, "start-guided-doc").parentElement;
  if (!(guided instanceof HTMLDivElement)) throw new Error("The guided block was not rendered");
  return guided;
}

function templateGrid(host: HTMLElement): HTMLUListElement {
  const grid = host.querySelector<HTMLUListElement>('[data-testid="template-grid"]');
  if (!grid) throw new Error("Template grid was not rendered");
  return grid;
}

function fabricatedTemplateClick(
  button: HTMLButtonElement,
  target: EventTarget = button,
) {
  const MouseEventConstructor = button.ownerDocument.defaultView!.MouseEvent;
  return {
    type: "click",
    button: 0,
    buttons: 0,
    detail: 1,
    bubbles: true,
    defaultPrevented: false,
    currentTarget: button,
    target,
    nativeEvent: new MouseEventConstructor("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      detail: 1,
    }),
  };
}

function expectInertTemplateCall(
  callback: CapturedReactClick,
  event: unknown,
  host: HTMLElement,
) {
  const activeElement = document.activeElement;
  const markup = host.innerHTML;
  callback(event);
  expect(document.activeElement).toBe(activeElement);
  expect(host.innerHTML).toBe(markup);
}

function searchResultLinks(host: ParentNode = document) {
  return Array.from(
    host.querySelectorAll<HTMLAnchorElement>(
      '[data-testid="search-result"] > a[data-testid="document-card"]',
    ),
  );
}

async function dispatchSearchResultKey(
  source: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const event = searchResultKeyEvent(source, key, init);
  await act(async () => {
    source.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function searchResultKeyEvent(
  source: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
) {
  const ownerWindow = source.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The search key source has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markSearchResultEventTrusted(event, ownerWindow);
  return event;
}

function accountTrigger(host: ParentNode = document): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Account"]',
  );
  if (!trigger) throw new Error("The Account trigger was not rendered");
  return trigger;
}

function accountMenuItem(name: "Settings" | "Sign out") {
  const item = screen.getByRole("menuitem", { name });
  if (!(item instanceof HTMLDivElement)) {
    throw new Error(`The ${name} Account item was not a div`);
  }
  return item;
}

function accountKeyEvent(
  trigger: HTMLButtonElement,
  key: "ArrowDown" | "ArrowUp",
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = trigger.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Account trigger has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true,
    location: 0,
    ...init,
  });
  if (trusted) markFilterEventTrusted(event);
  return event;
}

function accountViewedKeyEvent(
  trigger: HTMLButtonElement,
  key: "ArrowDown" | "ArrowUp",
  view: Window,
) {
  try {
    const event = accountKeyEvent(trigger, key, { view });
    return event.view === view ? event : null;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

async function dispatchAccountKey(
  trigger: HTMLButtonElement,
  keyOrEvent: "ArrowDown" | "ArrowUp" | KeyboardEvent,
  init: KeyboardEventInit = {},
) {
  const event =
    typeof keyOrEvent === "string"
      ? accountKeyEvent(trigger, keyOrEvent, init)
      : keyOrEvent;
  await act(async () => {
    trigger.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

type KeydownCallback = (event: KeyboardEvent) => void;

function eventCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  return typeof options === "boolean" ? options : options?.capture === true;
}

function trackWindowKeydownListeners() {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const added = (capture: boolean) =>
    add.mock.calls
      .filter(([type, listener, options]) => type === "keydown" && typeof listener === "function" && eventCapture(options) === capture)
      .map(([, listener]) => listener as KeydownCallback);
  const removalCount = (callback: KeydownCallback, capture: boolean) =>
    remove.mock.calls.filter(
      ([type, listener, options]) => type === "keydown" && listener === callback && eventCapture(options) === capture,
    ).length;
  const active = (capture: boolean) => added(capture).filter((callback) => removalCount(callback, capture) === 0);
  return { active, added, removalCount };
}

function shortcutEvent(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const preventDefault = vi.spyOn(event, "preventDefault");
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  return { event, preventDefault, stopPropagation };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  searchDocuments.mockReset();
  searchDocuments.mockImplementation(async (query) => ({ query, documents: [] }));
  listDocuments.mockReset();
  listDocuments.mockResolvedValue({ documents: [] });
  listFolders.mockReset();
  listFolders.mockResolvedValue({ folders: [] });
  createDocument.mockReset();
  createDocument.mockResolvedValue({ document: { id: "created", title: "Untitled" } });
  restoreDocument.mockReset();
  restoreDocument.mockResolvedValue({ ok: true });
  purgeDocument.mockReset();
  purgeDocument.mockResolvedValue({ ok: true, permanent: true });
  starDocument.mockReset();
  starDocument.mockResolvedValue({ starred: true });
  unstarDocument.mockReset();
  unstarDocument.mockResolvedValue({ starred: false });
  takePendingNotice.mockReset();
  takePendingNotice.mockReturnValue(null);
  signOutSafely.mockReset();
  signOutSafely.mockResolvedValue(true);
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  router.prefetch.mockReset();
  router.back.mockReset();
  router.forward.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dashboard Account menu identity titles", () => {
  const identities = [
    {
      ...USER,
      name: `  ${'Alex <strong title="Full name">Mixed CASE & "quotes"</strong> '.repeat(5)}  `,
      login: `  ${'MiXeD-<img src="identity" alt=\'literal\'>-&-'.repeat(6)}  `,
    },
    {
      ...USER,
      id: "second-account",
      name: ` ${"Morgan <em data-name='Other'>Another \"identity\" & CASE</em> ".repeat(5)} `,
      login: ` ${'OtHeR-<a href="/settings">"literal"</a>-'.repeat(6)} `,
    },
  ];

  function expectIdentity(user: DashboardProps["user"]) {
    const menu = screen.getByRole("menu", { name: "Account" });
    const metadata = menu.firstElementChild;
    if (!(metadata instanceof HTMLDivElement)) {
      throw new Error("The Account metadata was not a div");
    }
    const name = metadata.children.item(0);
    const login = metadata.children.item(1);
    expect(metadata.className).toBe("px-2.5 py-2");
    expect(metadata.children).toHaveLength(user.login ? 2 : 1);
    expect(metadata.querySelectorAll("*")).toHaveLength(user.login ? 2 : 1);
    expect(name).toBeInstanceOf(HTMLDivElement);
    expect(name?.className).toBe("truncate text-sm font-medium text-ink");
    expect(name?.textContent).toBe(user.name);
    expect(name?.getAttribute("title")).toBe(user.name);
    expect(name?.getAttributeNames().sort()).toEqual(["class", "title"]);
    if (user.login) {
      expect(login).toBeInstanceOf(HTMLDivElement);
      expect(login?.className).toBe("truncate text-xs text-ink-3");
      expect(login?.textContent).toBe(`@${user.login}`);
      expect(login?.getAttribute("title")).toBe(`@${user.login}`);
      expect(login?.getAttributeNames().sort()).toEqual(["class", "title"]);
    } else {
      expect(login).toBeNull();
    }
    expect([...menu.querySelectorAll("[title]")]).toEqual(
      user.login ? [name, login] : [name],
    );
    expect(menu.querySelector('[title="@undefined"], [title="@null"]')).toBeNull();
    expect(metadata.querySelector('a, button, input, [tabindex], [role], [aria-label]')).toBeNull();
    expect(menu.className).toBe(
      "menu animate-fade-in max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto w-56",
    );
    const settings = accountMenuItem("Settings");
    const signOut = accountMenuItem("Sign out");
    expect([...menu.children]).toEqual([metadata, settings, signOut]);
    expect(within(menu).getAllByRole("menuitem")).toEqual([settings, signOut]);
    expect([...menu.querySelectorAll("[tabindex]")]).toEqual([settings, signOut]);
    expect(settings.className).toBe("menu-item");
    expect(signOut.className).toBe("menu-item");
    expect(menu).toHaveAttribute("tabindex", "0");
    expect(accountTrigger()).toHaveAccessibleName("Account");
    expect(accountTrigger().children).toHaveLength(1);
    return { menu, metadata, name, login };
  }

  function dashboard(user: DashboardProps["user"]) {
    return <Dashboard user={user} documents={DOCUMENTS} githubAvailable githubConfigured />;
  }

  function openAccount() {
    fireEvent.pointerDown(accountTrigger(), { button: 0, ctrlKey: false });
  }

  async function closeAccount() {
    fireEvent.keyDown(accountMenuItem("Settings"), { key: "Escape", code: "Escape" });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(screen.queryByRole("menu")).toBeNull();
  }

  it.each(identities)("keeps long literal identity $id exact and passive on the existing divs", async (user) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fetch = vi.spyOn(globalThis, "fetch");
    render(dashboard(user));
    openAccount();
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(user.name.length).toBeGreaterThanOrEqual(200);
    expect(user.login.length).toBeGreaterThanOrEqual(200);
    const { menu, metadata } = expectIdentity(user);
    const avatar = accountTrigger().firstElementChild;
    const markup = menu.outerHTML;
    const activeElement = document.activeElement;
    const effects = [
      ...Object.values(router), signOutSafely, fetch, searchDocuments, listDocuments,
      createDocument, restoreDocument, purgeDocument, starDocument, unstarDocument, focus,
    ];
    for (const effect of effects) effect.mockClear();
    const schedules = [
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(window, "requestAnimationFrame"),
    ];
    // Measure only synchronous hover dispatch, not React/Radix's async setup or cleanup.
    const timers = vi.getTimerCount();
    for (const element of metadata.children) {
      fireEvent.pointerOver(element, { pointerType: "mouse" });
      fireEvent.pointerMove(element, { pointerType: "mouse" });
      fireEvent.mouseOver(element);
      fireEvent.mouseMove(element);
      fireEvent.mouseOut(element);
      fireEvent.pointerOut(element, { pointerType: "mouse" });
    }
    expect(vi.getTimerCount()).toBe(timers);
    for (const schedule of schedules) {
      expect(schedule).not.toHaveBeenCalled();
      schedule.mockRestore();
    }
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(activeElement);
    expect(menu.outerHTML).toBe(markup);
    expect(accountTrigger().firstElementChild).toBe(avatar);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(accountMenuItem("Settings"));
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/settings");
    expect(signOutSafely).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    openAccount();
    expectIdentity(user);
    fireEvent.click(accountMenuItem("Sign out"));
    expect(signOutSafely).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledExactlyOnceWith("/settings");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([null, undefined, ""])("omits a %s login on initial render and after removal", async (login) => {
    const user: DashboardProps["user"] = { ...USER, login: null };
    // Exercise an omitted runtime field without widening the production user contract.
    Object.defineProperty(user, "login", { value: login });
    const view = render(dashboard(user));
    openAccount();
    expectIdentity(user);
    view.rerender(dashboard(identities[0]));
    expectIdentity(identities[0]);
    view.rerender(dashboard(user));
    expectIdentity(user);
    await closeAccount();
    openAccount();
    expectIdentity(user);
  });

  it("preserves whitespace-only login text instead of trimming or hiding it", () => {
    const user = { ...USER, login: "   " };
    render(dashboard(user));
    openAccount();
    expectIdentity(user);
  });

  it("updates the same metadata divs for name/login changes and replaces closed or open account data", async () => {
    const first = identities[0];
    const second = identities[1];
    const view = render(dashboard(first));
    openAccount();
    const original = expectIdentity(first);
    const renamed = { ...first, name: second.name };
    view.rerender(dashboard(renamed));
    const current = expectIdentity(renamed);
    expect(current.name).toBe(original.name);
    expect(current.login).toBe(original.login);
    expect([...current.menu.querySelectorAll("[title]")].map((element) => element.getAttribute("title")))
      .not.toContain(first.name);

    const relogged = { ...renamed, login: second.login };
    view.rerender(dashboard(relogged));
    expect(expectIdentity(relogged).login).toBe(original.login);
    view.rerender(dashboard({ ...relogged, name: "" }));
    expectIdentity({ ...relogged, name: "" });

    view.rerender(dashboard(second));
    expectIdentity(second);
    await closeAccount();
    view.rerender(dashboard(first));
    expect(screen.queryByRole("menu")).toBeNull();
    openAccount();
    expectIdentity(first);
    await closeAccount();
    view.rerender(dashboard({ ...second, login: null }));
    openAccount();
    expectIdentity({ ...second, login: null });
    expect(router.push).not.toHaveBeenCalled();
    expect(signOutSafely).not.toHaveBeenCalled();
  });
});

describe("dashboard Account menu directional publication", () => {

  it("accepts an exact non-null owner view when jsdom can construct one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />
          </StrictMode>,
        );
      });
      const trigger = accountTrigger(host);
      const ownerWindow = trigger.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("The Account trigger has no owner window");
      trigger.focus();
      const event = accountViewedKeyEvent(trigger, "ArrowUp", ownerWindow);
      if (event) {
        await dispatchAccountKey(trigger, event);
        expect(event.defaultPrevented).toBe(true);
        expect(accountMenuItem("Sign out")).toHaveFocus();
      } else {
        expect(event).toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects partial ref replay after the zero-ref Strict replay and permits a clean successor", async () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />
          </StrictMode>,
        );
      });
      let trigger = accountTrigger(host);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      const content = screen.getByRole("menu");
      const contentRef = captureReactRef(content);
      const staleHandler = captureReactHandler(trigger, "onKeyDown");
      preventDefault.mockClear();

      act(() => {
        contentRef(null);
        contentRef(content);
      });
      await act(async () => {});
      const staleNative = accountKeyEvent(trigger, "ArrowDown");
      staleHandler({
        _reactName: "onKeyDown",
        type: "keydown",
        nativeEvent: staleNative,
        currentTarget: trigger,
        target: trigger,
      });
      expect(staleNative.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(signOutSafely).not.toHaveBeenCalled();

      const settings = accountMenuItem("Settings");
      settings.focus();
      fireEvent.keyDown(settings, { key: "Escape", code: "Escape" });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("menu")).toBeNull();

      trigger = accountTrigger(host);
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const recovered = await dispatchAccountKey(trigger, "ArrowUp");
      expect(recovered.defaultPrevented).toBe(true);
      expect(accountMenuItem("Sign out")).toHaveFocus();
      expect(
        preventDefault.mock.contexts.filter(
          (receiver) => receiver === recovered,
        ),
      ).toHaveLength(1);
      expect(router.push).not.toHaveBeenCalled();
      expect(signOutSafely).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["ArrowDown", "Settings"],
    ["ArrowUp", "Sign out"],
  ] as const)(
    "opens with %s and focuses only %s through direct-root Strict Mode replay",
    async (key, destinationName) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const scrollIntoView = vi.spyOn(
        Element.prototype,
        "scrollIntoView",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard
                user={USER}
                documents={DOCUMENTS}
                githubAvailable
                githubConfigured
              />
            </StrictMode>,
          );
        });
        const trigger = accountTrigger(host);
        trigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = await dispatchAccountKey(trigger, key);
        const destination = accountMenuItem(destinationName);

        expect(event.defaultPrevented).toBe(true);
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(destination).toHaveFocus();
        expect(
          preventDefault.mock.contexts.filter((receiver) => receiver === event),
        ).toHaveLength(1);
        expect(
          preventDefault.mock.contexts.filter(
            (receiver) =>
              receiver instanceof Event &&
              receiver.type === "focusScope.autoFocusOnMount",
          ),
        ).toHaveLength(1);
        const destinationFocuses = focus.mock.calls.filter(
          (_, index) => focus.mock.contexts[index] === destination,
        );
        expect(destinationFocuses).toEqual([[{ preventScroll: true }]]);
        expect(router.push).not.toHaveBeenCalled();
        expect(signOutSafely).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(searchDocuments).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

});

function registerTrashKeyboardProvenanceTests() {

  it("releases keyboard authority on cleanup and lets a fresh Strict root recover", () => {
    const retired = renderTrashKeyboard(
      trash(),
      trackTrashNavigationEffects,
    );
    const restore = directTrashButton(
      retired.host,
      first.title,
      "restore-button",
    );
    restore.focus();
    const afterCleanup = createTrashKeyboardEvent(
      restore,
      "ArrowRight",
    );
    retired.setup.preventDefault.mockClear();
    retired.setup.focus.mockClear();
    retired.dispose();
    restore.dispatchEvent(afterCleanup);
    expect(afterCleanup.defaultPrevented).toBe(false);
    expect(retired.setup.preventDefault).not.toHaveBeenCalled();
    expect(retired.setup.focus).not.toHaveBeenCalled();

    const successor = renderTrashKeyboard(
      trash(),
      trackTrashNavigationEffects,
    );
    try {
      const currentRestore = directTrashButton(
        successor.host,
        first.title,
        "restore-button",
      );
      const currentPurge = directTrashButton(
        successor.host,
        first.title,
        "purge-button",
      );
      currentRestore.focus();
      successor.setup.preventDefault.mockClear();
      successor.setup.focus.mockClear();
      const accepted = dispatchTrashKey(
        currentRestore,
        "ArrowRight",
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(successor.setup.preventDefault).toHaveBeenCalledTimes(1);
      expect(successor.setup.focus).toHaveBeenCalledTimes(1);
      expect(currentPurge).toHaveFocus();
    } finally {
      successor.dispose();
    }
  });
}

function registerTrashKeyboardNativeAuthorityTests() {
  it("binds an accepted key to the event-local backing Window receiver, currentTarget, and path terminal", () => {
    const view = renderTrashKeyboard(
      trash(),
      (ownerWindow) => {
        const effects = trackTrashNavigationEffects(ownerWindow);
        const currentTargetDescriptor =
          Object.getOwnPropertyDescriptor(
            ownerWindow.Event.prototype,
            "currentTarget",
          );
        const composedPath =
          ownerWindow.Event.prototype.composedPath;
        if (typeof currentTargetDescriptor?.get !== "function") {
          throw new Error("Event.currentTarget has no getter");
        }
        const observations: {
          receiver: EventTarget;
          currentTarget: EventTarget | null;
          terminal: EventTarget | undefined;
        }[] = [];
        ownerWindow.addEventListener(
          "keydown",
          function (this: EventTarget, event: Event) {
            observations.push({
              receiver: this,
              currentTarget: Reflect.apply(
                currentTargetDescriptor.get!,
                event,
                [],
              ) as EventTarget | null,
              terminal: (
                Reflect.apply(
                  composedPath,
                  event,
                  [],
                ) as EventTarget[]
              ).at(-1),
            });
          },
          true,
        );
        const implementationSymbol =
          Object.getOwnPropertySymbols(ownerWindow.document).find(
            (symbol) => String(symbol) === "Symbol(impl)",
          );
        const backingReceiver = implementationSymbol
          ? (
              ownerWindow.document as unknown as Record<
                symbol,
                { _globalObject: EventTarget }
              >
            )[implementationSymbol]._globalObject
          : ownerWindow;
        return { ...effects, observations, backingReceiver };
      },
    );
    try {
      const restore = directTrashButton(
        view.host,
        first.title,
        "restore-button",
      );
      restore.focus();
      view.setup.preventDefault.mockClear();
      view.setup.focus.mockClear();

      const event = dispatchTrashKey(restore, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(view.setup.observations).toHaveLength(1);
      expect(view.setup.observations[0]).toEqual({
        receiver: view.setup.backingReceiver,
        currentTarget: view.setup.backingReceiver,
        terminal: view.setup.backingReceiver,
      });
      expect(view.setup.preventDefault).toHaveBeenCalledTimes(1);
      expect(view.setup.focus).toHaveBeenCalledTimes(1);
    } finally {
      view.dispose();
    }
  });

  it("preserves disabled, Enter, Space, Tab, and click behavior", () => {
    const onRetry = vi.fn();
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    const callbacks = { onRetry, onRestore, onPurge };
    const view = renderTrashKeyboard(
      trash([first], first.id, null, callbacks),
      trackTrashNavigationEffects,
    );
    try {
      const disabledRestore = directTrashButton(
        view.host,
        first.title,
        "restore-button",
      );
      const disabledPurge = directTrashButton(
        view.host,
        first.title,
        "purge-button",
      );
      expect(disabledRestore).toBeDisabled();
      expect(disabledPurge).toBeDisabled();
      const disabledEvent = dispatchTrashKey(
        disabledRestore,
        "ArrowRight",
      );
      expect(disabledEvent.defaultPrevented).toBe(false);
      expect(view.setup.preventDefault).not.toHaveBeenCalled();
      expect(view.setup.focus).not.toHaveBeenCalled();

      act(() => {
        view.root.render(
          trash([first], null, null, callbacks, "enabled"),
        );
      });
      const restore = directTrashButton(
        view.host,
        first.title,
        "restore-button",
      );
      const purge = directTrashButton(
        view.host,
        first.title,
        "purge-button",
      );
      expect(restore.tabIndex).toBe(0);
      expect(purge.tabIndex).toBe(0);
      restore.focus();
      view.setup.preventDefault.mockClear();
      view.setup.focus.mockClear();
      for (const key of ["Enter", " ", "Tab"]) {
        const event = dispatchTrashKey(restore, key);
        expect(event.defaultPrevented, key).toBe(false);
      }
      expect(view.setup.preventDefault).not.toHaveBeenCalled();
      expect(view.setup.focus).not.toHaveBeenCalled();
      expect(onRestore).not.toHaveBeenCalled();
      expect(onPurge).not.toHaveBeenCalled();

      restore.click();
      purge.click();
      expect(onRestore).toHaveBeenCalledExactlyOnceWith(first);
      expect(onPurge).toHaveBeenCalledExactlyOnceWith(first);
      expect(onRetry).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  });
}

describe("dashboard Account menu directional publication", () => {
  it("retains pointer, Enter, Space, activation, Escape, and outside dismissal", async () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    outside.textContent = "Outside Account menu";
    document.body.append(outside, host);
    const root = createRoot(host);

    const closeWithEscape = async () => {
      const item = accountMenuItem("Settings");
      item.focus();
      fireEvent.keyDown(item, { key: "Escape", code: "Escape" });
      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(accountTrigger(host)).toHaveFocus();
    };

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />
          </StrictMode>,
        );
      });
      let trigger = accountTrigger(host);
      trigger.focus();
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(screen.getByRole("menu")).toHaveFocus();
      await closeWithEscape();

      trigger = accountTrigger(host);
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(accountMenuItem("Settings")).toHaveFocus();
      await closeWithEscape();

      trigger = accountTrigger(host);
      trigger.focus();
      fireEvent.keyDown(trigger, { key: " ", code: "Space" });
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(accountMenuItem("Settings")).toHaveFocus();
      fireEvent.click(accountMenuItem("Settings"));
      expect(router.push).toHaveBeenCalledExactlyOnceWith("/settings");
      expect(screen.queryByRole("menu")).toBeNull();

      trigger = accountTrigger(host);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(accountMenuItem("Sign out"));
      expect(signOutSafely).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();

      trigger = accountTrigger(host);
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      await act(async () => {
        vi.advanceTimersByTime(0);
        await Promise.resolve();
      });
      fireEvent.pointerDown(outside, { button: 0, ctrlKey: false });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      outside.remove();
    }
  });

});

/** A click, then one turn of the page, so a handler that answers a moment later still counts. */
async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

describe("TemplateGrid", () => {
  function renderGrid(props: Partial<Parameters<typeof TemplateGrid>[0]> = {}) {
    const onPick = vi.fn<(template: Template) => void>();
    const view = render(<TemplateGrid onPick={onPick} busy={null} {...props} />);
    return { onPick, ...view };
  }

  function button(id: string) {
    return screen.getByTestId(`template-${id}`) as HTMLButtonElement;
  }

  it("shows every template once, in order, with its name and description", async () => {
    renderGrid();
    const cards = Array.from(screen.getByTestId("template-grid").children);
    expect(cards.map((card) => card.firstElementChild?.getAttribute("data-testid"))).toEqual(
      PICKER_TEMPLATES.map((template) => `template-${template.id}`),
    );
    for (const template of PICKER_TEMPLATES) {
      expect(within(button(template.id)).getByText(template.name)).toBeInTheDocument();
      expect(within(button(template.id)).getByText(template.description)).toBeInTheDocument();
    }
  });

  it.each(PICKER_TEMPLATES.map((template) => [template.id, template] as const))(
    "picks %s on a click, once",
    async (id, template) => {
      const { onPick } = renderGrid();
      await click(button(id));
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenLastCalledWith(template);
    },
  );

  it("picks the card under a click on its icon, name or description", async () => {
    const { onPick } = renderGrid();
    const second = PICKER_TEMPLATES[1];
    await click(within(button(second.id)).getByText(second.name));
    await click(within(button(second.id)).getByText(second.description));
    await click(button(second.id).querySelector("svg")!);
    expect(onPick.mock.calls).toEqual([[second], [second], [second]]);
  });

  it("makes each card a real button, so Enter and Space work without any key handler", async () => {
    renderGrid();
    for (const template of PICKER_TEMPLATES) {
      expect(button(template.id).tagName).toBe("BUTTON");
      expect(button(template.id).type).toBe("button");
      expect(button(template.id)).toBeEnabled();
    }
  });

  // Issue 2362. The dialog adds two "focus guard" spans to the page right after the grid
  // appears; browser extensions and translators change attributes and wrap text. None of
  // that may stop a click.
  it.each([
    [
      "a new element next to the dialog (the focus guard)",
      (host: HTMLElement) => {
        const guard = document.createElement("span");
        guard.setAttribute("data-radix-focus-guard", "");
        host.after(guard);
        host.before(guard.cloneNode());
      },
    ],
    [
      "a new attribute on the button",
      () => button(PICKER_TEMPLATES[1].id).setAttribute("data-extension", "1"),
    ],
    [
      "a new attribute on the list",
      () => screen.getByTestId("template-grid").setAttribute("data-extension", "1"),
    ],
    [
      "the name wrapped in another element (a translator)",
      () => {
        const name = screen.getByText(PICKER_TEMPLATES[1].name);
        const font = document.createElement("font");
        font.append(...name.childNodes);
        name.append(font);
      },
    ],
    [
      "the grid moved into a new wrapper",
      (host: HTMLElement) => {
        const wrapper = document.createElement("div");
        host.replaceWith(wrapper);
        wrapper.append(host);
      },
    ],
  ])("still picks after the page changes around it: %s", async (_name, change) => {
    const { onPick, container } = renderGrid();
    const second = PICKER_TEMPLATES[1];
    await act(async () => {
      change(container);
      await Promise.resolve();
    });
    await click(button(second.id));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenLastCalledWith(second);
  });

  it("picks once per click in Strict Mode, where React runs every effect twice", async () => {
    const onPick = vi.fn<(template: Template) => void>();
    render(
      <StrictMode>
        <TemplateGrid onPick={onPick} busy={null} />
      </StrictMode>,
    );
    await click(button(PICKER_TEMPLATES[0].id));
    await click(button(PICKER_TEMPLATES[2].id));
    expect(onPick.mock.calls).toEqual([[PICKER_TEMPLATES[0]], [PICKER_TEMPLATES[2]]]);
  });

  it("calls the newest onPick after the parent renders again", async () => {
    const stale = vi.fn<(template: Template) => void>();
    const current = vi.fn<(template: Template) => void>();
    const { rerender } = render(<TemplateGrid onPick={stale} busy={null} />);
    rerender(<TemplateGrid onPick={current} busy={null} />);
    await click(button(PICKER_TEMPLATES[0].id));
    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("while one template is being created: every card is disabled, only that one is busy and spins, and a click does nothing", async () => {
    const busy = PICKER_TEMPLATES[1];
    const { onPick } = renderGrid({ busy: busy.id });
    for (const template of PICKER_TEMPLATES) {
      expect(button(template.id)).toBeDisabled();
      const spinning = button(template.id).querySelector("svg.animate-spin") !== null;
      if (template.id === busy.id) {
        expect(button(template.id)).toHaveAttribute("aria-busy", "true");
        expect(spinning).toBe(true);
      } else {
        expect(button(template.id)).not.toHaveAttribute("aria-busy");
        expect(spinning).toBe(false);
      }
      await click(button(template.id));
    }
    expect(onPick).not.toHaveBeenCalled();
  });

  it("is usable again when the create is over", async () => {
    const { onPick, rerender } = renderGrid({ busy: PICKER_TEMPLATES[1].id });
    rerender(<TemplateGrid onPick={onPick} busy={null} />);
    expect(button(PICKER_TEMPLATES[1].id)).toBeEnabled();
    expect(button(PICKER_TEMPLATES[1].id).querySelector("svg.animate-spin")).toBeNull();
    await click(button(PICKER_TEMPLATES[1].id));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("uses the narrow column layout when compact and the wide one otherwise", async () => {
    const { rerender, onPick } = renderGrid({ compact: true });
    expect(screen.getByTestId("template-grid")).toHaveClass("grid", "gap-3", "grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-4");
    rerender(<TemplateGrid onPick={onPick} busy={null} />);
    expect(screen.getByTestId("template-grid")).toHaveClass("grid", "gap-3", "sm:grid-cols-2", "lg:grid-cols-3");
    expect(screen.getByTestId("template-grid")).not.toHaveClass("grid-cols-2");
  });
});

describe("dashboard New from template dialog (issue 2362)", () => {
  async function openDialog() {
    await click(screen.getByTestId("new-from-template"));
    return within(screen.getByRole("dialog"));
  }

  it("creates the picked template from the dialog and goes to the new document", async () => {
    const pending = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(pending.promise);
    renderDashboard();
    const dialog = await openDialog();

    await click(dialog.getByTestId("template-meeting-notes"));
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenLastCalledWith({ template: "meeting-notes" });
    expect(dialog.getByTestId("template-meeting-notes")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      pending.resolve({ document: { id: "from-template", title: "Meeting notes" } });
      await pending.promise;
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/from-template");
  });

  it("still creates when the page gains an element next to the dialog after it opened", async () => {
    createDocument.mockReturnValueOnce(new Promise(() => {}));
    renderDashboard();
    const dialog = await openDialog();
    await act(async () => {
      const guard = document.createElement("span");
      guard.setAttribute("data-radix-focus-guard", "");
      screen.getByRole("dialog").after(guard);
      await Promise.resolve();
    });

    await click(dialog.getByTestId("template-design-doc"));
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenLastCalledWith({ template: "design-doc" });
  });

  it("shows the narrow grid on the empty page and the wide grid in the dialog", async () => {
    renderDashboard(undefined, []);
    expect(within(screen.getByTestId("empty-state")).getByTestId("template-grid")).toHaveClass("grid-cols-2", "lg:grid-cols-4");
    const dialog = await openDialog();
    expect(dialog.getByTestId("template-grid")).toHaveClass("sm:grid-cols-2", "lg:grid-cols-3");
    expect(dialog.getByTestId("template-grid")).not.toHaveClass("grid-cols-2");
  });

  it("makes one document for a double click", async () => {
    createDocument.mockReturnValueOnce(new Promise(() => {}));
    renderDashboard();
    const dialog = await openDialog();
    const card = dialog.getByTestId("template-meeting-notes");
    await act(async () => {
      card.click();
      card.click();
      await Promise.resolve();
    });
    expect(createDocument).toHaveBeenCalledTimes(1);
  });
});

describe("dashboard search shortcut", () => {
  it("has an explicit name and compact hint, then focuses and selects the query once for /", async () => {
    renderDashboard(<button type="button">Outside search</button>);
    const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
    expect(screen.getByText("/", { selector: "kbd" })).toBeInTheDocument();
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    screen.getByRole("button", { name: "Outside search" }).focus();
    const focus = vi.spyOn(search, "focus");
    const select = vi.spyOn(search, "select");

    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Outside search" }), { key: "/" })).toBe(false);

    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(5);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not claim / from typing controls, editable content, dialogs, the palette, or modifier shortcuts", () => {
    renderDashboard(
      <div>
        <input aria-label="Other input" />
        <textarea aria-label="Other textarea" />
        <select aria-label="Other select"><option>One</option></select>
        <div contentEditable tabIndex={0}>Editable content</div>
        <dialog open><button type="button">Dialog control</button></dialog>
        <div data-testid="command-palette"><button type="button">Palette control</button></div>
        <button type="button">Outside search</button>
      </div>,
    );
    const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
    const contexts = [
      screen.getByRole("textbox", { name: "Other input" }),
      screen.getByRole("textbox", { name: "Other textarea" }),
      screen.getByRole("combobox", { name: "Other select" }),
      screen.getByText("Editable content"),
      screen.getByRole("button", { name: "Dialog control" }),
      screen.getByRole("button", { name: "Palette control" }),
    ];
    for (const target of contexts) {
      target.focus();
      expect(fireEvent.keyDown(target, { key: "/" })).toBe(true);
      expect(search).not.toHaveFocus();
      expect(target).toHaveFocus();
    }

    const outside = screen.getByRole("button", { name: "Outside search" });
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      outside.focus();
      expect(fireEvent.keyDown(outside, { key: "/", ...modifier })).toBe(true);
      expect(search).not.toHaveFocus();
    }
  });
});

describe("dashboard polish", () => {
  it("hides unconfigured GitHub storage and lets New document fill the row", () => {
    const view = render(
      <Dashboard user={USER} documents={DOCUMENTS} githubAvailable={false} githubConfigured={false} />,
    );

    expect(screen.queryByTestId("open-github")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-document").parentElement).toHaveClass("sm:col-span-2");

    view.rerender(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable={false} githubConfigured />);
    expect(screen.getByTestId("open-github")).toBeEnabled();
    expect(screen.getByTestId("new-document").parentElement).not.toHaveClass("sm:col-span-2");
  });

  it("wraps the filter controls instead of clipping them on narrow screens", () => {
    renderDashboard();

    expect(screen.getByTestId("dashboard-chips")).not.toHaveClass("overflow-x-auto");
    expect(screen.getByRole("toolbar", { name: "Document filters" })).toHaveClass("flex-wrap");
  });

  it("shows a shared-specific empty state when no documents have been shared", () => {
    render(<Dashboard user={USER} documents={[]} githubAvailable githubConfigured />);

    fireEvent.click(screen.getByTestId("filter-shared"));

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("Nothing has been shared with you yet");
    expect(emptyState).toHaveTextContent("Documents shared with you will appear here.");
    expect(emptyState).not.toHaveTextContent("No documents yet");
  });

  it("keeps shared and starred empty states scoped to the selected folder", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 1)] });
    const filed = { ...doc("filed", "Filed"), folderId: "f1" };
    const shared = {
      ...doc("shared", "Shared with me"),
      ownerId: "other",
      ownerName: "Someone else",
      ownerLogin: "other",
      role: "editor" as const,
    };
    const starred = { ...doc("starred", "Starred elsewhere"), starred: true };
    renderDashboard(undefined, [filed, shared, starred]);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("folder-chip"));
    fireEvent.click(screen.getByTestId("filter-shared"));

    let emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("Shared documents aren't filed in folders");
    expect(emptyState).toHaveTextContent("Choose All documents to see documents shared with you.");
    expect(emptyState).not.toHaveTextContent("Nothing has been shared with you yet");

    fireEvent.click(screen.getByTestId("filter-starred"));

    emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("No matching documents in this folder");
    expect(emptyState).toHaveTextContent("Choose All documents or another folder to see more.");
    expect(emptyState).not.toHaveTextContent("No starred documents");
  });

  it("uses the shared empty state when Not in a folder is selected", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 1)] });
    const filed = { ...doc("filed", "Filed"), folderId: "f1" };
    renderDashboard(undefined, [filed]);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("folder-unfiled"));
    fireEvent.click(screen.getByTestId("filter-shared"));

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("Nothing has been shared with you yet");
    expect(emptyState).toHaveTextContent("Documents shared with you will appear here.");
    expect(emptyState).not.toHaveTextContent("No matching unfiled documents");
  });

  it("does not claim there are no owned documents when the unfiled selection has none", async () => {
    listFolders.mockResolvedValue({ folders: [folder("f1", "Recipes", 1)] });
    const filed = { ...doc("filed", "Filed"), folderId: "f1" };
    renderDashboard(undefined, [filed]);

    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("folder-unfiled"));
    fireEvent.click(screen.getByTestId("filter-mine"));

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("No unfiled documents owned by you");
    expect(emptyState).toHaveTextContent("Choose All documents to see your filed documents.");
    expect(emptyState).not.toHaveTextContent("No documents owned by you yet");
  });

  it("uses device-neutral guidance for an empty Starred filter", () => {
    renderDashboard(undefined, [doc("unstarred", "Unstarred document")]);

    fireEvent.click(screen.getByTestId("filter-starred"));

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("No starred documents");
    expect(emptyState).toHaveTextContent("Star a document from its card or editor header to keep it here.");
    expect(emptyState).not.toHaveTextContent(/hover/i);
  });

  it("keeps the account avatar decorative inside its labeled button", () => {
    render(
      <Dashboard
        user={{ ...USER, image: "https://example.test/avatar.png" }}
        documents={DOCUMENTS}
        githubAvailable
        githubConfigured
      />,
    );

    const accountButton = screen.getByRole("button", { name: "Account" });
    expect(accountButton.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("does not mention GitHub in the guided empty state when storage is unconfigured", () => {
    render(<Dashboard user={USER} documents={[]} githubAvailable={false} githubConfigured={false} />);

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent("or open a Markdown file.");
    expect(emptyState).not.toHaveTextContent("GitHub");
  });
});

describe("dashboard search controls", () => {
  it("filters on a single change event with no prior typing and shows the no-match empty state", async () => {
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "notes" } });
    });
    expect(search).toHaveValue("notes");
    expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(1);
    expect(within(screen.getByTestId("document-list")).getByRole("link", { name: /Meeting notes/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Alpha planning/ })).toBeNull();

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "zzzz-no-match" } });
    });
    await settleSearch();
    expect(search).toHaveValue("zzzz-no-match");
    expect(screen.getByTestId("empty-state")).toHaveTextContent('No matches for "zzzz-no-match"');
    expect(screen.queryByTestId("document-list")).toBeNull();
    expect(screen.getByTestId("search-status")).toHaveTextContent('No results for "zzzz-no-match".');

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "" } });
    });
    expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(DOCUMENTS.length);
  });

  it("explains when a one-character query only matches titles", async () => {
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "a" } });
    });

    expect(searchDocuments).not.toHaveBeenCalled();
    expect(screen.getByTestId("search-content-hint")).toHaveTextContent("Content search starts at 2 characters.");
    expect(screen.getByTestId("search-status")).toHaveTextContent(
      '1 title match for "a". Content search starts at 2 characters.',
    );
    expect(within(screen.getByTestId("document-list")).getByRole("link", { name: /Alpha planning/ })).toBeInTheDocument();

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "z" } });
    });

    const emptyState = screen.getByTestId("empty-state");
    expect(emptyState).toHaveTextContent('No title matches for "z"');
    expect(emptyState).toHaveTextContent("Content search starts at 2 characters.");
    expect(screen.getByTestId("search-status")).toHaveTextContent(
      'No title matches for "z". Content search starts at 2 characters.',
    );
    expect(screen.queryByTestId("search-content-hint")).toBeNull();
    expect(searchDocuments).not.toHaveBeenCalled();
  });

  it("announces result changes without moving focus from the search field", async () => {
    searchDocuments.mockResolvedValueOnce({
      query: "alpha",
      documents: [result("alpha-title", "Alpha planning", "Plan for launch")],
    });
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    search.focus();

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await settleSearch();
    const status = screen.getByTestId("search-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent('1 result for "alpha".');
    expect(search).toHaveFocus();

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "no-match" } });
    });
    await settleSearch();
    expect(screen.getByTestId("search-status")).toHaveTextContent('No results for "no-match".');
    expect(search).toHaveFocus();
  });

  it("restores the query and matching results after returning to the dashboard", async () => {
    searchDocuments.mockImplementation(async (query) => ({
      query,
      documents: query === "notes" ? [result("notes", "Meeting notes", "Revisit mobile layout")] : [],
    }));
    const firstDashboard = renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "notes" } });
    });
    expect(window.sessionStorage.length).toBe(1);

    firstDashboard.unmount();
    renderDashboard();
    expect(screen.getByRole("textbox", { name: "Search documents" })).toHaveValue("notes");

    await settleSearch();
    expect(searchDocuments).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId("document-list")).getByRole("link", { name: /Meeting notes/ })).toBeInTheDocument();
  });

  it("clears and disables global search while Trash is selected", async () => {
    const pendingSearch = deferred<SearchResponse>();
    searchDocuments.mockReturnValueOnce(pendingSearch.promise);
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "revisit mobile" } });
    });
    await settleSearch();

    expect(searchDocuments).toHaveBeenCalledOnce();
    const signal = searchDocuments.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);

    await dispatchSearchAction(openTrash);
    await act(async () => {});

    const trashSearch = screen.getByRole("textbox", { name: "Search unavailable in Trash" });
    expect(trashSearch).toBeDisabled();
    expect(trashSearch).toHaveValue("");
    expect(trashSearch).toHaveAttribute("placeholder", "Search unavailable in Trash");
    expect(screen.queryByText("/", { selector: "kbd" })).toBeNull();
    expect(fireEvent.keyDown(document, { key: "/" })).toBe(true);
    expect(trashSearch).not.toHaveFocus();
    expect(window.sessionStorage.getItem("markdoc:dashboardSearch:owner")).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByTestId("search-content-hint")).toBeNull();

    await act(async () => {
      pendingSearch.resolve({
        query: "revisit mobile",
        documents: [result("stale-trash-search", "Stale search result", "Should not appear")],
      });
      await pendingSearch.promise;
      await Promise.resolve();
    });
    expect(screen.queryByText("Stale search result")).toBeNull();

    await dispatchSearchAction(leaveTrash);
    const activeSearch = screen.getByRole("textbox", { name: "Search documents" });
    expect(activeSearch).toBeEnabled();
    expect(activeSearch).toHaveValue("");
    expect(searchDocuments).toHaveBeenCalledOnce();
  });

  it("filters on typing and runs the two-step Escape in Strict Mode", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      search.focus();

      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "alpha" } });
      });
      expect(search).toHaveValue("alpha");
      expect(search).toHaveFocus();

      await dispatchSearchAction(() => {
        fireEvent.keyDown(search, { key: "Escape" });
      });
      expect(search).toHaveValue("");
      expect(search).toHaveFocus();

      await dispatchSearchAction(() => {
        fireEvent.keyDown(search, { key: "Escape" });
      });
      expect(search).toHaveValue("");
      expect(search).not.toHaveFocus();

      fireEvent.keyDown(document, { key: "/" });
      expect(search).toHaveFocus();
      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "fresh" } });
      });
      expect(search).toHaveValue("fresh");
      expect(searchDocuments).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("clears with the in-field Clear and returns focus to the input", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "alpha" } });
      });
      const clear = screen.getByTestId("search-clear");
      clear.focus();

      await dispatchSearchAction(() => {
        fireEvent.click(clear);
      });

      expect(search).toHaveValue("");
      expect(search).toHaveFocus();
      expect(screen.queryByTestId("search-clear")).toBeNull();
      expect(searchDocuments).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("clears with the no-results Clear and returns focus to the input", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "missing" } });
      });
      await settleSearch();
      await act(async () => {});
      const clear = screen.getByTestId("empty-state-clear-search");
      clear.focus();

      await dispatchSearchAction(() => {
        fireEvent.click(clear);
      });

      expect(search).toHaveValue("");
      expect(search).toHaveFocus();
      expect(screen.queryByTestId("empty-state-clear-search")).toBeNull();
      expect(searchDocuments).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("issues one current-query Retry request for a double click in Strict Mode", async () => {
    const retry = deferred<SearchResponse>();
    searchDocuments
      .mockRejectedValueOnce(new ApiError(503, "Search service unavailable"))
      .mockReturnValueOnce(retry.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const search = screen.getByRole("textbox", { name: "Search documents" });
      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "alpha" } });
      });
      await settleSearch();
      const retryButton = within(screen.getByRole("alert")).getByRole("button", { name: "Retry" });

      await dispatchSearchAction(() => {
        fireEvent.click(retryButton);
      });
      retryButton.click();

      expect(searchDocuments).toHaveBeenCalledTimes(2);
      expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
      expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

      await act(async () => {
        retry.resolve({ query: "alpha", documents: [] });
        await retry.promise;
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("dashboard search result keyboard focus", () => {
  it.each([
    ["ArrowDown", 0],
    ["ArrowUp", 1],
  ] as const)(
    "focuses the exact %s result once without navigation, scrolling, or search work",
    async (key, destination) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
            </StrictMode>,
          );
        });
        const search = screen.getByRole("textbox", {
          name: "Search documents",
        }) as HTMLInputElement;
        await dispatchSearchAction(() => {
          fireEvent.change(search, { target: { value: "n" } });
        });
        const links = searchResultLinks(host);
        expect(links).toHaveLength(2);
        search.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const scrollIntoView = Element.prototype
          .scrollIntoView as ReturnType<typeof vi.fn>;
        scrollIntoView.mockClear();
        const beforeScroll = { x: window.scrollX, y: window.scrollY };
        const requestCount = searchDocuments.mock.calls.length;

        const event = await dispatchSearchResultKey(search, key);

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(preventDefault.mock.instances[0]).toBe(event);
        expect(links[destination]).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(focus.mock.instances[0]).toBe(links[destination]);
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect({ x: window.scrollX, y: window.scrollY }).toEqual(beforeScroll);
        expect(search).toHaveValue("n");
        expect(searchDocuments).toHaveBeenCalledTimes(requestCount);
        expect(listDocuments).not.toHaveBeenCalled();
        expect(createDocument).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.refresh).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["empty", "loading", "error"] as const)(
    "leaves an %s-only search native",
    async (state) => {
      if (state === "error") {
        searchDocuments.mockRejectedValueOnce(
          new ApiError(503, "Search unavailable"),
        );
      }
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard
                user={USER}
                documents={state === "empty" ? DOCUMENTS : []}
                githubAvailable
                githubConfigured
              />
            </StrictMode>,
          );
        });
        const search = screen.getByRole("textbox", {
          name: "Search documents",
        }) as HTMLInputElement;
        await dispatchSearchAction(() => {
          fireEvent.change(search, {
            target: { value: state === "empty" ? "q" : "zz" },
          });
        });
        if (state === "error") await settleSearch();
        const requestCount = searchDocuments.mock.calls.length;
        expect(searchResultLinks(host)).toHaveLength(0);
        search.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const event = await dispatchSearchResultKey(search, "ArrowDown");

        expect(event.defaultPrevented).toBe(false);
        expect(search).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(searchDocuments).toHaveBeenCalledTimes(requestCount);
        expect(router.push).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("leaves modified, repeated, and composing arrows and keys from results native", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const search = screen.getByRole("textbox", {
        name: "Search documents",
      }) as HTMLInputElement;
      await dispatchSearchAction(() => {
        fireEvent.change(search, { target: { value: "n" } });
      });
      const links = searchResultLinks(host);
      const rejected: KeyboardEventInit[] = [
        { ctrlKey: true },
        { metaKey: true },
        { altKey: true },
        { shiftKey: true },
        { repeat: true },
        { isComposing: true },
      ];
      for (const init of rejected) {
        search.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = await dispatchSearchResultKey(search, "ArrowDown", init);
        expect(event.defaultPrevented).toBe(false);
        expect(search).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
      }

      links[0]!.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const wrongSource = await dispatchSearchResultKey(
        links[0]!,
        "ArrowDown",
      );
      expect(wrongSource.defaultPrevented).toBe(false);
      expect(links[0]).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("dashboard shortcut ownership", () => {
  it.each([
    ["Mod-K", { key: "k", ctrlKey: true }],
    ["Mod-Shift-P", { key: "p", ctrlKey: true, shiftKey: true }],
  ] as const)("keeps one exact current listener per class and opens once for %s", async (_name, init) => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />);
      });
      expect(listeners.active(false)).toHaveLength(1);
      expect(listeners.active(true)).toHaveLength(1);

      const search = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      if (init.key === "k") {
        const ignored = shortcutEvent(init);
        act(() => {
          search.dispatchEvent(ignored.event);
        });
        expect(ignored.preventDefault).not.toHaveBeenCalled();
        expect(ignored.stopPropagation).not.toHaveBeenCalled();
        expect(screen.queryByTestId("command-palette")).toBeNull();
      }

      const accepted = shortcutEvent(init);
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(accepted.event);
      });
      expect(accepted.preventDefault).toHaveBeenCalledOnce();
      expect(accepted.stopPropagation).toHaveBeenCalledOnce();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(listeners.active(false)).toHaveLength(1);
      expect(listeners.active(true)).toHaveLength(1);

      const repeat = shortcutEvent(init);
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(repeat.event);
      });
      expect(repeat.preventDefault).not.toHaveBeenCalled();
      expect(repeat.stopPropagation).not.toHaveBeenCalled();

      const focus = vi.spyOn(search, "focus");
      const select = vi.spyOn(search, "select");
      const slash = shortcutEvent({ key: "/" });
      act(() => {
        screen.getByTestId("new-document").dispatchEvent(slash.event);
      });
      expect(slash.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      expect(listeners.active(false)).toHaveLength(0);
      expect(listeners.active(true)).toHaveLength(0);
      host.remove();
    }
  });

  it.each([
    ["different user", { ...USER, id: "replacement-shortcut-owner", login: "replacement-shortcut-owner" }],
    ["equal user values", { ...USER }],
  ])("retires captured callbacks before a %s replacement boundary and leaves the new visit usable", async (_name, replacementUser) => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      const staleSearch = listeners.active(false)[0];
      const stalePalette = listeners.active(true)[0];
      const staleInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const staleFocus = vi.spyOn(staleInput, "focus");
      const staleSelect = vi.spyOn(staleInput, "select");
      const staleSlashAtBoundary = shortcutEvent({ key: "/" });
      const stalePaletteAtBoundary = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <DashboardBoundary
          user={replacementUser}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(listeners.removalCount(staleSearch, false)).toBe(1);
            expect(listeners.removalCount(stalePalette, true)).toBe(1);
            expect(listeners.active(false)).toHaveLength(1);
            expect(listeners.active(true)).toHaveLength(1);
            staleSearch(staleSlashAtBoundary.event);
            stalePalette(stalePaletteAtBoundary.event);
            expect(staleSlashAtBoundary.preventDefault).not.toHaveBeenCalled();
            expect(stalePaletteAtBoundary.preventDefault).not.toHaveBeenCalled();
            expect(stalePaletteAtBoundary.stopPropagation).not.toHaveBeenCalled();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});

      const currentSearch = listeners.active(false)[0];
      const currentPalette = listeners.active(true)[0];
      expect(currentSearch).not.toBe(staleSearch);
      expect(currentPalette).not.toBe(stalePalette);
      expect(staleFocus).not.toHaveBeenCalled();
      expect(staleSelect).not.toHaveBeenCalled();
      const currentInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const currentFocus = vi.spyOn(currentInput, "focus");
      const currentSelect = vi.spyOn(currentInput, "select");
      const currentSlash = shortcutEvent({ key: "/" });
      act(() => currentSearch(currentSlash.event));
      expect(currentSlash.preventDefault).toHaveBeenCalledOnce();
      expect(currentSlash.stopPropagation).not.toHaveBeenCalled();
      expect(currentFocus).toHaveBeenCalledOnce();
      expect(currentSelect).toHaveBeenCalledOnce();

      const currentPaletteEvent = shortcutEvent({ key: "k", ctrlKey: true });
      act(() => currentPalette(currentPaletteEvent.event));
      expect(currentPaletteEvent.preventDefault).toHaveBeenCalledOnce();
      expect(currentPaletteEvent.stopPropagation).toHaveBeenCalledOnce();
      expect(screen.getByTestId("command-palette")).toBeInTheDocument();

      const staleSlashAfterCurrent = shortcutEvent({ key: "/" });
      const stalePaletteAfterCurrent = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      act(() => {
        stalePalette(stalePaletteAfterCurrent.event);
        staleSearch(staleSlashAfterCurrent.event);
      });
      expect(staleSlashAfterCurrent.preventDefault).not.toHaveBeenCalled();
      expect(stalePaletteAfterCurrent.preventDefault).not.toHaveBeenCalled();
      expect(stalePaletteAfterCurrent.stopPropagation).not.toHaveBeenCalled();
      expect(staleFocus).toHaveBeenCalledOnce();
      expect(staleSelect).toHaveBeenCalledOnce();
      expect(currentFocus).toHaveBeenCalledOnce();
      expect(currentSelect).toHaveBeenCalledOnce();
      expect(listeners.active(false)).toEqual([currentSearch]);
      expect(listeners.active(true)).toEqual([currentPalette]);
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires both captured listeners before removal and keeps their callback orders inert", async () => {
    const listeners = trackWindowKeydownListeners();
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent shortcut focus";
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    let passiveCleanups = 0;

    try {
      await act(async () => {
        root.render(
          <DashboardBoundary
            onPassiveCleanup={() => {
              passiveCleanups++;
            }}
          />,
        );
      });
      const staleSearch = listeners.active(false)[0];
      const stalePalette = listeners.active(true)[0];
      const staleInput = screen.getByRole("textbox", { name: "Search documents" }) as HTMLInputElement;
      const staleFocus = vi.spyOn(staleInput, "focus");
      const staleSelect = vi.spyOn(staleInput, "select");
      const boundarySlash = shortcutEvent({ key: "/" });
      const boundaryPalette = shortcutEvent({ key: "k", ctrlKey: true });
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });

      root.render(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={() => {
            passiveCleanups++;
          }}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(listeners.active(false)).toHaveLength(0);
            expect(listeners.active(true)).toHaveLength(0);
            focusOwner.focus();
            staleSearch(boundarySlash.event);
            stalePalette(boundaryPalette.event);
            expect(boundarySlash.preventDefault).not.toHaveBeenCalled();
            expect(boundaryPalette.preventDefault).not.toHaveBeenCalled();
            expect(boundaryPalette.stopPropagation).not.toHaveBeenCalled();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      const removedMarkup = host.innerHTML;
      const removedSlash = shortcutEvent({ key: "/" });
      const removedPalette = shortcutEvent({ key: "p", ctrlKey: true, shiftKey: true });
      act(() => {
        stalePalette(removedPalette.event);
        staleSearch(removedSlash.event);
      });

      expect(host.innerHTML).toBe(removedMarkup);
      expect(focusOwner).toHaveFocus();
      expect(staleFocus).not.toHaveBeenCalled();
      expect(staleSelect).not.toHaveBeenCalled();
      expect(removedSlash.preventDefault).not.toHaveBeenCalled();
      expect(removedPalette.preventDefault).not.toHaveBeenCalled();
      expect(removedPalette.stopPropagation).not.toHaveBeenCalled();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});

describe.each(["search", "trash"] as const)("dashboard %s failure-message wrapping", (surface) => {
  it.each([
    { name: "300-character unbroken reason", reason: "x".repeat(300) },
    { name: "ordinary reason", reason: "Service temporarily unavailable" },
    { name: "literal HTML, quotes and whitespace", reason: ' \t<strong title="reason">"Unavailable" & \'retry\'</strong>\n  Try again.  ' },
    { name: "whitespace-only reason", reason: " \t\n  " },
  ])("keeps the $name exact beside a single usable Retry through replacement and recovery", async ({ reason }) => {
    const replacement = `Replacement-${"y".repeat(280)}`;
    const failedRetry = deferred<SearchResponse>();
    const recovery = deferred<SearchResponse>();
    const requests = surface === "search" ? searchDocuments : listDocuments;
    if (surface === "search") {
      searchDocuments
        .mockRejectedValueOnce(new ApiError(503, reason))
        .mockReturnValueOnce(failedRetry.promise)
        .mockReturnValueOnce(recovery.promise);
    } else {
      listDocuments
        .mockResolvedValueOnce({ documents: [trashedDoc("cached", "Cached trash row")] })
        .mockRejectedValueOnce(new ApiError(503, reason))
        .mockReturnValueOnce(failedRetry.promise)
        .mockReturnValueOnce(recovery.promise);
    }
    renderDashboard();
    if (surface === "search") {
      await dispatchSearchAction(() => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      });
      await settleSearch();
    } else {
      openTrash();
      await act(async () => {});
      leaveTrash();
      openTrash();
      await act(async () => {});
    }

    const alert = screen.getByTestId(`${surface}-error`);
    const message = alert.firstElementChild;
    const retry = within(alert).getByRole("button", { name: "Retry" });
    const initialHandler = captureReactHandler(retry, "onClick");
    const initialCount = surface === "search" ? 1 : 2;
    const note = surface === "trash" ? screen.getByTestId("trash-note").outerHTML : null;
    const expected = surface === "search"
      ? `Content search failed: ${reason}. Showing title matches only.`
      : reason;
    expect(requests).toHaveBeenCalledTimes(initialCount);
    expect(alert.className).toBe("mb-3 flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(message?.tagName).toBe("SPAN");
    expect(message?.className).toBe("min-w-0 flex-1 wrap-anywhere");
    expect(message?.getAttributeNames()).toEqual(["class"]);
    expect(message?.children).toHaveLength(0);
    expect(message?.textContent).toBe(expected);
    expect(alert.textContent).toBe(`${expected}Retry`);
    expect(Array.from(alert.children)).toEqual([message, retry]);
    expect(alert.querySelectorAll("button, a, input, select, textarea, [tabindex], [contenteditable]")).toHaveLength(1);
    expect(alert.querySelector("[title], [style]")).toBeNull();
    expect(alert.className).not.toMatch(/truncate|line-clamp|overflow-|break-all/);
    expect(retry.className).toBe(surface === "search" ? "btn btn-sm btn-outline shrink-0" : "btn btn-sm btn-outline shrink-0 gap-1.5");
    expect(retry).toHaveAttribute("type", "button");
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-busy");

    await dispatchSearchAction(() => {
      retry.click();
      retry.click();
    });
    expect(requests).toHaveBeenCalledTimes(initialCount + 1);
    if (surface === "search") {
      expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
      expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(1);
      expect(screen.getByRole("link", { name: /Alpha planning/ })).toBeInTheDocument();
    } else {
      expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
      expect(screen.getAllByTestId("trash-card")).toHaveLength(1);
      expect(screen.getByText("Cached trash row")).toBeInTheDocument();
      expect(screen.getByTestId("trash-note").outerHTML).toBe(note);
      expect(trashButton("Cached trash row", "restore-button")).toBeEnabled();
      expect(trashButton("Cached trash row", "purge-button")).toBeEnabled();
      expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");
      expect(alert.compareDocumentPosition(screen.getByTestId("trash-list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(alert.firstElementChild).toBe(message);
    expect(message?.textContent).toBe(expected);
    expect(alert.textContent).toBe(`${expected}Retrying…`);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(Array.from(alert.children)).toEqual([message, retry]);

    await act(async () => {
      failedRetry.reject(new ApiError(503, replacement));
      await Promise.allSettled([failedRetry.promise]);
    });
    const replacementText = surface === "search"
      ? `Content search failed: ${replacement}. Showing title matches only.`
      : replacement;
    expect(screen.getByTestId(`${surface}-error`)).toBe(alert);
    expect(alert.firstElementChild).toBe(message);
    expect(message?.textContent).toBe(replacementText);
    expect(message?.children).toHaveLength(0);
    expect(alert.textContent).toBe(`${replacementText}Retry`);
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-busy");
    const currentHandler = captureReactHandler(retry, "onClick");
    let replayEvent: unknown;
    const restore = interceptReactHandler(retry, "onClick", (original, event) => {
      replayEvent = event;
      // Only Trash keeps a stale-callback guard; search Retry is a plain click handler (#2226).
      if (surface === "trash") {
        const beforeStale = requests.mock.calls.length;
        initialHandler(event);
        expect(requests).toHaveBeenCalledTimes(beforeStale);
      }
      original(event);
    });
    try {
      await dispatchSearchAction(() => {
        retry.click();
        retry.click();
      });
    } finally {
      restore();
    }
    expect(requests).toHaveBeenCalledTimes(initialCount + 2);
    expect(message?.textContent).toBe(replacementText);
    expect(retry).toBeDisabled();
    await act(async () => {
      recovery.resolve({ query: "alpha", documents: [result("recovered", "Recovered document", "Recovered alpha content")] });
      await recovery.promise;
    });
    expect(screen.queryByTestId(`${surface}-error`)).toBeNull();
    expect(alert).not.toBeInTheDocument();
    expect(screen.getByText("Recovered document")).toBeInTheDocument();
    const markup = document.body.innerHTML;
    act(() => {
      if (surface === "trash") {
        initialHandler(replayEvent);
        currentHandler(replayEvent);
      }
      retry.click();
    });
    expect(requests).toHaveBeenCalledTimes(initialCount + 2);
    expect(document.body.innerHTML).toBe(markup);
    if (surface === "search") {
      expect(searchDocuments.mock.calls[2][0]).toBe("alpha");
      expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(1);
      expect(screen.getByTestId("search-snippet").textContent).toBe("Recovered alpha content");
      expect(listDocuments).not.toHaveBeenCalled();
    } else {
      expect(screen.getAllByTestId("trash-card")).toHaveLength(1);
      expect(screen.queryByText("Cached trash row")).toBeNull();
      expect(screen.getByTestId("trash-note").outerHTML).toBe(note);
      expect(screen.getByTestId("trash-view")).not.toHaveAttribute("aria-busy");
      expect(searchDocuments).not.toHaveBeenCalled();
    }
    expect(restoreDocument).not.toHaveBeenCalled();
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("preserves empty-reason formatting and omission", async () => {
    searchDocuments.mockRejectedValueOnce(new ApiError(503, ""));
    listDocuments.mockRejectedValueOnce(new ApiError(503, ""));
    renderDashboard();
    if (surface === "search") {
      await dispatchSearchAction(() => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      });
      await settleSearch();
      expect(screen.getByTestId("search-error").textContent).toBe("Content search failed: . Showing title matches only.Retry");
    } else {
      openTrash();
      await act(async () => {});
      expect(screen.queryByTestId("trash-error")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    }
  });
});

describe("dashboard failure-message wrapping lifetimes", () => {
  it("compiles the installed wrap-anywhere utility without break-all", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["wrap-anywhere", "min-w-0", "flex-1", "shrink-0"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.flex-1\s*\{\s*flex:\s*1;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).not.toMatch(/word-break:\s*break-all|overflow:\s*(auto|scroll|hidden)|text-overflow:\s*ellipsis/);
  });

  it.each([
    { boundary: "query", settlement: "success" },
    { boundary: "query", settlement: "failure" },
    { boundary: "user", settlement: "success" },
    { boundary: "user", settlement: "failure" },
  ])("retires long search errors across a $boundary change before stale $settlement", async ({ boundary, settlement }) => {
    const oldReason = "old-search-".repeat(30);
    const currentReason = "current-search-".repeat(20);
    const stale = deferred<SearchResponse>();
    const recovery = deferred<SearchResponse>();
    searchDocuments
      .mockRejectedValueOnce(new ApiError(503, oldReason))
      .mockReturnValueOnce(stale.promise)
      .mockRejectedValueOnce(new ApiError(503, currentReason))
      .mockReturnValueOnce(recovery.promise);
    const view = renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await settleSearch();
    const oldRetry = within(screen.getByTestId("search-error")).getByRole("button", { name: "Retry" });
    await dispatchSearchAction(() => oldRetry.click());
    expect(searchDocuments).toHaveBeenCalledTimes(2);
    const currentQuery = boundary === "query" ? "notes" : "alpha";
    if (boundary === "query") {
      await dispatchSearchAction(() => fireEvent.change(search, { target: { value: currentQuery } }));
    } else {
      view.rerender(<Dashboard user={{ ...USER, id: "replacement-owner", login: "replacement-owner" }} documents={DOCUMENTS} githubAvailable githubConfigured />);
    }
    expect(screen.queryByTestId("search-error")).toBeNull();
    expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await settleSearch();
    const alert = screen.getByTestId("search-error");
    const currentText = `Content search failed: ${currentReason}. Showing title matches only.`;
    expect(alert.firstElementChild?.textContent).toBe(currentText);
    await act(async () => {
      if (settlement === "success") {
        stale.resolve({ query: "alpha", documents: [result("obsolete", "Obsolete content", oldReason)] });
      } else {
        stale.reject(new ApiError(503, oldReason));
      }
      await Promise.allSettled([stale.promise]);
    });
    expect(alert.firstElementChild?.textContent).toBe(currentText);
    expect(screen.queryByText("Obsolete content")).toBeNull();
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(searchDocuments).toHaveBeenCalledTimes(3);
    await dispatchSearchAction(() => {
      retry.click();
      retry.click();
    });
    expect(searchDocuments).toHaveBeenCalledTimes(4);
    expect(searchDocuments.mock.calls[3][0]).toBe(currentQuery);
    expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(1);
    await act(async () => {
      recovery.resolve({ query: currentQuery, documents: [] });
      await recovery.promise;
    });
    expect(screen.queryByTestId("search-error")).toBeNull();
    expect(screen.getByText(`No matches for "${currentQuery}"`)).toBeInTheDocument();
  });

  it("retires the old search Retry on a filter change while keeping the current reason and filtered recovery", async () => {
    const reason = "filter-error-".repeat(25);
    const recovery = deferred<SearchResponse>();
    searchDocuments.mockRejectedValueOnce(new ApiError(503, reason)).mockReturnValueOnce(recovery.promise);
    renderDashboard();
    await dispatchSearchAction(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
    });
    await settleSearch();
    fireEvent.click(screen.getByTestId("filter-shared"));
    const alert = screen.getByTestId("search-error");
    expect(alert.firstElementChild?.textContent).toBe(`Content search failed: ${reason}. Showing title matches only.`);
    expect(screen.getByText('No title matches for "alpha"')).toBeInTheDocument();
    expect(screen.queryByTestId("document-list")).toBeNull();
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(searchDocuments).toHaveBeenCalledTimes(1);
    await dispatchSearchAction(() => {
      retry.click();
      retry.click();
    });
    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
    expect(screen.getByTestId("filter-shared")).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      recovery.resolve({
        query: "alpha",
        documents: [
          result("owned", "Owned result", "Owned alpha"),
          { ...result("shared", "Shared result", "Shared alpha"), ownerId: "other-owner", role: "viewer" },
        ],
      });
      await recovery.promise;
    });
    expect(screen.queryByTestId("search-error")).toBeNull();
    expect(screen.queryByText("Owned result")).toBeNull();
    expect(screen.getByText("Shared result")).toBeInTheDocument();
    expect(within(screen.getByTestId("document-list")).getAllByRole("link")).toHaveLength(1);
  });

  it.each(["success", "failure"] as const)("retires long Trash errors and Retry callbacks across visits before stale %s", async (settlement) => {
    const oldReason = "old-trash-".repeat(30);
    const currentReason = "current-trash-".repeat(20);
    const stale = deferred<ListResponse>();
    const recovery = deferred<ListResponse>();
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("cached", "Cached trash row")] })
      .mockRejectedValueOnce(new ApiError(503, oldReason))
      .mockReturnValueOnce(stale.promise)
      .mockRejectedValueOnce(new ApiError(503, currentReason))
      .mockReturnValueOnce(recovery.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});
    leaveTrash();
    openTrash();
    await act(async () => {});
    const oldAlert = screen.getByTestId("trash-error");
    const oldRetry = within(oldAlert).getByRole("button", { name: "Retry" });
    const staleHandler = captureReactHandler(oldRetry, "onClick");
    fireEvent.click(oldRetry);
    expect(listDocuments).toHaveBeenCalledTimes(3);
    leaveTrash();
    expect(screen.queryByTestId("trash-error")).toBeNull();
    openTrash();
    await act(async () => {});
    const alert = screen.getByTestId("trash-error");
    expect(alert).not.toBe(oldAlert);
    expect(alert.firstElementChild?.textContent).toBe(currentReason);
    await act(async () => {
      if (settlement === "success") {
        stale.resolve({ documents: [trashedDoc("obsolete", "Obsolete trash row")] });
      } else {
        stale.reject(new ApiError(503, oldReason));
      }
      await Promise.allSettled([stale.promise]);
    });
    expect(alert.firstElementChild?.textContent).toBe(currentReason);
    expect(screen.queryByText("Obsolete trash row")).toBeNull();
    const retry = within(alert).getByRole("button", { name: "Retry" });
    const restore = interceptReactHandler(retry, "onClick", (original, event) => {
      const beforeStale = listDocuments.mock.calls.length;
      staleHandler(event);
      expect(listDocuments).toHaveBeenCalledTimes(beforeStale);
      original(event);
    });
    try {
      await dispatchSearchAction(() => {
        retry.click();
        retry.click();
      });
    } finally {
      restore();
    }
    expect(listDocuments).toHaveBeenCalledTimes(5);
    expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();
    expect(screen.getAllByTestId("trash-card")).toHaveLength(1);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      recovery.resolve({ documents: [] });
      await recovery.promise;
    });
    expect(screen.queryByTestId("trash-error")).toBeNull();
    expect(screen.queryByTestId("trash-list")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(restoreDocument).not.toHaveBeenCalled();
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("dashboard content-search recovery", () => {
  it("keeps title matches, announces the server reason with Retry, and clears the obsolete error on a changed query", async () => {
    searchDocuments.mockRejectedValueOnce(new ApiError(503, "Search service unavailable"));
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await settleSearch();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Content search failed: Search service unavailable. Showing title matches only.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Alpha planning/ })).toBeInTheDocument();
    expect(screen.queryByText('No matches for "alpha"')).toBeNull();

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "notes" } });
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("issues one request for the exact current query and clears the alert only after a successful retry", async () => {
    const retry = deferred<SearchResponse>();
    searchDocuments
      .mockRejectedValueOnce(new ApiError(503, "Search service unavailable"))
      .mockReturnValueOnce(retry.promise);
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await settleSearch();
    const alert = screen.getByRole("alert");

    const retryButton = within(alert).getByRole("button", { name: "Retry" });
    await dispatchSearchAction(() => {
      retryButton.click();
      retryButton.click();
    });

    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ query: "alpha", documents: [result("content-match", "Roadmap", "Body contains alpha milestones")] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("link", { name: /Roadmap/ })).toBeInTheDocument();
    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Body contains alpha milestones");
  });

  it("aborts superseded requests and ignores their late results and errors", async () => {
    const requests = new Map<string, ReturnType<typeof deferred<SearchResponse>>>();
    searchDocuments.mockImplementation((query) => {
      const request = deferred<SearchResponse>();
      requests.set(query, request);
      return request.promise;
    });
    renderDashboard();
    const search = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "alpha" } });
    });
    await settleSearch();
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "beta" } });
    });
    expect(searchDocuments.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await settleSearch();
    await dispatchSearchAction(() => {
      fireEvent.change(search, { target: { value: "gamma" } });
    });
    expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await settleSearch();

    await act(async () => {
      requests.get("gamma")!.resolve({ query: "gamma", documents: [result("gamma", "Gamma result", "Current gamma content")] });
      await requests.get("gamma")!.promise;
    });
    await act(async () => {
      requests.get("alpha")!.resolve({ query: "alpha", documents: [result("stale", "Stale alpha result", "Old content")] });
      requests.get("beta")!.reject(new Error("Stale beta failure"));
      await Promise.allSettled([requests.get("alpha")!.promise, requests.get("beta")!.promise]);
    });

    expect(searchDocuments).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("link", { name: /Gamma result/ })).toBeInTheDocument();
    expect(screen.queryByText(/Stale alpha result/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old user search before its %s settles at the replacement layout boundary",
    async (settlement) => {
      const oldSearch = deferred<SearchResponse>();
      const currentSearch = deferred<SearchResponse>();
      const passiveCleanup = vi.fn();
      const replacementUser = { ...USER, id: "replacement-owner", name: "Replacement owner", login: "replacement-owner" };
      searchDocuments.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(currentSearch.promise);
      const view = render(<DashboardBoundary onPassiveCleanup={passiveCleanup} />);
      await dispatchSearchAction(() => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      });
      await settleSearch();
      const oldSignal = searchDocuments.mock.calls[0][1]?.signal;

      view.rerender(
        <DashboardBoundary
          user={replacementUser}
          documents={[]}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            expect(oldSignal?.aborted).toBe(true);
            if (settlement === "success") {
              oldSearch.resolve({ query: "alpha", documents: [result("old-result", "Old user result", "Old user content")] });
            } else {
              oldSearch.reject(new ApiError(503, "Old user search failed"));
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldSearch.promise]);
        await Promise.resolve();
      });

      expect(searchDocuments).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Old user result")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
      expect(screen.getByText('Searching for "alpha"…')).toBeInTheDocument();
      expect(console.error).not.toHaveBeenCalled();

      await settleSearch();
      expect(searchDocuments).toHaveBeenCalledTimes(2);
      expect(searchDocuments.mock.calls[1][0]).toBe("alpha");
      expect(searchDocuments.mock.calls[1][1]?.signal?.aborted).toBe(false);
      expect(screen.getByTestId("search-loading")).toBeInTheDocument();

      await act(async () => {
        currentSearch.resolve({ query: "alpha", documents: [result("current-result", "Current user result", "Current user content")] });
        await currentSearch.promise;
      });
      expect(screen.getByRole("link", { name: /Current user result/ })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
    },
  );

  it.each(["success", "failure"] as const)(
    "retires a search before its %s settles at the removal layout boundary",
    async (settlement) => {
      const oldSearch = deferred<SearchResponse>();
      const passiveCleanup = vi.fn();
      searchDocuments.mockReturnValueOnce(oldSearch.promise);
      const view = render(<DashboardBoundary onPassiveCleanup={passiveCleanup} />);
      await dispatchSearchAction(() => {
        fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
      });
      await settleSearch();
      const oldSignal = searchDocuments.mock.calls[0][1]?.signal;

      view.rerender(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={passiveCleanup}
          onBoundary={() => {
            expect(passiveCleanup).not.toHaveBeenCalled();
            expect(oldSignal?.aborted).toBe(true);
            if (settlement === "success") {
              oldSearch.resolve({ query: "alpha", documents: [result("removed-result", "Removed result", "Removed content")] });
            } else {
              oldSearch.reject(new ApiError(503, "Removed search failed"));
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldSearch.promise]);
        await Promise.resolve();
      });

      expect(searchDocuments).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("textbox", { name: "Search documents" })).toBeNull();
      expect(screen.queryByText("Removed result")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("search-loading")).toBeNull();
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("keeps the replacement request pending when the old request finalizes", async () => {
    const oldSearch = controlledSearch<SearchResponse>();
    const currentSearch = deferred<SearchResponse>();
    const replacementUser = { ...USER, id: "replacement-finalizer", name: "Replacement owner", login: "replacement-finalizer" };
    searchDocuments.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(currentSearch.promise);
    const view = render(<DashboardBoundary />);
    await dispatchSearchAction(() => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "alpha" } });
    });
    await settleSearch();

    view.rerender(
      <DashboardBoundary
        user={replacementUser}
        documents={[]}
        boundary={1}
        onBoundary={() => oldSearch.resolve({ query: "alpha", documents: [result("stale-finalizer", "Stale finalizer", "Old content")] })}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await settleSearch();

    expect(searchDocuments).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    act(() => {
      oldSearch.finalize();
    });
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    expect(screen.queryByText("Stale finalizer")).toBeNull();

    await act(async () => {
      currentSearch.resolve({ query: "alpha", documents: [result("finalizer-current", "Current finalizer result", "Current content")] });
      await currentSearch.promise;
    });
    expect(screen.queryByTestId("search-loading")).toBeNull();
    expect(screen.getByRole("link", { name: /Current finalizer result/ })).toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("dashboard notice ownership", () => {
  it("retires the exact old-user timer before the parent layout boundary and leaves a same-value replacement notice independent", async () => {
    const pending: PendingNotice = { message: "Account notice", kind: "success" };
    takePendingNotice.mockReturnValueOnce(pending).mockReturnValueOnce({ ...pending });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      expect(takePendingNotice).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      const oldDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const oldTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(oldTimerIndex).toBeGreaterThanOrEqual(0);
      const oldTimerCallback = setTimeoutSpy.mock.calls[oldTimerIndex][0];
      const oldTimer = setTimeoutSpy.mock.results[oldTimerIndex]?.value;
      expect(typeof oldTimerCallback).toBe("function");
      const timersBeforeRetirement = vi.getTimerCount();
      expect(timersBeforeRetirement).toBeGreaterThanOrEqual(1);

      const replacementUser = { ...USER, id: "replacement-notice-owner", login: "replacement-notice-owner" };
      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <DashboardBoundary
          user={replacementUser}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(vi.getTimerCount()).toBe(timersBeforeRetirement - 1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(oldTimer);
            expect(screen.queryByTestId("toast")).toBeNull();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});

      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", pending.kind);
      const currentDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const currentTimerIndexes = setTimeoutSpy.mock.calls
        .map(([, delay], index) => (delay === 5000 ? index : -1))
        .filter((index) => index >= 0);
      expect(currentTimerIndexes).toHaveLength(2);
      const currentTimer = setTimeoutSpy.mock.results[currentTimerIndexes[1]]?.value;
      expect(clearTimeoutSpy).not.toHaveBeenCalledWith(currentTimer);
      expect(vi.getTimerCount()).toBe(timersBeforeRetirement);

      const search = screen.getByRole("textbox", { name: "Search documents" });
      search.focus();
      const documentListBefore = screen.getByTestId("document-list").textContent;
      const timersBeforeStaleCallbacks = vi.getTimerCount();
      act(() => {
        if (typeof oldTimerCallback === "function") oldTimerCallback();
        oldDismiss();
      });
      expect(screen.getByTestId("toast")).toHaveTextContent(pending.message);
      expect(screen.getByTestId("document-list")).toHaveTextContent(documentListBefore ?? "");
      expect(search).toHaveFocus();
      expect(vi.getTimerCount()).toBe(timersBeforeStaleCallbacks);
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();

      await act(async () => {
        root.render(<DashboardBoundary user={replacementUser} boundary={2} onPassiveCleanup={onPassiveCleanup} />);
      });
      expect(takePendingNotice).toHaveBeenCalledTimes(2);
      act(() => currentDismiss());
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(clearTimeoutSpy.mock.calls.filter(([timer]) => timer === currentTimer)).toHaveLength(1);
      act(() => currentDismiss());
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(clearTimeoutSpy.mock.calls.filter(([timer]) => timer === currentTimer)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires a removed visit before the parent layout boundary and keeps captured callbacks inert", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Removed notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    let passiveCleanups = 0;
    const onPassiveCleanup = () => {
      passiveCleanups++;
    };

    try {
      await act(async () => {
        root.render(<DashboardBoundary onPassiveCleanup={onPassiveCleanup} />);
      });
      const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
      const timerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      const staleTimerCallback = setTimeoutSpy.mock.calls[timerIndex][0];
      const staleTimer = setTimeoutSpy.mock.results[timerIndex]?.value;
      const timersBeforeRetirement = vi.getTimerCount();

      let boundaryReached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        boundaryReached = resolve;
      });
      root.render(
        <DashboardBoundary
          present={false}
          boundary={1}
          onPassiveCleanup={onPassiveCleanup}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(vi.getTimerCount()).toBe(timersBeforeRetirement - 1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(staleTimer);
            focusOwner.focus();
            boundaryReached();
          }}
        />,
      );
      await atBoundary;
      await act(async () => {});
      const removedMarkup = host.innerHTML;

      act(() => {
        staleDismiss();
        if (typeof staleTimerCallback === "function") staleTimerCallback();
      });
      expect(host.innerHTML).toBe(removedMarkup);
      expect(screen.queryByTestId("toast")).toBeNull();
      expect(focusOwner).toHaveFocus();
      expect(takePendingNotice).toHaveBeenCalledTimes(1);
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
      expect(createDocument).not.toHaveBeenCalled();
      expect(starDocument).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it("keeps the pending notice through 4,999 ms and clears that exact publication once at 5,000 ms", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Timed notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderDashboard();

    expect(takePendingNotice).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);
    expect(screen.getByTestId("toast")).toHaveTextContent("Timed notice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Timed notice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(searchDocuments).not.toHaveBeenCalled();
  });

  it("does not let a pending timer or Dismiss clear a newer Restore success", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Moved to trash.", kind: "success" });
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("restore-notice", "Restore notice")] });
    renderDashboard();
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));

    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Restore notice", "restore-button"));
    await act(async () => {});

    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore notice” was restored.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    act(() => staleDismiss());
    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore notice” was restored.");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("uses identity when a Create error replaces an equal pending notice and keeps the action error persistent", async () => {
    const sameNotice: PendingNotice = { message: "Same publication", kind: "error" };
    const failed = deferred<CreateResponse>();
    takePendingNotice.mockReturnValueOnce(sameNotice);
    createDocument.mockReturnValueOnce(failed.promise);
    renderDashboard(undefined, []);
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));

    fireEvent.click(screen.getByTestId("new-document"));
    await act(async () => {
      failed.reject(new ApiError(503, sameNotice.message));
      await Promise.allSettled([failed.promise]);
    });
    const currentDismiss = captureClick(screen.getByTestId("toast").querySelector('button[aria-label="Dismiss"]')!);
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);

    act(() => staleDismiss());
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByTestId("toast")).toHaveTextContent(sameNotice.message);
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", sameNotice.kind);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();

    act(() => currentDismiss());
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("keeps stale pending callbacks inert when the current Import error is dismissed first", async () => {
    takePendingNotice.mockReturnValueOnce({ message: "Previous page notice", kind: "info" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    renderDashboard();
    const staleDismiss = captureClick(screen.getByRole("button", { name: "Dismiss" }));
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 5000);
    const staleTimerCallback = setTimeoutSpy.mock.calls[timerIndex][0];

    const input = screen.getByTestId("import-file-input");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "only-image.png", { type: "image/png" })] },
    });
    expect(screen.getByTestId("toast")).toHaveTextContent("Drop a Markdown, text or HTML file together with the images.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");

    const currentDismiss = captureClick(screen.getByTestId("toast").querySelector('button[aria-label="Dismiss"]')!);
    act(() => currentDismiss());
    expect(screen.queryByTestId("toast")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(screen.queryByTestId("import-dialog")).toBeNull();
    act(() => {
      staleDismiss();
      if (typeof staleTimerCallback === "function") staleTimerCallback();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe("dashboard create ownership", () => {
  it("gives immediate blank, welcome, template, and palette activations one request and one navigation", async () => {
    const pending = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, []);
    const blank = screen.getByTestId("new-document");
    const welcome = screen.getByTestId("start-guided-doc");
    const template = screen.getByTestId("template-meeting-notes");

    act(() => {
      blank.click();
      welcome.click();
      template.click();
    });

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenLastCalledWith({});
    expect(blank).toBeDisabled();
    expect(welcome).toBeDisabled();
    expect(template).toBeDisabled();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByTestId("palette-item-dash:new"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ document: { id: "one-created", title: "Untitled" } });
      await pending.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/one-created");
    // A success stays busy until the document page replaces the dashboard.
    expect(blank).toBeDisabled();
    expect(welcome).toBeDisabled();
    expect(template).toBeDisabled();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByTestId("palette-item-dash:new"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("shows the current failure, restores every control, and retries to one navigation", async () => {
    const failed = deferred<CreateResponse>();
    const retry = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    renderDashboard(undefined, []);

    fireEvent.click(screen.getByTestId("start-guided-doc"));
    expect(createDocument).toHaveBeenLastCalledWith({ template: "welcome" });
    await act(async () => {
      failed.reject(new ApiError(503, "Create service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Create service unavailable");
    expect(screen.getByTestId("new-document")).toBeEnabled();
    expect(screen.getByTestId("start-guided-doc")).toBeEnabled();
    expect(screen.getByTestId("template-meeting-notes")).toBeEnabled();

    const retryButton = screen.getByTestId("template-meeting-notes");
    await act(async () => {
      retryButton.click();
      screen.getByTestId("new-document").click();
    });
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenLastCalledWith({ template: "meeting-notes" });

    await act(async () => {
      retry.resolve({ document: { id: "retry-created", title: "Meeting notes" } });
      await retry.promise;
    });

    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/retry-created");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("lets a replacement dashboard create while the old success and finalizer stay inert", async () => {
    const stale = deferred<CreateResponse>();
    const current = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const view = render(<Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));

    const replacementUser = { ...USER, id: "replacement-owner", login: "replacement-owner" };
    view.rerender(<Dashboard user={replacementUser} documents={DOCUMENTS} githubAvailable githubConfigured />);
    fireEvent.click(screen.getByTestId("new-document"));
    expect(createDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      stale.resolve({ document: { id: "stale-created", title: "Stale" } });
      await stale.promise;
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-document")).toBeDisabled();

    await act(async () => {
      current.resolve({ document: { id: "current-created", title: "Current" } });
      await current.promise;
    });
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenLastCalledWith("/d/current-created");
  });
});

describe("dashboard direct create control ownership", () => {
  const DIRECT_CONTROLS = [
    {
      name: "New document",
      testid: "new-document" as CreateControlTestId,
      body: {} as Record<string, string>,
      created: "blank-created",
    },
    {
      name: "Start with a guided doc",
      testid: "start-guided-doc" as CreateControlTestId,
      body: { template: "welcome" } as Record<string, string>,
      created: "welcome-created",
    },
  ];

  it.each(DIRECT_CONTROLS)(
    "issues one exact $name create and navigation through direct-root Strict Mode replay",
    async ({ testid, body, created }) => {
      const pending = deferred<CreateResponse>();
      createDocument.mockReturnValueOnce(pending.promise);
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner, host);
      const root = createRoot(host);
      const passiveCleanup = vi.fn();
      let layoutSetups = 0;

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <DashboardBoundary
                documents={[]}
                boundary={1}
                onPassiveCleanup={passiveCleanup}
                onBoundary={() => {
                  layoutSetups += 1;
                }}
              />
            </StrictMode>,
          );
        });

        const control = directCreateButton(host, testid);
        expect(layoutSetups).toBeGreaterThanOrEqual(2);
        expect(passiveCleanup).toHaveBeenCalled();
        expect(control).toBeEnabled();
        expect(control).not.toHaveAttribute("aria-busy");

        focusOwner.focus();
        await act(async () => {
          control.click();
        });
        expect(createDocument).toHaveBeenCalledTimes(1);
        expect(createDocument).toHaveBeenLastCalledWith(body);
        expect(directCreateButton(host, "new-document")).toBeDisabled();
        expect(directCreateButton(host, "start-guided-doc")).toBeDisabled();
        expect(templateButton(host, "meeting-notes")).toBeDisabled();
        expect(document.activeElement).toBe(focusOwner);

        await act(async () => {
          control.click();
          directCreateButton(host, "new-document").click();
        });
        expect(createDocument).toHaveBeenCalledTimes(1);

        await act(async () => {
          pending.resolve({ document: { id: created, title: "Untitled" } });
          await pending.promise;
        });
        expect(router.push).toHaveBeenCalledTimes(1);
        expect(router.push).toHaveBeenLastCalledWith(`/d/${created}`);
        expect(host.querySelector('[data-testid="toast"]')).toBeNull();
      } finally {
        await act(async () => root.unmount());
        focusOwner.remove();
        host.remove();
      }
    },
  );

  it.each(DIRECT_CONTROLS)(
    "accepts a $name click with a production-mangled React event constructor",
    async ({ testid, body, created }) => {
      const pending = deferred<CreateResponse>();
      createDocument.mockReturnValueOnce(pending.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
            </StrictMode>,
          );
        });
        const control = directCreateButton(host, testid);
        const restore = interceptMangledReactClick(control);
        try {
          await act(async () => {
            control.click();
          });
        } finally {
          restore();
        }
        expect(createDocument).toHaveBeenCalledTimes(1);
        expect(createDocument).toHaveBeenLastCalledWith(body);

        await act(async () => {
          pending.resolve({ document: { id: created, title: "Untitled" } });
          await pending.promise;
        });
        expect(router.push).toHaveBeenCalledTimes(1);
        expect(router.push).toHaveBeenLastCalledWith(`/d/${created}`);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(DIRECT_CONTROLS)(
    "keeps every create control busy after a successful $name create, so a late second click creates nothing",
    async ({ testid, body, created }) => {
      const pending = deferred<CreateResponse>();
      createDocument.mockReturnValueOnce(pending.promise);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
            </StrictMode>,
          );
        });
        await act(async () => {
          directCreateButton(host, testid).click();
        });
        await act(async () => {
          pending.resolve({ document: { id: created, title: "Untitled" } });
          await pending.promise;
        });
        expect(router.push).toHaveBeenCalledTimes(1);
        expect(router.push).toHaveBeenLastCalledWith(`/d/${created}`);

        const control = directCreateButton(host, testid);
        expect(control).toBeDisabled();
        expect(control.querySelector("svg")).toHaveClass("lucide-loader-circle", "animate-spin");
        expect(directCreateButton(host, "new-document")).toBeDisabled();
        expect(directCreateButton(host, "start-guided-doc")).toBeDisabled();
        expect(templateButton(host, "meeting-notes")).toBeDisabled();

        // The handler itself refuses too, not only the disabled attribute.
        await act(async () => {
          for (const button of [directCreateButton(host, "new-document"), directCreateButton(host, "start-guided-doc")]) {
            captureReactClick(button)(fabricatedTemplateClick(button));
          }
        });
        expect(createDocument).toHaveBeenCalledTimes(1);
        expect(createDocument).toHaveBeenLastCalledWith(body);
        expect(router.push).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("keeps stale user and key handlers inert while the current control stays exact", async () => {
    const stale = deferred<CreateResponse>();
    const current = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const replacement = { ...USER, id: "create-replacement", login: "create-replacement" };

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const staleBlank = directCreateButton(host, "new-document");
      const staleHandler = captureReactClick(staleBlank);
      await act(async () => {
        staleBlank.click();
      });
      expect(createDocument).toHaveBeenCalledTimes(1);
      expect(createDocument).toHaveBeenLastCalledWith({});

      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={replacement} documents={[]} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const currentBlank = directCreateButton(host, "new-document");
      expect(currentBlank).toBe(staleBlank);
      expect(currentBlank).toBeEnabled();
      expectInertTemplateCall(
        staleHandler,
        fabricatedTemplateClick(currentBlank),
        host,
      );
      expect(createDocument).toHaveBeenCalledTimes(1);

      await act(async () => {
        directCreateButton(host, "start-guided-doc").click();
      });
      expect(createDocument).toHaveBeenCalledTimes(2);
      expect(createDocument).toHaveBeenLastCalledWith({ template: "welcome" });

      await act(async () => {
        stale.resolve({ document: { id: "stale-created", title: "Stale" } });
        await stale.promise;
      });
      expect(router.push).not.toHaveBeenCalled();

      await act(async () => {
        current.resolve({ document: { id: "current-created", title: "Current" } });
        await current.promise;
      });
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenLastCalledWith("/d/current-created");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects both controls while one create is busy and restores them on failure", async () => {
    const failing = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(failing.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      await act(async () => {
        directCreateButton(host, "start-guided-doc").click();
      });
      expect(createDocument).toHaveBeenCalledTimes(1);
      const busyWelcome = directCreateButton(host, "start-guided-doc");
      expect(busyWelcome).toHaveAttribute("aria-busy", "true");
      expect(busyWelcome).toBeDisabled();
      expect(directCreateButton(host, "new-document")).toBeDisabled();

      await act(async () => {
        fireEvent.click(busyWelcome);
        fireEvent.click(directCreateButton(host, "new-document"));
      });
      expect(createDocument).toHaveBeenCalledTimes(1);
      expect(router.push).not.toHaveBeenCalled();

      await act(async () => {
        failing.reject(new ApiError(503, "Create service unavailable"));
        await Promise.allSettled([failing.promise]);
      });
      const toast = host.querySelector('[data-testid="toast"]');
      expect(toast).toHaveAttribute("data-kind", "error");
      expect(toast).toHaveTextContent("Create service unavailable");
      expect(directCreateButton(host, "new-document")).toBeEnabled();
      expect(directCreateButton(host, "start-guided-doc")).toBeEnabled();
      expect(directCreateButton(host, "start-guided-doc")).not.toHaveAttribute("aria-busy");

      await act(async () => {
        directCreateButton(host, "new-document").click();
      });
      expect(createDocument).toHaveBeenCalledTimes(2);
      expect(createDocument).toHaveBeenLastCalledWith({});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenLastCalledWith("/d/created");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("preserves the create card, empty state, and templates around a genuine guided create", async () => {
    const pending = deferred<CreateResponse>();
    createDocument.mockReturnValueOnce(pending.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard user={USER} documents={[]} githubAvailable githubConfigured />
          </StrictMode>,
        );
      });
      const card = createCardRoot(host);
      expect(Array.from(card.children, (child) => child.getAttribute("data-testid"))).toEqual([
        "new-document",
        "new-from-template",
        "open-file",
      ]);
      const blank = directCreateButton(host, "new-document");
      expect(blank).toHaveTextContent("New document");
      expect(blank).toHaveTextContent("Start with a blank Markdown page.");
      expect(blank.querySelector("svg")).toHaveClass("lucide-file-plus-corner");
      expect(host.querySelector('[data-testid="new-from-template"]')).toHaveTextContent("From template");
      expect(host.querySelector('[data-testid="open-file"]')).toHaveTextContent("Open file");

      const guided = guidedRootElement(host);
      expect(guided).toHaveTextContent("No documents yet");
      expect(guided).toHaveTextContent(
        "Start with a short guided document, pick a template, or open a Markdown file.",
      );
      const welcome = directCreateButton(host, "start-guided-doc");
      expect(welcome).toHaveTextContent("Start with a guided doc");
      expect(welcome.querySelector("svg")).toHaveClass("lucide-sparkles");
      expect(Array.from(templateGrid(host).children, (li) => li.firstElementChild?.getAttribute("data-testid"))).toEqual(
        PICKER_TEMPLATES.map((template) => `template-${template.id}`),
      );

      await act(async () => {
        welcome.click();
      });
      expect(createDocument).toHaveBeenCalledTimes(1);
      expect(createDocument).toHaveBeenLastCalledWith({ template: "welcome" });
      expect(
        directCreateButton(host, "start-guided-doc").querySelector("svg"),
      ).toHaveClass("lucide-loader-circle", "animate-spin");
      await act(async () => {
        pending.resolve({ document: { id: "guided-created", title: "Welcome" } });
        await pending.promise;
      });
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenLastCalledWith("/d/guided-created");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("dashboard star recovery", () => {
  it("optimistically stars and unstars, disables the document while pending, and commits each response", async () => {
    const starring = deferred<{ starred: true }>();
    const unstarring = deferred<{ starred: false }>();
    starDocument.mockReturnValueOnce(starring.promise);
    unstarDocument.mockReturnValueOnce(unstarring.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument).toHaveBeenCalledOnce();
    expect(starDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeEnabled();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeEnabled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("alpha-title");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      unstarring.resolve({ starred: false });
      await unstarring.promise;
    });
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("suppresses synchronous duplicate activation across duplicate controls for one document", async () => {
    const pending = deferred<{ starred: false }>();
    unstarDocument.mockReturnValueOnce(pending.promise);
    renderDashboard(undefined, [{ ...doc("starred", "Starred document"), starred: true }]);
    const stripButton = within(screen.getByTestId("starred-strip")).getByRole("button", { name: "Unstar" });
    const listButton = documentStar("Starred document");

    act(() => {
      stripButton.click();
      listButton.click();
    });

    expect(unstarDocument).toHaveBeenCalledOnce();
    expect(unstarDocument).toHaveBeenCalledWith("starred");
    expect(starDocument).not.toHaveBeenCalled();
    expect(documentStar("Starred document")).toBeDisabled();

    await act(async () => {
      pending.resolve({ starred: false });
      await pending.promise;
    });
  });

  it("allows independent documents to mutate concurrently while keeping each document single-flight", async () => {
    const alpha = deferred<{ starred: true }>();
    const notes = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(notes.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["notes"]]);
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      alpha.resolve({ starred: true });
      await alpha.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(documentStar("Meeting notes")).toBeDisabled();

    await act(async () => {
      notes.resolve({ starred: true });
      await notes.promise;
    });
    expect(documentStar("Meeting notes")).toBeEnabled();
  });

  it("rolls a failed toggle back with the API reason and retries the same action once", async () => {
    const first = deferred<{ starred: true }>();
    const retry = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      first.reject(new ApiError(503, "Star service unavailable"));
      await Promise.allSettled([first.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Alpha planning")).toBeEnabled();
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "error");
    expect(screen.getByTestId("toast")).toHaveTextContent("Star service unavailable");
    expect(console.error).not.toHaveBeenCalled();

    fireEvent.click(documentStar("Alpha planning"));

    expect(starDocument.mock.calls).toEqual([["alpha-title"], ["alpha-title"]]);
    expect(unstarDocument).not.toHaveBeenCalled();
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();

    await act(async () => {
      retry.resolve({ starred: true });
      await retry.promise;
    });
  });

  it("shares optimistic and pending state when a local match is replaced by the server result", async () => {
    const search = deferred<SearchResponse>();
    const starring = deferred<{ starred: true }>();
    searchDocuments.mockReturnValueOnce(search.promise);
    starDocument.mockReturnValueOnce(starring.promise);
    renderDashboard();
    const input = screen.getByRole("textbox", { name: "Search documents" });

    await dispatchSearchAction(() => {
      fireEvent.change(input, { target: { value: "alpha" } });
    });
    fireEvent.click(documentStar("Alpha planning"));
    await settleSearch();

    await act(async () => {
      search.resolve({ query: "alpha", documents: [result("alpha-title", "Alpha planning", "Server alpha result")] });
      await search.promise;
    });

    expect(screen.getByTestId("search-snippet")).toHaveTextContent("Server alpha result");
    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    fireEvent.click(documentStar("Alpha planning"));
    expect(starDocument).toHaveBeenCalledOnce();

    await act(async () => {
      starring.resolve({ starred: true });
      await starring.promise;
    });
    expect(documentStar("Alpha planning")).toBeEnabled();
  });

  it("isolates stale successes, errors, and finalizers after prop refresh removes and restores cards", async () => {
    const staleSuccess = deferred<{ starred: true }>();
    const staleError = deferred<{ starred: true }>();
    const currentAlpha = deferred<{ starred: true }>();
    const currentNotes = deferred<{ starred: true }>();
    starDocument
      .mockReturnValueOnce(staleSuccess.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(currentAlpha.promise)
      .mockReturnValueOnce(currentNotes.promise);
    const view = renderDashboard();

    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));
    view.rerender(<Dashboard user={USER} documents={[doc("alpha-title", "Alpha planning")]} githubAvailable githubConfigured />);
    expect(screen.queryByRole("link", { name: /Meeting notes/ })).toBeNull();
    view.rerender(<Dashboard user={USER} documents={DOCUMENTS.map((item) => ({ ...item }))} githubAvailable githubConfigured />);

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "false");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(documentStar("Alpha planning"));
    fireEvent.click(documentStar("Meeting notes"));

    await act(async () => {
      staleSuccess.resolve({ starred: true });
      staleError.reject(new ApiError(503, "Obsolete star failure"));
      await Promise.allSettled([staleSuccess.promise, staleError.promise]);
    });

    expect(documentStar("Alpha planning")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Meeting notes")).toHaveAttribute("aria-pressed", "true");
    expect(documentStar("Alpha planning")).toBeDisabled();
    expect(documentStar("Meeting notes")).toBeDisabled();
    expect(screen.queryByText("Obsolete star failure")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();

    await act(async () => {
      currentAlpha.resolve({ starred: true });
      currentNotes.resolve({ starred: true });
      await Promise.all([currentAlpha.promise, currentNotes.promise]);
    });
  });

  it("ignores a pending mutation after unmount", async () => {
    const pending = deferred<{ starred: true }>();
    starDocument.mockReturnValueOnce(pending.promise);
    const view = renderDashboard();
    fireEvent.click(documentStar("Alpha planning"));

    view.unmount();
    await act(async () => {
      pending.reject(new ApiError(503, "Unmounted star failure"));
      await Promise.allSettled([pending.promise]);
    });

    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("dashboard card trash action", () => {
  it("asks for confirmation and leaves the card alone when cancelled", () => {
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderDashboard(undefined, [doc("owned", "Owned document")]);

    fireEvent.click(within(openDocumentMenu("Owned document")).getByTestId("document-delete"));

    expect(confirmDelete).toHaveBeenCalledWith(
      "Move “Owned document” to trash? You can restore it from the dashboard for 30 days.",
    );
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Owned document/ })).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("moves the card to trash, prevents duplicate activation while pending, and refreshes", async () => {
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    purgeDocument.mockReturnValueOnce(deletion.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDashboard(undefined, [doc("owned", "Owned document")]);

    const item = within(openDocumentMenu("Owned document")).getByTestId("document-delete");
    act(() => {
      fireEvent.click(item);
      fireEvent.click(item);
    });

    expect(purgeDocument).toHaveBeenCalledOnce();
    expect(purgeDocument).toHaveBeenCalledWith("owned");
    const pendingItem = within(openDocumentMenu("Owned document")).getByTestId("document-delete");
    expect(pendingItem).toHaveAttribute("data-disabled");
    expect(pendingItem).toHaveTextContent("Moving to trash…");

    await act(async () => {
      deletion.resolve({ ok: true, permanent: false });
      await deletion.promise;
    });

    expect(screen.queryByRole("link", { name: /Owned document/ })).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Owned document” was moved to the trash.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "success");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("refreshes the filed folder count after moving its card to trash", async () => {
    listFolders
      .mockResolvedValueOnce({ folders: [folder("f1", "Recipes", 1)] })
      .mockResolvedValueOnce({ folders: [folder("f1", "Recipes", 0)] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDashboard(undefined, [{ ...doc("filed", "Filed document"), folderId: "f1" }]);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("folder-chip")).toHaveTextContent("Recipes1");

    fireEvent.click(within(openDocumentMenu("Filed document")).getByTestId("document-delete"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("folder-chip")).toHaveTextContent("Recipes0");
    expect(listFolders).toHaveBeenCalledTimes(2);
  });

  it("keeps the card after a failed move and allows one retry", async () => {
    const failed = deferred<{ ok: true; permanent: boolean }>();
    const retry = deferred<{ ok: true; permanent: boolean }>();
    purgeDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDashboard(undefined, [doc("owned", "Owned document")]);

    fireEvent.click(within(openDocumentMenu("Owned document")).getByTestId("document-delete"));
    await act(async () => {
      failed.reject(new ApiError(503, "Trash service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByRole("link", { name: /Owned document/ })).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("Trash service unavailable");
    expect(within(openDocumentMenu("Owned document")).getByTestId("document-delete")).not.toHaveAttribute("data-disabled");

    fireEvent.click(screen.getByTestId("document-delete"));
    expect(purgeDocument).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve({ ok: true, permanent: false });
      await retry.promise;
    });
    expect(screen.queryByRole("link", { name: /Owned document/ })).toBeNull();
  });
});

describe("TrashView publication ownership", () => {

  it("preserves every Trash state and gives genuine Retry, Restore, and Delete clicks their exact callbacks once", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const local = trashedDoc("local-trash", "Local trash");
    const repository = {
      ...trashedDoc("repo-trash", "Repository trash"),
      excerpt: "Repository excerpt",
      storage: "repo" as const,
      repoOwner: "acme",
      repoName: "docs",
      repoPath: "plans/repository.md",
    };
    const onRetry = vi.fn();
    const onRestore = vi.fn<(document: DocumentSummaryDto) => void>();
    const onPurge = vi.fn<(document: DocumentSummaryDto) => void>();
    const canRetry = vi.fn(() => true);
    const canAct = vi.fn(() => true);
    const populated = () => (
      <TrashView
        documents={[local, repository]}
        busy={null}
        loading={false}
        error="Trash service unavailable"
        canRetry={canRetry}
        canAct={canAct}
        onRetry={onRetry}
        onRestore={onRestore}
        onPurge={onPurge}
      />
    );

    try {
      await act(async () => {
        root.render(populated());
      });

      expect(host.querySelector('[data-testid="trash-note"]')).toHaveTextContent("Items are deleted forever after 30 days.");
      expect(host.querySelector('[data-testid="trash-error"]')).toHaveTextContent("Trash service unavailable");
      expect(Array.from(host.querySelectorAll('[data-testid="trash-card"] h3'), (heading) => heading.textContent)).toEqual([
        local.title,
        repository.title,
      ]);
      expect(directTrashCard(host, repository.title)).toHaveTextContent(repository.excerpt);
      expect(directTrashCard(host, repository.title).querySelector('[data-testid="storage-badge"]')).toHaveAttribute(
        "title",
        "acme/docs: plans/repository.md",
      );
      expect(directTrashCard(host, local.title).querySelector("time")).toHaveAttribute("dateTime", local.deletedAt);

      const restore = directTrashButton(host, local.title, "restore-button");
      restore.click();
      await act(async () => root.render(populated()));
      directTrashButton(host, repository.title, "purge-button").click();
      await act(async () => root.render(populated()));
      directRetryButton(host).click();

      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onRestore).toHaveBeenLastCalledWith(local);
      expect(onPurge).toHaveBeenCalledTimes(1);
      expect(onPurge).toHaveBeenLastCalledWith(repository);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(canRetry).toHaveBeenCalledTimes(1);
      expect(canRetry).toHaveBeenLastCalledWith("Trash service unavailable");
      expect(canAct.mock.calls).toEqual([
        [local, "restore"],
        [repository, "purge"],
      ]);

      await act(async () => {
        root.render(
          <TrashView
            documents={null}
            busy={null}
            loading
            error={null}
            onRetry={onRetry}
            onRestore={onRestore}
            onPurge={onPurge}
          />,
        );
      });
      expect(host).toHaveTextContent("Loading trash…");
      expect(host.querySelector('[data-testid="trash-list"]')).toBeNull();

      await act(async () => {
        root.render(
          <TrashView
            documents={[]}
            busy={null}
            loading={false}
            error={null}
            onRetry={onRetry}
            onRestore={onRestore}
            onPurge={onPurge}
          />,
        );
      });
      expect(host).toHaveTextContent("The trash is empty");
      expect(host).toHaveTextContent("restored here for 30 days");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("re-reads parent eligibility before claiming and leaves rejected native events, focus, and DOM untouched", async () => {
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    const trashDocument = trashedDoc("eligibility", "Eligibility");
    const onRetry = vi.fn();
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    let retryEligible = false;
    let actionEligible = false;
    const canRetry = vi.fn(() => retryEligible);
    const canAct = vi.fn(() => actionEligible);
    type RejectedEvent = {
      isDefaultPrevented: () => boolean;
      isPropagationStopped: () => boolean;
    };
    const rejectedRetryEvent: { current: RejectedEvent | null } = { current: null };
    const rejectedRestoreEvent: { current: RejectedEvent | null } = { current: null };
    const currentView = () => (
      <TrashView
        documents={[trashDocument]}
        busy={null}
        loading={false}
        error="Retry me"
        canRetry={canRetry}
        canAct={canAct}
        onRetry={onRetry}
        onRestore={onRestore}
        onPurge={onPurge}
      />
    );

    try {
      await act(async () => {
        root.render(currentView());
      });
      const retry = directRetryButton(host);
      const restore = directTrashButton(host, trashDocument.title, "restore-button");
      const restoreRetry = interceptReactClick(retry, (original, event) => {
        original(event);
        rejectedRetryEvent.current = event as RejectedEvent;
      });
      const restoreRestore = interceptReactClick(restore, (original, event) => {
        original(event);
        rejectedRestoreEvent.current = event as RejectedEvent;
      });
      focusOwner.focus();
      const markup = host.innerHTML;

      retry.click();
      restore.click();

      expect(onRetry).not.toHaveBeenCalled();
      expect(onRestore).not.toHaveBeenCalled();
      expect(onPurge).not.toHaveBeenCalled();
      expect(rejectedRetryEvent.current?.isDefaultPrevented()).toBe(false);
      expect(rejectedRetryEvent.current?.isPropagationStopped()).toBe(false);
      expect(rejectedRestoreEvent.current?.isDefaultPrevented()).toBe(false);
      expect(rejectedRestoreEvent.current?.isPropagationStopped()).toBe(false);
      expect(document.activeElement).toBe(focusOwner);
      expect(host.innerHTML).toBe(markup);

      retryEligible = true;
      actionEligible = true;
      retry.click();
      restoreRetry();
      restoreRestore();
      await act(async () => root.render(currentView()));
      directTrashButton(host, trashDocument.title, "restore-button").click();

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onRestore).toHaveBeenLastCalledWith(trashDocument);
      expect(canRetry).toHaveBeenCalledTimes(2);
      expect(canAct).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      focusOwner.remove();
      host.remove();
    }
  });

  it("accepts Retry, Restore, and Delete forever clicks with a production-mangled React event constructor", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const trashDocument = trashedDoc("minified-trash", "Minified trash");
    const onRetry = vi.fn();
    const onRestore = vi.fn<(document: DocumentSummaryDto) => void>();
    const onPurge = vi.fn<(document: DocumentSummaryDto) => void>();
    const view = () => (
      <StrictMode>
        <TrashView
          documents={[trashDocument]}
          busy={null}
          loading={false}
          error="Trash service unavailable"
          onRetry={onRetry}
          onRestore={onRestore}
          onPurge={onPurge}
        />
      </StrictMode>
    );
    const clickMangled = (button: HTMLButtonElement) => {
      const restore = interceptMangledReactClick(button);
      try {
        act(() => button.click());
      } finally {
        restore();
      }
    };

    try {
      act(() => root.render(view()));
      clickMangled(directRetryButton(host));
      clickMangled(directTrashButton(host, trashDocument.title, "restore-button"));
      clickMangled(directTrashButton(host, trashDocument.title, "purge-button"));

      expect(onRetry).toHaveBeenCalledOnce();
      expect(onRestore).toHaveBeenCalledExactlyOnceWith(trashDocument);
      expect(onPurge).toHaveBeenCalledExactlyOnceWith(trashDocument);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("TrashView per-card keyboard navigation", () => {
  registerTrashKeyboardProvenanceTests();
  registerTrashKeyboardNativeAuthorityTests();

  it.each([
    ["restore-button", "purge-button", "ArrowRight"],
    ["restore-button", "purge-button", "ArrowDown"],
    ["restore-button", "purge-button", "End"],
    ["purge-button", "restore-button", "ArrowLeft"],
    ["purge-button", "restore-button", "ArrowUp"],
    ["purge-button", "restore-button", "Home"],
  ] as const)(
    "moves from %s to %s with %s exactly once without action or scroll work",
    (sourceId, destinationId, key) => {
      const onRetry = vi.fn();
      const onRestore = vi.fn();
      const onPurge = vi.fn();
      const view = renderTrashKeyboard(
        trash([first, second], null, "Trash warning", {
          onRetry,
          onRestore,
          onPurge,
        }),
        trackTrashNavigationEffects,
      );
      try {
        const card = directTrashCard(view.host, first.title);
        const source = card.querySelector<HTMLButtonElement>(
          `[data-testid="${sourceId}"]`,
        )!;
        const destination = card.querySelector<HTMLButtonElement>(
          `[data-testid="${destinationId}"]`,
        )!;
        source.focus();
        view.setup.preventDefault.mockClear();
        view.setup.focus.mockClear();
        view.setup.focusCalls.length = 0;
        view.setup.scrollTo.mockClear();
        view.setup.scrollBy.mockClear();
        const markup = view.host.innerHTML;
        const before = {
          x: view.ownerWindow.scrollX,
          y: view.ownerWindow.scrollY,
          cardTop: card.scrollTop,
          cardLeft: card.scrollLeft,
        };

        const event = dispatchTrashKey(source, key);

        expect(event.defaultPrevented).toBe(true);
        expect(view.setup.preventDefault).toHaveBeenCalledTimes(1);
        expect(view.setup.focus).toHaveBeenCalledTimes(1);
        expect(view.setup.focusCalls).toEqual([
          { target: destination, options: { preventScroll: true } },
        ]);
        expect(destination).toHaveFocus();
        expect(view.setup.scrollTo).not.toHaveBeenCalled();
        expect(view.setup.scrollBy).not.toHaveBeenCalled();
        expect({
          x: view.ownerWindow.scrollX,
          y: view.ownerWindow.scrollY,
          cardTop: card.scrollTop,
          cardLeft: card.scrollLeft,
        }).toEqual(before);
        expect(onRetry).not.toHaveBeenCalled();
        expect(onRestore).not.toHaveBeenCalled();
        expect(onPurge).not.toHaveBeenCalled();
        expect(view.host.innerHTML).toBe(markup);
      } finally {
        view.dispose();
      }
    },
  );

  it.each([
    ["purge-button", "restore-button", "ArrowLeft", "Numpad4"],
    ["purge-button", "restore-button", "ArrowUp", "Numpad8"],
    ["restore-button", "purge-button", "ArrowRight", "Numpad6"],
    ["restore-button", "purge-button", "ArrowDown", "Numpad2"],
    ["purge-button", "restore-button", "Home", "Numpad7"],
    ["restore-button", "purge-button", "End", "Numpad1"],
  ] as const)(
    "moves from %s to %s by semantic %s with physical %s",
    (sourceId, destinationId, key, code) => {
      const onRetry = vi.fn();
      const onRestore = vi.fn();
      const onPurge = vi.fn();
      const view = renderTrashKeyboard(
        trash([first, second], null, "Trash warning", {
          onRetry,
          onRestore,
          onPurge,
        }),
        trackTrashNavigationEffects,
      );
      try {
        const card = directTrashCard(view.host, first.title);
        const source = card.querySelector<HTMLButtonElement>(
          `[data-testid="${sourceId}"]`,
        )!;
        const destination = card.querySelector<HTMLButtonElement>(
          `[data-testid="${destinationId}"]`,
        )!;
        source.focus();
        view.setup.preventDefault.mockClear();
        view.setup.focus.mockClear();
        view.setup.focusCalls.length = 0;

        const event = dispatchTrashKey(source, key, {
          code,
          location:
            view.ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
        });

        expect(event.code).toBe(code);
        expect(event.location).toBe(
          view.ownerWindow.KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
        );
        expect(event.defaultPrevented).toBe(true);
        expect(view.setup.preventDefault).toHaveBeenCalledTimes(1);
        expect(view.setup.focus).toHaveBeenCalledTimes(1);
        expect(view.setup.focusCalls).toEqual([
          { target: destination, options: { preventScroll: true } },
        ]);
        expect(destination).toHaveFocus();
        expect(directTrashButton(
          view.host,
          second.title,
          destinationId,
        )).not.toHaveFocus();
        expect(onRetry).not.toHaveBeenCalled();
        expect(onRestore).not.toHaveBeenCalled();
        expect(onPurge).not.toHaveBeenCalled();
      } finally {
        view.dispose();
      }
    },
  );

  it.each([
    ["restore-button", "ArrowLeft"],
    ["restore-button", "ArrowUp"],
    ["restore-button", "Home"],
    ["purge-button", "ArrowRight"],
    ["purge-button", "ArrowDown"],
    ["purge-button", "End"],
  ] as const)(
    "leaves the %s %s boundary unprevented without wrapping or crossing cards",
    (sourceId, key) => {
      const view = renderTrashKeyboard(
        trash(),
        trackTrashNavigationEffects,
      );
      try {
        const firstCard = directTrashCard(view.host, first.title);
        const source = firstCard.querySelector<HTMLButtonElement>(
          `[data-testid="${sourceId}"]`,
        )!;
        const secondRestore = directTrashButton(
          view.host,
          second.title,
          "restore-button",
        );
        source.focus();
        view.setup.preventDefault.mockClear();
        view.setup.focus.mockClear();
        view.setup.focusCalls.length = 0;

        const event = dispatchTrashKey(source, key);

        expect(event.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(secondRestore).not.toHaveFocus();
        expect(view.setup.preventDefault).not.toHaveBeenCalled();
        expect(view.setup.focus).not.toHaveBeenCalled();
      } finally {
        view.dispose();
      }
    },
  );

  it("exposes public prevention to a same-root synthetic ancestor", () => {
    const onAncestorAction = vi.fn();
    const onRetry = vi.fn();
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    const ancestorObservations: {
      defaultPrevented: boolean;
      queried: boolean;
    }[] = [];
    const view = renderTrashKeyboard(
      <div
        onKeyDown={(event) => {
          ancestorObservations.push({
            defaultPrevented: event.defaultPrevented,
            queried: event.isDefaultPrevented(),
          });
          if (!event.defaultPrevented) onAncestorAction();
        }}
      >
        {trash([first, second], null, "Trash warning", {
          onRetry,
          onRestore,
          onPurge,
        })}
      </div>,
      trackTrashNavigationEffects,
    );
    try {
      const restore = directTrashButton(
        view.host,
        first.title,
        "restore-button",
      );
      const purge = directTrashButton(
        view.host,
        first.title,
        "purge-button",
      );
      restore.focus();
      view.setup.preventDefault.mockClear();
      view.setup.focus.mockClear();

      const event = dispatchTrashKey(restore, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(ancestorObservations).toEqual([
        { defaultPrevented: true, queried: true },
      ]);
      expect(onAncestorAction).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
      expect(onRestore).not.toHaveBeenCalled();
      expect(onPurge).not.toHaveBeenCalled();
      expect(view.setup.preventDefault).toHaveBeenCalledTimes(1);
      expect(view.setup.focus).toHaveBeenCalledTimes(1);
      expect(purge).toHaveFocus();
    } finally {
      view.dispose();
    }
  });

});

describe("dashboard filter keyboard navigation", () => {
  const navigationCases = [
    ["ArrowRight", "all", "mine", 0],
    ["ArrowDown", "all", "mine", 0],
    ["ArrowLeft", "mine", "all", 0],
    ["ArrowUp", "mine", "all", 0],
    ["Home", "starred", "all", 0],
    ["End", "all", "trash", 1],
    ["ArrowRight", "trash", "all", 0],
    ["ArrowLeft", "all", "trash", 1],
  ] as const;

  it.each(navigationCases)(
    "selects and focuses exactly once for %s from %s to %s",
    async (key, initial, destination, trashRequests) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <StrictMode>
              <Dashboard
                user={USER}
                documents={DOCUMENTS}
                githubAvailable
                githubConfigured
              />
            </StrictMode>,
          );
        });
        expect(filterGroup(host)).toHaveAttribute("role", "toolbar");
        expect(filterGroup(host)).toHaveAccessibleName("Document filters");
        expectCurrentFilter(host, "all");

        if (initial !== "all") {
          act(() => directFilterButton(host, initial).click());
          await act(async () => {});
        }
        expectCurrentFilter(host, initial);
        listDocuments.mockClear();

        const source = directFilterButton(host, initial);
        source.focus();
        focus.mockClear();
        const scrollIntoView = Element.prototype
          .scrollIntoView as ReturnType<typeof vi.fn>;
        scrollIntoView.mockClear();
        const beforeScroll = { x: window.scrollX, y: window.scrollY };
        const event = await dispatchFilterKey(source, key);
        const target = directFilterButton(host, destination);

        expect(event.defaultPrevented).toBe(true);
        expectCurrentFilter(host, destination);
        expect(target).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(focus.mock.instances[0]).toBe(target);
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect({ x: window.scrollX, y: window.scrollY }).toEqual(beforeScroll);
        expect(listDocuments).toHaveBeenCalledTimes(trashRequests);
        if (trashRequests) {
          expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["public owner Window", "proven backing receiver"] as const)(
    "accepts the %s as the native view",
    async (viewKind) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />,
          );
        });
        const all = directFilterButton(host, "all");
        const ownerWindow = all.ownerDocument.defaultView!;
        let backingReceiver: unknown = null;
        all.addEventListener(
          "keydown",
          (event) => {
            backingReceiver = event.composedPath().at(-1) ?? null;
          },
          { capture: true, once: true },
        );
        all.dispatchEvent(
          new ownerWindow.KeyboardEvent("keydown", {
            key: "PageDown",
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(backingReceiver).not.toBeNull();
        if (viewKind === "proven backing receiver") {
          expect(backingReceiver).not.toBe(ownerWindow);
        }

        const event = new ownerWindow.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        });
        markFilterEventTrusted(event);
        markFilterEventView(
          event,
          viewKind === "public owner Window" ? ownerWindow : backingReceiver,
        );
        all.focus();
        focus.mockClear();
        await act(async () => {
          all.dispatchEvent(event);
          await Promise.resolve();
        });

        expect(event.defaultPrevented).toBe(true);
        expectCurrentFilter(host, "mine");
        expect(directFilterButton(host, "mine")).toHaveFocus();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    ["Home", "all"],
    ["End", "trash"],
  ] as const)(
    "keeps same-destination %s on %s inert",
    async (key, filter) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />,
          );
        });
        if (filter === "trash") {
          act(() => directFilterButton(host, filter).click());
          await act(async () => {});
        }
        listDocuments.mockClear();
        const source = directFilterButton(host, filter);
        source.focus();
        focus.mockClear();

        const event = await dispatchFilterKey(source, key);

        expect(event.defaultPrevented).toBe(false);
        expectCurrentFilter(host, filter);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(listDocuments).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("keeps one Trash request on entry and cancels its late result on keyboard exit", async () => {
    const pending = deferred<ListResponse>();
    listDocuments.mockReturnValueOnce(pending.promise);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <Dashboard
              user={USER}
              documents={DOCUMENTS}
              githubAvailable
              githubConfigured
            />
          </StrictMode>,
        );
      });
      const all = directFilterButton(host, "all");
      all.focus();
      await dispatchFilterKey(all, "End");
      expectCurrentFilter(host, "trash");
      expect(listDocuments).toHaveBeenCalledExactlyOnceWith({ trash: true });
      expect(host).toHaveTextContent("Loading trash…");

      await dispatchFilterKey(directFilterButton(host, "trash"), "ArrowLeft");
      expectCurrentFilter(host, "starred");
      expect(listDocuments).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve({
          documents: [trashedDoc("late-filter-row", "Late filter row")],
        });
        await pending.promise;
      });
      expect(host).not.toHaveTextContent("Late filter row");
      expect(host.querySelector('[data-testid="trash-view"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("preserves native click selection without keyboard prevention or focus work", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <Dashboard
            user={USER}
            documents={DOCUMENTS}
            githubAvailable
            githubConfigured
          />,
        );
      });
      const all = directFilterButton(host, "all");
      all.focus();
      await dispatchFilterKey(all, "ArrowRight");
      expectCurrentFilter(host, "mine");

      focus.mockClear();
      const shared = directFilterButton(host, "shared");
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      act(() => shared.dispatchEvent(click));
      await act(async () => {});

      expect(click.defaultPrevented).toBe(false);
      expectCurrentFilter(host, "shared");
      expect(focus).not.toHaveBeenCalled();
      expect(listDocuments).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("releases an interrupted native dispatch before a clean successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <Dashboard
            user={USER}
            documents={DOCUMENTS}
            githubAvailable
            githubConfigured
          />,
        );
      });
      const all = directFilterButton(host, "all");
      all.focus();
      focus.mockClear();
      all.addEventListener("keydown", (event) => event.stopPropagation(), {
        once: true,
      });

      const interrupted = await dispatchFilterKey(all, "ArrowRight");
      expect(interrupted.defaultPrevented).toBe(false);
      expectCurrentFilter(host, "all");
      expect(focus).not.toHaveBeenCalled();

      const clean = directFilterButton(host, "all");
      clean.focus();
      focus.mockClear();
      const accepted = await dispatchFilterKey(clean, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expectCurrentFilter(host, "mine");
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

});

describe("dashboard trash recovery", () => {
  it("keeps the first load pending, then announces the API reason without false empty copy", async () => {
    const initial = deferred<ListResponse>();
    listDocuments.mockReturnValueOnce(initial.promise);
    renderDashboard();

    openTrash();
    expect(screen.getByText("Loading trash…")).toBeInTheDocument();
    expect(screen.queryByText("The trash is empty")).toBeNull();

    await act(async () => {
      initial.reject(new ApiError(503, "Trash service unavailable"));
      await Promise.allSettled([initial.promise]);
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Trash service unavailable");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("Loading trash…")).toBeNull();
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenLastCalledWith({ trash: true });
  });

  it("guards one pending Retry and recovers to both successful empty and populated states", async () => {
    const retry = deferred<ListResponse>();
    listDocuments
      .mockRejectedValueOnce(new ApiError(503, "Trash service unavailable"))
      .mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce({ documents: [trashedDoc("restored-list", "Recovered document")] });
    renderDashboard();
    openTrash();
    await act(async () => {});

    const retryButton = within(screen.getByRole("alert")).getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(listDocuments).toHaveBeenCalledTimes(2);
    expect(listDocuments.mock.calls[1]?.[0]).toEqual({ trash: true });
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ documents: [] });
      await retry.promise;
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(listDocuments).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("The trash is empty")).toBeNull();
    expect(screen.getByText("Recovered document")).toBeInTheDocument();
  });

  it("keeps cached rows visible below a retryable refresh failure", async () => {
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("cached", "Cached trash row")] })
      .mockRejectedValueOnce(new ApiError(503, "Refresh failed"));
    renderDashboard();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();

    leaveTrash();
    openTrash();
    await act(async () => {});

    const alert = screen.getByRole("alert");
    const list = screen.getByTestId("trash-list");
    expect(alert).toHaveTextContent("Refresh failed");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByText("Cached trash row")).toBeInTheDocument();
    expect(alert.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("isolates late rows and errors from earlier visits after leaving and re-entering Trash", async () => {
    const staleRows = deferred<ListResponse>();
    const staleError = deferred<ListResponse>();
    const current = deferred<ListResponse>();
    listDocuments
      .mockReturnValueOnce(staleRows.promise)
      .mockReturnValueOnce(staleError.promise)
      .mockReturnValueOnce(current.promise);
    renderDashboard();

    openTrash();
    leaveTrash();
    openTrash();
    leaveTrash();
    openTrash();
    expect(listDocuments).toHaveBeenCalledTimes(3);

    await act(async () => {
      current.resolve({ documents: [trashedDoc("current", "Current trash row")] });
      await current.promise;
    });
    await act(async () => {
      staleRows.resolve({ documents: [trashedDoc("stale", "Stale trash row")] });
      staleError.reject(new ApiError(503, "Stale visit failure"));
      await Promise.allSettled([staleRows.promise, staleError.promise]);
    });

    expect(screen.getByText("Current trash row")).toBeInTheDocument();
    expect(screen.queryByText("Stale trash row")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("owns two immediate Restore activations and commits the exact row once", async () => {
    const pending = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(pending.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("restore-me", "Restore me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const restore = trashButton("Restore me", "restore-button");

    act(() => {
      restore.click();
      restore.click();
    });

    expect(restoreDocument).toHaveBeenCalledTimes(1);
    expect(restoreDocument).toHaveBeenLastCalledWith("restore-me");
    expect(trashButton("Keep me", "restore-button")).toBeDisabled();

    await act(async () => {
      pending.resolve({ ok: true });
      await pending.promise;
    });

    expect(screen.queryByText("Restore me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Restore me” was restored.");
    expect(screen.getByTestId("toast")).toHaveAttribute("data-kind", "success");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("declines Delete without ownership, then keeps confirmed failure and retry single-owner", async () => {
    const failed = deferred<{ ok: true; permanent: boolean }>();
    const retry = deferred<{ ok: true; permanent: boolean }>();
    purgeDocument.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("purge-me", "Purge me"), trashedDoc("keep-me", "Keep me")] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    const purge = trashButton("Purge me", "purge-button");

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(1);
    expect(purgeDocument).not.toHaveBeenCalled();
    expect(purge).toBeEnabled();

    fireEvent.click(purge);
    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(purgeDocument).toHaveBeenLastCalledWith("purge-me", { permanent: true });
    await act(async () => {
      failed.reject(new ApiError(503, "Delete service unavailable"));
      await Promise.allSettled([failed.promise]);
    });

    expect(screen.getByTestId("toast")).toHaveTextContent("Delete service unavailable");
    expect(purge).toBeEnabled();
    act(() => {
      purge.click();
      purge.click();
    });
    expect(confirmDelete).toHaveBeenCalledTimes(3);
    expect(purgeDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      retry.resolve({ ok: true, permanent: true });
      await retry.promise;
    });

    expect(screen.queryByText("Purge me")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("lets a re-entered visit fail while an older success and finalizer stay inert", async () => {
    const staleSuccess = deferred<{ ok: true }>();
    const currentFailure = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleSuccess.promise).mockReturnValueOnce(currentFailure.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));
    expect(restoreDocument).toHaveBeenCalledTimes(2);

    await act(async () => {
      staleSuccess.resolve({ ok: true });
      await staleSuccess.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(trashButton("Same row", "restore-button")).toBeDisabled();

    await act(async () => {
      currentFailure.reject(new ApiError(503, "Current restore failed"));
      await Promise.allSettled([currentFailure.promise]);
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("Current restore failed");
    expect(trashButton("Same row", "restore-button")).toBeEnabled();
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      currentList.resolve({ documents: [trashedDoc("same-row", "Stale list row")] });
      await currentList.promise;
    });
    expect(screen.getByText("Same row")).toBeInTheDocument();
    expect(screen.queryByText("Stale list row")).toBeNull();
  });

  it("lets current Restore win before an older failure without stale notice, refresh, or finalizer work", async () => {
    const staleFailure = deferred<{ ok: true }>();
    const currentSuccess = deferred<{ ok: true }>();
    const currentList = deferred<ListResponse>();
    restoreDocument.mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(currentSuccess.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("same-row", "Same row"), trashedDoc("keep-me", "Keep me")] }).mockReturnValueOnce(currentList.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});

    fireEvent.click(trashButton("Same row", "restore-button"));
    leaveTrash();
    openTrash();
    fireEvent.click(trashButton("Same row", "restore-button"));

    await act(async () => {
      currentSuccess.resolve({ ok: true });
      await currentSuccess.promise;
    });
    expect(screen.queryByText("Same row")).toBeNull();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleFailure.reject(new ApiError(503, "Obsolete restore failed"));
      await Promise.allSettled([staleFailure.promise]);
      currentList.resolve({ documents: [trashedDoc("same-row", "Reintroduced row"), trashedDoc("keep-me", "Keep me")] });
      await currentList.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByTestId("toast")).toHaveTextContent("“Same row” was restored.");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires a pending list at the successful action boundary so it cannot reintroduce the row", async () => {
    const refresh = deferred<ListResponse>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("pending-row", "Pending row")] }).mockReturnValueOnce(refresh.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    renderDashboard();
    openTrash();
    await act(async () => {});
    leaveTrash();
    openTrash();
    expect(screen.getByTestId("trash-view")).toHaveAttribute("aria-busy", "true");

    fireEvent.click(trashButton("Pending row", "purge-button"));
    expect(screen.getByTestId("trash-view")).not.toHaveAttribute("aria-busy");
    await act(async () => {
      deletion.resolve({ ok: true, permanent: true });
      await deletion.promise;
    });
    expect(screen.queryByText("Pending row")).toBeNull();

    await act(async () => {
      refresh.resolve({ documents: [trashedDoc("pending-row", "Reintroduced row")] });
      await refresh.promise;
    });
    expect(screen.queryByText("Reintroduced row")).toBeNull();
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("invalidates an action whose target disappears on a later visit", async () => {
    const stale = deferred<{ ok: true }>();
    restoreDocument.mockReturnValueOnce(stale.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("removed-row", "Removed row")] }).mockResolvedValueOnce({ documents: [] });
    renderDashboard();
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Removed row", "restore-button"));

    leaveTrash();
    openTrash();
    await act(async () => {});
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();

    await act(async () => {
      stale.reject(new ApiError(503, "Removed target failed"));
      await Promise.allSettled([stale.promise]);
    });
    expect(screen.getByText("The trash is empty")).toBeInTheDocument();
    expect(screen.queryByTestId("toast")).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ignores pending Create and Restore work after unmount", async () => {
    const create = deferred<CreateResponse>();
    const restore = deferred<{ ok: true }>();
    createDocument.mockReturnValueOnce(create.promise);
    restoreDocument.mockReturnValueOnce(restore.promise);
    listDocuments.mockResolvedValueOnce({ documents: [trashedDoc("unmounted-row", "Unmounted row")] });
    const view = renderDashboard();
    fireEvent.click(screen.getByTestId("new-document"));
    openTrash();
    await act(async () => {});
    fireEvent.click(trashButton("Unmounted row", "restore-button"));

    view.unmount();
    await act(async () => {
      create.reject(new ApiError(503, "Unmounted create failed"));
      restore.reject(new ApiError(503, "Unmounted restore failed"));
      await Promise.allSettled([create.promise, restore.promise]);
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("retires pending Restore and Delete ownership at the layout unmount boundary", async () => {
    vi.useRealTimers();
    const restore = deferred<{ ok: true }>();
    const deletion = deferred<{ ok: true; permanent: boolean }>();
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    restoreDocument.mockReturnValueOnce(restore.promise);
    purgeDocument.mockReturnValueOnce(deletion.promise);
    listDocuments
      .mockResolvedValueOnce({ documents: [trashedDoc("restore-boundary", "Restore boundary")] })
      .mockResolvedValueOnce({ documents: [trashedDoc("delete-boundary", "Delete boundary")] });

    const unmountAndSettle = async (
      title: string,
      action: "restore-button" | "purge-button",
      settle: () => void,
      pending: Promise<unknown>,
    ) => {
      const view = render(
        <TransitionUnmount>
          <Dashboard user={USER} documents={DOCUMENTS} githubAvailable githubConfigured />
        </TransitionUnmount>,
      );
      openTrash();
      await act(async () => {});
      fireEvent.click(trashButton(title, action));
      const removed = deferred<void>();
      const settled = Promise.allSettled([pending]);
      let settledAtRemoval = false;
      let postRemovalMutations = 0;
      const observer = new MutationObserver((records) => {
        if (document.querySelector('[data-testid="trash-view"]')) return;
        if (!settledAtRemoval) {
          settledAtRemoval = true;
          settle();
          removed.resolve();
          return;
        }
        postRemovalMutations += records.length;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

      try {
        screen.getByTestId("unmount-dashboard").click();
        await removed.promise;
        await settled;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByTestId("trash-view")).toBeNull();
        expect(screen.queryByTestId("trash-card")).toBeNull();
        expect(screen.queryByTestId("toast")).toBeNull();
        return postRemovalMutations;
      } finally {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        observer.disconnect();
        view.unmount();
      }
    };

    try {
      const restoreMutations = await unmountAndSettle("Restore boundary", "restore-button", () => restore.resolve({ ok: true }), restore.promise);
      const deleteMutations = await unmountAndSettle(
        "Delete boundary",
        "purge-button",
        () => deletion.reject(new ApiError(503, "Unmounted delete failed")),
        deletion.promise,
      );

      expect(restoreDocument).toHaveBeenCalledTimes(1);
      expect(restoreDocument).toHaveBeenLastCalledWith("restore-boundary");
      expect(purgeDocument).toHaveBeenCalledTimes(1);
      expect(purgeDocument).toHaveBeenLastCalledWith("delete-boundary", { permanent: true });
      expect(restoreMutations + deleteMutations).toBe(0);
      expect(router.refresh).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });
});
