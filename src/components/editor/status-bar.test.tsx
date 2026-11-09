// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  StrictMode,
  type ReactNode,
} from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
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

const directViews: DirectView[] = [];
const fakeSessionDisposals: (() => void)[] = [];
const fakeSessionSelections = new WeakMap<
  CollabSession,
  (from: number, to: number) => void
>();
const fakeSessionReadiness = new WeakMap<
  CollabSession,
  (ready: boolean) => void
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
  let contentReady = true;
  const notify = () => {
    version += 1;
    [...subscribers].forEach((listener) => listener());
  };
  ydoc.on("update", notify);
  const session = {
    name,
    binding: { getTree: () => controlled.sessionValue },
    get contentReady() {
      return contentReady;
    },
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
  fakeSessionReadiness.set(session, (ready) => {
    contentReady = ready;
    notify();
  });
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

async function nextTask() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
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
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "PointerEvent");
});

describe("status bar Strict Mode controls", () => {

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

  it("covers every accepted desktop source and destination in committed order", async () => {
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
});

describe("status bar nested StatsPopover reconciliation", () => {
  it("shows a real zero-word count once an empty document is ready", async () => {
    const current = callbacks();
    controlled.sessionValue = { text: "", tree: {} };

    await renderStatus(statusProps(current));

    expect(screen.getByTestId("word-count")).toHaveTextContent("0 words");
  });

  it("shows zero words for matching empty sources only after the session reports readiness", async () => {
    const actual = await vi.importActual<typeof import("./use-session")>("./use-session");
    controlled.sessionHook.mockImplementation(actual.useDebouncedSessionValue);
    controlled.sessionValue = { text: "", tree: {} };
    const props = statusProps(callbacks());
    const setContentReady = fakeSessionReadiness.get(props.session)!;
    setContentReady(false);

    await renderStatus(props);
    const count = screen.getByTestId("word-count");
    expect(count).toHaveTextContent("— words");

    await act(async () => setContentReady(true));

    expect(screen.getByTestId("word-count")).toBe(count);
    expect(count).toHaveTextContent("0 words");
  });

  it("waits for the initial source snapshot, then keeps the prior count during edits", async () => {
    const current = callbacks();
    const populated = { text: Array.from({ length: 20 }, () => "word").join(" "), tree: {} };
    const edited = { text: `${populated.text} extra`, tree: {} };
    controlled.sessionValue = populated;
    controlled.sessionHook.mockReturnValue({ text: "", tree: {} });
    const props = statusProps(current);
    const view = await renderStatus(props);
    const rerender = () => act(async () => view.root.render(
      <StrictMode>
        <StatusBar key="initial" {...props} doc={documentDto()} />
      </StrictMode>,
    ));
    const count = screen.getByTestId("word-count");

    expect(count).toHaveTextContent("— words");

    controlled.sessionHook.mockReturnValue(populated);
    await rerender();
    expect(screen.getByTestId("word-count")).toBe(count);
    expect(count).toHaveTextContent("20 words");

    controlled.sessionValue = edited;
    controlled.sessionHook.mockReturnValue(populated);
    await rerender();
    expect(screen.getByTestId("word-count")).toBe(count);
    expect(count).toHaveTextContent("20 words");

    controlled.sessionHook.mockReturnValue(edited);
    await rerender();
    expect(screen.getByTestId("word-count")).toBe(count);
    expect(count).toHaveTextContent("21 words");
  });

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
