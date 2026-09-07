// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("./use-session", () => ({
  useDebouncedSessionValue: (...args: unknown[]) => {
    controlled.sessionHook(...args);
    return controlled.sessionValue;
  },
}));
vi.mock("./stats-popover", () => ({
  StatsPopover: ({ session, source, hydrated }: { session: CollabSession; source: string; hydrated: boolean }) => (
    <output data-testid="stats-popover" data-session={session === null ? "none" : "present"} data-source={source} data-hydrated={hydrated} />
  ),
  useLocalSelection: () => null,
}));
vi.mock("@/components/ui/theme-toggle", () => ({
  ThemeToggle: ({ className }: { className?: string }) => <button type="button" className={className} data-testid="theme-toggle">Theme</button>,
  useTheme: () => [controlled.themePreference, controlled.themeSetter],
}));

import { StatusBar, type StatusBarProps } from "./status-bar";

type ValueHandler<T> = (value: T) => void;
type ClickHandler = (event: ReactMouseEvent<HTMLElement>) => void;

interface StatusCallbacks {
  layout: ReturnType<typeof vi.fn<(layout: Layout) => void>>;
  wrapping: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  syncScroll: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  issue: ReturnType<typeof vi.fn<(issue: LintIssue) => void>>;
  shortcuts: ReturnType<typeof vi.fn<() => void>>;
  storage: ReturnType<typeof vi.fn<() => void>>;
}

interface CapturedActions {
  menuOpen: ValueHandler<boolean>;
  issuesOpen?: ValueHandler<boolean>;
  layout: ValueHandler<string>;
  wrapping: ValueHandler<boolean | "indeterminate">;
  syncScroll: ValueHandler<boolean | "indeterminate">;
  theme?: ValueHandler<string>;
  compactShortcuts?: ValueHandler<Event>;
  desktopShortcuts?: ClickHandler;
  storage?: ClickHandler;
  issue?: ClickHandler;
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

const ISSUE_A: LintIssue = {
  line: 3,
  column: 5,
  offset: 17,
  message: "Use a descriptive link",
  rule: "descriptive-link",
  severity: "warning",
};
const ISSUE_B: LintIssue = { ...ISSUE_A };
const ISSUE_OTHER: LintIssue = {
  line: 7,
  column: 1,
  offset: 41,
  message: "Heading level skipped",
  rule: "heading-increment",
  severity: "error",
};

const directViews: DirectView[] = [];

function fakeSession(name: string) {
  return {
    name,
    binding: { getTree: () => controlled.sessionValue.tree },
  } as unknown as CollabSession;
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

function InitialStatusBar({ props }: { props: StatusBarProps }) {
  return <StatusBar {...props} />;
}

function ReplacementStatusBar({ props }: { props: StatusBarProps }) {
  return <StatusBar {...props} />;
}

function StatusBoundary({
  props,
  mount = "initial",
  present = true,
  boundary = 0,
  passiveGeneration = "initial",
  onBoundary,
  onPassiveCleanup,
}: {
  props: StatusBarProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  boundary?: number;
  passiveGeneration?: string;
  onBoundary?: () => void;
  onPassiveCleanup: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveGeneration]);
  if (!present) return null;
  return mount === "initial"
    ? <InitialStatusBar props={props} />
    : <ReplacementStatusBar props={props} />;
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

async function renderBoundary(
  view: DirectView,
  props: StatusBarProps,
  options: Omit<Parameters<typeof StatusBoundary>[0], "props" | "onPassiveCleanup"> & {
    onPassiveCleanup: () => void;
  },
) {
  await act(async () => {
    view.root.render(<StatusBoundary props={props} {...options} />);
    await Promise.resolve();
  });
}

function fiberFor(element: Element): ReactFiber {
  const fiberKey = Object.keys(element).find((candidate) => candidate.startsWith("__reactFiber$"));
  const propsKey = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey) throw new Error(`React internals were not attached to ${element.tagName}`);
  const record = element as unknown as Record<string, ReactFiber | Record<string, unknown>>;
  const fiber = record[fiberKey] as ReactFiber;
  const props = record[propsKey] as Record<string, unknown>;
  const alternate = fiber.alternate;
  if (!alternate) return fiber;
  const eventProps = ["onClick", "onPointerDown", "onKeyDown", "onFocus"];
  const alternateIsCurrent = eventProps.some(
    (name) => typeof props[name] === "function" && alternate.memoizedProps?.[name] === props[name],
  );
  return alternateIsCurrent ? alternate : fiber;
}

function nearestHandler<T extends (...args: never[]) => unknown>(element: Element, name: string): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const handler = fiber.memoizedProps?.[name];
    if (typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`${name} was not found above ${element.tagName}`);
}

function reactHandler(element: Element, name = "onClick"): ClickHandler {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown>>)[key];
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as ClickHandler;
}

async function openDisclosures(compact = false, alreadyOpen = false) {
  const menuTrigger = screen.getByTestId("layout-menu");
  const menuOpen = nearestHandler<ValueHandler<boolean>>(menuTrigger, "onOpenChange");
  if (!alreadyOpen && menuTrigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
      await Promise.resolve();
    });
  }
  let issuesOpen: ValueHandler<boolean> | undefined;
  if (!compact) {
    const issuesTrigger = screen.getByTestId("issues-button");
    issuesOpen = nearestHandler<ValueHandler<boolean>>(issuesTrigger, "onOpenChange");
    if (!alreadyOpen && issuesTrigger.getAttribute("aria-expanded") !== "true") {
      await act(async () => {
        fireEvent.click(issuesTrigger);
        await Promise.resolve();
      });
    }
  }
  return { menuOpen, issuesOpen };
}

function elementWithText(selector: string, text: string) {
  const element = [...document.querySelectorAll<HTMLElement>(selector)]
    .findLast((candidate) => candidate.textContent?.includes(text));
  if (!element) throw new Error(`${selector} containing "${text}" was not rendered`);
  return element;
}

async function captureActions({
  alreadyOpen = false,
  compact = false,
  issueMessage,
  storage = true,
}: {
  alreadyOpen?: boolean;
  compact?: boolean;
  issueMessage?: string;
  storage?: boolean;
} = {}): Promise<CapturedActions> {
  const disclosures = await openDisclosures(compact, alreadyOpen);
  const codeItem = elementWithText('[role="menuitemradio"]', "Code only");
  const wrapItem = elementWithText('[role="menuitemcheckbox"]', "Wrap long lines");
  const syncItem = screen.getByTestId("sync-scroll-toggle");
  const storageButton = screen.getByTestId("storage-indicator");
  const actions: CapturedActions = {
    ...disclosures,
    layout: nearestHandler(codeItem, "onValueChange"),
    wrapping: nearestHandler(wrapItem, "onCheckedChange"),
    syncScroll: nearestHandler(syncItem, "onCheckedChange"),
    storage: storage ? reactHandler(storageButton) : undefined,
  };
  if (compact) {
    actions.theme = nearestHandler<ValueHandler<string>>(screen.getByTestId("menu-theme-dark"), "onValueChange");
    actions.compactShortcuts = nearestHandler<ValueHandler<Event>>(
      elementWithText('[role="menuitem"]', "Help and shortcuts"),
      "onSelect",
    );
  } else {
    const desktopShortcuts = document.querySelector<HTMLButtonElement>('button[aria-label="Help and shortcuts"]');
    if (!desktopShortcuts) throw new Error("Desktop shortcuts were not rendered");
    actions.desktopShortcuts = reactHandler(desktopShortcuts);
    const issueButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .findLast((button) => button.textContent?.includes(issueMessage ?? ISSUE_A.message));
    actions.issue = issueButton ? reactHandler(issueButton) : undefined;
  }
  return actions;
}

function clickProbe() {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    event: {
      preventDefault,
      stopPropagation,
      isDefaultPrevented: () => preventDefault.mock.calls.length > 0,
      isPropagationStopped: () => stopPropagation.mock.calls.length > 0,
    } as unknown as ReactMouseEvent<HTMLElement>,
    preventDefault,
    stopPropagation,
  };
}

function activateCurrent(actions: CapturedActions, props: StatusBarProps) {
  actions.layout(props.layout === "code" ? "rich" : "code");
  actions.wrapping(!props.lineWrapping);
  actions.syncScroll(!props.syncScroll);
  actions.issue?.(clickProbe().event);
  actions.desktopShortcuts?.(clickProbe().event);
  actions.compactShortcuts?.(new Event("select"));
  actions.storage?.(clickProbe().event);
  actions.theme?.(controlled.themePreference === "dark" ? "light" : "dark");
}

function allCallCounts(callbackSets: StatusCallbacks[]) {
  return {
    callbacks: callbackSets.flatMap((set) => [
      set.layout.mock.calls.length,
      set.wrapping.mock.calls.length,
      set.syncScroll.mock.calls.length,
      set.issue.mock.calls.length,
      set.shortcuts.mock.calls.length,
      set.storage.mock.calls.length,
    ]),
    theme: controlled.themeSetter.mock.calls.length,
  };
}

function expectStaleInert(
  actions: CapturedActions,
  staleProps: StatusBarProps,
  view: DirectView,
  callbackSets: StatusCallbacks[],
  trackRenderWork = false,
) {
  const focused = document.activeElement;
  const probes = [clickProbe(), clickProbe(), clickProbe()];
  const before = allCallCounts(callbackSets);
  const lintCalls = controlled.lint.mock.calls.length;
  const sessionCalls = controlled.sessionHook.mock.calls.length;
  const html = view.host.innerHTML;
  const menuItems = document.querySelectorAll('[role^="menuitem"]').length;
  const issueRows = [...document.querySelectorAll("button")]
    .filter((button) => [ISSUE_A.message, ISSUE_B.message, ISSUE_OTHER.message]
      .some((message) => button.textContent?.includes(message))).length;

  actions.menuOpen(false);
  actions.issuesOpen?.(false);
  actions.layout(staleProps.layout === "code" ? "rich" : "code");
  actions.wrapping(!staleProps.lineWrapping);
  actions.syncScroll(!staleProps.syncScroll);
  actions.issue?.(probes[0].event);
  actions.desktopShortcuts?.(probes[1].event);
  actions.compactShortcuts?.(new Event("select"));
  actions.storage?.(probes[2].event);
  actions.theme?.(controlled.themePreference === "dark" ? "light" : "dark");

  expect(allCallCounts(callbackSets)).toEqual(before);
  if (trackRenderWork) {
    expect(controlled.lint).toHaveBeenCalledTimes(lintCalls);
    expect(controlled.sessionHook).toHaveBeenCalledTimes(sessionCalls);
  }
  expect(view.host.innerHTML).toBe(html);
  expect(document.querySelectorAll('[role^="menuitem"]')).toHaveLength(menuItems);
  expect([...document.querySelectorAll("button")]
    .filter((button) => [ISSUE_A.message, ISSUE_B.message, ISSUE_OTHER.message]
      .some((message) => button.textContent?.includes(message)))).toHaveLength(issueRows);
  expect(document.activeElement).toBe(focused);
  probes.forEach(({ preventDefault, stopPropagation }) => {
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
  expect(view.host.querySelector('[data-testid="status-bar"]')).not.toBeNull();
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
  document.body.replaceChildren();
});

describe("status bar current publications", () => {
  it("admits each desktop control once and rejects selected, invalid, same-value, and repeated input", async () => {
    const current = callbacks();
    const props = statusProps(current);
    const view = await renderDirect(<StatusBoundary props={props} onPassiveCleanup={() => {}} />);
    const actions = await captureActions();

    actions.layout("split");
    actions.layout("invalid");
    actions.layout("code");
    actions.layout("rich");
    actions.wrapping("indeterminate");
    actions.wrapping(false);
    actions.wrapping(true);
    actions.wrapping(true);
    actions.syncScroll("indeterminate");
    actions.syncScroll(true);
    actions.syncScroll(false);
    actions.syncScroll(false);
    actions.issue?.(clickProbe().event);
    actions.issue?.(clickProbe().event);
    actions.desktopShortcuts?.(clickProbe().event);
    actions.desktopShortcuts?.(clickProbe().event);
    actions.storage?.(clickProbe().event);
    actions.storage?.(clickProbe().event);

    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("code");
    expect(current.wrapping).toHaveBeenCalledOnce();
    expect(current.wrapping).toHaveBeenCalledWith(true);
    expect(current.syncScroll).toHaveBeenCalledOnce();
    expect(current.syncScroll).toHaveBeenCalledWith(false);
    expect(current.issue).toHaveBeenCalledOnce();
    expect(current.issue).toHaveBeenCalledWith(ISSUE_A);
    expect(current.shortcuts).toHaveBeenCalledOnce();
    expect(current.storage).toHaveBeenCalledOnce();
    expect(view.host.querySelector('[data-testid="status-bar"]')).not.toHaveAttribute("data-compact");
  });

  it("binds compact theme and shortcuts separately and keeps missing storage disabled and inert", async () => {
    const current = callbacks();
    const props = statusProps(current, { compact: true, layout: "code", onStorage: undefined });
    await renderDirect(<StatusBoundary props={props} onPassiveCleanup={() => {}} />);
    const actions = await captureActions({ compact: true, storage: false });
    const storageButton = screen.getByTestId("storage-indicator");

    actions.layout("split");
    actions.layout("code");
    actions.layout("rich");
    actions.layout("rich");
    actions.theme?.("sepia");
    actions.theme?.("system");
    actions.theme?.("dark");
    actions.theme?.("light");
    actions.compactShortcuts?.(new Event("select"));
    actions.compactShortcuts?.(new Event("select"));

    expect(current.layout).toHaveBeenCalledOnce();
    expect(current.layout).toHaveBeenCalledWith("rich");
    expect(controlled.themeSetter).toHaveBeenCalledOnce();
    expect(controlled.themeSetter).toHaveBeenCalledWith("dark");
    expect(current.shortcuts).toHaveBeenCalledOnce();
    expect(current.storage).not.toHaveBeenCalled();
    expect(storageButton).toBeDisabled();
    expect(reactHandler.bind(null, storageButton)).toThrow("onClick was not attached");
    expect(screen.queryByTestId("issues-button")).toBeNull();
    expect(screen.queryByTestId("theme-toggle")).toBeNull();
  });
});

describe("status bar replacement authority", () => {
  it.each([
    ["stale before current", true],
    ["current before stale", false],
  ] as const)("retires exact session, document, callback, layout, flags, and equal-looking issue A before parent layout: %s", async (_name, staleFirst) => {
    const passiveCleanup = vi.fn();
    const oldCallbacks = callbacks();
    const newCallbacks = callbacks();
    const oldProps = statusProps(oldCallbacks);
    const view = await renderDirect(<StatusBoundary props={oldProps} onPassiveCleanup={passiveCleanup} />);
    const stale = await captureActions();
    const root = screen.getByTestId("status-bar");
    const menuTrigger = screen.getByTestId("layout-menu");
    controlled.issues = [ISSUE_B];
    controlled.sessionValue = { text: "# Replacement", tree: {} };
    const newProps = statusProps(newCallbacks, {
      session: fakeSession("session-b"),
      doc: documentDto({
        id: "document-b",
        storage: "gist",
        gistId: "gist-b",
        repoOwner: null,
        repoName: null,
        repoBranch: null,
        repoPath: null,
        githubUrl: "https://gist.github.com/gist-b",
        hasUnpublishedChanges: false,
      }),
      layout: "code",
      lineWrapping: true,
      syncScroll: false,
    });
    let boundaryReached = false;

    await renderBoundary(view, newProps, {
      boundary: 1,
      passiveGeneration: "replacement",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        expect(screen.getByTestId("status-bar")).toBe(root);
        expect(screen.getByTestId("layout-menu")).toBe(menuTrigger);
        if (!staleFirst) {
          reactHandler(screen.getByTestId("storage-indicator"))(clickProbe().event);
          const shortcut = view.host.querySelector<HTMLButtonElement>('button[aria-label="Help and shortcuts"]');
          if (!shortcut) throw new Error("Current desktop shortcut was not rendered");
          reactHandler(shortcut)(clickProbe().event);
        }
        expectStaleInert(stale, oldProps, view, [oldCallbacks, newCallbacks], true);
        boundaryReached = true;
      },
    });

    expect(boundaryReached).toBe(true);
    const current = await captureActions();
    if (staleFirst) {
      expectStaleInert(stale, oldProps, view, [oldCallbacks, newCallbacks]);
      act(() => activateCurrent(current, newProps));
    } else {
      act(() => activateCurrent(current, newProps));
      expectStaleInert(stale, oldProps, view, [oldCallbacks, newCallbacks]);
    }
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(oldCallbacks.layout).not.toHaveBeenCalled();
    expect(oldCallbacks.wrapping).not.toHaveBeenCalled();
    expect(oldCallbacks.syncScroll).not.toHaveBeenCalled();
    expect(oldCallbacks.issue).not.toHaveBeenCalled();
    expect(oldCallbacks.shortcuts).not.toHaveBeenCalled();
    expect(oldCallbacks.storage).not.toHaveBeenCalled();
    expect(newCallbacks.layout).toHaveBeenCalledOnce();
    expect(newCallbacks.wrapping).toHaveBeenCalledOnce();
    expect(newCallbacks.syncScroll).toHaveBeenCalledOnce();
    expect(newCallbacks.issue).toHaveBeenCalledOnce();
    expect(newCallbacks.issue).toHaveBeenCalledWith(ISSUE_B);
    expect(newCallbacks.shortcuts).toHaveBeenCalledOnce();
    expect(newCallbacks.storage).toHaveBeenCalledOnce();
    expect(screen.getByTestId("storage-indicator")).toHaveTextContent("gist");
    expect(screen.getByTestId("storage-indicator")).toHaveAttribute("title", "Gist gist-b");
    expectStaleInert(stale, oldProps, view, [oldCallbacks, newCallbacks]);
    act(() => activateCurrent(current, newProps));
    expect(newCallbacks.layout).toHaveBeenCalledOnce();
    expect(newCallbacks.issue).toHaveBeenCalledOnce();
  });

  it("keeps reused parent callbacks and DOM usable while an issue moves behind a changed snapshot", async () => {
    const passiveCleanup = vi.fn();
    const sharedCallbacks = callbacks();
    const props = statusProps(sharedCallbacks);
    const view = await renderDirect(<StatusBoundary props={props} onPassiveCleanup={passiveCleanup} />);
    const stale = await captureActions();
    const root = screen.getByTestId("status-bar");
    controlled.issues = [ISSUE_OTHER, ISSUE_A];
    controlled.sessionValue = { text: "# Moved issue", tree: {} };
    const newProps = { ...props, doc: documentDto() };
    let boundaryReached = false;

    await renderBoundary(view, newProps, {
      boundary: 1,
      passiveGeneration: "moved-issue",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(screen.getByTestId("status-bar")).toBe(root);
        expectStaleInert(stale, props, view, [sharedCallbacks], true);
        boundaryReached = true;
      },
    });

    expect(boundaryReached).toBe(true);
    const current = await captureActions({ issueMessage: ISSUE_OTHER.message });
    act(() => activateCurrent(current, newProps));
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(sharedCallbacks.issue).toHaveBeenCalledOnce();
    expect(sharedCallbacks.issue).toHaveBeenCalledWith(ISSUE_OTHER);
    expectStaleInert(stale, props, view, [sharedCallbacks]);
  });

  it("retires desktop A across compact and hydration publication changes without reaching the current theme setter", async () => {
    const passiveCleanup = vi.fn();
    const sharedCallbacks = callbacks();
    const oldProps = statusProps(sharedCallbacks);
    const view = await renderDirect(<StatusBoundary props={oldProps} onPassiveCleanup={passiveCleanup} />);
    const stale = await captureActions();
    controlled.hydrated = false;
    controlled.issues = [];
    controlled.themePreference = "dark";
    const compactProps = statusProps(sharedCallbacks, {
      ...oldProps,
      compact: true,
      layout: "code",
    });
    let boundaryReached = false;

    await renderBoundary(view, compactProps, {
      boundary: 1,
      passiveGeneration: "compact-hydration",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(screen.queryByTestId("issues-button")).toBeNull();
        expectStaleInert(stale, oldProps, view, [sharedCallbacks]);
        boundaryReached = true;
      },
    });

    expect(boundaryReached).toBe(true);
    const current = await captureActions({ compact: true });
    act(() => activateCurrent(current, compactProps));
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(controlled.themeSetter).toHaveBeenCalledOnce();
    expect(controlled.themeSetter).toHaveBeenCalledWith("light");
    expect(sharedCallbacks.shortcuts).toHaveBeenCalledOnce();
    expect(sharedCallbacks.issue).not.toHaveBeenCalled();
    expectStaleInert(stale, oldProps, view, [sharedCallbacks]);
  });

  it("gives an equal-value remount and replacement DOM isolated claims", async () => {
    const passiveCleanup = vi.fn();
    const sharedCallbacks = callbacks();
    const sharedProps = statusProps(sharedCallbacks);
    const view = await renderDirect(<StatusBoundary props={sharedProps} onPassiveCleanup={passiveCleanup} />);
    const stale = await captureActions();
    const oldRoot = screen.getByTestId("status-bar");
    let boundaryReached = false;

    await renderBoundary(view, sharedProps, {
      mount: "replacement",
      boundary: 1,
      passiveGeneration: "equal-remount",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(screen.getByTestId("status-bar")).not.toBe(oldRoot);
        expectStaleInert(stale, sharedProps, view, [sharedCallbacks]);
        boundaryReached = true;
      },
    });

    expect(boundaryReached).toBe(true);
    const current = await captureActions();
    act(() => activateCurrent(current, sharedProps));
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(sharedCallbacks.layout).toHaveBeenCalledOnce();
    expect(sharedCallbacks.wrapping).toHaveBeenCalledOnce();
    expect(sharedCallbacks.syncScroll).toHaveBeenCalledOnce();
    expect(sharedCallbacks.issue).toHaveBeenCalledOnce();
    expect(sharedCallbacks.shortcuts).toHaveBeenCalledOnce();
    expect(sharedCallbacks.storage).toHaveBeenCalledOnce();
    expectStaleInert(stale, sharedProps, view, [sharedCallbacks]);
  });

  it("retires every control before removal reaches the parent layout boundary and passive cleanup", async () => {
    const passiveCleanup = vi.fn();
    const currentCallbacks = callbacks();
    const props = statusProps(currentCallbacks);
    const view = await renderDirect(<StatusBoundary props={props} onPassiveCleanup={passiveCleanup} />);
    const stale = await captureActions();

    await renderBoundary(view, props, {
      present: false,
      boundary: 1,
      passiveGeneration: "removed",
      onPassiveCleanup: passiveCleanup,
      onBoundary: () => {
        expect(passiveCleanup).not.toHaveBeenCalled();
        expect(screen.queryByTestId("status-bar")).toBeNull();
        const focusTarget = document.createElement("button");
        document.body.prepend(focusTarget);
        focusTarget.focus();
        const html = document.body.innerHTML;
        const before = allCallCounts([currentCallbacks]);
        stale.menuOpen(false);
        stale.issuesOpen?.(false);
        stale.layout("code");
        stale.wrapping(true);
        stale.syncScroll(false);
        stale.issue?.(clickProbe().event);
        stale.desktopShortcuts?.(clickProbe().event);
        stale.storage?.(clickProbe().event);
        expect(allCallCounts([currentCallbacks])).toEqual(before);
        expect(document.body.innerHTML).toBe(html);
        expect(document.activeElement).toBe(focusTarget);
        focusTarget.remove();
      },
    });

    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(currentCallbacks.layout).not.toHaveBeenCalled();
    expect(currentCallbacks.wrapping).not.toHaveBeenCalled();
    expect(currentCallbacks.syncScroll).not.toHaveBeenCalled();
    expect(currentCallbacks.issue).not.toHaveBeenCalled();
    expect(currentCallbacks.shortcuts).not.toHaveBeenCalled();
    expect(currentCallbacks.storage).not.toHaveBeenCalled();
  });
});
