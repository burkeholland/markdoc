// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("StatusBar · real input", () => {
  it("opens the View menu by click and changes layout, wrapping and sync scrolling", async () => {
    const user = userEvent.setup();
    const current = callbacks();
    await renderDirect(<StatusBar {...statusProps(current)} />);
    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByRole("menuitemradio", { name: /Code only/ }));
    expect(current.layout).toHaveBeenCalledExactlyOnceWith("code");

    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /Wrap long lines/ }));
    expect(current.wrapping).toHaveBeenCalledExactlyOnceWith(true);

    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByTestId("sync-scroll-toggle"));
    expect(current.syncScroll).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not report re-selecting the current layout", async () => {
    const user = userEvent.setup();
    const current = callbacks();
    await renderDirect(<StatusBar {...statusProps(current, { layout: "split" })} />);
    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByRole("menuitemradio", { name: /Code and preview/ }));
    expect(current.layout).not.toHaveBeenCalled();
  });

  it("opens the menu from the keyboard focusing the first or last item, and Escape returns focus", async () => {
    const user = userEvent.setup();
    await renderDirect(<StatusBar {...statusProps(callbacks())} />);
    const trigger = screen.getByTestId("layout-menu");
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menuitemradio", { name: /Code and preview/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("status-menu-content")).toBeNull();
    expect(trigger).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(await screen.findByTestId("sync-scroll-toggle")).toHaveFocus();
  });

  it("selects an issue from the issues popover", async () => {
    const user = userEvent.setup();
    const current = callbacks();
    await renderDirect(<StatusBar {...statusProps(current)} />);
    await user.click(screen.getByTestId("issues-button"));
    await user.click(await screen.findByRole("button", { name: /Use a descriptive link/ }));
    expect(current.issue).toHaveBeenCalledExactlyOnceWith(ISSUE_A);
  });

  it("opens issues with ArrowDown focusing the first row", async () => {
    const user = userEvent.setup();
    await renderDirect(<StatusBar {...statusProps(callbacks())} />);
    screen.getByTestId("issues-button").focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("button", { name: /Use a descriptive link/ })).toHaveFocus();
  });

  it("activates storage and shortcuts buttons, and disables storage without a handler", async () => {
    const user = userEvent.setup();
    const current = callbacks();
    const view = await renderDirect(<StatusBar {...statusProps(current)} />);
    await user.click(screen.getByTestId("storage-indicator"));
    await user.click(screen.getByRole("button", { name: "Help and shortcuts" }));
    expect(current.storage).toHaveBeenCalledOnce();
    expect(current.shortcuts).toHaveBeenCalledOnce();
    await act(async () => view.root.render(<StatusBar {...statusProps(current, { onStorage: undefined })} />));
    expect(screen.getByTestId("storage-indicator")).toBeDisabled();
  });

  it("moves focus across top-level controls with arrow keys without wrapping", async () => {
    const user = userEvent.setup();
    await renderDirect(<StatusBar {...statusProps(callbacks())} />);
    const stats = screen.getByTestId("stats-button");
    stats.focus();
    await user.keyboard("{ArrowLeft}");
    expect(stats).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("layout-menu")).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Help and shortcuts" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(stats).toHaveFocus();
  });

  it("picks a theme and opens help from the compact menu", async () => {
    const user = userEvent.setup();
    const current = callbacks();
    await renderDirect(<StatusBar {...statusProps(current, { compact: true, layout: "code" })} />);
    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByTestId("menu-theme-dark"));
    expect(controlled.themeSetter).toHaveBeenCalledExactlyOnceWith("dark");
    await user.click(screen.getByTestId("layout-menu"));
    await user.click(await screen.findByRole("menuitem", { name: /Help and shortcuts/ }));
    expect(current.shortcuts).toHaveBeenCalledOnce();
  });
});
