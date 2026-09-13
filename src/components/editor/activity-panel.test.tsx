// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CollabSession } from "@/editor/collab/session";
import type { ActivityItemDto, ActivityPageDto } from "@/lib/api";

const activity = vi.fn();
const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      activity: (...args: unknown[]) => activity(...args),
    },
  },
}));

import { ActivityPanel } from "./activity-panel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(docId: string): CollabSession {
  return { docId } as unknown as CollabSession;
}

function ActivityBoundary({
  documentId,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  documentId: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ActivityPanel session={session(documentId)} onClose={() => {}} /> : null;
}

function ActivityVisitBoundary({
  session,
  onClose,
  present = true,
  instance = "activity",
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? (
    <ActivityMount
      key={instance}
      session={session}
      onClose={onClose}
      onPassiveCleanup={onPassiveCleanup}
    />
  ) : null;
}

function ActivityMount({
  session,
  onClose,
  onPassiveCleanup,
}: {
  session: CollabSession;
  onClose: () => void;
  onPassiveCleanup?: () => void;
}) {
  useEffect(() => onPassiveCleanup, [onPassiveCleanup]);
  return <ActivityPanel session={session} onClose={onClose} />;
}

function StrictReplayBoundary({
  children,
  onLayoutCleanup,
}: {
  children: ReactNode;
  onLayoutCleanup: () => void;
}) {
  useLayoutEffect(() => onLayoutCleanup, [onLayoutCleanup]);
  return children;
}

interface CapturedMouseEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type ClickHandler = (event: CapturedMouseEvent) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedControl {
  element: HTMLButtonElement;
  click: ClickHandler;
  ref: ElementRef<HTMLButtonElement>;
}

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(
  element: HTMLElement,
  name: string,
): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`Element does not have an ${name} handler`);
  return handler;
}

function reactRef<T extends HTMLElement>(element: T): ElementRef<T> {
  const ref = reactProperty<ElementRef<T>>(element, "ref");
  if (typeof ref === "function") return ref;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached to the element");
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber.ref !== "function") throw new Error("Element does not have a callback ref");
  return fiber.ref as ElementRef<T>;
}

function captureControl(element: HTMLElement): CapturedControl {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button control");
  return {
    element,
    click: reactHandler<ClickHandler>(element, "onClick"),
    ref: reactRef(element),
  };
}

function capturedMouseEvent(
  control: CapturedControl,
  source: EventTarget | null = control.element,
  target: EventTarget | null = source,
  nativeTarget: EventTarget | null = target,
): CapturedMouseEvent {
  const ownerDocument = source instanceof Node ? source.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", { bubbles: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return {
    type: "click",
    currentTarget: source,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

function invoke(
  control: CapturedControl,
  source: EventTarget | null = control.element,
  target: EventTarget | null = source,
) {
  control.click(capturedMouseEvent(control, source, target));
}

function captureClick(element: HTMLElement): () => void {
  const control = captureControl(element);
  return () => invoke(control);
}

type ActivityKeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;

/** jsdom keeps event trust in an internal slot; a genuine keydown is trusted before dispatch. */
function markActivityEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
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
    throw new Error("Unable to set jsdom's internal Activity event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) throw new Error("The Activity event trust slot did not update");
}

function setActivityEventView(event: KeyboardEvent, view: Window) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find(
      (candidate): candidate is { view: Window | null } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "view" in candidate,
    );
  if (!implementation) {
    throw new Error("Unable to set jsdom's internal Activity event view slot");
  }
  implementation.view = view;
}

function replaceActivityPathTerminal(event: Event, terminal: EventTarget) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find((candidate): candidate is {
      _path: Array<{ item: Record<symbol, unknown> }>;
    } => {
      if (!candidate || typeof candidate !== "object") return false;
      return Array.isArray((candidate as { _path?: unknown })._path);
    });
  const entry = implementation?._path.at(-1);
  const currentTerminal = event.composedPath().at(-1);
  const wrapper = entry
    ? Object.getOwnPropertySymbols(entry.item).find(
        (symbol) => entry.item[symbol] === currentTerminal,
      )
    : undefined;
  if (!entry || !wrapper) {
    throw new Error("Unable to replace jsdom's Activity path terminal");
  }
  const item: Record<symbol, unknown> = {};
  Object.defineProperty(item, wrapper, { value: terminal });
  entry.item = item;
  if (event.composedPath().at(-1) !== terminal) {
    throw new Error("The Activity path terminal did not update");
  }
}

function activityKeyboardEvent(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Activity header control has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markActivityEventTrusted(event);
  return event;
}

function activityKey(
  element: HTMLElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = activityKeyboardEvent(element, key, init);
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

/**
 * Everything a hostile listener can put on a React-like keydown wrapper: every field React copies
 * from the native event, both phase predicates and `persist`, around the live native event itself.
 */
function fabricatedActivityKey(
  currentTarget: HTMLButtonElement,
  nativeEvent: KeyboardEvent,
): ReactKeyboardEvent<HTMLButtonElement> {
  return {
    type: nativeEvent.type,
    key: nativeEvent.key,
    code: nativeEvent.code,
    repeat: nativeEvent.repeat,
    altKey: nativeEvent.altKey,
    ctrlKey: nativeEvent.ctrlKey,
    metaKey: nativeEvent.metaKey,
    shiftKey: nativeEvent.shiftKey,
    bubbles: nativeEvent.bubbles,
    cancelable: nativeEvent.cancelable,
    defaultPrevented: nativeEvent.defaultPrevented,
    eventPhase: nativeEvent.eventPhase,
    isTrusted: nativeEvent.isTrusted,
    view: nativeEvent.view,
    timeStamp: nativeEvent.timeStamp,
    currentTarget,
    target: nativeEvent.target,
    nativeEvent,
    _reactName: "onKeyDown",
    isDefaultPrevented: () => nativeEvent.defaultPrevented,
    isPropagationStopped: () => nativeEvent.cancelBubble,
    persist: () => undefined,
    preventDefault: () => nativeEvent.preventDefault(),
    stopPropagation: () => nativeEvent.stopPropagation(),
  } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
}

function headerControl(
  name: "Refresh activity" | "Refreshing activity" | "Close activity",
) {
  const element = screen.getByRole("button", { name });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${name} to be a header button`);
  }
  return element;
}

function activityPanel() {
  return screen.getByTestId("activity-panel");
}

function activityHeader() {
  const header = activityPanel().firstElementChild;
  if (!(header instanceof HTMLElement)) throw new Error("Activity has no header");
  return header;
}

function replaceKeyHandler(
  element: HTMLElement,
  handler: ActivityKeyHandler,
  name: "onKeyDown" | "onKeyDownCapture" = "onKeyDown",
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Activity control");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  const props = record[propsKey];
  const replacement = { ...props, [name]: handler };
  record[propsKey] = replacement;
  return () => {
    if (record[propsKey] === replacement) record[propsKey] = props;
  };
}

function headerPage(id = "header"): ActivityPageDto {
  return { items: [row(id, `${id} editor`)], nextBefore: null };
}

const directRoots = new Set<Root>();

function createDirectActivity(
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() => root.render(<ActivityVisitBoundary {...props} />));
  return { host, root };
}

function renderDirectActivity(
  root: Root,
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  act(() => root.render(<ActivityVisitBoundary {...props} />));
}

function createStrictActivity(
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  directRoots.add(root);
  act(() =>
    root.render(
      <StrictMode>
        <ActivityVisitBoundary {...props} />
      </StrictMode>,
    ),
  );
  return { host, root };
}

function renderStrictActivity(
  root: Root,
  props: ComponentProps<typeof ActivityVisitBoundary>,
) {
  act(() =>
    root.render(
      <StrictMode>
        <ActivityVisitBoundary {...props} />
      </StrictMode>,
    ),
  );
}

function row(id: string, actorName: string): ActivityItemDto {
  return {
    id,
    actorId: `user-${id}`,
    actorName,
    actorKind: "user",
    action: "edit",
    detail: {},
    createdAt: "2026-09-01T09:00:00.000Z",
  };
}

/** A settled direct-root Strict Mode Activity panel, with whatever `activity` was mocked to answer. */
async function mountHeaderView(docId: string, onClose: () => void = vi.fn()) {
  const collab = session(docId);
  const view = createStrictActivity({ session: collab, onClose });
  await act(async () => {});
  return { ...view, onClose, session: collab };
}

beforeEach(() => {
  activity.mockReset();
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  for (const root of directRoots) act(() => root.unmount());
  directRoots.clear();
  document.body.replaceChildren();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(unhandledRejections).toEqual([]);
});

describe("ActivityPanel list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<ActivityPageDto>();
    activity.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<ActivityPanel session={session("activity-retry-empty")} onClose={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load activity");
    expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close activity" })).toBeEnabled();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ items: [], nextBefore: null });
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(activity).toHaveBeenNthCalledWith(2, "activity-retry-empty", { limit: 50 });
  });

  it("keeps one first-page request through pending ticks and refreshes at the next tick after settlement", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const later = deferred<ActivityPageDto>();
    activity.mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);

    render(<ActivityPanel session={session("activity-coalesced")} onClose={vi.fn()} />);
    expect(activity).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledTimes(1);

    initial.resolve({ items: [row("initial", "Initial editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Initial editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(1, "activity-coalesced", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, "activity-coalesced", { limit: 50 });

    later.resolve({ items: [row("later", "Later editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Later editor")).toBeInTheDocument();
  });

  it.each(["stale-first", "current-first"] as const)(
    "gives a same-document replacement sole authority when %s work settles first",
    async (settlementOrder) => {
      const intervalCallbacks: Array<() => void> = [];
      const reusedHandle = 41 as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        return reusedHandle;
      });
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      const sharedPage = { items: [row("shared", "Shared editor")], nextBefore: "shared-cursor" };
      const failedRefresh = deferred<ActivityPageDto>();
      const retiredRetry = deferred<ActivityPageDto>();
      const retiredPage = deferred<ActivityPageDto>();
      const currentRefresh = deferred<ActivityPageDto>();
      const currentPage = deferred<ActivityPageDto>();
      const responses = [
        Promise.resolve(sharedPage),
        failedRefresh.promise,
        retiredRetry.promise,
        retiredPage.promise,
        currentRefresh.promise,
        currentPage.promise,
      ];
      activity.mockImplementation(() => {
        const response = responses.shift();
        if (!response) throw new Error("Unexpected activity request");
        return response;
      });
      const firstSession = session("same-document");
      const currentSession = session("same-document");
      const firstClose = vi.fn();
      const currentClose = vi.fn();

      const rendered = render(<ActivityVisitBoundary session={firstSession} onClose={firstClose} />);
      await act(async () => {});
      const oldClose = captureClick(screen.getByRole("button", { name: "Close activity" }));
      const oldLoadMore = captureClick(screen.getByRole("button", { name: "Load more" }));

      await act(async () => {
        intervalCallbacks[0]();
        failedRefresh.reject("refresh unavailable");
      });
      const oldRetry = captureClick(screen.getByRole("button", { name: "Retry" }));
      act(() => {
        oldRetry();
      });
      const currentLoadMoreAfterRetry = captureClick(
        screen.getByRole("button", { name: "Load more" }),
      );
      act(() => currentLoadMoreAfterRetry());
      expect(activity).toHaveBeenCalledTimes(4);

      let clearsAtBoundary = -1;
      let intervalsAtBoundary = -1;
      rendered.rerender(
        <ActivityVisitBoundary
          session={currentSession}
          onClose={currentClose}
          boundary={1}
          onBoundary={() => {
            clearsAtBoundary = clearIntervalSpy.mock.calls.length;
            intervalsAtBoundary = setIntervalSpy.mock.calls.length;
          }}
        />,
      );

      expect(clearsAtBoundary).toBe(1);
      expect(intervalsAtBoundary).toBe(2);
      expect(activity).toHaveBeenCalledTimes(5);
      expect(screen.queryByText("Shared editor")).toBeNull();
      expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).not.toBeNull();

      intervalCallbacks[0]();
      oldRetry();
      oldLoadMore();
      oldClose();
      expect(activity).toHaveBeenCalledTimes(5);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(firstClose).not.toHaveBeenCalled();

      await act(async () => {
        intervalCallbacks[1]();
        intervalCallbacks[1]();
      });
      expect(activity).toHaveBeenCalledTimes(5);

      const settleRetired = async () => {
        retiredRetry.resolve(sharedPage);
        retiredPage.resolve(sharedPage);
        await Promise.all([retiredRetry.promise, retiredPage.promise]);
      };

      if (settlementOrder === "stale-first") {
        const beforeRetiredSettlements = screen.getByTestId("activity-panel").innerHTML;
        await act(settleRetired);
        expect(screen.getByTestId("activity-panel").innerHTML).toBe(beforeRetiredSettlements);
        currentRefresh.resolve(sharedPage);
        await act(async () => {});
      } else {
        currentRefresh.resolve(sharedPage);
        await act(async () => {});
        const beforeRetiredSettlements = screen.getByTestId("activity-panel").innerHTML;
        await act(settleRetired);
        expect(screen.getByTestId("activity-panel").innerHTML).toBe(beforeRetiredSettlements);
      }

      expect(screen.getByText("Shared editor")).toBeInTheDocument();
      const currentLoadMore = captureClick(screen.getByRole("button", { name: "Load more" }));
      act(() => {
        currentLoadMore();
        currentLoadMore();
      });
      expect(activity).toHaveBeenCalledTimes(6);
      expect(activity).toHaveBeenLastCalledWith("same-document", { before: "shared-cursor", limit: 50 });
      expect(screen.getByTestId("activity-load-more")).toBeDisabled();

      oldRetry();
      oldLoadMore();
      oldClose();
      intervalCallbacks[0]();
      expect(activity).toHaveBeenCalledTimes(6);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("activity-load-more")).toBeDisabled();

      currentPage.resolve({
        items: [row("older", "Earlier editor"), row("shared", "Duplicate shared editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
      expect(screen.getByText("Earlier editor")).toBeInTheDocument();
      expect(screen.queryByText("Duplicate shared editor")).toBeNull();

      const closeCurrent = captureClick(screen.getByRole("button", { name: "Close activity" }));
      closeCurrent();
      closeCurrent();
      intervalCallbacks[1]();
      expect(currentClose).toHaveBeenCalledOnce();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenNthCalledWith(1, reusedHandle);
      expect(clearIntervalSpy).toHaveBeenNthCalledWith(2, reusedHandle);
      expect(activity).toHaveBeenCalledTimes(6);

      rendered.unmount();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("retires a callback-only visit before its replacement reaches the parent layout boundary", async () => {
    const intervalCallbacks: Array<() => void> = [];
    const reusedHandle = 73 as unknown as ReturnType<typeof setInterval>;
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
      intervalCallbacks.push(handler as () => void);
      return reusedHandle;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const retiredRequest = deferred<ActivityPageDto>();
    const currentRequest = deferred<ActivityPageDto>();
    activity.mockReturnValueOnce(retiredRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const stableSession = session("callback-replacement");
    const retiredClose = vi.fn();
    const currentClose = vi.fn();

    const rendered = render(<ActivityVisitBoundary session={stableSession} onClose={retiredClose} />);
    const oldClose = captureClick(screen.getByRole("button", { name: "Close activity" }));
    let clearsAtBoundary = -1;
    rendered.rerender(
      <ActivityVisitBoundary
        session={stableSession}
        onClose={currentClose}
        boundary={1}
        onBoundary={() => {
          clearsAtBoundary = clearIntervalSpy.mock.calls.length;
        }}
      />,
    );

    expect(clearsAtBoundary).toBe(1);
    expect(intervalCallbacks).toHaveLength(2);
    expect(activity).toHaveBeenCalledTimes(2);
    oldClose();
    intervalCallbacks[0]();
    expect(retiredClose).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    currentRequest.resolve({ items: [row("current", "Current editor")], nextBefore: null });
    await act(async () => {});
    const currentPublication = screen.getByTestId("activity-panel").innerHTML;
    retiredRequest.resolve({ items: [row("retired", "Retired editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByTestId("activity-panel").innerHTML).toBe(currentPublication);

    const closeCurrent = captureClick(screen.getByRole("button", { name: "Close activity" }));
    closeCurrent();
    closeCurrent();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps expanded rows through a refresh failure and a successful retry", async () => {
    vi.useFakeTimers();
    activity
      .mockResolvedValueOnce({ items: [row("recent", "Recent editor")], nextBefore: "older-than-recent" })
      .mockResolvedValueOnce({ items: [row("older", "Earlier editor")], nextBefore: null })
      .mockRejectedValueOnce("refresh unavailable")
      .mockResolvedValueOnce({ items: [row("fresh", "Newest editor")], nextBefore: null });

    render(<ActivityPanel session={session("activity-expanded")} onClose={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByText("Recent editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Newest editor")).toBeInTheDocument();
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
  });

  it("starts one page request for rapid activation and keeps the cursor retryable after failure", async () => {
    vi.useFakeTimers();
    const initial = deferred<ActivityPageDto>();
    const failedPage = deferred<ActivityPageDto>();
    const failedRefresh = deferred<ActivityPageDto>();
    const retriedPage = deferred<ActivityPageDto>();
    activity
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(failedPage.promise)
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(retriedPage.promise);

    render(<ActivityPanel session={session("activity-page-retry")} onClose={vi.fn()} />);
    initial.resolve({ items: [row("recent", "Recent editor")], nextBefore: "older-cursor" });
    await act(async () => {});

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(2, "activity-page-retry", { before: "older-cursor", limit: 50 });

    failedPage.reject("page unavailable");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    failedRefresh.reject("refresh unavailable");
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenNthCalledWith(4, "activity-page-retry", { before: "older-cursor", limit: 50 });

    retriedPage.resolve({ items: [row("older", "Earlier editor"), row("recent", "Duplicate recent editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load activity");
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Earlier editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate recent editor")).toBeNull();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);
  });

  it("ignores an old-cursor success without appending, advancing, expanding, or unlocking the current page", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    const laterPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise)
      .mockReturnValueOnce(laterPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-success")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenNthCalledWith(4, "activity-stale-page-success", { before: "current-cursor", limit: 50 });
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    oldPage.resolve({ items: [row("stale", "Stale editor")], nextBefore: "stale-next" });
    await act(async () => {});
    expect(screen.queryByText("Stale editor")).toBeNull();
    expect(screen.getByText("Fresh editor")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();
    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(4);

    currentPage.resolve({ items: [row("current", "Current older editor"), row("fresh", "Duplicate fresh editor")], nextBefore: "later-cursor" });
    await act(async () => {});
    expect(screen.getByText("Current older editor")).toBeInTheDocument();
    expect(screen.queryByText("Duplicate fresh editor")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("activity-load-more"));
    expect(activity).toHaveBeenCalledTimes(5);
    expect(activity).toHaveBeenNthCalledWith(5, "activity-stale-page-success", { before: "later-cursor", limit: 50 });
    laterPage.resolve({ items: [row("last", "Last editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("Last editor")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-load-more")).toBeNull();
  });

  it("ignores an old-cursor failure and finalizer while the current page is pending", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<ActivityPageDto>();
    const currentPage = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "old-cursor" })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [row("fresh", "Fresh editor")], nextBefore: "current-cursor" })
      .mockReturnValueOnce(currentPage.promise);

    render(<ActivityPanel session={session("activity-stale-page-failure")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    oldPage.reject("stale failure");
    await act(async () => {});
    expect(screen.queryByText("Failed to load more")).toBeNull();
    expect(screen.getByTestId("activity-load-more")).toBeDisabled();

    currentPage.reject("current failure");
    await act(async () => {});
    expect(screen.getByText("Failed to load more")).toBeInTheDocument();
    expect(screen.getByTestId("activity-load-more")).toBeEnabled();
  });

  it("ignores an older document response after the panel switches documents", async () => {
    const oldRequest = deferred<ActivityPageDto>();
    activity.mockImplementation((docId: string) =>
      docId === "activity-old"
        ? oldRequest.promise
        : Promise.resolve({ items: [row("new", "New document editor")], nextBefore: null }),
    );

    const rendered = render(<ActivityPanel session={session("activity-old")} onClose={vi.fn()} />);
    await waitFor(() => expect(activity).toHaveBeenCalledWith("activity-old", { limit: 50 }));
    rendered.rerender(<ActivityPanel session={session("activity-new")} onClose={vi.fn()} />);
    expect(await screen.findByText("New document editor")).toBeInTheDocument();

    oldRequest.resolve({ items: [row("old", "Old document editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.getByText("New document editor")).toBeInTheDocument();
    expect(screen.queryByText("Old document editor")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "retires an old document before its deferred %s settles at the replacement layout boundary",
    async (outcome) => {
      vi.useFakeTimers();
      const oldRequest = deferred<ActivityPageDto>();
      const currentRequest = deferred<ActivityPageDto>();
      const laterRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(currentRequest.promise)
        .mockReturnValueOnce(laterRequest.promise);

      const rendered = render(<ActivityBoundary documentId="activity-boundary-old" />);
      expect(activity).toHaveBeenCalledTimes(1);

      rendered.rerender(
        <ActivityBoundary
          documentId="activity-boundary-current"
          boundary={1}
          onBoundary={() => {
            if (outcome === "success") {
              oldRequest.resolve({ items: [row("retired", "Retired document editor")], nextBefore: "retired-cursor" });
            } else {
              oldRequest.reject("retired document failure");
            }
          }}
        />,
      );
      await act(async () => {
        await Promise.allSettled([oldRequest.promise]);
      });

      expect(activity).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Retired document editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("activity-panel").querySelector(".animate-spin")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(activity).toHaveBeenCalledTimes(2);

      currentRequest.resolve({ items: [row("current", "Current document editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Current document editor")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenNthCalledWith(3, "activity-boundary-current", { limit: 50 });
      laterRequest.resolve({ items: [row("later", "Later current editor")], nextBefore: null });
      await act(async () => {});
      expect(screen.getByText("Later current editor")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("invalidates pending work synchronously when Close is activated", async () => {
    vi.useFakeTimers();
    const pending = deferred<ActivityPageDto>();
    const onClose = vi.fn();
    activity.mockReturnValueOnce(pending.promise);

    render(<ActivityPanel session={session("activity-close")} onClose={onClose} />);
    expect(vi.getTimerCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close activity" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(activity).toHaveBeenCalledOnce();

    pending.resolve({ items: [row("late", "Late editor")], nextBefore: null });
    await act(async () => {});
    expect(screen.queryByText("Late editor")).toBeNull();
  });

  it("retires page, refresh, and cadence work before settlements at the removal layout boundary", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityBoundary documentId="activity-boundary-removal" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    let timersAtBoundary = -1;

    rendered.rerender(
      <ActivityBoundary
        documentId="activity-boundary-removal"
        present={false}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = vi.getTimerCount();
          page.resolve({ items: [row("retired-page", "Retired page editor")], nextBefore: "retired-next" });
          refresh.reject("retired refresh failure");
        }}
      />,
    );
    await act(async () => {
      await Promise.allSettled([page.promise, refresh.promise]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    expect(timersAtBoundary).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(activity).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(screen.queryByText("Retired page editor")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });

  it("handles late page resolution and refresh rejection after unmount without committing", async () => {
    vi.useFakeTimers();
    const page = deferred<ActivityPageDto>();
    const refresh = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({ items: [row("initial", "Initial editor")], nextBefore: "older-cursor" })
      .mockReturnValueOnce(page.promise)
      .mockReturnValueOnce(refresh.promise);

    const rendered = render(<ActivityPanel session={session("activity-unmount")} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(activity).toHaveBeenCalledTimes(3);

    rendered.unmount();
    page.resolve({ items: [row("late-page", "Late page editor")], nextBefore: null });
    refresh.reject("late refresh failure");
    await act(async () => {});
    expect(screen.queryByTestId("activity-panel")).toBeNull();
    expect(unhandledRejections).toEqual([]);
  });
});

describe("ActivityPanel manual refresh", () => {
  it("refreshes the current first page once, replaces its cursor, updates relative time, and sits immediately before Close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T12:01:10.000Z"));
    const refreshed = deferred<ActivityPageDto>();
    const nextPage = deferred<ActivityPageDto>();
    const timedRow = {
      ...row("timed", "Initial timed editor"),
      createdAt: "2026-09-08T12:00:00.000Z",
    };
    const initialPage = {
      items: [timedRow],
      nextBefore: "initial-cursor",
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(nextPage.promise);

    createStrictActivity({
      session: session("manual-success"),
      onClose: vi.fn(),
    });
    await act(async () => {});

    expect(activity).toHaveBeenCalledTimes(2);
    const refresh = screen.getByRole("button", { name: "Refresh activity" });
    const close = screen.getByRole("button", { name: "Close activity" });
    expect(refresh.nextElementSibling).toBe(close);
    expect(screen.getByText("1 minute ago")).toBeInTheDocument();

    act(() => refresh.click());
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("manual-success", { limit: 50 });
    expect(
      screen.getByRole("button", { name: "Refreshing activity" }),
    ).toBeDisabled();

    vi.setSystemTime(new Date("2026-09-08T12:02:10.000Z"));
    refreshed.resolve({
      items: [{ ...timedRow, actorName: "Updated timed editor" }],
      nextBefore: "replacement-cursor",
    });
    await act(async () => {});

    expect(screen.getByText("Updated timed editor")).toBeInTheDocument();
    expect(screen.getByText("2 minutes ago")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh activity" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(4);
    expect(activity).toHaveBeenLastCalledWith("manual-success", {
      before: "replacement-cursor",
      limit: 50,
    });
  });

  it("retains expanded history and its cursor across failure and a de-duplicated retry", async () => {
    const failedRefresh = deferred<ActivityPageDto>();
    const successfulRefresh = deferred<ActivityPageDto>();
    const deeperPage = deferred<ActivityPageDto>();
    const initialPage = {
      items: [row("recent", "Recent editor")],
      nextBefore: "older-cursor",
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce({
        items: [row("older", "Older editor")],
        nextBefore: "deep-cursor",
      })
      .mockReturnValueOnce(failedRefresh.promise)
      .mockReturnValueOnce(successfulRefresh.promise)
      .mockReturnValueOnce(deeperPage.promise);

    createStrictActivity({
      session: session("manual-expanded"),
      onClose: vi.fn(),
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {});
    expect(screen.getAllByTestId("activity-row")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(activity).toHaveBeenCalledTimes(4);
    failedRefresh.reject("refresh failed");
    await act(async () => {});

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to load activity",
    );
    expect(screen.getByText("Recent editor")).toBeInTheDocument();
    expect(screen.getByText("Older editor")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh activity" }),
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh activity" }));
    expect(activity).toHaveBeenCalledTimes(5);
    successfulRefresh.resolve({
      items: [
        row("fresh", "Fresh editor"),
        row("recent", "Updated recent editor"),
      ],
      nextBefore: "ignored-first-page-cursor",
    });
    await act(async () => {});

    expect(screen.queryByRole("alert")).toBeNull();
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Fresh editor");
    expect(rows[1]).toHaveTextContent("Updated recent editor");
    expect(rows[2]).toHaveTextContent("Older editor");
    expect(screen.queryByText("Recent editor")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(activity).toHaveBeenCalledTimes(6);
    expect(activity).toHaveBeenLastCalledWith("manual-expanded", {
      before: "deep-cursor",
      limit: 50,
    });
  });

  it.each(["refresh first", "Retry first"] as const)(
    "coalesces cadence, repeated manual, and error Retry work when clicked %s",
    async (order) => {
      vi.useFakeTimers();
      const staleInitial = deferred<ActivityPageDto>();
      const currentInitial = deferred<ActivityPageDto>();
      const automaticRefresh = deferred<ActivityPageDto>();
      const retriedRefresh = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(staleInitial.promise)
        .mockReturnValueOnce(currentInitial.promise)
        .mockReturnValueOnce(automaticRefresh.promise)
        .mockReturnValueOnce(retriedRefresh.promise);

      createStrictActivity({
        session: session(`manual-coalesce-${order}`),
        onClose: vi.fn(),
      });
      expect(activity).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "Refresh activity" }),
      ).toBeNull();

      currentInitial.resolve({
        items: [row("current", "Current editor")],
        nextBefore: null,
      });
      await act(async () => {});
      const beforeAutomatic = captureControl(
        screen.getByRole("button", { name: "Refresh activity" }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(activity).toHaveBeenCalledTimes(3);
      const automaticControl = screen.getByRole("button", {
        name: "Refreshing activity",
      });
      expect(automaticControl).toBeDisabled();
      act(() => {
        invoke(beforeAutomatic);
        automaticControl.click();
      });
      expect(activity).toHaveBeenCalledTimes(3);

      automaticRefresh.reject("automatic refresh failed");
      await act(async () => {});
      const manual = captureControl(
        screen.getByRole("button", { name: "Refresh activity" }),
      );
      const retry = captureControl(
        screen.getByRole("button", { name: "Retry" }),
      );
      const first = order === "refresh first" ? manual : retry;
      const second = order === "refresh first" ? retry : manual;
      act(() => {
        invoke(first);
        invoke(first);
        invoke(second);
      });

      expect(activity).toHaveBeenCalledTimes(4);
      expect(activity).toHaveBeenLastCalledWith(
        `manual-coalesce-${order}`,
        { limit: 50 },
      );
      expect(
        screen.getByRole("button", { name: "Refreshing activity" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: order === "Retry first" ? "Retrying…" : "Retry",
        }),
      ).toBeDisabled();

      retriedRefresh.resolve({
        items: [row("recovered", "Recovered editor")],
        nextBefore: null,
      });
      staleInitial.resolve({
        items: [row("stale", "Stale editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getByText("Recovered editor")).toBeInTheDocument();
      expect(screen.queryByText("Stale editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("rejects crossed, fabricated, disabled, inert, and restored events until a clean publication succeeds", async () => {
    const request = deferred<ActivityPageDto>();
    const initialPage = {
      items: [row("authority", "Authority editor")],
      nextBefore: null,
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockReturnValueOnce(request.promise);
    const stableSession = session("manual-authority");
    const onClose = vi.fn();
    const view = createStrictActivity({
      session: stableSession,
      onClose,
    });
    await act(async () => {});
    const stale = captureControl(
      screen.getByRole("button", { name: "Refresh activity" }),
    );
    const close = captureControl(
      screen.getByRole("button", { name: "Close activity" }),
    );
    const sibling = document.createElement("button");
    document.body.append(sibling);
    const fabricated = {
      ...capturedMouseEvent(stale),
      nativeEvent: new Event("click"),
    };
    const mismatchedTarget = capturedMouseEvent(
      stale,
      stale.element,
      stale.element,
      sibling,
    );

    act(() => {
      invoke(stale, close.element);
      stale.click(fabricated);
      stale.click(mismatchedTarget);
      stale.element.disabled = true;
      invoke(stale);
      stale.element.disabled = false;
      stale.element.setAttribute("inert", "");
      invoke(stale);
      stale.element.removeAttribute("inert");
      invoke(stale);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();

    renderStrictActivity(view.root, {
      session: stableSession,
      onClose,
    });
    const current = captureControl(
      screen.getByRole("button", { name: "Refresh activity" }),
    );
    const currentEvent = capturedMouseEvent(current);
    act(() => {
      invoke(stale, current.element);
      current.click(currentEvent);
      current.click(currentEvent);
    });

    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("manual-authority", {
      limit: 50,
    });
    expect(
      screen.getByRole("button", { name: "Refreshing activity" }),
    ).toBeDisabled();
  });

  it("keeps a partial ref replay inert and recovers only through its complete clean successor", async () => {
    const request = deferred<ActivityPageDto>();
    const initialPage = {
      items: [row("partial", "Partial replay editor")],
      nextBefore: null,
    };
    activity
      .mockResolvedValueOnce(initialPage)
      .mockResolvedValueOnce(initialPage)
      .mockReturnValueOnce(request.promise);

    createStrictActivity({
      session: session("manual-partial-replay"),
      onClose: vi.fn(),
    });
    await act(async () => {});
    const stale = captureControl(
      screen.getByRole("button", { name: "Refresh activity" }),
    );

    act(() => {
      stale.ref(null);
      invoke(stale);
    });
    expect(activity).toHaveBeenCalledTimes(2);

    act(() => stale.ref(stale.element));
    const current = captureControl(
      screen.getByRole("button", { name: "Refresh activity" }),
    );
    expect(current.element).toBe(stale.element);
    expect(current.click).not.toBe(stale.click);
    act(() => {
      invoke(stale, current.element);
      invoke(current);
      invoke(current);
    });

    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenLastCalledWith("manual-partial-replay", {
      limit: 50,
    });
  });

  it.each(["resolve", "reject"] as const)(
    "retires a manual request and stale callback across document replacement before its late %s",
    async (outcome) => {
      const lateRequest = deferred<ActivityPageDto>();
      const documentBRequests: ReturnType<
        typeof deferred<ActivityPageDto>
      >[] = [];
      let documentACalls = 0;
      activity.mockImplementation((documentId: string) => {
        if (documentId === "manual-document-A") {
          documentACalls += 1;
          if (documentACalls <= 2) {
            return Promise.resolve({
              items: [row("document-A", "Document A editor")],
              nextBefore: null,
            });
          }
          return lateRequest.promise;
        }
        if (documentId === "manual-document-B") {
          const pending = deferred<ActivityPageDto>();
          documentBRequests.push(pending);
          return pending.promise;
        }
        throw new Error(`Unexpected document: ${documentId}`);
      });
      const oldClose = vi.fn();
      const newClose = vi.fn();
      const view = createStrictActivity({
        session: session("manual-document-A"),
        onClose: oldClose,
      });
      await act(async () => {});
      const stale = captureControl(
        screen.getByRole("button", { name: "Refresh activity" }),
      );
      act(() => invoke(stale));
      expect(documentACalls).toBe(3);

      renderStrictActivity(view.root, {
        session: session("manual-document-B"),
        onClose: newClose,
        boundary: 1,
        onBoundary: () => invoke(stale),
      });
      expect(documentACalls).toBe(3);
      expect(documentBRequests.length).toBeGreaterThan(0);
      for (const pending of documentBRequests) {
        pending.resolve({
          items: [row("document-B", "Document B editor")],
          nextBefore: null,
        });
      }
      await act(async () => {});
      expect(screen.getByText("Document B editor")).toBeInTheDocument();

      if (outcome === "resolve") {
        lateRequest.resolve({
          items: [row("late-A", "Late document A editor")],
          nextBefore: null,
        });
      } else {
        lateRequest.reject("late document A failure");
      }
      await act(async () => {});
      expect(screen.getByText("Document B editor")).toBeInTheDocument();
      expect(screen.queryByText("Late document A editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(oldClose).not.toHaveBeenCalled();
      expect(newClose).not.toHaveBeenCalled();

      const callsBeforeRefresh = activity.mock.calls.length;
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh activity" }),
      );
      expect(activity).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      expect(activity).toHaveBeenLastCalledWith("manual-document-B", {
        limit: 50,
      });
    },
  );

  it.each([
    ["Close", "resolve"],
    ["cleanup", "reject"],
  ] as const)(
    "performs no late state work after %s during a manual request that later %ss",
    async (retirement, outcome) => {
      vi.useFakeTimers();
      const lateRequest = deferred<ActivityPageDto>();
      const initialPage = {
        items: [row("before-retirement", "Before retirement editor")],
        nextBefore: null,
      };
      activity
        .mockResolvedValueOnce(initialPage)
        .mockResolvedValueOnce(initialPage)
        .mockReturnValueOnce(lateRequest.promise);
      const onClose = vi.fn();
      const view = createStrictActivity({
        session: session(`manual-${retirement}`),
        onClose,
      });
      await act(async () => {});
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh activity" }),
      );
      expect(activity).toHaveBeenCalledTimes(3);

      if (retirement === "Close") {
        fireEvent.click(
          screen.getByRole("button", { name: "Close activity" }),
        );
        expect(onClose).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } else {
        act(() => view.root.unmount());
        directRoots.delete(view.root);
        expect(screen.queryByTestId("activity-panel")).toBeNull();
      }

      if (outcome === "resolve") {
        lateRequest.resolve({
          items: [row("late-retirement", "Late retirement editor")],
          nextBefore: null,
        });
      } else {
        lateRequest.reject("late retirement failure");
      }
      await act(async () => {});

      expect(screen.queryByText("Late retirement editor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(unhandledRejections).toEqual([]);
    },
  );
});

describe("ActivityPanel exact action publications", () => {
  it("keeps current actions usable after Strict Mode replay while retired refs and handlers stay inert", async () => {
    const loadPage = deferred<ActivityPageDto>();
    activity.mockImplementation((documentId: string, options: { before?: string }) => {
      if (documentId === "strict-close") {
        return Promise.resolve({ items: [], nextBefore: null });
      }
      if (documentId === "strict-retry") {
        return Promise.reject("offline");
      }
      if (documentId === "strict-load") {
        return options.before
          ? loadPage.promise
          : Promise.resolve({
              items: [row("strict-row", "Strict editor")],
              nextBefore: "strict-cursor",
            });
      }
      throw new Error(`Unexpected document: ${documentId}`);
    });
    const closeSession = session("strict-close");
    const retrySession = session("strict-retry");
    const loadSession = session("strict-load");
    const retiredClose = vi.fn();
    const currentClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    const renderPanels = (instance: string, onClose: () => void) => (
      <StrictMode>
        <section key={instance}>
          <ActivityPanel session={closeSession} onClose={onClose} />
          <ActivityPanel session={retrySession} onClose={() => {}} />
          <ActivityPanel session={loadSession} onClose={() => {}} />
        </section>
      </StrictMode>
    );

    act(() => root.render(renderPanels("A", retiredClose)));
    await act(async () => {});
    const retiredPanels = screen.getAllByTestId("activity-panel");
    const retiredCloseControl = captureControl(
      within(retiredPanels[0]!).getByRole("button", { name: "Close activity" }),
    );
    const retiredRetryControl = captureControl(
      within(retiredPanels[1]!).getByRole("button", { name: "Retry" }),
    );
    const retiredLoadControl = captureControl(
      within(retiredPanels[2]!).getByRole("button", { name: "Load more" }),
    );

    act(() => root.render(renderPanels("B", currentClose)));
    await act(async () => {});
    const currentPanels = screen.getAllByTestId("activity-panel");
    const currentCloseControl = captureControl(
      within(currentPanels[0]!).getByRole("button", { name: "Close activity" }),
    );
    const currentRetryControl = captureControl(
      within(currentPanels[1]!).getByRole("button", { name: "Retry" }),
    );
    const currentLoadControl = captureControl(
      within(currentPanels[2]!).getByRole("button", { name: "Load more" }),
    );
    expect(currentCloseControl.element).not.toBe(retiredCloseControl.element);
    expect(currentRetryControl.element).not.toBe(retiredRetryControl.element);
    expect(currentLoadControl.element).not.toBe(retiredLoadControl.element);
    expect(currentCloseControl.ref).not.toBe(retiredCloseControl.ref);
    expect(currentRetryControl.ref).not.toBe(retiredRetryControl.ref);
    expect(currentLoadControl.ref).not.toBe(retiredLoadControl.ref);
    const callsBeforeActions = activity.mock.calls.length;

    act(() => {
      retiredCloseControl.ref(currentCloseControl.element);
      retiredRetryControl.ref(currentRetryControl.element);
      retiredLoadControl.ref(currentLoadControl.element);
      retiredLoadControl.ref(null);
      retiredRetryControl.ref(null);
      retiredCloseControl.ref(null);
      invoke(retiredCloseControl, currentCloseControl.element);
      invoke(retiredRetryControl, currentRetryControl.element);
      invoke(retiredLoadControl, currentLoadControl.element);
      invoke(currentCloseControl, retiredCloseControl.element);
      invoke(currentRetryControl, retiredRetryControl.element);
      invoke(currentLoadControl, retiredLoadControl.element);
    });
    expect(activity).toHaveBeenCalledTimes(callsBeforeActions);
    expect(retiredClose).not.toHaveBeenCalled();
    expect(currentClose).not.toHaveBeenCalled();

    act(() => {
      currentCloseControl.element.querySelector("svg")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      currentCloseControl.element.click();
      currentRetryControl.element.click();
      currentRetryControl.element.click();
      currentLoadControl.element.click();
      currentLoadControl.element.click();
    });

    expect(retiredClose).not.toHaveBeenCalled();
    expect(currentClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(callsBeforeActions + 2);
    expect(activity).toHaveBeenNthCalledWith(callsBeforeActions + 1, "strict-retry", {
      limit: 50,
    });
    expect(activity).toHaveBeenNthCalledWith(callsBeforeActions + 2, "strict-load", {
      before: "strict-cursor",
      limit: 50,
    });
  });

  it.each(["stale-first", "current-first"] as const)(
    "gives the exact fresh Strict Mode visit sole cadence and request authority, %s",
    async (settlementOrder) => {
      const intervalCallbacks: Array<() => void> = [];
      const intervalHandles = [
        301 as unknown as ReturnType<typeof setInterval>,
        302 as unknown as ReturnType<typeof setInterval>,
      ];
      vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        const handle = intervalHandles[intervalCallbacks.length - 1];
        if (!handle) throw new Error("Unexpected Activity cadence");
        return handle;
      });
      const clearIntervalSpy = vi
        .spyOn(globalThis, "clearInterval")
        .mockImplementation(() => {});
      const staleRequest = deferred<ActivityPageDto>();
      const currentRequest = deferred<ActivityPageDto>();
      const cadenceRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(currentRequest.promise)
        .mockReturnValueOnce(cadenceRequest.promise);
      const stableSession = session(`strict-cadence-${settlementOrder}`);
      const onClose = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directRoots.add(root);

      act(() => {
        root.render(
          <StrictMode>
            <ActivityPanel session={stableSession} onClose={onClose} />
          </StrictMode>,
        );
      });

      expect(activity).toHaveBeenCalledTimes(2);
      expect(intervalCallbacks).toHaveLength(2);
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandles[0]);
      act(() => {
        intervalCallbacks[0]?.();
        intervalCallbacks[1]?.();
        intervalCallbacks[1]?.();
      });
      expect(activity).toHaveBeenCalledTimes(2);

      const settleStale = async () => {
        staleRequest.resolve({
          items: [row("strict-stale", "Stale editor")],
          nextBefore: null,
        });
        await staleRequest.promise;
      };
      const settleCurrent = async () => {
        currentRequest.resolve({
          items: [row("strict-current", "Current editor")],
          nextBefore: null,
        });
        await currentRequest.promise;
      };

      if (settlementOrder === "stale-first") {
        await act(settleStale);
        expect(screen.queryByText("Stale editor")).toBeNull();
        await act(settleCurrent);
      } else {
        await act(settleCurrent);
        await act(settleStale);
      }
      expect(screen.getByText("Current editor")).toBeInTheDocument();
      expect(screen.queryByText("Stale editor")).toBeNull();

      act(() => {
        intervalCallbacks[0]?.();
        intervalCallbacks[1]?.();
        intervalCallbacks[1]?.();
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenLastCalledWith(stableSession.docId, {
        limit: 50,
      });

      cadenceRequest.resolve({
        items: [row("strict-cadence", "Cadence editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getByText("Cadence editor")).toBeInTheDocument();
      expect(screen.queryByText("Current editor")).toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each(["restored mutation", "detach and reinsert"] as const)(
    "rejects a Strict Mode successor after queued root history records a %s",
    async (change) => {
      const intervalCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        return 401 as unknown as ReturnType<typeof setInterval>;
      });
      const clearIntervalSpy = vi
        .spyOn(globalThis, "clearInterval")
        .mockImplementation(() => {});
      const staleRequest = deferred<ActivityPageDto>();
      activity.mockReturnValue(staleRequest.promise);
      const onClose = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directRoots.add(root);
      const onLayoutCleanup = () => {
        const panel = screen.getByTestId("activity-panel");
        if (change === "restored mutation") {
          panel.setAttribute("data-replay-change", "temporary");
          panel.removeAttribute("data-replay-change");
          return;
        }
        const parent = panel.parentNode;
        const next = panel.nextSibling;
        if (!parent) throw new Error("Activity panel has no parent");
        parent.removeChild(panel);
        parent.insertBefore(panel, next);
      };

      act(() => {
        root.render(
          <StrictMode>
            <StrictReplayBoundary onLayoutCleanup={onLayoutCleanup}>
              <ActivityPanel
                session={session(`strict-history-${change}`)}
                onClose={onClose}
              />
            </StrictReplayBoundary>
          </StrictMode>,
        );
      });

      expect(activity).toHaveBeenCalledOnce();
      expect(intervalCallbacks).toHaveLength(1);
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      act(() => {
        intervalCallbacks[0]?.();
        screen.getByRole("button", { name: "Close activity" }).click();
      });
      expect(activity).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();

      staleRequest.resolve({
        items: [row("strict-history-stale", "History stale editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.queryByText("History stale editor")).toBeNull();
      expect(
        screen.getByTestId("activity-panel").querySelector(".animate-spin"),
      ).not.toBeNull();
    },
  );

  it.each(["immediate parent", "higher wrapper"] as const)(
    "does not revive stale Strict Mode work after detaching and restoring the %s",
    async (level) => {
      const intervalCallbacks: Array<() => void> = [];
      vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
        intervalCallbacks.push(handler as () => void);
        return (500 + intervalCallbacks.length) as unknown as ReturnType<
          typeof setInterval
        >;
      });
      const clearIntervalSpy = vi
        .spyOn(globalThis, "clearInterval")
        .mockImplementation(() => {});
      const staleRequest = deferred<ActivityPageDto>();
      const freshRequest = deferred<ActivityPageDto>();
      const freshCadenceRequest = deferred<ActivityPageDto>();
      activity
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(freshRequest.promise)
        .mockReturnValueOnce(freshCadenceRequest.promise);
      const staleClose = vi.fn();
      const freshClose = vi.fn();
      const wrapper = document.createElement("section");
      const host = document.createElement("div");
      wrapper.append(host);
      document.body.append(wrapper);
      const root = createRoot(host);
      directRoots.add(root);
      let mutateReplay = true;
      let stalePanel: HTMLElement | null = null;
      let staleCloseControl: CapturedControl | null = null;
      const onLayoutCleanup = () => {
        if (!mutateReplay) return;
        const panel = screen.getByTestId("activity-panel");
        stalePanel = panel;
        staleCloseControl = captureControl(
          within(panel).getByRole("button", { name: "Close activity" }),
        );
        const target =
          level === "immediate parent"
            ? panel.parentNode
            : panel.parentNode?.parentNode;
        const parent = target?.parentNode;
        const next = target?.nextSibling ?? null;
        if (!target || !parent) throw new Error(`Activity ${level} has no parent`);
        parent.removeChild(target);
        parent.insertBefore(target, next);
      };

      act(() => {
        root.render(
          <StrictMode>
            <StrictReplayBoundary onLayoutCleanup={onLayoutCleanup}>
              <ActivityPanel
                session={session(`strict-${level}`)}
                onClose={staleClose}
              />
            </StrictReplayBoundary>
          </StrictMode>,
        );
      });

      const retiredPanel = stalePanel;
      const retiredCloseControl = staleCloseControl;
      if (!retiredPanel || !retiredCloseControl) {
        throw new Error(
          "Strict Mode cleanup did not capture the retired Activity controls",
        );
      }
      expect(activity).toHaveBeenCalledOnce();
      expect(intervalCallbacks).toHaveLength(1);
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      act(() => {
        invoke(retiredCloseControl);
        intervalCallbacks[0]?.();
      });
      expect(activity).toHaveBeenCalledOnce();
      expect(staleClose).not.toHaveBeenCalled();

      mutateReplay = false;
      const currentSession = session(`fresh-${level}`);
      act(() => {
        root.render(
          <section key="fresh">
            <ActivityPanel session={currentSession} onClose={freshClose} />
          </section>,
        );
      });
      const freshPanel = screen.getByTestId("activity-panel");
      expect(freshPanel).not.toBe(retiredPanel);
      expect(activity).toHaveBeenCalledTimes(2);
      expect(intervalCallbacks).toHaveLength(2);

      staleRequest.resolve({
        items: [row(`stale-${level}`, "Stale ancestor editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.queryByText("Stale ancestor editor")).toBeNull();

      freshRequest.resolve({
        items: [row(`fresh-${level}`, "Fresh ancestor editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getByText("Fresh ancestor editor")).toBeInTheDocument();

      act(() => {
        intervalCallbacks[0]?.();
        intervalCallbacks[1]?.();
        intervalCallbacks[1]?.();
      });
      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenLastCalledWith(currentSession.docId, { limit: 50 });
      expect(staleClose).not.toHaveBeenCalled();
      expect(freshClose).not.toHaveBeenCalled();

      freshCadenceRequest.resolve({
        items: [row(`fresh-cadence-${level}`, "Fresh cadence editor")],
        nextBefore: null,
      });
      await act(async () => {});
      expect(screen.getByText("Fresh cadence editor")).toBeInTheDocument();
      expect(screen.queryByText("Stale ancestor editor")).toBeNull();
      act(() => {
        within(freshPanel).getByRole("button", { name: "Close activity" }).click();
      });
      expect(staleClose).not.toHaveBeenCalled();
      expect(freshClose).toHaveBeenCalledOnce();
    },
  );

  it("rejects foreign, detached, disabled, replaced, wrong-action, and fabricated sources before exact controls claim once", async () => {
    const retryRequest = deferred<ActivityPageDto>();
    const pageRequest = deferred<ActivityPageDto>();
    let retryReentry: CapturedControl | null = null;
    let pageReentry: CapturedControl | null = null;
    let retryCloseReentry: CapturedControl | null = null;
    let pageCloseReentry: CapturedControl | null = null;
    const retryClose = vi.fn(() => {
      if (retryCloseReentry) invoke(retryCloseReentry);
    });
    const pageClose = vi.fn(() => {
      if (pageCloseReentry) invoke(pageCloseReentry);
    });
    let retryCalls = 0;
    let pageCalls = 0;
    activity.mockImplementation((documentId: string) => {
      if (documentId === "exact-retry") {
        retryCalls += 1;
        if (retryCalls === 1) return Promise.reject("offline");
        if (retryReentry) invoke(retryReentry);
        return retryRequest.promise;
      }
      if (documentId === "exact-page") {
        pageCalls += 1;
        if (pageCalls === 1) {
          return Promise.resolve({
            items: [row("page-row", "Page editor")],
            nextBefore: "page-cursor",
          });
        }
        if (pageReentry) invoke(pageReentry);
        return pageRequest.promise;
      }
      throw new Error(`Unexpected document: ${documentId}`);
    });

    render(
      <>
        <ActivityPanel session={session("exact-retry")} onClose={retryClose} />
        <ActivityPanel session={session("exact-page")} onClose={pageClose} />
      </>,
    );
    await act(async () => {});
    const panels = screen.getAllByTestId("activity-panel");
    const retryPanel = panels[0];
    const pagePanel = panels[1];
    if (!retryPanel || !pagePanel) throw new Error("Expected two activity panels");
    const retryControl = captureControl(within(retryPanel).getByRole("button", { name: "Retry" }));
    const retryCloseControl = captureControl(
      within(retryPanel).getByRole("button", { name: "Close activity" }),
    );
    const loadControl = captureControl(within(pagePanel).getByRole("button", { name: "Load more" }));
    const pageCloseControl = captureControl(
      within(pagePanel).getByRole("button", { name: "Close activity" }),
    );
    retryReentry = retryControl;
    pageReentry = loadControl;
    const detached = document.createElement("button");
    const sibling = document.createElement("button");
    document.body.append(sibling);
    const foreignDocument = document.implementation.createHTMLDocument("foreign");
    const foreign = foreignDocument.createElement("button");
    foreignDocument.body.append(foreign);
    const replacement = retryControl.element.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("Expected a replacement button");
    const focused = document.activeElement;

    const fabricated = {
      ...capturedMouseEvent(retryControl),
      nativeEvent: new Event("click"),
    };
    const wrongType = {
      ...capturedMouseEvent(loadControl),
      type: "pointerdown",
    };
    const mismatchedTarget = capturedMouseEvent(
      retryControl,
      retryControl.element,
      retryControl.element,
      sibling,
    );

    act(() => {
      invoke(retryControl, loadControl.element);
      invoke(loadControl, retryControl.element);
      invoke(retryCloseControl, pageCloseControl.element);
      invoke(retryControl, detached);
      invoke(retryControl, sibling);
      invoke(retryControl, foreign);
      retryControl.click(fabricated);
      loadControl.click(wrongType);
      retryControl.click(mismatchedTarget);
      retryControl.element.disabled = true;
      invoke(retryControl);
      retryControl.element.disabled = false;
    });

    const injected = document.createElement("span");
    retryControl.element.append(injected);
    act(() => invoke(retryControl, retryControl.element, injected));
    injected.remove();

    const retryParent = retryControl.element.parentElement;
    if (!retryParent) throw new Error("Retry has no parent");
    const alert = within(retryPanel).getByRole("alert");
    const alertParent = alert.parentElement;
    const alertReplacement = alert.cloneNode(true);
    if (!alertParent) throw new Error("Alert has no parent");
    alertParent.replaceChild(alertReplacement, alert);
    act(() => invoke(retryControl));
    alertParent.replaceChild(alert, alertReplacement);

    retryParent.replaceChild(replacement, retryControl.element);
    act(() => {
      invoke(retryControl);
      invoke(retryControl, replacement);
    });
    retryParent.replaceChild(retryControl.element, replacement);

    const closeParent = retryCloseControl.element.parentElement;
    const closeReplacement = retryCloseControl.element.cloneNode(true);
    if (!closeParent) throw new Error("Close has no parent");
    closeParent.replaceChild(closeReplacement, retryCloseControl.element);
    act(() => {
      invoke(retryCloseControl);
      invoke(retryCloseControl, closeReplacement);
    });
    closeParent.replaceChild(retryCloseControl.element, closeReplacement);

    expect(activity).toHaveBeenCalledTimes(2);
    expect(retryClose).not.toHaveBeenCalled();
    expect(pageClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(focused);
    expect(fabricated.defaultPrevented).toBe(false);
    expect(wrongType.defaultPrevented).toBe(false);
    expect(mismatchedTarget.defaultPrevented).toBe(false);

    const retryEvent = capturedMouseEvent(retryControl);
    const loadEvent = capturedMouseEvent(loadControl);
    act(() => {
      retryControl.click(retryEvent);
      retryControl.click(retryEvent);
      loadControl.click(loadEvent);
      loadControl.click(loadEvent);
    });
    expect(activity).toHaveBeenCalledTimes(3);
    expect(activity).toHaveBeenNthCalledWith(3, "exact-page", {
      before: "page-cursor",
      limit: 50,
    });

    const currentRetryClose = captureControl(
      within(retryPanel).getByRole("button", { name: "Close activity" }),
    );
    const currentPageClose = captureControl(
      within(pagePanel).getByRole("button", { name: "Close activity" }),
    );
    retryCloseReentry = currentRetryClose;
    pageCloseReentry = currentPageClose;
    act(() => {
      invoke(currentRetryClose);
      invoke(currentRetryClose);
      invoke(currentPageClose);
      invoke(currentPageClose);
    });
    expect(retryClose).not.toHaveBeenCalled();
    expect(pageClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(3);
    sibling.remove();
  });

  it.each([
    ["stale before current", false],
    ["current before stale", true],
  ] as const)(
    "retires a same-DOM row mutation and reorder before the parent layout boundary, %s",
    async (_label, currentFirst) => {
      const items = [row("first", "First editor"), row("second", "Second editor")];
      const page = deferred<ActivityPageDto>();
      activity
        .mockResolvedValueOnce({ items, nextBefore: "mutable-cursor" })
        .mockReturnValueOnce(page.promise);
      const stableSession = session("mutable-list");
      const onClose = vi.fn();
      const view = createDirectActivity({ session: stableSession, onClose });
      await act(async () => {});
      const stale = captureControl(screen.getByRole("button", { name: "Load more" }));
      const staleRows = screen.getAllByTestId("activity-row");

      items[0]!.actorName = "Mutated first editor";
      items.reverse();
      let current!: CapturedControl;
      renderDirectActivity(view.root, {
        session: stableSession,
        onClose,
        boundary: 1,
        onBoundary: () => {
          current = captureControl(screen.getByRole("button", { name: "Load more" }));
          expect(current.element).toBe(stale.element);
          expect(screen.getAllByTestId("activity-row")[1]).toBe(staleRows[0]);
        },
      });

      act(() => {
        if (currentFirst) invoke(current);
        invoke(stale, current.element);
        if (!currentFirst) invoke(current);
      });
      expect(activity).toHaveBeenCalledTimes(2);
      expect(activity).toHaveBeenLastCalledWith("mutable-list", {
        before: "mutable-cursor",
        limit: 50,
      });
      expect(screen.getByText("Mutated first editor")).toBeInTheDocument();
      expect(screen.getAllByTestId("activity-row")[0]).toHaveTextContent("Second editor");
    },
  );

  it.each([
    ["A first", false],
    ["B first", true],
  ] as const)(
    "isolates equal-looking remount callbacks, late refs, and passive cleanup, %s",
    async (_label, currentFirst) => {
      const pending = deferred<ActivityPageDto>();
      activity
        .mockRejectedValueOnce("first failure")
        .mockRejectedValueOnce("second failure")
        .mockReturnValueOnce(pending.promise);
      const stableSession = session("equal-remount");
      const onClose = vi.fn();
      const passiveCleanup = vi.fn();
      const view = createDirectActivity({
        session: stableSession,
        onClose,
        instance: "A",
        onPassiveCleanup: passiveCleanup,
      });
      await act(async () => {});
      const stalePanel = screen.getByTestId("activity-panel");
      const staleRetry = captureControl(screen.getByRole("button", { name: "Retry" }));
      const stalePanelRef = reactRef(stalePanel);
      let currentPanel!: HTMLElement;
      let cleanupAtBoundary = -1;

      renderDirectActivity(view.root, {
        session: stableSession,
        onClose,
        instance: "B",
        boundary: 1,
        onBoundary: () => {
          cleanupAtBoundary = passiveCleanup.mock.calls.length;
          currentPanel = screen.getByTestId("activity-panel");
          expect(currentPanel).not.toBe(stalePanel);
          expect(stalePanel.isConnected).toBe(false);
          invoke(staleRetry);
        },
      });
      await act(async () => {});
      expect(cleanupAtBoundary).toBe(0);
      expect(passiveCleanup).toHaveBeenCalledOnce();
      const current = captureControl(screen.getByRole("button", { name: "Retry" }));
      expect(current.element).not.toBe(staleRetry.element);

      act(() => {
        stalePanelRef(currentPanel);
        staleRetry.ref(current.element);
        staleRetry.ref(null);
        stalePanelRef(null);
        invoke(staleRetry, staleRetry.element);
        invoke(staleRetry, current.element);
        invoke(current, staleRetry.element);
        if (currentFirst) invoke(current);
        invoke(staleRetry, current.element);
        if (!currentFirst) invoke(current);
      });

      expect(activity).toHaveBeenCalledTimes(3);
      expect(activity).toHaveBeenLastCalledWith("equal-remount", { limit: 50 });
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("keeps restored publication regions retired until React commits a fresh publication", async () => {
    const page = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce({
        items: [row("dom-row", "DOM editor")],
        nextBefore: "dom-cursor",
      })
      .mockReturnValueOnce(page.promise);
    const stableSession = session("dom-replacement");
    const onClose = vi.fn();
    const rendered = render(
      <ActivityPanel session={stableSession} onClose={onClose} />,
    );
    await act(async () => {});
    const panel = screen.getByTestId("activity-panel");
    const header = panel.firstElementChild;
    const scroll = panel.lastElementChild;
    const content = scroll?.firstElementChild;
    const group = content?.firstElementChild;
    const rowElement = screen.getByTestId("activity-row");
    const load = captureControl(screen.getByRole("button", { name: "Load more" }));
    if (
      !header ||
      !scroll ||
      !content ||
      !group ||
      !(rowElement instanceof HTMLLIElement)
    ) {
      throw new Error("Expected the complete activity publication");
    }
    const regions = [header, scroll, content, group, rowElement, load.element];

    for (const region of regions) {
      const parent = region.parentElement;
      const replacement = region.cloneNode(true);
      if (!parent) throw new Error("Publication region has no parent");
      parent.replaceChild(replacement, region);
      act(() => invoke(load));
      parent.replaceChild(region, replacement);
    }
    const panelParent = panel.parentElement;
    const panelReplacement = panel.cloneNode(true);
    if (!panelParent) throw new Error("Panel has no parent");
    panelParent.replaceChild(panelReplacement, panel);
    act(() => invoke(load));
    panelParent.replaceChild(panel, panelReplacement);

    expect(activity).toHaveBeenCalledOnce();
    act(() => {
      invoke(load);
      invoke(load);
    });
    expect(activity).toHaveBeenCalledOnce();

    rendered.rerender(
      <ActivityPanel session={stableSession} onClose={onClose} />,
    );
    const currentLoad = captureControl(
      screen.getByRole("button", { name: "Load more" }),
    );
    act(() => {
      invoke(load, currentLoad.element);
      invoke(currentLoad);
      invoke(currentLoad);
    });
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenLastCalledWith("dom-replacement", {
      before: "dom-cursor",
      limit: 50,
    });
  });

  it("retires a mutated session before replacement and gives only the new document control authority", async () => {
    activity.mockImplementation((documentId: string) =>
      Promise.resolve({
        items: [row(documentId, `${documentId} editor`)],
        nextBefore: null,
      }));
    const mutableSession = session("session-A");
    const oldClose = vi.fn();
    const newClose = vi.fn();
    const view = createDirectActivity({ session: mutableSession, onClose: oldClose });
    await act(async () => {});
    const stale = captureControl(screen.getByRole("button", { name: "Close activity" }));

    (mutableSession as { docId: string }).docId = "session-B";
    act(() => invoke(stale));
    expect(oldClose).not.toHaveBeenCalled();

    let currentPanel!: HTMLElement;
    renderDirectActivity(view.root, {
      session: mutableSession,
      onClose: newClose,
      boundary: 1,
      onBoundary: () => {
        currentPanel = screen.getByTestId("activity-panel");
        invoke(stale);
      },
    });
    await act(async () => {});
    const current = captureControl(
      within(currentPanel).getByRole("button", { name: "Close activity" }),
    );
    act(() => {
      invoke(stale, current.element);
      invoke(current, stale.element);
      invoke(current);
      invoke(current);
    });
    expect(oldClose).not.toHaveBeenCalled();
    expect(newClose).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenNthCalledWith(1, "session-A", { limit: 50 });
    expect(activity).toHaveBeenNthCalledWith(2, "session-B", { limit: 50 });
  });
});

describe("ActivityPanel header focus movement", () => {
  it.each([
    ["ArrowRight", "Refresh activity", "Close activity"],
    ["ArrowDown", "Refresh activity", "Close activity"],
    ["End", "Refresh activity", "Close activity"],
    ["ArrowLeft", "Close activity", "Refresh activity"],
    ["ArrowUp", "Close activity", "Refresh activity"],
    ["Home", "Close activity", "Refresh activity"],
  ] as const)(
    "moves %s from %s to %s once, without acting, fetching or scrolling",
    async (key, from, to) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`header-${key}-${from}`, onClose);
      const source = headerControl(from);
      const destination = headerControl(to);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;
      const published = activityPanel().innerHTML;
      const scroll = activityPanel().lastElementChild;
      const scrollBefore = [window.scrollX, window.scrollY, scroll?.scrollTop ?? 0];

      const event = activityKey(source, key);

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(focus.mock.instances[0]).toBe(destination);
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
      expect(activityPanel().innerHTML).toBe(published);
      expect([
        window.scrollX,
        window.scrollY,
        activityPanel().lastElementChild?.scrollTop ?? 0,
      ]).toEqual(scrollBefore);
      expect(headerControl("Refresh activity")).toBeEnabled();
      expect(headerControl("Close activity")).toBeEnabled();
    },
  );

  it.each([
    ["ArrowLeft", "Numpad4", "Close activity", "Refresh activity"],
    ["ArrowUp", "Numpad8", "Close activity", "Refresh activity"],
    ["ArrowRight", "Numpad6", "Refresh activity", "Close activity"],
    ["ArrowDown", "Numpad2", "Refresh activity", "Close activity"],
    ["Home", "Numpad7", "Close activity", "Refresh activity"],
    ["End", "Numpad1", "Refresh activity", "Close activity"],
  ] as const)(
    "accepts %s from %s at the numpad location without acting",
    async (key, code, from, to) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`header-numpad-${code}`, onClose);
      const source = headerControl(from);
      const destination = headerControl(to);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;

      const event = activityKeyboardEvent(source, key, {
        code,
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });
      const ownerWindow = source.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("Activity has no owner Window");
      setActivityEventView(event, ownerWindow);
      expect(event.view).toBe(ownerWindow);
      act(() => source.dispatchEvent(event));

      expect(event.code).toBe(code);
      expect(event.location).toBe(KeyboardEvent.DOM_KEY_LOCATION_NUMPAD);
      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ArrowLeft", "Refresh activity"],
    ["ArrowUp", "Refresh activity"],
    ["Home", "Refresh activity"],
    ["ArrowRight", "Close activity"],
    ["ArrowDown", "Close activity"],
    ["End", "Close activity"],
  ] as const)(
    "leaves %s on %s inert at the header boundary and keeps the panel usable",
    async (key, from) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      await mountHeaderView(`boundary-${key}-${from}`, onClose);
      const source = headerControl(from);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const requests = activity.mock.calls.length;

      const event = activityKey(source, key);

      expect(event.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(activity).toHaveBeenCalledTimes(requests);
      expect(onClose).not.toHaveBeenCalled();

      const accepted = activityKey(
        source,
        from === "Refresh activity" ? "ArrowRight" : "ArrowLeft",
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledOnce();
    },
  );

  it.each(["present", "absent", "mutated"] as const)(
    "authenticates the backing Window receiver when private React metadata is %s",
    async (privateMetadata) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-window-receiver-${privateMetadata}`);
      const refresh = headerControl("Refresh activity");
      const close = headerControl("Close activity");
      const capture = reactHandler<ActivityKeyHandler>(
        refresh,
        "onKeyDownCapture",
      );
      const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
      const captures: ReactKeyboardEvent<HTMLButtonElement>[] = [];
      const bubbles: ReactKeyboardEvent<HTMLButtonElement>[] = [];
      const captureMethods: unknown[][] = [];
      const bubbleMethods: unknown[][] = [];
      const cancellationStates: boolean[][] = [];
      const phaseFacts: Array<readonly [number, EventTarget | null]> = [];
      const stagePrivateMetadata = (
        event: ReactKeyboardEvent<HTMLButtonElement>,
      ) => {
        if (privateMetadata === "absent") {
          Reflect.deleteProperty(event, "_reactName");
        } else if (privateMetadata === "mutated") {
          Object.defineProperty(event, "_reactName", {
            configurable: true,
            value: "onPrivateMetadataChanged",
          });
        }
      };
      const propsKey = Object.keys(refresh).find((key) =>
        key.startsWith("__reactProps$"),
      );
      if (!propsKey) {
        throw new Error(
          "React props were not attached to the Activity control",
        );
      }
      const record = refresh as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const originalProps = record[propsKey];
      record[propsKey] = {
        ...originalProps,
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          stagePrivateMetadata(event);
          captures.push(event);
          captureMethods.push([
            event.preventDefault,
            event.stopPropagation,
            event.isDefaultPrevented,
            event.isPropagationStopped,
            event.persist,
          ]);
          cancellationStates.push([
            event.isDefaultPrevented(),
            event.isPropagationStopped(),
          ]);
          phaseFacts.push([event.eventPhase, event.currentTarget]);
          capture(event);
        },
        onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          stagePrivateMetadata(event);
          bubbles.push(event);
          bubbleMethods.push([
            event.preventDefault,
            event.stopPropagation,
            event.isDefaultPrevented,
            event.isPropagationStopped,
            event.persist,
          ]);
          cancellationStates.push([
            event.isDefaultPrevented(),
            event.isPropagationStopped(),
          ]);
          phaseFacts.push([event.eventPhase, event.currentTarget]);
          bubble(event);
        },
      };
      const ownerWindow = refresh.ownerDocument.defaultView;
      const currentTargetGetter = ownerWindow
        ? Object.getOwnPropertyDescriptor(
            ownerWindow.Event.prototype,
            "currentTarget",
          )?.get
        : undefined;
      const composedPath = ownerWindow?.Event.prototype.composedPath;
      if (!ownerWindow || !currentTargetGetter || !composedPath) {
        throw new Error("Activity Window event intrinsics were unavailable");
      }
      const nativeDelivery: {
        receiver?: EventTarget;
        currentTarget?: EventTarget | null;
        terminal?: EventTarget;
      } = {};
      const event = activityKeyboardEvent(refresh, "ArrowRight");
      const observeReceiver = function (this: EventTarget, nativeEvent: Event) {
        if (nativeEvent !== event) return;
        nativeDelivery.receiver = this;
        nativeDelivery.currentTarget = Reflect.apply(
          currentTargetGetter,
          nativeEvent,
          [],
        ) as EventTarget | null;
        nativeDelivery.terminal = Reflect.apply(
          composedPath,
          nativeEvent,
          [],
        ).at(-1);
      };
      ownerWindow.addEventListener("keydown", observeReceiver, true);
      refresh.focus();
      focus.mockClear();

      try {
        act(() => refresh.dispatchEvent(event));
      } finally {
        ownerWindow.removeEventListener("keydown", observeReceiver, true);
        record[propsKey] = originalProps;
      }

      expect(captures).toHaveLength(1);
      expect(bubbles).toHaveLength(1);
      expect(captures[0]).not.toBe(bubbles[0]);
      expect(captures[0]!.nativeEvent).toBe(event);
      expect(bubbles[0]!.nativeEvent).toBe(event);
      expect(captureMethods).toHaveLength(1);
      expect(bubbleMethods).toHaveLength(1);
      expect(cancellationStates).toEqual([
        [false, false],
        [false, false],
      ]);
      expect(phaseFacts).toEqual([
        [Event.CAPTURING_PHASE, refresh],
        [Event.BUBBLING_PHASE, refresh],
      ]);
      expect(nativeDelivery.receiver).toBe(nativeDelivery.currentTarget);
      expect(nativeDelivery.receiver).toBe(nativeDelivery.terminal);
      expect(event.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("prevents through the exact bubble wrapper before a same-root ancestor observes it", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const nativePreventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    const observations: Array<{
      event: ReactKeyboardEvent<HTMLDivElement>;
      defaultPrevented: boolean;
      nativeDefaultPrevented: boolean;
      query: boolean;
    }> = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    directRoots.add(root);
    act(() =>
      root.render(
        <StrictMode>
          <div
            onKeyDown={(event) => {
              observations.push({
                event,
                defaultPrevented: event.defaultPrevented,
                nativeDefaultPrevented: event.nativeEvent.defaultPrevented,
                query: event.isDefaultPrevented(),
              });
            }}
          >
            <ActivityVisitBoundary
              session={session("header-synthetic-ancestor")}
              onClose={onClose}
            />
          </div>
        </StrictMode>,
      ),
    );
    await act(async () => {});
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const capture = reactHandler<ActivityKeyHandler>(
      refresh,
      "onKeyDownCapture",
    );
    const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    let captureWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    let capturePreventDefault: unknown;
    let bubblePreventDefault: unknown;
    const publicPreventReceivers: ReactKeyboardEvent<HTMLButtonElement>[] = [];
    const restoreCapture = replaceKeyHandler(
      refresh,
      (event) => {
        captureWrapper = event;
        capturePreventDefault = event.preventDefault;
        capture(event);
      },
      "onKeyDownCapture",
    );
    const restoreBubble = replaceKeyHandler(refresh, (event) => {
      bubbleWrapper = event;
      const originalPreventDefault = event.preventDefault;
      const publicPreventDefault = function (
        this: ReactKeyboardEvent<HTMLButtonElement>,
      ) {
        publicPreventReceivers.push(this);
        return Reflect.apply(originalPreventDefault, this, []);
      };
      Object.defineProperty(event, "preventDefault", {
        configurable: true,
        value: publicPreventDefault,
      });
      bubblePreventDefault = publicPreventDefault;
      bubble(event);
    });
    refresh.focus();
    focus.mockClear();
    nativePreventDefault.mockClear();
    const requests = activity.mock.calls.length;
    const published = activityPanel().innerHTML;
    const scroll = activityPanel().lastElementChild;
    const scrollBefore = [window.scrollX, window.scrollY, scroll?.scrollTop ?? 0];
    const event = activityKeyboardEvent(refresh, "ArrowRight");
    const ownerWindow = refresh.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Activity has no owner Window");
    setActivityEventView(event, ownerWindow);
    expect(event.view).toBe(ownerWindow);

    try {
      act(() => refresh.dispatchEvent(event));
    } finally {
      restoreBubble();
      restoreCapture();
    }

    expect(captureWrapper).not.toBeNull();
    expect(bubbleWrapper).not.toBeNull();
    expect(captureWrapper).not.toBe(bubbleWrapper);
    expect(capturePreventDefault).not.toBe(bubblePreventDefault);
    expect(publicPreventReceivers).toEqual([bubbleWrapper]);
    expect(observations).toEqual([
      {
        event: bubbleWrapper,
        defaultPrevented: true,
        nativeDefaultPrevented: true,
        query: true,
      },
    ]);
    expect(event.defaultPrevented).toBe(true);
    expect(nativePreventDefault).toHaveBeenCalledOnce();
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(activityPanel().innerHTML).toBe(published);
    expect([
      window.scrollX,
      window.scrollY,
      activityPanel().lastElementChild?.scrollTop ?? 0,
    ]).toEqual(scrollBefore);
  });

  it.each([
    ["persist", "absent"],
    ["persist", "replaced"],
    ["persist", "non-function"],
    ["stopPropagation", "absent"],
    ["stopPropagation", "replaced"],
    ["stopPropagation", "non-function"],
  ] as const)(
    "ignores a %s method that is %s on both legitimate wrappers",
    async (property, state) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-optional-${property}-${state}`);
      const refresh = headerControl("Refresh activity");
      const close = headerControl("Close activity");
      const capture = reactHandler<ActivityKeyHandler>(
        refresh,
        "onKeyDownCapture",
      );
      const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
      const wrappers: ReactKeyboardEvent<HTMLButtonElement>[] = [];
      const optionalValues: unknown[] = [];
      const stage = (
        event: ReactKeyboardEvent<HTMLButtonElement>,
        handler: ActivityKeyHandler,
      ) => {
        wrappers.push(event);
        if (state === "absent") {
          const requiredMethods = [
            ["preventDefault", event.preventDefault],
            ["isDefaultPrevented", event.isDefaultPrevented],
            ["isPropagationStopped", event.isPropagationStopped],
          ] as const;
          Reflect.deleteProperty(event, property);
          Object.setPrototypeOf(event, null);
          for (const [name, method] of requiredMethods) {
            Object.defineProperty(event, name, {
              configurable: true,
              value: method,
            });
          }
          optionalValues.push(Reflect.has(event, property));
        } else {
          const value = state === "replaced" ? () => undefined : 17;
          Object.defineProperty(event, property, {
            configurable: true,
            value,
          });
          optionalValues.push(event[property]);
        }
        handler(event);
      };
      const restoreCapture = replaceKeyHandler(
        refresh,
        (event) => stage(event, capture),
        "onKeyDownCapture",
      );
      const restoreBubble = replaceKeyHandler(refresh, (event) =>
        stage(event, bubble));
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = activityKeyboardEvent(refresh, "ArrowRight");
      try {
        act(() => refresh.dispatchEvent(event));
      } finally {
        restoreBubble();
        restoreCapture();
      }

      expect(wrappers).toHaveLength(2);
      expect(wrappers[0]).not.toBe(wrappers[1]);
      if (state === "absent") {
        expect(optionalValues).toEqual([false, false]);
      } else if (state === "replaced") {
        expect(optionalValues).toHaveLength(2);
        expect(optionalValues.every((value) => typeof value === "function")).toBe(
          true,
        );
      } else {
        expect(optionalValues).toEqual([17, 17]);
      }
      expect(event.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("ignores unrelated prototypes on the distinct legitimate wrappers", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView("header-unrelated-wrapper-prototypes");
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const capture = reactHandler<ActivityKeyHandler>(
      refresh,
      "onKeyDownCapture",
    );
    const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const phases = ["unrelated-capture", "unrelated-bubble"] as const;
    const prototypes: object[] = [];
    const wrappers: ReactKeyboardEvent<HTMLButtonElement>[] = [];
    const inheritedMethods: boolean[] = [];
    const stage = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      handler: ActivityKeyHandler,
      phase: (typeof phases)[number],
    ) => {
      const requiredMethods = [
        ["preventDefault", event.preventDefault],
        ["isDefaultPrevented", event.isDefaultPrevented],
        ["isPropagationStopped", event.isPropagationStopped],
      ] as const;
      const prototype = Object.create(null) as Record<string, unknown>;
      prototype.phase = phase;
      for (const [name, method] of requiredMethods) {
        prototype[name] = method;
        Reflect.deleteProperty(event, name);
      }
      Object.seal(prototype);
      Object.setPrototypeOf(event, prototype);
      prototypes.push(prototype);
      wrappers.push(event);
      inheritedMethods.push(
        requiredMethods.every(([name]) => !Object.hasOwn(event, name)),
      );
      handler(event);
    };
    const restoreCapture = replaceKeyHandler(
      refresh,
      (event) => stage(event, capture, phases[0]),
      "onKeyDownCapture",
    );
    const restoreBubble = replaceKeyHandler(refresh, (event) =>
      stage(event, bubble, phases[1]));
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = activityKeyboardEvent(refresh, "ArrowRight");
    try {
      act(() => refresh.dispatchEvent(event));
    } finally {
      restoreBubble();
      restoreCapture();
    }

    expect(wrappers).toHaveLength(2);
    expect(wrappers[0]).not.toBe(wrappers[1]);
    expect(inheritedMethods).toEqual([true, true]);
    expect(Object.getPrototypeOf(wrappers[0]!)).toBe(prototypes[0]);
    expect(Object.getPrototypeOf(wrappers[1]!)).toBe(prototypes[1]);
    expect(event.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each([
    ["one", false, 1],
    ["nested", true, 2],
  ] as const)(
    "retains native delivery through %s microtask checkpoints before React",
    async (label, nested, expectedCheckpoints) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-${label}-microtasks`);
      const refresh = headerControl("Refresh activity");
      const close = headerControl("Close activity");
      const ownerWindow = refresh.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("Activity has no owner Window");
      const scheduled: VoidFunction[] = [];
      let checkpoints = 0;
      const queueMicrotaskSpy = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((callback) => {
          scheduled.push(callback);
        });
      queueMicrotask(() => {
        checkpoints += 1;
        if (nested) {
          queueMicrotask(() => {
            checkpoints += 1;
          });
        }
      });
      const runCheckpoints = () => {
        if (nested) {
          while (scheduled.length > 0) scheduled.shift()?.();
        } else {
          scheduled.shift()?.();
        }
      };
      ownerWindow.addEventListener("keydown", runCheckpoints, true);
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const event = activityKeyboardEvent(refresh, "ArrowRight");
      try {
        act(() => refresh.dispatchEvent(event));
      } finally {
        ownerWindow.removeEventListener("keydown", runCheckpoints, true);
        while (scheduled.length > 0) scheduled.shift()?.();
        queueMicrotaskSpy.mockRestore();
      }

      expect(checkpoints).toBe(expectedCheckpoints);
      expect(event.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it.each([
    ["capture", "preventDefault"],
    ["capture", "isDefaultPrevented"],
    ["capture", "isPropagationStopped"],
    ["bubble", "preventDefault"],
    ["bubble", "isDefaultPrevented"],
    ["bubble", "isPropagationStopped"],
  ] as const)(
    "rejects %s wrapper %s drift and accepts a clean successor",
    async (phase, property) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-${phase}-${property}-drift`);
      const refresh = headerControl("Refresh activity");
      const close = headerControl("Close activity");
      const handlerName =
        phase === "capture" ? "onKeyDownCapture" : "onKeyDown";
      const handler = reactHandler<ActivityKeyHandler>(refresh, handlerName);
      const restore = replaceKeyHandler(
        refresh,
        (event) => {
          handler(event);
          Object.defineProperty(event, property, {
            configurable: true,
            value: () => false,
          });
        },
        handlerName,
      );
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = activityKeyboardEvent(refresh, "ArrowRight");
      try {
        act(() => refresh.dispatchEvent(rejected));
      } finally {
        restore();
      }

      expect(rejected.defaultPrevented).toBe(false);
      expect(refresh).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      const accepted = activityKey(refresh, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(close).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    },
  );

  it("requires propagation to remain public and unstopped after prevention", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView("header-propagation-after-prevention");
    const refresh = headerControl("Refresh activity");
    const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const restore = replaceKeyHandler(refresh, (event) => {
      const originalPreventDefault = event.preventDefault;
      Object.defineProperty(event, "preventDefault", {
        configurable: true,
        value: function (this: ReactKeyboardEvent<HTMLButtonElement>) {
          Reflect.apply(originalPreventDefault, this, []);
          Object.defineProperty(this, "isPropagationStopped", {
            configurable: true,
            value: () => true,
          });
        },
      });
      bubble(event);
    });
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = activityKeyboardEvent(refresh, "ArrowRight");
    try {
      act(() => refresh.dispatchEvent(rejected));
    } finally {
      restore();
    }

    expect(rejected.defaultPrevented).toBe(true);
    expect(refresh).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();

    const successorRefresh = headerControl("Refresh activity");
    const accepted = activityKey(successorRefresh, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("keeps a reentrant native delivery and its replay inert before clean recovery", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView("header-reentrant-delivery");
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const restore = replaceKeyHandler(refresh, (event) => {
      bubble(event);
      bubble(event);
    });
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const reentrant = activityKeyboardEvent(refresh, "ArrowRight");

    try {
      act(() => {
        refresh.dispatchEvent(reentrant);
        refresh.dispatchEvent(reentrant);
      });
    } finally {
      restore();
    }

    expect(reentrant.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const accepted = activityKey(refresh, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("drops an open delivery on retirement before a clean publication recovers", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    const view = await mountHeaderView("header-retired-delivery", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const ownerWindow = refresh.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Activity has no owner Window");
    const retireDuringCapture = () => close.click();
    ownerWindow.addEventListener("keydown", retireDuringCapture, true);
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const retired = activityKeyboardEvent(refresh, "ArrowRight");

    try {
      act(() => {
        refresh.dispatchEvent(retired);
        refresh.dispatchEvent(retired);
      });
    } finally {
      ownerWindow.removeEventListener("keydown", retireDuringCapture, true);
    }

    expect(onClose).toHaveBeenCalledOnce();
    expect(retired.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    act(() => view.root.unmount());
    directRoots.delete(view.root);
    view.host.remove();
    await mountHeaderView("header-retired-delivery-successor");
    const successor = headerControl("Refresh activity");
    successor.focus();
    focus.mockClear();
    const accepted = activityKey(successor, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("rejects a structural Window terminal while retaining the genuine backing receiver", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView("header-structural-window");
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const ownerWindow = refresh.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("Activity has no owner Window");
    const structural = Object.create(
      ownerWindow.Window.prototype,
    ) as EventTarget;
    Object.defineProperties(structural, {
      document: { value: refresh.ownerDocument },
      Window: { value: ownerWindow.Window },
      Event: { value: ownerWindow.Event },
      EventTarget: { value: ownerWindow.EventTarget },
      KeyboardEvent: { value: ownerWindow.KeyboardEvent },
      Object: { value: ownerWindow.Object },
      Reflect: { value: ownerWindow.Reflect },
      window: { value: structural },
      self: { value: structural },
    });
    const observation: {
      receiver?: EventTarget;
      currentTarget?: EventTarget | null;
      terminal?: EventTarget;
    } = {};
    const event = activityKeyboardEvent(refresh, "ArrowRight");
    const stageTerminal = vi.fn(function (
      this: EventTarget,
      nativeEvent: Event,
    ) {
      if (nativeEvent !== event) return;
      observation.receiver = this;
      observation.currentTarget = nativeEvent.currentTarget;
      observation.terminal = nativeEvent.composedPath().at(-1);
      replaceActivityPathTerminal(nativeEvent, structural);
    });
    ownerWindow.addEventListener("keydown", stageTerminal, {
      capture: true,
      once: true,
    });
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    act(() => refresh.dispatchEvent(event));

    expect(stageTerminal).toHaveBeenCalledOnce();
    expect(observation.receiver).toBe(observation.currentTarget);
    expect(observation.receiver).toBe(observation.terminal);
    expect(observation.receiver).not.toBe(structural);
    expect(event.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const recovered = activityKey(refresh, "ArrowRight");

    expect(recovered.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("rejects a structural document defaultView and recovers through a clean publication", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const view = await mountHeaderView("header-structural-default-view");
    const refresh = headerControl("Refresh activity");
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("Activity has no owner Window");
    const structural = Object.create(
      ownerWindow.Window.prototype,
    ) as Window & typeof globalThis;
    Object.defineProperties(structural, {
      document: { value: document },
      Window: { value: ownerWindow.Window },
      Event: { value: ownerWindow.Event },
      UIEvent: { value: ownerWindow.UIEvent },
      EventTarget: { value: ownerWindow.EventTarget },
      KeyboardEvent: { value: ownerWindow.KeyboardEvent },
      Node: { value: ownerWindow.Node },
      Document: { value: ownerWindow.Document },
      HTMLElement: { value: ownerWindow.HTMLElement },
      MutationObserver: { value: ownerWindow.MutationObserver },
      Object: { value: ownerWindow.Object },
      Reflect: { value: ownerWindow.Reflect },
      window: { value: structural },
      self: { value: structural },
    });
    const previous = Object.getOwnPropertyDescriptor(document, "defaultView");
    const event = activityKeyboardEvent(refresh, "ArrowRight");
    try {
      Object.defineProperty(document, "defaultView", {
        configurable: true,
        value: structural,
      });
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();
      act(() => refresh.dispatchEvent(event));
    } finally {
      if (previous) {
        Object.defineProperty(document, "defaultView", previous);
      } else {
        Reflect.deleteProperty(document, "defaultView");
      }
    }

    const restored = activityKey(refresh, "ArrowRight");

    expect(event.defaultPrevented).toBe(false);
    expect(restored.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    renderStrictActivity(view.root, {
      session: view.session,
      onClose: view.onClose,
    });
    const currentRefresh = headerControl("Refresh activity");
    currentRefresh.focus();
    focus.mockClear();

    const recovered = activityKey(currentRefresh, "ArrowRight");

    expect(recovered.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("rejects changed React cancellation method identity before clean recovery", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView("header-react-method-identity");
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const bubble = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const restore = replaceKeyHandler(refresh, (event) => {
      bubble(event);
      Object.defineProperty(event, "isDefaultPrevented", {
        configurable: true,
        value: () => false,
      });
    });
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = activityKey(refresh, "ArrowRight");
    restore();

    expect(rejected.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const recovered = activityKey(refresh, "ArrowRight");

    expect(recovered.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves every key inert while the refresh control is hidden", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const pending = deferred<ActivityPageDto>();
    activity.mockReturnValue(pending.promise);
    const onClose = vi.fn();
    await mountHeaderView("header-hidden-refresh", onClose);
    expect(screen.queryByRole("button", { name: "Refresh activity" })).toBeNull();
    expect(activityHeader().children).toHaveLength(2);
    const close = headerControl("Close activity");
    close.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves every key inert while the refresh control is disabled", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const pending = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce(headerPage())
      .mockResolvedValueOnce(headerPage())
      .mockReturnValue(pending.promise);
    const onClose = vi.fn();
    await mountHeaderView("header-disabled-refresh", onClose);
    act(() => headerControl("Refresh activity").click());
    const refreshing = headerControl("Refreshing activity");
    const close = headerControl("Close activity");
    expect(refreshing).toBeDisabled();
    close.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["ArrowLeft", "ArrowUp", "Home", "ArrowRight", "End"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
      expect(activityKey(refreshing, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Tab order, Enter/Space activation and pointer actions unchanged", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-activation", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    expect(refresh.nextElementSibling).toBe(close);
    expect(refresh.hasAttribute("tabindex")).toBe(false);
    expect(close.hasAttribute("tabindex")).toBe(false);
    expect([refresh.tabIndex, close.tabIndex]).toEqual([0, 0]);
    close.focus();
    focus.mockClear();
    const requests = activity.mock.calls.length;

    for (const key of ["Enter", " ", "Tab", "Escape"]) {
      expect(activityKey(close, key).defaultPrevented).toBe(false);
    }

    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);

    act(() => refresh.click());
    expect(activity).toHaveBeenCalledTimes(requests + 1);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {});
  });

  it("uses captured owner-realm intrinsics and recovers through clean successors", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-intrinsics", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;
    const publicComposedPath = vi.fn(() => []);
    const publicFocus = vi.fn();
    const event = activityKeyboardEvent(refresh, "ArrowRight");
    Object.defineProperties(event, {
      composedPath: { configurable: true, value: publicComposedPath },
    });
    Object.defineProperty(close, "focus", {
      configurable: true,
      value: publicFocus,
    });

    act(() => {
      refresh.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(publicComposedPath).not.toHaveBeenCalled();
    expect(publicFocus).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();

    const back = activityKey(close, "Home");

    expect(back.defaultPrevented).toBe(true);
    expect(refresh).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects untrusted, fabricated, foreign-realm and foreign-view keys before one genuine pair", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-authority", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const handler = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const ownerWindow = refresh.ownerDocument.defaultView;
    if (!ownerWindow) throw new Error("The Activity owner Window did not mount");
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentDocument?.defaultView;
    if (!foreignWindow) throw new Error("The foreign Activity realm did not mount");
    const untrusted = activityKeyboardEvent(refresh, "ArrowRight", {}, false);
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    markActivityEventTrusted(foreign);
    const foreignView = activityKeyboardEvent(refresh, "ArrowRight");
    setActivityEventView(foreignView, foreignWindow);
    expect(foreignView.view).toBe(foreignWindow);
    const structuralWindow = new Proxy(
      Object.create(Object.getPrototypeOf(ownerWindow), {
        document: { configurable: true, value: refresh.ownerDocument },
        Event: { configurable: true, value: ownerWindow.Event },
        UIEvent: { configurable: true, value: ownerWindow.UIEvent },
        KeyboardEvent: {
          configurable: true,
          value: ownerWindow.KeyboardEvent,
        },
      }),
      {},
    ) as Window;
    const structuralView = activityKeyboardEvent(refresh, "ArrowRight");
    setActivityEventView(structuralView, structuralWindow);
    expect(structuralView.view).toBe(structuralWindow);
    expect(structuralWindow).not.toBe(ownerWindow);
    const replacedKey = activityKeyboardEvent(refresh, "ArrowRight");
    Object.defineProperty(replacedKey, "key", {
      configurable: true,
      value: "End",
    });
    const fabricatedNative = activityKeyboardEvent(refresh, "ArrowRight");
    const fabricated = fabricatedActivityKey(refresh, fabricatedNative);

    act(() => {
      refresh.dispatchEvent(untrusted);
      refresh.dispatchEvent(foreign);
      refresh.dispatchEvent(foreignView);
      refresh.dispatchEvent(structuralView);
      refresh.dispatchEvent(replacedKey);
      handler(fabricated);
    });

    expect(untrusted.defaultPrevented).toBe(false);
    expect(foreign.defaultPrevented).toBe(false);
    expect(foreignView.defaultPrevented).toBe(false);
    expect(structuralView.defaultPrevented).toBe(false);
    expect(replacedKey.defaultPrevented).toBe(false);
    expect(fabricatedNative.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const genuine = activityKeyboardEvent(refresh, "ArrowRight");
    setActivityEventView(genuine, ownerWindow);
    expect(genuine.view).toBe(ownerWindow);
    act(() => refresh.dispatchEvent(genuine));

    expect(genuine.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    frame.remove();
  });

  it.each([
    ["Alt-modified", { altKey: true }],
    ["Control-modified", { ctrlKey: true }],
    ["Meta-modified", { metaKey: true }],
    ["Shift-modified", { shiftKey: true }],
    ["repeating", { repeat: true }],
    ["composing", { isComposing: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects a %s key without prevention or focus", async (_name, init) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    await mountHeaderView(`header-modifier-${_name}`);
    const refresh = headerControl("Refresh activity");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = activityKey(refresh, "ArrowRight", init);

    expect(event.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const accepted = activityKey(refresh, "ArrowRight");
    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
  });

  it.each(["prevented", "propagation-stopped"] as const)(
    "rejects a previously %s key and keeps the publication usable",
    async (state) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      await mountHeaderView(`header-${state}`);
      const refresh = headerControl("Refresh activity");
      refresh.focus();
      focus.mockClear();
      const event = activityKeyboardEvent(refresh, "ArrowRight");
      if (state === "prevented") event.preventDefault();
      else event.stopPropagation();
      preventDefault.mockClear();

      act(() => {
        refresh.dispatchEvent(event);
      });

      expect(refresh).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();

      const accepted = activityKey(refresh, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(headerControl("Close activity")).toHaveFocus();
    },
  );

  it("rejects wrong focus and a crossed control handler", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-crossed", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const refreshHandler = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const unfocused = activityKey(close, "ArrowLeft");

    expect(unfocused.defaultPrevented).toBe(false);
    expect(outside).toHaveFocus();

    const restore = replaceKeyHandler(close, refreshHandler);
    close.focus();
    focus.mockClear();
    const crossed = activityKey(close, "ArrowLeft");
    restore();

    expect(crossed.defaultPrevented).toBe(false);
    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const accepted = activityKey(close, "ArrowLeft");
    expect(accepted.defaultPrevented).toBe(true);
    expect(refresh).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    outside.remove();
  });

  it("rejects stale refresh and document facts, then accepts the committed successor", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const pending = deferred<ActivityPageDto>();
    activity
      .mockResolvedValueOnce(headerPage())
      .mockResolvedValueOnce(headerPage())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(headerPage("successor"));
    const onClose = vi.fn();
    const view = await mountHeaderView("stale-facts-A", onClose);
    const close = headerControl("Close activity");
    const staleHandler = reactHandler<ActivityKeyHandler>(close, "onKeyDown");
    act(() => headerControl("Refresh activity").click());
    pending.resolve(headerPage());
    await act(async () => {});
    expect(headerControl("Refresh activity")).toBeEnabled();
    close.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const restore = replaceKeyHandler(close, staleHandler);
    const stale = activityKey(close, "Home");
    restore();

    expect(stale.defaultPrevented).toBe(false);
    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    const current = activityKey(close, "Home");

    expect(current.defaultPrevented).toBe(true);
    expect(headerControl("Refresh activity")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();

    (view.session as { docId: string }).docId = "stale-facts-B";
    close.focus();
    focus.mockClear();

    const mutated = activityKey(close, "Home");

    expect(mutated.defaultPrevented).toBe(false);
    expect(close).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();

    renderStrictActivity(view.root, { session: view.session, onClose });
    await act(async () => {});
    const currentClose = headerControl("Close activity");
    const currentRefresh = headerControl("Refresh activity");
    expect(currentClose).not.toBe(close);
    currentClose.focus();
    focus.mockClear();

    const accepted = activityKey(currentClose, "ArrowUp");

    expect(accepted.defaultPrevented).toBe(true);
    expect(currentRefresh).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(activity).toHaveBeenLastCalledWith("stale-facts-B", { limit: 50 });
  });

  it.each([
    "restored panel attribute",
    "reordered and restored controls",
    "replaced and restored control",
  ] as const)("retires a %s and recovers through a fresh publication", async (mutation) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    const view = await mountHeaderView(`header-mutation-${mutation}`, onClose);
    const panel = activityPanel();
    const header = activityHeader();
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    if (mutation === "restored panel attribute") {
      panel.setAttribute("data-header-change", "temporary");
      panel.removeAttribute("data-header-change");
    } else if (mutation === "reordered and restored controls") {
      header.insertBefore(close, refresh);
      header.append(close);
    } else {
      const replacement = refresh.cloneNode(true);
      if (!(replacement instanceof HTMLButtonElement)) {
        throw new Error("The replacement refresh control was not a button");
      }
      refresh.replaceWith(replacement);
      replacement.replaceWith(refresh);
    }
    expect(refresh.nextElementSibling).toBe(close);
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const rejected = activityKey(refresh, "ArrowRight");

    expect(rejected.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    renderStrictActivity(view.root, { session: view.session, onClose });
    const currentRefresh = headerControl("Refresh activity");
    currentRefresh.focus();
    focus.mockClear();

    const accepted = activityKey(currentRefresh, "ArrowRight");

    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Close activity")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["key", "location"] as const)(
    "retires replaced %s descriptor history until a fresh publication captures clean intrinsics",
    async (property) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      activity.mockResolvedValue(headerPage());
      const onClose = vi.fn();
      const view = await mountHeaderView(
        `header-descriptors-${property}`,
        onClose,
      );
      const refresh = headerControl("Refresh activity");
      const descriptor = Object.getOwnPropertyDescriptor(
        window.KeyboardEvent.prototype,
        property,
      );
      if (!descriptor) {
        throw new Error(`KeyboardEvent.${property} had no descriptor`);
      }
      refresh.focus();
      focus.mockClear();
      preventDefault.mockClear();
      Object.defineProperty(window.KeyboardEvent.prototype, property, {
        ...descriptor,
        get: () =>
          property === "key"
            ? "ArrowRight"
            : KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });

      const poisoned = activityKey(refresh, "ArrowRight", {
        code: "Numpad6",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });
      Object.defineProperty(
        window.KeyboardEvent.prototype,
        property,
        descriptor,
      );
      const restored = activityKey(refresh, "ArrowRight", {
        code: "Numpad6",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });

      expect(poisoned.defaultPrevented).toBe(false);
      expect(restored.defaultPrevented).toBe(false);
      expect(refresh).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();

      renderStrictActivity(view.root, { session: view.session, onClose });
      const currentRefresh = headerControl("Refresh activity");
      currentRefresh.focus();
      focus.mockClear();

      const accepted = activityKey(currentRefresh, "ArrowRight", {
        code: "Numpad6",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
      });

      expect(accepted.defaultPrevented).toBe(true);
      expect(headerControl("Close activity")).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
    },
  );

  it("claims the publication, movement, wrapper and native event before replay", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-replay", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;
    const event = activityKeyboardEvent(refresh, "ArrowRight");

    act(() => {
      refresh.dispatchEvent(event);
      close.dispatchEvent(event);
      refresh.dispatchEvent(event);
    });

    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();

    const successor = activityKey(close, "ArrowLeft");

    expect(successor.defaultPrevented).toBe(true);
    expect(refresh).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  /**
   * A hostile native listener between the panel and React's delegation root can hand the control's
   * own bubble handler a complete React-like wrapper around the live, genuine, trusted native event
   * before React delivers its own. Neither that forgery nor React's real, now crossed, delivery may
   * prevent, focus, act, fetch or scroll; only a distinct clean event recovers.
   */
  it("rejects a forged wrapper from an earlier native panel listener and the crossed real delivery", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-native-forgery", onClose);
    const panel = activityPanel();
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const bubbleHandler = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;
    const published = panel.innerHTML;
    const scrollBefore = [
      window.scrollX,
      window.scrollY,
      panel.lastElementChild?.scrollTop ?? 0,
    ];
    const forged: string[] = [];
    const real: string[] = [];
    const forge = (native: Event) => {
      forged.push(
        `${native.eventPhase}:${native.currentTarget === panel}:${native.defaultPrevented}`,
      );
      bubbleHandler(fabricatedActivityKey(refresh, native as KeyboardEvent));
    };
    const restoreHandler = replaceKeyHandler(refresh, (event) => {
      real.push(`${event.currentTarget === refresh}:${event.eventPhase}`);
      bubbleHandler(event);
    });
    panel.addEventListener("keydown", forge);

    const forgedEvent = activityKey(refresh, "ArrowRight");

    panel.removeEventListener("keydown", forge);
    restoreHandler();

    expect(forged).toEqual([`${Event.BUBBLING_PHASE}:true:false`]);
    expect(real).toEqual([`true:${Event.BUBBLING_PHASE}`]);
    expect(forgedEvent.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
    expect(activityPanel()).toBe(panel);
    expect(panel.innerHTML).toBe(published);
    expect([
      window.scrollX,
      window.scrollY,
      panel.lastElementChild?.scrollTop ?? 0,
    ]).toEqual(scrollBefore);
    expect(headerControl("Refresh activity")).toBeEnabled();
    expect(headerControl("Close activity")).toBeEnabled();

    const accepted = activityKey(refresh, "ArrowRight");

    expect(accepted.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.instances[0]).toBe(close);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects a replacement callback that withholds React's wrapper and forwards only a forgery", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    await mountHeaderView("header-callback-forgery", onClose);
    const refresh = headerControl("Refresh activity");
    const close = headerControl("Close activity");
    const bubbleHandler = reactHandler<ActivityKeyHandler>(refresh, "onKeyDown");
    const forwarded: Event[] = [];
    const restoreHandler = replaceKeyHandler(refresh, (event) => {
      forwarded.push(event.nativeEvent);
      bubbleHandler(fabricatedActivityKey(refresh, event.nativeEvent));
    });
    refresh.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const requests = activity.mock.calls.length;

    const forgedEvent = activityKey(refresh, "ArrowRight");

    restoreHandler();
    expect(forwarded).toEqual([forgedEvent]);
    expect(forgedEvent.defaultPrevented).toBe(false);
    expect(refresh).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();

    const accepted = activityKey(refresh, "ArrowRight");

    expect(accepted.defaultPrevented).toBe(true);
    expect(close).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(activity).toHaveBeenCalledTimes(requests);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does no keyboard work after cleanup and a clean panel recovers", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    activity.mockResolvedValue(headerPage());
    const onClose = vi.fn();
    const view = await mountHeaderView("header-cleanup", onClose);
    const retiredClose = headerControl("Close activity");
    const staleHandler = reactHandler<ActivityKeyHandler>(retiredClose, "onKeyDown");
    retiredClose.focus();
    focus.mockClear();
    preventDefault.mockClear();

    act(() => view.root.unmount());
    directRoots.delete(view.root);
    view.host.remove();
    const afterCleanup = activityKeyboardEvent(retiredClose, "ArrowLeft");
    const fabricated = fabricatedActivityKey(retiredClose, afterCleanup);
    act(() => {
      retiredClose.dispatchEvent(afterCleanup);
      staleHandler(fabricated);
    });

    expect(afterCleanup.defaultPrevented).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await mountHeaderView("header-cleanup-successor", onClose);
    const currentClose = headerControl("Close activity");
    currentClose.focus();
    focus.mockClear();

    const accepted = activityKey(currentClose, "ArrowLeft");

    expect(accepted.defaultPrevented).toBe(true);
    expect(headerControl("Refresh activity")).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });
});
