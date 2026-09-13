// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  StrictMode,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefCallback,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "./update-pill";

const DOC_ID = "doc-919";
const INITIAL_HASH = "hash-before";
const REPLACEMENT_DOC_ID = "doc-920";
const REPLACEMENT_HASH = "replacement-hash";
const POLL_MS = 1000;
const fetchMock = vi.fn<typeof fetch>();

const response = (contentHash: string, ok = true) =>
  ({
    ok,
    json: vi.fn().mockResolvedValue({ contentHash }),
  }) as unknown as Response;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function ReaderBoundary({
  docId = DOC_ID,
  initialHash = INITIAL_HASH,
  pollMs = POLL_MS,
  show = true,
  visit = "initial",
  onLayout,
}: {
  docId?: string;
  initialHash?: string;
  pollMs?: number;
  show?: boolean;
  visit?: "initial" | "replacement";
  onLayout?: () => void;
}) {
  useLayoutEffect(() => {
    onLayout?.();
  }, [docId, initialHash, pollMs, show, visit, onLayout]);

  if (!show) return null;
  const props = { docId, initialHash, pollMs };
  return visit === "initial" ? <InitialReaderVisit {...props} /> : <ReplacementReaderVisit {...props} />;
}

function InitialReaderVisit(props: { docId: string; initialHash: string; pollMs: number }) {
  return <UpdatePill {...props} />;
}

function ReplacementReaderVisit(props: { docId: string; initialHash: string; pollMs: number }) {
  return <UpdatePill {...props} />;
}

type RefreshClick = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type UpdateKeyDown = (
  event: ReactKeyboardEvent<HTMLButtonElement>,
) => void;

function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

function captureClick(element: HTMLButtonElement) {
  return reactHandler<RefreshClick>(element, "onClick");
}

function captureKeyDown(element: HTMLButtonElement) {
  return reactHandler<UpdateKeyDown>(element, "onKeyDown");
}

function captureKeyDownCapture(element: HTMLButtonElement) {
  return reactHandler<UpdateKeyDown>(
    element,
    "onKeyDownCapture",
  );
}

function updateKeyHandlers(element: HTMLButtonElement) {
  return {
    capture: captureKeyDownCapture(element),
    bubble: captureKeyDown(element),
  };
}

function captureRef<T extends HTMLElement>(element: T) {
  return reactHandler<RefCallback<T>>(element, "ref");
}

function markJsdomEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
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

function updateKeyEvent(
  element: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) {
    throw new Error("The update control has no owner window");
  }
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function dispatchUpdateKey(
  element: HTMLButtonElement,
  keyOrEvent: string | KeyboardEvent,
  init: KeyboardEventInit = {},
) {
  const event =
    typeof keyOrEvent === "string"
      ? updateKeyEvent(element, keyOrEvent, init)
      : keyOrEvent;
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function dispatchUpdateKeyWithHandler(
  element: HTMLButtonElement,
  event: KeyboardEvent,
  onKeyDown: UpdateKeyDown,
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error("React props were not attached to the update control");
  }
  const properties = element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  const replacement = { ...props, onKeyDown };
  properties[propsKey] = replacement;
  try {
    act(() => {
      element.dispatchEvent(event);
    });
  } finally {
    if (properties[propsKey] === replacement) {
      properties[propsKey] = props;
    }
  }
}

function dispatchUpdateKeyWithHandlers(
  element: HTMLButtonElement,
  event: KeyboardEvent,
  {
    capture,
    bubble,
  }: {
    capture: UpdateKeyDown;
    bubble: UpdateKeyDown;
  },
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error(
      "React props were not attached to the update control",
    );
  }
  const properties = element as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  const replacement = {
    ...props,
    onKeyDownCapture: capture,
    onKeyDown: bubble,
  };
  properties[propsKey] = replacement;
  try {
    act(() => {
      element.dispatchEvent(event);
    });
  } finally {
    if (properties[propsKey] === replacement) {
      properties[propsKey] = props;
    }
  }
}

function replaceJsdomPathTerminal(
  event: Event,
  terminal: EventTarget,
) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find((candidate): candidate is {
      _path: Array<{ item: Record<symbol, unknown> }>;
    } => {
      if (!candidate || typeof candidate !== "object") return false;
      return Array.isArray(
        (candidate as { _path?: unknown })._path,
      );
    });
  const entry = implementation?._path.at(-1);
  const currentTerminal = event.composedPath().at(-1);
  const wrapper = entry
    ? Object.getOwnPropertySymbols(entry.item).find(
        (symbol) => entry.item[symbol] === currentTerminal,
      )
    : undefined;
  if (!entry || !wrapper) {
    throw new Error(
      "Unable to replace jsdom's keyboard path terminal",
    );
  }
  const item: Record<symbol, unknown> = {};
  Object.defineProperty(item, wrapper, { value: terminal });
  entry.item = item;
  if (event.composedPath().at(-1) !== terminal) {
    throw new Error(
      "The jsdom keyboard path terminal did not update",
    );
  }
}

function clickEvent(
  currentTarget: HTMLButtonElement,
  {
    type = "click",
    button = 0,
    target = currentTarget,
    nativeType = "click",
    nativeButton = button,
    nativeTarget = target,
    nativeEvent,
  }: {
    type?: string;
    button?: number;
    target?: EventTarget | null;
    nativeType?: string;
    nativeButton?: number;
    nativeTarget?: EventTarget | null;
    nativeEvent?: Event;
  } = {},
) {
  const ownerDocument = currentTarget.ownerDocument;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent;
  if (!MouseEventConstructor) throw new Error("The owner document has no MouseEvent constructor");
  const actualNativeEvent =
    nativeEvent ??
    new MouseEventConstructor(nativeType, {
      bubbles: true,
      cancelable: true,
      button: nativeButton,
    });
  if (nativeEvent === undefined) {
    Object.defineProperty(actualNativeEvent, "target", {
      configurable: true,
      value: nativeTarget,
    });
  }
  return {
    type,
    button,
    currentTarget,
    target,
    nativeEvent: actualNativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
}

function controls(host: ParentNode = document) {
  const pill = host.querySelector<HTMLDivElement>('[data-testid="reader-updated"]');
  const buttons = pill?.querySelectorAll<HTMLButtonElement>("button");
  const button = buttons?.item(0);
  const dismissButton = buttons?.item(1);
  if (!pill || buttons?.length !== 2 || !button || !dismissButton) {
    throw new Error("The complete reader update control was not rendered");
  }
  return { pill, button, dismissButton };
}

function failureControls(host: ParentNode = document) {
  const pill = host.querySelector<HTMLDivElement>(
    '[data-testid="reader-update-error"]',
  );
  const button = pill?.querySelector<HTMLButtonElement>("button");
  if (!pill || !button) {
    throw new Error("The complete reader update failure control was not rendered");
  }
  return { pill, button };
}

function trackVisibilityListeners() {
  const active = new Set<EventListenerOrEventListenerObject>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") active.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "visibilitychange") active.delete(listener);
    remove(type, listener, options);
  });
  return active;
}

function createNavigationSpies() {
  return {
    reload: vi.fn(),
    assign: vi.fn(),
    replace: vi.fn(),
  };
}

async function withNavigation<T>(
  navigation: ReturnType<typeof createNavigationSpies>,
  callback: () => T | Promise<T>,
): Promise<T> {
  const browserWindow = window;
  const controlledWindow = Object.create(browserWindow) as Window;
  Object.defineProperty(controlledWindow, "location", { configurable: true, value: navigation });
  vi.stubGlobal("window", controlledWindow);
  try {
    return await callback();
  } finally {
    vi.stubGlobal("window", browserWindow);
  }
}

describe("UpdatePill polling", () => {
  let visibility: DocumentVisibilityState;
  let unhandledRejection: (event: PromiseRejectionEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    fetchMock.mockReset().mockResolvedValue(response(INITIAL_HASH));
    vi.stubGlobal("fetch", fetchMock);
    unhandledRejection = vi.fn();
    window.addEventListener("unhandledrejection", unhandledRejection);
  });

  afterEach(() => {
    cleanup();
    window.removeEventListener("unhandledrejection", unhandledRejection);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    fireEvent(document, new Event("visibilitychange"));
  };

  const mount = () => render(<UpdatePill docId={DOC_ID} initialHash={INITIAL_HASH} pollMs={POLL_MS} />);

  const requestSignal = (index: number) => fetchMock.mock.calls[index]?.[1]?.signal as AbortSignal;

  const mountDirectStrict = async (
    props: {
      docId?: string;
      initialHash?: string;
      pollMs?: number;
    } = {},
  ) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <StrictMode>
          <UpdatePill
            docId={props.docId ?? DOC_ID}
            initialHash={props.initialHash ?? INITIAL_HASH}
            pollMs={props.pollMs ?? POLL_MS}
          />
        </StrictMode>,
      );
    });
    return { host, root };
  };

  it("checks immediately on a visible mount, then keeps the configured interval cadence", async () => {
    mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(0);
    await advance(POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("suppresses interval ticks while a request is in flight", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    mount();

    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(response(INITIAL_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts on hide, ignores the old response, and checks immediately when visible again", async () => {
    const oldRequest = deferred<Response>();
    const freshRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(freshRequest.promise).mockResolvedValue(response(INITIAL_HASH));
    mount();
    const oldSignal = requestSignal(0);

    setVisibility("hidden");
    expect(oldSignal.aborted).toBe(true);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const freshSignal = requestSignal(1);

    oldRequest.resolve(response("hash-from-aborted-request"));
    await advance(0);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(freshSignal.aborted).toBe(false);

    freshRequest.resolve(response(INITIAL_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts the owned request and clears the timer on unmount", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const { unmount } = mount();
    const signal = requestSignal(0);

    unmount();
    expect(signal.aborted).toBe(true);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(response("hash-after-unmount"));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retires document A before its changed response settles in document B's parent layout effect", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValueOnce(oldRequest.promise).mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        docId={REPLACEMENT_DOC_ID}
        initialHash={REPLACEMENT_HASH}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.resolve(response("changed-after-replacement"));
        }}
      />,
    );
    await advance(0);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/documents/${REPLACEMENT_DOC_ID}/content`);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("keeps document B's request and cadence usable when document A rejects at the replacement boundary", async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
      .mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        docId={REPLACEMENT_DOC_ID}
        initialHash={REPLACEMENT_HASH}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.reject(new TypeError("retired request failed"));
        }}
      />,
    );
    await advance(0);

    expect(abortedAtBoundary).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestSignal(1).aborted).toBe(false);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    currentRequest.resolve(response(REPLACEMENT_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("retires polling before a changed response settles at the parent layout boundary after removal", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValue(oldRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        show={false}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.resolve(response("changed-after-removal"));
        }}
      />,
    );
    await advance(0);
    await advance(POLL_MS * 4);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("retires polling before a rejection settles at the parent layout boundary after removal", async () => {
    const oldRequest = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockReturnValue(oldRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);
    let abortedAtBoundary = false;

    rerender(
      <ReaderBoundary
        show={false}
        onLayout={() => {
          abortedAtBoundary = oldSignal.aborted;
          oldRequest.reject(new TypeError("retired request failed"));
        }}
      />,
    );
    await advance(0);
    await advance(POLL_MS * 4);

    expect(abortedAtBoundary).toBe(true);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("does not let document A's finalizer clear document B's pending request", async () => {
    const oldRequest = deferred<Response>();
    const currentRequest = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
      .mockResolvedValue(response(REPLACEMENT_HASH));
    const { rerender } = render(<ReaderBoundary />);
    const oldSignal = requestSignal(0);

    rerender(<ReaderBoundary docId={REPLACEMENT_DOC_ID} initialHash={REPLACEMENT_HASH} />);
    expect(oldSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    oldRequest.resolve(response("changed-after-current-request-started"));
    await advance(0);
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();

    currentRequest.resolve(response(REPLACEMENT_HASH));
    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clears document A's stale presentation and starts document B immediately", async () => {
    const currentRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response("changed-before-replacement"))
      .mockReturnValueOnce(currentRequest.promise);
    const { rerender } = render(<ReaderBoundary />);
    await advance(0);
    expect(screen.getByTestId("reader-updated")).toBeInTheDocument();

    rerender(<ReaderBoundary docId={REPLACEMENT_DOC_ID} initialHash={REPLACEMENT_HASH} />);

    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/documents/${REPLACEMENT_DOC_ID}/content`);
  });

  it("retries transient and non-2xx failures on following interval ticks", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(response(INITIAL_HASH, false)).mockResolvedValue(response(INITIAL_HASH));
    mount();

    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await advance(0);
    await advance(POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      name: "a rejected request",
      arrange: () => fetchMock.mockRejectedValue(new TypeError("offline")),
    },
    {
      name: "a non-OK response",
      arrange: () => fetchMock.mockResolvedValue(response(INITIAL_HASH, false)),
    },
    {
      name: "a malformed response",
      arrange: () =>
        fetchMock.mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ contentHash: "" }),
        } as unknown as Response),
    },
  ])("publishes one current failure for $name and retains one cadence", async ({ arrange }) => {
    arrange();
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const baseline = fetchMock.mock.calls.length;
      const failure = failureControls(host);

      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      expect(failure.pill).toHaveTextContent("Couldn't check for updates.");
      expect(failure.button).toHaveAccessibleName("Retry now");
      expect(failure.button).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);

      await advance(POLL_MS);
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      expect(failureControls(host).button).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("publishes an interval failure without replacing the current cadence", async () => {
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const baseline = fetchMock.mock.calls.length;
      expect(host.querySelector('[data-testid="reader-update-error"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(1);

      fetchMock.mockRejectedValue(new TypeError("interval offline"));
      await advance(POLL_MS);
      await advance(0);

      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(failureControls(host).button).toBeEnabled();
      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    { remoteHash: INITIAL_HASH, result: "clear" as const },
    { remoteHash: "hash-after-retry", result: "refresh" as const },
  ])("runs one immediate retry and accepts a $result success", async ({ remoteHash, result }) => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const request = deferred<Response>();
      fetchMock.mockReturnValueOnce(request.promise);
      const baseline = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const retry = failureControls(host).button;

      fireEvent.click(retry);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(failureControls(host).button).toBeDisabled();
      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(timers);

      fireEvent.click(failureControls(host).button);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);

      request.resolve(response(remoteHash));
      await advance(0);
      expect(host.querySelector('[data-testid="reader-update-error"]')).toBeNull();
      if (result === "refresh") {
        expect(host.querySelectorAll('[data-testid="reader-updated"]')).toHaveLength(1);
      } else {
        expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();
        expect(vi.getTimerCount()).toBe(1);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("leaves one enabled Retry available after an accepted retry failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const retryFailure = deferred<Response>();
      fetchMock.mockReturnValueOnce(retryFailure.promise);
      const baseline = fetchMock.mock.calls.length;

      fireEvent.click(failureControls(host).button);
      expect(failureControls(host).button).toBeDisabled();
      retryFailure.reject(new TypeError("still offline"));
      await advance(0);

      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      expect(failureControls(host).button).toBeEnabled();
      expect(vi.getTimerCount()).toBe(1);

      const nextRetry = deferred<Response>();
      fetchMock.mockReturnValueOnce(nextRetry.promise);
      fireEvent.click(failureControls(host).button);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 2);
      expect(failureControls(host).button).toBeDisabled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects crossed, fabricated, prevented, stopped, and replayed Retry events", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    const sibling = document.createElement("button");
    const iframe = document.createElement("iframe");
    document.body.append(sibling, iframe);
    try {
      await advance(0);
      const { pill, button } = failureControls(host);
      const retry = captureClick(button);
      const foreignWindow = iframe.contentWindow;
      if (!foreignWindow) throw new Error("The foreign event window was not created");
      const foreignGlobal = foreignWindow as Window & typeof globalThis;
      const foreignEvent = new foreignGlobal.MouseEvent("click", {
        bubbles: true,
        button: 0,
      });
      Object.defineProperty(foreignEvent, "target", {
        configurable: true,
        value: button,
      });
      const malformedNative = clickEvent(button, {
        nativeEvent: new Event("click", { bubbles: true }),
      });
      const prevented = clickEvent(button);
      Object.defineProperty(prevented, "defaultPrevented", {
        configurable: true,
        value: true,
      });
      const nativePrevented = clickEvent(button);
      nativePrevented.nativeEvent.preventDefault();
      const stopped = clickEvent(button);
      Object.defineProperty(stopped, "isPropagationStopped", {
        configurable: true,
        value: () => true,
      });
      const before = pill.outerHTML;
      const baseline = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();

      act(() => {
        retry(clickEvent(sibling));
        retry(clickEvent(button, { button: 1 }));
        retry(clickEvent(button, { target: sibling, nativeTarget: sibling }));
        retry(clickEvent(button, { nativeEvent: foreignEvent }));
        retry(malformedNative);
        retry(prevented);
        retry(nativePrevented);
        retry(stopped);
      });

      expect(fetchMock).toHaveBeenCalledTimes(baseline);
      expect(pill.outerHTML).toBe(before);
      expect(vi.getTimerCount()).toBe(timers);
      expect(prevented.preventDefault).not.toHaveBeenCalled();
      expect(stopped.stopPropagation).not.toHaveBeenCalled();

      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      const activation = clickEvent(button);
      act(() => {
        retry(activation);
        retry(activation);
        retry(clickEvent(button));
      });

      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(failureControls(host).button).toBeDisabled();
      expect(activation.preventDefault).not.toHaveBeenCalled();
      expect(activation.stopPropagation).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      iframe.remove();
      sibling.remove();
      host.remove();
    }
  });

  it("rejects a mutation-tainted Retry click and accepts a clean successor", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const stale = failureControls(host);
      const staleRetry = captureClick(stale.button);
      const baseline = fetchMock.mock.calls.length;
      const markup = stale.pill.outerHTML;

      stale.button.setAttribute("data-transient", "true");
      stale.button.removeAttribute("data-transient");
      staleRetry(clickEvent(stale.button));

      expect(fetchMock).toHaveBeenCalledTimes(baseline);
      expect(stale.pill.outerHTML).toBe(markup);

      await advance(POLL_MS);
      await advance(0);
      const current = failureControls(host);
      const currentRetry = captureClick(current.button);
      const pending = deferred<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      act(() => currentRetry(clickEvent(current.button)));

      expect(fetchMock).toHaveBeenCalledTimes(baseline + 2);
      expect(failureControls(host).button).toBeDisabled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    {
      name: "descendant mutation and restoration",
      alter: ({ button }: ReturnType<typeof failureControls>) => {
        button.setAttribute("data-transient", "true");
        button.removeAttribute("data-transient");
      },
    },
    {
      name: "pill detachment and restoration",
      alter: ({ pill }: ReturnType<typeof failureControls>) => {
        const parent = pill.parentNode;
        if (!parent) throw new Error("Failure pill has no parent");
        const nextSibling = pill.nextSibling;
        pill.remove();
        parent.insertBefore(pill, nextSibling);
      },
    },
    {
      name: "button replacement and restoration",
      alter: ({ pill, button }: ReturnType<typeof failureControls>) => {
        const notice = button.parentElement;
        if (!notice) throw new Error("Retry button has no notice");
        const replacement = button.cloneNode(true);
        notice.replaceChild(replacement, button);
        notice.replaceChild(button, replacement);
        expect(pill.contains(button)).toBe(true);
      },
    },
    {
      name: "control reordering and restoration",
      alter: ({ button }: ReturnType<typeof failureControls>) => {
        const notice = button.parentElement;
        const message = notice?.firstChild;
        if (!notice || !message) throw new Error("Failure notice is incomplete");
        notice.insertBefore(button, message);
        notice.append(button);
      },
    },
    {
      name: "callback-ref detachment and restoration",
      alter: ({ button }: ReturnType<typeof failureControls>) => {
        const retryRef = captureRef(button);
        retryRef(null);
        retryRef(button);
      },
    },
  ])("rejects a Retry settlement after $name and lets a clean successor recover", async ({ alter }) => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const staleRequest = deferred<Response>();
      fetchMock.mockReturnValueOnce(staleRequest.promise);
      const baseline = fetchMock.mock.calls.length;

      fireEvent.click(failureControls(host).button);
      const pendingControl = failureControls(host);
      expect(pendingControl.button).toBeDisabled();
      act(() => alter(pendingControl));

      staleRequest.resolve(response("stale-changed-hash"));
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 1);
      expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();

      const recovery = deferred<Response>();
      fetchMock.mockReturnValueOnce(recovery.promise);
      await advance(POLL_MS);
      recovery.reject(new TypeError("current failure"));
      await advance(0);

      const recovered = failureControls(host);
      expect(recovered.button).toBeEnabled();
      expect(host.querySelectorAll('[data-testid="reader-update-error"]')).toHaveLength(1);
      const nextRequest = deferred<Response>();
      fetchMock.mockReturnValueOnce(nextRequest.promise);
      fireEvent.click(recovered.button);
      expect(fetchMock).toHaveBeenCalledTimes(baseline + 3);
      expect(failureControls(host).button).toBeDisabled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects a hidden Retry and an aborted hidden settlement before fresh visible recovery", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    try {
      await advance(0);
      const stale = failureControls(host);
      const staleRetry = captureClick(stale.button);
      const beforeHide = fetchMock.mock.calls.length;

      setVisibility("hidden");
      staleRetry(clickEvent(stale.button));
      expect(fetchMock).toHaveBeenCalledTimes(beforeHide);
      expect(stale.button).toBeEnabled();

      const visibleRequest = deferred<Response>();
      fetchMock.mockReturnValueOnce(visibleRequest.promise);
      setVisibility("visible");
      expect(fetchMock).toHaveBeenCalledTimes(beforeHide + 1);
      expect(failureControls(host).button).toBeDisabled();
      const signal = requestSignal(beforeHide);

      setVisibility("hidden");
      expect(signal.aborted).toBe(true);
      visibleRequest.resolve(response("hidden-changed-hash"));
      await advance(0);
      expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();

      const recovery = deferred<Response>();
      fetchMock.mockReturnValueOnce(recovery.promise);
      setVisibility("visible");
      expect(fetchMock).toHaveBeenCalledTimes(beforeHide + 2);
      recovery.resolve(response(INITIAL_HASH));
      await advance(0);
      expect(host.querySelector('[data-testid="reader-update-error"]')).toBeNull();
      expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["document", "key"] as const)(
    "retires the previous failure, Retry, and settlement after a %s replacement",
    async (replacement) => {
      fetchMock.mockRejectedValue(new TypeError("offline"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const stale = failureControls(host);
        const staleRetry = captureClick(stale.button);
        const staleRequest = deferred<Response>();
        fetchMock.mockReturnValueOnce(staleRequest.promise);
        fireEvent.click(stale.button);
        const staleRequestIndex = fetchMock.mock.calls.length - 1;
        const staleSignal = requestSignal(staleRequestIndex);

        await act(async () => {
          root.render(
            <StrictMode>
              <UpdatePill
                key={replacement === "key" ? "replacement" : "initial"}
                docId={REPLACEMENT_DOC_ID}
                initialHash={REPLACEMENT_HASH}
                pollMs={POLL_MS}
              />
            </StrictMode>,
          );
        });
        await advance(0);
        expect(staleSignal.aborted).toBe(true);

        staleRequest.resolve(response("changed-after-replacement"));
        await advance(0);
        expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();
        const current = failureControls(host);
        const currentRetry = captureClick(current.button);
        const replacementFetches = fetchMock.mock.calls.length;

        act(() => {
          staleRetry(clickEvent(stale.button));
          staleRetry(clickEvent(current.button));
          currentRetry(clickEvent(stale.button));
        });
        expect(fetchMock).toHaveBeenCalledTimes(replacementFetches);

        const currentRequest = deferred<Response>();
        fetchMock.mockReturnValueOnce(currentRequest.promise);
        act(() => {
          currentRetry(clickEvent(current.button));
          currentRetry(clickEvent(current.button));
        });
        expect(fetchMock).toHaveBeenCalledTimes(replacementFetches + 1);
        expect(failureControls(host).button).toBeDisabled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("releases the failure authority, request, timer, and listener on cleanup", async () => {
    const activeListeners = trackVisibilityListeners();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const { host, root } = await mountDirectStrict();
    await advance(0);
    const stale = failureControls(host);
    const staleRetry = captureClick(stale.button);
    const before = fetchMock.mock.calls.length;

    await act(async () => root.unmount());
    expect(activeListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.innerHTML).toBe("");

    staleRetry(clickEvent(stale.button));
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(host.innerHTML).toBe("");
    host.remove();
  });

  it("shows the refresh action and stops polling after detecting a changed hash", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);

    expect(screen.getByRole("button", { name: /Updated.*Refresh/ })).toBeInTheDocument();
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dismisses one immutable hash in Strict Mode, suppresses it, and publishes one later hash", async () => {
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));

    await withNavigation(navigation, async () => {
      render(
        <StrictMode>
          <UpdatePill docId={DOC_ID} initialHash={INITIAL_HASH} pollMs={POLL_MS} />
        </StrictMode>,
      );
      await advance(0);
    });

    const first = controls();
    expect(first.dismissButton).toHaveAccessibleName("Dismiss update notice");
    const refresh = captureClick(first.button);
    const dismiss = captureClick(first.dismissButton);
    const publishedFetches = fetchMock.mock.calls.length;

    act(() => {
      dismiss(clickEvent(first.button));
      refresh(clickEvent(first.dismissButton));
    });
    expect(screen.getByTestId("reader-updated")).toBe(first.pill);
    expect(fetchMock).toHaveBeenCalledTimes(publishedFetches);
    expect(navigation.reload).not.toHaveBeenCalled();

    act(() => dismiss(clickEvent(first.dismissButton)));
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(navigation.reload).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();

    await advance(0);
    await advance(POLL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(publishedFetches);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    await advance(1);
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(publishedFetches + 1);
    const suppressedFetches = fetchMock.mock.calls.length;

    act(() => {
      dismiss(clickEvent(first.dismissButton));
      refresh(clickEvent(first.button));
    });
    expect(fetchMock).toHaveBeenCalledTimes(suppressedFetches);
    expect(navigation.reload).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(response("hash-later"));
    await advance(POLL_MS);
    await advance(0);

    const later = controls();
    expect(later.pill).not.toBe(first.pill);
    expect(screen.getAllByTestId("reader-updated")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(suppressedFetches + 1);
    expect(later.dismissButton).toHaveAccessibleName("Dismiss update notice");
  });

  it("clears a dismissed hash after observing the initial hash", async () => {
    fetchMock.mockResolvedValue(response("hash-after"));
    mount();
    await advance(0);

    fireEvent.click(controls().dismissButton);
    await advance(0);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(response(INITIAL_HASH));
    await advance(POLL_MS);
    await advance(0);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();

    fetchMock.mockResolvedValue(response("hash-after"));
    await advance(POLL_MS);
    await advance(0);
    expect(screen.getAllByTestId("reader-updated")).toHaveLength(1);
  });

  it("ignores malformed remote hashes until one valid immutable hash is observed", async () => {
    const values: unknown[] = [undefined, null, 17, {}, "", "hash-after"];
    fetchMock.mockImplementation(async () => {
      const contentHash = values.shift();
      return {
        ok: true,
        json: vi.fn().mockResolvedValue({ contentHash }),
      } as unknown as Response;
    });
    mount();

    for (let index = 0; index < 5; index++) {
      await advance(0);
      expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
      await advance(POLL_MS);
    }
    await advance(0);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.getAllByTestId("reader-updated")).toHaveLength(1);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a dismissed hash hidden when a hidden follow-up request settles by %s",
    async (settlement) => {
      const late = deferred<Response>();
      fetchMock
        .mockResolvedValueOnce(response("hash-after"))
        .mockReturnValueOnce(late.promise)
        .mockResolvedValue(response("hash-later"));
      mount();
      await advance(0);

      fireEvent.click(controls().dismissButton);
      await advance(POLL_MS);
      const lateSignal = requestSignal(1);
      setVisibility("hidden");
      expect(lateSignal.aborted).toBe(true);

      if (settlement === "resolve") {
        late.resolve(response("hash-after"));
      } else {
        late.reject(new TypeError("retired dismissed-hash request failed"));
      }
      await advance(0);
      expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
      expect(unhandledRejection).not.toHaveBeenCalled();

      setVisibility("visible");
      await advance(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.getAllByTestId("reader-updated")).toHaveLength(1);
    },
  );

  it("does not carry dismissal or stale controls into a replacement document", async () => {
    const late = deferred<Response>();
    const navigation = createNavigationSpies();
    fetchMock
      .mockResolvedValueOnce(response("hash-after"))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(response("hash-after"));
    const view = render(<ReaderBoundary />);
    await advance(0);
    const stale = controls();
    const staleDismiss = captureClick(stale.dismissButton);

    fireEvent.click(stale.dismissButton);
    await advance(POLL_MS);
    const staleSignal = requestSignal(1);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();

    await withNavigation(navigation, async () => {
      view.rerender(
        <ReaderBoundary
          docId={REPLACEMENT_DOC_ID}
          initialHash={REPLACEMENT_HASH}
        />,
      );
      expect(staleSignal.aborted).toBe(true);
      late.resolve(response("hash-after"));
      await advance(0);
    });

    const current = controls();
    const fetches = fetchMock.mock.calls.length;
    staleDismiss(clickEvent(current.dismissButton));
    expect(screen.getByTestId("reader-updated")).toBe(current.pill);
    expect(fetchMock).toHaveBeenCalledTimes(fetches);
    expect(navigation.reload).not.toHaveBeenCalled();

    fireEvent.click(current.dismissButton);
    expect(screen.queryByTestId("reader-updated")).not.toBeInTheDocument();
    expect(navigation.reload).not.toHaveBeenCalled();
  });

  it("aborts and retires polling when unmounted after dismissal", async () => {
    const late = deferred<Response>();
    const activeListeners = trackVisibilityListeners();
    fetchMock
      .mockResolvedValueOnce(response("hash-after"))
      .mockReturnValueOnce(late.promise);
    const view = mount();
    await advance(0);

    fireEvent.click(controls().dismissButton);
    await advance(POLL_MS);
    const signal = requestSignal(1);
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(activeListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    late.reject(new TypeError("request rejected after dismissed visit cleanup"));
    await advance(POLL_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(unhandledRejection).not.toHaveBeenCalled();
  });

  it("lets the exact current Refresh publication reload only once without other changes", async () => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    document.body.append(focusOwner);
    focusOwner.focus();
    fetchMock.mockResolvedValue(response("hash-after"));
    const frozenNavigation = createNavigationSpies();

    try {
      await withNavigation(frozenNavigation, async () => {
        mount();
        await advance(0);
      });
      const { pill, button } = controls();
      const refresh = captureClick(button);
      const event = clickEvent(button);
      const markup = pill.outerHTML;
      const timers = vi.getTimerCount();

      const replacementNavigation = createNavigationSpies();
      await withNavigation(replacementNavigation, () => {
        refresh(event);
        refresh(event);
      });

      expect(frozenNavigation.reload).toHaveBeenCalledOnce();
      expect(frozenNavigation.assign).not.toHaveBeenCalled();
      expect(frozenNavigation.replace).not.toHaveBeenCalled();
      expect(replacementNavigation.reload).not.toHaveBeenCalled();
      expect(replacementNavigation.assign).not.toHaveBeenCalled();
      expect(replacementNavigation.replace).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(0);
      expect(pill.outerHTML).toBe(markup);
      expect(focusOwner).toHaveFocus();
    } finally {
      focusOwner.remove();
    }
  });

  it("replaces replayed handlers, refs, and publications before accepting one reentrant Strict Mode click", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigation = createNavigationSpies();
    const NativeMutationObserver = window.MutationObserver;
    type ReplayCapture = {
      publication: MutationObserver;
      pill: HTMLDivElement;
      button: HTMLButtonElement;
      pillRef: RefCallback<HTMLDivElement>;
      buttonRef: RefCallback<HTMLButtonElement>;
      click: RefreshClick;
    };
    const captures: ReplayCapture[] = [];

    class CapturingMutationObserver implements MutationObserver {
      private readonly observer: MutationObserver;

      constructor(callback: MutationCallback) {
        this.observer = new NativeMutationObserver(callback);
        const { pill, button } = controls(host);
        captures.push({
          publication: this,
          pill,
          button,
          pillRef: captureRef(pill),
          buttonRef: captureRef(button),
          click: captureClick(button),
        });
      }

      disconnect() {
        this.observer.disconnect();
      }

      observe(target: Node, options?: MutationObserverInit) {
        this.observer.observe(target, options);
      }

      takeRecords() {
        return this.observer.takeRecords();
      }
    }

    vi.stubGlobal("MutationObserver", CapturingMutationObserver);
    fetchMock.mockResolvedValue(response("hash-after"));
    try {
      await withNavigation(navigation, async () => {
        await act(async () => {
          root.render(
            <StrictMode>
              <UpdatePill docId={DOC_ID} initialHash={INITIAL_HASH} pollMs={POLL_MS} />
            </StrictMode>,
          );
        });
        await advance(0);
      });

      expect(captures).toHaveLength(2);
      const [retired, current] = captures;
      if (!retired || !current) throw new Error("Strict Mode did not publish both control generations");
      expect(current.publication).not.toBe(retired.publication);
      expect(current.click).not.toBe(retired.click);
      expect(current.pillRef).not.toBe(retired.pillRef);
      expect(current.buttonRef).not.toBe(retired.buttonRef);
      expect(current.pill).toBe(retired.pill);
      expect(current.button).toBe(retired.button);

      act(() => {
        retired.pillRef(current.pill);
        retired.buttonRef(current.button);
        current.pillRef(retired.pill);
        current.buttonRef(retired.button);
        retired.buttonRef(null);
        retired.pillRef(null);
      });

      const activation = clickEvent(current.button);
      navigation.reload.mockImplementation(() => {
        current.click(activation);
        retired.click(activation);
      });
      act(() => {
        retired.click(activation);
        current.click(activation);
        current.click(activation);
      });

      expect(navigation.reload).toHaveBeenCalledOnce();
      expect(navigation.assign).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("requires a primary owner-document native click with matching exact descendant targets", async () => {
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));
    await withNavigation(navigation, async () => {
      mount();
      await advance(0);
    });
    const { button } = controls();
    const refresh = captureClick(button);
    const icon = button.querySelector("svg");
    if (!icon) throw new Error("The Refresh icon was not rendered");
    const detached = button.cloneNode(true) as HTMLButtonElement;
    const sibling = document.createElement("button");
    document.body.append(sibling);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignWindow = iframe.contentWindow;
    if (!foreignWindow) throw new Error("The foreign event window was not created");
    const foreignGlobal = foreignWindow as Window & typeof globalThis;
    const foreignEvent = new foreignGlobal.MouseEvent("click", {
      bubbles: true,
      button: 0,
    });
    Object.defineProperty(foreignEvent, "target", {
      configurable: true,
      value: button,
    });

    try {
      act(() => {
        refresh(clickEvent(button, { nativeEvent: new Event("click", { bubbles: true }) }));
        refresh(clickEvent(button, { type: "pointerdown" }));
        refresh(clickEvent(button, { button: 1 }));
        refresh(clickEvent(button, { nativeButton: 1 }));
        refresh(clickEvent(button, { target: icon, nativeTarget: button }));
        refresh(clickEvent(button, { nativeEvent: foreignEvent }));
        refresh(clickEvent(sibling));
        refresh(clickEvent(detached));
      });
      expect(navigation.reload).not.toHaveBeenCalled();

      fireEvent.click(icon);
      fireEvent.click(icon);
      expect(navigation.reload).toHaveBeenCalledOnce();
    } finally {
      iframe.remove();
      sibling.remove();
    }
  });

  it.each([
    {
      name: "transient descendant mutation",
      alter: ({ button }: ReturnType<typeof controls>) => {
        const updated = button.firstElementChild;
        if (!updated) throw new Error("Updated text is missing");
        updated.setAttribute("data-transient", "true");
        updated.removeAttribute("data-transient");
      },
    },
    {
      name: "pill detach and reinsert",
      alter: ({ pill }: ReturnType<typeof controls>) => {
        const parent = pill.parentNode;
        if (!parent) throw new Error("Refresh pill has no parent");
        const nextSibling = pill.nextSibling;
        pill.remove();
        parent.insertBefore(pill, nextSibling);
      },
    },
    {
      name: "button replace and restore",
      alter: ({ pill, button }: ReturnType<typeof controls>) => {
        const replacement = button.cloneNode(true);
        pill.replaceChildren(replacement);
        pill.replaceChildren(button);
      },
    },
    {
      name: "partial callback-ref replay",
      alter: ({ pill }: ReturnType<typeof controls>) => {
        const pillRef = captureRef(pill);
        pillRef(null);
        pillRef(pill);
      },
    },
    {
      name: "callback-ref replacement",
      alter: ({ button }: ReturnType<typeof controls>) => {
        const buttonRef = captureRef(button);
        const replacement = button.cloneNode(true) as HTMLButtonElement;
        document.body.append(replacement);
        buttonRef(replacement);
        buttonRef(button);
        replacement.remove();
      },
    },
  ])("permanently retires A after $name and leaves an equal-looking B usable", async ({ alter }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      await withNavigation(navigation, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const stale = controls(host);
      const staleClick = captureClick(stale.button);
      const stalePillRef = captureRef(stale.pill);
      const staleButtonRef = captureRef(stale.button);
      alter(stale);
      staleClick(clickEvent(stale.button));
      expect(navigation.reload).not.toHaveBeenCalled();

      await withNavigation(navigation, async () => {
        await act(async () =>
          root.render(<ReaderBoundary visit="replacement" />),
        );
        await advance(0);
      });
      const current = controls(host);
      const currentClick = captureClick(current.button);
      expect(current.pill).not.toBe(stale.pill);
      expect(current.button).not.toBe(stale.button);
      const activation = clickEvent(current.button);

      act(() => {
        stalePillRef(current.pill);
        staleButtonRef(current.button);
        staleButtonRef(null);
        stalePillRef(null);
        staleClick(activation);
        currentClick(activation);
        currentClick(activation);
      });
      expect(navigation.reload).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    {
      name: "transient Dismiss mutation and restoration",
      alter: ({ dismissButton }: ReturnType<typeof controls>) => {
        dismissButton.setAttribute("data-transient", "true");
        dismissButton.removeAttribute("data-transient");
      },
    },
    {
      name: "Dismiss replacement and restoration",
      alter: ({ pill, dismissButton }: ReturnType<typeof controls>) => {
        const replacement = dismissButton.cloneNode(true);
        pill.replaceChild(replacement, dismissButton);
        pill.replaceChild(dismissButton, replacement);
      },
    },
    {
      name: "control reordering and restoration",
      alter: ({ pill, button, dismissButton }: ReturnType<typeof controls>) => {
        pill.insertBefore(dismissButton, button);
        pill.append(dismissButton);
      },
    },
    {
      name: "partial Dismiss callback-ref replay",
      alter: ({ dismissButton }: ReturnType<typeof controls>) => {
        const dismissRef = captureRef(dismissButton);
        dismissRef(null);
        dismissRef(dismissButton);
      },
    },
  ])("rejects Dismiss after $name and leaves a fresh publication usable", async ({ alter }) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      await withNavigation(navigation, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const stale = controls(host);
      const staleDismiss = captureClick(stale.dismissButton);
      const fetches = fetchMock.mock.calls.length;
      const markup = host.innerHTML;

      act(() => alter(stale));
      expect(host.innerHTML).toBe(markup);
      act(() => staleDismiss(clickEvent(stale.dismissButton)));
      expect(host.querySelector('[data-testid="reader-updated"]')).toBe(stale.pill);
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(navigation.reload).not.toHaveBeenCalled();

      await withNavigation(navigation, async () => {
        await act(async () =>
          root.render(<ReaderBoundary visit="replacement" />),
        );
        await advance(0);
      });
      const current = controls(host);
      expect(current.pill).not.toBe(stale.pill);
      expect(current.dismissButton).not.toBe(stale.dismissButton);
      const currentDismiss = captureClick(current.dismissButton);

      staleDismiss(clickEvent(current.dismissButton));
      expect(host.querySelector('[data-testid="reader-updated"]')).toBe(current.pill);
      act(() => currentDismiss(clickEvent(current.dismissButton)));
      expect(host.querySelector('[data-testid="reader-updated"]')).toBeNull();
      expect(navigation.reload).not.toHaveBeenCalled();
      expect(navigation.assign).not.toHaveBeenCalled();
      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("fails closed after exact reload ownership drifts and does not let A clear a remounted B", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      await withNavigation(navigation, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const stale = controls(host);
      const staleClick = captureClick(stale.button);
      const reload = navigation.reload;
      const replacementReload = vi.fn();
      navigation.reload = replacementReload;
      staleClick(clickEvent(stale.button));
      navigation.reload = reload;
      staleClick(clickEvent(stale.button));
      expect(reload).not.toHaveBeenCalled();
      expect(replacementReload).not.toHaveBeenCalled();

      await withNavigation(navigation, async () => {
        await act(async () =>
          root.render(<ReaderBoundary visit="replacement" />),
        );
        await advance(0);
      });
      const current = controls(host);
      const currentClick = captureClick(current.button);
      staleClick(clickEvent(current.button));
      currentClick(clickEvent(current.button));
      expect(reload).toHaveBeenCalledOnce();
      expect(replacementReload).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(
    (
      [
        "sibling button",
        "foreign connected button",
        "detached exact button",
        "replacement button",
        "replacement pill",
        "disabled exact button",
        "fact-mutated exact button",
        "fact-mutated exact pill",
      ] as const
    ).flatMap((source) =>
      (["wrong-before-current", "current-before-wrong"] as const).map((order) => ({ source, order })),
    ),
  )("rejects a $source with zero work in $order order", async ({ source, order }) => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    focusOwner.focus();
    const root = createRoot(host);
    const navigation = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));
    let restore = () => {};

    try {
      await withNavigation(navigation, async () => {
        await act(async () => root.render(<UpdatePill docId={DOC_ID} initialHash={INITIAL_HASH} pollMs={POLL_MS} />));
        await advance(0);
      });
      const { pill, button } = controls(host);
      const refresh = captureClick(button);
      const prepareWrongSource = () => {
        if (source === "sibling button") {
          const sibling = document.createElement("button");
          pill.append(sibling);
          restore = () => sibling.remove();
          return sibling;
        }
        if (source === "foreign connected button") {
          const foreign = document.createElement("button");
          document.body.append(foreign);
          restore = () => foreign.remove();
          return foreign;
        }
        if (source === "detached exact button") {
          button.remove();
          restore = () => pill.append(button);
          return button;
        }
        if (source === "replacement button") {
          const replacement = button.cloneNode(true) as HTMLButtonElement;
          pill.replaceChildren(replacement);
          restore = () => pill.replaceChildren(button);
          return replacement;
        }
        if (source === "replacement pill") {
          const replacement = pill.cloneNode(true) as HTMLDivElement;
          const replacementButton = replacement.querySelector("button");
          if (!(replacementButton instanceof HTMLButtonElement)) throw new Error("Replacement pill has no button");
          host.replaceChild(replacement, pill);
          restore = () => host.replaceChild(pill, replacement);
          return replacementButton;
        }
        if (source === "disabled exact button") {
          button.disabled = true;
          restore = () => {
            button.disabled = false;
          };
          return button;
        }
        if (source === "fact-mutated exact button") {
          button.setAttribute("data-mutated", "true");
          restore = () => button.removeAttribute("data-mutated");
          return button;
        }
        pill.setAttribute("role", "alert");
        restore = () => pill.setAttribute("role", "status");
        return button;
      };
      const invokeWrong = () => {
        const wrongSource = prepareWrongSource();
        const before = host.innerHTML;
        const fetches = fetchMock.mock.calls.length;
        const timers = vi.getTimerCount();
        const listeners = activeListeners.size;
        const activeElement = document.activeElement;
        const event = clickEvent(wrongSource);

        refresh(event);

        expect(navigation.reload).toHaveBeenCalledTimes(order === "current-before-wrong" ? 1 : 0);
        expect(navigation.assign).not.toHaveBeenCalled();
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(fetches);
        expect(vi.getTimerCount()).toBe(timers);
        expect(activeListeners.size).toBe(listeners);
        expect(document.activeElement).toBe(activeElement);
        expect(host.innerHTML).toBe(before);
        restore();
        restore = () => {};
      };
      const invokeCurrent = () => refresh(clickEvent(button));

      if (order === "wrong-before-current") {
        invokeWrong();
        invokeCurrent();
      } else {
        invokeCurrent();
        invokeWrong();
      }

      const permanentlyAltered = source !== "foreign connected button";
      const accepted =
        order === "current-before-wrong" ||
        (order === "wrong-before-current" && !permanentlyAltered);
      expect(navigation.reload).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(activeListeners.size).toBe(0);
      expect(focusOwner).toHaveFocus();
    } finally {
      restore();
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it("retires a removed Refresh publication before the parent layout boundary", async () => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    focusOwner.focus();
    fetchMock.mockResolvedValue(response("hash-after"));
    const frozenNavigation = createNavigationSpies();

    try {
      await withNavigation(frozenNavigation, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const staleControl = controls(host);
      const staleRefresh = captureClick(staleControl.button);
      const fetches = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const listeners = activeListeners.size;
      let boundaryMarkup: string | null = null;
      let boundaryFetches = -1;
      let boundaryTimers = -1;
      let boundaryListeners = -1;
      let boundaryFocused = false;
      const boundaryNavigation = createNavigationSpies();

      await withNavigation(boundaryNavigation, () =>
        act(async () =>
          root.render(
            <ReaderBoundary
              show={false}
              onLayout={() => {
                boundaryMarkup = host.innerHTML;
                boundaryFetches = fetchMock.mock.calls.length;
                boundaryTimers = vi.getTimerCount();
                boundaryListeners = activeListeners.size;
                boundaryFocused = document.activeElement === focusOwner;
                staleRefresh(clickEvent(staleControl.button));
              }}
            />,
          ),
        ),
      );

      expect(boundaryMarkup).toBe("");
      expect(boundaryFetches).toBe(fetches);
      expect(boundaryTimers).toBe(timers);
      expect(boundaryListeners).toBe(listeners);
      expect(boundaryFocused).toBe(true);
      expect(boundaryNavigation.reload).not.toHaveBeenCalled();
      expect(boundaryNavigation.assign).not.toHaveBeenCalled();
      expect(boundaryNavigation.replace).not.toHaveBeenCalled();

      const afterBoundaryNavigation = createNavigationSpies();
      await withNavigation(afterBoundaryNavigation, () => staleRefresh(clickEvent(staleControl.button)));
      expect(frozenNavigation.reload).not.toHaveBeenCalled();
      expect(afterBoundaryNavigation.reload).not.toHaveBeenCalled();
      expect(afterBoundaryNavigation.assign).not.toHaveBeenCalled();
      expect(afterBoundaryNavigation.replace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(listeners);
      expect(host.innerHTML).toBe("");
      expect(focusOwner).toHaveFocus();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it.each(
    (["reload method replacement", "poll cadence replacement"] as const).flatMap((change) =>
      (["retired-before-current", "current-before-retired"] as const).map((order) => ({ change, order })),
    ),
  )("keeps reused DOM owned by B after $change in $order order", async ({ change, order }) => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    const navigationA = createNavigationSpies();
    const navigationB = createNavigationSpies();
    fetchMock.mockResolvedValue(response("hash-after"));

    try {
      await withNavigation(navigationA, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const a = controls(host);
      const staleRefresh = captureClick(a.button);
      const stalePillRef = reactHandler<RefCallback<HTMLDivElement>>(a.pill, "ref");
      const staleButtonRef = reactHandler<RefCallback<HTMLButtonElement>>(a.button, "ref");
      let boundaryRan = false;

      await withNavigation(navigationB, () =>
        act(async () =>
          root.render(
            <ReaderBoundary
              pollMs={change === "poll cadence replacement" ? POLL_MS + 17 : POLL_MS}
              onLayout={() => {
                boundaryRan = true;
                const current = controls(host);
                expect(current.pill).toBe(a.pill);
                expect(current.button).toBe(a.button);
                staleRefresh(clickEvent(current.button));
              }}
            />,
          ),
        ),
      );

      expect(boundaryRan).toBe(true);
      expect(navigationA.reload).not.toHaveBeenCalled();
      expect(navigationB.reload).not.toHaveBeenCalled();
      const b = controls(host);
      expect(b.pill).toBe(a.pill);
      expect(b.button).toBe(a.button);
      const currentRefresh = captureClick(b.button);
      focusOwner.focus();

      act(() => {
        stalePillRef(a.pill);
        staleButtonRef(a.button);
        staleButtonRef(null);
        stalePillRef(null);
      });
      const fetches = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const listeners = activeListeners.size;
      const markup = host.innerHTML;
      expect(host.innerHTML).toBe(markup);

      if (order === "retired-before-current") {
        staleRefresh(clickEvent(b.button));
        currentRefresh(clickEvent(b.button));
      } else {
        currentRefresh(clickEvent(b.button));
        staleRefresh(clickEvent(b.button));
      }

      expect(navigationA.reload).not.toHaveBeenCalled();
      expect(navigationB.reload).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(listeners);
      expect(host.innerHTML).toBe(markup);
      expect(focusOwner).toHaveFocus();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it.each([
    {
      name: "different document values with stale before current",
      docId: REPLACEMENT_DOC_ID,
      initialHash: INITIAL_HASH,
      visit: "initial" as const,
      staleFirst: true,
    },
    {
      name: "a replacement hash on the same document",
      docId: DOC_ID,
      initialHash: REPLACEMENT_HASH,
      visit: "initial" as const,
      staleFirst: true,
    },
    {
      name: "an equal-value distinct visit with current before stale",
      docId: DOC_ID,
      initialHash: INITIAL_HASH,
      visit: "replacement" as const,
      staleFirst: false,
    },
  ])("keeps B usable after replacing A with $name", async ({ docId, initialHash, visit, staleFirst }) => {
    const activeListeners = trackVisibilityListeners();
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    const host = document.createElement("div");
    document.body.append(focusOwner, host);
    const root = createRoot(host);
    focusOwner.focus();
    fetchMock.mockResolvedValueOnce(response("changed-a")).mockResolvedValueOnce(response("changed-b"));
    const navigationA = createNavigationSpies();
    const navigationB = createNavigationSpies();

    try {
      await withNavigation(navigationA, async () => {
        await act(async () => root.render(<ReaderBoundary />));
        await advance(0);
      });
      const staleControl = controls(host);
      const staleRefresh = captureClick(staleControl.button);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(activeListeners.size).toBe(0);

      let boundaryMarkup: string | null = null;
      let boundaryFetches = -1;
      let boundaryTimers = -1;
      let boundaryListeners = -1;
      let boundaryFocused = false;
      let layoutCalls = 0;

      await withNavigation(navigationB, async () => {
        await act(async () =>
          root.render(
            <ReaderBoundary
              docId={docId}
              initialHash={initialHash}
              visit={visit}
              onLayout={() => {
                layoutCalls++;
                boundaryMarkup = host.innerHTML;
                boundaryFetches = fetchMock.mock.calls.length;
                boundaryTimers = vi.getTimerCount();
                boundaryListeners = activeListeners.size;
                boundaryFocused = document.activeElement === focusOwner;
                staleRefresh(clickEvent(staleControl.button));
              }}
            />,
          ),
        );
        await advance(0);
      });

      expect(boundaryMarkup).toBe("");
      expect(boundaryFetches).toBe(1);
      expect(boundaryTimers).toBe(0);
      expect(boundaryListeners).toBe(0);
      expect(boundaryFocused).toBe(true);
      expect(navigationA.reload).not.toHaveBeenCalled();
      expect(navigationB.reload).not.toHaveBeenCalled();
      expect(layoutCalls).toBe(1);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `/api/documents/${DOC_ID}/content`,
        `/api/documents/${docId}/content`,
      ]);
      expect(requestSignal(1)).not.toBe(requestSignal(0));
      expect(requestSignal(1).aborted).toBe(false);
      const currentControl = controls(host);
      const currentRefresh = captureClick(currentControl.button);
      if (visit === "replacement" || docId !== DOC_ID || initialHash !== INITIAL_HASH) {
        expect(currentControl.pill).not.toBe(staleControl.pill);
        expect(currentControl.button).not.toBe(staleControl.button);
      }
      staleRefresh(clickEvent(currentControl.button));
      currentRefresh(clickEvent(staleControl.button));
      expect(navigationA.reload).not.toHaveBeenCalled();
      expect(navigationB.reload).not.toHaveBeenCalled();
      const currentMarkup = currentControl.pill.outerHTML;
      const fetches = fetchMock.mock.calls.length;
      const timers = vi.getTimerCount();
      const listeners = activeListeners.size;

      if (staleFirst) {
        staleRefresh(clickEvent(staleControl.button));
        currentRefresh(clickEvent(currentControl.button));
      } else {
        currentRefresh(clickEvent(currentControl.button));
        staleRefresh(clickEvent(staleControl.button));
      }
      expect(navigationA.reload).not.toHaveBeenCalled();
      expect(navigationB.reload).toHaveBeenCalledOnce();
      expect(navigationB.assign).not.toHaveBeenCalled();
      expect(navigationB.replace).not.toHaveBeenCalled();

      const repeatedNavigation = createNavigationSpies();
      await withNavigation(repeatedNavigation, () => {
        staleRefresh(clickEvent(staleControl.button));
        currentRefresh(clickEvent(currentControl.button));
      });
      expect(repeatedNavigation.reload).not.toHaveBeenCalled();
      expect(repeatedNavigation.assign).not.toHaveBeenCalled();
      expect(repeatedNavigation.replace).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetches);
      expect(vi.getTimerCount()).toBe(timers);
      expect(activeListeners.size).toBe(listeners);
      expect(currentControl.pill.outerHTML).toBe(currentMarkup);
      expect(focusOwner).toHaveFocus();
      expect(layoutCalls).toBe(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  describe("keyboard navigation", () => {
    it("authenticates distinct React capture and bubble wrappers for one native delivery", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        const handlers = updateKeyHandlers(current.button);
        const wrappers: ReactKeyboardEvent<HTMLButtonElement>[] =
          [];
        current.button.focus();
        focus.mockClear();
        const event = updateKeyEvent(
          current.button,
          "ArrowRight",
        );

        dispatchUpdateKeyWithHandlers(current.button, event, {
          capture: (wrapper) => {
            wrappers.push(wrapper);
            handlers.capture(wrapper);
          },
          bubble: (wrapper) => {
            wrappers.push(wrapper);
            handlers.bubble(wrapper);
          },
        });

        expect(wrappers).toHaveLength(2);
        expect(wrappers[0]).not.toBe(wrappers[1]);
        expect(wrappers[0]?.nativeEvent).toBe(event);
        expect(wrappers[1]?.nativeEvent).toBe(event);
        expect(wrappers[0]?.isDefaultPrevented).toBe(
          wrappers[1]?.isDefaultPrevented,
        );
        expect(wrappers[0]?.isPropagationStopped).toBe(
          wrappers[1]?.isPropagationStopped,
        );
        expect(event.defaultPrevented).toBe(true);
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["present", "absent", "mutated"] as const)(
      "does not use %s private _reactName metadata as key authority",
      async (state) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        fetchMock.mockResolvedValue(response("hash-after"));
        const { host, root } = await mountDirectStrict();
        let captured:
          | ReactKeyboardEvent<HTMLButtonElement>
          | null = null;
        const setPrivateName = (
          wrapper: ReactKeyboardEvent<HTMLButtonElement>,
          value: unknown,
        ) => {
          if (state === "absent") {
            if (!Reflect.deleteProperty(wrapper, "_reactName")) {
              throw new Error(
                "Unable to remove private React metadata",
              );
            }
            expect("_reactName" in wrapper).toBe(false);
            return;
          }
          if (
            !Reflect.defineProperty(wrapper, "_reactName", {
              configurable: true,
              enumerable: true,
              writable: true,
              value:
                state === "present" ? "onKeyDown" : value,
            })
          ) {
            throw new Error(
              "Unable to stage private React metadata",
            );
          }
        };
        try {
          await advance(0);
          const current = controls(host);
          const handlers = updateKeyHandlers(current.button);
          current.button.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const event = updateKeyEvent(
            current.button,
            "ArrowRight",
          );

          dispatchUpdateKeyWithHandlers(current.button, event, {
            capture: (wrapper) => {
              captured = wrapper;
              setPrivateName(wrapper, "capture-before");
              handlers.capture(wrapper);
            },
            bubble: (wrapper) => {
              if (!captured) {
                throw new Error(
                  "The React capture wrapper was not observed",
                );
              }
              setPrivateName(captured, "capture-after");
              setPrivateName(wrapper, "bubble");
              handlers.bubble(wrapper);
            },
          });

          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(current.dismissButton).toHaveFocus();
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it("uses the genuine Window callback receiver as current target and path terminal", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        const ownerWindow = current.button.ownerDocument.defaultView;
        if (!ownerWindow) {
          throw new Error("The update control has no owner window");
        }
        let currentTarget: EventTarget | null | undefined;
        let pathTerminal: EventTarget | undefined;
        const observer = vi.fn(function (
          this: EventTarget,
          event: Event,
        ) {
          currentTarget = event.currentTarget;
          pathTerminal = event.composedPath().at(-1);
        });
        ownerWindow.addEventListener("keydown", observer, {
          capture: true,
          once: true,
        });
        current.button.focus();
        focus.mockClear();

        const event = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );

        if (!pathTerminal) {
          throw new Error("The keyboard path had no Window terminal");
        }
        expect(observer.mock.contexts).toEqual([pathTerminal]);
        expect(currentTarget).toBe(pathTerminal);
        expect(event.defaultPrevented).toBe(true);
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it("rejects a structural Window terminal before clean recovery", async () => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const ownerWindow = window;
      const structural = Object.create(
        ownerWindow.Window.prototype,
      ) as EventTarget;
      Object.defineProperties(structural, {
        document: { value: document },
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
        originalTerminal?: EventTarget;
      } = {};
      const stageTerminal = vi.fn(function (
        this: EventTarget,
        event: Event,
      ) {
        observation.receiver = this;
        observation.currentTarget = event.currentTarget;
        observation.originalTerminal =
          event.composedPath().at(-1);
        replaceJsdomPathTerminal(event, structural);
      });
      ownerWindow.addEventListener("keydown", stageTerminal, {
        capture: true,
        once: true,
      });
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        current.button.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );

        expect(stageTerminal).toHaveBeenCalledOnce();
        expect(observation.receiver).toBe(
          observation.currentTarget,
        );
        expect(observation.receiver).toBe(
          observation.originalTerminal,
        );
        expect(observation.receiver).not.toBe(structural);
        expect(rejected.composedPath()).toEqual([]);
        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(current.button).toHaveFocus();

        preventDefault.mockClear();
        const recovered = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        ownerWindow.removeEventListener(
          "keydown",
          stageTerminal,
          true,
        );
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it("rejects React cancellation method identity drift between phases", async () => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        const handlers = updateKeyHandlers(current.button);
        for (const property of [
          "isDefaultPrevented",
          "isPropagationStopped",
        ] as const) {
          current.button.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const event = updateKeyEvent(
            current.button,
            "ArrowRight",
          );
          dispatchUpdateKeyWithHandlers(current.button, event, {
            capture: handlers.capture,
            bubble: (wrapper) => {
              Object.defineProperty(wrapper, property, {
                configurable: true,
                value: () => false,
              });
              handlers.bubble(wrapper);
            },
          });
          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(current.button).toHaveFocus();
        }

        const recovered = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );
        expect(recovered.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it("requires both React phases and rejects one wrapper reused across them", async () => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        const handlers = updateKeyHandlers(current.button);
        let captureWrapper:
          | ReactKeyboardEvent<HTMLButtonElement>
          | null = null;
        const attempts: Array<{
          capture: UpdateKeyDown;
          bubble: UpdateKeyDown;
        }> = [
          { capture: handlers.capture, bubble: () => undefined },
          { capture: () => undefined, bubble: handlers.bubble },
          {
            capture: (wrapper) => {
              captureWrapper = wrapper;
              handlers.capture(wrapper);
            },
            bubble: () => {
              if (captureWrapper) {
                handlers.bubble(captureWrapper);
              }
            },
          },
        ];
        for (const attempt of attempts) {
          current.button.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const event = updateKeyEvent(
            current.button,
            "ArrowRight",
          );
          dispatchUpdateKeyWithHandlers(
            current.button,
            event,
            attempt,
          );
          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(current.button).toHaveFocus();
        }
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it("removes the exact owned Window key listener on cleanup", async () => {
      const active = new Set<
        EventListenerOrEventListenerObject
      >();
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      vi.spyOn(window, "addEventListener").mockImplementation(
        (type, listener, options) => {
          if (type === "keydown" && listener) active.add(listener);
          add(type, listener, options);
        },
      );
      vi.spyOn(window, "removeEventListener").mockImplementation(
        (type, listener, options) => {
          if (type === "keydown" && listener) {
            active.delete(listener);
          }
          remove(type, listener, options);
        },
      );
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        expect(active.size).toBe(1);

        await act(async () => root.unmount());

        expect(active.size).toBe(0);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each([
      ["Refresh", "ArrowRight", "Dismiss"] as const,
      ["Refresh", "ArrowDown", "Dismiss"] as const,
      ["Refresh", "End", "Dismiss"] as const,
      ["Dismiss", "ArrowLeft", "Refresh"] as const,
      ["Dismiss", "ArrowUp", "Refresh"] as const,
      ["Dismiss", "Home", "Refresh"] as const,
    ])(
      "moves from %s with %s to %s exactly once without other work",
      async (from, key, to) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const navigation = createNavigationSpies();
        fetchMock.mockResolvedValue(response("hash-after"));
        let mounted:
          | Awaited<ReturnType<typeof mountDirectStrict>>
          | undefined;

        try {
          await withNavigation(navigation, async () => {
            mounted = await mountDirectStrict();
            await advance(0);
          });
          if (!mounted) throw new Error("The update control did not mount");
          const current = controls(mounted.host);
          const source =
            from === "Refresh" ? current.button : current.dismissButton;
          const destination =
            to === "Refresh" ? current.button : current.dismissButton;
          const fetches = fetchMock.mock.calls.length;
          const markup = current.pill.outerHTML;
          const scroll = { x: window.scrollX, y: window.scrollY };
          source.focus();
          focus.mockClear();
          preventDefault.mockClear();

          const event = dispatchUpdateKey(source, key);

          expect(event.isTrusted).toBe(true);
          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(focus.mock.contexts[0]).toBe(destination);
          expect(destination).toHaveFocus();
          expect(current.pill.outerHTML).toBe(markup);
          expect(
            [...current.pill.querySelectorAll("button")],
          ).toEqual([current.button, current.dismissButton]);
          expect(current.button.tabIndex).toBe(0);
          expect(current.dismissButton.tabIndex).toBe(0);
          expect(fetchMock).toHaveBeenCalledTimes(fetches);
          expect(navigation.reload).not.toHaveBeenCalled();
          expect(navigation.assign).not.toHaveBeenCalled();
          expect(navigation.replace).not.toHaveBeenCalled();
          expect({ x: window.scrollX, y: window.scrollY }).toEqual(
            scroll,
          );
        } finally {
          if (mounted) {
            await act(async () => mounted?.root.unmount());
            mounted.host.remove();
          }
        }
      },
    );

    it.each([
      ["Refresh", "ArrowLeft"] as const,
      ["Refresh", "ArrowUp"] as const,
      ["Refresh", "Home"] as const,
      ["Dismiss", "ArrowRight"] as const,
      ["Dismiss", "ArrowDown"] as const,
      ["Dismiss", "End"] as const,
    ])(
      "leaves the %s boundary for %s unprevented and inert",
      async (from, key) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        fetchMock.mockResolvedValue(response("hash-after"));
        const { host, root } = await mountDirectStrict();
        try {
          await advance(0);
          const current = controls(host);
          const source =
            from === "Refresh" ? current.button : current.dismissButton;
          const fetches = fetchMock.mock.calls.length;
          const markup = current.pill.outerHTML;
          source.focus();
          focus.mockClear();
          preventDefault.mockClear();

          const event = dispatchUpdateKey(source, key);

          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(source).toHaveFocus();
          expect(current.pill.outerHTML).toBe(markup);
          expect(fetchMock).toHaveBeenCalledTimes(fetches);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it("rejects modified, repeated, composing, canceled, stopped, unsupported, and wrong-focus input before clean recovery", async () => {
      const nativePreventDefault = Event.prototype.preventDefault;
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      const outside = document.createElement("button");
      document.body.append(outside);
      try {
        await advance(0);
        const current = controls(host);
        const source = current.button;
        const rejected = [
          updateKeyEvent(source, "PageDown"),
          updateKeyEvent(source, "ArrowRight", { altKey: true }),
          updateKeyEvent(source, "ArrowRight", { ctrlKey: true }),
          updateKeyEvent(source, "ArrowRight", { metaKey: true }),
          updateKeyEvent(source, "ArrowRight", { shiftKey: true }),
          updateKeyEvent(source, "ArrowRight", { repeat: true }),
          updateKeyEvent(source, "ArrowRight", {
            isComposing: true,
          }),
          updateKeyEvent(source, "ArrowRight", { bubbles: false }),
          updateKeyEvent(source, "ArrowRight", {
            cancelable: false,
          }),
          updateKeyEvent(source, "ArrowRight", {}, false),
        ];

        for (const event of rejected) {
          source.focus();
          focus.mockClear();
          preventDefault.mockClear();
          dispatchUpdateKey(source, event);
          expect(event.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(source).toHaveFocus();
        }

        const prevented = updateKeyEvent(source, "ArrowRight");
        Reflect.apply(nativePreventDefault, prevented, []);
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        dispatchUpdateKey(source, prevented);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        const stopped = updateKeyEvent(source, "ArrowRight");
        stopped.stopPropagation();
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        dispatchUpdateKey(source, stopped);
        expect(stopped.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        outside.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const unfocused = dispatchUpdateKey(source, "ArrowRight");
        expect(unfocused.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(outside).toHaveFocus();

        source.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const accepted = dispatchUpdateKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        outside.remove();
        host.remove();
      }
    });

    it("requires one genuine owner-realm React and native delivery before clean recovery", async () => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      try {
        await advance(0);
        const current = controls(host);
        const source = current.button;
        const handler = captureKeyDown(source);
        const fabricatedPreventDefault = vi.fn();
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        handler({
          type: "keydown",
          key: "ArrowRight",
          currentTarget: source,
          target: source,
          preventDefault: fabricatedPreventDefault,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>);
        expect(fabricatedPreventDefault).not.toHaveBeenCalled();

        const proxied = updateKeyEvent(source, "ArrowRight");
        dispatchUpdateKeyWithHandler(source, proxied, (event) => {
          handler(
            new Proxy(event, {
              get(target, property, receiver) {
                if (property === "isTrusted") return false;
                return Reflect.get(target, property, receiver);
              },
            }),
          );
        });
        expect(proxied.defaultPrevented).toBe(false);

        const crossedNative = updateKeyEvent(
          source,
          "ArrowRight",
        );
        const crossedDelivery = updateKeyEvent(
          source,
          "ArrowRight",
        );
        dispatchUpdateKeyWithHandler(
          source,
          crossedDelivery,
          (event) => {
            handler(
              new Proxy(event, {
                get(target, property, receiver) {
                  if (property === "nativeEvent") {
                    return crossedNative;
                  }
                  return Reflect.get(target, property, receiver);
                },
              }),
            );
          },
        );
        expect(crossedDelivery.defaultPrevented).toBe(false);

        const foreignWindow = iframe.contentWindow;
        if (!foreignWindow) {
          throw new Error("The foreign owner window was not created");
        }
        const foreignGlobal =
          foreignWindow as Window & typeof globalThis;
        const foreignEvent = new foreignGlobal.KeyboardEvent(
          "keydown",
          {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          },
        );
        markJsdomEventTrusted(foreignEvent);
        const foreignDelivery = updateKeyEvent(
          source,
          "ArrowRight",
        );
        dispatchUpdateKeyWithHandler(
          source,
          foreignDelivery,
          (event) => {
            handler(
              new Proxy(event, {
                get(target, property, receiver) {
                  if (property === "nativeEvent") {
                    return foreignEvent;
                  }
                  return Reflect.get(target, property, receiver);
                },
              }),
            );
          },
        );
        expect(foreignDelivery.defaultPrevented).toBe(false);

        const crossedSource = updateKeyEvent(
          current.dismissButton,
          "ArrowLeft",
        );
        dispatchUpdateKeyWithHandler(
          current.dismissButton,
          crossedSource,
          handler,
        );
        expect(crossedSource.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();

        const accepted = dispatchUpdateKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();
      } finally {
        await act(async () => root.unmount());
        iframe.remove();
        host.remove();
      }
    });

    it.each([
      {
        name: "document authority",
        props: {
          docId: REPLACEMENT_DOC_ID,
          initialHash: REPLACEMENT_HASH,
          pollMs: POLL_MS,
          visit: "initial" as const,
        },
      },
      {
        name: "initial hash",
        props: {
          docId: DOC_ID,
          initialHash: REPLACEMENT_HASH,
          pollMs: POLL_MS,
          visit: "initial" as const,
        },
      },
      {
        name: "poll cadence",
        props: {
          docId: DOC_ID,
          initialHash: INITIAL_HASH,
          pollMs: POLL_MS + 17,
          visit: "initial" as const,
        },
      },
      {
        name: "visit and callback",
        props: {
          docId: DOC_ID,
          initialHash: INITIAL_HASH,
          pollMs: POLL_MS,
          visit: "replacement" as const,
        },
      },
    ])(
      "rejects stale $name facts while the exact successor remains usable",
      async ({ props }) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        fetchMock.mockResolvedValue(response("hash-after"));
        try {
          await act(async () => {
            root.render(
              <StrictMode>
                <ReaderBoundary />
              </StrictMode>,
            );
          });
          await advance(0);
          const stale = controls(host);
          const staleHandler = captureKeyDown(stale.button);

          await act(async () => {
            root.render(
              <StrictMode>
                <ReaderBoundary {...props} />
              </StrictMode>,
            );
          });
          await advance(0);
          const current = controls(host);
          current.button.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const staleEvent = updateKeyEvent(
            current.button,
            "ArrowRight",
          );
          dispatchUpdateKeyWithHandler(
            current.button,
            staleEvent,
            staleHandler,
          );

          expect(staleEvent.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(current.button).toHaveFocus();

          const accepted = dispatchUpdateKey(
            current.button,
            "ArrowRight",
          );
          expect(accepted.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(current.dismissButton).toHaveFocus();
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each([
      {
        name: "attribute mutation and restoration",
        alter: ({ button }: ReturnType<typeof controls>) => {
          button.setAttribute("data-transient", "true");
          button.removeAttribute("data-transient");
        },
      },
      {
        name: "detachment and reinsertion",
        alter: ({ pill }: ReturnType<typeof controls>) => {
          const parent = pill.parentNode;
          if (!parent) throw new Error("The update pill has no parent");
          const next = pill.nextSibling;
          pill.remove();
          parent.insertBefore(pill, next);
        },
      },
      {
        name: "control reordering and restoration",
        alter: ({
          pill,
          button,
          dismissButton,
        }: ReturnType<typeof controls>) => {
          pill.insertBefore(dismissButton, button);
          pill.append(dismissButton);
        },
      },
      {
        name: "partial Strict callback-ref replay",
        alter: ({ button }: ReturnType<typeof controls>) => {
          const ref = captureRef(button);
          ref(null);
          ref(button);
        },
      },
    ])(
      "rejects navigation after $name and admits a distinct clean successor",
      async ({ alter }) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        fetchMock.mockResolvedValue(response("hash-after"));
        try {
          await act(async () => {
            root.render(
              <StrictMode>
                <ReaderBoundary />
              </StrictMode>,
            );
          });
          await advance(0);
          const stale = controls(host);
          const staleHandler = captureKeyDown(stale.button);
          const markup = stale.pill.outerHTML;
          act(() => alter(stale));
          expect(stale.pill.outerHTML).toBe(markup);
          stale.button.focus();
          focus.mockClear();
          preventDefault.mockClear();

          const rejected = dispatchUpdateKey(
            stale.button,
            "ArrowRight",
          );
          expect(rejected.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();

          await act(async () => {
            root.render(
              <StrictMode>
                <ReaderBoundary visit="replacement" />
              </StrictMode>,
            );
          });
          await advance(0);
          const current = controls(host);
          current.button.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const crossed = updateKeyEvent(
            current.button,
            "ArrowRight",
          );
          dispatchUpdateKeyWithHandler(
            current.button,
            crossed,
            staleHandler,
          );
          expect(crossed.defaultPrevented).toBe(false);

          const accepted = dispatchUpdateKey(
            current.button,
            "ArrowRight",
          );
          expect(accepted.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(current.dismissButton).toHaveFocus();
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it("rejects hidden input, exposes no failure navigation, and recovers when the notice is visible", async () => {
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        current.button.focus();
        focus.mockClear();
        preventDefault.mockClear();
        setVisibility("hidden");
        const hidden = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );
        expect(hidden.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        setVisibility("visible");
        const accepted = dispatchUpdateKey(
          current.button,
          "ArrowRight",
        );
        expect(accepted.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }

      cleanup();
      preventDefault.mockClear();
      focus.mockClear();
      fetchMock.mockRejectedValue(new TypeError("offline"));
      const failure = await mountDirectStrict();
      try {
        await advance(0);
        const retry = failureControls(failure.host).button;
        expect(() => captureKeyDown(retry)).toThrow(
          "onKeyDown was not attached",
        );
        retry.focus();
        focus.mockClear();
        const fetches = fetchMock.mock.calls.length;
        const event = dispatchUpdateKey(retry, "ArrowRight");
        expect(event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(fetches);
      } finally {
        await act(async () => failure.root.unmount());
        failure.host.remove();
      }
    });

    it("claims movement and delivery before replay or focus reentrancy and rejects cleanup input", async () => {
      const nativeFocus = HTMLElement.prototype.focus;
      const preventDefault = vi.spyOn(
        Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      let capturedWrapper:
        | ReactKeyboardEvent<HTMLButtonElement>
        | null = null;
      try {
        await advance(0);
        const current = controls(host);
        const handler = captureKeyDown(current.button);
        current.button.focus();
        focus.mockClear();
        preventDefault.mockClear();
        focus.mockImplementation(function (
          this: HTMLElement,
          options?: FocusOptions,
        ) {
          if (this === current.dismissButton && capturedWrapper) {
            handler(capturedWrapper);
          }
          Reflect.apply(nativeFocus, this, [options]);
        });
        const event = updateKeyEvent(
          current.button,
          "ArrowRight",
        );
        dispatchUpdateKeyWithHandler(
          current.button,
          event,
          (wrapper) => {
            capturedWrapper = wrapper;
            handler(wrapper);
            handler(wrapper);
          },
        );

        expect(event.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(current.dismissButton).toHaveFocus();

        current.button.focus();
        focus.mockClear();
        preventDefault.mockClear();
        dispatchUpdateKey(current.button, event);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(current.button).toHaveFocus();

        const staleHandler = handler;
        const staleWrapper = capturedWrapper;
        await act(async () => root.unmount());
        focus.mockClear();
        preventDefault.mockClear();
        if (!staleWrapper) {
          throw new Error("The React wrapper was not captured");
        }
        staleHandler(staleWrapper);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(host.innerHTML).toBe("");
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["Enter", " "] as const)(
      "leaves %s activation available after an unhandled keydown",
      async (key) => {
        const preventDefault = vi.spyOn(
          Event.prototype,
          "preventDefault",
        );
        const navigation = createNavigationSpies();
        fetchMock.mockResolvedValue(response("hash-after"));
        let mounted:
          | Awaited<ReturnType<typeof mountDirectStrict>>
          | undefined;
        try {
          await withNavigation(navigation, async () => {
            mounted = await mountDirectStrict();
            await advance(0);
            if (!mounted) {
              throw new Error("The update control did not mount");
            }
            const current = controls(mounted.host);
            current.button.focus();
            preventDefault.mockClear();
            const event = dispatchUpdateKey(current.button, key);
            expect(event.defaultPrevented).toBe(false);
            expect(preventDefault).not.toHaveBeenCalled();
            fireEvent.click(current.button);
          });
          expect(navigation.reload).toHaveBeenCalledOnce();
          expect(navigation.assign).not.toHaveBeenCalled();
          expect(navigation.replace).not.toHaveBeenCalled();
        } finally {
          if (mounted) {
            await act(async () => mounted?.root.unmount());
            mounted.host.remove();
          }
        }
      },
    );

    it("keeps pointer dismissal available after focus navigation", async () => {
      fetchMock.mockResolvedValue(response("hash-after"));
      const { host, root } = await mountDirectStrict();
      try {
        await advance(0);
        const current = controls(host);
        current.button.focus();
        dispatchUpdateKey(current.button, "ArrowRight");
        expect(current.dismissButton).toHaveFocus();

        fireEvent.click(current.dismissButton);

        expect(
          host.querySelector('[data-testid="reader-updated"]'),
        ).toBeNull();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });
  });
});
