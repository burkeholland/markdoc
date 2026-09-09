// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Component,
  StrictMode,
  useLayoutEffect,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";

import { WebhooksPanel } from "./webhooks-panel";

const fetchMock = vi.fn<typeof fetch>();
let foreignRoot: HTMLDivElement;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function BoundaryHarness({
  cardKey = 0,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  cardKey?: number;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <WebhooksPanel key={cardKey} /> : null;
}

function LayoutProbe({ children, onLayout }: { children: ReactNode; onLayout: () => void }) {
  useLayoutEffect(onLayout, [onLayout]);
  return children;
}

class TestErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <div data-testid="strict-replay-error" />
      : this.props.children;
  }
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

function optionalReactProp<T>(element: HTMLElement, name: string): T | null {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey]
    : undefined;
  const value = props?.[name];
  return typeof value === "function" ? value as T : null;
}

type ClickHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;
type InputChangeHandler = (event: ChangeEvent<HTMLInputElement>) => void;
type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;
type KeyDownHandler = (event: ReactKeyboardEvent<HTMLFormElement>) => void;

function setNativeProvenance(event: Event, target: EventTarget) {
  const path: EventTarget[] = [];
  if (target instanceof Node) {
    for (let current: Node | null = target; current; current = current.parentNode) {
      path.push(current);
    }
    const ownerDocument = target instanceof Document ? target : target.ownerDocument;
    if (ownerDocument) {
      path.push(ownerDocument);
      if (ownerDocument.defaultView) path.push(ownerDocument.defaultView);
    }
  } else {
    path.push(target);
  }
  Object.defineProperties(event, {
    target: { configurable: true, value: target },
    currentTarget: { configurable: true, value: target },
    eventPhase: { configurable: true, value: Event.AT_TARGET },
    composedPath: { configurable: true, value: () => path },
  });
}

function mouseEvent(
  currentTarget: HTMLButtonElement,
  options: {
    target?: EventTarget;
    nativeTarget?: EventTarget;
    MouseEventType?: typeof window.MouseEvent;
  } = {},
) {
  const target = options.target ?? currentTarget;
  const nativeTarget = options.nativeTarget ?? target;
  const MouseEventType = options.MouseEventType ?? window.MouseEvent;
  const nativeEvent = new MouseEventType("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  });
  setNativeProvenance(nativeEvent, nativeTarget);
  return {
    type: "click",
    button: 0,
    bubbles: true,
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
}

function invokeRejectedMouseProvenance(
  handler: ClickHandler,
  currentTarget: HTMLButtonElement,
) {
  const foreign = document.createElement("button");
  const unpublished = document.createElement("span");
  const iframe = document.createElement("iframe");
  foreignRoot.append(foreign, iframe);
  const foreignWindow = iframe.contentWindow as (Window & typeof globalThis) | null;
  const foreignMouseEvent = foreignWindow?.MouseEvent;
  if (!foreignMouseEvent) throw new Error("The foreign document has no MouseEvent constructor");

  act(() => {
    handler(mouseEvent(currentTarget, { target: foreign }));
    handler(mouseEvent(currentTarget, { nativeTarget: foreign }));
    handler(mouseEvent(currentTarget, { target: unpublished }));
    handler(mouseEvent(currentTarget, { MouseEventType: foreignMouseEvent }));
  });

  foreign.remove();
  iframe.remove();
}

function submitEvent(
  currentTarget: HTMLFormElement,
  target: EventTarget,
  nativeTarget: EventTarget,
  submitter: HTMLElement | null,
) {
  const ownerWindow = currentTarget.ownerDocument.defaultView!;
  const nativeEvent = new ownerWindow.SubmitEvent("submit", {
    bubbles: true,
    cancelable: true,
    submitter,
  });
  setNativeProvenance(nativeEvent, nativeTarget);
  const preventDefault = vi.fn(() => nativeEvent.preventDefault());
  return {
    event: {
      type: "submit",
      currentTarget,
      target,
      nativeEvent,
      defaultPrevented: false,
      preventDefault,
    } as unknown as FormEvent<HTMLFormElement>,
    preventDefault,
  };
}

function inputEvent(
  currentTarget: HTMLInputElement,
  options: {
    target?: EventTarget;
    nativeTarget?: EventTarget;
    EventType?: typeof window.Event;
    wrapperType?: string;
    nativeType?: string;
  } = {},
) {
  const target = options.target ?? currentTarget;
  const nativeTarget = options.nativeTarget ?? target;
  const EventType = options.EventType ?? currentTarget.ownerDocument.defaultView!.Event;
  const nativeEvent = new EventType(options.nativeType ?? "input", {
    bubbles: true,
    cancelable: true,
  });
  setNativeProvenance(nativeEvent, nativeTarget);
  return {
    type: options.wrapperType ?? "change",
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
    preventDefault: vi.fn(),
  } as unknown as ChangeEvent<HTMLInputElement>;
}

function keyboardEvent(
  currentTarget: HTMLFormElement,
  target: HTMLElement,
  options: {
    nativeTarget?: EventTarget;
    KeyboardEventType?: typeof window.KeyboardEvent;
    wrapperType?: string;
    nativeType?: string;
    key?: string;
    nativeKey?: string;
    code?: string;
    nativeCode?: string;
    altKey?: boolean;
    nativeAltKey?: boolean;
    ctrlKey?: boolean;
    nativeCtrlKey?: boolean;
    metaKey?: boolean;
    nativeMetaKey?: boolean;
    shiftKey?: boolean;
    nativeShiftKey?: boolean;
    repeat?: boolean;
    nativeRepeat?: boolean;
    isComposing?: boolean;
    bubbles?: boolean;
    nativeBubbles?: boolean;
    cancelable?: boolean;
    nativeCancelable?: boolean;
    defaultPrevented?: boolean;
    propagationStopped?: boolean;
    eventPhase?: number;
  } = {},
) {
  const KeyboardEventType = options.KeyboardEventType ?? window.KeyboardEvent;
  const key = options.key ?? "Escape";
  const code = options.code ?? "Escape";
  const altKey = options.altKey ?? false;
  const ctrlKey = options.ctrlKey ?? false;
  const metaKey = options.metaKey ?? false;
  const shiftKey = options.shiftKey ?? false;
  const repeat = options.repeat ?? false;
  const bubbles = options.bubbles ?? true;
  const cancelable = options.cancelable ?? true;
  const nativeEvent = new KeyboardEventType(options.nativeType ?? "keydown", {
    key: options.nativeKey ?? key,
    code: options.nativeCode ?? code,
    altKey: options.nativeAltKey ?? altKey,
    ctrlKey: options.nativeCtrlKey ?? ctrlKey,
    metaKey: options.nativeMetaKey ?? metaKey,
    shiftKey: options.nativeShiftKey ?? shiftKey,
    repeat: options.nativeRepeat ?? repeat,
    isComposing: options.isComposing ?? false,
    bubbles: options.nativeBubbles ?? bubbles,
    cancelable: options.nativeCancelable ?? cancelable,
  });
  setNativeProvenance(
    nativeEvent,
    options.nativeTarget ?? target,
  );
  if (options.eventPhase !== undefined) {
    Object.defineProperty(nativeEvent, "eventPhase", {
      configurable: true,
      value: options.eventPhase,
    });
  }
  const preventDefault = vi.fn();
  const defaultPrevented = options.defaultPrevented ?? false;
  const propagationStopped = options.propagationStopped ?? false;
  return {
    event: {
      type: options.wrapperType ?? "keydown",
      currentTarget,
      target,
      nativeEvent,
      key,
      code,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      repeat,
      bubbles,
      cancelable,
      defaultPrevented,
      preventDefault,
      isDefaultPrevented: () => defaultPrevented,
      isPropagationStopped: () => propagationStopped,
    } as unknown as ReactKeyboardEvent<HTMLFormElement>,
    nativeEvent,
    preventDefault,
  };
}

function markJsdomEventTrusted(event: Event) {
  // jsdom has no hardware input; update only its internal trust slot.
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) => (event as unknown as Record<symbol, unknown>)[symbol],
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

function createDispatchedKeyboardEvent(
  target: HTMLElement,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The keyboard target has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
    view: ownerWindow,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function dispatchKeyboardEvent(
  target: HTMLElement,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const event = createDispatchedKeyboardEvent(target, init, trusted);
  fireEvent(target, event);
  return event;
}

function dispatchKeyboardWithReactMutation(
  form: HTMLFormElement,
  target: HTMLElement,
  mutate: (event: ReactKeyboardEvent<HTMLFormElement>) => void,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const propsKey = Object.keys(form).find((key) =>
    key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the form");
  const properties = form as unknown as Record<
    string,
    Record<string, unknown>
  >;
  const props = properties[propsKey];
  const handler = props?.onKeyDown;
  if (!props || typeof handler !== "function") {
    throw new Error("onKeyDown was not attached to the form");
  }
  const wrapped = {
    ...props,
    onKeyDown: (event: ReactKeyboardEvent<HTMLFormElement>) => {
      mutate(event);
      (handler as KeyDownHandler)(event);
    },
  };
  properties[propsKey] = wrapped;
  try {
    return dispatchKeyboardEvent(target, init, trusted);
  } finally {
    if (properties[propsKey] === wrapped) properties[propsKey] = props;
  }
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function retiredListAuthority(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (
    !reason ||
    typeof reason !== "object" ||
    !("authority" in reason)
  ) {
    throw new Error("The retired list abort did not publish its authority");
  }
  const authority: unknown = reason.authority;
  if (
    !authority ||
    typeof authority !== "object" ||
    !("read" in authority) ||
    typeof authority.read !== "function"
  ) {
    throw new Error("The retired list abort authority was invalid");
  }
  return Reflect.apply(authority.read, authority, []);
}

const disabledWebhook = {
  id: "disabled-hook",
  url: "https://receiver.example/disabled",
  events: ["comment.added"],
  documentIds: null,
  active: false,
  failures: 20,
  createdAt: "2026-09-01T12:00:00.000Z",
  lastDelivery: { status: 500, at: "2026-09-01T12:01:00.000Z", attempt: 4, event: "comment.added" },
};

const activeWebhook = {
  ...disabledWebhook,
  id: "active-hook",
  url: "https://receiver.example/active",
  active: true,
  failures: 0,
  lastDelivery: null,
};

const otherDisabledWebhook = {
  ...disabledWebhook,
  id: "other-disabled-hook",
  url: "https://receiver.example/other-disabled",
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  foreignRoot = document.createElement("div");
  document.body.append(foreignRoot);
});

afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  foreignRoot.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Settings → Webhooks: list recovery", () => {
  it("replaces a settled initial failure with its API reason and one atomic Retry alert", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Webhook service unavailable" }, 503));
    render(<WebhooksPanel />);

    const errorBlock = await screen.findByTestId("webhooks-list-error");
    const alert = within(errorBlock).getByRole("alert");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveTextContent("Webhook service unavailable");
    expect(within(errorBlock).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("guards Retry while pending and recovers to the genuine empty state", async () => {
    const retry = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ error: "Try again" }, 503)).mockReturnValueOnce(retry.promise);
    render(<WebhooksPanel />);

    const retryButton = within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.queryByText("Loading…")).toBeNull();

    await act(async () => retry.resolve(response({ webhooks: [] })));
    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
  });

  it("recovers from an initial failure to the populated list", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Try again" }, 503)).mockResolvedValueOnce(response({ webhooks: [activeWebhook] }));
    render(<WebhooksPanel />);

    fireEvent.click(within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("webhook-row")).toHaveTextContent(activeWebhook.url);
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cached rows visible when a later refresh fails with the fallback reason", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook] }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockRejectedValueOnce("offline");
    render(<WebhooksPanel />);

    const row = await screen.findByTestId("webhook-row");
    fireEvent.click(within(row).getByTestId("webhook-test"));

    expect(await screen.findByTestId("webhooks-list-error")).toHaveTextContent("Failed to load webhooks");
    expect(screen.getByTestId("webhook-row")).toHaveTextContent(activeWebhook.url);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/active-hook/test", "/api/webhooks"]);
  });

  it("keeps list and action errors separate and clears only the list error after a successful Retry", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: "List unavailable" }, 503))
      .mockResolvedValueOnce(response({ error: "Receiver URL is not allowed" }, 400))
      .mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-list-error");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/hook" } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Receiver URL is not allowed");
    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("List unavailable");

    fireEvent.click(within(screen.getByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));
    await screen.findByTestId("webhooks-empty");

    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.getByTestId("webhook-action-error")).toHaveTextContent("Receiver URL is not allowed");
  });

  it("ignores an older list success after a newer list failure", async () => {
    const firstEnable = deferred<Response>();
    const secondEnable = deferred<Response>();
    const staleList = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(firstEnable.promise)
      .mockReturnValueOnce(secondEnable.promise)
      .mockReturnValueOnce(staleList.promise)
      .mockResolvedValueOnce(response({ error: "Newest refresh failed" }, 503));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));

    await act(async () => firstEnable.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => secondEnable.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    expect(await screen.findByTestId("webhooks-list-error")).toHaveTextContent("Newest refresh failed");

    await act(async () => staleList.resolve(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }] })));

    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("Newest refresh failed");
    expect(screen.getAllByTestId("webhook-row")).toHaveLength(2);
    expect(screen.getByText(disabledWebhook.url)).toBeInTheDocument();
    expect(screen.getByText(otherDisabledWebhook.url)).toBeInTheDocument();
  });
});

describe("Settings → Webhooks: manual refresh ownership", () => {
  it("keeps the current publication usable through a parent-only rerender", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ webhooks: [activeWebhook] })));
    const view = renderDirect(
      <StrictMode><BoundaryHarness boundary={0} /></StrictMode>,
    );

    await within(view.host).findByText(activeWebhook.url);
    await settle();
    const refresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    const publishedRef = reactProp<RefCallback<HTMLButtonElement>>(
      refresh,
      "ref",
    );
    const callsBeforeRefresh = fetchMock.mock.calls.length;

    act(() => view.root.render(
      <StrictMode><BoundaryHarness boundary={1} /></StrictMode>,
    ));
    await settle();

    const currentRefresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    expect(currentRefresh).toBe(refresh);
    expect(reactProp<RefCallback<HTMLButtonElement>>(currentRefresh, "ref"))
      .toBe(publishedRef);
    fireEvent.click(currentRefresh);
    await waitFor(() => expect(fetchMock.mock.calls.length)
      .toBe(callsBeforeRefresh + 1));
  });

  it.each([
    {
      label: "Enable",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      actionResponse: response({
        webhook: { ...disabledWebhook, active: true, failures: 0 },
      }),
      reloaded: [{ ...disabledWebhook, active: true, failures: 0 }],
    },
    {
      label: "Send test",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      actionResponse: response({ ok: true }),
      reloaded: [activeWebhook],
    },
    {
      label: "Delete",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      actionResponse: response({ ok: true }),
      reloaded: [],
    },
  ])("blocks Refresh while $label owns its row, then admits a fresh request", async ({
    hook,
    control,
    actionUrl,
    actionResponse,
    reloaded,
  }) => {
    const action = deferred<Response>();
    let phase: "initial" | "pending" | "reload" | "fresh" = "initial";
    fetchMock.mockImplementation((url, init) => {
      if (url === actionUrl) return action.promise;
      if (url === "/api/webhooks" && !init?.method) {
        if (phase === "initial") {
          return Promise.resolve(response({ webhooks: [hook] }));
        }
        if (phase === "pending") {
          return Promise.resolve(response({ webhooks: [] }));
        }
        return Promise.resolve(response({
          webhooks: phase === "reload" ? reloaded : [otherDisabledWebhook],
        }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByTestId(control);
    await settle();
    const listCallsBeforeAction = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    ).length;
    phase = "pending";
    fireEvent.click(within(view.host).getByTestId(control));
    const refresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    expect(refresh).toBeDisabled();
    const rejectedEvent = mouseEvent(refresh);
    act(() => reactProp<ClickHandler>(refresh, "onClick")(rejectedEvent));

    expect(rejectedEvent.preventDefault).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeAction);
    expect(within(view.host).getByTestId("webhook-row")).toBeInTheDocument();

    phase = "reload";
    await act(async () => action.resolve(actionResponse));
    await waitFor(() => expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeAction + 1));
    if (reloaded.length === 0) {
      await within(view.host).findByTestId("webhooks-empty");
    } else {
      await within(view.host).findByTestId("webhook-row");
    }
    await waitFor(() => expect(
      within(view.host).getByTestId("webhook-refresh"),
    ).toBeEnabled());

    phase = "fresh";
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));
    expect(await within(view.host).findByText(otherDisabledWebhook.url))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeAction + 2);
  });

  it("blocks both Refresh and Retry while a row operation owns settlement", async () => {
    const testRequest = deferred<Response>();
    let phase: "initial" | "failure" | "pending" | "reload" | "fresh" = "initial";
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks/active-hook/test") return testRequest.promise;
      if (url === "/api/webhooks" && !init?.method) {
        if (phase === "initial") {
          return Promise.resolve(response({ webhooks: [activeWebhook] }));
        }
        if (phase === "failure") {
          return Promise.resolve(response({ error: "List unavailable" }, 503));
        }
        if (phase === "pending") {
          return Promise.resolve(response({ webhooks: [] }));
        }
        return Promise.resolve(response({
          webhooks: phase === "reload" ? [activeWebhook] : [otherDisabledWebhook],
        }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByText(activeWebhook.url);
    await settle();
    phase = "failure";
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));
    await within(view.host).findByTestId("webhooks-list-error");
    const listCallsBeforeRow = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    ).length;

    phase = "pending";
    fireEvent.click(within(view.host).getByTestId("webhook-test"));
    const refresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    const retry = within(view.host)
      .getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(refresh).toBeDisabled();
    expect(retry).toBeDisabled();
    const refreshEvent = mouseEvent(refresh);
    const retryEvent = mouseEvent(retry);
    act(() => {
      reactProp<ClickHandler>(refresh, "onClick")(refreshEvent);
      reactProp<ClickHandler>(retry, "onClick")(retryEvent);
    });

    expect(refreshEvent.preventDefault).not.toHaveBeenCalled();
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeRow);
    expect(within(view.host).getByTestId("webhooks-list-error"))
      .toHaveTextContent("List unavailable");

    phase = "reload";
    await act(async () => testRequest.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeRow + 1));
    await waitFor(() => {
      expect(within(view.host).getByTestId("webhook-refresh")).toBeEnabled();
      expect(within(view.host).queryByTestId("webhooks-list-error")).toBeNull();
    });

    phase = "fresh";
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));
    expect(await within(view.host).findByText(otherDisabledWebhook.url))
      .toBeInTheDocument();
  });

  it("blocks Refresh while Create owns settlement, then admits a fresh request", async () => {
    const create = deferred<Response>();
    const createdWebhook = {
      ...activeWebhook,
      id: "create-before-refresh",
      url: "https://receiver.example/create-before-refresh",
    };
    let phase: "initial" | "pending" | "reload" | "fresh" = "initial";
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks" && init?.method === "POST") {
        return create.promise;
      }
      if (url === "/api/webhooks" && !init?.method) {
        if (phase === "initial") return Promise.resolve(response({ webhooks: [] }));
        if (phase === "pending") return Promise.resolve(response({
          webhooks: [otherDisabledWebhook],
        }));
        return Promise.resolve(response({
          webhooks: phase === "reload" ? [createdWebhook] : [otherDisabledWebhook],
        }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByTestId("webhooks-empty");
    await settle();
    const listCallsBeforeCreate = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    ).length;
    fireEvent.click(within(view.host).getByTestId("webhook-add"));
    fireEvent.change(within(view.host).getByTestId("webhook-url"), {
      target: { value: createdWebhook.url },
    });
    phase = "pending";
    fireEvent.click(within(view.host).getByTestId("webhook-create"));

    const refresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    expect(refresh).toBeDisabled();
    act(() => reactProp<ClickHandler>(refresh, "onClick")(mouseEvent(refresh)));
    expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeCreate);

    phase = "reload";
    await act(async () => create.resolve(response({
      webhook: { ...createdWebhook, secret: "whsec_create_before_refresh" },
    })));
    expect(await within(view.host).findByText(createdWebhook.url))
      .toBeInTheDocument();
    await waitFor(() => expect(
      within(view.host).getByTestId("webhook-refresh"),
    ).toBeEnabled());

    phase = "fresh";
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));
    expect(await within(view.host).findByText(otherDisabledWebhook.url))
      .toBeInTheDocument();
  });

  it("publishes one busy Refresh and atomically replaces the current rows on success", async () => {
    const refresh = deferred<Response>();
    let serveRefresh = false;
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks" && !init?.method) {
        return serveRefresh
          ? refresh.promise
          : Promise.resolve(response({ webhooks: [activeWebhook] }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await screen.findByText(activeWebhook.url);
    await settle();
    const listCallsBeforeRefresh = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    ).length;
    serveRefresh = true;
    const refreshButton = screen.getByRole("button", {
      name: "Refresh webhooks",
    }) as HTMLButtonElement;
    const refreshHandler = reactProp<ClickHandler>(refreshButton, "onClick");
    const refreshEvent = mouseEvent(refreshButton);
    act(() => {
      refreshHandler(refreshEvent);
      refreshHandler(refreshEvent);
    });

    expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeRefresh + 1);
    expect(screen.getByRole("button", { name: "Refreshing webhooks" }))
      .toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Refreshing webhooks" }))
      .toBeDisabled();
    expect(screen.getByText(activeWebhook.url)).toBeInTheDocument();

    await act(async () => refresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    })));

    expect(await screen.findByText(otherDisabledWebhook.url)).toBeInTheDocument();
    expect(screen.queryByText(activeWebhook.url)).toBeNull();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh webhooks" })).toBeEnabled();
  });

  it("retains rows, draft fields, and the revealed secret on failure and recovery", async () => {
    const failedRefresh = deferred<Response>();
    const recoveredRefresh = deferred<Response>();
    const createdWebhook = {
      ...activeWebhook,
      id: "refresh-created-hook",
      url: "https://receiver.example/refresh-created",
    };
    let createdAccepted = false;
    let listMode: "normal" | "failing" | "recovering" = "normal";
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks" && init?.method === "POST") {
        createdAccepted = true;
        return Promise.resolve(response({
          webhook: { ...createdWebhook, secret: "whsec_refresh_kept" },
        }));
      }
      if (url === "/api/webhooks" && !init?.method) {
        if (listMode === "failing") return failedRefresh.promise;
        if (listMode === "recovering") return recoveredRefresh.promise;
        return Promise.resolve(response({
          webhooks: createdAccepted ? [createdWebhook] : [],
        }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await screen.findByTestId("webhooks-empty");
    await settle();
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: createdWebhook.url },
    });
    fireEvent.click(screen.getByTestId("webhook-create"));
    expect(await screen.findByTestId("webhook-secret"))
      .toHaveTextContent("whsec_refresh_kept");
    await screen.findByText(createdWebhook.url);

    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: "https://receiver.example/draft-kept" },
    });
    fireEvent.change(screen.getByTestId("webhook-docs"), {
      target: { value: "doc-kept" },
    });
    listMode = "failing";
    fireEvent.click(screen.getByTestId("webhook-refresh"));

    expect(screen.getByText(createdWebhook.url)).toBeInTheDocument();
    expect(screen.getByTestId("webhook-url"))
      .toHaveValue("https://receiver.example/draft-kept");
    expect(screen.getByTestId("webhook-docs")).toHaveValue("doc-kept");
    expect(screen.getByTestId("webhook-secret"))
      .toHaveTextContent("whsec_refresh_kept");

    await act(async () => failedRefresh.resolve(response({
      error: "Manual refresh unavailable",
    }, 503)));

    expect(await screen.findByTestId("webhooks-list-error"))
      .toHaveTextContent("Manual refresh unavailable");
    expect(screen.getByText(createdWebhook.url)).toBeInTheDocument();
    expect(screen.getByTestId("webhook-url"))
      .toHaveValue("https://receiver.example/draft-kept");
    expect(screen.getByTestId("webhook-docs")).toHaveValue("doc-kept");
    expect(screen.getByTestId("webhook-secret"))
      .toHaveTextContent("whsec_refresh_kept");

    listMode = "recovering";
    fireEvent.click(screen.getByTestId("webhook-refresh"));
    await act(async () => recoveredRefresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    })));

    expect(await screen.findByText(otherDisabledWebhook.url)).toBeInTheDocument();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.getByTestId("webhook-url"))
      .toHaveValue("https://receiver.example/draft-kept");
    expect(screen.getByTestId("webhook-secret"))
      .toHaveTextContent("whsec_refresh_kept");
  });

  it("coalesces repeated and crossed Refresh and Retry activations", async () => {
    const refresh = deferred<Response>();
    const retry = deferred<Response>();
    let listMode: "initial" | "refresh" | "retry" = "initial";
    fetchMock.mockImplementation((url, init) => {
      if (url !== "/api/webhooks" || init?.method) {
        return Promise.resolve(response({ error: "Unexpected request" }, 500));
      }
      if (listMode === "refresh") return refresh.promise;
      if (listMode === "retry") return retry.promise;
      return Promise.resolve(response({ error: "Initial list failed" }, 503));
    });
    renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    const errorBlock = await screen.findByTestId("webhooks-list-error");
    await settle();
    const listCallsBeforeRefresh = fetchMock.mock.calls.length;
    listMode = "refresh";
    const refreshButton = screen.getByTestId("webhook-refresh") as HTMLButtonElement;
    const retryButton = within(errorBlock).getByRole("button", {
      name: "Retry",
    }) as HTMLButtonElement;
    const refreshHandler = reactProp<ClickHandler>(refreshButton, "onClick");
    const retryHandler = reactProp<ClickHandler>(retryButton, "onClick");
    const refreshEvent = mouseEvent(refreshButton);
    const retryEvent = mouseEvent(retryButton);
    act(() => {
      refreshHandler(refreshEvent);
      refreshHandler(refreshEvent);
      retryHandler(retryEvent);
    });

    expect(fetchMock).toHaveBeenCalledTimes(listCallsBeforeRefresh + 1);
    expect(screen.getByRole("button", { name: "Refreshing webhooks" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    await act(async () => refresh.resolve(response({
      error: "Refresh still failed",
    }, 503)));
    expect(await screen.findByTestId("webhooks-list-error"))
      .toHaveTextContent("Refresh still failed");

    listMode = "retry";
    const currentRetry = screen.getByRole("button", {
      name: "Retry",
    }) as HTMLButtonElement;
    const currentRefresh = screen.getByTestId("webhook-refresh") as HTMLButtonElement;
    const currentRetryHandler = reactProp<ClickHandler>(currentRetry, "onClick");
    const currentRefreshHandler = reactProp<ClickHandler>(currentRefresh, "onClick");
    const callsBeforeRetry = fetchMock.mock.calls.length;
    act(() => {
      const event = mouseEvent(currentRetry);
      currentRetryHandler(event);
      currentRetryHandler(event);
      currentRefreshHandler(mouseEvent(currentRefresh));
    });

    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect(screen.getByRole("button", { name: "Retrying…" }))
      .toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Refresh webhooks" }))
      .toBeDisabled();
    await act(async () => retry.resolve(response({ webhooks: [] })));
    expect(await screen.findByTestId("webhooks-empty")).toBeInTheDocument();
  });

  it("retires an older Refresh when a row operation starts", async () => {
    const refresh = deferred<Response>();
    const testRequest = deferred<Response>();
    const refreshSignals: AbortSignal[] = [];
    let aborts = 0;
    let refreshing = false;
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks/active-hook/test") return testRequest.promise;
      if (url === "/api/webhooks" && !init?.method) {
        if (refreshing) {
          const signal = init?.signal;
          if (!signal) {
            return Promise.resolve(response({ error: "Missing signal" }, 500));
          }
          refreshSignals.push(signal);
          signal.addEventListener("abort", () => {
            aborts += 1;
            refresh.reject(signal.reason);
          }, { once: true });
          return refresh.promise;
        }
        return Promise.resolve(response({ webhooks: [activeWebhook] }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await screen.findByText(activeWebhook.url);
    await settle();
    refreshing = true;
    fireEvent.click(screen.getByTestId("webhook-refresh"));
    expect(screen.getByRole("button", { name: "Refreshing webhooks" }))
      .toBeDisabled();
    fireEvent.click(screen.getByTestId("webhook-test"));
    expect(screen.getByRole("button", { name: "Refresh webhooks" })).toBeDisabled();
    expect(refreshSignals).toHaveLength(1);
    expect(refreshSignals[0].aborted).toBe(true);
    expect(refreshSignals[0].reason).toMatchObject({ name: "AbortError" });
    expect(retiredListAuthority(refreshSignals[0])).toBeNull();
    expect(aborts).toBe(1);

    refresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    }));
    await settle();
    expect(screen.getByText(activeWebhook.url)).toBeInTheDocument();
    expect(screen.queryByText(otherDisabledWebhook.url)).toBeNull();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();

    refreshing = false;
    await act(async () => testRequest.resolve(response({ ok: true })));
    await waitFor(() => expect(screen.getByTestId("webhook-test")).toBeEnabled());
    expect(screen.getByText(activeWebhook.url)).toBeInTheDocument();
    expect(aborts).toBe(1);

    const listCallsBeforeFresh = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    ).length;
    fireEvent.click(screen.getByTestId("webhook-refresh"));
    await waitFor(() => expect(fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/webhooks" && !init?.method,
    )).toHaveLength(listCallsBeforeFresh + 1));
  });

  it("retires an older Refresh when Create starts and preserves Create settlement", async () => {
    const refresh = deferred<Response>();
    const create = deferred<Response>();
    const refreshSignals: AbortSignal[] = [];
    let aborts = 0;
    const createdWebhook = {
      ...activeWebhook,
      id: "crossed-created-hook",
      url: "https://receiver.example/crossed-created",
    };
    let listMode: "normal" | "refresh" | "created" = "normal";
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks" && init?.method === "POST") {
        return create.promise;
      }
      if (url === "/api/webhooks" && !init?.method) {
        if (listMode === "refresh") {
          const signal = init?.signal;
          if (!signal) {
            return Promise.resolve(response({ error: "Missing signal" }, 500));
          }
          refreshSignals.push(signal);
          signal.addEventListener("abort", () => {
            aborts += 1;
            refresh.reject(signal.reason);
          }, { once: true });
          return refresh.promise;
        }
        return Promise.resolve(response({
          webhooks: listMode === "created" ? [createdWebhook] : [],
        }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await screen.findByTestId("webhooks-empty");
    await settle();
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: createdWebhook.url },
    });
    listMode = "refresh";
    fireEvent.click(screen.getByTestId("webhook-refresh"));
    fireEvent.click(screen.getByTestId("webhook-create"));
    expect(screen.getByRole("button", { name: "Refresh webhooks" })).toBeDisabled();
    expect(refreshSignals).toHaveLength(1);
    expect(refreshSignals[0].aborted).toBe(true);
    expect(retiredListAuthority(refreshSignals[0])).toBeNull();
    expect(aborts).toBe(1);

    refresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    }));
    await settle();
    expect(screen.queryByText(otherDisabledWebhook.url)).toBeNull();
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();

    listMode = "created";
    await act(async () => create.resolve(response({
      webhook: { ...createdWebhook, secret: "whsec_crossed_create" },
    })));
    expect(await screen.findByText(createdWebhook.url)).toBeInTheDocument();
    expect(screen.getByTestId("webhook-secret"))
      .toHaveTextContent("whsec_crossed_create");
    expect(aborts).toBe(1);
  });

  it("retires Refresh on cleanup and leaves a clean remount usable", async () => {
    const retiredRefresh = deferred<Response>();
    const retiredSignals: AbortSignal[] = [];
    let aborts = 0;
    let listMode: "initial" | "created" | "retired" | "successor" = "initial";
    fetchMock.mockImplementation((url, init) => {
      if (url === "/api/webhooks" && init?.method === "POST") {
        return Promise.resolve(response({
          webhook: { ...activeWebhook, secret: "whsec_cleanup_release" },
        }));
      }
      if (url !== "/api/webhooks" || init?.method) {
        return Promise.resolve(response({ error: "Unexpected request" }, 500));
      }
      if (listMode === "retired") {
        const signal = init?.signal;
        if (!signal) {
          return Promise.resolve(response({ error: "Missing signal" }, 500));
        }
        retiredSignals.push(signal);
        signal.addEventListener("abort", () => {
          aborts += 1;
          retiredRefresh.reject(signal.reason);
        }, { once: true });
        return retiredRefresh.promise;
      }
      return Promise.resolve(response({
        webhooks: listMode === "successor"
          ? [otherDisabledWebhook]
          : listMode === "created"
            ? [activeWebhook]
            : [],
      }));
    });
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByTestId("webhooks-empty");
    await settle();
    fireEvent.click(within(view.host).getByTestId("webhook-add"));
    fireEvent.change(within(view.host).getByTestId("webhook-url"), {
      target: { value: activeWebhook.url },
    });
    listMode = "created";
    fireEvent.click(within(view.host).getByTestId("webhook-create"));
    expect(await within(view.host).findByTestId("webhook-secret"))
      .toHaveTextContent("whsec_cleanup_release");
    await within(view.host).findByText(activeWebhook.url);
    await settle();

    listMode = "retired";
    const refreshButton = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    const refreshHandler = reactProp<ClickHandler>(refreshButton, "onClick");
    const refreshEvent = mouseEvent(refreshButton);
    act(() => refreshHandler(refreshEvent));
    const callsAtUnmount = fetchMock.mock.calls.length;
    act(() => view.root.unmount());
    act(() => refreshHandler(refreshEvent));
    expect(retiredSignals).toHaveLength(1);
    expect(retiredSignals[0].aborted).toBe(true);
    expect(retiredSignals[0].reason).toMatchObject({ name: "AbortError" });
    expect(retiredListAuthority(retiredSignals[0])).toBeNull();
    expect(aborts).toBe(1);
    retiredRefresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    }));
    await settle();

    expect(view.host).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(callsAtUnmount);
    expect(aborts).toBe(1);

    listMode = "successor";
    const successor = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
    expect(await within(successor.host).findByText(otherDisabledWebhook.url))
      .toBeInTheDocument();
    await settle();
    fireEvent.click(within(successor.host).getByTestId("webhook-refresh"));
    expect(within(successor.host).getByText(otherDisabledWebhook.url))
      .toBeInTheDocument();
  });

  it("surfaces an unrelated current AbortError instead of treating its name as retirement", async () => {
    const unrelatedAbort = new DOMException(
      "The upstream request aborted unexpectedly.",
      "AbortError",
    );
    let abortCurrentRequest = false;
    fetchMock.mockImplementation(() =>
      abortCurrentRequest
        ? Promise.reject(unrelatedAbort)
        : Promise.resolve(response({ webhooks: [activeWebhook] })));
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByText(activeWebhook.url);
    await settle();
    const callsBeforeRefresh = fetchMock.mock.calls.length;
    abortCurrentRequest = true;
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));

    expect(await within(view.host).findByTestId("webhooks-list-error"))
      .toHaveTextContent("Failed to load webhooks");
    const signal = fetchMock.mock.calls[callsBeforeRefresh]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(within(view.host).getByText(activeWebhook.url)).toBeInTheDocument();
  });

  it("rejects settlement after document replacement without affecting a clean successor", async () => {
    const replacedRefresh = deferred<Response>();
    let replaceDocument = false;
    fetchMock.mockImplementation((url, init) => {
      if (url !== "/api/webhooks" || init?.method) {
        return Promise.resolve(response({ error: "Unexpected request" }, 500));
      }
      return replaceDocument
        ? replacedRefresh.promise
        : Promise.resolve(response({ webhooks: [activeWebhook] }));
    });
    const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

    await within(view.host).findByText(activeWebhook.url);
    await settle();
    replaceDocument = true;
    fireEvent.click(within(view.host).getByTestId("webhook-refresh"));
    const iframe = document.createElement("iframe");
    foreignRoot.append(iframe);
    iframe.contentDocument!.body.append(view.host);
    await act(async () => replacedRefresh.resolve(response({
      webhooks: [otherDisabledWebhook],
    })));
    await settle();

    expect(within(view.host).getByText(activeWebhook.url).textContent)
      .toBe(activeWebhook.url);
    expect(within(view.host).queryByText(otherDisabledWebhook.url)).toBeNull();

    replaceDocument = false;
    const successor = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
    await within(successor.host).findByText(activeWebhook.url);
    await settle();
    const callsBeforeRefresh = fetchMock.mock.calls.length;
    fireEvent.click(within(successor.host).getByTestId("webhook-refresh"));
    await waitFor(() => expect(fetchMock.mock.calls.length)
      .toBe(callsBeforeRefresh + 1));
    iframe.remove();
  });

  it("rejects callback/event replay and restored DOM mutation before a clean remount", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ webhooks: [activeWebhook] })));
    const view = renderDirect(
      <StrictMode><BoundaryHarness cardKey={1} /></StrictMode>,
    );

    await within(view.host).findByText(activeWebhook.url);
    await settle();
    const refresh = within(view.host).getByTestId("webhook-refresh") as HTMLButtonElement;
    const retiredHandler = reactProp<ClickHandler>(refresh, "onClick");
    const retiredEvent = mouseEvent(refresh);
    const callsBeforeMutation = fetchMock.mock.calls.length;
    refresh.setAttribute("data-restored", "true");
    refresh.removeAttribute("data-restored");
    act(() => {
      retiredHandler(retiredEvent);
      retiredHandler(retiredEvent);
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeMutation);

    act(() => view.root.render(
      <StrictMode><BoundaryHarness cardKey={2} /></StrictMode>,
    ));
    await waitFor(() => expect(fetchMock.mock.calls.length)
      .toBeGreaterThan(callsBeforeMutation));
    await within(view.host).findByText(activeWebhook.url);
    await settle();
    const currentRefresh = within(view.host)
      .getByTestId("webhook-refresh") as HTMLButtonElement;
    const currentHandler = reactProp<ClickHandler>(currentRefresh, "onClick");
    const callsBeforeReplay = fetchMock.mock.calls.length;
    act(() => {
      retiredHandler(mouseEvent(currentRefresh));
      currentHandler(retiredEvent);
      currentHandler(mouseEvent(currentRefresh));
      currentHandler(mouseEvent(currentRefresh));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(
      callsBeforeReplay + 1,
    ));
  });
});

describe("Settings → Webhooks: the add form shows the validation reason (#1480)", () => {
  it("shows the URL rule, not the bare \"Invalid request\", when the server rejects the new webhook", async () => {
    // `handler()` answers a zod failure with `400 { error: "Invalid request", issues }`; the panel's `request()` turns
    // that into `new ApiError(400, "Invalid request", [{ path: ["url"], message: "Enter an https:// URL" }])`.
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ error: "Invalid request", issues: [{ path: ["url"], message: "Enter an https:// URL" }] }, 400));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter an https:// URL");
    expect(alert).not.toHaveTextContent("Invalid request");
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ url: "not-a-url" });
  });
});

describe("Settings → Webhooks: event targets", () => {
  it("keeps each native checkbox inside a 24px hit row and lets the label toggle it", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));

    const checkbox = screen.getByTestId("webhook-event-content.changed");
    const row = checkbox.closest("label");
    expect(row).not.toBeNull();
    expect(row).toHaveClass("min-h-6");
    expect(checkbox).not.toBeChecked();

    fireEvent.click(row!);
    expect(checkbox).toBeChecked();
  });
});

describe("Settings → Webhooks: enable a disabled webhook", () => {
  it("shows Enable only for inactive rows, locks that row while pending, and reloads the active row", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, activeWebhook] }))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeEnabled();
    expect(within(rows[1]).queryByTestId("webhook-enable")).toBeNull();
    expect(screen.getAllByTestId("webhook-enable")).toHaveLength(1);

    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-delete")).toBeDisabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-delete")).toBeEnabled();

    await act(async () => pending.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.queryByTestId("webhook-enable")).toBeNull());
    expect(screen.getByTestId("webhook-status")).toHaveTextContent("enabled · last attempt 500 ·");
    expect(screen.getByTestId("webhook-status")).not.toHaveTextContent("failed ×0");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/disabled-hook/enable", "/api/webhooks"]);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
  });

  it("keeps both disabled rows locked while overlapping enable requests settle independently", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, { ...otherDisabledWebhook, active: true, failures: 0 }] }))
      .mockResolvedValueOnce(response({ webhooks: [{ ...disabledWebhook, active: true, failures: 0 }, { ...otherDisabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    let rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-enable"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    for (const row of rows) {
      expect(within(row).getByTestId("webhook-enable")).toBeDisabled();
      expect(within(row).getByTestId("webhook-test")).toBeDisabled();
      expect(within(row).getByTestId("webhook-delete")).toBeDisabled();
    }

    await act(async () => second.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.getAllByTestId("webhook-enable")).toHaveLength(1));
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-enable")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[0]).getByTestId("webhook-delete")).toBeDisabled();
    expect(within(rows[1]).queryByTestId("webhook-enable")).toBeNull();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-delete")).toBeEnabled();

    await act(async () => first.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(screen.queryByTestId("webhook-enable")).toBeNull());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/enable",
      "/api/webhooks/other-disabled-hook/enable",
      "/api/webhooks",
      "/api/webhooks",
    ]);
  });

  it("shows the server reason inline and leaves the disabled row available to retry", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook] }))
      .mockResolvedValueOnce(response({ error: "A webhook cannot point at Markdoc itself" }, 400));
    render(<WebhooksPanel />);

    fireEvent.click(await screen.findByTestId("webhook-enable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A webhook cannot point at Markdoc itself");
    expect(screen.getByTestId("webhook-enable")).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Settings → Webhooks: action ownership", () => {
  it("owns duplicate Create synchronously, preserves a failed form, and keeps an accepted secret until it renders", async () => {
    const firstCreate = deferred<Response>();
    const secondCreate = deferred<Response>();
    const refresh = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockReturnValueOnce(firstCreate.promise)
      .mockReturnValueOnce(secondCreate.promise)
      .mockReturnValueOnce(refresh.promise);
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/retry-me" } });
    fireEvent.change(screen.getByTestId("webhook-docs"), { target: { value: "doc-one, doc-two" } });
    const form = screen.getByTestId("webhook-form");

    fireEvent.click(screen.getByTestId("webhook-create"));
    fireEvent.click(screen.getByTestId("webhook-create"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("webhook-create")).toBeDisabled();
    expect(screen.getByTestId("webhook-add")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByTestId("webhook-url")).toBeDisabled();
    expect(screen.getByTestId("webhook-docs")).toBeDisabled();
    expect(screen.getByTestId("webhook-event-request.created")).toBeDisabled();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const disclosure = screen.getByTestId("webhook-add");
    cancel.removeAttribute("disabled");
    disclosure.removeAttribute("disabled");
    fireEvent.click(cancel);
    fireEvent.click(disclosure);
    expect(form).toBeInTheDocument();

    await act(async () => firstCreate.resolve(response({ error: "Receiver rejected this URL" }, 422)));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Receiver rejected this URL");
    expect(screen.getByTestId("webhook-url")).toHaveValue("https://receiver.example/retry-me");
    expect(screen.getByTestId("webhook-docs")).toHaveValue("doc-one, doc-two");
    expect(screen.getByTestId("webhook-create")).toBeEnabled();

    fireEvent.click(screen.getByTestId("webhook-create"));
    fireEvent.click(screen.getByTestId("webhook-create"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("webhook-create")).toBeDisabled();

    await act(async () =>
      secondCreate.resolve(response({ webhook: { ...activeWebhook, id: "created-hook", secret: "whsec_single_display" } })),
    );

    const created = await screen.findByTestId("webhook-created");
    expect(within(created).getAllByTestId("webhook-secret")).toHaveLength(1);
    expect(screen.queryByTestId("webhook-form")).toBeNull();
    expect(screen.getByTestId("webhook-add")).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => refresh.resolve(response({ webhooks: [{ ...activeWebhook, id: "created-hook" }] })));

    expect(screen.getByTestId("webhook-add")).toBeEnabled();
    expect(screen.getAllByTestId("webhook-secret")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks" && init?.method === "POST")).toHaveLength(2);
  });

  it("suppresses duplicate and mixed same-row actions while another row remains independently usable", async () => {
    const firstRow = deferred<Response>();
    const secondRow = deferred<Response>();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(firstRow.promise)
      .mockReturnValueOnce(secondRow.promise)
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, { ...otherDisabledWebhook, active: true, failures: 0 }] }));
    render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));

    for (const control of [
      within(rows[0]).getByTestId("webhook-test"),
      within(rows[0]).getByTestId("webhook-enable"),
      within(rows[0]).getByTestId("webhook-delete"),
    ]) {
      fireEvent.click(control);
    }

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks/disabled-hook/test"]);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(within(rows[1]).getByTestId("webhook-enable")).toBeEnabled();

    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    const duplicateEnable = within(rows[1]).getByTestId("webhook-enable");
    duplicateEnable.removeAttribute("disabled");
    fireEvent.click(duplicateEnable);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/test",
      "/api/webhooks/other-disabled-hook/enable",
    ]);

    await act(async () => firstRow.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(within(screen.getAllByTestId("webhook-row")[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeDisabled();

    await act(async () => secondRow.resolve(response({ webhook: { ...otherDisabledWebhook, active: true, failures: 0 } })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeEnabled();
  });

  it.each([
    {
      label: "Test",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      failure: response({ error: "Test delivery refused" }, 502),
      reason: "Test delivery refused",
      success: response({ ok: true }),
      refreshed: [activeWebhook],
    },
    {
      label: "Enable",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      failure: response({ error: "Receiver is still unavailable" }, 409),
      reason: "Receiver is still unavailable",
      success: response({ webhook: { ...disabledWebhook, active: true, failures: 0 } }),
      refreshed: [{ ...disabledWebhook, active: true, failures: 0 }],
    },
    {
      label: "Delete",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      failure: null,
      reason: "Could not delete webhook",
      success: response({ ok: true }),
      refreshed: [],
    },
  ])("shows the $label reason and accepts an exact same-action retry", async ({ hook, control, actionUrl, failure, reason, success, refreshed }) => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock.mockResolvedValueOnce(response({ webhooks: [hook] }));
    if (failure) fetchMock.mockResolvedValueOnce(failure);
    else fetchMock.mockRejectedValueOnce("offline");
    fetchMock.mockResolvedValueOnce(success).mockResolvedValueOnce(response({ webhooks: refreshed }));
    render(<WebhooksPanel />);

    fireEvent.click(await screen.findByTestId(control));

    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent(reason);
    expect(screen.getByTestId(control)).toBeEnabled();

    fireEvent.click(screen.getByTestId(control));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(fetchMock.mock.calls.filter(([url]) => url === actionUrl)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks")).toHaveLength(2);
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
  });

  it("owns confirmed Delete once, clears its matching one-time secret, and refreshes once", async () => {
    const deletion = deferred<Response>();
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ webhook: { ...activeWebhook, secret: "whsec_delete_me" } }))
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook] }))
      .mockReturnValueOnce(deletion.promise)
      .mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: activeWebhook.url } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    await screen.findByTestId("webhook-row");
    expect(screen.getAllByTestId("webhook-secret")).toHaveLength(1);

    const deleteButton = screen.getByTestId("webhook-delete");
    fireEvent.click(deleteButton);
    deleteButton.removeAttribute("disabled");
    fireEvent.click(deleteButton);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks/active-hook" && init?.method === "DELETE")).toHaveLength(1);

    await act(async () => deletion.resolve(response({ ok: true })));

    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(screen.queryByTestId("webhook-created")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/webhooks" && !init?.method)).toHaveLength(3);
  });

  it("keeps newer feedback and row ownership isolated from an older settlement and finalizer", async () => {
    const olderAction = deferred<Response>();
    const newerAction = deferred<Response>();
    const newerRetry = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, { ...activeWebhook, id: "other-active-hook", url: "https://receiver.example/other" }] }))
      .mockReturnValueOnce(olderAction.promise)
      .mockReturnValueOnce(newerAction.promise)
      .mockReturnValueOnce(newerRetry.promise)
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, { ...activeWebhook, id: "other-active-hook", url: "https://receiver.example/other" }] }));
    render(<WebhooksPanel />);

    let rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-test"));

    await act(async () => newerAction.resolve(response({ error: "Newer action failed" }, 503)));
    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Newer action failed");
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-test")).toBeDisabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();

    await act(async () => olderAction.resolve(response({ error: "Older action failed" }, 503)));
    expect(screen.getByTestId("webhook-action-error")).toHaveTextContent("Newer action failed");
    rows = screen.getAllByTestId("webhook-row");
    expect(within(rows[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeEnabled();

    fireEvent.click(within(rows[1]).getByTestId("webhook-test"));
    expect(within(rows[0]).getByTestId("webhook-test")).toBeEnabled();
    expect(within(rows[1]).getByTestId("webhook-test")).toBeDisabled();

    await act(async () => newerRetry.resolve(response({ ok: true })));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeEnabled();
  });

  it("invalidates every owner on unmount and handles late action resolutions and rejections", async () => {
    const testAction = deferred<Response>();
    const enableAction = deferred<Response>();
    const createAction = deferred<Response>();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook, disabledWebhook] }))
      .mockReturnValueOnce(testAction.promise)
      .mockReturnValueOnce(enableAction.promise)
      .mockReturnValueOnce(createAction.promise);
    const view = render(<WebhooksPanel />);

    const rows = await screen.findAllByTestId("webhook-row");
    fireEvent.click(within(rows[0]).getByTestId("webhook-test"));
    fireEvent.click(within(rows[1]).getByTestId("webhook-enable"));
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/late" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    view.unmount();
    testAction.reject(new Error("late test rejection"));
    enableAction.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } }));
    createAction.resolve(response({ webhook: { ...activeWebhook, id: "late-created-hook", secret: "whsec_late" } }));
    await Promise.allSettled([testAction.promise, enableAction.promise, createAction.promise]);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});

describe("Settings → Webhooks: layout retirement", () => {
  it.each([
    {
      label: "success",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ webhooks: [disabledWebhook] })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired list failed" }, 503)),
    },
  ])("retires an initial list $label before replacing the card", async ({ settle }) => {
    const retiredList = deferred<Response>();
    const currentList = deferred<Response>();
    const currentAction = deferred<Response>();
    fetchMock.mockReturnValueOnce(retiredList.promise).mockReturnValueOnce(currentList.promise).mockReturnValueOnce(currentAction.promise);
    const view = render(<BoundaryHarness cardKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(<BoundaryHarness cardKey={2} boundary={1} onBoundary={() => settle(retiredList)} />);
    await act(async () => {
      await retiredList.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByTestId("webhooks-list-error")).toBeNull();
    expect(screen.queryByTestId("webhook-row")).toBeNull();

    await act(async () => currentList.resolve(response({ webhooks: [activeWebhook] })));
    const testButton = within(await screen.findByTestId("webhook-row")).getByTestId("webhook-test");
    fireEvent.click(testButton);
    expect(testButton).toBeDisabled();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks", "/api/webhooks/active-hook/test"]);

    await act(async () => currentAction.resolve(response({ error: "Current test failed" }, 503)));
    expect(await screen.findByTestId("webhook-action-error")).toHaveTextContent("Current test failed");
    expect(screen.getByTestId("webhook-test")).toBeEnabled();
  });

  it.each([
    {
      label: "success",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ webhooks: [activeWebhook] })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired Retry failed" }, 503)),
    },
  ])("retires a pending Retry $label without clearing the replacement Retry owner", async ({ settle }) => {
    const retiredRetry = deferred<Response>();
    const currentRetry = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ error: "Retired initial failure" }, 503))
      .mockReturnValueOnce(retiredRetry.promise)
      .mockResolvedValueOnce(response({ error: "Current initial failure" }, 503))
      .mockReturnValueOnce(currentRetry.promise);
    const view = render(<BoundaryHarness cardKey={1} />);

    fireEvent.click(within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" }));
    view.rerender(<BoundaryHarness cardKey={2} boundary={1} onBoundary={() => settle(retiredRetry)} />);
    await act(async () => {
      await Promise.allSettled([retiredRetry.promise]);
      await Promise.resolve();
    });

    const currentRetryButton = within(await screen.findByTestId("webhooks-list-error")).getByRole("button", { name: "Retry" });
    expect(screen.getByTestId("webhooks-list-error")).toHaveTextContent("Current initial failure");
    fireEvent.click(currentRetryButton);
    fireEvent.click(currentRetryButton);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    await act(async () => currentRetry.resolve(response({ webhooks: [] })));
    expect(await screen.findByTestId("webhooks-empty")).toHaveTextContent("No webhooks yet.");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/webhooks", "/api/webhooks", "/api/webhooks", "/api/webhooks"]);
  });

  it.each([
    {
      label: "success with a returned secret",
      settle: (pending: ReturnType<typeof deferred<Response>>) =>
        pending.resolve(response({ webhook: { ...activeWebhook, id: "retired-created-hook", secret: "whsec_retired" } })),
    },
    {
      label: "failure",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.reject(new Error("Retired create failed")),
    },
  ])("retires an Add $label at the removed-card boundary", async ({ settle }) => {
    const retiredCreate = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockReturnValueOnce(retiredCreate.promise)
      .mockResolvedValue(response({ webhooks: [activeWebhook] }));
    const view = render(<BoundaryHarness />);

    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/retired-create" } });
    fireEvent.submit(screen.getByTestId("webhook-form"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<BoundaryHarness present={false} boundary={1} onBoundary={() => settle(retiredCreate)} />);
    await act(async () => {
      await Promise.allSettled([retiredCreate.promise]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("webhooks-card")).toBeNull();
    expect(screen.queryByTestId("webhook-created")).toBeNull();
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "Test success",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ ok: true })),
    },
    {
      label: "Test failure",
      hook: activeWebhook,
      control: "webhook-test",
      actionUrl: "/api/webhooks/active-hook/test",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired test failed" }, 503)),
    },
    {
      label: "Enable success",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      settle: (pending: ReturnType<typeof deferred<Response>>) =>
        pending.resolve(response({ webhook: { ...disabledWebhook, active: true, failures: 0 } })),
    },
    {
      label: "Enable failure",
      hook: disabledWebhook,
      control: "webhook-enable",
      actionUrl: "/api/webhooks/disabled-hook/enable",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ error: "Retired enable failed" }, 503)),
    },
    {
      label: "Delete success",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.resolve(response({ ok: true })),
    },
    {
      label: "Delete failure",
      hook: activeWebhook,
      control: "webhook-delete",
      actionUrl: "/api/webhooks/active-hook",
      settle: (pending: ReturnType<typeof deferred<Response>>) => pending.reject(new Error("Retired delete failed")),
    },
  ])("retires a pending $label at the removed-card boundary", async ({ hook, control, actionUrl, settle }) => {
    const retiredAction = deferred<Response>();
    vi.stubGlobal("confirm", vi.fn(() => true));
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [hook] }))
      .mockReturnValueOnce(retiredAction.promise)
      .mockResolvedValue(response({ webhooks: [activeWebhook] }));
    const view = render(<BoundaryHarness />);

    fireEvent.click(await screen.findByTestId(control));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    view.rerender(<BoundaryHarness present={false} boundary={1} onBoundary={() => settle(retiredAction)} />);
    await act(async () => {
      await Promise.allSettled([retiredAction.promise]);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("webhooks-card")).toBeNull();
    expect(screen.queryByTestId("webhook-action-error")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === actionUrl)).toHaveLength(1);
  });
});

describe("Settings → Webhooks: exact committed controls", () => {
  it("rejects A handlers through B controls in both orders and ignores late A ref cleanup", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ webhooks: [] })));
    const view = render(<BoundaryHarness cardKey={1} />);
    await screen.findByTestId("webhooks-empty");

    const addA = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const clickA = reactProp<ClickHandler>(addA, "onClick");
    const refA = reactProp<RefCallback<HTMLButtonElement>>(addA, "ref");

    view.rerender(<BoundaryHarness cardKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByTestId("webhooks-empty");
    const addB = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const clickB = reactProp<ClickHandler>(addB, "onClick");

    act(() => {
      clickA(mouseEvent(addB));
      clickB(mouseEvent(addA));
      clickB(mouseEvent(addA));
      clickA(mouseEvent(addB));
      refA(null);
    });

    expect(screen.queryByTestId("webhook-form")).toBeNull();
    fireEvent.click(addB);
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
  });

  it("requires exact native mouse provenance for Add, Cancel, and Retry without retiring current controls", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: "Try again" }, 503))
      .mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-list-error");

    const add = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const clickAdd = reactProp<ClickHandler>(add, "onClick");
    invokeRejectedMouseProvenance(clickAdd, add);
    expect(screen.queryByTestId("webhook-form")).toBeNull();
    act(() => clickAdd(mouseEvent(add)));
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();

    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const clickCancel = reactProp<ClickHandler>(cancel, "onClick");
    invokeRejectedMouseProvenance(clickCancel, cancel);
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
    act(() => clickCancel(mouseEvent(cancel)));
    expect(screen.queryByTestId("webhook-form")).toBeNull();

    const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    const clickRetry = reactProp<ClickHandler>(retry, "onClick");
    invokeRejectedMouseProvenance(clickRetry, retry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => clickRetry(mouseEvent(retry)));
    expect(await screen.findByTestId("webhooks-empty")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires exact native mouse provenance for Enable and Send test without retiring current row controls", async () => {
    const enableRequest = deferred<Response>();
    const testRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, activeWebhook] }))
      .mockReturnValueOnce(enableRequest.promise)
      .mockReturnValueOnce(testRequest.promise);
    render(<WebhooksPanel />);
    const rows = await screen.findAllByTestId("webhook-row");

    const enable = within(rows[0]).getByTestId("webhook-enable") as HTMLButtonElement;
    const test = within(rows[1]).getByTestId("webhook-test") as HTMLButtonElement;
    const clickEnable = reactProp<ClickHandler>(enable, "onClick");
    const clickTest = reactProp<ClickHandler>(test, "onClick");
    invokeRejectedMouseProvenance(clickEnable, enable);
    invokeRejectedMouseProvenance(clickTest, test);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => clickEnable(mouseEvent(enable)));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const currentTest = screen.getAllByTestId("webhook-test")[1] as HTMLButtonElement;
    const clickCurrentTest = reactProp<ClickHandler>(currentTest, "onClick");
    act(() => clickCurrentTest(mouseEvent(currentTest)));
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/enable",
      "/api/webhooks/active-hook/test",
    ]);

    await act(async () => {
      enableRequest.resolve(response({ error: "Enable unavailable" }, 503));
      testRequest.resolve(response({ error: "Test unavailable" }, 503));
    });
    await waitFor(() => {
      expect(screen.getByTestId("webhook-enable")).toBeEnabled();
      expect(screen.getAllByTestId("webhook-test")[1]).toBeEnabled();
    });
  });

  describe("Settings → Webhooks: Escape cancellation", () => {
    function trackNativePrevention() {
      const nativePreventDefault = window.Event.prototype.preventDefault;
      return vi
        .spyOn(window.Event.prototype, "preventDefault")
        .mockImplementation(function (this: Event) {
          Reflect.apply(nativePreventDefault, this, []);
        });
    }

    it.each([
      ["URL field", "webhook-url"],
      ["document field", "webhook-docs"],
      ["event checkbox", "webhook-event-request.created"],
      ["form background", "webhook-form"],
    ])("cancels once from the current %s without starting other work", async (
      _label,
      targetId,
    ) => {
      const preventDefault = trackNativePrevention();
      const confirmMock = vi.fn(() => true);
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal("confirm", confirmMock);
      const navigatorWithClipboard = Object.create(window.navigator) as Navigator;
      Object.defineProperty(navigatorWithClipboard, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      vi.stubGlobal("navigator", navigatorWithClipboard);
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      const target = within(view.host).getByTestId(targetId) as HTMLElement;
      const escape = createDispatchedKeyboardEvent(target);
      target.focus();
      expect(target.ownerDocument.activeElement).toBe(target);
      const callsBeforeEscape = fetchMock.mock.calls.length;
      const locationBeforeEscape = window.location.href;

      fireEvent(target, escape);
      fireEvent(target, escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeEscape);
      expect(confirmMock).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(window.location.href).toBe(locationBeforeEscape);
    });

    it("rejects an untrusted owner dispatch and accepts the next trusted Escape", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      url.focus();
      const untrusted = dispatchKeyboardEvent(url, {}, false);

      expect(untrusted.isTrusted).toBe(false);
      expect(untrusted.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);

      const trusted = dispatchKeyboardEvent(url);
      expect(trusted.isTrusted).toBe(true);
      expect(trusted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("rejects trusted native key, modifier, composition, and dispatch-state drift", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const rejected: readonly (readonly [string, KeyboardEventInit])[] = [
        ["key", { key: "Enter", code: "Enter" }],
        ["code", { code: "KeyE" }],
        ["Alt", { altKey: true }],
        ["Control", { ctrlKey: true }],
        ["Meta", { metaKey: true }],
        ["Shift", { shiftKey: true }],
        ["repeat", { repeat: true }],
        ["composition", { isComposing: true }],
        ["bubbling", { bubbles: false }],
        ["cancelability", { cancelable: false }],
      ];
      url.focus();
      for (const [label, init] of rejected) {
        const event = dispatchKeyboardEvent(url, init);
        expect(event.defaultPrevented, label).toBe(false);
        expect(preventDefault, label).not.toHaveBeenCalled();
        expect(within(view.host).getByTestId("webhook-form"), label).toBe(form);
      }

      const prevented = createDispatchedKeyboardEvent(url);
      prevented.preventDefault();
      preventDefault.mockClear();
      fireEvent(url, prevented);
      expect(prevented.defaultPrevented).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);

      const accepted = dispatchKeyboardEvent(url);
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("uses captured native methods and focus getter instead of replaced public values", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const docs = within(view.host).getByTestId("webhook-docs") as HTMLInputElement;
      const event = createDispatchedKeyboardEvent(url);
      const publicPath = vi.fn(() => [docs]);
      const publicPreventDefault = vi.fn();
      const publicActiveElement = vi.fn(() => docs);
      Object.defineProperties(event, {
        composedPath: { configurable: true, value: publicPath },
        preventDefault: { configurable: true, value: publicPreventDefault },
      });
      url.focus();
      Object.defineProperty(document, "activeElement", {
        configurable: true,
        get: publicActiveElement,
      });
      try {
        fireEvent(url, event);
      } finally {
        Reflect.deleteProperty(document, "activeElement");
      }

      expect(publicPath).not.toHaveBeenCalled();
      expect(publicPreventDefault).not.toHaveBeenCalled();
      expect(publicActiveElement).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
      expect(form.isConnected).toBe(false);
    });

    it("rejects changed native descriptors before accepting after restoration", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(
        window.KeyboardEvent.prototype,
        "key",
      );
      if (!descriptor?.get) {
        throw new Error("KeyboardEvent.key has no native getter");
      }
      url.focus();
      Object.defineProperty(window.KeyboardEvent.prototype, "key", {
        ...descriptor,
        get: () => "Enter",
      });
      try {
        const rejected = dispatchKeyboardEvent(url);
        expect(rejected.defaultPrevented).toBe(false);
      } finally {
        Object.defineProperty(
          window.KeyboardEvent.prototype,
          "key",
          descriptor,
        );
      }

      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);
      const accepted = dispatchKeyboardEvent(url);
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("rejects changed React identity, parity fields, and predicates without poisoning recovery", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const docs = within(view.host).getByTestId("webhook-docs") as HTMLInputElement;
      const replace = (
        event: ReactKeyboardEvent<HTMLFormElement>,
        name: PropertyKey,
        value: unknown,
      ) => {
        Object.defineProperty(event, name, {
          configurable: true,
          writable: true,
          value,
        });
      };
      const mutations: Array<
        readonly [
          string,
          (event: ReactKeyboardEvent<HTMLFormElement>) => void,
        ]
      > = [
        ["React name", (event) => replace(event, "_reactName", "onKeyUp")],
        ["native identity", (event) => replace(
          event,
          "nativeEvent",
          new window.KeyboardEvent("keydown"),
        )],
        ["trust", (event) => replace(event, "isTrusted", false)],
        ["key", (event) => replace(event, "key", "Enter")],
        ["code", (event) => replace(event, "code", "Enter")],
        ["modifier", (event) => replace(event, "altKey", true)],
        ["repeat", (event) => replace(event, "repeat", true)],
        ["composition", (event) => replace(event, "isComposing", true)],
        ["target", (event) => replace(event, "target", docs)],
        ["current target", (event) => replace(event, "currentTarget", docs)],
        ["phase", (event) => replace(event, "eventPhase", Event.NONE)],
        ["view", (event) => replace(event, "view", null)],
        ["bubbling", (event) => replace(event, "bubbles", false)],
        ["cancelability", (event) => replace(event, "cancelable", false)],
        ["default prevention field", (event) =>
          replace(event, "defaultPrevented", true)],
        ["default prevention predicate", (event) =>
          replace(event, "isDefaultPrevented", () => true)],
        ["propagation predicate", (event) =>
          replace(event, "isPropagationStopped", () => true)],
        ["persistence method", (event) =>
          replace(event, "persist", undefined)],
        ["persistence predicate", (event) =>
          replace(event, "isPersistent", () => false)],
      ];

      url.focus();
      for (const [label, mutate] of mutations) {
        const calls = preventDefault.mock.calls.length;
        const rejected = dispatchKeyboardWithReactMutation(
          form,
          url,
          mutate,
        );
        expect(rejected.defaultPrevented, label).toBe(false);
        expect(preventDefault.mock.calls.length, label).toBe(calls);
        expect(within(view.host).getByTestId("webhook-form"), label).toBe(form);
      }

      const accepted = dispatchKeyboardEvent(url);
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("claims before prevention, removes one form, and rejects prevention reentry", async () => {
      const nativePreventDefault = window.Event.prototype.preventDefault;
      let keyDown: KeyDownHandler | null = null;
      let reactEvent: ReactKeyboardEvent<HTMLFormElement> | null = null;
      const preventDefault = vi
        .spyOn(window.Event.prototype, "preventDefault")
        .mockImplementation(function (this: Event) {
          if (keyDown && reactEvent) keyDown(reactEvent);
          Reflect.apply(nativePreventDefault, this, []);
        });
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const card = within(view.host).getByTestId("webhooks-card");
      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const currentKeyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      keyDown = currentKeyDown;
      const removedForms: Node[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          removedForms.push(
            ...[...record.removedNodes].filter(
              (node) => node === form,
            ),
          );
        }
      });
      observer.observe(card, { childList: true });
      url.focus();

      dispatchKeyboardWithReactMutation(form, url, (event) => {
        reactEvent = event;
      });
      await settle();
      observer.disconnect();

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(removedForms).toEqual([form]);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("preserves the current draft and action error exactly like Cancel", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation((url, init) =>
        url === "/api/webhooks" && init?.method === "POST"
          ? Promise.resolve(response({ error: "Receiver rejected this draft" }, 422))
          : Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      fireEvent.change(within(view.host).getByTestId("webhook-url"), {
        target: { value: "https://receiver.example/escape-draft" },
      });
      fireEvent.change(within(view.host).getByTestId("webhook-docs"), {
        target: { value: "doc-escape" },
      });
      fireEvent.click(within(view.host).getByTestId("webhook-event-content.changed"));
      fireEvent.click(within(view.host).getByTestId("webhook-create"));
      expect(await within(view.host).findByTestId("webhook-action-error"))
        .toHaveTextContent("Receiver rejected this draft");
      await settle();

      const docs = within(view.host).getByTestId("webhook-docs") as HTMLInputElement;
      const callsBeforeEscape = fetchMock.mock.calls.length;
      docs.focus();
      preventDefault.mockClear();
      dispatchKeyboardEvent(docs);

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeEscape);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
      expect(within(view.host).getByTestId("webhook-action-error"))
        .toHaveTextContent("Receiver rejected this draft");

      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      expect(within(view.host).getByTestId("webhook-url"))
        .toHaveValue("https://receiver.example/escape-draft");
      expect(within(view.host).getByTestId("webhook-docs"))
        .toHaveValue("doc-escape");
      expect(within(view.host).getByTestId("webhook-event-content.changed"))
        .toBeChecked();
    });

    it("is inert while Create owns the form", async () => {
      const preventDefault = trackNativePrevention();
      const create = deferred<Response>();
      let created = false;
      fetchMock.mockImplementation((url, init) => {
        if (url === "/api/webhooks" && init?.method === "POST") {
          return create.promise;
        }
        return Promise.resolve(response({
          webhooks: created ? [activeWebhook] : [],
        }));
      });
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      fireEvent.change(within(view.host).getByTestId("webhook-url"), {
        target: { value: activeWebhook.url },
      });
      fireEvent.click(within(view.host).getByTestId("webhook-create"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      expect(form).toHaveAttribute("aria-busy", "true");
      form.focus();
      preventDefault.mockClear();
      const escape = createDispatchedKeyboardEvent(form);
      const requestsAtEscape = fetchMock.mock.calls.length;
      fireEvent(form, escape);

      expect(preventDefault).not.toHaveBeenCalled();
      expect(escape.defaultPrevented).toBe(false);
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);
      expect(fetchMock).toHaveBeenCalledTimes(requestsAtEscape);

      created = true;
      await act(async () => create.resolve(response({
        webhook: { ...activeWebhook, secret: "whsec_escape_pending" },
      })));
      expect(await within(view.host).findByText(activeWebhook.url)).toBeInTheDocument();
    });

    it("rejects every ineligible key and event provenance without poisoning the current form", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const docs = within(view.host).getByTestId("webhook-docs") as HTMLInputElement;
      const add = within(view.host).getByTestId("webhook-add") as HTMLButtonElement;
      const keyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      const iframe = document.createElement("iframe");
      const foreignForm = document.createElement("form");
      foreignRoot.append(iframe, foreignForm);
      const foreignWindow = iframe.contentWindow;
      const foreignRealm = foreignWindow?.document.defaultView;
      if (!foreignWindow || foreignRealm !== foreignWindow) {
        throw new Error("The foreign document has no current window");
      }
      const foreignKeyboardEvent = foreignRealm.KeyboardEvent;

      const rejected: Array<{
        label: string;
        target: HTMLElement;
        make: () => ReturnType<typeof keyboardEvent>;
        focus?: HTMLElement;
        prepare?: (candidate: ReturnType<typeof keyboardEvent>) => void;
      }> = [
        { label: "Alt", target: url, make: () => keyboardEvent(form, url, { altKey: true }) },
        { label: "Control", target: url, make: () => keyboardEvent(form, url, { ctrlKey: true }) },
        { label: "Meta", target: url, make: () => keyboardEvent(form, url, { metaKey: true }) },
        { label: "Shift", target: url, make: () => keyboardEvent(form, url, { shiftKey: true }) },
        { label: "repeat", target: url, make: () => keyboardEvent(form, url, { repeat: true }) },
        { label: "composition", target: url, make: () => keyboardEvent(form, url, { isComposing: true }) },
        { label: "non-bubbling wrapper", target: url, make: () => keyboardEvent(form, url, { bubbles: false, nativeBubbles: true }) },
        { label: "non-bubbling native event", target: url, make: () => keyboardEvent(form, url, { nativeBubbles: false }) },
        { label: "non-cancelable wrapper", target: url, make: () => keyboardEvent(form, url, { cancelable: false, nativeCancelable: true }) },
        { label: "non-cancelable native event", target: url, make: () => keyboardEvent(form, url, { nativeCancelable: false }) },
        { label: "prevented wrapper", target: url, make: () => keyboardEvent(form, url, { defaultPrevented: true }) },
        {
          label: "prevented native event",
          target: url,
          make: () => keyboardEvent(form, url),
          prepare: (candidate) => candidate.nativeEvent.preventDefault(),
        },
        { label: "stopped wrapper", target: url, make: () => keyboardEvent(form, url, { propagationStopped: true }) },
        {
          label: "stopped native event",
          target: url,
          make: () => keyboardEvent(form, url),
          prepare: (candidate) => Object.defineProperty(candidate.nativeEvent, "cancelBubble", {
            configurable: true,
            value: true,
          }),
        },
        { label: "wrong React type", target: url, make: () => keyboardEvent(form, url, { wrapperType: "keyup" }) },
        { label: "wrong native type", target: url, make: () => keyboardEvent(form, url, { nativeType: "keyup" }) },
        { label: "other key", target: url, make: () => keyboardEvent(form, url, { key: "Tab", code: "Tab" }) },
        { label: "Space", target: url, make: () => keyboardEvent(form, url, { key: " ", code: "Space" }) },
        { label: "Enter", target: url, make: () => keyboardEvent(form, url, { key: "Enter", code: "Enter" }) },
        { label: "wrong code", target: url, make: () => keyboardEvent(form, url, { code: "KeyE" }) },
        { label: "crossed native key", target: url, make: () => keyboardEvent(form, url, { nativeKey: "Enter" }) },
        { label: "crossed native code", target: url, make: () => keyboardEvent(form, url, { nativeCode: "Enter" }) },
        { label: "crossed native modifier", target: url, make: () => keyboardEvent(form, url, { nativeAltKey: true }) },
        { label: "crossed native repeat", target: url, make: () => keyboardEvent(form, url, { nativeRepeat: true }) },
        { label: "undispatched event", target: url, make: () => keyboardEvent(form, url, { eventPhase: Event.NONE }) },
        {
          label: "foreign event realm",
          target: url,
          make: () => keyboardEvent(form, url, { KeyboardEventType: foreignKeyboardEvent }),
        },
        { label: "outside target", target: add, make: () => keyboardEvent(form, add) },
        {
          label: "crossed native target",
          target: url,
          make: () => keyboardEvent(form, url, { nativeTarget: docs }),
        },
        {
          label: "wrong current form",
          target: url,
          make: () => keyboardEvent(foreignForm, url),
        },
        {
          label: "unfocused target",
          target: url,
          focus: docs,
          make: () => keyboardEvent(form, url),
        },
        {
          label: "non-keyboard native event",
          target: url,
          make: () => {
            const candidate = keyboardEvent(form, url);
            Object.defineProperty(candidate.event, "nativeEvent", {
              configurable: true,
              value: new window.Event("keydown", {
                bubbles: true,
                cancelable: true,
              }),
            });
            return candidate;
          },
        },
      ];

      for (const candidate of rejected) {
        const value = candidate.make();
        candidate.prepare?.(value);
        (candidate.focus ?? candidate.target).focus();
        const preventionCalls = preventDefault.mock.calls.length;
        const requestCalls = fetchMock.mock.calls.length;
        act(() => keyDown(value.event));
        expect(
          preventDefault.mock.calls.length,
          `${candidate.label} prevention`,
        ).toBe(preventionCalls);
        expect(value.preventDefault, `${candidate.label} React prevention`)
          .not.toHaveBeenCalled();
        expect(fetchMock.mock.calls.length, `${candidate.label} requests`)
          .toBe(requestCalls);
        expect(within(view.host).getByTestId("webhook-form"), candidate.label)
          .toBe(form);
      }

      url.focus();
      const callsBeforeExact = preventDefault.mock.calls.length;
      dispatchKeyboardEvent(url);
      expect(preventDefault).toHaveBeenCalledTimes(callsBeforeExact + 1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
      iframe.remove();
      foreignForm.remove();
    });

    it("rejects a stale draft handler and admits only its current successor", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const staleKeyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      fireEvent.change(url, {
        target: { value: "https://receiver.example/current-draft" },
      });
      await settle();
      url.focus();
      const staleEscape = keyboardEvent(form, url);
      act(() => staleKeyDown(staleEscape.event));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);

      const currentKeyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      expect(currentKeyDown).not.toBe(staleKeyDown);
      dispatchKeyboardEvent(url);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it.each([
      "detach and restore the form",
      "detach and restore a control",
      "replace and restore a control",
      "reorder and restore the form",
    ] as const)("permanently rejects restored DOM history after %s and recovers on a keyed mount", async (history) => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(
        <StrictMode><BoundaryHarness cardKey={1} /></StrictMode>,
      );
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const card = within(view.host).getByTestId("webhooks-card");
      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const keyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      if (history === "detach and restore the form") {
        const next = form.nextSibling;
        form.remove();
        card.insertBefore(form, next);
      } else if (history === "detach and restore a control") {
        const parent = url.parentNode;
        const next = url.nextSibling;
        if (!parent) throw new Error("The URL input had no parent");
        url.remove();
        parent.insertBefore(url, next);
      } else if (history === "replace and restore a control") {
        const replacement = url.cloneNode(true);
        const ownerWindow = url.ownerDocument.defaultView;
        if (
          !ownerWindow ||
          !(replacement instanceof ownerWindow.HTMLInputElement)
        ) {
          throw new Error("The cloned URL control was not an input");
        }
        url.replaceWith(replacement);
        replacement.replaceWith(url);
      } else {
        const next = form.nextSibling;
        card.append(form);
        card.insertBefore(form, next);
      }
      url.focus();
      const restoredEscape = keyboardEvent(form, url);
      act(() => keyDown(restoredEscape.event));

      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);

      act(() => view.root.render(
        <StrictMode><BoundaryHarness cardKey={2} /></StrictMode>,
      ));
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      const currentUrl = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      currentUrl.focus();
      dispatchKeyboardEvent(currentUrl);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it.each([
      "form-only ref replay",
      "all-ref replay without layout replay",
    ] as const)("rejects a manual %s and lets a complete keyed successor recover", async (replay) => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(
        <StrictMode><BoundaryHarness cardKey={1} /></StrictMode>,
      );
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));

      const card = within(view.host).getByTestId("webhooks-card");
      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const keyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      const bindings = [card, ...card.querySelectorAll<HTMLElement>("*")]
        .flatMap((element) => {
          const ref = optionalReactProp<RefCallback<HTMLElement>>(element, "ref");
          return ref ? [{ element, ref }] : [];
        });
      act(() => {
        if (replay === "form-only ref replay") {
          const formRef = reactProp<RefCallback<HTMLFormElement>>(form, "ref");
          formRef(null);
          formRef(form);
        } else {
          bindings.forEach(({ ref }) => ref(null));
          [...bindings].reverse().forEach(({ element, ref }) => ref(element));
        }
      });
      url.focus();
      act(() => keyDown(keyboardEvent(form, url).event));
      expect(preventDefault).not.toHaveBeenCalled();
      expect(within(view.host).getByTestId("webhook-form")).toBe(form);

      act(() => view.root.render(
        <StrictMode><BoundaryHarness cardKey={2} /></StrictMode>,
      ));
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      const successorChoice = within(view.host)
        .getByTestId("webhook-event-request.created") as HTMLInputElement;
      successorChoice.focus();
      dispatchKeyboardEvent(successorChoice);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(view.host).queryByTestId("webhook-form")).toBeNull();
    });

    it("releases a removed form's authority and leaves a fresh Strict root usable", async () => {
      const preventDefault = trackNativePrevention();
      fetchMock.mockImplementation(() =>
        Promise.resolve(response({ webhooks: [] })));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(view.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(view.host).getByTestId("webhook-add"));
      const form = within(view.host).getByTestId("webhook-form") as HTMLFormElement;
      const url = within(view.host).getByTestId("webhook-url") as HTMLInputElement;
      const staleKeyDown = reactProp<KeyDownHandler>(form, "onKeyDown");
      const staleEscape = keyboardEvent(form, url);
      const callsAtUnmount = fetchMock.mock.calls.length;

      act(() => view.root.unmount());
      act(() => staleKeyDown(staleEscape.event));
      await settle();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(callsAtUnmount);
      expect(view.host).toBeEmptyDOMElement();

      const successor = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      await within(successor.host).findByTestId("webhooks-empty");
      await settle();
      fireEvent.click(within(successor.host).getByTestId("webhook-add"));
      const successorForm = within(successor.host)
        .getByTestId("webhook-form") as HTMLFormElement;
      successorForm.focus();
      dispatchKeyboardEvent(successorForm);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(within(successor.host).queryByTestId("webhook-form")).toBeNull();
    });
  });

  describe("Settings → Webhooks: direct-root Strict Mode replay", () => {
    it("retires the first publication and keeps Add, draft, Cancel, Create, and Copy exact", async () => {
      const createdWebhook = {
        ...activeWebhook,
        id: "strict-created",
        url: "https://receiver.example/strict-created",
      };
      let hooks = [] as typeof activeWebhook[];
      fetchMock.mockImplementation(async (url, init) => {
        if (url === "/api/webhooks" && init?.method === "POST") {
          hooks = [createdWebhook];
          return response({ webhook: { ...createdWebhook, secret: "whsec_strict" } });
        }
        return response({ webhooks: hooks });
      });
      let copyHandler: ClickHandler | null = null;
      let copyEvent: ReactMouseEvent<HTMLButtonElement> | null = null;
      const writeText = vi.fn(() => {
        if (copyHandler && copyEvent) copyHandler(copyEvent);
        return Promise.resolve();
      });
      const navigatorWithClipboard = Object.create(window.navigator) as Navigator;
      Object.defineProperty(navigatorWithClipboard, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      vi.stubGlobal("navigator", navigatorWithClipboard);

      let retiredAdd: ClickHandler | null = null;
      let retiredAddRef: RefCallback<HTMLButtonElement> | null = null;
      let retiredBindings: Array<{
        element: HTMLElement;
        ref: RefCallback<HTMLElement>;
      }> = [];
      const captureFirstLayout = () => {
        if (retiredAdd) return;
        const card = document.querySelector<HTMLElement>('[data-testid="webhooks-card"]');
        const add = document.querySelector<HTMLButtonElement>('[data-testid="webhook-add"]');
        if (!card || !add) throw new Error("The first Strict Mode publication was not rendered");
        retiredAdd = reactProp<ClickHandler>(add, "onClick");
        retiredAddRef = reactProp<RefCallback<HTMLButtonElement>>(add, "ref");
        retiredBindings = [card, ...card.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
          const ref = optionalReactProp<RefCallback<HTMLElement>>(element, "ref");
          return ref ? [{ element, ref }] : [];
        });
      };
      renderDirect(
        <StrictMode>
          <LayoutProbe onLayout={captureFirstLayout}>
            <WebhooksPanel />
          </LayoutProbe>
        </StrictMode>,
      );
      await screen.findByTestId("webhooks-empty");
      await settle();

      const add = screen.getByTestId("webhook-add") as HTMLButtonElement;
      const currentAdd = reactProp<ClickHandler>(add, "onClick");
      const currentAddRef = reactProp<RefCallback<HTMLButtonElement>>(add, "ref");
      expect(currentAdd).not.toBe(retiredAdd);
      expect(currentAddRef).not.toBe(retiredAddRef);
      act(() => {
        retiredBindings.forEach(({ element, ref }) => ref(element));
        [...retiredBindings].reverse().forEach(({ ref }) => ref(null));
        const event = mouseEvent(add);
        retiredAdd?.(event);
        currentAdd(event);
        currentAdd(event);
      });
      expect(screen.getByTestId("webhook-form")).toBeInTheDocument();

      const url = screen.getByTestId("webhook-url") as HTMLInputElement;
      url.value = createdWebhook.url;
      const changeUrl = reactProp<InputChangeHandler>(url, "onChange");
      const urlEvent = inputEvent(url);
      act(() => {
        changeUrl(urlEvent);
        changeUrl(urlEvent);
      });
      expect(url).toHaveValue(createdWebhook.url);

      const docs = screen.getByTestId("webhook-docs") as HTMLInputElement;
      docs.value = "doc-strict";
      const changeDocs = reactProp<InputChangeHandler>(docs, "onChange");
      const docsEvent = inputEvent(docs);
      act(() => {
        changeDocs(docsEvent);
        changeDocs(docsEvent);
      });
      expect(docs).toHaveValue("doc-strict");

      const choice = screen.getByTestId("webhook-event-content.changed") as HTMLInputElement;
      choice.checked = true;
      const changeChoice = reactProp<InputChangeHandler>(choice, "onChange");
      const choiceEvent = inputEvent(choice);
      act(() => {
        changeChoice(choiceEvent);
        changeChoice(choiceEvent);
      });
      expect(choice).toBeChecked();

      const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      const clickCancel = reactProp<ClickHandler>(cancel, "onClick");
      const cancelEvent = mouseEvent(cancel);
      act(() => {
        clickCancel(cancelEvent);
        clickCancel(cancelEvent);
      });
      expect(screen.queryByTestId("webhook-form")).toBeNull();

      fireEvent.click(screen.getByTestId("webhook-add"));
      fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: createdWebhook.url } });
      const form = screen.getByTestId("webhook-form") as HTMLFormElement;
      const create = screen.getByTestId("webhook-create") as HTMLButtonElement;
      const submit = reactProp<SubmitHandler>(form, "onSubmit");
      const exactSubmit = submitEvent(form, form, form, create);
      act(() => {
        submit(exactSubmit.event);
        submit(exactSubmit.event);
      });
      expect(exactSubmit.preventDefault).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

      const created = await screen.findByTestId("webhook-created");
      await settle();
      const copy = within(created).getByRole("button", { name: "Copy secret" }) as HTMLButtonElement;
      copyHandler = reactProp<ClickHandler>(copy, "onClick");
      copyEvent = mouseEvent(copy);
      act(() => {
        copyHandler?.(copyEvent!);
        copyHandler?.(copyEvent!);
      });
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith("whsec_strict");
      expect(await screen.findByTestId("webhook-row")).toHaveTextContent(createdWebhook.url);
    });

    it("keeps Retry, Enable, Test, and Delete single-owner after Strict Mode replay", async () => {
      let recover = false;
      const requestUrls: string[] = [];
      fetchMock.mockImplementation(async (url, init) => {
        requestUrls.push(String(url));
        if (url === "/api/webhooks") {
          return recover
            ? response({ webhooks: [disabledWebhook, activeWebhook] })
            : response({ error: "Strict retry required" }, 503);
        }
        if (init?.method === "DELETE") return response({ ok: true });
        return response({ webhook: activeWebhook });
      });
      vi.stubGlobal("confirm", vi.fn(() => true));
      renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);

      const retry = within(await screen.findByTestId("webhooks-list-error"))
        .getByRole("button", { name: "Retry" }) as HTMLButtonElement;
      await settle();
      const retryHandler = reactProp<ClickHandler>(retry, "onClick");
      const retryEvent = mouseEvent(retry);
      const requestsBeforeRetry = requestUrls.length;
      recover = true;
      act(() => {
        retryHandler(retryEvent);
        retryHandler(retryEvent);
      });
      await screen.findAllByTestId("webhook-row");
      await settle();
      expect(requestUrls).toHaveLength(requestsBeforeRetry + 1);

      let rows = screen.getAllByTestId("webhook-row");
      const enable = within(rows[0]).getByTestId("webhook-enable") as HTMLButtonElement;
      const enableHandler = reactProp<ClickHandler>(enable, "onClick");
      const enableEvent = mouseEvent(enable);
      act(() => {
        enableHandler(enableEvent);
        enableHandler(enableEvent);
      });
      expect(requestUrls.filter((url) => url.endsWith("/disabled-hook/enable"))).toHaveLength(1);
      await waitFor(() => expect(requestUrls.filter((url) => url === "/api/webhooks").length).toBeGreaterThan(requestsBeforeRetry + 1));
      await settle();

      rows = screen.getAllByTestId("webhook-row");
      const test = within(rows[1]).getByTestId("webhook-test") as HTMLButtonElement;
      const testHandler = reactProp<ClickHandler>(test, "onClick");
      const testEvent = mouseEvent(test);
      act(() => {
        testHandler(testEvent);
        testHandler(testEvent);
      });
      expect(requestUrls.filter((url) => url.endsWith("/active-hook/test"))).toHaveLength(1);
      await waitFor(() => expect(within(screen.getAllByTestId("webhook-row")[1]).getByTestId("webhook-test")).toBeEnabled());
      await settle();

      rows = screen.getAllByTestId("webhook-row");
      const deleteButton = within(rows[1]).getByTestId("webhook-delete") as HTMLButtonElement;
      const deleteHandler = reactProp<ClickHandler>(deleteButton, "onClick");
      const deleteEvent = mouseEvent(deleteButton);
      act(() => {
        deleteHandler(deleteEvent);
        deleteHandler(deleteEvent);
      });
      expect(confirm).toHaveBeenCalledOnce();
      expect(requestUrls.filter((url) => url.endsWith("/active-hook"))).toHaveLength(1);
    });

    it.each([
      "partial replay",
      "detach and reinsert",
      "replace and restore",
      "reorder and restore",
      "mutate and restore",
    ] as const)("permanently rejects a Strict Mode publication after %s history", async (history) => {
      fetchMock.mockImplementation(async () => response({ webhooks: [activeWebhook] }));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      const card = await screen.findByTestId("webhooks-card") as HTMLDivElement;
      await screen.findByTestId("webhook-row");
      await settle();
      const test = screen.getByTestId("webhook-test") as HTMLButtonElement;
      const testHandler = reactProp<ClickHandler>(test, "onClick");

      if (history === "partial replay") {
        const cardRef = reactProp<RefCallback<HTMLDivElement>>(card, "ref");
        act(() => {
          cardRef(null);
          cardRef(card);
        });
      } else if (history === "detach and reinsert") {
        const next = card.nextSibling;
        card.remove();
        view.host.insertBefore(card, next);
      } else if (history === "replace and restore") {
        const replacement = test.cloneNode(true) as HTMLButtonElement;
        test.replaceWith(replacement);
        replacement.replaceWith(test);
      } else if (history === "reorder and restore") {
        const parent = test.parentNode;
        const next = test.nextSibling;
        if (!parent) throw new Error("The Test control had no parent");
        parent.appendChild(test);
        parent.insertBefore(test, next);
      } else {
        test.setAttribute("aria-label", "Changed and restored");
        test.removeAttribute("aria-label");
      }

      const event = mouseEvent(test);
      act(() => {
        testHandler(event);
        testHandler(event);
      });
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks/active-hook/test")).toHaveLength(0);
    });

    it.each(["immediate parent", "higher ancestor"] as const)(
      "rejects a control after its restored %s placement history",
      async (placement) => {
        fetchMock.mockImplementation(async () => response({ webhooks: [activeWebhook] }));
        const view = renderDirect(
          <StrictMode>
            <section data-testid="webhook-outer">
              <div data-testid="webhook-parent">
                <WebhooksPanel />
              </div>
            </section>
          </StrictMode>,
        );
        const test = await within(view.host).findByTestId("webhook-test") as HTMLButtonElement;
        await settle();
        const testHandler = reactProp<ClickHandler>(test, "onClick");
        const outer = within(view.host).getByTestId("webhook-outer");
        const parent = within(view.host).getByTestId("webhook-parent");
        const moved = placement === "immediate parent" ? parent : outer;
        const owner = moved.parentNode;
        const next = moved.nextSibling;
        if (!owner) throw new Error("The moved webhook ancestor had no parent");
        moved.remove();
        owner.insertBefore(moved, next);

        act(() => testHandler(mouseEvent(test)));
        expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks/active-hook/test")).toHaveLength(0);
      },
    );

    it("ignores nonadjacent subtree activity without poisoning the current control", async () => {
      const action = deferred<Response>();
      fetchMock.mockImplementation(async (url) =>
        url === "/api/webhooks/active-hook/test"
          ? action.promise
          : response({ webhooks: [activeWebhook] }));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      const test = await within(view.host).findByTestId("webhook-test") as HTMLButtonElement;
      await settle();
      const transient = document.createElement("span");
      foreignRoot.append(transient);
      transient.remove();

      act(() => reactProp<ClickHandler>(test, "onClick")(mouseEvent(test)));
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks/active-hook/test")).toHaveLength(1);
    });

    it("disconnects an interrupted replay observer without touching another panel", async () => {
      const NativeMutationObserver = window.MutationObserver;
      const instances: TrackingMutationObserver[] = [];
      class TrackingMutationObserver implements MutationObserver {
        readonly #observer: MutationObserver;
        readonly disconnect = vi.fn(() => this.#observer.disconnect());

        constructor(callback: MutationCallback) {
          this.#observer = new NativeMutationObserver((records) => callback(records, this));
          instances.push(this);
        }

        observe(target: Node, options?: MutationObserverInit) {
          this.#observer.observe(target, options);
        }

        takeRecords() {
          return this.#observer.takeRecords();
        }
      }
      vi.stubGlobal("MutationObserver", TrackingMutationObserver);
      fetchMock.mockImplementation(async () => response({ webhooks: [activeWebhook] }));
      const firstHost = document.createElement("div");
      const secondHost = document.createElement("div");
      document.body.append(firstHost, secondHost);
      const first = { host: firstHost, root: createRoot(firstHost) };
      const second = { host: secondHost, root: createRoot(secondHost) };
      directViews.push(first, second);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      let layoutCount = 0;
      const interruptReplay = () => {
        layoutCount += 1;
        if (layoutCount === 2) throw new Error("Interrupt webhook replay");
      };
      act(() => {
        first.root.render(
          <StrictMode>
            <TestErrorBoundary>
              <LayoutProbe onLayout={interruptReplay}>
                <WebhooksPanel />
              </LayoutProbe>
            </TestErrorBoundary>
          </StrictMode>,
        );
      });
      await within(first.host).findByTestId("strict-replay-error");
      await settle();
      expect(instances.length).toBeGreaterThan(0);
      expect(instances.every((instance) => instance.disconnect.mock.calls.length === 1)).toBe(true);

      act(() => second.root.render(<StrictMode><WebhooksPanel /></StrictMode>));
      const secondTest = await within(second.host).findByTestId("webhook-test") as HTMLButtonElement;
      await settle();
      act(() => reactProp<ClickHandler>(secondTest, "onClick")(mouseEvent(secondTest)));
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/webhooks/active-hook/test")).toHaveLength(1);
      act(() => second.root.unmount());
      await settle();
      expect(instances.every((instance) => instance.disconnect.mock.calls.length === 1)).toBe(true);
    });

    it("ignores stale controls and pending settlements after a direct Strict Mode unmount", async () => {
      const action = deferred<Response>();
      fetchMock.mockImplementation(async (url) =>
        url === "/api/webhooks/active-hook/test"
          ? action.promise
          : response({ webhooks: [activeWebhook] }));
      const view = renderDirect(<StrictMode><WebhooksPanel /></StrictMode>);
      const test = await screen.findByTestId("webhook-test") as HTMLButtonElement;
      await settle();
      const testHandler = reactProp<ClickHandler>(test, "onClick");
      const testEvent = mouseEvent(test);
      act(() => testHandler(testEvent));
      const callsAtUnmount = fetchMock.mock.calls.length;

      act(() => view.root.unmount());
      act(() => testHandler(testEvent));
      await act(async () => action.resolve(response({ ok: true })));
      await settle();

      expect(view.host).toBeEmptyDOMElement();
      expect(fetchMock).toHaveBeenCalledTimes(callsAtUnmount);
    });
  });

  it("requires exact native mouse provenance for Copy and Delete while accepting published icon targets", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const navigatorWithClipboard = Object.create(window.navigator) as Navigator;
    Object.defineProperty(navigatorWithClipboard, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("navigator", navigatorWithClipboard);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const createdWebhook = {
      ...activeWebhook,
      id: "created-hook",
      url: "https://receiver.example/created",
    };
    const deletion = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [activeWebhook] }))
      .mockResolvedValueOnce(response({ webhook: { ...createdWebhook, secret: "whsec_provenance" } }))
      .mockResolvedValueOnce(response({ webhooks: [createdWebhook] }))
      .mockReturnValueOnce(deletion.promise);
    render(<WebhooksPanel />);
    await screen.findByTestId("webhook-row");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: createdWebhook.url } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    const createdRoot = await screen.findByTestId("webhook-created");
    const copyButton = within(createdRoot).getByRole("button", { name: "Copy secret" }) as HTMLButtonElement;
    const copy = reactProp<ClickHandler>(copyButton, "onClick");
    invokeRejectedMouseProvenance(copy, copyButton);
    expect(writeText).not.toHaveBeenCalled();
    const copyIcon = copyButton.querySelector("svg");
    if (!copyIcon) throw new Error("The published Copy icon was not rendered");
    act(() => copy(mouseEvent(copyButton, { target: copyIcon })));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("whsec_provenance");

    const rowUrl = await screen.findByText(createdWebhook.url);
    const row = rowUrl.closest('[data-testid="webhook-row"]');
    if (!row) throw new Error("The created webhook row was not rendered");
    const deleteButton = within(row as HTMLElement).getByTestId("webhook-delete") as HTMLButtonElement;
    const clickDelete = reactProp<ClickHandler>(deleteButton, "onClick");
    invokeRejectedMouseProvenance(clickDelete, deleteButton);
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const deleteIcon = deleteButton.querySelector("svg");
    if (!deleteIcon) throw new Error("The published Delete icon was not rendered");
    act(() => clickDelete(mouseEvent(deleteButton, { target: deleteIcon })));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks",
      "/api/webhooks",
      "/api/webhooks/created-hook",
    ]);
  });

  it("requires exact input targets and retires equal-looking draft handlers on the reused DOM", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));

    const url = screen.getByTestId("webhook-url") as HTMLInputElement;
    const docs = screen.getByTestId("webhook-docs") as HTMLInputElement;
    const staleChange = reactProp<InputChangeHandler>(url, "onChange");

    url.value = "https://receiver.example/wrong-target";
    act(() => staleChange(inputEvent(url, { target: docs, nativeTarget: docs })));
    url.value = "";
    docs.value = "https://receiver.example/wrong-current";
    act(() => staleChange(inputEvent(docs)));
    docs.value = "";
    expect(url).toHaveValue("");
    expect(docs).toHaveValue("");

    fireEvent.change(url, { target: { value: "https://receiver.example/current" } });
    expect(url).toHaveValue("https://receiver.example/current");
    const currentChange = reactProp<InputChangeHandler>(url, "onChange");
    expect(currentChange).not.toBe(staleChange);

    url.value = "https://receiver.example/stale";
    act(() => staleChange(inputEvent(url)));
    url.value = "https://receiver.example/current";
    expect(url).toHaveValue("https://receiver.example/current");

    url.value = "https://receiver.example/successor";
    act(() => currentChange(inputEvent(url)));
    expect(url).toHaveValue("https://receiver.example/successor");
  });

  it("accepts only an exact native form submit and preserves keyboard submission", async () => {
    const create = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] })).mockReturnValueOnce(create.promise);
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: "https://receiver.example/native-submit" } });

    const form = screen.getByTestId("webhook-form") as HTMLFormElement;
    const createButton = screen.getByTestId("webhook-create") as HTMLButtonElement;
    const addButton = screen.getByTestId("webhook-add") as HTMLButtonElement;
    const submit = reactProp<SubmitHandler>(form, "onSubmit");
    const foreignForm = document.createElement("form");
    foreignRoot.appendChild(foreignForm);

    const wrongCurrent = submitEvent(foreignForm, form, form, createButton);
    const wrongTarget = submitEvent(form, createButton, form, createButton);
    const wrongNativeTarget = submitEvent(form, form, foreignForm, createButton);
    const wrongSubmitter = submitEvent(form, form, form, addButton);
    act(() => {
      submit(wrongCurrent.event);
      submit(wrongTarget.event);
      submit(wrongNativeTarget.event);
      submit(wrongSubmitter.event);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrongCurrent.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(wrongNativeTarget.preventDefault).not.toHaveBeenCalled();
    expect(wrongSubmitter.preventDefault).not.toHaveBeenCalled();

    const keyboardSubmit = submitEvent(form, form, form, null);
    act(() => submit(keyboardSubmit.event));
    expect(keyboardSubmit.preventDefault).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      url: "https://receiver.example/native-submit",
      events: ["request.created", "mention", "comment.added", "comment.replied"],
      documentIds: null,
    });
    foreignForm.remove();
  });

  it("prevents owned no-choice and retired submits before admitting only the fresh submit", async () => {
    const create = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockReturnValueOnce(create.promise);
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: "https://receiver.example/safe-submit" },
    });
    for (const choice of ["request.created", "mention", "comment.added", "comment.replied"]) {
      fireEvent.click(screen.getByTestId(`webhook-event-${choice}`));
    }

    const form = screen.getByTestId("webhook-form") as HTMLFormElement;
    const createButton = screen.getByTestId("webhook-create") as HTMLButtonElement;
    const retiredSubmit = reactProp<SubmitHandler>(form, "onSubmit");
    const noChoiceSubmit = submitEvent(form, form, form, null);
    act(() => retiredSubmit(noChoiceSubmit.event));
    expect(noChoiceSubmit.preventDefault).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("webhook-event-request.created"));
    const retiredEvent = submitEvent(form, form, form, createButton);
    act(() => retiredSubmit(retiredEvent.event));
    expect(retiredEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const freshSubmit = reactProp<SubmitHandler>(form, "onSubmit");
    expect(freshSubmit).not.toBe(retiredSubmit);
    const freshEvent = submitEvent(form, form, form, createButton);
    act(() => freshSubmit(freshEvent.event));
    expect(freshEvent.preventDefault).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prevents an owned submit after restored DOM mutation without starting app work", async () => {
    fetchMock.mockResolvedValueOnce(response({ webhooks: [] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), {
      target: { value: "https://receiver.example/mutated-submit" },
    });

    const form = screen.getByTestId("webhook-form") as HTMLFormElement;
    const createButton = screen.getByTestId("webhook-create") as HTMLButtonElement;
    const submit = reactProp<SubmitHandler>(form, "onSubmit");
    form.setAttribute("data-mutated", "true");
    form.removeAttribute("data-mutated");

    const mutatedSubmit = submitEvent(form, form, form, createButton);
    act(() => submit(mutatedSubmit.event));
    expect(mutatedSubmit.preventDefault).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects sibling, foreign, detached, cross-control, disabled, wrong-row, and reordered row sources", async () => {
    const pending = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [disabledWebhook, otherDisabledWebhook] }))
      .mockReturnValueOnce(pending.promise);
    render(<WebhooksPanel />);
    const rows = await screen.findAllByTestId("webhook-row");
    const firstTest = within(rows[0]).getByTestId("webhook-test") as HTMLButtonElement;
    const secondTest = within(rows[1]).getByTestId("webhook-test") as HTMLButtonElement;
    const firstDelete = within(rows[0]).getByTestId("webhook-delete") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(firstTest, "onClick");
    const detached = firstTest.cloneNode(true) as HTMLButtonElement;
    const foreign = document.createElement("button");
    foreignRoot.appendChild(foreign);

    act(() => {
      click(mouseEvent(secondTest));
      click(mouseEvent(firstDelete));
      click(mouseEvent(detached));
      click(mouseEvent(foreign));
    });
    firstTest.disabled = true;
    act(() => click(mouseEvent(firstTest)));
    firstTest.disabled = false;

    const list = rows[0].parentElement!;
    list.insertBefore(rows[1], rows[0]);
    act(() => click(mouseEvent(firstTest)));
    list.insertBefore(rows[0], rows[1]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => click(mouseEvent(firstTest)));
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
    ]);
    foreign.remove();
  });

  it("re-reads every mutable API row primitive before claiming a row action", async () => {
    interface MutableRow {
      id: string;
      url: string;
      events: string[];
      documentIds: string[] | null;
      active: boolean;
      failures: number;
      createdAt: string;
      lastDelivery: { status: number; at: string; attempt: number; event: string } | null;
    }

    const captured: { row: MutableRow | null } = { row: null };
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const parsed = originalParse(text) as { webhooks?: MutableRow[] };
      if (parsed.webhooks?.length === 1) captured.row = parsed.webhooks[0]!;
      return parsed;
    });
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [disabledWebhook] })).mockReturnValueOnce(pending.promise);
    render(<WebhooksPanel />);
    const testButton = await screen.findByTestId("webhook-test") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(testButton, "onClick");
    const liveRow = captured.row;
    if (!liveRow?.lastDelivery) throw new Error("The parsed webhook row was not captured");

    const originalDelivery = { ...liveRow.lastDelivery };
    const mutations: Array<() => () => void> = [
      () => {
        const old = liveRow!.id;
        liveRow!.id = "mutated-id";
        return () => { liveRow!.id = old; };
      },
      () => {
        const old = liveRow!.url;
        liveRow!.url = "https://receiver.example/mutated";
        return () => { liveRow!.url = old; };
      },
      () => {
        const old = liveRow!.events[0]!;
        liveRow!.events[0] = "mutated.event";
        return () => { liveRow!.events[0] = old; };
      },
      () => {
        liveRow!.documentIds = ["mutated-document"];
        return () => { liveRow!.documentIds = null; };
      },
      () => {
        liveRow!.active = true;
        return () => { liveRow!.active = false; };
      },
      () => {
        liveRow!.failures = 19;
        return () => { liveRow!.failures = 20; };
      },
      () => {
        liveRow!.createdAt = "2026-09-02T12:00:00.000Z";
        return () => { liveRow!.createdAt = disabledWebhook.createdAt; };
      },
      () => {
        liveRow!.lastDelivery!.status = 201;
        return () => { liveRow!.lastDelivery!.status = originalDelivery.status; };
      },
      () => {
        liveRow!.lastDelivery!.at = "2026-09-02T12:01:00.000Z";
        return () => { liveRow!.lastDelivery!.at = originalDelivery.at; };
      },
      () => {
        liveRow!.lastDelivery!.attempt = 5;
        return () => { liveRow!.lastDelivery!.attempt = originalDelivery.attempt; };
      },
      () => {
        liveRow!.lastDelivery!.event = "mutated.event";
        return () => { liveRow!.lastDelivery!.event = originalDelivery.event; };
      },
    ];

    for (const mutate of mutations) {
      const restore = mutate();
      act(() => click(mouseEvent(testButton)));
      restore();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    act(() => click(mouseEvent(testButton)));
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/disabled-hook/test",
    ]);
  });

  it("allows a later Delete after decline while blocking reentrant confirmation for the same event", async () => {
    const deletion = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response({ webhooks: [activeWebhook] })).mockReturnValueOnce(deletion.promise);
    render(<WebhooksPanel />);
    const deleteButton = await screen.findByTestId("webhook-delete") as HTMLButtonElement;
    const click = reactProp<ClickHandler>(deleteButton, "onClick");
    const declinedEvent = mouseEvent(deleteButton);
    const confirmMock = vi
      .fn<(message?: string) => boolean>()
      .mockImplementationOnce(() => {
        click(declinedEvent);
        return false;
      })
      .mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirmMock);

    act(() => click(declinedEvent));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const currentDelete = screen.getByTestId("webhook-delete") as HTMLButtonElement;
    const currentClick = reactProp<ClickHandler>(currentDelete, "onClick");
    act(() => currentClick(mouseEvent(currentDelete)));
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([requestedUrl]) => requestedUrl)).toEqual([
      "/api/webhooks",
      "/api/webhooks/active-hook",
    ]);
  });

  it("binds Copy to the exact created secret DOM and ignores later mutation of the API object", async () => {
    const captured: { created: { id: string; secret: string; url: string } | null } = { created: null };
    const originalParse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const parsed = originalParse(text) as { webhook?: { id: string; secret?: string; url: string } };
      if (parsed.webhook?.secret) {
        captured.created = parsed.webhook as { id: string; secret: string; url: string };
      }
      return parsed;
    });
    const writeText = vi.fn(() => Promise.resolve());
    const navigatorWithClipboard = Object.create(window.navigator) as Navigator;
    Object.defineProperty(navigatorWithClipboard, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("navigator", navigatorWithClipboard);
    fetchMock
      .mockResolvedValueOnce(response({ webhooks: [] }))
      .mockResolvedValueOnce(response({ webhook: { ...activeWebhook, id: "created-hook", secret: "whsec_exact" } }))
      .mockResolvedValueOnce(response({ webhooks: [{ ...activeWebhook, id: "created-hook" }] }));
    render(<WebhooksPanel />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    fireEvent.change(screen.getByTestId("webhook-url"), { target: { value: activeWebhook.url } });
    fireEvent.click(screen.getByTestId("webhook-create"));

    const createdRoot = await screen.findByTestId("webhook-created");
    const code = within(createdRoot).getByTestId("webhook-secret");
    expect(code).toHaveTextContent("whsec_exact");
    const copyButton = within(createdRoot).getByRole("button", { name: "Copy secret" }) as HTMLButtonElement;
    const copy = reactProp<ClickHandler>(copyButton, "onClick");
    const createdSource = captured.created;
    if (!createdSource) throw new Error("The parsed created webhook was not captured");
    createdSource.id = "mutated-created-id";
    createdSource.url = "https://receiver.example/mutated-created";
    createdSource.secret = "whsec_mutated";

    act(() => copy(mouseEvent(screen.getByTestId("webhook-add") as HTMLButtonElement)));
    expect(writeText).not.toHaveBeenCalled();

    const exactEvent = mouseEvent(copyButton);
    act(() => {
      copy(exactEvent);
      copy(exactEvent);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("whsec_exact");

    const currentCopyButton = within(screen.getByTestId("webhook-created"))
      .getByRole("button", { name: "Copy secret" }) as HTMLButtonElement;
    const currentCopy = reactProp<ClickHandler>(currentCopyButton, "onClick");
    const currentCode = screen.getByTestId("webhook-secret");
    const currentText = currentCode.textContent;
    currentCode.textContent = "whsec_dom_mutated";
    currentCode.textContent = currentText;
    act(() => currentCopy(mouseEvent(currentCopyButton)));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("retires a publication on control replacement and requires a rendered successor", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(response({ webhooks: [] })));
    const view = render(<BoundaryHarness cardKey={1} />);
    await screen.findByTestId("webhooks-empty");
    fireEvent.click(screen.getByTestId("webhook-add"));
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const clickCancel = reactProp<ClickHandler>(cancel, "onClick");
    const cancelRef = reactProp<RefCallback<HTMLButtonElement>>(cancel, "ref");
    const replacement = cancel.cloneNode(true) as HTMLButtonElement;
    foreignRoot.appendChild(replacement);

    act(() => {
      cancelRef(replacement);
      cancelRef(cancel);
      clickCancel(mouseEvent(cancel));
    });
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
    replacement.remove();

    view.rerender(<BoundaryHarness cardKey={2} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTestId("webhook-add"));
    expect(screen.getByTestId("webhook-form")).toBeInTheDocument();
  });
});
