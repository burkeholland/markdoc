// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CollabSession } from "@/editor/collab/session";
import type { LintIssue } from "@/editor/markdown/lint";
import type { DocumentDto } from "@/server/dto";
import type { Layout } from "@/lib/viewport";

const controlled = vi.hoisted(() => ({
  hydrated: true,
  issues: [] as unknown[],
  lint: vi.fn(),
  sessionValue: { text: "# Status bar", tree: {} },
  sessionHook: vi.fn(),
  themePreference: "system",
  themeSetter: vi.fn(),
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
    useDebouncedSessionValue: (...args: unknown[]) => {
      controlled.sessionHook(...args);
      return controlled.sessionValue;
    },
  };
});
vi.mock("@/components/ui/theme-toggle", () => ({
  ThemeToggle: ({ className }: { className?: string }) => (
    <button type="button" className={className} data-testid="theme-toggle">
      Theme
    </button>
  ),
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
    binding: { getTree: () => controlled.sessionValue.tree },
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

function desktopShortcuts() {
  const element = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Help and shortcuts"]',
  );
  if (!element) throw new Error("Desktop shortcuts were not rendered");
  return element;
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
  fireEvent.pointerDown(pointerDownTarget, {
    button: 0,
    pointerId: 7,
    pointerType: "mouse",
    isPrimary: true,
  });
  await nextTask();
  fireEvent.pointerUp(releaseTarget, {
    button: 0,
    pointerId: 7,
    pointerType: "mouse",
    isPrimary: true,
  });
  fireEvent.click(releaseTarget, { button: 0 });
  await act(async () => {
    await Promise.resolve();
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

beforeEach(() => {
  controlled.hydrated = true;
  controlled.issues = [ISSUE_A];
  controlled.lint.mockReset();
  controlled.sessionHook.mockReset();
  controlled.sessionValue = { text: "# Status bar", tree: {} };
  controlled.themePreference = "system";
  controlled.themeSetter.mockReset();
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
  document.body.replaceChildren();
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

describe("status bar nested StatsPopover reconciliation", () => {
  it("keeps current controls usable after the real statistics disclosure opens and closes", async () => {
    const current = callbacks();
    await renderStatus(statusProps(current));
    const stats = screen.getByTestId("stats-button");

    expect(screen.getByTestId("word-count")).toHaveTextContent("2 words");
    fireEvent.click(stats);
    expect(screen.getByTestId("stats-popover")).toBeInTheDocument();
    fireEvent.keyDown(window, {
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("stats-popover")).toBeNull();

    fireEvent.click(screen.getByTestId("storage-indicator"));
    expect(current.storage).toHaveBeenCalledOnce();
  });

  it("keeps current controls usable after real selection-label and goal reconciliation", async () => {
    const current = callbacks();
    const props = statusProps(current);
    await renderStatus(props);

    act(() => setFakeSelection(props.session, 2, 8));
    expect(screen.getByTestId("selection-count")).toHaveTextContent(
      "1 of 2 selected",
    );

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
    ISSUE_A.message = "Mutated issue";
    fireEvent.click(elementWithText("button", originalMessage));
    expect(current.issue).not.toHaveBeenCalled();
    ISSUE_A.message = originalMessage;
    fireEvent.click(elementWithText("button", originalMessage));
    expect(current.issue).not.toHaveBeenCalled();

    await rerenderStatus(view, props, "fresh-issue");
    openIssues();
    fireEvent.click(elementWithText("button", ISSUE_A.message));
    expect(current.issue).toHaveBeenCalledOnce();
    expect(current.issue).toHaveBeenCalledWith(ISSUE_A);
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
