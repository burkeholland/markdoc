// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  StrictMode,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import * as Y from "yjs";
import type { CollabSession } from "@/editor/collab/session";
import type { LintIssue } from "@/editor/markdown/lint";
import type { DocumentDto } from "@/server/dto";
import type { Layout } from "@/lib/viewport";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/primitives";

const controlled = vi.hoisted(() => ({
  hydrated: true,
  issues: [] as unknown[],
  lint: vi.fn(),
  sessionValue: { text: "# Status bar", tree: {} },
  sessionHook: vi.fn(),
  themePreference: "system",
  themeSetter: vi.fn(),
  themeDisabled: false,
  themeHidden: false,
  themeContract: true,
}));

vi.mock("@/editor/markdown/lint", () => ({
  lintMarkdown: (...args: unknown[]) => {
    controlled.lint(...args);
    return controlled.issues;
  },
}));
vi.mock("@/lib/hooks", () => ({
  useHydrated: () => controlled.hydrated,
}));
vi.mock("./use-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-session")>();
  return {
    ...actual,
    useDebouncedSessionValue: controlled.sessionHook,
  };
});
vi.mock("@/components/ui/theme-toggle", () => ({
  ThemeToggle: ({ className }: { className?: string }) => {
    const label = `Theme: ${
      controlled.themePreference === "system"
        ? "System"
        : controlled.themePreference === "light"
          ? "Light"
          : "Dark"
    }`;
    return (
      <button
        type="button"
        className={`icon-btn ${className ?? ""}`.trim()}
        title={controlled.themeContract ? `${label} (click to switch)` : undefined}
        aria-label={controlled.themeContract ? label : undefined}
        disabled={controlled.themeDisabled}
        hidden={controlled.themeHidden}
        data-testid="theme-toggle"
        data-theme-preference={
          controlled.themeContract ? controlled.themePreference : undefined
        }
      >
        Theme
      </button>
    );
  },
  useTheme: () => [controlled.themePreference, controlled.themeSetter],
}));

import { StatusBar, type StatusBarProps } from "./status-bar";
import { setGoal } from "@/editor/collab/meta";

interface StatusCallbacks {
  layout: ReturnType<typeof vi.fn<(layout: Layout) => void>>;
  wrapping: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  syncScroll: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  issue: ReturnType<typeof vi.fn<(issue: LintIssue) => void>>;
  shortcuts: ReturnType<typeof vi.fn<() => void>>;
  storage: ReturnType<typeof vi.fn<() => void>>;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

interface ReactFiber {
  alternate?: ReactFiber | null;
  memoizedProps?: Record<string, unknown>;
  return: ReactFiber | null;
}

interface CapturedClick {
  capture: (event: ReactMouseEvent<HTMLElement>) => void;
  click: (event: ReactMouseEvent<HTMLElement>) => void;
  element: HTMLElement;
}

interface CapturedDisclosure {
  authorize: (event: ReactMouseEvent<HTMLElement>) => void;
  change: (open: boolean) => void;
  element: HTMLElement;
}

interface CapturedKey {
  keyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  element: HTMLElement;
}

class StatusBarPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

const ISSUE_A: LintIssue = {
  line: 3,
  column: 5,
  offset: 17,
  message: "Use a descriptive link",
  rule: "descriptive-link",
  severity: "warning",
};

const ISSUE_OTHER: LintIssue = {
  line: 7,
  column: 1,
  offset: 41,
  message: "Heading level skipped",
  rule: "heading-increment",
  severity: "error",
};

const directViews: DirectView[] = [];
const fakeSessionDisposals: (() => void)[] = [];
let restoreExactWindowRealm: (() => void) | null = null;
const fakeSessionSelections = new WeakMap<
  CollabSession,
  (from: number, to: number) => void
>();

function fakeSession(name: string) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("source");
  ytext.insert(0, controlled.sessionValue.text);
  const meta = ydoc.getMap("meta");
  const subscribers = new Set<() => void>();
  const awarenessListeners = new Set<() => void>();
  let localState: { cursor?: { anchor: unknown; head: unknown } } | null = null;
  let version = 0;
  const notify = () => {
    version += 1;
    [...subscribers].forEach((listener) => listener());
  };
  ydoc.on("update", notify);
  const session = {
    name,
    binding: { getTree: () => controlled.sessionValue },
    ydoc,
    ytext,
    meta,
    canEdit: true,
    user: {
      id: "alice",
      name: "Alice",
      login: "alice",
      image: null,
    },
    awareness: {
      getLocalState: () => localState,
      on: (event: string, listener: () => void) => {
        if (event === "change") awarenessListeners.add(listener);
      },
      off: (event: string, listener: () => void) => {
        if (event === "change") awarenessListeners.delete(listener);
      },
    },
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    get version() {
      return version;
    },
  } as unknown as CollabSession;
  fakeSessionSelections.set(session, (from, to) => {
    localState = {
      cursor: {
        anchor: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(ytext, from),
        ),
        head: Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(ytext, to),
        ),
      },
    };
    [...awarenessListeners].forEach((listener) => listener());
  });
  fakeSessionDisposals.push(() => {
    ydoc.off("update", notify);
    ydoc.destroy();
  });
  return session;
}

function setFakeSelection(session: CollabSession, from: number, to: number) {
  const setSelection = fakeSessionSelections.get(session);
  if (!setSelection) throw new Error("Unknown fake session");
  setSelection(from, to);
}

function documentDto(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: "document-a",
    title: "Status publication",
    storage: "repo",
    linkAccess: "private",
    linkPreview: false,
    ownerId: "owner",
    gistId: null,
    gistFile: null,
    repoOwner: "octo",
    repoName: "docs",
    repoBranch: "main",
    repoPath: "README.md",
    publishedAt: null,
    hasUnpublishedChanges: true,
    githubUrl: "https://github.com/octo/docs/blob/main/README.md",
    createdAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

function callbacks(): StatusCallbacks {
  return {
    layout: vi.fn(),
    wrapping: vi.fn(),
    syncScroll: vi.fn(),
    issue: vi.fn(),
    shortcuts: vi.fn(),
    storage: vi.fn(),
  };
}

function statusProps(
  currentCallbacks: StatusCallbacks,
  overrides: Partial<StatusBarProps> = {},
): StatusBarProps {
  return {
    session: fakeSession("session-a"),
    doc: documentDto(),
    layout: "split",
    onLayout: currentCallbacks.layout,
    lineWrapping: false,
    onLineWrapping: currentCallbacks.wrapping,
    syncScroll: true,
    onSyncScroll: currentCallbacks.syncScroll,
    onIssueSelect: currentCallbacks.issue,
    onShortcuts: currentCallbacks.shortcuts,
    onStorage: currentCallbacks.storage,
    compact: false,
    ...overrides,
  };
}

async function renderDirect(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  await act(async () => {
    view.root.render(node);
    await Promise.resolve();
  });
  return view;
}

async function renderStatus(
  props: StatusBarProps,
  key = "initial",
  strict = true,
) {
  return renderDirect(
    strict
      ? (
          <StrictMode>
            <StatusBar key={key} {...props} />
          </StrictMode>
        )
      : <StatusBar key={key} {...props} />,
  );
}

async function rerenderStatus(
  view: DirectView,
  props: StatusBarProps,
  key = "initial",
) {
  await act(async () => {
    view.root.render(
      <StrictMode>
        <StatusBar key={key} {...props} />
      </StrictMode>,
    );
    await Promise.resolve();
  });
}

function elementWithText(selector: string, text: string) {
  const element = [...document.querySelectorAll<HTMLElement>(selector)]
    .findLast((candidate) => candidate.textContent?.includes(text));
  if (!element) throw new Error(`${selector} containing "${text}" was not rendered`);
  return element;
}

async function expectFocusedMenuItem(
  trigger: HTMLElement,
  selector: string,
  text: string,
) {
  await waitFor(() => {
    const contents = screen.getAllByTestId("status-menu-content");
    const item = elementWithText(selector, text);
    expect(contents).toHaveLength(1);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", contents[0]!.id);
    expect(contents[0]).toContainElement(item);
    expect(item).toHaveFocus();
  });
}

async function expectFocusedIssueRow(
  trigger: HTMLElement,
  issue: LintIssue,
) {
  await waitFor(() => {
    const contents = screen.getAllByTestId("status-issues-content");
    const row = elementWithText("button", issue.message);
    expect(contents).toHaveLength(1);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", contents[0]!.id);
    expect(contents[0]).toContainElement(row);
    expect(row).toHaveFocus();
  });
}

function desktopShortcuts() {
  const element = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Help and shortcuts"]',
  );
  if (!element) throw new Error("Desktop shortcuts were not rendered");
  return element;
}

function statusControls(compact = false) {
  const stats = screen.getByTestId("stats-button");
  const menu = screen.getByTestId("layout-menu");
  const storage = screen.getByTestId("storage-indicator");
  if (compact) return [stats, storage, menu];
  return [
    stats,
    menu,
    screen.getByTestId("issues-button"),
    storage,
    screen.getByTestId("theme-toggle"),
    desktopShortcuts(),
  ];
}

function openMenu() {
  const trigger = screen.getByTestId("layout-menu");
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  return trigger;
}

function selectMenuItem(selector: string, text: string) {
  const trigger = openMenu();
  const item = elementWithText(selector, text);
  fireEvent.click(item);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
}

function openIssues() {
  const trigger = screen.getByTestId("issues-button");
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  return trigger;
}

function closeIssues() {
  const trigger = screen.getByTestId("issues-button");
  if (trigger.getAttribute("aria-expanded") === "true") fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
}

async function nextTask() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function outsidePointerClick(
  pointerDownTarget: HTMLElement,
  releaseTarget = pointerDownTarget,
) {
  fireEvent(pointerDownTarget, pointerEvent("pointerdown", 7));
  await nextTask();
  fireEvent(releaseTarget, pointerEvent("pointerup", 7));
  fireEvent(releaseTarget, pointerEvent("click", 7));
  await act(async () => {
    await Promise.resolve();
  });
}

function pointerEvent(
  type: "pointerdown" | "pointerup" | "pointercancel" | "click",
  pointerId = 1,
  overrides: PointerEventInit = {},
) {
  return new StatusBarPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: type === "pointercancel" ? -1 : 0,
    detail: type === "click" ? 1 : 0,
    pointerId,
    pointerType: "mouse",
    isPrimary: true,
    ...overrides,
  });
}

function fiberFor(element: Element): ReactFiber {
  const fiberKey = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactFiber$"),
  );
  const propsKey = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  if (!fiberKey || !propsKey)
    throw new Error(`React internals were not attached to ${element.tagName}`);
  const record = element as unknown as Record<
    string,
    ReactFiber | Record<string, unknown>
  >;
  const fiber = record[fiberKey] as ReactFiber;
  const props = record[propsKey] as Record<string, unknown>;
  const alternate = fiber.alternate;
  if (!alternate) return fiber;
  const handlerNames = [
    "onClick",
    "onClickCapture",
    "onPointerDown",
    "onPointerDownCapture",
    "onKeyDown",
  ];
  const alternateIsCurrent = handlerNames.some(
    (name) =>
      typeof props[name] === "function"
      && alternate.memoizedProps?.[name] === props[name],
  );
  return alternateIsCurrent ? alternate : fiber;
}

function nearestHandler<T extends (...args: never[]) => unknown>(
  element: Element,
  name: string,
): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const handler = fiber.memoizedProps?.[name];
    if (typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`${name} was not found above ${element.tagName}`);
}

function reactHandler<T extends (...args: never[]) => unknown>(
  element: Element,
  name: string,
): T {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  if (!key) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown>>)[key];
  const handler = props[name];
  if (typeof handler !== "function")
    throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

function captureClick(element: HTMLElement): CapturedClick {
  return {
    capture: reactHandler(element, "onClickCapture"),
    click: reactHandler(element, "onClick"),
    element,
  };
}

function captureDisclosure(element: HTMLElement): CapturedDisclosure {
  return {
    authorize: reactHandler(element, "onPointerDownCapture"),
    change: nearestHandler(element, "onOpenChange"),
    element,
  };
}

function captureKey(element: HTMLElement): CapturedKey {
  return {
    keyDown: reactHandler(element, "onKeyDownCapture"),
    element,
  };
}

function trustKeyboardEvent(event: KeyboardEvent, ownerWindow: Window) {
  const implementationSymbol = Object.getOwnPropertySymbols(event).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  if (!implementationSymbol)
    throw new Error("Keyboard event implementation slot was not available");
  const implementation = (
    event as unknown as Record<
      symbol,
      { isTrusted: boolean; view: Window | null }
    >
  )[implementationSymbol];
  const descriptor = Object.getOwnPropertyDescriptor(
    implementation,
    "isTrusted",
  );
  if (!descriptor?.writable)
    throw new Error("Keyboard event trust slot was not writable");
  implementation.view = ownerWindow;
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  expect(event.isTrusted).toBe(true);
  expect(event.view).toBe(ownerWindow);
}

function menuKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("Menu trigger owner window was unavailable");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    code: key,
    key,
    ...init,
  });
  if (trusted) trustKeyboardEvent(event, ownerWindow);
  return event;
}

function useExactWindowListenerRealm() {
  if (restoreExactWindowRealm) return;
  const exposedWindow = document.defaultView;
  if (!exposedWindow) throw new Error("Document default view was unavailable");
  let listenerReceiver: Window | null = null;
  const observeReceiver = (event: Event) => {
    if (!(event.currentTarget instanceof exposedWindow.Window))
      throw new Error("Window listener current target was unavailable");
    listenerReceiver = event.currentTarget;
  };
  exposedWindow.addEventListener("status-bar-window-probe", observeReceiver, {
    once: true,
  });
  exposedWindow.dispatchEvent(
    new exposedWindow.Event("status-bar-window-probe"),
  );
  if (!listenerReceiver) throw new Error("Window listener receiver was unavailable");
  const ownDescriptor = Object.getOwnPropertyDescriptor(document, "defaultView");
  Object.defineProperty(document, "defaultView", {
    configurable: true,
    value: listenerReceiver,
  });
  restoreExactWindowRealm = () => {
    if (ownDescriptor) {
      Object.defineProperty(document, "defaultView", ownDescriptor);
    } else {
      Reflect.deleteProperty(document, "defaultView");
    }
  };
}

function fabricatedClick(
  currentTarget: EventTarget | null,
  target: EventTarget | null = currentTarget,
) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    event: {
      nativeEvent: {
        type: "click",
        target,
        composedPath: () => [target, currentTarget, document, window],
      },
      type: "click",
      target,
      currentTarget,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: 1,
      preventDefault,
      stopPropagation,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    } as unknown as ReactMouseEvent<HTMLElement>,
    preventDefault,
    stopPropagation,
  };
}

function invokeFabricatedClick(
  action: CapturedClick,
  currentTarget: EventTarget | null = action.element,
  target: EventTarget | null = currentTarget,
) {
  const probe = fabricatedClick(currentTarget, target);
  action.capture(probe.event);
  action.click(probe.event);
  return probe;
}

function invokeFabricatedDisclosure(disclosure: CapturedDisclosure) {
  const probe = fabricatedClick(disclosure.element);
  disclosure.authorize(probe.event);
  disclosure.change(true);
  return probe;
}

function allCallbackCounts(sets: StatusCallbacks[]) {
  return sets.flatMap((set) => [
    set.layout.mock.calls.length,
    set.wrapping.mock.calls.length,
    set.syncScroll.mock.calls.length,
    set.issue.mock.calls.length,
    set.shortcuts.mock.calls.length,
    set.storage.mock.calls.length,
  ]);
}

function LayoutReplayProbe({ inspect }: { inspect: () => void }) {
  useLayoutEffect(() => {
    inspect();
  }, [inspect]);
  return null;
}

function NavigationEventProbe({
  children,
  onCapture,
  onBubble,
}: {
  children: ReactNode;
  onCapture?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onBubble?: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <div onKeyDownCapture={onCapture} onKeyDown={onBubble}>
      {children}
    </div>
  );
}

function UnrelatedPresencePopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="presence-trigger">
          Presence
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid="presence-content">
        Current collaborators
      </PopoverContent>
    </Popover>
  );
}

beforeEach(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: StatusBarPointerEvent,
  });
  controlled.hydrated = true;
  controlled.issues = [ISSUE_A];
  controlled.lint.mockReset();
  controlled.sessionHook.mockReset().mockImplementation(() => controlled.sessionValue);
  controlled.sessionValue = { text: "# Status bar", tree: {} };
  controlled.themePreference = "system";
  controlled.themeSetter.mockReset();
  controlled.themeDisabled = false;
  controlled.themeHidden = false;
  controlled.themeContract = true;
});

afterEach(async () => {
  while (directViews.length) {
    const view = directViews.pop()!;
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
    view.host.remove();
  }
  while (fakeSessionDisposals.length) fakeSessionDisposals.pop()!();
  restoreExactWindowRealm?.();
  restoreExactWindowRealm = null;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "PointerEvent");
});

describe("status bar Strict Mode controls", () => {
  it("publishes a distinct complete replay before desktop controls act exactly once", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const staleStorage: CapturedClick[] = [];
    const staleMenu: CapturedDisclosure[] = [];
    const inspect = () => {
      staleStorage.push(captureClick(screen.getByTestId("storage-indicator")));
      staleMenu.push(captureDisclosure(screen.getByTestId("layout-menu")));
    };
    await renderDirect(
      <StrictMode>
        <StatusBar {...props} />
        <LayoutReplayProbe inspect={inspect} />
      </StrictMode>,
    );

    expect(staleStorage).toHaveLength(2);
    expect(staleMenu).toHaveLength(2);
    const staleStorageProbe = invokeFabricatedClick(staleStorage[0]);
    const staleMenuProbe = invokeFabricatedDisclosure(staleMenu[0]);
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(screen.getByTestId("layout-menu")).toHaveAttribute("aria-expanded", "false");
    expect(staleStorageProbe.preventDefault).not.toHaveBeenCalled();
    expect(staleStorageProbe.stopPropagation).not.toHaveBeenCalled();
    expect(staleMenuProbe.preventDefault).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("storage-indicator"));
    fireEvent.click(desktopShortcuts());
    openIssues();
    const issueEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const issueRow = elementWithText("button", ISSUE_A.message);
    act(() => {
      issueRow.dispatchEvent(issueEvent);
      issueRow.dispatchEvent(issueEvent);
    });
    closeIssues();
    selectMenuItem('[role="menuitemradio"]', "Code only");
    selectMenuItem('[role="menuitemcheckbox"]', "Wrap long lines");
    selectMenuItem('[role="menuitemcheckbox"]', "Sync scrolling");

    expect(current.storage).toHaveBeenCalledOnce();
    expect(current.shortcuts).toHaveBeenCalledOnce();
    expect(current.issue).toHaveBeenCalledOnce();
    expect(current.issue).toHaveBeenCalledWith(ISSUE_A);
    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("code");
    expect(current.wrapping).toHaveBeenCalledOnce();
    expect(current.wrapping).toHaveBeenCalledWith(true);
    expect(current.syncScroll).toHaveBeenCalledOnce();
    expect(current.syncScroll).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("status-bar")).not.toHaveAttribute("data-compact");
    expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
  });

  it("keeps compact layout, wrapping, sync, theme, shortcuts, and storage authority exact", async () => {
    const current = callbacks();
    const props = statusProps(current, { compact: true, layout: "code" });
    await renderStatus(props);

    const trigger = screen.getByTestId("layout-menu");
    expect(trigger).toHaveAccessibleName("View options");
    expect(screen.queryByTestId("issues-button")).toBeNull();
    expect(screen.queryByTestId("theme-toggle")).toBeNull();

    openMenu();
    expect(
      document.querySelector('[role="menuitemradio"]')?.parentElement?.textContent,
    ).not.toContain("Code and preview");
    fireEvent.click(screen.getByTestId("menu-theme-dark"));
    selectMenuItem('[role="menuitemradio"]', "Preview only");
    selectMenuItem('[role="menuitemcheckbox"]', "Wrap long lines");
    selectMenuItem('[role="menuitemcheckbox"]', "Sync scrolling");
    selectMenuItem('[role="menuitem"]', "Help and shortcuts");
    fireEvent.click(screen.getByTestId("storage-indicator"));

    expect(controlled.themeSetter).toHaveBeenCalledOnce();
    expect(controlled.themeSetter).toHaveBeenCalledWith("dark");
    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("rich");
    expect(current.wrapping).toHaveBeenCalledOnce();
    expect(current.syncScroll).toHaveBeenCalledOnce();
    expect(current.shortcuts).toHaveBeenCalledOnce();
    expect(current.storage).toHaveBeenCalledOnce();
    expect(screen.getByTestId("status-bar")).toHaveAttribute("data-compact", "true");
  });

  it.each([
    [false, "split", "ArrowDown", '[role="menuitemradio"]', "Code and preview"],
    [false, "split", "ArrowUp", '[role="menuitemcheckbox"]', "Sync scrolling"],
    [true, "code", "ArrowDown", '[role="menuitemradio"]', "Code only"],
    [true, "code", "ArrowUp", '[role="menuitem"]', "Help and shortcuts"],
  ] as const)(
    "opens the %s menu from closed with %s and focuses %s once without actions or scroll",
    async (compact, layout, key, selector, label) => {
      useExactWindowListenerRealm();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
        writable: true,
      });
      try {
        const current = callbacks();
        await renderStatus(statusProps(current, { compact, layout }));
        const trigger = screen.getByTestId("layout-menu");
        trigger.focus();
        focus.mockClear();
        const scrollPosition = {
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        };
        const event = menuKey(trigger, key);

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        await expectFocusedMenuItem(trigger, selector, label);
        expect(
          preventDefault.mock.contexts.filter((context) => context === event),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
        expect(controlled.themeSetter).not.toHaveBeenCalled();
        expect(documentScroll).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect({
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        }).toEqual(scrollPosition);
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
        documentScroll.mockRestore();
        if (originalScrollIntoView) {
          Object.defineProperty(
            HTMLElement.prototype,
            "scrollIntoView",
            originalScrollIntoView,
          );
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
        }
      }
    },
  );

  it.each(["Enter", " "] as const)(
    "retains closed-trigger %s opening and normal Escape focus return",
    async (key) => {
      const current = callbacks();
      await renderStatus(statusProps(current));
      const trigger = screen.getByTestId("layout-menu");
      trigger.focus();

      fireEvent.keyDown(trigger, { key });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(screen.getByTestId("status-menu-content"), {
        key: "Escape",
      });
      await nextTask();

      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveFocus();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );

  it("preserves keyboard selection, Escape focus return, labels, and ARIA", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));

    const trigger = openMenu();
    const code = elementWithText('[role="menuitemradio"]', "Code only");
    code.focus();
    fireEvent.keyDown(code, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();

    openMenu();
    const rich = elementWithText('[role="menuitemradio"]', "Preview only");
    rich.focus();
    fireEvent.keyDown(rich, { key: "Enter" });
    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("rich");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    const issuesTrigger = openIssues();
    expect(issuesTrigger).toHaveTextContent("1 issue");
    expect(screen.getByTestId("status-issues-content")).toHaveTextContent(
      "Markdown issues",
    );
    fireEvent.keyDown(screen.getByTestId("status-issues-content"), {
      key: "Escape",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(issuesTrigger).toHaveAttribute("aria-expanded", "false");
    expect(issuesTrigger).toHaveFocus();
  });
});

describe("status bar top-level keyboard navigation", () => {
  it("moves to the next desktop control once without activation or scroll work", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    try {
      await renderStatus(statusProps(current));
      const controls = statusControls();
      const source = controls[3]!;
      const destination = controls[4]!;
      source.focus();
      focus.mockClear();
      const event = menuKey(source, "ArrowRight", {
        code: "Numpad6",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });

      act(() => {
        source.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      expect(controlled.themeSetter).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      expect(screen.getByTestId("layout-menu")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    } finally {
      focus.mockRestore();
      preventDefault.mockRestore();
      scroll.mockRestore();
    }
  });

  it("keeps the exact pair through one and nested capture-to-bubble microtask checkpoints", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const queuedMicrotasks: VoidFunction[] = [];
    const queue = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(
      (callback) => queuedMicrotasks.push(callback),
    );
    try {
      await renderStatus(statusProps(current));
      const source = statusControls()[1]!;
      const destination = statusControls()[2]!;
      let checkpoints = 0;
      source.addEventListener("keydown", () => {
        const expiry = queuedMicrotasks.shift();
        if (!expiry) throw new Error("Navigation expiry was not queued");
        expiry();
        checkpoints += 1;
        queueMicrotask(expiry);
        const nestedExpiry = queuedMicrotasks.shift();
        if (!nestedExpiry) throw new Error("Nested navigation expiry was not queued");
        nestedExpiry();
        checkpoints += 1;
      }, { capture: true, once: true });
      source.focus();
      const event = menuKey(source, "ArrowRight");

      act(() => {
        source.dispatchEvent(event);
      });

      expect(checkpoints).toBe(2);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      while (queuedMicrotasks.length) queuedMicrotasks.shift()!();
      queue.mockRestore();
    }
  });

  it("keeps the rightful pair through wrong-target, reentrant, and duplicate capture attempts", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    let rootCapture: ((event: ReactKeyboardEvent<HTMLElement>) => void) | null =
      null;
    let rootBubble: ((event: ReactKeyboardEvent<HTMLElement>) => void) | null =
      null;
    let captureEvent: ReactKeyboardEvent<HTMLElement> | null = null;
    let bubbleEvent: ReactKeyboardEvent<HTMLElement> | null = null;
    let reentered = false;
    let duplicateAttempts = 0;
    try {
      await renderDirect(
        <StrictMode>
          <NavigationEventProbe
            onCapture={(event) => {
              captureEvent = event;
              const capture = rootCapture;
              if (!capture)
                throw new Error("Status bar capture handler was unavailable");
              capture(event);
              const nativeEventDescriptor = Object.getOwnPropertyDescriptor(
                event,
                "nativeEvent",
              );
              if (!nativeEventDescriptor)
                throw new Error("React native event slot was unavailable");
              const nativeEvent = event.nativeEvent;
              Object.defineProperty(event, "nativeEvent", {
                configurable: true,
                enumerable: nativeEventDescriptor.enumerable,
                get() {
                  Object.defineProperty(
                    event,
                    "nativeEvent",
                    nativeEventDescriptor,
                  );
                  reentered = true;
                  capture(event);
                  return nativeEvent;
                },
              });
              capture(event);
            }}
            onBubble={(event) => {
              bubbleEvent = event;
            }}
          >
            <StatusBar {...statusProps(current)} />
          </NavigationEventProbe>
        </StrictMode>,
      );
      const root = screen.getByTestId("status-bar");
      rootCapture = reactHandler<
        (event: ReactKeyboardEvent<HTMLElement>) => void
      >(root, "onKeyDownCapture");
      rootBubble = reactHandler<
        (event: ReactKeyboardEvent<HTMLElement>) => void
      >(root, "onKeyDown");
      const source = statusControls()[1]!;
      const destination = statusControls()[2]!;
      source.addEventListener("keydown", () => {
        const capture = rootCapture;
        const retainedEvent = captureEvent;
        if (!capture || !retainedEvent)
          throw new Error("React capture attempt was unavailable");
        capture(retainedEvent);
        capture(retainedEvent);
        duplicateAttempts += 2;
      }, { capture: true, once: true });
      source.focus();
      focus.mockClear();
      const event = menuKey(source, "ArrowRight");

      act(() => {
        source.dispatchEvent(event);
      });

      expect(reentered).toBe(true);
      expect(duplicateAttempts).toBe(2);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);
      const capture = captureEvent;
      const bubble = bubbleEvent;
      const captureHandler = rootCapture;
      const bubbleHandler = rootBubble;
      if (!capture || !bubble || !captureHandler || !bubbleHandler)
        throw new Error("Retained navigation pair was unavailable");
      source.focus();
      focus.mockClear();
      await act(async () => {
        captureHandler(capture);
        bubbleHandler(bubble);
        source.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(focus).not.toHaveBeenCalled();
      expect(
        preventDefault.mock.contexts.filter((context) => context === event),
      ).toHaveLength(1);

      const cleanSource = statusControls()[1]!;
      const cleanDestination = statusControls()[2]!;
      cleanSource.focus();
      focus.mockClear();
      const clean = menuKey(cleanSource, "ArrowRight");
      act(() => {
        cleanSource.dispatchEvent(clean);
      });
      expect(clean.defaultPrevented).toBe(true);
      expect(cleanDestination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it.each(["throwing native-event read", "prevent-method drift"] as const)(
    "keeps the rightful pair pending after a %s capture attempt",
    async (failure) => {
      useExactWindowListenerRealm();
      const current = callbacks();
      let rootCapture:
        | ((event: ReactKeyboardEvent<HTMLElement>) => void)
        | null = null;
      let attempted = false;
      await renderDirect(
        <StrictMode>
          <NavigationEventProbe onCapture={(event) => {
            const capture = rootCapture;
            if (!capture)
              throw new Error("Status bar capture handler was unavailable");
            capture(event);
            if (failure === "throwing native-event read") {
              const descriptor = Object.getOwnPropertyDescriptor(
                event,
                "nativeEvent",
              );
              if (!descriptor)
                throw new Error("React native event slot was unavailable");
              const nativeEvent = event.nativeEvent;
              let reads = 0;
              let threw = false;
              Object.defineProperty(event, "nativeEvent", {
                configurable: true,
                enumerable: descriptor.enumerable,
                get() {
                  reads += 1;
                  if (reads === 3) {
                    Object.defineProperty(event, "nativeEvent", descriptor);
                    threw = true;
                    throw new Error("capture read failed");
                  }
                  return nativeEvent;
                },
              });
              try {
                expect(() => capture(event)).not.toThrow();
              } finally {
                Object.defineProperty(event, "nativeEvent", descriptor);
              }
              expect(threw).toBe(true);
            } else {
              const descriptor = Object.getOwnPropertyDescriptor(
                event,
                "preventDefault",
              );
              const preventDefault = event.preventDefault;
              if (typeof preventDefault !== "function")
                throw new Error("React preventDefault method was unavailable");
              Object.defineProperty(event, "preventDefault", {
                configurable: true,
                value: vi.fn(),
              });
              try {
                capture(event);
              } finally {
                if (descriptor) {
                  Object.defineProperty(event, "preventDefault", descriptor);
                } else {
                  Reflect.deleteProperty(event, "preventDefault");
                }
              }
              expect(event.preventDefault).toBe(preventDefault);
            }
            attempted = true;
            expect(event.defaultPrevented).toBe(false);
            expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
          }}>
            <StatusBar {...statusProps(current)} />
          </NavigationEventProbe>
        </StrictMode>,
      );
      const root = screen.getByTestId("status-bar");
      rootCapture = reactHandler<
        (event: ReactKeyboardEvent<HTMLElement>) => void
      >(root, "onKeyDownCapture");
      const source = statusControls()[1]!;
      const destination = statusControls()[2]!;
      source.focus();
      const event = menuKey(source, "ArrowRight");

      act(() => {
        source.dispatchEvent(event);
      });

      expect(attempted).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );

  it("keeps a rightful bubble pending after crossed, wrong-source, and drifted attempts", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    let captureEvent: ReactKeyboardEvent<HTMLElement> | null = null;
    await renderDirect(
      <StrictMode>
        <NavigationEventProbe onCapture={(event) => {
          captureEvent = event;
        }}>
          <StatusBar {...statusProps(current)} />
        </NavigationEventProbe>
      </StrictMode>,
    );
    const root = screen.getByTestId("status-bar");
    const source = statusControls()[1]!;
    const destination = statusControls()[2]!;
    const complete = reactHandler<
      (event: ReactKeyboardEvent<HTMLElement>) => void
    >(root, "onKeyDown");
    source.addEventListener("keydown", () => {
      if (!captureEvent) throw new Error("React capture wrapper was unavailable");
      complete(captureEvent);
      const target = captureEvent.target;
      const preventDefault = captureEvent.preventDefault;
      Object.defineProperty(captureEvent, "target", {
        configurable: true,
        value: destination,
      });
      Object.defineProperty(captureEvent, "preventDefault", {
        configurable: true,
        value: vi.fn(),
      });
      complete(captureEvent);
      Object.defineProperty(captureEvent, "target", {
        configurable: true,
        value: target,
      });
      Object.defineProperty(captureEvent, "preventDefault", {
        configurable: true,
        value: preventDefault,
      });
    }, { capture: true, once: true });
    source.focus();
    const event = menuKey(source, "ArrowRight");

    act(() => {
      source.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(destination).toHaveFocus();
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each([
    "prevent-method drift",
    "cancellation-query mutation",
    "cancellation-query reentry",
  ] as const)(
    "retires %s after cancellation and accepts a distinct clean successor",
    async (failure) => {
      useExactWindowListenerRealm();
      const current = callbacks();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      let sampledBubble: ReactKeyboardEvent<HTMLElement> | null = null;
      let prototype: object | null = null;
      let preventDefaultDescriptor: PropertyDescriptor | undefined;
      try {
        await renderDirect(
          <StrictMode>
            <NavigationEventProbe onBubble={(event) => {
              sampledBubble = event;
            }}>
              <StatusBar {...statusProps(current)} />
            </NavigationEventProbe>
          </StrictMode>,
        );
        const source = statusControls()[2]!;
        source.focus();
        act(() => {
          source.dispatchEvent(menuKey(source, "Tab"));
        });
        if (!sampledBubble)
          throw new Error("React bubble wrapper was unavailable");
        prototype = Object.getPrototypeOf(sampledBubble);
        preventDefaultDescriptor = Object.getOwnPropertyDescriptor(
          prototype,
          "preventDefault",
        );
        if (
          !preventDefaultDescriptor
          || typeof preventDefaultDescriptor.value !== "function"
        )
          throw new Error("React preventDefault method was unavailable");
        const retainedPreventDefault = preventDefaultDescriptor.value as (
          this: ReactKeyboardEvent<HTMLElement>,
        ) => void;
        const root = screen.getByTestId("status-bar");
        const complete = reactHandler<
          (event: ReactKeyboardEvent<HTMLElement>) => void
        >(root, "onKeyDown");
        const destination = statusControls()[3]!;
        const parent = destination.parentNode;
        const next = destination.nextSibling;
        if (!parent) throw new Error("Navigation destination was detached");
        let rejected: KeyboardEvent | null = null;
        let failureApplied = false;
        Object.defineProperty(prototype, "preventDefault", {
          ...preventDefaultDescriptor,
          value: function (this: ReactKeyboardEvent<HTMLElement>) {
            Reflect.apply(retainedPreventDefault, this, []);
            if (this.nativeEvent !== rejected) return;
            if (failure === "prevent-method drift") {
              Object.defineProperty(this, "isPropagationStopped", {
                configurable: true,
                value: () => false,
              });
              return;
            }
            const retainedQuery = this.isDefaultPrevented;
            Object.defineProperty(this, "isDefaultPrevented", {
              configurable: true,
              value: function (this: ReactKeyboardEvent<HTMLElement>) {
                const prevented = Reflect.apply(retainedQuery, this, []);
                if (!failureApplied) {
                  failureApplied = true;
                  if (failure === "cancellation-query mutation") {
                    parent.removeChild(destination);
                    parent.insertBefore(destination, next);
                  } else {
                    complete(this);
                  }
                }
                return prevented;
              },
            });
          },
        });
        source.focus();
        focus.mockClear();
        rejected = menuKey(source, "ArrowRight");

        act(() => {
          source.dispatchEvent(rejected!);
        });

        expect(rejected.defaultPrevented).toBe(true);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        Object.defineProperty(
          prototype,
          "preventDefault",
          preventDefaultDescriptor,
        );
        await nextTask();
        const cleanSource = statusControls()[2]!;
        const cleanDestination = statusControls()[3]!;
        cleanSource.focus();
        focus.mockClear();
        const clean = menuKey(cleanSource, "ArrowRight");
        act(() => {
          cleanSource.dispatchEvent(clean);
        });
        expect(clean.defaultPrevented).toBe(true);
        expect(cleanDestination).toHaveFocus();
        expect(focus).toHaveBeenCalledOnce();
        expect(failure === "prevent-method drift" || failureApplied).toBe(true);
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        if (prototype && preventDefaultDescriptor) {
          Object.defineProperty(
            prototype,
            "preventDefault",
            preventDefaultDescriptor,
          );
        }
        focus.mockRestore();
      }
    },
  );

  it("retires a post-claim pre-effect failure, rejects replay, and recovers", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const documentPrototype = Document.prototype;
    const activeElementDescriptor = Object.getOwnPropertyDescriptor(
      documentPrototype,
      "activeElement",
    );
    if (!activeElementDescriptor?.get)
      throw new Error("Document activeElement getter was unavailable");
    const readActiveElement = activeElementDescriptor.get;
    let armed = false;
    let failed = false;
    let reads = 0;
    Object.defineProperty(documentPrototype, "activeElement", {
      ...activeElementDescriptor,
      get: function (this: Document) {
        const active = Reflect.apply(readActiveElement, this, []);
        if (armed) {
          reads += 1;
          if (reads === 5) {
            failed = true;
            return this.body;
          }
        }
        return active;
      },
    });
    try {
      await renderStatus(statusProps(current));
      const source = statusControls()[2]!;
      source.focus();
      focus.mockClear();
      armed = true;
      const rejected = menuKey(source, "ArrowRight");

      act(() => {
        source.dispatchEvent(rejected);
      });

      armed = false;
      expect(failed).toBe(true);
      expect(rejected.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      await nextTask();
      focus.mockClear();
      act(() => {
        source.dispatchEvent(rejected);
      });
      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      const cleanSource = statusControls()[2]!;
      const cleanDestination = statusControls()[3]!;
      cleanSource.focus();
      focus.mockClear();
      const clean = menuKey(cleanSource, "ArrowRight");
      act(() => {
        cleanSource.dispatchEvent(clean);
      });
      expect(clean.defaultPrevented).toBe(true);
      expect(cleanDestination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      Object.defineProperty(
        documentPrototype,
        "activeElement",
        activeElementDescriptor,
      );
      focus.mockRestore();
    }
  });

  it("covers every accepted desktop source and destination in committed order", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current));
    const cases: [number, number, "ArrowLeft" | "ArrowRight" | "Home" | "End"][] = [];
    for (let index = 0; index < 5; index++) {
      cases.push([index, index + 1, "ArrowRight"]);
      cases.push([index + 1, index, "ArrowLeft"]);
      cases.push([index, 5, "End"]);
      cases.push([index + 1, 0, "Home"]);
    }

    for (const [from, to, key] of cases) {
      const controls = statusControls();
      const source = controls[from]!;
      const destination = controls[to]!;
      source.focus();
      const event = menuKey(source, key);
      await act(async () => {
        source.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
    }

    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(controlled.themeSetter).not.toHaveBeenCalled();
    expect(screen.getByTestId("layout-menu")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("uses compact visual order and accepts all four semantic keypad mappings", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current, { compact: true, layout: "code" }));
    const cases = [
      [2, 1, "ArrowLeft", "Numpad4"],
      [0, 1, "ArrowRight", "Numpad6"],
      [2, 0, "Home", "Numpad7"],
      [0, 2, "End", "Numpad1"],
    ] as const;

    for (const [from, to, key, code] of cases) {
      const controls = statusControls(true);
      const source = controls[from]!;
      const destination = controls[to]!;
      source.focus();
      const event = menuKey(source, key, {
        code,
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });
      await act(async () => {
        source.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
    }

    expect(statusControls(true).map((control) => control.dataset.testid)).toEqual([
      "stats-button",
      "storage-indicator",
      "layout-menu",
    ]);
    expect(screen.queryByTestId("issues-button")).toBeNull();
    expect(screen.queryByTestId("theme-toggle")).toBeNull();
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("keeps bounded edges and non-navigation keys unprevented and inert", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current));
    const controls = statusControls();
    const cases = [
      [controls[0]!, "ArrowLeft"],
      [controls[0]!, "Home"],
      [controls.at(-1)!, "ArrowRight"],
      [controls.at(-1)!, "End"],
      [controls[3]!, "ArrowUp"],
      [controls[3]!, "ArrowDown"],
      [controls[3]!, "Tab"],
      [controls[3]!, "Enter"],
      [controls[3]!, " "],
    ] as const;

    for (const [source, key] of cases) {
      source.focus();
      const event = menuKey(source, key);
      act(() => {
        source.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
    }

    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(controlled.themeSetter).not.toHaveBeenCalled();
  });

  it.each(["disabled", "hidden"] as const)(
    "skips an initially %s theme control",
    async (state) => {
      useExactWindowListenerRealm();
      controlled.themeDisabled = state === "disabled";
      controlled.themeHidden = state === "hidden";
      const current = callbacks();
      await renderStatus(statusProps(current));
      const controls = statusControls();
      const storage = controls[3]!;
      const shortcuts = controls[5]!;
      storage.focus();
      const event = menuKey(storage, "ArrowRight");

      act(() => {
        storage.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(shortcuts).toHaveFocus();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );

  it("skips disabled compact storage and does not publish absent desktop controls", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current, {
      compact: true,
      layout: "code",
      onStorage: undefined,
    }));
    const stats = screen.getByTestId("stats-button");
    const menu = screen.getByTestId("layout-menu");
    expect(screen.getByTestId("storage-indicator")).toBeDisabled();
    stats.focus();
    const event = menuKey(stats, "ArrowRight");

    act(() => {
      stats.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(menu).toHaveFocus();
    expect(screen.queryByTestId("issues-button")).toBeNull();
    expect(screen.queryByTestId("theme-toggle")).toBeNull();
    expect(document.querySelector('[aria-label="Help and shortcuts"]')).toBeNull();
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("fails navigation closed for an inexact child trigger without disabling existing controls", async () => {
    useExactWindowListenerRealm();
    controlled.themeContract = false;
    const current = callbacks();
    await renderStatus(statusProps(current));
    const source = screen.getByTestId("issues-button");
    source.focus();
    const event = menuKey(source, "ArrowRight");

    act(() => {
      source.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("rejects modifiers, repeat, composition, cancellation, wrong focus, and lookalike views before recovering", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      await renderStatus(statusProps(current));
      const source = statusControls()[2]!;
      const destination = statusControls()[3]!;
      const reject = (event: KeyboardEvent) => {
        focus.mockClear();
        act(() => {
          source.dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
      };
      for (const init of [
        { ctrlKey: true },
        { altKey: true },
        { metaKey: true },
        { shiftKey: true },
        { repeat: true },
        { isComposing: true },
        { cancelable: false },
        { bubbles: false },
      ] satisfies KeyboardEventInit[]) {
        source.focus();
        reject(menuKey(source, "ArrowRight", init));
      }
      destination.focus();
      reject(menuKey(source, "ArrowRight"));
      source.focus();
      const canceled = menuKey(source, "ArrowRight");
      canceled.preventDefault();
      focus.mockClear();
      act(() => {
        source.dispatchEvent(canceled);
      });
      expect(canceled.defaultPrevented).toBe(true);
      expect(focus).not.toHaveBeenCalled();
      const lookalike: Record<string, unknown> = {
        document: source.ownerDocument,
      };
      lookalike.window = lookalike;
      const crossed = menuKey(source, "ArrowRight");
      Object.defineProperty(crossed, "view", {
        configurable: true,
        value: lookalike,
      });
      reject(crossed);

      source.focus();
      focus.mockClear();
      const clean = menuKey(source, "ArrowRight");
      act(() => {
        source.dispatchEvent(clean);
      });
      expect(clean.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      focus.mockRestore();
    }
  });

  it("rejects DOM reorder and restore history, then accepts a clean successor", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current));
    const root = screen.getByTestId("status-bar");
    const controls = statusControls();
    const source = controls[2]!;
    const destination = controls[3]!;
    const next = destination.nextSibling;
    root.insertBefore(destination, source);
    root.insertBefore(destination, next);
    source.focus();
    const stale = menuKey(source, "ArrowRight");

    act(() => {
      source.dispatchEvent(stale);
    });

    expect(stale.defaultPrevented).toBe(false);
    expect(source).toHaveFocus();
    await nextTask();
    const currentSource = statusControls()[2]!;
    const currentDestination = statusControls()[3]!;
    currentSource.focus();
    const clean = menuKey(currentSource, "ArrowRight");
    act(() => {
      currentSource.dispatchEvent(clean);
    });
    expect(clean.defaultPrevented).toBe(true);
    expect(currentDestination).toHaveFocus();
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("claims replay once and removes navigation listeners on cleanup", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      const view = await renderStatus(statusProps(current));
      const source = statusControls()[1]!;
      const destination = statusControls()[2]!;
      source.focus();
      focus.mockClear();
      const event = menuKey(source, "ArrowRight");
      act(() => {
        source.dispatchEvent(event);
        source.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();

      await act(async () => {
        await Promise.resolve();
      });
      const pendingSource = statusControls()[1]!;
      pendingSource.focus();
      focus.mockClear();
      pendingSource.addEventListener("keydown", (pending) => {
        pending.stopPropagation();
      }, { capture: true, once: true });
      const pending = menuKey(pendingSource, "ArrowRight");
      act(() => {
        pendingSource.dispatchEvent(pending);
      });
      expect(pending.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();

      await act(async () => {
        view.root.unmount();
        await Promise.resolve();
      });
      view.host.remove();
      directViews.splice(directViews.indexOf(view), 1);
      focus.mockClear();
      act(() => {
        pendingSource.dispatchEvent(pending);
      });
      expect(pending.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      const afterCleanup = menuKey(source, "ArrowLeft");
      act(() => {
        source.dispatchEvent(afterCleanup);
      });
      expect(afterCleanup.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);

      await renderStatus(statusProps(current));
      const cleanSource = statusControls()[1]!;
      const cleanDestination = statusControls()[2]!;
      cleanSource.focus();
      focus.mockClear();
      const clean = menuKey(cleanSource, "ArrowRight");
      act(() => {
        cleanSource.dispatchEvent(clean);
      });
      expect(clean.defaultPrevented).toBe(true);
      expect(cleanDestination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      focus.mockRestore();
    }
  });
});

describe("status bar directional menu authority", () => {
  beforeEach(useExactWindowListenerRealm);

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "rejects untrusted, modified, repeated, composing, malformed, unfocused, and crossed %s input",
    async (key) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      try {
        const current = callbacks();
        await renderStatus(statusProps(current));
        const trigger = screen.getByTestId("layout-menu");
        const child = trigger.querySelector<HTMLElement>("span");
        if (!child) throw new Error("Menu trigger child was not rendered");
        const reject = async (
          event: KeyboardEvent,
          target: HTMLElement = trigger,
          expectedPrevented = false,
        ) => {
          focus.mockClear();
          await act(async () => {
            target.dispatchEvent(event);
            await Promise.resolve();
          });
          expect(event.defaultPrevented).toBe(expectedPrevented);
          expect(trigger).toHaveAttribute("aria-expanded", "false");
          expect(focus).not.toHaveBeenCalled();
          expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
          expect(controlled.themeSetter).not.toHaveBeenCalled();
        };

        trigger.focus();
        await reject(menuKey(trigger, key, {}, false));
        for (const init of [
          { ctrlKey: true },
          { altKey: true },
          { metaKey: true },
          { shiftKey: true },
          { repeat: true },
          { isComposing: true },
          { cancelable: false },
          { bubbles: false },
        ] satisfies KeyboardEventInit[]) {
          trigger.focus();
          await reject(menuKey(trigger, key, init));
        }

        trigger.focus();
        await reject(menuKey(child, key), child);

        desktopShortcuts().focus();
        await reject(menuKey(trigger, key));

        trigger.focus();
        const prevented = menuKey(trigger, key);
        prevented.preventDefault();
        await reject(prevented, trigger, true);
        expect(
          preventDefault.mock.contexts.filter((context) => context === prevented),
        ).toHaveLength(1);

        const valid = menuKey(trigger, key);
        trigger.focus();
        focus.mockClear();
        await act(async () => {
          trigger.dispatchEvent(valid);
          await Promise.resolve();
        });
        await expectFocusedMenuItem(
          trigger,
          key === "ArrowDown"
            ? '[role="menuitemradio"]'
            : '[role="menuitemcheckbox"]',
          key === "ArrowDown" ? "Code and preview" : "Sync scrolling",
        );
        expect(
          preventDefault.mock.contexts.filter((context) => context === valid),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it("rejects a self-window-shaped public view and accepts a distinct exact-view successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    try {
      const current = callbacks();
      await renderStatus(statusProps(current));
      const trigger = screen.getByTestId("layout-menu");
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const lookalike: Record<string, unknown> = {
        document: trigger.ownerDocument,
      };
      lookalike.window = lookalike;
      const crossed = menuKey(trigger, "ArrowDown");
      const intrinsicView = Object.getOwnPropertyDescriptor(
        window.UIEvent.prototype,
        "view",
      )?.get;
      if (!intrinsicView)
        throw new Error("Owner-realm UIEvent view getter was unavailable");
      const nativeView = intrinsicView.call(crossed);
      Object.defineProperty(crossed, "view", {
        configurable: true,
        value: lookalike,
      });

      await act(async () => {
        trigger.dispatchEvent(crossed);
        await Promise.resolve();
      });

      expect(intrinsicView.call(crossed)).toBe(nativeView);
      expect(crossed.view).toBe(lookalike);
      expect(crossed.defaultPrevented).toBe(false);
      expect(
        preventDefault.mock.contexts.filter((context) => context === crossed),
      ).toHaveLength(0);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(focus).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      expect(controlled.themeSetter).not.toHaveBeenCalled();

      const successor = menuKey(trigger, "ArrowDown");
      await act(async () => {
        trigger.dispatchEvent(successor);
        await Promise.resolve();
      });

      await expectFocusedMenuItem(
        trigger,
        '[role="menuitemradio"]',
        "Code and preview",
      );
      expect(
        preventDefault.mock.contexts.filter((context) => context === successor),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledOnce();
      expect(scroll).not.toHaveBeenCalled();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      focus.mockRestore();
      preventDefault.mockRestore();
      scroll.mockRestore();
    }
  });

  it.each([
    ["keyboard getter", () => {
      const prototype = window.KeyboardEvent.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "key");
      if (!descriptor?.get)
        throw new Error("KeyboardEvent key getter was unavailable");
      Object.defineProperty(prototype, "key", {
        ...descriptor,
        get(this: KeyboardEvent) {
          return Reflect.apply(descriptor.get!, this, []);
        },
      });
      return () => Object.defineProperty(prototype, "key", descriptor);
    }],
    ["focus method", () => {
      const prototype = window.HTMLElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "focus");
      if (typeof descriptor?.value !== "function")
        throw new Error("HTMLElement focus method was unavailable");
      Object.defineProperty(prototype, "focus", {
        ...descriptor,
        value(this: HTMLElement, options?: FocusOptions) {
          return Reflect.apply(descriptor.value, this, [options]);
        },
      });
      return () => Object.defineProperty(prototype, "focus", descriptor);
    }],
  ] as const)(
    "latches restored %s history before Arrow input and recovers only after a clean remount",
    async (_name, replace) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      let restore: (() => void) | null = null;
      try {
        const current = callbacks();
        const props = statusProps(current);
        const view = await renderStatus(props);
        const trigger = screen.getByTestId("layout-menu");
        trigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        restore = replace();
        const historyProbe = menuKey(trigger, "F1");
        await act(async () => {
          trigger.dispatchEvent(historyProbe);
          await Promise.resolve();
        });
        restore();
        restore = null;
        focus.mockClear();
        preventDefault.mockClear();
        scroll.mockClear();

        const rejected = menuKey(trigger, "ArrowDown");
        await act(async () => {
          trigger.dispatchEvent(rejected);
          await Promise.resolve();
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(
          preventDefault.mock.contexts.filter((context) => context === rejected),
        ).toHaveLength(0);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(focus).not.toHaveBeenCalled();
        expect(scroll).not.toHaveBeenCalled();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
        expect(controlled.themeSetter).not.toHaveBeenCalled();

        await rerenderStatus(view, props, `clean-${_name}`);
        const currentTrigger = screen.getByTestId("layout-menu");
        currentTrigger.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const successor = menuKey(currentTrigger, "ArrowDown");
        await act(async () => {
          currentTrigger.dispatchEvent(successor);
          await Promise.resolve();
        });

        await expectFocusedMenuItem(
          currentTrigger,
          '[role="menuitemradio"]',
          "Code and preview",
        );
        expect(
          preventDefault.mock.contexts.filter(
            (context) => context === successor,
          ),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
        expect(scroll).not.toHaveBeenCalled();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        restore?.();
        focus.mockRestore();
        preventDefault.mockRestore();
        scroll.mockRestore();
      }
    },
  );

  it("claims one native and React pair before reentry, rejects replay, and accepts a distinct successor", async () => {
    const nativePreventDefault = Event.prototype.preventDefault;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    try {
      const current = callbacks();
      await renderStatus(statusProps(current));
      const trigger = screen.getByTestId("layout-menu");
      trigger.focus();
      focus.mockClear();
      const accepted = menuKey(trigger, "ArrowDown");
      const crossed = menuKey(trigger, "ArrowUp");
      preventDefault.mockImplementation(function (this: Event) {
        nativePreventDefault.call(this);
        if (this === accepted)
          trigger.dispatchEvent(crossed);
      });

      await act(async () => {
        trigger.dispatchEvent(accepted);
        await Promise.resolve();
      });

      await expectFocusedMenuItem(
        trigger,
        '[role="menuitemradio"]',
        "Code and preview",
      );
      expect(
        preventDefault.mock.contexts.filter((context) => context === accepted),
      ).toHaveLength(1);
      expect(
        preventDefault.mock.contexts.filter((context) => context === crossed),
      ).toHaveLength(0);
      expect(focus).toHaveBeenCalledOnce();

      fireEvent.keyDown(screen.getByTestId("status-menu-content"), {
        key: "Escape",
      });
      await nextTask();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      focus.mockClear();
      const acceptedCalls = preventDefault.mock.contexts.filter(
        (context) => context === accepted,
      ).length;
      await act(async () => {
        trigger.dispatchEvent(accepted);
        await Promise.resolve();
      });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(
        preventDefault.mock.contexts.filter((context) => context === accepted),
      ).toHaveLength(acceptedCalls);
      expect(focus).not.toHaveBeenCalled();

      const successor = menuKey(trigger, "ArrowUp");
      trigger.focus();
      focus.mockClear();
      await act(async () => {
        trigger.dispatchEvent(successor);
        await Promise.resolve();
      });
      await expectFocusedMenuItem(
        trigger,
        '[role="menuitemcheckbox"]',
        "Sync scrolling",
      );
      expect(
        preventDefault.mock.contexts.filter((context) => context === successor),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledOnce();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it.each([
    ["document fact drift", (props: StatusBarProps) => {
      props.doc.repoPath = "MUTATED.md";
      return () => {
        props.doc.repoPath = "README.md";
      };
    }],
    ["trigger mutation and restore", () => {
      const trigger = screen.getByTestId("layout-menu");
      const className = trigger.className;
      trigger.className = `${className} altered`;
      trigger.className = className;
      return () => {};
    }],
    ["trigger detach and reinsert", () => {
      const trigger = screen.getByTestId("layout-menu");
      const parent = trigger.parentNode;
      if (!parent) throw new Error("Menu trigger parent was unavailable");
      trigger.remove();
      parent.append(trigger);
      return () => {};
    }],
  ] as const)(
    "rejects %s without directional work and recovers through a complete current publication",
    async (_name, mutate) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const stopPropagation = vi.spyOn(Event.prototype, "stopPropagation");
      const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      try {
        const current = callbacks();
        const props = statusProps(current);
        await renderStatus(props);
        const trigger = screen.getByTestId("layout-menu");
        trigger.focus();
        focus.mockClear();
        const restore = mutate(props);
        const rejected = menuKey(trigger, "ArrowDown");

        await act(async () => {
          trigger.dispatchEvent(rejected);
          restore();
          await Promise.resolve();
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(
          preventDefault.mock.contexts.filter((context) => context === rejected),
        ).toHaveLength(0);
        expect(
          stopPropagation.mock.contexts.filter(
            (context) => context === rejected,
          ),
        ).toHaveLength(1);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(focus).not.toHaveBeenCalled();
        expect(scroll).not.toHaveBeenCalled();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);

        await act(async () => {
          await Promise.resolve();
        });
        const currentTrigger = screen.getByTestId("layout-menu");
        currentTrigger.focus();
        focus.mockClear();
        const successor = menuKey(currentTrigger, "ArrowDown");
        await act(async () => {
          currentTrigger.dispatchEvent(successor);
          await Promise.resolve();
        });
        await expectFocusedMenuItem(
          currentTrigger,
          '[role="menuitemradio"]',
          "Code and preview",
        );
        expect(focus).toHaveBeenCalledOnce();
        expect(scroll).not.toHaveBeenCalled();
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
        stopPropagation.mockRestore();
        scroll.mockRestore();
      }
    },
  );

  it("does not use retired propagation proof after a wrapper method is crossed", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const firstStop = vi.fn();
    const crossedStop = vi.fn();
    let stopBeforeReact: ((event: Event) => void) | null = null;
    try {
      const current = callbacks();
      const props = statusProps(current);
      await renderStatus(props);
      const trigger = screen.getByTestId("layout-menu");
      const stale = captureKey(trigger);
      trigger.focus();
      focus.mockClear();
      preventDefault.mockClear();
      props.doc.repoPath = "MUTATED.md";
      const nativeEvent = menuKey(trigger, "ArrowDown");
      let stopReads = 0;
      const wrapper = {
        nativeEvent,
        currentTarget: trigger,
        target: trigger,
        type: "keydown",
        key: "ArrowDown",
        eventPhase: Event.CAPTURING_PHASE,
        defaultPrevented: false,
        isPropagationStopped: () => false,
        get stopPropagation() {
          stopReads += 1;
          return stopReads <= 2 ? firstStop : crossedStop;
        },
      } as unknown as ReactKeyboardEvent<HTMLElement>;
      stopBeforeReact = (event) => {
        event.stopPropagation();
        Object.defineProperty(event, "code", {
          configurable: true,
          value: "Crossed",
        });
        stale.keyDown(wrapper);
      };
      window.addEventListener("keydown", stopBeforeReact, true);

      await act(async () => {
        trigger.dispatchEvent(nativeEvent);
        props.doc.repoPath = "README.md";
        await Promise.resolve();
      });

      expect(nativeEvent.defaultPrevented).toBe(false);
      expect(
        preventDefault.mock.contexts.filter(
          (context) => context === nativeEvent,
        ),
      ).toHaveLength(0);
      expect(firstStop).not.toHaveBeenCalled();
      expect(crossedStop).not.toHaveBeenCalled();
      expect(screen.getByTestId("layout-menu")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(focus).not.toHaveBeenCalled();
      expect(scroll).not.toHaveBeenCalled();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      expect(controlled.themeSetter).not.toHaveBeenCalled();
    } finally {
      if (stopBeforeReact)
        window.removeEventListener("keydown", stopBeforeReact, true);
      focus.mockRestore();
      preventDefault.mockRestore();
      scroll.mockRestore();
    }
  });

  it("rejects fabricated and stale key handlers without preventing or opening", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    const oldTrigger = screen.getByTestId("layout-menu");
    const stale = captureKey(oldTrigger);

    await rerenderStatus(view, props, "replacement");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    stale.keyDown({
      nativeEvent: menuKey(oldTrigger, "ArrowDown"),
      currentTarget: oldTrigger,
      target: oldTrigger,
      type: "keydown",
      key: "ArrowDown",
      code: "ArrowDown",
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      eventPhase: Event.CAPTURING_PHASE,
      isTrusted: true,
      view: window,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
      stopPropagation,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
    } as unknown as ReactKeyboardEvent<HTMLElement>);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.getByTestId("layout-menu")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("status bar directional issues authority", () => {
  beforeEach(useExactWindowListenerRealm);

  it.each([
    [[ISSUE_A], "ArrowDown", ISSUE_A],
    [[ISSUE_A], "ArrowUp", ISSUE_A],
    [[ISSUE_A, ISSUE_OTHER], "ArrowDown", ISSUE_A],
    [[ISSUE_A, ISSUE_OTHER], "ArrowUp", ISSUE_OTHER],
  ] as const)(
    "opens ordered issues with %s and focuses the %s destination once without selection, document work, or scroll",
    async (issues, key, expectedIssue) => {
      controlled.issues = [...issues];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const scrollIntoView = vi.fn();
      const originalScrollIntoView = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "scrollIntoView",
      );
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
        writable: true,
      });
      try {
        const current = callbacks();
        const props = statusProps(current);
        await renderStatus(props);
        const trigger = screen.getByTestId("issues-button");
        trigger.focus();
        focus.mockClear();
        const documentState = {
          source: props.session.ytext.toString(),
          version: props.session.version,
        };
        const scrollPosition = {
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        };
        const event = menuKey(trigger, key);

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        await expectFocusedIssueRow(trigger, expectedIssue);
        expect(
          preventDefault.mock.contexts.filter((context) => context === event),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(screen.getAllByTestId("status-issues-content")).toHaveLength(1);
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
        expect(props.session.ytext.toString()).toBe(documentState.source);
        expect(props.session.version).toBe(documentState.version);
        expect(documentScroll).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect({
          bodyLeft: document.body.scrollLeft,
          bodyTop: document.body.scrollTop,
          documentLeft: document.documentElement.scrollLeft,
          documentTop: document.documentElement.scrollTop,
          x: window.scrollX,
          y: window.scrollY,
        }).toEqual(scrollPosition);
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
        documentScroll.mockRestore();
        if (originalScrollIntoView) {
          Object.defineProperty(
            HTMLElement.prototype,
            "scrollIntoView",
            originalScrollIntoView,
          );
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
        }
      }
    },
  );

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "keeps no-issues %s input inert",
    async (key) => {
      controlled.issues = [];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      try {
        const current = callbacks();
        await renderStatus(statusProps(current));
        const trigger = screen.getByTestId("issues-button");
        trigger.focus();
        focus.mockClear();
        const event = menuKey(trigger, key);

        await act(async () => {
          trigger.dispatchEvent(event);
          await Promise.resolve();
        });

        expect(event.defaultPrevented).toBe(false);
        expect(
          preventDefault.mock.contexts.filter((context) => context === event),
        ).toHaveLength(0);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByTestId("status-issues-content")).toBeNull();
        expect(focus).not.toHaveBeenCalled();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it.each(["ArrowDown", "ArrowUp"] as const)(
    "rejects untrusted, modified, repeated, composing, malformed, unfocused, canceled, and crossed %s input before work",
    async (key) => {
      controlled.issues = [ISSUE_A, ISSUE_OTHER];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      try {
        const current = callbacks();
        await renderStatus(statusProps(current));
        const trigger = screen.getByTestId("issues-button");
        const child = trigger.querySelector<HTMLElement>("svg");
        if (!child) throw new Error("Issues trigger child was not rendered");
        const reject = async (
          event: KeyboardEvent,
          target: HTMLElement = trigger,
          expectedPrevented = false,
        ) => {
          focus.mockClear();
          await act(async () => {
            target.dispatchEvent(event);
            await Promise.resolve();
          });
          expect(event.defaultPrevented).toBe(expectedPrevented);
          expect(trigger).toHaveAttribute("aria-expanded", "false");
          expect(screen.queryByTestId("status-issues-content")).toBeNull();
          expect(focus).not.toHaveBeenCalled();
          expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
        };

        trigger.focus();
        await reject(menuKey(trigger, key, {}, false));
        for (const init of [
          { ctrlKey: true },
          { altKey: true },
          { metaKey: true },
          { shiftKey: true },
          { repeat: true },
          { isComposing: true },
          { cancelable: false },
          { bubbles: false },
        ] satisfies KeyboardEventInit[]) {
          trigger.focus();
          await reject(menuKey(trigger, key, init));
        }

        trigger.focus();
        await reject(menuKey(child, key), child);
        desktopShortcuts().focus();
        await reject(menuKey(trigger, key));

        trigger.focus();
        const canceled = menuKey(trigger, key);
        canceled.preventDefault();
        await reject(canceled, trigger, true);

        const valid = menuKey(trigger, key);
        trigger.focus();
        focus.mockClear();
        await act(async () => {
          trigger.dispatchEvent(valid);
          await Promise.resolve();
        });
        await expectFocusedIssueRow(
          trigger,
          key === "ArrowDown" ? ISSUE_A : ISSUE_OTHER,
        );
        expect(
          preventDefault.mock.contexts.filter((context) => context === valid),
        ).toHaveLength(1);
        expect(focus).toHaveBeenCalledOnce();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
      }
    },
  );

  it("claims one exact native and React pair, rejects replay and stale handlers, and accepts a clean successor", async () => {
    controlled.issues = [ISSUE_A, ISSUE_OTHER];
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    try {
      const current = callbacks();
      const props = statusProps(current);
      const view = await renderStatus(props);
      const trigger = screen.getByTestId("issues-button");
      const stale = captureKey(trigger);
      trigger.focus();
      focus.mockClear();
      const accepted = menuKey(trigger, "ArrowDown");

      await act(async () => {
        trigger.dispatchEvent(accepted);
        await Promise.resolve();
      });

      await expectFocusedIssueRow(trigger, ISSUE_A);
      expect(
        preventDefault.mock.contexts.filter((context) => context === accepted),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledOnce();
      fireEvent.keyDown(screen.getByTestId("status-issues-content"), {
        key: "Escape",
      });
      await nextTask();
      expect(trigger).toHaveAttribute("aria-expanded", "false");

      focus.mockClear();
      const acceptedCalls = preventDefault.mock.contexts.filter(
        (context) => context === accepted,
      ).length;
      await act(async () => {
        trigger.dispatchEvent(accepted);
        await Promise.resolve();
      });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(
        preventDefault.mock.contexts.filter((context) => context === accepted),
      ).toHaveLength(acceptedCalls);
      expect(focus).not.toHaveBeenCalled();

      await rerenderStatus(view, props, "issues-replacement");
      const preventFabricated = vi.fn();
      stale.keyDown({
        ...fabricatedClick(trigger).event,
        nativeEvent: menuKey(trigger, "ArrowUp"),
        type: "keydown",
        key: "ArrowUp",
        code: "ArrowUp",
        eventPhase: Event.CAPTURING_PHASE,
        isTrusted: true,
        view: window,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        preventDefault: preventFabricated,
      } as unknown as ReactKeyboardEvent<HTMLElement>);
      expect(preventFabricated).not.toHaveBeenCalled();
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );

      const successorTrigger = screen.getByTestId("issues-button");
      successorTrigger.focus();
      focus.mockClear();
      const successor = menuKey(successorTrigger, "ArrowUp");
      await act(async () => {
        successorTrigger.dispatchEvent(successor);
        await Promise.resolve();
      });
      await expectFocusedIssueRow(successorTrigger, ISSUE_OTHER);
      expect(
        preventDefault.mock.contexts.filter((context) => context === successor),
      ).toHaveLength(1);
      expect(focus).toHaveBeenCalledOnce();
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      focus.mockRestore();
      preventDefault.mockRestore();
    }
  });

  it.each([
    ["trigger attributes", () => {
      const trigger = screen.getByTestId("issues-button");
      const className = trigger.className;
      trigger.className = `${className} altered`;
      trigger.className = className;
    }],
    ["trigger placement in the DOM", () => {
      const trigger = screen.getByTestId("issues-button");
      const parent = trigger.parentNode;
      if (!parent) throw new Error("Issues trigger parent was unavailable");
      trigger.remove();
      parent.append(trigger);
    }],
  ] as const)(
    "latches restored %s history without prevention and recovers through a complete successor",
    async (_name, mutate) => {
      controlled.issues = [ISSUE_A, ISSUE_OTHER];
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      try {
        const current = callbacks();
        await renderStatus(statusProps(current));
        const trigger = screen.getByTestId("issues-button");
        trigger.focus();
        focus.mockClear();
        mutate();
        const rejected = menuKey(trigger, "ArrowDown");

        await act(async () => {
          trigger.dispatchEvent(rejected);
          await Promise.resolve();
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(
          preventDefault.mock.contexts.filter((context) => context === rejected),
        ).toHaveLength(0);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(focus).not.toHaveBeenCalled();
        expect(scroll).not.toHaveBeenCalled();
        expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);

        await act(async () => {
          await Promise.resolve();
        });
        const currentTrigger = screen.getByTestId("issues-button");
        currentTrigger.focus();
        focus.mockClear();
        const successor = menuKey(currentTrigger, "ArrowDown");
        await act(async () => {
          currentTrigger.dispatchEvent(successor);
          await Promise.resolve();
        });
        await expectFocusedIssueRow(currentTrigger, ISSUE_A);
        expect(focus).toHaveBeenCalledOnce();
        expect(scroll).not.toHaveBeenCalled();
      } finally {
        focus.mockRestore();
        preventDefault.mockRestore();
        scroll.mockRestore();
      }
    },
  );

  it("retires reordered issue-row history, cleans up completely, and retains pointer, activation, Escape, and trigger activation", async () => {
    controlled.issues = [ISSUE_A, ISSUE_OTHER];
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    openIssues();
    const content = screen.getByTestId("status-issues-content");
    const list = content.querySelector("ul");
    const first = list?.firstElementChild;
    const second = list?.lastElementChild;
    if (!list || !first || !second)
      throw new Error("Ordered issue rows were not rendered");
    list.append(first);
    list.insertBefore(first, second);
    fireEvent.click(elementWithText("button", ISSUE_A.message));
    expect(current.issue).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "clean-issues");
    const cleanTrigger = screen.getByTestId("issues-button");
    for (const key of ["Enter", " "] as const) {
      cleanTrigger.focus();
      const event = menuKey(cleanTrigger, key);
      fireEvent(cleanTrigger, event);
      expect(event.defaultPrevented).toBe(false);
      fireEvent.click(cleanTrigger);
      expect(cleanTrigger).toHaveAttribute("aria-expanded", "true");
      const row = elementWithText("button", ISSUE_A.message);
      fireEvent.click(row);
      expect(current.issue).toHaveBeenCalledWith(ISSUE_A);
      fireEvent.keyDown(screen.getByTestId("status-issues-content"), {
        key: "Escape",
      });
      await nextTask();
      expect(cleanTrigger).toHaveAttribute("aria-expanded", "false");
      expect(cleanTrigger).toHaveFocus();
    }
    fireEvent.click(cleanTrigger);
    expect(cleanTrigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(elementWithText("button", ISSUE_OTHER.message));
    expect(current.issue).toHaveBeenLastCalledWith(ISSUE_OTHER);
    closeIssues();
    expect(current.issue).toHaveBeenCalledTimes(3);

    const stale = captureKey(cleanTrigger);
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
    directViews.splice(directViews.indexOf(view), 1);
    view.host.remove();
    const preventDefault = vi.fn();
    stale.keyDown({
      ...fabricatedClick(cleanTrigger).event,
      nativeEvent: menuKey(cleanTrigger, "ArrowDown"),
      type: "keydown",
      key: "ArrowDown",
      code: "ArrowDown",
      eventPhase: Event.CAPTURING_PHASE,
      isTrusted: true,
      view: window,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      preventDefault,
    } as unknown as ReactKeyboardEvent<HTMLElement>);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByTestId("status-issues-content")).toBeNull();
    expect(screen.queryByTestId("issues-button")).toBeNull();

    await renderStatus(props, "clean-successor");
    const successorTrigger = screen.getByTestId("issues-button");
    successorTrigger.focus();
    await act(async () => {
      successorTrigger.dispatchEvent(menuKey(successorTrigger, "ArrowUp"));
      await Promise.resolve();
    });
    await expectFocusedIssueRow(successorTrigger, ISSUE_OTHER);
  });
});

describe("status bar nested StatsPopover reconciliation", () => {
  it("keeps current controls usable after an Escape statistics close", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    const stats = screen.getByTestId("stats-button");

    expect(screen.getByTestId("word-count")).toHaveTextContent("2 words");
    fireEvent.click(stats);
    const content = screen.getByTestId("stats-popover");
    expect(content).toBeInTheDocument();
    fireEvent.keyDown(content, {
      code: "Escape",
      key: "Escape",
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("stats-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("preserves outer controls through local statistics form updates", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    const stats = screen.getByTestId("stats-button");
    fireEvent.click(stats);
    const content = screen.getByTestId("stats-popover");

    fireEvent.input(screen.getByTestId("goal-value"), {
      target: { value: "250" },
    });
    expect(screen.getByTestId("goal-set")).toBeEnabled();
    fireEvent.keyDown(content, { code: "Escape", key: "Escape" });
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("reconciles an already-open placement transition after an outer replay", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    fireEvent.click(screen.getByTestId("stats-button"));
    const openContent = screen.getByTestId("stats-popover");
    expect(openContent).toBeInTheDocument();
    act(() => openContent.setAttribute("data-side", "top"));

    await rerenderStatus(view, {
      ...props,
      doc: {
        ...props.doc,
        title: "Updated while statistics stay open",
      },
    });
    act(() => {
      screen.getByTestId("stats-button").setAttribute(
        "data-radix-popper-side",
        "top",
      );
    });
    await act(async () => Promise.resolve());
    const content = screen.getByTestId("stats-popover");
    fireEvent.keyDown(content, { code: "Escape", key: "Escape" });
    await act(async () => Promise.resolve());
    expect(screen.queryByTestId("stats-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("accepts the split Escape close emitted by the browser", async () => {
    useExactWindowListenerRealm();
    const current = callbacks();
    await renderStatus(statusProps(current));
    const trigger = screen.getByTestId("stats-button");
    fireEvent.click(trigger);
    const content = screen.getByTestId("stats-popover");
    const portal = content.parentElement;
    if (!portal) throw new Error("Statistics portal wrapper missing");

    const splitClose = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
      trigger.setAttribute("data-state", "closed");
      trigger.dispatchEvent(new FocusEvent("focusin", {
        bubbles: true,
        composed: true,
      }));
      trigger.removeAttribute("data-radix-popper-side");
      trigger.removeAttribute("data-radix-popper-align");
      portal.remove();
    };
    window.addEventListener("keydown", splitClose, { capture: true, once: true });

    fireEvent.keyDown(content, { code: "Escape", key: "Escape" });
    await act(async () => Promise.resolve());
    expect(screen.queryByTestId("stats-popover")).toBeNull();

    try {
      fireEvent.click(screen.getByTestId("storage-indicator"));
      expect(current.storage).toHaveBeenCalledOnce();
    } finally {
      if (!portal.isConnected) document.body.append(portal);
    }
  });

  it("keeps current controls usable after an asynchronous statistics placement flip", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    const trigger = screen.getByTestId("stats-button");
    fireEvent.click(trigger);
    const content = screen.getByTestId("stats-popover");
    await act(async () => Promise.resolve());

    act(() => {
      content.setAttribute("data-side", "top");
      trigger.setAttribute("data-radix-popper-side", "top");
    });
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("expires an unpaired statistics content placement synchronously", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    fireEvent.click(screen.getByTestId("stats-button"));
    const content = screen.getByTestId("stats-popover");
    let now = window.performance.now();
    const clock = vi.spyOn(window.performance, "now").mockImplementation(() => now);

    try {
      act(() => content.setAttribute("data-side", "top"));
      await act(async () => Promise.resolve());
      now += 1_001;
      fireEvent.click(screen.getByTestId("storage-indicator"));
      expect(current.storage).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }

    await rerenderStatus(view, props, "fresh-after-unpaired-placement");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("rejects fake Radix-shaped content inserted during a genuine statistics lease", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const attackerContainer = document.createElement("div");
    document.body.prepend(attackerContainer);
    const view = await renderStatus(props);
    const trigger = screen.getByTestId("stats-button");
    trigger.addEventListener("click", () => {
      const fakePortal = document.createElement("div");
      const fakeContent = document.createElement("div");
      fakePortal.setAttribute("data-radix-popper-content-wrapper", "");
      fakeContent.id = "fake-stats-content";
      fakeContent.setAttribute("data-testid", "stats-popover");
      fakeContent.setAttribute("data-state", "open");
      fakeContent.setAttribute("role", "dialog");
      fakeContent.setAttribute("data-side", "bottom");
      fakeContent.setAttribute("data-align", "start");
      fakePortal.append(fakeContent);
      attackerContainer.append(fakePortal);
    }, { capture: true, once: true });

    fireEvent.click(trigger);
    expect(screen.getAllByTestId("stats-popover")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-after-fake-stats");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("keeps a replay bound to the original statistics portal", async () => {
    const original = callbacks();
    const replacement = callbacks();
    const props = statusProps(original);
    const view = await renderStatus(props);
    fireEvent.click(screen.getByTestId("stats-button"));
    const replacementProps = {
      ...props,
      onStorage: replacement.storage,
    };
    await rerenderStatus(view, replacementProps);
    const content = screen.getByTestId("stats-popover");
    const portal = content.parentElement;
    if (!portal) throw new Error("Statistics portal wrapper missing");
    const clone = portal.cloneNode(true) as HTMLElement;

    portal.replaceWith(clone);
    try {
      fireEvent.click(screen.getByTestId("storage-indicator"));
      expect(original.storage).not.toHaveBeenCalled();
      expect(replacement.storage).not.toHaveBeenCalled();
    } finally {
      if (clone.isConnected) clone.replaceWith(portal);
    }

    await rerenderStatus(view, replacementProps, "fresh-after-stats-clone");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(replacement.storage).toHaveBeenCalledOnce();
  });

  it("retires an open statistics boundary when its session is replaced", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    fireEvent.click(screen.getByTestId("stats-button"));
    expect(screen.getByTestId("stats-popover")).toBeInTheDocument();

    await rerenderStatus(view, {
      ...props,
      session: fakeSession("session-b"),
    });

    expect(screen.queryByTestId("stats-popover")).toBeNull();
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();

    await nextTask();
    fireEvent.click(screen.getByTestId("stats-button"));
    expect(screen.getByTestId("stats-popover")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("stats-popover"), {
      code: "Escape",
      key: "Escape",
    });
    await act(async () => Promise.resolve());
    fireEvent.click(desktopShortcuts());
    expect(current.shortcuts).toHaveBeenCalledOnce();
  });

  it("retires after an unrelated fake popper wrapper is added and removed", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    const fakePortal = document.createElement("div");
    fakePortal.setAttribute("data-radix-popper-content-wrapper", "");
    const fakeContent = document.createElement("div");
    fakeContent.setAttribute("data-testid", "stats-popover");
    fakePortal.append(fakeContent);

    act(() => {
      document.body.append(fakePortal);
      fakePortal.remove();
    });
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-after-fake-wrapper");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("publishes an internal successor after an unrelated body portal opens and closes", async () => {
    const current = callbacks();
    const props = statusProps(current);
    await renderDirect(
      <StrictMode>
        <UnrelatedPresencePopover />
        <StatusBar {...props} />
      </StrictMode>,
    );
    const root = screen.getByTestId("status-bar");
    const presence = screen.getByTestId("presence-trigger");

    fireEvent.click(presence);
    expect(screen.getByTestId("presence-content")).toBeVisible();
    await nextTask();
    expect(screen.getByTestId("status-bar")).toBe(root);

    fireEvent.click(presence);
    expect(screen.queryByTestId("presence-content")).toBeNull();
    await nextTask();
    expect(screen.getByTestId("status-bar")).toBe(root);

    fireEvent.click(screen.getByTestId("storage-indicator"));
    fireEvent.click(desktopShortcuts());
    expect(current.storage).toHaveBeenCalledOnce();
    expect(current.shortcuts).toHaveBeenCalledOnce();
  });

  it("accepts an immediate secondary-pointer disclosure close once", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));
    const trigger = openIssues();
    await nextTask();

    fireEvent(outside, pointerEvent("pointerdown", 31, { button: 2 }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByTestId("storage-indicator"));

    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("does not lease a statistics close rejected for a secondary pointer", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));
    fireEvent.click(screen.getByTestId("stats-button"));
    await nextTask();

    fireEvent(outside, pointerEvent("pointerdown", 32, { button: 2 }));
    expect(screen.getByTestId("stats-popover")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("storage-indicator"));

    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("expires a statistics lease synchronously when its timer is starved", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    const trigger = screen.getByTestId("stats-button");
    let now = window.performance.now();
    const clock = vi.spyOn(window.performance, "now").mockImplementation(() => now);
    trigger.addEventListener("click", () => {
      now += 1_001;
    }, { capture: true, once: true });

    try {
      fireEvent.click(trigger);
      fireEvent.click(screen.getByTestId("storage-indicator"));
      expect(current.storage).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }

    await rerenderStatus(view, props, "fresh-after-expired-stats");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("keeps current controls usable after real selection-label and goal reconciliation", async () => {
    const current = callbacks();
    const props = statusProps(current);
    await renderStatus(props);
    const beforeSelection = captureClick(screen.getByTestId("storage-indicator"));

    act(() => setFakeSelection(props.session, 2, 8));
    expect(screen.getByTestId("selection-count")).toHaveTextContent(
      "1 of 2 selected",
    );
    const beforeGoal = captureClick(screen.getByTestId("storage-indicator"));

    act(() => {
      setGoal(props.session, {
        kind: "words",
        mode: "min",
        value: 100,
        setBy: "alice",
        setAt: 100,
      });
    });
    expect(screen.getByTestId("goal-ring")).toBeInTheDocument();
    expect(screen.getByTestId("stats-button")).toHaveAttribute(
      "title",
      "2 / 100 words",
    );

    invokeFabricatedClick(beforeSelection);
    invokeFabricatedClick(beforeGoal);
    expect(current.storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });
});

describe("status bar permanent retirement", () => {
  it.each([
    ["root mutation and restore", () => {
      const root = screen.getByTestId("status-bar");
      const className = root.className;
      root.className = `${className} altered`;
      root.className = className;
    }],
    ["root detach and reinsert", () => {
      const root = screen.getByTestId("status-bar");
      const parent = root.parentNode;
      if (!parent) throw new Error("Status bar parent missing");
      root.remove();
      parent.appendChild(root);
    }],
    ["higher ancestor detach and reinsert", (view: DirectView) => {
      view.host.remove();
      document.body.append(view.host);
    }],
    ["nonadjacent ancestor churn", () => {
      const sibling = document.createElement("aside");
      document.body.prepend(sibling);
      sibling.remove();
    }],
    ["statistics trigger mutation and restore", () => {
      const trigger = screen.getByTestId("stats-button");
      const title = trigger.title;
      trigger.title = "altered";
      trigger.title = title;
    }],
    ["statistics placement mutation and restore", () => {
      const trigger = screen.getByTestId("stats-button");
      trigger.setAttribute("data-radix-popper-side", "top");
      trigger.removeAttribute("data-radix-popper-side");
    }],
    ["statistics descendant replacement and restore", () => {
      const label = screen.getByTestId("word-count");
      const text = label.firstChild;
      if (!text) throw new Error("Statistics label text missing");
      const replacement = text.cloneNode(true);
      label.replaceChild(replacement, text);
      label.replaceChild(text, replacement);
    }],
  ])("retires after %s and lets an equal fresh remount recover", async (_name, mutate) => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    mutate(view);

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "replacement");
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("retires a restored partial portal without letting late controls revive it", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    openMenu();
    const content = screen.getByTestId("status-menu-content");
    const extra = document.createElement("span");
    content.append(extra);
    extra.remove();
    fireEvent.click(elementWithText('[role="menuitemradio"]', "Code only"));
    expect(current.layout).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-menu");
    selectMenuItem('[role="menuitemradio"]', "Code only");
    expect(current.layout).toHaveBeenCalledOnce();
  });

  it("latches document and issue fact drift even when the values are restored", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    const originalPath = props.doc.repoPath;
    props.doc.repoPath = "MUTATED.md";
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).not.toHaveBeenCalled();
    props.doc.repoPath = originalPath;
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-document");
    openIssues();
    const originalMessage = ISSUE_A.message;
    const issueButton = elementWithText("button", originalMessage);
    ISSUE_A.message = "Mutated issue";
    fireEvent.click(issueButton);
    expect(current.issue).not.toHaveBeenCalled();
    ISSUE_A.message = originalMessage;
    fireEvent.click(issueButton);
    expect(current.issue).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-issue");
    openIssues();
    fireEvent.click(elementWithText("button", ISSUE_A.message));
    expect(current.issue).toHaveBeenCalledOnce();
    expect(current.issue).toHaveBeenCalledWith(ISSUE_A);
  });
});

describe("status bar long issue descriptions", () => {
  const messages = [
    ["unbroken", "x".repeat(256)],
    ["ordinary", "Use a descriptive link so readers know where it leads. ".repeat(6)],
    ["literal", '<button tabindex="0">Not a control</button> & **literal** <img src="missing"> '.repeat(4)],
  ] as const;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("./use-session")>("./use-session");
    controlled.sessionHook.mockImplementation(actual.useDebouncedSessionValue);
  });

  function expectWrappedIssues(issues: readonly LintIssue[]) {
    const content = screen.getByTestId("status-issues-content");
    expect(content).toHaveClass("w-80", "p-0");
    expect(content).toHaveAttribute("data-align", "end");
    expect(content.querySelector("ul")).toHaveAttribute(
      "class",
      "scrollbar-thin max-h-72 overflow-y-auto py-1",
    );
    const rows = [...content.querySelectorAll("button")];
    expect(rows).toHaveLength(issues.length);
    for (const [index, issue] of issues.entries()) {
      const row = rows[index];
      expect(row).toHaveAttribute("type", "button");
      expect(row).toHaveAttribute(
        "class",
        "flex w-full items-start gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-surface-3",
      );
      expect(row.parentElement?.tagName).toBe("LI");
      expect(row.childNodes).toHaveLength(3);
      const spans = [...row.children];
      expect(spans.map((span) => span.tagName)).toEqual(["SPAN", "SPAN", "SPAN"]);
      expect(row.querySelectorAll("*")).toHaveLength(3);
      const [dot, message, line] = spans;
      expect(dot).toHaveAttribute(
        "class",
        `mt-0.5 h-2 w-2 shrink-0 rounded-full ${issue.severity === "error" ? "bg-danger" : "bg-warning"}`,
      );
      expect(dot.childNodes).toHaveLength(0);
      expect(message).toHaveAttribute(
        "class",
        "min-w-0 flex-1 wrap-anywhere text-ink-2",
      );
      expect(message.textContent).toBe(issue.message);
      expect(message.childNodes).toHaveLength(1);
      expect(message.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(line).toHaveAttribute("class", "shrink-0 font-mono text-xs text-ink-4");
      expect(line.textContent).toBe(`L${issue.line}`);
      expect(row.textContent).toBe(`${issue.message}L${issue.line}`);
      expect(row.tabIndex).toBe(0);
      expect(row.querySelectorAll("[tabindex], [role], [title], [contenteditable], a, button, input")).toHaveLength(0);
    }
    return rows;
  }

  function inspectWithoutEffects(
    props: StatusBarProps,
    sets: StatusCallbacks[],
    inspect: () => void,
  ) {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const click = vi.spyOn(HTMLElement.prototype, "click");
    const scroll = vi.spyOn(window, "scrollTo");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const fetch = vi.spyOn(globalThis, "fetch");
    const counts = () => [
      ...allCallbackCounts(sets),
      controlled.lint.mock.calls.length,
      controlled.sessionHook.mock.calls.length,
      controlled.themeSetter.mock.calls.length,
      focus.mock.calls.length,
      click.mock.calls.length,
      scroll.mock.calls.length,
      timeout.mock.calls.length,
      interval.mock.calls.length,
      fetch.mock.calls.length,
    ];
    try {
      const before = counts();
      const source = props.session.ytext.toString();
      const version = props.session.version;
      const focused = document.activeElement;
      const markup = document.body.innerHTML;
      inspect();
      expect(counts()).toEqual(before);
      expect(props.session.ytext.toString()).toBe(source);
      expect(props.session.version).toBe(version);
      expect(document.activeElement).toBe(focused);
      expect(document.body.innerHTML).toBe(markup);
    } finally {
      vi.restoreAllMocks();
    }
  }

  describe.each(["error", "warning"] as const)("%s", (severity) => {
    it.each(messages)("wraps %s text without adding controls or changing the selected issue", async (_kind, message) => {
      expect(message.length).toBeGreaterThanOrEqual(240);
      const issue: LintIssue = { ...ISSUE_A, message, severity };
      controlled.issues = [issue];
      const current = callbacks();
      const props = statusProps(current);
      await renderStatus(props);
      openIssues();
      await nextTask();

      inspectWithoutEffects(props, [current], () => {
        expectWrappedIssues([issue]);
        expect(screen.getByTestId("issues-button")).toHaveTextContent("1 issue");
        expect(screen.getByTestId("issues-button")).toHaveClass(
          severity === "error" ? "text-danger" : "text-warning",
        );
      });
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);

      const row = elementWithText("button", message);
      fireEvent.click(row);
      fireEvent.click(row);
      expect(current.issue).toHaveBeenCalledOnce();
      expect(current.issue.mock.calls[0][0]).toBe(issue);
      expect(allCallbackCounts([current])).toEqual([0, 0, 0, 1, 0, 0]);
    });
  });

  it.each(["replacement", "reorder", "removal", "document switch"] as const)(
    "keeps the same open portal and retires long issue handlers after %s",
    async (transition) => {
      const first: LintIssue = { ...ISSUE_A, message: messages[0][1] };
      const second: LintIssue = { ...ISSUE_OTHER, message: messages[1][1] };
      const replacement: LintIssue = { ...ISSUE_OTHER, message: messages[2][1] };
      controlled.issues = [first, second];
      const retired = callbacks();
      const current = callbacks();
      const props = statusProps(retired);
      const view = await renderStatus(props);
      const trigger = openIssues();
      await nextTask();
      const root = screen.getByTestId("status-bar");
      const content = screen.getByTestId("status-issues-content");
      const portal = content.parentElement;
      const rows = expectWrappedIssues([first, second]);
      const stale = rows.map(captureClick);
      const nextIssues = transition === "reorder"
        ? [second, first]
        : transition === "removal"
          ? [second]
          : [replacement];
      controlled.issues = nextIssues;
      controlled.sessionValue = { text: `# Current ${transition}`, tree: {} };
      const nextProps: StatusBarProps = {
        ...props,
        onIssueSelect: current.issue,
        ...(transition === "document switch" ? {
          doc: documentDto({ id: "document-b" }),
          session: fakeSession("session-b"),
        } : {}),
      };
      vi.useFakeTimers();
      try {
        if (transition !== "document switch") {
          act(() => {
            props.session.ydoc.transact(() => {
              props.session.ytext.delete(0, props.session.ytext.length);
              props.session.ytext.insert(0, controlled.sessionValue.text);
            });
          });
        }
        await rerenderStatus(view, nextProps);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });

        inspectWithoutEffects(nextProps, [retired, current], () => {
          expect(screen.getByTestId("status-bar")).toBe(root);
          expect(screen.getAllByTestId("status-issues-content")).toHaveLength(1);
          expect(screen.getByTestId("status-issues-content")).toBe(content);
          expect(content.parentElement).toBe(portal);
          expect(screen.getByTestId("issues-button")).toBe(trigger);
          expect(trigger).toHaveAttribute("aria-expanded", "true");
          expect(trigger).toHaveAttribute("aria-controls", content.id);
          expectWrappedIssues(nextIssues).forEach((row, index) => {
            expect(row).toBe(rows[index]);
          });
          expect(controlled.lint).toHaveBeenLastCalledWith(
            controlled.sessionValue.text,
            controlled.sessionValue.tree,
          );
          expect(nextProps.session.ytext.toString()).toBe(controlled.sessionValue.text);
          for (const issue of [first, second]) {
            if (!nextIssues.includes(issue))
              expect(screen.queryByText(issue.message, { exact: true })).toBeNull();
          }
        });
        for (const old of stale) {
          const probe = invokeFabricatedClick(old);
          expect(probe.preventDefault).not.toHaveBeenCalled();
          expect(probe.stopPropagation).not.toHaveBeenCalled();
          if (!old.element.isConnected) fireEvent.click(old.element);
        }
        expect(allCallbackCounts([retired, current])).toEqual(new Array(12).fill(0));

        const source = nextProps.session.ytext.toString();
        const version = nextProps.session.version;
        const selected = nextIssues[0];
        const row = elementWithText("button", selected.message);
        fireEvent.click(row);
        fireEvent.click(row);
        expect(retired.issue).not.toHaveBeenCalled();
        expect(current.issue).toHaveBeenCalledOnce();
        expect(current.issue.mock.calls[0][0]).toBe(selected);
        expect(nextProps.session.ytext.toString()).toBe(source);
        expect(nextProps.session.version).toBe(version);
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );

  it("republishes the same open portal for a callback-only change without relinting", async () => {
    useExactWindowListenerRealm();
    const issue: LintIssue = { ...ISSUE_A, message: messages[0][1] };
    controlled.issues = [issue];
    const retired = callbacks();
    const current = callbacks();
    const props = statusProps(retired);
    const view = await renderStatus(props);
    const trigger = openIssues();
    await nextTask();
    const root = screen.getByTestId("status-bar");
    const content = screen.getByTestId("status-issues-content");
    const portal = content.parentElement;
    const [row] = expectWrappedIssues([issue]);
    const stale = captureClick(row);
    const staleClose = nearestHandler<(open: boolean) => void>(content, "onOpenChange");
    const lintCalls = controlled.lint.mock.calls.length;
    const snapshot = controlled.sessionValue;
    const source = props.session.ytext.toString();
    const version = props.session.version;
    const nextProps = { ...props, onIssueSelect: current.issue };
    await rerenderStatus(view, nextProps);

    inspectWithoutEffects(nextProps, [retired, current], () => {
      expect(screen.getByTestId("status-bar")).toBe(root);
      expect(screen.getAllByTestId("status-issues-content")).toHaveLength(1);
      expect(screen.getByTestId("status-issues-content")).toBe(content);
      expect(content.parentElement).toBe(portal);
      expect(screen.getByTestId("issues-button")).toBe(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(trigger).toHaveAttribute("aria-controls", content.id);
      expect(expectWrappedIssues([issue])[0]).toBe(row);
      expect(controlled.sessionValue).toBe(snapshot);
      expect(controlled.lint).toHaveBeenCalledTimes(lintCalls);
    });
    const probe = invokeFabricatedClick(stale);
    expect(probe.preventDefault).not.toHaveBeenCalled();
    expect(probe.stopPropagation).not.toHaveBeenCalled();
    act(() => staleClose(false));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(allCallbackCounts([retired, current])).toEqual(new Array(12).fill(0));
    fireEvent.click(row);
    fireEvent.click(row);
    invokeFabricatedClick(stale);
    expect(retired.issue).not.toHaveBeenCalled();
    expect(current.issue).toHaveBeenCalledOnce();
    expect(current.issue.mock.calls[0][0]).toBe(issue);
    expect(props.session.ytext.toString()).toBe(source);
    expect(props.session.version).toBe(version);

    fireEvent.keyDown(content, { key: "Escape" });
    await nextTask();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    openIssues();
    closeIssues();
  });

  it.each(["wrapper attribute", "wrapper replacement", "content replacement", "duplicate content"] as const)(
    "does not republish an inexact retained boundary after %s",
    async (mutation) => {
      const issue: LintIssue = { ...ISSUE_A, message: messages[0][1] };
      controlled.issues = [issue];
      const retired = callbacks();
      const current = callbacks();
      const props = statusProps(retired);
      const view = await renderStatus(props);
      openIssues();
      await nextTask();
      const content = screen.getByTestId("status-issues-content");
      const portal = content.parentElement;
      if (!portal) throw new Error("Issues portal wrapper missing");
      const [row] = expectWrappedIssues([issue]);
      const stale = captureClick(row);
      const clone = mutation === "wrapper replacement"
        ? portal.cloneNode(false)
        : content.cloneNode(true);
      try {
        if (mutation === "wrapper attribute") {
          portal.removeAttribute("data-radix-popper-content-wrapper");
        } else if (mutation === "wrapper replacement") {
          portal.replaceWith(clone);
          clone.appendChild(content);
        } else if (mutation === "content replacement") {
          content.replaceWith(clone);
        } else {
          portal.append(clone);
        }
        await rerenderStatus(view, { ...props, onIssueSelect: current.issue });
        invokeFabricatedClick(stale);
        fireEvent.click(row);
        fireEvent.click(row);
        if (clone instanceof HTMLElement) {
          const foreignRow = clone.querySelector("button");
          if (foreignRow) fireEvent.click(foreignRow);
        }
        expect(allCallbackCounts([retired, current])).toEqual(new Array(12).fill(0));
      } finally {
        if (mutation === "wrapper attribute") {
          portal.setAttribute("data-radix-popper-content-wrapper", "");
        } else if (mutation === "wrapper replacement") {
          portal.append(content);
          clone.parentNode?.replaceChild(portal, clone);
        } else if (mutation === "content replacement") {
          clone.parentNode?.replaceChild(content, clone);
        } else {
          clone.parentNode?.removeChild(clone);
        }
      }
    },
  );

  it("rejects restored retained-boundary mutation history before a successor can act", async () => {
    const issue: LintIssue = { ...ISSUE_A, message: messages[0][1] };
    controlled.issues = [issue];
    const retired = callbacks();
    const current = callbacks();
    const props = statusProps(retired);
    const view = await renderStatus(props);
    openIssues();
    await nextTask();
    const content = screen.getByTestId("status-issues-content");
    const [row] = expectWrappedIssues([issue]);
    const stale = captureClick(row);
    await rerenderStatus(view, { ...props, onIssueSelect: current.issue });
    expect(screen.getByTestId("status-issues-content")).toBe(content);
    const className = content.className;
    content.className = `${className} altered`;
    content.className = className;
    act(() => {
      fireEvent.click(row);
      fireEvent.click(row);
      invokeFabricatedClick(stale);
    });
    expect(allCallbackCounts([retired, current])).toEqual(new Array(12).fill(0));
  });

  it("emits min-width zero and overflow-wrap anywhere from installed Tailwind", async () => {
    const theme = readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
    const { build } = await compile(`${theme}\n@tailwind utilities;`);
    const css = build(["min-w-0", "wrap-anywhere", "flex-1", "shrink-0"]);
    expect(css).toMatch(/\.min-w-0\s*\{\s*min-width:\s*0px;\s*\}/);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.flex-1\s*\{\s*flex:\s*1;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
  });
});

describe("status bar event and replacement claims", () => {
  it("rejects fabricated, crossed, and repeated direct events without poisoning controls", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    const storage = captureClick(screen.getByTestId("storage-indicator"));
    const shortcuts = captureClick(desktopShortcuts());
    const storageProbe = invokeFabricatedClick(
      storage,
      shortcuts.element,
      storage.element,
    );
    const shortcutsProbe = invokeFabricatedClick(
      shortcuts,
      storage.element,
      shortcuts.element,
    );
    expect(allCallbackCounts([current])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(storageProbe.preventDefault).not.toHaveBeenCalled();
    expect(storageProbe.stopPropagation).not.toHaveBeenCalled();
    expect(shortcutsProbe.preventDefault).not.toHaveBeenCalled();

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      storage.element.dispatchEvent(event);
      storage.element.dispatchEvent(event);
    });
    fireEvent.click(shortcuts.element);
    expect(current.storage).toHaveBeenCalledOnce();
    expect(current.shortcuts).toHaveBeenCalledOnce();
  });

  it("rejects fabricated and crossed menu items before a genuine selection", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    openMenu();
    const code = elementWithText('[role="menuitemradio"]', "Code only");
    const rich = elementWithText('[role="menuitemradio"]', "Preview only");
    const codeCapture = reactHandler<(event: ReactMouseEvent<HTMLElement>) => void>(
      code,
      "onClickCapture",
    );
    const codeSelect = nearestHandler<(event: Event) => void>(code, "onSelect");
    const valueChange = nearestHandler<(value: string) => void>(
      code,
      "onValueChange",
    );
    codeCapture(fabricatedClick(rich, code).event);
    codeSelect({
      currentTarget: rich,
      target: code,
      preventDefault: vi.fn(),
    } as unknown as Event);
    valueChange("code");
    valueChange("invalid");
    expect(current.layout).not.toHaveBeenCalled();
    expect(screen.getByTestId("layout-menu")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(code);
    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("code");
  });

  it("binds ordered issue rows, rejects crossed handlers, and claims each row once", async () => {
    controlled.issues = [ISSUE_A, ISSUE_OTHER];
    const current = callbacks();
    await renderStatus(statusProps(current));
    openIssues();
    const rows = [...screen.getByTestId("status-issues-content").querySelectorAll("button")];
    expect(rows.map((row) => row.textContent)).toEqual([
      `${ISSUE_A.message}L${ISSUE_A.line}`,
      `${ISSUE_OTHER.message}L${ISSUE_OTHER.line}`,
    ]);
    const first = captureClick(rows[0]);
    invokeFabricatedClick(first, rows[1], rows[0]);
    expect(current.issue).not.toHaveBeenCalled();

    fireEvent.click(rows[0]);
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    fireEvent.click(rows[1]);
    expect(current.issue).toHaveBeenCalledTimes(2);
    expect(current.issue.mock.calls).toEqual([[ISSUE_A], [ISSUE_OTHER]]);
  });

  it("bridges deferred outside pointer timing and rejects stale or crossed chains", async () => {
    controlled.issues = [ISSUE_A, ISSUE_OTHER];
    const current = callbacks();
    const firstOutside = document.createElement("button");
    const secondOutside = document.createElement("button");
    document.body.prepend(firstOutside, secondOutside);
    await renderStatus(statusProps(current));

    openIssues();
    await nextTask();
    const staleContent = screen.getByTestId("status-issues-content");
    const staleAuthorize = nearestHandler<
      (event: CustomEvent<{ originalEvent: Event }>) => void
    >(staleContent, "onPointerDownOutside");
    const staleChange = nearestHandler<(open: boolean) => void>(
      staleContent,
      "onOpenChange",
    );
    let genuineOutsideEvent: CustomEvent<{ originalEvent: Event }> | null = null;
    firstOutside.addEventListener(
      "dismissableLayer.pointerDownOutside",
      (event) => {
        genuineOutsideEvent =
          event as CustomEvent<{ originalEvent: Event }>;
      },
    );

    await outsidePointerClick(firstOutside);
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(genuineOutsideEvent).not.toBeNull();

    openIssues();
    await nextTask();
    act(() => {
      staleAuthorize(genuineOutsideEvent!);
      staleChange(false);
    });
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await outsidePointerClick(firstOutside, secondOutside);
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await outsidePointerClick(secondOutside);
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(current.issue).not.toHaveBeenCalled();
  });

  it("accepts Chromium's non-primary synthesized click after a primary pointer chain", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));
    openIssues();
    await nextTask();

    fireEvent(outside, pointerEvent("pointerdown", 9));
    await nextTask();
    fireEvent(outside, pointerEvent("pointerup", 9));
    fireEvent(outside, pointerEvent("click", 9, { isPrimary: false }));
    await act(async () => Promise.resolve());

    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("keeps the Radix fallback lease and expires an incomplete outside gesture", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));

    openIssues();
    await nextTask();
    const stopClick = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener("click", stopClick);
    fireEvent(outside, pointerEvent("pointerdown", 11));
    fireEvent(outside, pointerEvent("pointerup", 11));
    fireEvent(outside, pointerEvent("click", 11));
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await nextTask();
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    document.removeEventListener("click", stopClick);

    openIssues();
    await nextTask();
    vi.useFakeTimers();
    try {
      fireEvent(outside, pointerEvent("pointerdown", 12));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      fireEvent(outside, pointerEvent("pointerup", 12));
      fireEvent(outside, pointerEvent("click", 12));
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      fireEvent(outside, pointerEvent("pointerdown", 13));
      fireEvent(outside, pointerEvent("pointerup", 13));
      fireEvent(outside, pointerEvent("click", 13));
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects named MouseEvents, cancelled pointers, and mixed final clicks", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));
    openIssues();
    await nextTask();

    fireEvent(outside, new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      composed: true,
    }));
    fireEvent(outside, new MouseEvent("pointerup", {
      bubbles: true,
      button: 0,
      cancelable: true,
      composed: true,
    }));
    fireEvent(outside, new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      composed: true,
      detail: 1,
    }));
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent(outside, pointerEvent("pointerdown", 41));
    fireEvent(outside, pointerEvent("pointercancel", 41));
    fireEvent(outside, pointerEvent("pointerup", 41));
    fireEvent(outside, pointerEvent("click", 41));
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent(outside, pointerEvent("pointerdown", 42));
    fireEvent(outside, pointerEvent("pointerup", 42));
    fireEvent(outside, new MouseEvent("click", {
      bubbles: true,
      button: 0,
      cancelable: true,
      composed: true,
      detail: 1,
    }));
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
    closeIssues();
    openIssues();
    await nextTask();
    await outsidePointerClick(outside);
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("enforces monotonic gesture and callback deadlines with starved timers", async () => {
    const current = callbacks();
    const outside = document.createElement("button");
    document.body.prepend(outside);
    await renderStatus(statusProps(current));
    openIssues();
    await nextTask();
    let now = window.performance.now();
    const clock = vi.spyOn(window.performance, "now").mockImplementation(() => now);
    const stopClick = (event: Event) => event.stopImmediatePropagation();

    try {
      fireEvent(outside, pointerEvent("pointerdown", 51));
      now += 5_001;
      fireEvent(outside, pointerEvent("pointerup", 51));
      fireEvent(outside, pointerEvent("click", 51));
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );

      document.addEventListener("click", stopClick);
      fireEvent(outside, pointerEvent("pointerdown", 52));
      fireEvent(outside, pointerEvent("pointerup", 52));
      fireEvent(outside, pointerEvent("click", 52));
      now += 1_001;
      await nextTask();
      expect(screen.getByTestId("issues-button")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    } finally {
      document.removeEventListener("click", stopClick);
      clock.mockRestore();
    }

    await outsidePointerClick(outside);
    expect(screen.getByTestId("issues-button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("retires callback A before the same DOM publishes callback B", async () => {
    const oldCallbacks = callbacks();
    const newCallbacks = callbacks();
    const oldProps = statusProps(oldCallbacks);
    const view = await renderStatus(oldProps);
    const root = screen.getByTestId("status-bar");
    const staleStorage = captureClick(screen.getByTestId("storage-indicator"));
    const staleMenu = captureDisclosure(screen.getByTestId("layout-menu"));
    const newProps = statusProps(newCallbacks, {
      ...oldProps,
      onLayout: newCallbacks.layout,
      onLineWrapping: newCallbacks.wrapping,
      onSyncScroll: newCallbacks.syncScroll,
      onIssueSelect: newCallbacks.issue,
      onShortcuts: newCallbacks.shortcuts,
      onStorage: newCallbacks.storage,
    });

    await rerenderStatus(view, newProps);
    expect(screen.getByTestId("status-bar")).toBe(root);
    invokeFabricatedClick(staleStorage);
    invokeFabricatedDisclosure(staleMenu);
    expect(allCallbackCounts([oldCallbacks, newCallbacks])).toEqual(
      new Array(12).fill(0),
    );

    fireEvent.click(screen.getByTestId("storage-indicator"));
    selectMenuItem('[role="menuitemradio"]', "Code only");
    expect(oldCallbacks.storage).not.toHaveBeenCalled();
    expect(oldCallbacks.layout).not.toHaveBeenCalled();
    expect(newCallbacks.storage).toHaveBeenCalledOnce();
    expect(newCallbacks.layout).toHaveBeenCalledOnce();
  });

  it("isolates equal-looking remount DOM and ignores old late handlers", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderStatus(props);
    const oldRoot = screen.getByTestId("status-bar");
    const staleStorage = captureClick(screen.getByTestId("storage-indicator"));

    await rerenderStatus(view, props, "replacement");
    expect(screen.getByTestId("status-bar")).not.toBe(oldRoot);
    invokeFabricatedClick(staleStorage);
    expect(current.storage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });
});
