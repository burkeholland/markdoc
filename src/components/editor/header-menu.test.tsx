// @vitest-environment jsdom
import { StrictMode, type ComponentProps, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TooltipProvider } from "@/components/ui/primitives";
import type { DocumentDto } from "@/server/dto";
import type { SyncStatusDto } from "@/lib/api";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) {
        this.awareness = new Awareness(opts.document);
      }
      destroy() {
        this.awareness.destroy();
      }
    },
  };
});

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { Header } from "./header";

type HeaderProps = ComponentProps<typeof Header>;
type HeaderActions = Pick<
  HeaderProps,
  "onHistory" | "onNameVersion" | "onDuplicate" | "onDelete"
>;

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const DOC: DocumentDto = {
  id: "menu-document",
  title: "Menu source",
  storage: "local",
  linkAccess: "private",
  linkPreview: false,
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const sessions: CollabSession[] = [];
const views: DirectView[] = [];

function createSession(
  docId = DOC.id,
  role: CollabSession["role"] = "owner",
) {
  const session = new CollabSession({
    docId,
    user: makeCollabUser("owner-1", "Owner One", null, null),
    role,
    autoConnect: false,
    getToken: async () => {
      throw new Error("No provider connection permitted");
    },
  });
  session.keepAlive();
  session.localLoaded = true;
  session.synced = true;
  sessions.push(session);
  return session;
}

function createActions(): HeaderActions {
  return {
    onHistory: vi.fn(),
    onNameVersion: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
  };
}

function headerProps(
  session: CollabSession,
  actions: HeaderActions,
  overrides: Partial<HeaderProps> = {},
): HeaderProps {
  return {
    session,
    doc: DOC,
    commentsOpen: false,
    onToggleComments: vi.fn(),
    onOpenNotification: vi.fn(),
    onShare: vi.fn(),
    onPublish: vi.fn(),
    onPublishNow: vi.fn(),
    onPull: vi.fn(),
    onSync: vi.fn(),
    sync: null,
    onHistory: actions.onHistory,
    onMoreMenuOpen: vi.fn(),
    onActivity: vi.fn(),
    onShortcuts: vi.fn(),
    onCommandPalette: vi.fn(),
    onDelete: actions.onDelete,
    onDuplicate: actions.onDuplicate,
    onDownload: vi.fn(),
    onCopyMarkdown: vi.fn(),
    onNameVersion: actions.onNameVersion,
    documentMutation: null,
    publishing: false,
    isOwner: true,
    githubConfigured: true,
    onHome: vi.fn(),
    layout: "rich",
    onLayout: vi.fn(),
    onOutline: vi.fn(),
    compact: false,
    ...overrides,
  };
}

async function renderStrict(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const view = { host, root };
  views.push(view);
  await act(async () => {
    root.render(<StrictMode>{node}</StrictMode>);
  });
  return {
    ...view,
    render: async (next: ReactNode) => {
      await act(async () => {
        root.render(<StrictMode>{next}</StrictMode>);
      });
    },
  };
}

function header(props: HeaderProps, outside = false) {
  return (
    <TooltipProvider>
      <Header {...props} />
      {outside && <button type="button">Outside menu</button>}
    </TooltipProvider>
  );
}

function trigger() {
  return screen.getByTestId("more-menu");
}

function openMenu() {
  fireEvent(
    trigger(),
    new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    }),
  );
  return screen.getByRole("menu");
}

function item(name: MoreActionName) {
  if (name === "history") return screen.getByTestId("menu-history");
  if (name === "name-version") {
    return screen.getByRole("menuitem", { name: "Name current version" });
  }
  if (name === "duplicate") return screen.getByTestId("menu-duplicate");
  return screen.getByTestId("menu-delete");
}

type MoreActionName = "history" | "name-version" | "duplicate" | "delete";

async function waitForOutsideListener() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object"
        && candidate !== null
        && "isTrusted" in candidate
        && candidate.isTrusted === false,
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
  if (!event.isTrusted) throw new Error("The jsdom event trust slot did not update");
}

function publishTrigger() {
  return screen.getByTestId("publish-menu") as HTMLButtonElement;
}

function publishArrow(
  key: "ArrowDown" | "ArrowUp",
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const button = publishTrigger();
  const ownerWindow = button.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Publish trigger has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    key,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  act(() => button.dispatchEvent(event));
  return event;
}

function linkedDocument(
  githubUrl: string | null = "https://github.com/o/r/blob/main/doc.md",
): DocumentDto {
  return {
    ...DOC,
    storage: "repo",
    repoOwner: "o",
    repoName: "r",
    repoBranch: "main",
    repoPath: "doc.md",
    publishedAt: "2026-09-08T01:00:00.000Z",
    githubUrl,
  };
}

function syncStatus(status: SyncStatusDto["status"] = "in-sync"): SyncStatusDto {
  return {
    status,
    remote: {
      sha: "abc123",
      revision: "abc123",
      url: "https://github.com/o/r/blob/main/doc.md",
      updatedAt: null,
    },
    localChanged: false,
    remoteChanged: status === "remote-unreadable",
    lines: { local: 0, remote: 0 },
    ...(status === "remote-unreadable"
      ? { size: 3_000_000, limit: 2_097_152 }
      : {}),
  };
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
  const eventTargetAdd = EventTarget.prototype.addEventListener;
  const eventTargetRemove = EventTarget.prototype.removeEventListener;
  const windowAdd = window.addEventListener;
  const windowRemove = window.removeEventListener;
  // jsdom's Window methods do not delegate through EventTarget.prototype.
  vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(
    function (this: EventTarget, type, callback, options) {
      if (callback === null) return;
      if (this === window) windowAdd.call(window, type, callback, options);
      else eventTargetAdd.call(this, type, callback, options);
    },
  );
  vi.spyOn(EventTarget.prototype, "removeEventListener").mockImplementation(
    function (this: EventTarget, type, callback, options) {
      if (callback === null) return;
      if (this === window) windowRemove.call(window, type, callback, options);
      else eventTargetRemove.call(this, type, callback, options);
    },
  );
});

afterEach(async () => {
  for (const view of views.splice(0)) {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
  for (const session of sessions.splice(0)) session.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("editor header More menu authority", () => {
  it("keeps genuine selection usable after a pre-mount body decoy", async () => {
    const session = createSession();
    const actions = createActions();
    let history: HTMLElement | null = null;
    document.body.addEventListener("click", (event) => {
      if (!history || event.target !== history) return;
      history.dispatchEvent(new CustomEvent("menu.itemSelect", {
        bubbles: true,
        cancelable: true,
      }));
    }, { once: true });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    history = item("history");

    fireEvent.click(history);

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the exact native selection through a mid-dispatch microtask checkpoint", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    vi.useFakeTimers({ toFake: ["queueMicrotask"] });
    history.addEventListener("click", () => {
      vi.runAllTicks();
    }, { capture: true, once: true });

    try {
      fireEvent.click(history);
    } finally {
      vi.runAllTicks();
      vi.useRealTimers();
    }

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([
    ["history", "onHistory"],
    ["name-version", "onNameVersion"],
    ["duplicate", "onDuplicate"],
    ["delete", "onDelete"],
  ] as const)("runs the current %s action exactly once through direct-root Strict Mode", async (name, callback) => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    await userEvent.click(item(name));

    expect(actions[callback]).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("preserves the realm CustomEvent constructor and restores item dispatch", async () => {
    const session = createSession();
    const actions = createActions();
    const CustomEventConstructor = window.CustomEvent;
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");

    expect(window.CustomEvent).toBe(CustomEventConstructor);
    fireEvent.click(history);

    expect(history.dispatchEvent).toBe(EventTarget.prototype.dispatchEvent);
  });

  it("restores a fresh item's exact dispatch descriptor after selection", async () => {
    const nativeSetAttribute = Element.prototype.setAttribute;
    const originalDispatch = function (this: EventTarget, event: Event) {
      return Reflect.apply(EventTarget.prototype.dispatchEvent, this, [event]) as boolean;
    };
    const originalDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      value: originalDispatch,
      writable: false,
    };
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
      function (this: Element, name: string, value: string) {
        Reflect.apply(nativeSetAttribute, this, [name, value]);
        if (name === "data-testid" && value === "menu-history") {
          Object.defineProperty(this, "dispatchEvent", originalDescriptor);
        }
      },
    );
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    setAttribute.mockRestore();
    const history = item("history");

    fireEvent.click(history);

    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(originalDescriptor);
  });

  it("keeps conditional permissions, disabled mutations, labels, classes, and icons exact", async () => {
    const viewer = createSession(DOC.id, "viewer");
    const actions = createActions();
    const view = await renderStrict(
      header(headerProps(viewer, actions, {
        isOwner: false,
        documentMutation: "duplicate",
      })),
    );
    openMenu();

    expect(screen.queryByRole("menuitem", { name: "Name current version" })).toBeNull();
    expect(screen.queryByTestId("menu-delete")).toBeNull();
    expect(item("history")).toHaveTextContent("Version history");
    expect(item("history").querySelector(".lucide-rotate-ccw-clock")).not.toBeNull();
    expect(item("duplicate")).toHaveTextContent("Making a copy…");
    expect(item("duplicate")).toHaveClass("menu-item");
    expect(item("duplicate")).toHaveAttribute("aria-disabled", "true");
    expect(item("duplicate")).toHaveAttribute("aria-busy", "true");
    expect(item("duplicate").querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(item("duplicate"));
    expect(actions.onDuplicate).not.toHaveBeenCalled();

    fireEvent.keyDown(item("history"), { key: "Escape" });
    const owner = createSession();
    await view.render(header(headerProps(owner, actions)));
    openMenu();
    expect(item("delete")).toHaveClass("menu-item", "text-danger");
    expect(item("delete").querySelector(".lucide-trash-2")).not.toBeNull();
  });

  it("preserves keyboard selection, Escape, outside dismissal, and focus return", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions), true));
    const menuTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside menu" });

    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    await waitFor(() => expect(item("history")).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    expect(actions.onHistory).toHaveBeenCalledOnce();
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    fireEvent.keyDown(item("history"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("preserves close and focus behavior for existing unowned items and window blur", async () => {
    const session = createSession();
    const actions = createActions();
    const onActivity = vi.fn();
    await renderStrict(header(headerProps(session, actions, { onActivity })));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByTestId("menu-activity"));
    expect(onActivity).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(menuTrigger).toHaveFocus());

    openMenu();
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes generic selections that synchronously change header facts", async () => {
    const activitySession = createSession();
    const activityActions = createActions();
    const activity = vi.fn();
    const baseProps = headerProps(activitySession, activityActions);
    function ActivityHeader() {
      const [commentsOpen, setCommentsOpen] = useState(true);
      return (
        <Header
          {...baseProps}
          commentsOpen={commentsOpen}
          onActivity={() => {
            activity();
            setCommentsOpen(false);
          }}
        />
      );
    }
    await renderStrict(
      <TooltipProvider>
        <ActivityHeader />
      </TooltipProvider>,
    );

    openMenu();
    fireEvent.click(screen.getByTestId("menu-activity"));
    expect(activity).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  // Basic coverage for the #2203 plain-select close path, not a regression guard: fireEvent.click
  // dispatches synchronously from script, the same way Radix's Enter handling does, so these pass
  // against main's unmodified header.tsx too - jsdom can't reproduce the real (trusted) mouse
  // click's async timing that actually causes the menu to stay open. The regression guards are
  // the mouse-driven e2e/reader.spec.ts:182 test and the e2e/prod-smoke.spec.ts "Open reader view"
  // test, both of which fail against main's header.tsx and pass against this PR's.
  it("closes before opening the reader view in a new tab (basic coverage)", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByTestId("menu-reader"));
    expect(window.open).toHaveBeenCalledWith(`/p/${DOC.id}`, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes before opening a linked document's GitHub URL in a new tab (basic coverage)", async () => {
    const session = createSession();
    const actions = createActions();
    const linkedDoc: DocumentDto = {
      ...DOC,
      storage: "repo",
      repoOwner: "o",
      repoName: "r",
      repoBranch: "main",
      repoPath: "doc.md",
      githubUrl: "https://github.com/o/r/blob/main/doc.md",
    };
    await renderStrict(header(headerProps(session, actions, { doc: linkedDoc })));
    const menuTrigger = trigger();
    menuTrigger.focus();

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on GitHub" }));
    expect(window.open).toHaveBeenCalledWith(linkedDoc.githubUrl, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes the Publish menu's own Open on GitHub item before opening the URL (basic coverage; Publish's onOpenChange close path was never affected by #2203)", async () => {
    const doc = linkedDocument();
    const props = headerProps(createSession(doc.id, "viewer"), createActions(), {
      doc,
      sync: syncStatus(),
      isOwner: false,
    });
    await renderStrict(header(props));
    const menuTrigger = publishTrigger();
    menuTrigger.focus();

    fireEvent(
      menuTrigger,
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      }),
    );
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open on GitHub" }));
    expect(window.open).toHaveBeenCalledWith(doc.githubUrl, "_blank", "noopener");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes a compact Mode selection that changes the current session mode", async () => {
    const session = createSession();
    const actions = createActions();
    const setMode = vi.spyOn(session, "setMode");
    await renderStrict(header(headerProps(session, actions, { compact: true })));
    const menuTrigger = trigger();
    menuTrigger.focus();
    fireEvent.keyDown(menuTrigger, { key: "ArrowDown" });
    const viewing = await screen.findByRole("menuitemradio", { name: /Viewing/ });
    viewing.focus();

    await userEvent.keyboard("{Enter}");
    expect(setMode).toHaveBeenCalledExactlyOnceWith("viewing");
    expect(session.mode).toBe("viewing");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("consumes one delete confirmation choice and leaves a fresh successor exact", async () => {
    const session = createSession();
    const mutation = vi.fn();
    const confirmDelete = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const actions = createActions();
    actions.onDelete = vi.fn(() => {
      if (confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`)) {
        mutation();
      }
    });
    await renderStrict(header(headerProps(session, actions)));

    openMenu();
    fireEvent.click(item("delete"));
    expect(confirmDelete).toHaveBeenCalledExactlyOnceWith(
      "Move “Menu source” to trash? You can restore it from the dashboard for 30 days.",
    );
    expect(mutation).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("delete"));
    expect(confirmDelete).toHaveBeenCalledTimes(2);
    expect(mutation).toHaveBeenCalledOnce();
  });
});

describe("editor header Publish options directional focus", () => {
  it.each([
    ["ArrowDown", "Gist or repository…"],
    ["ArrowUp", "Share link…"],
  ] as const)("opens an unlinked owner menu with %s at %s", async (key, destination) => {
    const props = headerProps(createSession(), createActions());
    const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
    const dispatchEvent = vi.spyOn(window.EventTarget.prototype, "dispatchEvent");
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    await renderStrict(header(props));
    publishTrigger().focus();
    focus.mockClear();

    const event = publishArrow(key);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: destination })).toHaveFocus());
    const content = screen.getByRole("menu");
    const autoFocusDeliveries = dispatchEvent.mock.calls.flatMap(
      (args, index) =>
        args[0] instanceof window.CustomEvent
        && args[0].type === "focusScope.autoFocusOnMount"
        && dispatchEvent.mock.contexts[index] === content
          ? [args[0]]
          : [],
    );
    expect(autoFocusDeliveries).toHaveLength(1);
    expect(autoFocusDeliveries[0]!.target).toBe(content);
    expect(autoFocusDeliveries[0]!.defaultPrevented).toBe(true);
    expect(
      preventDefault.mock.contexts.filter((context) => context === autoFocusDeliveries[0]),
    ).toHaveLength(1);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(screen.getByRole("menuitem", { name: destination }));
    expect(props.onPublish).not.toHaveBeenCalled();
    expect(props.onDownload).not.toHaveBeenCalled();
    expect(props.onShare).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each([
    ["owner without GitHub", "owner", true],
    ["editor", "editor", false],
    ["viewer", "viewer", false],
  ] as const)(
    "skips the disabled first action for an unlinked %s",
    async (_name, role, isOwner) => {
      const props = headerProps(createSession(DOC.id, role), createActions(), {
        isOwner,
        githubConfigured: false,
      });
      await renderStrict(header(props));
      publishTrigger().focus();

      publishArrow("ArrowDown");

      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Download Markdown" })).toHaveFocus());
      expect(screen.getByRole("menuitem", { name: /Gist or repository/ }))
        .toHaveAttribute("aria-disabled", "true");
      expect(props.onPublish).not.toHaveBeenCalled();
      expect(props.onDownload).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["owner", "owner", true, "Commit to GitHub…", "Change connection…"],
    ["editor", "editor", false, "Commit to GitHub…", "Open on GitHub"],
    ["viewer", "viewer", false, "Open on GitHub", "Open on GitHub"],
  ] as const)(
    "uses exact linked %s enabled endpoints",
    async (_name, role, isOwner, first, last) => {
      const doc = linkedDocument();
      const props = headerProps(createSession(doc.id, role), createActions(), {
        doc,
        sync: syncStatus(),
        isOwner,
      });
      const view = await renderStrict(header(props));
      publishTrigger().focus();
      publishArrow("ArrowDown");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: first })).toHaveFocus());
      fireEvent.keyDown(screen.getByRole("menuitem", { name: first }), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      await view.render(header({ ...props }));
      publishTrigger().focus();
      publishArrow("ArrowUp");
      await waitFor(() => expect(screen.getByRole("menuitem", { name: last })).toHaveFocus());

      expect(props.onPublishNow).not.toHaveBeenCalled();
      expect(props.onPull).not.toHaveBeenCalled();
      expect(props.onSync).not.toHaveBeenCalled();
      expect(props.onPublish).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  it("skips an unreadable Pull row and chooses the optional last action", async () => {
    const doc = linkedDocument();
    const props = headerProps(createSession(doc.id, "editor"), createActions(), {
      doc,
      sync: syncStatus("remote-unreadable"),
      isOwner: false,
    });
    await renderStrict(header(props));
    publishTrigger().focus();

    publishArrow("ArrowUp");

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Open on GitHub" })).toHaveFocus());
    expect(screen.getByRole("menuitem", { name: "Pull latest from GitHub" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(props.onPull).not.toHaveBeenCalled();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it("retains pointer, Enter, Space, item activation, Escape, and outside close", async () => {
    const props = headerProps(createSession(), createActions());
    await renderStrict(header(props, true));
    const outside = screen.getByRole("button", { name: "Outside menu" });

    fireEvent.pointerDown(publishTrigger(), {
      bubbles: true,
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Download Markdown" }));
    expect(props.onDownload).toHaveBeenCalledExactlyOnceWith("md", false);

    publishTrigger().focus();
    fireEvent.keyDown(publishTrigger(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(publishTrigger()).toHaveFocus());

    fireEvent.keyDown(publishTrigger(), { key: " " });
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
