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

interface ReactFiber {
  return: ReactFiber | null;
  elementType?: string | { displayName?: string; name?: string };
  memoizedProps?: Record<string, unknown>;
  ref?: ((element: HTMLElement | null) => void) | { current: HTMLElement | null };
}

const DOC: DocumentDto = {
  id: "menu-document",
  title: "Menu source",
  storage: "local",
  linkAccess: "private",
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
type SelectHandler = (event: Event) => void;
type OpenHandler = (open: boolean) => void;
type EscapeHandler = (event: KeyboardEvent) => void;
type OutsideHandler = (event: CustomEvent<{ originalEvent: Event }>) => void;

function fiberFor(element: HTMLElement) {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  if (!key) throw new Error("React fiber was not attached");
  return (element as unknown as Record<string, ReactFiber>)[key]!;
}

function captureSelect(element: HTMLElement): SelectHandler {
  return captureHandler(element, "onSelect", "MenuItem");
}

function captureHandler<T>(
  element: HTMLElement,
  prop: string,
  ownerName?: string,
): T {
  let fiber: ReactFiber | null = fiberFor(element);
  while (fiber) {
    const type = fiber.elementType;
    const name = typeof type === "string" ? type : type?.displayName ?? type?.name;
    const handler = fiber.memoizedProps?.[prop];
    if ((!ownerName || name === ownerName) && typeof handler === "function") {
      return handler as T;
    }
    fiber = fiber.return;
  }
  throw new Error(`${prop} handler was not attached`);
}

function captureOpenChange() {
  return captureHandler<OpenHandler>(trigger(), "onOpenChange");
}

function captureEscape() {
  return captureHandler<EscapeHandler>(screen.getByRole("menu"), "onEscapeKeyDown", "MenuContent");
}

function captureOutside() {
  return captureHandler<OutsideHandler>(
    screen.getByRole("menu"),
    "onPointerDownOutside",
    "MenuContent",
  );
}

function captureFocusOutside() {
  return captureHandler<OutsideHandler>(
    screen.getByRole("menu"),
    "onFocusOutside",
    "MenuContent",
  );
}

function shadowEvent(event: Event, values: Readonly<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
}

function dispatchUnadmittedSelection(element: HTMLElement, select = captureSelect(element)) {
  const event = new CustomEvent("menu.itemSelect", {
    bubbles: true,
    cancelable: true,
  });
  element.addEventListener(
    "menu.itemSelect",
    (current) => {
      current.stopImmediatePropagation();
      select(current);
    },
    { once: true },
  );
  element.dispatchEvent(event);
  return event;
}

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

  it("retires unconsumed selection authority at the native window boundary", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const staleSelect = captureSelect(history);
    history.addEventListener("click", (event) => event.preventDefault(), { once: true });

    fireEvent.click(history);
    act(() => dispatchUnadmittedSelection(history, staleSelect));

    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(history);
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

  it("fails closed when a current item becomes non-extensible before replacement", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    Object.preventExtensions(history);

    await view.render(header({ ...props, commentsOpen: true }));

    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
  });

  it("fails closed when an owned item is non-extensible before publication", async () => {
    const nativeSetAttribute = Element.prototype.setAttribute;
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute").mockImplementation(
      function (this: Element, name: string, value: string) {
        Reflect.apply(nativeSetAttribute, this, [name, value]);
        if (name === "data-testid" && value === "menu-history") {
          void this.attributes;
          void this.children;
          void this.childNodes;
          void this.classList;
          void (this as HTMLElement).dataset;
          void (this as HTMLElement).style;
          Object.preventExtensions(this);
        }
      },
    );
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));

    openMenu();
    setAttribute.mockRestore();
    fireEvent.click(item("history"));

    expect(actions.onHistory).not.toHaveBeenCalled();
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

  it("does not overwrite a same-value foreign dispatch descriptor", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    const foreignDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      value: history.dispatchEvent,
      writable: false,
    };
    Object.defineProperty(history, "dispatchEvent", foreignDescriptor);

    await view.render(header({ ...props, commentsOpen: true }));

    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(foreignDescriptor);
    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();

    await view.render(<div key="fresh">{header(props)}</div>);
    openMenu();
    const freshHistory = item("history");
    expect(freshHistory).not.toBe(history);
    fireEvent.click(freshHistory);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("treats a foreign deletion before first cleanup as unsafe", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    expect(Object.prototype.hasOwnProperty.call(history, "dispatchEvent")).toBe(true);
    Reflect.deleteProperty(history, "dispatchEvent");

    await view.render(header({ ...props, commentsOpen: true }));

    expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toBeUndefined();
    fireEvent.click(history);
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
  });

  it.each(["data", "accessor"] as const)(
    "treats a foreign restoration of the original own %s descriptor as unsafe",
    async (kind) => {
      const nativeSetAttribute = Element.prototype.setAttribute;
      const originalDispatch = function (this: EventTarget, event: Event) {
        return Reflect.apply(EventTarget.prototype.dispatchEvent, this, [event]) as boolean;
      };
      const originalDescriptor: PropertyDescriptor = kind === "data"
        ? {
            configurable: true,
            enumerable: true,
            value: originalDispatch,
            writable: false,
          }
        : {
            configurable: true,
            enumerable: true,
            get: () => originalDispatch,
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
      const props = headerProps(session, actions);
      const view = await renderStrict(header(props));
      openMenu();
      setAttribute.mockRestore();
      const history = item("history");
      Object.defineProperty(history, "dispatchEvent", originalDescriptor);

      await view.render(header({ ...props, commentsOpen: true }));

      expect(Object.getOwnPropertyDescriptor(history, "dispatchEvent")).toEqual(
        originalDescriptor,
      );
      fireEvent.click(history);
      fireEvent.click(item("history"));
      expect(actions.onHistory).not.toHaveBeenCalled();
    },
  );

  it("treats foreign deletion of an outside-target observer as unsafe", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    let outside: HTMLElement | null = null;
    const deleteObserver = (event: PointerEvent) => {
      if (!outside || event.target !== outside) return;
      document.removeEventListener("pointerdown", deleteObserver);
      Reflect.deleteProperty(outside, "dispatchEvent");
    };
    document.addEventListener("pointerdown", deleteObserver);
    const view = await renderStrict(header(props, true));
    const outsideElement = screen.getByRole("button", { name: "Outside menu" });
    outside = outsideElement;
    openMenu();
    item("history").focus();
    await waitForOutsideListener();

    fireEvent.pointerDown(outsideElement, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(Object.getOwnPropertyDescriptor(outsideElement, "dispatchEvent")).toBeUndefined();
    await view.render(header({ ...props, commentsOpen: true }, true));
    await waitForOutsideListener();
    fireEvent.pointerDown(outsideElement, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("keeps a successor wrapper after its predecessor restores itself", async () => {
    const session = createSession();
    const actions = createActions();
    const props = headerProps(session, actions);
    const view = await renderStrict(header(props));
    openMenu();
    const history = item("history");
    const firstWrapper = history.dispatchEvent;

    await view.render(header({ ...props, commentsOpen: true }));
    const successorWrapper = history.dispatchEvent;
    expect(successorWrapper).not.toBe(firstWrapper);
    await act(async () => Promise.resolve());
    expect(history.dispatchEvent).toBe(successorWrapper);

    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
    expect(history.dispatchEvent).toBe(EventTarget.prototype.dispatchEvent);
  });

  it("rejects unadmitted and repeated custom selection without consuming a fresh action", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const select = captureSelect(history);

    act(() => {
      dispatchUnadmittedSelection(history, select);
      dispatchUnadmittedSelection(history, select);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(history);
    act(() => dispatchUnadmittedSelection(history, select));
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects a canceled owned click replay before callback or delete confirmation", async () => {
    const session = createSession();
    const actions = createActions();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(false);
    actions.onDelete = vi.fn(() => {
      confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`);
    });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const deleteItem = item("delete");
    const select = captureSelect(deleteItem);
    const canceledClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    deleteItem.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true, once: true });

    act(() => {
      deleteItem.dispatchEvent(canceledClick);
      shadowEvent(canceledClick, {
        currentTarget: document.body,
        defaultPrevented: false,
        eventPhase: Event.BUBBLING_PHASE,
        target: deleteItem,
        composedPath: () => [
          deleteItem,
          screen.getByRole("menu"),
          document.body,
          document.documentElement,
          document,
          window,
        ],
      });
      dispatchUnadmittedSelection(deleteItem, select);
    });
    expect(actions.onDelete).not.toHaveBeenCalled();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(deleteItem);
    expect(actions.onDelete).toHaveBeenCalledOnce();
    expect(confirmDelete).toHaveBeenCalledOnce();
  });

  it("rejects nested selection from a pre-mount window interceptor", async () => {
    const session = createSession();
    const actions = createActions();
    const confirmDelete = vi.spyOn(window, "confirm").mockReturnValue(false);
    actions.onDelete = vi.fn(() => {
      confirm(`Move “${DOC.title}” to trash? You can restore it from the dashboard for 30 days.`);
    });
    let deleteItem: HTMLElement | null = null;
    let decoy: CustomEvent | null = null;
    window.addEventListener("menu.itemSelect", (event) => {
      if (!deleteItem || !decoy || event.target !== deleteItem) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteItem.dispatchEvent(decoy);
    }, { capture: true, once: true });
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    deleteItem = item("delete");
    deleteItem.addEventListener("click", () => {
      decoy = new CustomEvent("menu.itemSelect", {
        bubbles: true,
        cancelable: true,
      });
    }, { capture: true, once: true });

    fireEvent.click(deleteItem);
    expect(actions.onDelete).not.toHaveBeenCalled();
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(deleteItem);
    expect(actions.onDelete).toHaveBeenCalledOnce();
    expect(confirmDelete).toHaveBeenCalledOnce();
  });

  it("rejects plain and prototype-only public event shells without throwing", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const select = captureSelect(history);
    const plainShell = {
      type: "menu.itemSelect",
      target: history,
      currentTarget: history,
      eventPhase: Event.AT_TARGET,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      detail: null,
      composedPath: () => [history, screen.getByRole("menu"), document.body, document],
    } as unknown as Event;
    const prototypeShell = Object.create(CustomEvent.prototype) as Event;

    act(() => {
      select(plainShell);
      select(prototypeShell);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();

    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects a crossed custom selection admitted by another action's native click", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const duplicate = item("duplicate");
    const selectDuplicate = captureSelect(duplicate);

    history.addEventListener("click", (event) => {
      event.stopImmediatePropagation();
      dispatchUnadmittedSelection(duplicate, selectDuplicate);
    }, { capture: true, once: true });
    act(() => {
      history.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
    });

    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(actions.onDuplicate).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it("retires a partial item-ref replay without consuming its complete successor", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    openMenu();
    const history = item("history");
    const staleSelect = captureSelect(history);
    const ref = fiberFor(history).ref;
    if (typeof ref !== "function") throw new Error("History callback ref was not attached");

    act(() => {
      ref(null);
      ref(history);
      dispatchUnadmittedSelection(history, staleSelect);
    });
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await waitFor(() => expect(item("history")).toBe(history));
    fireEvent.click(history);
    expect(actions.onHistory).toHaveBeenCalledOnce();
  });

  it.each(["attribute", "order", "item", "portal", "portal-ancestor", "placement"] as const)(
    "permanently retires restored %s mutation history and keeps a reopened successor usable",
    async (mutation) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions)));
      const content = openMenu();
      const history = item("history");

      act(() => {
        if (mutation === "attribute") {
          history.setAttribute("role", "option");
          history.setAttribute("role", "menuitem");
        } else if (mutation === "order") {
          const successor = history.nextSibling!;
          content.insertBefore(successor, history);
          content.insertBefore(history, successor);
        } else if (mutation === "item") {
          const parent = history.parentNode!;
          const successor = history.nextSibling;
          parent.removeChild(history);
          parent.insertBefore(history, successor);
        } else if (mutation === "portal") {
          const parent = content.parentNode!;
          parent.removeChild(content);
          parent.appendChild(content);
        } else if (mutation === "portal-ancestor") {
          const portal = content.parentNode!;
          const parent = portal.parentNode!;
          parent.removeChild(portal);
          parent.appendChild(portal);
        } else {
          const parent = content.parentNode!;
          const sibling = document.createElement("div");
          parent.insertBefore(sibling, content);
          sibling.remove();
        }
      });
      fireEvent.click(history);
      expect(actions.onHistory).not.toHaveBeenCalled();

      await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
      fireEvent.click(item("history"));
      expect(actions.onHistory).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );

  it("retires stale document and callback actions while preserving the current document", async () => {
    const firstSession = createSession();
    const first = createActions();
    const view = await renderStrict(header(headerProps(firstSession, first)));
    openMenu();
    const staleHistoryElement = item("history");
    const staleHistory = captureSelect(staleHistoryElement);

    const nextDoc = { ...DOC, id: "next-document", title: "Next source" };
    const nextSession = createSession(nextDoc.id);
    const next = createActions();
    await view.render(header(headerProps(nextSession, next, { doc: nextDoc })));
    act(() => dispatchUnadmittedSelection(staleHistoryElement, staleHistory));
    expect(first.onHistory).not.toHaveBeenCalled();
    expect(next.onHistory).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("history"));
    expect(next.onHistory).toHaveBeenCalledOnce();
  });

  it("rejects document and permission drift without closing or invoking the stale action", async () => {
    const session = createSession();
    const actions = createActions();
    const doc = { ...DOC };
    await renderStrict(header(headerProps(session, actions, { doc })));
    openMenu();

    doc.title = "Mutated source";
    fireEvent.click(item("history"));
    expect(actions.onHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    doc.title = DOC.title;

    Object.defineProperty(session, "role", { configurable: true, value: "viewer" });
    fireEvent.click(item("name-version"));
    expect(actions.onNameVersion).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    Object.defineProperty(session, "role", { configurable: true, value: "owner" });

    fireEvent.click(item("history"));
    expect(actions.onHistory).toHaveBeenCalledOnce();
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

  it("rejects a canceled Escape with valid-looking own event fields", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions)));
    const handlers: {
      escape: EscapeHandler | null;
      close: OpenHandler | null;
    } = { escape: null, close: null };
    const intercept = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      document.removeEventListener("keydown", intercept, { capture: true });
      event.preventDefault();
      event.stopImmediatePropagation();
      shadowEvent(event, {
        currentTarget: document,
        defaultPrevented: false,
        eventPhase: Event.CAPTURING_PHASE,
        composedPath: () => [
          event.target,
          screen.getByRole("menu"),
          document.body,
          document.documentElement,
          document,
          window,
        ],
      });
      if (!handlers.escape || !handlers.close) throw new Error("Escape handlers were not captured");
      handlers.escape(event);
      handlers.close(false);
    };
    document.addEventListener("keydown", intercept, { capture: true });
    openMenu();
    const history = item("history");
    history.focus();
    handlers.escape = captureEscape();
    handlers.close = captureOpenChange();

    fireEvent.keyDown(history, { key: "Escape" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(history).toHaveFocus();

    fireEvent.keyDown(history, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["pointer", "focus"] as const)(
    "rejects canceled poisoned %s-outside dismissal and keeps a fresh dismissal usable",
    async (family) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions), true));
      const outside = screen.getByRole("button", { name: "Outside menu" });
      const handlers: {
        outside: OutsideHandler | null;
        close: OpenHandler | null;
      } = { outside: null, close: null };
      const eventName = family === "pointer" ? "pointerdown" : "focusin";
      const intercept = (event: Event) => {
        if (event.target !== outside) return;
        document.removeEventListener(eventName, intercept);
        event.stopImmediatePropagation();
        if (family === "pointer") {
          event.preventDefault();
          shadowEvent(event, { defaultPrevented: false });
        }
        const outsideEvent = new CustomEvent(
          family === "pointer"
            ? "dismissableLayer.pointerDownOutside"
            : "dismissableLayer.focusOutside",
          {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent: event },
          },
        );
        outside.addEventListener(outsideEvent.type, (current) => {
          current.stopImmediatePropagation();
          if (family === "focus") {
            current.preventDefault();
            shadowEvent(current, { defaultPrevented: false });
          }
          if (!handlers.outside || !handlers.close) {
            throw new Error("Outside handlers were not captured");
          }
          handlers.outside(current as CustomEvent<{ originalEvent: Event }>);
          handlers.close(false);
        }, { once: true });
        outside.dispatchEvent(outsideEvent);
      };
      document.addEventListener(eventName, intercept);
      openMenu();
      const history = item("history");
      history.focus();
      handlers.outside = family === "pointer" ? captureOutside() : captureFocusOutside();
      handlers.close = captureOpenChange();
      if (family === "pointer") await waitForOutsideListener();

      if (family === "pointer") {
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(history).toHaveFocus();

      if (family === "pointer") {
        await waitForOutsideListener();
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        const freshIntercept = (event: FocusEvent) => {
          if (event.target !== outside) return;
          document.removeEventListener("focusin", freshIntercept);
          event.stopImmediatePropagation();
          const freshOutside = new CustomEvent("dismissableLayer.focusOutside", {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent: event },
          });
          outside.addEventListener(freshOutside.type, (current) => {
            current.stopImmediatePropagation();
            if (!handlers.outside || !handlers.close) {
              throw new Error("Outside handlers were not captured");
            }
            handlers.outside(current as CustomEvent<{ originalEvent: Event }>);
            handlers.close(false);
          }, { once: true });
          outside.dispatchEvent(freshOutside);
        };
        document.addEventListener("focusin", freshIntercept);
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    },
  );

  it("rejects nested pointer-outside from a pre-mount window interceptor", async () => {
    const session = createSession();
    const actions = createActions();
    let outside: HTMLElement | null = null;
    window.addEventListener("dismissableLayer.pointerDownOutside", (event) => {
      if (!outside || event.target !== outside) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const originalEvent = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent;
      outside.dispatchEvent(new CustomEvent("dismissableLayer.pointerDownOutside", {
        bubbles: false,
        cancelable: true,
        detail: { originalEvent },
      }));
    }, { capture: true, once: true });
    await renderStrict(header(headerProps(session, actions), true));
    outside = screen.getByRole("button", { name: "Outside menu" });
    openMenu();
    const history = item("history");
    history.focus();
    await waitForOutsideListener();

    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(history).toHaveFocus();

    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["pointer", "focus"] as const)(
    "accepts its own %s-outside event after another layer's event for the same native event",
    async (family) => {
      const session = createSession();
      const actions = createActions();
      await renderStrict(header(headerProps(session, actions), true));
      const outside = screen.getByRole("button", { name: "Outside menu" });
      const eventName = family === "pointer" ? "pointerdown" : "focusin";
      const handlers: {
        outside: OutsideHandler | null;
        close: OpenHandler | null;
      } = { outside: null, close: null };
      const injectForeignLayerEvent = (originalEvent: Event) => {
        if (originalEvent.target !== outside) return;
        document.removeEventListener(eventName, injectForeignLayerEvent);
        outside.dispatchEvent(new CustomEvent(
          family === "pointer"
            ? "dismissableLayer.pointerDownOutside"
            : "dismissableLayer.focusOutside",
          {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent },
          },
        ));
        if (family === "focus") {
          const ownEvent = new CustomEvent("dismissableLayer.focusOutside", {
            bubbles: false,
            cancelable: true,
            detail: { originalEvent },
          });
          outside.addEventListener(ownEvent.type, (event) => {
            event.stopImmediatePropagation();
            if (!handlers.outside || !handlers.close) {
              throw new Error("Outside handlers were not captured");
            }
            handlers.outside(event as CustomEvent<{ originalEvent: Event }>);
            handlers.close(false);
          }, { once: true });
          outside.dispatchEvent(ownEvent);
          originalEvent.stopImmediatePropagation();
        }
      };
      document.addEventListener(eventName, injectForeignLayerEvent);
      openMenu();
      item("history").focus();
      if (family === "pointer") {
        await waitForOutsideListener();
      } else {
        handlers.outside = captureFocusOutside();
        handlers.close = captureOpenChange();
      }

      if (family === "pointer") {
        fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      } else {
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }

      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    },
  );

  it("keeps stale Escape and outside handlers from closing or focusing a reopened visit", async () => {
    const session = createSession();
    const actions = createActions();
    await renderStrict(header(headerProps(session, actions), true));
    const menuTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside menu" });

    openMenu();
    const staleHistory = item("history");
    const staleEscape = captureEscape();
    const staleEscapeClose = captureOpenChange();
    fireEvent.keyDown(staleHistory, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    openMenu();
    item("history").focus();

    const replayedEscape = new KeyboardEvent("keydown", { bubbles: true, key: "Escape" });
    staleHistory.addEventListener("keydown", (event) => {
      event.stopImmediatePropagation();
      staleEscape(event);
      staleEscapeClose(false);
    }, { capture: true, once: true });
    act(() => staleHistory.dispatchEvent(replayedEscape));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(menuTrigger).not.toHaveFocus();

    const staleOutside = captureOutside();
    const staleOutsideClose = captureOpenChange();
    fireEvent.keyDown(item("history"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    openMenu();
    await waitForOutsideListener();
    const replayedOriginal = new PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerType: "mouse",
    });
    const replayedOutside = new CustomEvent("dismissableLayer.pointerDownOutside", {
      bubbles: true,
      cancelable: true,
      detail: { originalEvent: replayedOriginal },
    });
    outside.addEventListener(replayedOutside.type, (event) => {
      event.stopImmediatePropagation();
      staleOutside(event as CustomEvent<{ originalEvent: Event }>);
      staleOutsideClose(false);
    }, { capture: true, once: true });
    act(() => outside.dispatchEvent(replayedOutside));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await waitForOutsideListener();
    fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("claims the old action before a synchronous callback publishes a fresh document", async () => {
    const firstSession = createSession();
    const nextDoc = { ...DOC, id: "callback-successor", title: "Callback successor" };
    const nextSession = createSession(nextDoc.id);
    const first = createActions();
    const next = createActions();
    const firstProps = headerProps(firstSession, first);
    const nextView = header(headerProps(nextSession, next, { doc: nextDoc }));
    const viewRef: { current: DirectView | null } = { current: null };
    first.onHistory = vi.fn(() => {
      if (!viewRef.current) throw new Error("Header root was not mounted");
      viewRef.current.root.render(<StrictMode>{nextView}</StrictMode>);
    });
    const view = await renderStrict(header({ ...firstProps, onHistory: first.onHistory }));
    viewRef.current = view;

    openMenu();
    const currentHistory = item("history");
    const currentStaleSelect = captureSelect(currentHistory);
    fireEvent.click(currentHistory);
    expect(first.onHistory).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    act(() => {
      dispatchUnadmittedSelection(currentHistory, currentStaleSelect);
    });
    expect(first.onHistory).toHaveBeenCalledOnce();
    expect(next.onHistory).not.toHaveBeenCalled();

    openMenu();
    fireEvent.click(item("history"));
    expect(next.onHistory).toHaveBeenCalledOnce();
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
    await renderStrict(header(props));
    publishTrigger().focus();
    focus.mockClear();

    const event = publishArrow(key);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: destination })).toHaveFocus());
    expect(focus).toHaveBeenCalledOnce();
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

  it("does no work when a linked viewer has no enabled current action", async () => {
    const doc = linkedDocument(null);
    const props = headerProps(createSession(doc.id, "viewer"), createActions(), {
      doc,
      sync: syncStatus(),
      isOwner: false,
    });
    await renderStrict(header(props));
    publishTrigger().focus();

    const event = publishArrow("ArrowDown");

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.onPublishNow).not.toHaveBeenCalled();
    expect(props.onPull).not.toHaveBeenCalled();
    expect(props.onSync).not.toHaveBeenCalled();
  });

  it.each([
    ["untrusted", {}, false],
    ["Alt-modified", { altKey: true }, true],
    ["Control-modified", { ctrlKey: true }, true],
    ["Meta-modified", { metaKey: true }, true],
    ["Shift-modified", { shiftKey: true }, true],
    ["repeating", { repeat: true }, true],
    ["composing", { isComposing: true }, true],
  ] as const)("rejects %s ArrowDown before accepting a clean successor", async (
    _name,
    init,
    trusted,
  ) => {
    const props = headerProps(createSession(), createActions());
    await renderStrict(header(props));
    publishTrigger().focus();

    const rejected = publishArrow("ArrowDown", init, trusted);

    expect(rejected.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    const accepted = publishArrow("ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
  });

  it.each(["attribute", "placement"] as const)(
    "rejects restored trigger %s history and recovers in a distinct visit",
    async (mutation) => {
      const props = headerProps(createSession(), createActions());
      const view = await renderStrict(<div key="first">{header(props)}</div>);
      const current = publishTrigger();
      if (mutation === "attribute") {
        current.setAttribute("aria-label", "Changed");
        current.setAttribute("aria-label", "Publish options");
      } else {
        const parent = current.parentNode!;
        const next = current.nextSibling;
        current.remove();
        parent.insertBefore(current, next);
      }
      current.focus();

      const rejected = publishArrow("ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      await view.render(<div key="second">{header(props)}</div>);
      publishTrigger().focus();
      publishArrow("ArrowDown");
      await waitFor(() =>
        expect(screen.getByRole("menuitem", { name: "Gist or repository…" })).toHaveFocus());
    },
  );

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
