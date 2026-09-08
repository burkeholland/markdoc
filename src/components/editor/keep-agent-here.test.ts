// @vitest-environment jsdom
import {
  createElement,
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const listTokens = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());
const selectContents = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      tokens: {
        ...actual.api.tokens,
        list: (...args: Parameters<typeof actual.api.tokens.list>) => listTokens(...args),
      },
    },
  };
});

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyText,
  selectContents,
}));

import { AgentConnectCard } from "@/components/settings/agent-connect-card";
import { ApiError, api } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { KeepAgentHereDialog, KeepAgentHerePanel, keepAgentPrompt } from "./keep-agent-here";

type TokenListResponse = Awaited<ReturnType<typeof api.tokens.list>>;

const DOC = { id: "doc-1", title: "Plan" };
type PanelProps = ComponentProps<typeof KeepAgentHerePanel>;
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedClick {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  defaultPrevented: boolean;
}

type ClickHandler = (event: CapturedClick) => void;

interface CapturedControl {
  element: HTMLButtonElement;
  click: ClickHandler;
  ref: ElementRef<HTMLButtonElement>;
}

interface CapturedPanel {
  panel: HTMLDivElement;
  heading: HTMLHeadingElement | null;
  error: HTMLDivElement | null;
  prompt: HTMLPreElement;
  back: CapturedControl | null;
  retry: CapturedControl | null;
  copy: CapturedControl;
  panelRef: ElementRef<HTMLDivElement>;
  headingRef: ElementRef<HTMLHeadingElement> | null;
  errorRef: ElementRef<HTMLDivElement> | null;
  promptRef: ElementRef<HTMLPreElement>;
}

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

function reactProperty<T>(element: HTMLElement, name: string): T | undefined {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  return props?.[name] as T | undefined;
}

function reactHandler<T extends (...args: never[]) => unknown>(element: HTMLElement, name: string): T {
  const handler = reactProperty<T>(element, name);
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler;
}

function reactRef<T extends HTMLElement>(element: HTMLElement): ElementRef<T> {
  const ref = reactProperty<ElementRef<T>>(element, "ref");
  if (typeof ref !== "function") throw new Error(`A callback ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return ref;
}

function captureControl(element: HTMLElement): CapturedControl {
  if (!(element instanceof HTMLButtonElement)) throw new Error("Expected a button control");
  return {
    element,
    click: reactHandler<ClickHandler>(element, "onClick"),
    ref: reactRef<HTMLButtonElement>(element),
  };
}

function capturePanel(host: HTMLElement = document.body): CapturedPanel {
  const scope = within(host);
  const panel = scope.getByTestId("keep-agent-panel");
  const heading = scope.queryByRole("heading", { level: 3, name: "Keep an agent here" });
  const error = scope.queryByTestId("keep-agent-token-error");
  const prompt = scope.getByTestId("keep-agent-prompt");
  const back = scope.queryByTestId("keep-agent-back");
  const retry = scope.queryByRole("button", { name: /Retry/ });
  const copy = scope.getByTestId("keep-agent-copy");
  if (!(panel instanceof HTMLDivElement) || !(prompt instanceof HTMLPreElement)) {
    throw new Error("Expected the Keep-agent panel and prompt elements");
  }
  return {
    panel,
    heading: heading instanceof HTMLHeadingElement ? heading : null,
    error: error instanceof HTMLDivElement ? error : null,
    prompt,
    back: back ? captureControl(back) : null,
    retry: retry ? captureControl(retry) : null,
    copy: captureControl(copy),
    panelRef: reactRef<HTMLDivElement>(panel),
    headingRef: heading ? reactRef<HTMLHeadingElement>(heading) : null,
    errorRef: error ? reactRef<HTMLDivElement>(error) : null,
    promptRef: reactRef<HTMLPreElement>(prompt),
  };
}

function capturedClick(
  control: CapturedControl,
  currentTarget: EventTarget | null = control.element,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
): CapturedClick {
  const ownerDocument = currentTarget instanceof Node ? currentTarget.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", { bubbles: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return {
    type: "click",
    currentTarget,
    target,
    nativeEvent,
    defaultPrevented: false,
  };
}

function invoke(control: CapturedControl, currentTarget: EventTarget | null = control.element, target: EventTarget | null = currentTarget) {
  control.click(capturedClick(control, currentTarget, target));
}

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function observeMutations(host: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(host, { attributes: true, characterData: true, childList: true, subtree: true });
  mutationObservers.push(observer);
  return observer;
}

function InitialPanel(props: PanelProps) {
  return createElement(KeepAgentHerePanel, props);
}

function ReplacementPanel(props: PanelProps) {
  return createElement(KeepAgentHerePanel, props);
}

function PanelBoundary({
  panel: panelProps,
  mount = "initial",
  present = true,
  boundary = 0,
  passiveVisit = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  panel: PanelProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  boundary?: number;
  passiveVisit?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);
  if (!present) return null;
  return createElement(mount === "initial" ? InitialPanel : ReplacementPanel, panelProps);
}

function tokenResponse(count: number): TokenListResponse {
  return {
    tokens: Array.from({ length: count }, (_, index) => ({ id: `token-${index}` })),
  } as TokenListResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function resolve<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}

async function reject<T>(pending: ReturnType<typeof deferred<T>>, error: unknown) {
  await act(async () => {
    pending.reject(error);
    await pending.promise.catch(() => undefined);
  });
}

function panel(active = true) {
  return createElement(KeepAgentHerePanel, { doc: DOC, active });
}

function dialog(open: boolean) {
  return createElement(KeepAgentHereDialog, { doc: DOC, open, onOpenChange: () => {} });
}

/**
 * Settles a request from the parent's layout effect after the panel visit is replaced or removed.
 * The queued promise continuation runs before the retired visit's passive cleanup.
 */
function BoundaryHarness({
  active = true,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  active?: boolean;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? panel(active) : null;
}

beforeEach(() => {
  window.localStorage.clear();
  listTokens.mockReset().mockResolvedValue(tokenResponse(1));
  copyText.mockReset().mockResolvedValue(true);
  selectContents.mockReset();
});

afterEach(() => {
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("keepAgentPrompt", () => {
  it("names the document, its id and the two MCP tools of the watch loop", () => {
    const s = keepAgentPrompt({ id: "abc123", title: "Launch plan" });
    expect(s).toBe(
      'Sit in the Markdoc document "Launch plan" (id abc123): call markdoc_presence active, then loop markdoc_watch with wait 55 and act on comments, mentions and requests until I say stop.',
    );
  });

  it("keeps the quoted title unambiguous and falls back to Untitled", () => {
    expect(keepAgentPrompt({ id: "x", title: 'Say "hi"' })).toContain(`"Say 'hi'"`);
    expect(keepAgentPrompt({ id: "x", title: "" })).toContain('"Untitled"');
  });
});

describe("agent documentation links", () => {
  it("gives every standalone documentation link an inline 24px hit area", () => {
    const card = render(createElement(AgentConnectCard, { origin: "https://markdoc.test" }));
    const agentDocs = screen.getByTestId("agent-docs-link");
    expect(agentDocs).toHaveClass("inline-flex", "min-h-6");
    expect(agentDocs).toHaveAttribute("href", AGENT_DOCS_URL);

    fireEvent.click(screen.getByTestId("agent-connect-tab-copilot-app"));
    expect(screen.getByRole("link", { name: "Inside the Copilot app setup and limits" })).toHaveClass("inline-flex", "min-h-6");
    card.unmount();

    render(panel(false));
    const keepAgentDocs = screen.getByTestId("keep-agent-docs-link");
    expect(keepAgentDocs).toHaveClass("inline-flex", "min-h-6");
    expect(keepAgentDocs).toHaveAttribute("href", `${AGENT_DOCS_URL}#sit-in-a-document`);
    expect(keepAgentDocs).toHaveAttribute("target", "_blank");
  });
});

describe("KeepAgentHerePanel token setup check", () => {
  it("keeps one physical initial check through Strict Mode's layout-effect replay", async () => {
    const initial = deferred<TokenListResponse>();
    listTokens.mockReset().mockReturnValueOnce(initial.promise);

    render(createElement(StrictMode, null, panel()));

    expect(listTokens).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Checking token setup…");
    await resolve(initial, tokenResponse(1));
    expect(listTokens).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows one neutral checking status and withholds first-time setup until zero tokens are confirmed", async () => {
    const initial = deferred<TokenListResponse>();
    listTokens.mockReset().mockReturnValueOnce(initial.promise);

    render(panel());

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Checking token setup…");
    expect(status).toHaveClass("text-ink-3");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByTestId("agent-connect-card")).toBeNull();
    expect(listTokens).toHaveBeenCalledTimes(1);

    await resolve(initial, tokenResponse(0));

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
  });

  it("replaces a failed first check with the API reason, one alert, and one Retry control", async () => {
    listTokens.mockReset().mockRejectedValueOnce(
      new ApiError(400, "Invalid request", [{ path: ["tokens"], message: "Your token list is temporarily unavailable." }]),
    );

    render(panel());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your token list is temporarily unavailable.");
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("agent-connect-card")).toBeNull();
  });

  it("uses the concise fallback when a failed check has no error message", async () => {
    listTokens.mockReset().mockRejectedValueOnce("offline");

    render(panel());

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check token setup");
  });

  it.each([
    { count: 0, setup: true, label: "zero tokens" },
    { count: 2, setup: false, label: "existing tokens" },
  ])("guards a double Retry and recovers with $label", async ({ count, setup }) => {
    const retry = deferred<TokenListResponse>();
    listTokens
      .mockReset()
      .mockRejectedValueOnce(new ApiError(503, "Token service unavailable."))
      .mockReturnValueOnce(retry.promise);

    render(panel());
    await screen.findByRole("alert");
    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(listTokens).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retrying…" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("agent-connect-card")).toBeNull();

    await resolve(retry, tokenResponse(count));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    if (setup) expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
    else expect(screen.queryByTestId("agent-connect-card")).toBeNull();
  });

  it("keeps setup navigation, the exact prompt, Copy, and documentation usable after failure", async () => {
    listTokens.mockReset().mockRejectedValueOnce(new ApiError(503, "Token service unavailable."));

    render(panel());
    await screen.findByRole("alert");

    expect(screen.getByRole("link", { name: "Tokens" })).toHaveAttribute("href", "/settings?next=%2Fd%2Fdoc-1#tokens");
    expect(screen.getByRole("link", { name: "Connect an MCP client" })).toHaveAttribute("href", "/settings?next=%2Fd%2Fdoc-1#connect");
    expect(screen.getByTestId("keep-agent-prompt")).toHaveTextContent(keepAgentPrompt(DOC));
    expect(screen.getByTestId("keep-agent-docs-link")).toHaveAttribute("href", `${AGENT_DOCS_URL}#sit-in-a-document`);

    fireEvent.click(screen.getByRole("button", { name: "Copy instruction" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(keepAgentPrompt(DOC)));
    expect(screen.getByRole("button", { name: "Copy instruction" })).toHaveTextContent("Copied");
  });

  it("keeps a persisted setup dismissal after a zero-token Retry", async () => {
    window.localStorage.setItem(AGENT_CONNECT_DISMISSED_KEY, "1");
    listTokens
      .mockReset()
      .mockRejectedValueOnce(new ApiError(503, "Token service unavailable."))
      .mockResolvedValueOnce(tokenResponse(0));

    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(listTokens).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("agent-connect-card")).toBeNull();
  });

  it.each([
    { count: 0, setup: true, label: "zero-token" },
    { count: 1, setup: false, label: "nonzero-token" },
  ])("retains the confirmed $label setup decision when a reopen refresh fails", async ({ count, setup }) => {
    const refresh = deferred<TokenListResponse>();
    listTokens.mockReset().mockResolvedValueOnce(tokenResponse(count)).mockReturnValueOnce(refresh.promise);
    const rendered = render(panel());
    await waitFor(() => expect(listTokens).toHaveBeenCalledTimes(1));
    await act(async () => {});

    if (setup) expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
    else expect(screen.queryByTestId("agent-connect-card")).toBeNull();

    rendered.rerender(panel(false));
    rendered.rerender(panel());

    expect(listTokens).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Checking token setup…");
    if (setup) expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
    else expect(screen.queryByTestId("agent-connect-card")).toBeNull();

    await reject(refresh, new ApiError(503, "Refresh failed."));

    expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed.");
    if (setup) expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
    else expect(screen.queryByTestId("agent-connect-card")).toBeNull();
  });

  it.each(["success", "failure"] as const)(
    "serializes a rapid dialog close/reopen across an old physical %s and follows it with one current check",
    async (settlement) => {
      const old = deferred<TokenListResponse>();
      const current = deferred<TokenListResponse>();
      let inFlight = 0;
      let maximumInFlight = 0;
      const tracked = (request: ReturnType<typeof deferred<TokenListResponse>>) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        return request.promise.finally(() => {
          inFlight -= 1;
        });
      };
      listTokens
        .mockReset()
        .mockImplementationOnce(() => tracked(old))
        .mockImplementationOnce(() => tracked(current));
      const rendered = render(dialog(true));

      rendered.rerender(dialog(false));
      expect(screen.queryByTestId("keep-agent-dialog")).toBeNull();
      rendered.rerender(dialog(true));
      rendered.rerender(dialog(true));

      expect(listTokens).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveTextContent("Checking token setup…");
      if (settlement === "success") await resolve(old, tokenResponse(0));
      else await reject(old, new ApiError(503, "Old visit failed."));

      expect(listTokens).toHaveBeenCalledTimes(2);
      expect(maximumInFlight).toBe(1);
      expect(screen.getByRole("status")).toHaveTextContent("Checking token setup…");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("agent-connect-card")).toBeNull();

      await resolve(current, tokenResponse(0));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByTestId("agent-connect-card")).toBeInTheDocument();
      expect(maximumInFlight).toBe(1);
    },
  );

  it.each(["success", "failure"] as const)(
    "retires a queued old %s at the inactive layout boundary before starting one current check",
    async (settlement) => {
      const old = deferred<TokenListResponse>();
      const current = deferred<TokenListResponse>();
      listTokens.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      const rendered = render(createElement(BoundaryHarness));

      rendered.rerender(
        createElement(BoundaryHarness, {
          active: false,
          boundary: 1,
          onBoundary: () => {
            if (settlement === "success") old.resolve(tokenResponse(0));
            else old.reject(new ApiError(503, "Retired visit failed."));
          },
        }),
      );
      await act(async () => {
        await Promise.allSettled([old.promise]);
        await Promise.resolve();
      });

      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("agent-connect-card")).toBeNull();
      rendered.rerender(createElement(BoundaryHarness, { active: true, boundary: 2 }));
      expect(listTokens).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status")).toHaveTextContent("Checking token setup…");

      await resolve(current, tokenResponse(1));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("agent-connect-card")).toBeNull();
    },
  );

  it("retires before a failure settles at the DOM-removal layout boundary without post-unmount work or an unhandled rejection", async () => {
    const pending = deferred<TokenListResponse>();
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    listTokens.mockReset().mockReturnValueOnce(pending.promise);
    window.addEventListener("unhandledrejection", unhandled);

    try {
      const rendered = render(createElement(BoundaryHarness));
      expect(listTokens).toHaveBeenCalledTimes(1);
      rendered.rerender(
        createElement(BoundaryHarness, {
          present: false,
          boundary: 1,
          onBoundary: () => pending.reject(new ApiError(503, "Removed visit failed.")),
        }),
      );
      await act(async () => {
        await Promise.allSettled([pending.promise]);
        await Promise.resolve();
      });

      expect(unhandled).not.toHaveBeenCalled();
      expect(listTokens).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("keep-agent-panel")).toBeNull();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});

describe("KeepAgentHerePanel exact control publications", () => {
  it("claims each genuine Back, Retry, and Copy click once before producer work", async () => {
    const retry = deferred<TokenListResponse>();
    const onBack = vi.fn();
    listTokens
      .mockReset()
      .mockRejectedValueOnce(new ApiError(503, "Token service unavailable."))
      .mockReturnValueOnce(retry.promise);
    const view = renderDirect(
      createElement(PanelBoundary, {
        panel: { doc: DOC, onBack },
      }),
    );
    await waitFor(() => expect(within(view.host).getByRole("alert")).toBeInTheDocument());
    const captured = capturePanel(view.host);
    const back = captured.back!;
    const retryControl = captured.retry!;
    const copyTarget = captured.copy.element.firstElementChild;
    if (!copyTarget) throw new Error("The Copy control has no rendered descendant");
    const backEvent = capturedClick(back);
    const retryEvent = capturedClick(retryControl);
    const copyEvent = capturedClick(captured.copy, captured.copy.element, copyTarget, copyTarget);

    act(() => {
      back.click(backEvent);
      captured.copy.click(copyEvent);
      retryControl.click(retryEvent);
      back.click(backEvent);
      captured.copy.click(copyEvent);
      retryControl.click(retryEvent);
    });

    expect(onBack).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(DOC));
    expect(listTokens).toHaveBeenCalledTimes(2);
    expect(selectContents).not.toHaveBeenCalled();

    await resolve(retry, tokenResponse(1));
  });

  it("keeps exact actions available through Strict Mode's ref and layout replays", async () => {
    const onBack = vi.fn();
    const view = renderDirect(
      createElement(StrictMode, null, createElement(KeepAgentHerePanel, { doc: DOC, onBack })),
    );
    await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
    const current = capturePanel(view.host);

    fireEvent.click(current.back!.element);
    fireEvent.click(current.copy.element);

    expect(onBack).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(DOC));
    expect(listTokens).toHaveBeenCalledOnce();
  });

  it("rejects non-native, mismatched, foreign, detached, disabled, replaced, and late-injected sources without consuming current actions", async () => {
    const onBack = vi.fn();
    const view = renderDirect(createElement(KeepAgentHerePanel, { doc: DOC, onBack }));
    await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
    const current = capturePanel(view.host);
    const back = current.back!;
    const foreign = document.createElement("button");
    const replacement = current.copy.element.cloneNode(true);
    if (!(replacement instanceof HTMLButtonElement)) throw new Error("Expected a replacement Copy control");
    const detached = document.createElement("button");
    document.body.append(foreign, replacement);
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fabricated = {
      ...capturedClick(back),
      nativeEvent: new Event("click"),
    };
    const wrongType = {
      ...capturedClick(current.copy),
      type: "pointerdown",
    };
    const copyTarget = current.copy.element.firstElementChild;
    if (!copyTarget) throw new Error("The Copy control has no rendered descendant");
    const mismatched = capturedClick(
      current.copy,
      current.copy.element,
      copyTarget,
      current.copy.element,
    );
    const injected = document.createElement("span");
    current.copy.element.append(injected);
    const injectedEvent = capturedClick(
      current.copy,
      current.copy.element,
      injected,
      injected,
    );
    current.copy.element.disabled = true;
    act(() => invoke(current.copy));
    current.copy.element.disabled = false;
    observer.takeRecords();

    act(() => {
      back.click(fabricated);
      current.copy.click(wrongType);
      current.copy.click(mismatched);
      invoke(back, current.copy.element);
      invoke(current.copy, back.element);
      invoke(current.copy, foreign);
      invoke(current.copy, detached);
      invoke(current.copy, replacement);
      current.copy.click(injectedEvent);
    });

    expect(onBack).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);

    injected.remove();
    observer.takeRecords();
    fireEvent.click(back.element);
    fireEvent.click(current.copy.element);
    expect(onBack).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(DOC));
    foreign.remove();
    replacement.remove();
  });

  it("isolates sibling panel controls and leaves each current owner usable", async () => {
    const onBackA = vi.fn();
    const onBackB = vi.fn();
    const docB = { id: "doc-2", title: "Launch" };
    const view = renderDirect(
      createElement(
        "div",
        null,
        createElement("section", { "data-testid": "panel-a" }, createElement(KeepAgentHerePanel, { doc: DOC, onBack: onBackA })),
        createElement("section", { "data-testid": "panel-b" }, createElement(KeepAgentHerePanel, { doc: docB, onBack: onBackB })),
      ),
    );
    await waitFor(() => expect(listTokens).toHaveBeenCalledTimes(2));
    const panelAHost = within(view.host).getByTestId("panel-a");
    const panelBHost = within(view.host).getByTestId("panel-b");
    const panelA = capturePanel(panelAHost);
    const panelB = capturePanel(panelBHost);

    act(() => {
      invoke(panelA.back!, panelB.back!.element);
      invoke(panelB.back!, panelA.back!.element);
      invoke(panelA.copy, panelB.copy.element);
      invoke(panelB.copy, panelA.copy.element);
    });
    expect(onBackA).not.toHaveBeenCalled();
    expect(onBackB).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();

    fireEvent.click(panelA.back!.element);
    fireEvent.click(panelB.copy.element);
    expect(onBackA).toHaveBeenCalledOnce();
    expect(onBackB).not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(docB));
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires same-DOM document and callback publications before the parent layout boundary in %s order",
    async (order) => {
      const onBackA = vi.fn();
      const onBackB = vi.fn();
      const docB = { id: "doc-2", title: "Current plan" };
      let passiveCleanups = 0;
      const view = renderDirect(
        createElement(PanelBoundary, {
          panel: { doc: DOC, onBack: onBackA },
          onPassiveCleanup: () => passiveCleanups++,
        }),
      );
      await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
      const stale = capturePanel(view.host);
      const observer = observeMutations(view.host);
      let currentAtBoundary!: CapturedPanel;

      act(() => {
        view.root.render(
          createElement(PanelBoundary, {
            panel: { doc: docB, onBack: onBackB },
            boundary: 1,
            passiveVisit: 1,
            onPassiveCleanup: () => passiveCleanups++,
            onBoundary: () => {
              expect(passiveCleanups).toBe(0);
              currentAtBoundary = capturePanel(view.host);
              expect(currentAtBoundary.panel).toBe(stale.panel);
              expect(currentAtBoundary.prompt).toBe(stale.prompt);
              expect(currentAtBoundary.copy.element).toBe(stale.copy.element);
              observer.takeRecords();
              if (order === "stale-before-current") {
                invoke(stale.back!);
                invoke(stale.copy, currentAtBoundary.copy.element);
              } else {
                invoke(stale.copy, currentAtBoundary.copy.element);
                invoke(stale.back!);
              }
            },
          }),
        );
      });

      expect(passiveCleanups).toBe(1);
      expect(onBackA).not.toHaveBeenCalled();
      expect(onBackB).not.toHaveBeenCalled();
      expect(copyText).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      const current = capturePanel(view.host);
      fireEvent.click(current.back!.element);
      fireEvent.click(current.copy.element);
      expect(onBackB).toHaveBeenCalledOnce();
      expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(docB));
      expect(current.prompt).toHaveTextContent(keepAgentPrompt(docB));
    },
  );

  it("isolates an equal-looking remount, ignores late old refs, and retires before removal reaches parent layout", async () => {
    const pendingCopy = deferred<boolean>();
    copyText.mockReturnValue(pendingCopy.promise);
    const onBack = vi.fn();
    const props = { doc: DOC, onBack };
    let passiveCleanups = 0;
    const view = renderDirect(
      createElement(PanelBoundary, {
        panel: props,
        onPassiveCleanup: () => passiveCleanups++,
      }),
    );
    await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
    const stale = capturePanel(view.host);
    let currentAtBoundary!: CapturedPanel;

    act(() => {
      view.root.render(
        createElement(PanelBoundary, {
          panel: props,
          mount: "replacement",
          boundary: 1,
          passiveVisit: 1,
          onPassiveCleanup: () => passiveCleanups++,
          onBoundary: () => {
            expect(passiveCleanups).toBe(0);
            currentAtBoundary = capturePanel(view.host);
            expect(currentAtBoundary.panel).not.toBe(stale.panel);
            expect(stale.panel.isConnected).toBe(false);
            invoke(stale.back!, currentAtBoundary.back!.element);
            invoke(stale.copy, currentAtBoundary.copy.element);
            invoke(currentAtBoundary.back!, stale.back!.element);
            invoke(currentAtBoundary.copy, stale.copy.element);
          },
        }),
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    const current = capturePanel(view.host);
    act(() => {
      stale.panelRef(current.panel);
      stale.headingRef?.(current.heading);
      stale.promptRef(current.prompt);
      stale.back!.ref(current.back!.element);
      stale.copy.ref(current.copy.element);
      stale.panelRef(null);
      stale.headingRef?.(null);
      stale.promptRef(null);
      stale.back!.ref(null);
      stale.copy.ref(null);
    });
    fireEvent.click(current.copy.element);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(DOC));

    act(() => {
      view.root.render(
        createElement(PanelBoundary, {
          panel: props,
          mount: "replacement",
          present: false,
          boundary: 2,
          passiveVisit: 2,
          onPassiveCleanup: () => passiveCleanups++,
          onBoundary: () => {
            expect(current.panel.isConnected).toBe(false);
            invoke(current.back!);
          },
        }),
      );
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(within(view.host).queryByTestId("keep-agent-panel")).toBeNull();

    await act(async () => {
      pendingCopy.reject(new Error("late clipboard failure"));
      await Promise.resolve();
    });
    expect(selectContents).not.toHaveBeenCalled();
  });

  it.each(["panel", "heading", "error", "prompt", "back", "retry", "copy"] as const)(
    "retires every action when the committed %s ref is replaced",
    async (role) => {
      const onBack = vi.fn();
      listTokens.mockReset().mockRejectedValueOnce(new ApiError(503, "Token service unavailable."));
      const view = renderDirect(createElement(KeepAgentHerePanel, { doc: DOC, onBack }));
      await waitFor(() => expect(within(view.host).getByRole("alert")).toBeInTheDocument());
      const stale = capturePanel(view.host);
      const original =
        role === "panel"
          ? stale.panel
          : role === "heading"
            ? stale.heading!
            : role === "error"
              ? stale.error!
              : role === "prompt"
                ? stale.prompt
                : stale[role]!.element;
      const replacement = original.cloneNode(true);
      if (!(replacement instanceof HTMLElement)) throw new Error(`Expected a replacement ${role} element`);
      view.host.append(replacement);
      const observer = observeMutations(view.host);
      observer.takeRecords();

      act(() => {
        if (role === "panel") stale.panelRef(replacement as HTMLDivElement);
        else if (role === "heading") stale.headingRef?.(replacement as HTMLHeadingElement);
        else if (role === "error") stale.errorRef?.(replacement as HTMLDivElement);
        else if (role === "prompt") stale.promptRef(replacement as HTMLPreElement);
        else stale[role]!.ref(replacement as HTMLButtonElement);
        invoke(stale.back!);
        invoke(stale.retry!);
        invoke(stale.copy);
      });

      expect(onBack).not.toHaveBeenCalled();
      expect(listTokens).toHaveBeenCalledOnce();
      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      replacement.remove();
    },
  );

  it("re-reads mutable document primitives immediately before claim and preserves current usability after rejection", async () => {
    const mutableDoc = { id: "mutable-1", title: "Original" };
    const onBack = vi.fn();
    const view = renderDirect(createElement(KeepAgentHerePanel, { doc: mutableDoc, onBack }));
    await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
    const current = capturePanel(view.host);

    mutableDoc.id = "mutated-2";
    mutableDoc.title = "Mutated";
    act(() => {
      invoke(current.back!);
      invoke(current.copy);
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();

    mutableDoc.id = "mutable-1";
    mutableDoc.title = "Original";
    fireEvent.click(current.back!.element);
    fireEvent.click(current.copy.element);
    expect(onBack).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(mutableDoc));
  });

  it("passes the exact committed prompt to the existing copy fallback and feedback flow", async () => {
    copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const view = renderDirect(createElement(KeepAgentHerePanel, { doc: DOC }));
    await waitFor(() => expect(within(view.host).queryByRole("status")).toBeNull());
    const current = capturePanel(view.host);

    fireEvent.click(current.copy.element);

    expect(copyText).toHaveBeenCalledExactlyOnceWith(keepAgentPrompt(DOC));
    await waitFor(() => expect(selectContents).toHaveBeenCalledExactlyOnceWith(current.prompt));
    expect(within(view.host).getByRole("button", { name: "Copy instruction" })).toHaveTextContent("Select & press Ctrl+C");
  });
});
