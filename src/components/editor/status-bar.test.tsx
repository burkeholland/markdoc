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
type SelectHandler = (event: Event) => void;
type SourceHandler = (event: { currentTarget: EventTarget | null }) => void;
type OutsideHandler = (event: CustomEvent<{ originalEvent: Event }>) => void;

interface ValueAction<T> {
  (value: T): void;
  raw: ValueHandler<T>;
  items: Map<string, { element: HTMLElement; select: SelectHandler }>;
}

interface DirectAction<T> {
  (event: T): void;
  raw: (event: T) => void;
  element: HTMLElement;
}

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
  menuTrigger: HTMLElement;
  authorizeMenu: SourceHandler;
  menuContent: HTMLElement;
  authorizeMenuContent: SourceHandler;
  authorizeMenuOutside: OutsideHandler;
  issuesTrigger?: HTMLElement;
  authorizeIssues?: SourceHandler;
  issuesContent?: HTMLElement;
  authorizeIssuesContent?: SourceHandler;
  authorizeIssuesOutside?: OutsideHandler;
  layout: ValueAction<string>;
  wrapping: ValueAction<boolean | "indeterminate">;
  syncScroll: ValueAction<boolean | "indeterminate">;
  theme?: ValueAction<string>;
  compactShortcuts?: DirectAction<Event>;
  desktopShortcuts?: DirectAction<ReactMouseEvent<HTMLElement>>;
  storage?: DirectAction<ReactMouseEvent<HTMLElement>>;
  issue?: DirectAction<ReactMouseEvent<HTMLElement>>;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

interface ReactFiber {
  alternate?: ReactFiber | null;
  elementType?: { displayName?: string; name?: string } | string;
  memoizedProps?: Record<string, unknown>;
  return: ReactFiber | null;
  type?: { displayName?: string; name?: string } | string;
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

function handlerOwnedBy<T extends (...args: never[]) => unknown>(
  element: Element,
  name: string,
  owner: string,
): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const type = fiber.elementType;
    const typeName = typeof type === "string" ? type : type?.displayName ?? type?.name;
    const handler = fiber.memoizedProps?.[name];
    if (typeName === owner && typeof handler === "function") return handler as T;
    fiber = fiber.return;
  }
  throw new Error(`${name} owned by ${owner} was not found above ${element.tagName}`);
}

function reactHandler<T extends (...args: never[]) => unknown = ClickHandler>(element: Element, name = "onClick"): T {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
  if (!key) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown>>)[key];
  const handler = props[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

function withCurrentTarget<T extends { currentTarget: EventTarget | null }>(
  event: T,
  currentTarget: EventTarget | null,
) {
  return { ...event, currentTarget } as T;
}

function directAction<T extends { currentTarget: EventTarget | null }>(
  element: HTMLElement,
  handler: (event: T) => void,
): DirectAction<T> {
  const action = ((event: T) => handler(withCurrentTarget(event, element))) as DirectAction<T>;
  action.raw = handler;
  action.element = element;
  return action;
}

function selectEvent(currentTarget: EventTarget | null) {
  return {
    currentTarget,
    preventDefault: vi.fn(),
    defaultPrevented: false,
  } as unknown as Event;
}

function sourceEvent(currentTarget: EventTarget | null) {
  return {
    currentTarget,
    target: currentTarget,
    key: "Escape",
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
  };
}

function valueAction<T>(
  raw: ValueHandler<T>,
  items: Map<string, { element: HTMLElement; select: SelectHandler }>,
  represented: (value: T) => string | null,
): ValueAction<T> {
  const action = ((value: T) => {
    const itemValue = represented(value);
    const item = itemValue === null ? undefined : items.get(itemValue);
    if (item) item.select(selectEvent(item.element));
    else raw(value);
  }) as ValueAction<T>;
  action.raw = raw;
  action.items = items;
  return action;
}

async function openDisclosures(compact = false, alreadyOpen = false) {
  const menuTrigger = screen.getByTestId("layout-menu");
  const menuOpen = nearestHandler<ValueHandler<boolean>>(menuTrigger, "onOpenChange");
  const authorizeMenu = reactHandler<SourceHandler>(menuTrigger, "onPointerDownCapture");
  if (!alreadyOpen && menuTrigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
      await Promise.resolve();
    });
  }
  let issuesOpen: ValueHandler<boolean> | undefined;
  let issuesTrigger: HTMLElement | undefined;
  let authorizeIssues: SourceHandler | undefined;
  if (!compact) {
    const currentIssuesTrigger = screen.getByTestId("issues-button");
    issuesTrigger = currentIssuesTrigger;
    issuesOpen = nearestHandler<ValueHandler<boolean>>(currentIssuesTrigger, "onOpenChange");
    authorizeIssues = reactHandler<SourceHandler>(currentIssuesTrigger, "onClickCapture");
    if (!alreadyOpen && currentIssuesTrigger.getAttribute("aria-expanded") !== "true") {
      await act(async () => {
        fireEvent.click(currentIssuesTrigger);
        await Promise.resolve();
      });
    }
  }
  return { menuOpen, issuesOpen, menuTrigger, authorizeMenu, issuesTrigger, authorizeIssues };
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
  const layoutItems = new Map([
    ["code", { element: codeItem, select: nearestHandler<SelectHandler>(codeItem, "onSelect") }],
    ["rich", (() => {
      const element = elementWithText('[role="menuitemradio"]', "Preview only");
      return { element, select: nearestHandler<SelectHandler>(element, "onSelect") };
    })()],
  ]);
  if (!compact) {
    const element = elementWithText('[role="menuitemradio"]', "Code and preview");
    layoutItems.set("split", { element, select: nearestHandler<SelectHandler>(element, "onSelect") });
  }
  const wrappingItems = new Map([
    ["change", { element: wrapItem, select: nearestHandler<SelectHandler>(wrapItem, "onSelect") }],
  ]);
  const syncItems = new Map([
    ["change", { element: syncItem, select: nearestHandler<SelectHandler>(syncItem, "onSelect") }],
  ]);
  const wrappingNext = wrapItem.getAttribute("aria-checked") !== "true";
  const syncNext = syncItem.getAttribute("aria-checked") !== "true";
  const menuContent = screen.getByTestId("status-menu-content");
  const issueContent = disclosures.issuesTrigger
    ? screen.getByTestId("status-issues-content")
    : undefined;
  const actions: CapturedActions = {
    ...disclosures,
    menuContent,
    authorizeMenuContent: handlerOwnedBy<SourceHandler>(menuContent, "onPointerDownCapture", "MenuContent"),
    authorizeMenuOutside: handlerOwnedBy<OutsideHandler>(menuContent, "onPointerDownOutside", "MenuContent"),
    issuesContent: issueContent,
    authorizeIssuesContent: issueContent
      ? handlerOwnedBy<SourceHandler>(issueContent, "onKeyDownCapture", "PopoverContent")
      : undefined,
    authorizeIssuesOutside: issueContent
      ? handlerOwnedBy<OutsideHandler>(issueContent, "onPointerDownOutside", "PopoverContent")
      : undefined,
    layout: valueAction(
      nearestHandler<ValueHandler<string>>(codeItem, "onValueChange"),
      layoutItems,
      (value) => layoutItems.has(value) ? value : null,
    ),
    wrapping: valueAction(
      nearestHandler<ValueHandler<boolean | "indeterminate">>(wrapItem, "onCheckedChange"),
      wrappingItems,
      (value) => value === wrappingNext ? "change" : null,
    ),
    syncScroll: valueAction(
      nearestHandler<ValueHandler<boolean | "indeterminate">>(syncItem, "onCheckedChange"),
      syncItems,
      (value) => value === syncNext ? "change" : null,
    ),
    storage: storage
      ? directAction(storageButton, reactHandler<ClickHandler>(storageButton))
      : undefined,
  };
  if (compact) {
    const themeItems = new Map(
      ["light", "dark", "system"].map((theme) => {
        const element = screen.getByTestId(`menu-theme-${theme}`);
        return [theme, { element, select: nearestHandler<SelectHandler>(element, "onSelect") }] as const;
      }),
    );
    actions.theme = valueAction(
      nearestHandler<ValueHandler<string>>(screen.getByTestId("menu-theme-dark"), "onValueChange"),
      themeItems,
      (value) => themeItems.has(value) ? value : null,
    );
    const compactShortcuts = elementWithText('[role="menuitem"]', "Help and shortcuts");
    actions.compactShortcuts = directAction(
      compactShortcuts,
      nearestHandler<SelectHandler>(compactShortcuts, "onSelect"),
    );
  } else {
    const desktopShortcuts = document.querySelector<HTMLButtonElement>('button[aria-label="Help and shortcuts"]');
    if (!desktopShortcuts) throw new Error("Desktop shortcuts were not rendered");
    actions.desktopShortcuts = directAction(desktopShortcuts, reactHandler<ClickHandler>(desktopShortcuts));
    const issueButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .findLast((button) => button.textContent?.includes(issueMessage ?? ISSUE_A.message));
    actions.issue = issueButton
      ? directAction(issueButton, reactHandler<ClickHandler>(issueButton))
      : undefined;
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

function invokeWrongSources(actions: CapturedActions) {
  const foreign = document.createElement("button");
  const detached = document.createElement("button");
  document.body.prepend(foreign);
  const code = actions.layout.items.get("code");
  const rich = actions.layout.items.get("rich");
  const wrapping = actions.wrapping.items.get("change");
  const syncScroll = actions.syncScroll.items.get("change");
  if (!code || !rich || !wrapping || !syncScroll) throw new Error("Expected status menu controls");

  code.select(selectEvent(rich.element));
  code.select(selectEvent(foreign));
  code.select(selectEvent(detached));
  wrapping.select(selectEvent(syncScroll.element));
  wrapping.select(selectEvent(foreign));
  syncScroll.select(selectEvent(wrapping.element));
  syncScroll.select(selectEvent(detached));
  actions.issue?.raw(withCurrentTarget(clickProbe().event, actions.storage?.element ?? foreign));
  actions.desktopShortcuts?.raw(withCurrentTarget(clickProbe().event, actions.issue?.element ?? foreign));
  actions.compactShortcuts?.raw(selectEvent(actions.theme?.items.get("dark")?.element ?? foreign));
  actions.storage?.raw(withCurrentTarget(clickProbe().event, actions.desktopShortcuts?.element ?? foreign));

  const dark = actions.theme?.items.get("dark");
  const light = actions.theme?.items.get("light");
  if (dark && light) {
    dark.select(selectEvent(light.element));
    dark.select(selectEvent(foreign));
    dark.select(selectEvent(detached));
  }

  actions.authorizeMenu(sourceEvent(actions.issuesTrigger ?? foreign));
  actions.menuOpen(false);
  actions.authorizeMenu(sourceEvent(foreign));
  actions.menuOpen(false);
  actions.authorizeMenuContent(sourceEvent(actions.issuesContent ?? foreign));
  actions.menuOpen(false);
  actions.authorizeMenuContent(sourceEvent(detached));
  actions.menuOpen(false);
  actions.authorizeMenuOutside(sourceEvent(foreign) as unknown as CustomEvent<{ originalEvent: Event }>);
  actions.menuOpen(false);
  if (actions.authorizeIssues && actions.issuesOpen) {
    actions.authorizeIssues(sourceEvent(actions.menuTrigger));
    actions.issuesOpen(false);
    actions.authorizeIssues(sourceEvent(foreign));
    actions.issuesOpen(false);
    actions.authorizeIssuesContent?.(sourceEvent(actions.menuContent));
    actions.issuesOpen(false);
    actions.authorizeIssuesContent?.(sourceEvent(detached));
    actions.issuesOpen(false);
    actions.authorizeIssuesOutside?.(sourceEvent(foreign) as unknown as CustomEvent<{ originalEvent: Event }>);
    actions.issuesOpen(false);
  }

  foreign.remove();
}

function invokeCrossPublicationSources(stale: CapturedActions, current: CapturedActions) {
  const staleCode = stale.layout.items.get("code");
  const currentCode = current.layout.items.get("code");
  const staleWrapping = stale.wrapping.items.get("change");
  const currentWrapping = current.wrapping.items.get("change");
  const staleSync = stale.syncScroll.items.get("change");
  const currentSync = current.syncScroll.items.get("change");
  if (!staleCode || !currentCode || !staleWrapping || !currentWrapping || !staleSync || !currentSync)
    throw new Error("Expected cross-publication status controls");

  staleCode.select(selectEvent(currentCode.element));
  currentCode.select(selectEvent(staleCode.element));
  staleWrapping.select(selectEvent(currentWrapping.element));
  currentWrapping.select(selectEvent(staleWrapping.element));
  staleSync.select(selectEvent(currentSync.element));
  currentSync.select(selectEvent(staleSync.element));
  if (stale.issue && current.issue) {
    stale.issue.raw(withCurrentTarget(clickProbe().event, current.issue.element));
    current.issue.raw(withCurrentTarget(clickProbe().event, stale.issue.element));
  }
  if (stale.desktopShortcuts && current.desktopShortcuts) {
    stale.desktopShortcuts.raw(withCurrentTarget(clickProbe().event, current.desktopShortcuts.element));
    current.desktopShortcuts.raw(withCurrentTarget(clickProbe().event, stale.desktopShortcuts.element));
  }
  if (stale.storage && current.storage) {
    stale.storage.raw(withCurrentTarget(clickProbe().event, current.storage.element));
    current.storage.raw(withCurrentTarget(clickProbe().event, stale.storage.element));
  }

  stale.authorizeMenu(sourceEvent(current.menuTrigger));
  stale.menuOpen(false);
  current.authorizeMenu(sourceEvent(stale.menuTrigger));
  current.menuOpen(false);
  stale.authorizeMenuContent(sourceEvent(current.menuContent));
  stale.menuOpen(false);
  current.authorizeMenuContent(sourceEvent(stale.menuContent));
  current.menuOpen(false);
  if (
    stale.issuesTrigger
    && current.issuesTrigger
    && stale.authorizeIssues
    && current.authorizeIssues
    && stale.issuesOpen
    && current.issuesOpen
  ) {
    stale.authorizeIssues(sourceEvent(current.issuesTrigger));
    stale.issuesOpen(false);
    current.authorizeIssues(sourceEvent(stale.issuesTrigger));
    current.issuesOpen(false);
    stale.authorizeIssuesContent?.(sourceEvent(current.issuesContent ?? current.issuesTrigger));
    stale.issuesOpen(false);
    current.authorizeIssuesContent?.(sourceEvent(stale.issuesContent ?? stale.issuesTrigger));
    current.issuesOpen(false);
  }
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

  it.each([
    ["desktop, wrong before current", false, true],
    ["desktop, current before wrong", false, false],
    ["compact, wrong before current", true, true],
    ["compact, current before wrong", true, false],
  ] as const)(
    "rejects sibling, foreign, and detached event sources without suppressing %s",
    async (_name, compact, wrongFirst) => {
      const current = callbacks();
      const props = statusProps(current, compact ? { compact: true, layout: "code" } : {});
      const view = await renderDirect(<StatusBoundary props={props} onPassiveCleanup={() => {}} />);
      const actions = await captureActions({ compact });
      const beforeWrongHtml = view.host.innerHTML;
      const beforeWrongFocus = document.activeElement;

      if (!wrongFirst) act(() => activateCurrent(actions, props));
      const beforeWrong = allCallCounts([current]);
      invokeWrongSources(actions);

      expect(allCallCounts([current])).toEqual(beforeWrong);
      expect(view.host.innerHTML).toBe(beforeWrongHtml);
      expect(document.activeElement).toBe(beforeWrongFocus);
      expect(actions.menuTrigger).toHaveAttribute("aria-expanded", "true");
      if (actions.issuesTrigger) expect(actions.issuesTrigger).toHaveAttribute("aria-expanded", "true");

      if (wrongFirst) act(() => activateCurrent(actions, props));
      expect(current.layout).toHaveBeenCalledOnce();
      expect(current.wrapping).toHaveBeenCalledOnce();
      expect(current.syncScroll).toHaveBeenCalledOnce();
      expect(current.issue).toHaveBeenCalledTimes(compact ? 0 : 1);
      expect(current.shortcuts).toHaveBeenCalledOnce();
      expect(current.storage).toHaveBeenCalledOnce();
      expect(controlled.themeSetter).toHaveBeenCalledTimes(compact ? 1 : 0);

      act(() => {
        actions.authorizeMenu(sourceEvent(actions.menuTrigger));
        actions.menuOpen(false);
      });
      if (actions.issuesTrigger && actions.authorizeIssues && actions.issuesOpen) {
        act(() => {
          fireEvent.click(actions.issuesTrigger!);
        });
      }
      expect(actions.menuTrigger).toHaveAttribute("aria-expanded", "false");
      if (actions.issuesTrigger) expect(actions.issuesTrigger).toHaveAttribute("aria-expanded", "false");

      const afterClose = allCallCounts([current]);
      const closedHtml = view.host.innerHTML;
      invokeWrongSources(actions);
      expect(allCallCounts([current])).toEqual(afterClose);
      expect(view.host.innerHTML).toBe(closedHtml);
    },
  );

  it("retains current Escape and outside disclosure transitions from exact content events", async () => {
    const current = callbacks();
    const props = statusProps(current);
    await renderDirect(<StatusBoundary props={props} onPassiveCleanup={() => {}} />);
    const issuesTrigger = screen.getByTestId("issues-button");
    await act(async () => {
      fireEvent.click(issuesTrigger);
      await Promise.resolve();
    });
    expect(issuesTrigger).toHaveAttribute("aria-expanded", "true");
    const issuesContent = screen.getByTestId("status-issues-content");
    const issueEscape = handlerOwnedBy<SourceHandler>(
      issuesContent,
      "onKeyDownCapture",
      "PopoverContent",
    );
    const issueOpen = nearestHandler<ValueHandler<boolean>>(issuesTrigger, "onOpenChange");
    issueEscape(sourceEvent(issuesContent));
    act(() => issueOpen(false));
    expect(issuesTrigger).toHaveAttribute("aria-expanded", "false");

    const menuTrigger = screen.getByTestId("layout-menu");
    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
    expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
    const code = elementWithText('[role="menuitemradio"]', "Code only");
    const menuContent = screen.getByTestId("status-menu-content");
    const menuEscape = handlerOwnedBy<(event: KeyboardEvent) => void>(
      menuContent,
      "onEscapeKeyDown",
      "MenuContent",
    );
    const menuOpen = nearestHandler<ValueHandler<boolean>>(menuTrigger, "onOpenChange");
    menuContent.ownerDocument.addEventListener("keydown", menuEscape, { once: true });
    code.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    act(() => menuOpen(false));
    expect(menuTrigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
    expect(menuTrigger).toHaveAttribute("aria-expanded", "true");
    const outside = document.createElement("button");
    document.body.prepend(outside);
    const currentMenuContent = screen.getByTestId("status-menu-content");
    const menuOutside = handlerOwnedBy<OutsideHandler>(
      currentMenuContent,
      "onPointerDownOutside",
      "MenuContent",
    );
    const originalEvent = { target: outside } as unknown as Event;
    outside.addEventListener("dismissableLayer.pointerDownOutside", menuOutside as EventListener, { once: true });
    outside.dispatchEvent(new CustomEvent("dismissableLayer.pointerDownOutside", {
      detail: { originalEvent },
    }));
    act(() => nearestHandler<ValueHandler<boolean>>(menuTrigger, "onOpenChange")(false));
    expect(menuTrigger).toHaveAttribute("aria-expanded", "false");
    outside.remove();
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
    const beforeCrossPublication = allCallCounts([sharedCallbacks]);
    const html = view.host.innerHTML;
    invokeCrossPublicationSources(stale, current);
    expect(allCallCounts([sharedCallbacks])).toEqual(beforeCrossPublication);
    expect(view.host.innerHTML).toBe(html);
    act(() => activateCurrent(current, sharedProps));
    expect(passiveCleanup).toHaveBeenCalledOnce();
    expect(sharedCallbacks.layout).toHaveBeenCalledOnce();
    expect(sharedCallbacks.wrapping).toHaveBeenCalledOnce();
    expect(sharedCallbacks.syncScroll).toHaveBeenCalledOnce();
    expect(sharedCallbacks.issue).toHaveBeenCalledOnce();
    expect(sharedCallbacks.shortcuts).toHaveBeenCalledOnce();
    expect(sharedCallbacks.storage).toHaveBeenCalledOnce();
    const afterCurrent = allCallCounts([sharedCallbacks]);
    invokeCrossPublicationSources(stale, current);
    expect(allCallCounts([sharedCallbacks])).toEqual(afterCurrent);
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
