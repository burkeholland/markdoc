// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AgentConnectCard,
  COPILOT_APP_INSTALL,
  CopyBlock,
  mcpConfigFor,
  mcpHttpConfigFor,
  mcpVsCodeConfigFor,
  TOKEN_PLACEHOLDER,
  type AgentConnectCardProps,
} from "./agent-connect-card";
import { CopilotPermissionsHint } from "./copilot-permissions-hint";
import { copilotAllowToolLine, MCP_PATH, type TokenScopeName } from "@/lib/mcp";

const copyText = vi.hoisted(() => vi.fn());
const selectContents = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText, selectContents }));

beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true);
  selectContents.mockReset();
});

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const mutationObservers: MutationObserver[] = [];

afterEach(() => {
  cleanup();
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

interface ReactHostFiber {
  alternate?: ReactHostFiber | null;
  memoizedProps?: Record<string, unknown>;
  refCleanup?: unknown;
}

function reactRefCleanup(element: HTMLElement): () => void {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey || !propsKey) throw new Error(`React internals were not attached to ${element.tagName}`);
  const record = element as unknown as Record<string, ReactHostFiber | Record<string, unknown>>;
  const fiber = record[fiberKey] as ReactHostFiber;
  const props = record[propsKey] as Record<string, unknown>;
  const alternate = fiber.alternate;
  const current = alternate?.memoizedProps?.onKeyDown === props.onKeyDown
    ? alternate
    : fiber;
  if (!current || typeof current.refCleanup !== "function") {
    throw new Error(`React ref cleanup was not attached to ${element.tagName}`);
  }
  return current.refCleanup as () => void;
}

type ClickHandler = (event: { currentTarget: HTMLButtonElement }) => void;
type KeyHandler = (event: { key: string; currentTarget: HTMLButtonElement; preventDefault: () => void }) => void;
type ElementRef<T extends HTMLElement> = (element: T | null) => void | (() => void);
type PermissionHintClickHandler = (event: PermissionEvent) => void;

interface PermissionHintProps {
  testIdPrefix: string;
  className?: string;
  scope?: TokenScopeName | null;
}

interface CapturedPermissionHint {
  root: HTMLDivElement;
  pre: HTMLPreElement;
  button: HTMLButtonElement;
  click: PermissionHintClickHandler;
  rootRef: ElementRef<HTMLDivElement>;
  preRef: ElementRef<HTMLPreElement>;
  buttonRef: ElementRef<HTMLButtonElement>;
}

interface PermissionEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function permissionEvent(
  currentTarget: HTMLButtonElement,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
  button = 0,
  type = "click",
): PermissionEvent {
  const ownerDocument = currentTarget.ownerDocument;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", {
    bubbles: true,
    cancelable: true,
    button,
  });
  Object.defineProperty(nativeEvent, "target", {
    configurable: true,
    value: nativeTarget,
  });
  return {
    type,
    currentTarget,
    target,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function expectEventUntouched(event: PermissionEvent) {
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
}

function capturePermissionHint(prefix: string): CapturedPermissionHint {
  const root = screen.getByTestId(`${prefix}-permissions`) as HTMLDivElement;
  const pre = screen.getByTestId(`${prefix}-allow-line`) as HTMLPreElement;
  const button = screen.getByTestId(`${prefix}-allow-copy`) as HTMLButtonElement;
  return {
    root,
    pre,
    button,
    click: reactHandler<PermissionHintClickHandler>(button, "onClick"),
    rootRef: reactHandler<ElementRef<HTMLDivElement>>(root, "ref"),
    preRef: reactHandler<ElementRef<HTMLPreElement>>(pre, "ref"),
    buttonRef: reactHandler<ElementRef<HTMLButtonElement>>(button, "ref"),
  };
}

type CopyBlockProps = ComponentProps<typeof CopyBlock>;

interface CopyBlockEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

type CopyBlockClickHandler = (event: CopyBlockEvent) => void;

interface CapturedCopyBlock {
  wrapper: HTMLDivElement;
  pre: HTMLPreElement;
  button: HTMLButtonElement;
  click: CopyBlockClickHandler;
  wrapperRef: ElementRef<HTMLDivElement>;
  preRef: ElementRef<HTMLPreElement>;
  buttonRef: ElementRef<HTMLButtonElement>;
}

function captureCopyBlock(host: HTMLElement, testId: string, copyTestId?: string): CapturedCopyBlock {
  const scope = within(host);
  const pre = scope.getByTestId(testId);
  const wrapper = pre.parentElement;
  const button = copyTestId ? scope.getByTestId(copyTestId) : wrapper?.querySelector(":scope > button");
  if (!(wrapper instanceof HTMLDivElement) || !(pre instanceof HTMLPreElement) || !(button instanceof HTMLButtonElement)) {
    throw new Error("Expected a complete CopyBlock hierarchy");
  }
  return {
    wrapper,
    pre,
    button,
    click: reactHandler<CopyBlockClickHandler>(button, "onClick"),
    wrapperRef: reactHandler<ElementRef<HTMLDivElement>>(wrapper, "ref"),
    preRef: reactHandler<ElementRef<HTMLPreElement>>(pre, "ref"),
    buttonRef: reactHandler<ElementRef<HTMLButtonElement>>(button, "ref"),
  };
}

function copyBlockEvent(
  block: CapturedCopyBlock,
  currentTarget: EventTarget | null = block.button,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
  button = 0,
): CopyBlockEvent {
  const ownerDocument = currentTarget instanceof Node ? currentTarget.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor("click", { bubbles: true, cancelable: true, button });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  const path: EventTarget[] = [];
  if (nativeTarget instanceof Node) {
    let current: Node | null = nativeTarget;
    while (current) {
      path.push(current);
      current = current.parentNode;
    }
    const view = nativeTarget.ownerDocument?.defaultView;
    if (view && path.at(-1) === nativeTarget.ownerDocument) path.push(view);
  }
  Object.defineProperty(nativeEvent, "composedPath", {
    configurable: true,
    value: () => path,
  });
  return {
    type: "click",
    currentTarget,
    target,
    nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function expectCopyBlockEventUntouched(event: CopyBlockEvent) {
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(event.stopPropagation).not.toHaveBeenCalled();
}

function CopyBlockBoundary({
  block,
  mount = "initial",
  present = true,
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  block: CopyBlockProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);
  if (!present) return null;
  return <CopyBlock key={mount} {...block} />;
}

interface CapturedActions {
  clickElement: HTMLButtonElement;
  click: ClickHandler;
  keyElement: HTMLButtonElement;
  key: KeyHandler;
  createElement: HTMLButtonElement;
  create: ClickHandler;
  dismissElement: HTMLButtonElement;
  dismiss: ClickHandler;
}

function tab(name: string): HTMLButtonElement {
  return screen.getByRole("tab", { name }) as HTMLButtonElement;
}

function expectSelected(name: string) {
  const selected = screen.getAllByRole("tab").filter((element) => element.getAttribute("aria-selected") === "true");
  expect(selected).toEqual([tab(name)]);
  expect(tab(name)).toHaveAttribute("tabindex", "0");
  expect(screen.getAllByRole("tab").filter((element) => element.tabIndex === 0)).toEqual([tab(name)]);
}

function tabKeyEvent(
  element: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
): KeyboardEvent {
  const KeyboardEventConstructor = element.ownerDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventConstructor) throw new Error("The tab has no owner-realm KeyboardEvent");
  const event = new KeyboardEventConstructor("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markJsdomEventTrusted(event);
  return event;
}

function markJsdomEventTrusted(event: Event) {
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

function dispatchTabKeyWithHandler(
  element: HTMLButtonElement,
  event: KeyboardEvent,
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Agent tab");
  const properties = element as unknown as Record<string, Record<string, unknown>>;
  const props = properties[propsKey];
  const replacement = { ...props, onKeyDown };
  properties[propsKey] = replacement;
  try {
    act(() => {
      element.dispatchEvent(event);
    });
  } finally {
    if (properties[propsKey] === replacement) properties[propsKey] = props;
  }
}

interface PublicTabWrapperMethods {
  preventDefault: () => void;
  stopPropagation: () => void;
  isDefaultPrevented: () => boolean;
  isPropagationStopped: () => boolean;
}

function publicTabWrapper<T extends HTMLElement>(
  event: ReactKeyboardEvent<T>,
  prototype: object,
  methods: PublicTabWrapperMethods,
): ReactKeyboardEvent<T> {
  return Object.assign(Object.create(prototype) as object, {
    type: event.type,
    target: event.target,
    currentTarget: event.currentTarget,
    eventPhase: event.eventPhase,
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    isTrusted: event.isTrusted,
    nativeEvent: event.nativeEvent,
    key: event.key,
    code: event.code,
    location: event.location,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    view: event.view,
    ...methods,
  }) as unknown as ReactKeyboardEvent<T>;
}

function dispatchTabKeyWithPublicWrappers(
  element: HTMLButtonElement,
  event: KeyboardEvent,
  wrapCapture: (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => ReactKeyboardEvent<HTMLDivElement>,
  wrapBubble: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => ReactKeyboardEvent<HTMLButtonElement>,
) {
  const list = element.closest('[role="tablist"]');
  if (!(list instanceof HTMLDivElement)) throw new Error("The tab has no tablist");
  const capture = reactHandler<
    (event: ReactKeyboardEvent<HTMLDivElement>) => void
  >(list, "onKeyDownCapture");
  const bubble = reactHandler<
    (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  >(element, "onKeyDown");
  const listKey = Object.keys(list).find((key) => key.startsWith("__reactProps$"));
  const tabKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!listKey || !tabKey) throw new Error("React props were not attached to the tab boundary");
  const listRecord = list as unknown as Record<string, Record<string, unknown>>;
  const tabRecord = element as unknown as Record<string, Record<string, unknown>>;
  const listProps = listRecord[listKey]!;
  const tabProps = tabRecord[tabKey]!;
  const captureReplacement = {
    ...listProps,
    onKeyDownCapture: (current: ReactKeyboardEvent<HTMLDivElement>) =>
      capture(wrapCapture(current)),
  };
  const bubbleReplacement = {
    ...tabProps,
    onKeyDown: (current: ReactKeyboardEvent<HTMLButtonElement>) =>
      bubble(wrapBubble(current)),
  };
  listRecord[listKey] = captureReplacement;
  tabRecord[tabKey] = bubbleReplacement;
  try {
    act(() => {
      element.dispatchEvent(event);
    });
  } finally {
    if (listRecord[listKey] === captureReplacement) listRecord[listKey] = listProps;
    if (tabRecord[tabKey] === bubbleReplacement) tabRecord[tabKey] = tabProps;
  }
}

function dispatchTabKey(
  element: HTMLButtonElement,
  keyOrEvent: string | KeyboardEvent,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = typeof keyOrEvent === "string"
    ? tabKeyEvent(element, keyOrEvent, init)
    : keyOrEvent;
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function captureActions(): CapturedActions {
  const clickElement = tab("Copilot app");
  const keyElement = tab("VS Code");
  const createElement = screen.getByTestId("agent-connect-create-token") as HTMLButtonElement;
  const dismissElement = screen.getByTestId("agent-connect-dismiss") as HTMLButtonElement;
  expect(createElement.tagName).toBe("BUTTON");
  return {
    clickElement,
    click: reactHandler<ClickHandler>(clickElement, "onClick"),
    keyElement,
    key: reactHandler<KeyHandler>(keyElement, "onKeyDown"),
    createElement,
    create: reactHandler<ClickHandler>(createElement, "onClick"),
    dismissElement,
    dismiss: reactHandler<ClickHandler>(dismissElement, "onClick"),
  };
}

function invokeActions(actions: CapturedActions) {
  const preventDefault = vi.fn();
  actions.click({ currentTarget: actions.clickElement });
  actions.key({ key: "ArrowRight", currentTarget: actions.keyElement, preventDefault });
  actions.create({ currentTarget: actions.createElement });
  actions.dismiss({ currentTarget: actions.dismissElement });
  return preventDefault;
}

function InitialCard(props: AgentConnectCardProps) {
  return <AgentConnectCard {...props} />;
}

function ReplacementCard(props: AgentConnectCardProps) {
  return <AgentConnectCard {...props} />;
}

function CardBoundary({
  card,
  mount = "initial",
  present = true,
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  card: AgentConnectCardProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);
  if (!present) return null;
  return mount === "initial" ? <InitialCard {...card} /> : <ReplacementCard {...card} />;
}

function InitialPermissionHint(props: PermissionHintProps) {
  return <CopilotPermissionsHint {...props} />;
}

function ReplacementPermissionHint(props: PermissionHintProps) {
  return <CopilotPermissionsHint {...props} />;
}

function PermissionHintBoundary({
  hint,
  mount = "initial",
  present = true,
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  hint: PermissionHintProps;
  mount?: "initial" | "replacement";
  present?: boolean;
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);
  if (!present) return null;
  return mount === "initial" ? <InitialPermissionHint {...hint} /> : <ReplacementPermissionHint {...hint} />;
}

describe("MCP setup disclosure", () => {
  it("uses the existing endpoint and placeholder in both supported HTTP configuration shapes", () => {
    const origin = "https://markdoc.example.test";
    const cli = JSON.parse(mcpHttpConfigFor(origin));
    const vscode = JSON.parse(mcpVsCodeConfigFor(origin));
    expect(cli.mcpServers.markdoc.url).toBe(`${origin}${MCP_PATH}`);
    expect(vscode.servers.markdoc.url).toBe(`${origin}${MCP_PATH}`);
    expect(vscode.servers.markdoc.headers.Authorization).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
    expect(cli.mcpServers.markdoc.headers.Authorization).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
    const stdio = JSON.parse(mcpConfigFor(origin));
    expect(stdio.mcpServers.markdoc.env).toEqual({ MARKDOC_URL: origin, MARKDOC_TOKEN: TOKEN_PLACEHOLDER });
  });

  it("does not guess localhost when the origin is not available yet", () => {
    render(<AgentConnectCard origin="" hideTokenStep />);
    expect(screen.getByText("Determining this server's address...")).toBeVisible();
    expect(screen.queryByTestId("agent-connect-config")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy MCP configuration" })).toBeNull();
  });

  it.each(["Copilot CLI", "VS Code", "Other MCP clients"])("copies client-specific stdio after opening it for %s and switching clients", async (initial) => {
    const origin = "https://markdoc.example.test";
    render(<AgentConnectCard origin={origin} hideTokenStep />);
    fireEvent.click(screen.getByRole("tab", { name: initial }));
    const stdio = screen.getByTestId("agent-connect-config-stdio");
    expect(stdio).not.toBeVisible();
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-connect-stdio-toggle"));
    let copies = 0;
    for (const client of [initial, "VS Code", "Other MCP clients", "Copilot CLI"]) {
      fireEvent.click(screen.getByRole("tab", { name: client }));
      expect(stdio).toBeVisible();
      const root = client === "VS Code" ? "servers" : "mcpServers";
      const displayed = stdio.textContent!;
      expect(JSON.parse(displayed)).toEqual({
        [root]: {
          markdoc: {
            command: "node",
            args: ["/path/to/markdoc/mcp/server.mjs"],
            env: { MARKDOC_URL: origin, MARKDOC_TOKEN: TOKEN_PLACEHOLDER },
          },
        },
      });
      expect(Object.keys(JSON.parse(screen.getByTestId("agent-connect-config").textContent!))).toEqual([root]);
      expect(copyText).toHaveBeenCalledTimes(copies);
      fireEvent.click(screen.getByRole("button", { name: "Copy stdio MCP configuration" }));
      await waitFor(() => expect(copyText).toHaveBeenCalledTimes(copies + 1));
      expect(copyText.mock.calls[copies][0] === displayed).toBe(true);
      copies++;
    }
    fireEvent.click(screen.getByRole("tab", { name: "Copilot app" }));
    expect(screen.queryByTestId("agent-connect-config-stdio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy stdio MCP configuration" })).toBeNull();
    expect(copyText).toHaveBeenCalledTimes(copies);
  });

  it("keeps optional CLI permissions collapsed and omits them for other clients", () => {
    render(<AgentConnectCard origin="https://markdoc.example.test" scope="comment" hideTokenStep />);
    expect(screen.getByTestId("agent-connect-allow-line")).not.toBeVisible();
    fireEvent.click(screen.getByText("Optional Copilot CLI permissions"));
    expect(screen.getByTestId("agent-connect-allow-line")).toBeVisible();
    expect(screen.getByTestId("agent-connect-scope-chip")).toHaveTextContent("comment");
    fireEvent.click(screen.getByRole("tab", { name: "Other MCP clients" }));
    expect(screen.queryByTestId("agent-connect-allow-line")).toBeNull();
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
  });

  it("binds simultaneous cards and tab replacements to their exact config, stdio, and install controls", () => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const view = renderDirect(
      <div>
        <section data-testid="card-a">
          <AgentConnectCard origin="https://card-a.markdoc.test" hideTokenStep />
        </section>
        <section data-testid="card-b">
          <AgentConnectCard origin="https://card-b.markdoc.test" hideTokenStep />
        </section>
      </div>,
    );
    const cardAHost = within(view.host).getByTestId("card-a");
    const cardBHost = within(view.host).getByTestId("card-b");
    const configA = captureCopyBlock(cardAHost, "agent-connect-config");
    const stdioA = captureCopyBlock(cardAHost, "agent-connect-config-stdio");
    const configB = captureCopyBlock(cardBHost, "agent-connect-config");

    act(() => {
      configA.click(copyBlockEvent(stdioA));
      stdioA.click(copyBlockEvent(configA));
      configA.click(copyBlockEvent(configB));
      configB.click(copyBlockEvent(configA));
    });
    expect(copyText).not.toHaveBeenCalled();

    fireEvent.click(configA.button);
    fireEvent.click(stdioA.button);
    fireEvent.click(configB.button);
    expect(copyText.mock.calls.map(([value]) => value)).toEqual([
      configA.pre.textContent,
      stdioA.pre.textContent,
      configB.pre.textContent,
    ]);

    fireEvent.click(within(cardAHost).getByRole("tab", { name: "Copilot app" }));
    const install = captureCopyBlock(cardAHost, "agent-connect-app-install");
    act(() => {
      configA.click(copyBlockEvent(install));
      stdioA.click(copyBlockEvent(install));
      install.click(copyBlockEvent(stdioA));
    });
    expect(copyText).toHaveBeenCalledTimes(3);
    fireEvent.click(install.button);
    expect(copyText).toHaveBeenLastCalledWith(COPILOT_APP_INSTALL);

    fireEvent.click(within(cardAHost).getByRole("tab", { name: "Copilot CLI" }));
    const currentConfig = captureCopyBlock(cardAHost, "agent-connect-config");
    act(() => {
      install.click(copyBlockEvent(currentConfig));
      currentConfig.click(copyBlockEvent(stdioA));
    });
    expect(copyText).toHaveBeenCalledTimes(4);
    fireEvent.click(currentConfig.button);
    expect(copyText).toHaveBeenCalledTimes(5);
    expect(copyText).toHaveBeenLastCalledWith(currentConfig.pre.textContent);
    expect(selectContents).not.toHaveBeenCalled();
  });
});

describe("CopyBlock exact control publications", () => {
  const baseBlock: CopyBlockProps = {
    value: "alpha setup value",
    label: "alpha setup",
    testId: "copy-value",
    copyTestId: "copy-button",
  };

  it("keeps config, stdio, and command successors exact through Strict Mode replay", async () => {
    vi.useFakeTimers();
    const families = [
      {
        value: "HTTP MCP configuration",
        label: "MCP configuration",
        testId: "strict-config-value",
        copyTestId: "strict-config-copy",
      },
      {
        value: "stdio MCP configuration",
        label: "stdio MCP configuration",
        testId: "strict-stdio-value",
        copyTestId: "strict-stdio-copy",
      },
      {
        value: COPILOT_APP_INSTALL,
        label: "Copilot app install command",
        testId: "strict-command-value",
        copyTestId: "strict-command-copy",
      },
    ] satisfies CopyBlockProps[];
    const attempts = families.map(() => deferred<boolean>());
    const active = new Map<string, CapturedCopyBlock>();
    copyText.mockImplementation((value: string) => {
      const block = active.get(value);
      if (!block) throw new Error(`No active CopyBlock for ${value}`);
      block.click(copyBlockEvent(block));
      block.click(copyBlockEvent(block));
      return attempts[copyText.mock.calls.length - 1]!.promise;
    });
    const view = renderDirect(
      <StrictMode>
        <section>
          {families.map((family) => <CopyBlock key={family.testId} {...family} />)}
        </section>
      </StrictMode>,
    );
    const blocks = families.map((family) =>
      captureCopyBlock(view.host, family.testId!, family.copyTestId));
    families.forEach((family, index) => active.set(family.value, blocks[index]!));
    const crossed = [
      copyBlockEvent(blocks[1]!),
      copyBlockEvent(blocks[2]!),
      copyBlockEvent(blocks[0]!),
    ];

    act(() => {
      blocks[0]!.click(crossed[0]!);
      blocks[1]!.click(crossed[1]!);
      blocks[2]!.click(crossed[2]!);
    });
    expect(copyText).not.toHaveBeenCalled();

    const accepted = blocks.map((block) => {
      const icon = block.button.firstElementChild;
      if (!icon) throw new Error("The Strict Mode CopyBlock button has no icon");
      return copyBlockEvent(block, block.button, icon, icon);
    });
    act(() => {
      blocks.forEach((block, index) => {
        block.click(accepted[index]!);
        block.click(accepted[index]!);
      });
    });

    expect(copyText.mock.calls.map(([value]) => value)).toEqual(
      families.map(({ value }) => value),
    );
    for (const event of [...crossed, ...accepted]) expectCopyBlockEventUntouched(event);

    await act(async () => {
      attempts[0]!.resolve(true);
      attempts[1]!.reject(new Error("clipboard unavailable"));
      attempts[2]!.resolve(true);
      await Promise.allSettled(attempts.map(({ promise }) => promise));
    });

    expect(within(view.host).getByTestId("strict-config-copy")).toHaveTextContent("Copied");
    expect(within(view.host).getByTestId("strict-stdio-copy")).toHaveTextContent("Select & press Ctrl+C");
    expect(within(view.host).getByTestId("strict-command-copy")).toHaveTextContent("Copied");
    expect(selectContents).toHaveBeenCalledExactlyOnceWith(blocks[1]!.pre);
    expect(vi.getTimerCount()).toBe(3);

    const current = families.map((family) =>
      captureCopyBlock(view.host, family.testId!, family.copyTestId));
    act(() => {
      blocks.forEach((block, index) => block.click(copyBlockEvent(current[index]!)));
      current[0]!.click(copyBlockEvent(current[1]!));
      current[1]!.click(copyBlockEvent(current[2]!));
      current[2]!.click(copyBlockEvent(current[0]!));
    });
    expect(copyText).toHaveBeenCalledTimes(3);

    act(() => vi.advanceTimersByTime(1500));
    expect(within(view.host).getByTestId("strict-config-copy")).toHaveTextContent("Copy");
    expect(within(view.host).getByTestId("strict-stdio-copy")).toHaveTextContent("Select & press Ctrl+C");
    expect(within(view.host).getByTestId("strict-command-copy")).toHaveTextContent("Copy");
    act(() => vi.advanceTimersByTime(500));
    expect(within(view.host).getByTestId("strict-stdio-copy")).toHaveTextContent("Copy");
  });

  it.each(["mutation and restoration", "detach and reinsert", "reorder and restoration"] as const)(
    "rejects Strict Mode publication %s history and keeps its equal successor independent",
    (scenario) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      const strictBlock = (key: string) => (
        <StrictMode>
          <section key={key}>
            <CopyBlock {...baseBlock} />
          </section>
        </StrictMode>
      );
      const view = renderDirect(strictBlock("a"));
      const stale = captureCopyBlock(view.host, "copy-value", "copy-button");
      const staleEvent = copyBlockEvent(stale);

      if (scenario === "mutation and restoration") {
        stale.pre.setAttribute("data-transient", "changed");
        stale.pre.removeAttribute("data-transient");
      } else if (scenario === "detach and reinsert") {
        const parent = stale.wrapper.parentNode;
        const next = stale.wrapper.nextSibling;
        if (!parent) throw new Error("The CopyBlock wrapper has no parent");
        stale.wrapper.remove();
        parent.insertBefore(stale.wrapper, next);
      } else {
        stale.wrapper.insertBefore(stale.button, stale.pre);
        stale.wrapper.append(stale.button);
      }

      act(() => stale.click(staleEvent));
      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectCopyBlockEventUntouched(staleEvent);

      act(() => view.root.render(strictBlock("b")));
      const current = captureCopyBlock(view.host, "copy-value", "copy-button");
      expect(current.wrapper).not.toBe(stale.wrapper);
      act(() => {
        stale.wrapperRef(current.wrapper);
        stale.preRef(current.pre);
        stale.buttonRef(current.button);
        stale.wrapperRef(null);
        stale.preRef(null);
        stale.buttonRef(null);
      });
      fireEvent.click(current.button);
      expect(copyText).toHaveBeenCalledExactlyOnceWith(baseBlock.value);
    },
  );

  it.each(
    [
      {
        family: "HTTP config",
        value: "HTTP MCP configuration",
        label: "MCP configuration",
        testId: "ancestor-config-value",
        copyTestId: "ancestor-config-copy",
      },
      {
        family: "stdio config",
        value: "stdio MCP configuration",
        label: "stdio MCP configuration",
        testId: "ancestor-stdio-value",
        copyTestId: "ancestor-stdio-copy",
      },
      {
        family: "install command",
        value: COPILOT_APP_INSTALL,
        label: "Copilot app install command",
        testId: "ancestor-command-value",
        copyTestId: "ancestor-command-copy",
      },
    ].flatMap((block) =>
      (["immediate parent", "higher wrapper"] as const).map((ancestor) => ({
        ...block,
        ancestor,
      }))),
  )(
    "permanently retires the $family publication after restored $ancestor placement",
    async ({ family, ancestor, ...block }) => {
      vi.useFakeTimers();
      const strictBlock = (key: string) => (
        <StrictMode>
          <div key={key} data-testid="copy-ancestor-outer">
            <span data-testid="copy-distant-sibling">unrelated</span>
            <span>adjacent</span>
            <div data-testid="copy-higher-wrapper">
              <section data-testid="copy-immediate-parent">
                <CopyBlock {...block} />
              </section>
            </div>
          </div>
        </StrictMode>
      );
      const view = renderDirect(strictBlock("stale"));
      const stale = captureCopyBlock(view.host, block.testId, block.copyTestId);
      const immediateParent = stale.wrapper.parentNode;
      const higherWrapper = immediateParent?.parentNode;
      const detached = ancestor === "immediate parent" ? immediateParent : higherWrapper;
      const parent = detached?.parentNode;
      const nextSibling = detached?.nextSibling ?? null;
      if (!detached || !parent) throw new Error(`The ${family} ${ancestor} is not connected`);

      parent.removeChild(detached);
      parent.insertBefore(detached, nextSibling);
      const staleEvent = copyBlockEvent(stale);
      act(() => {
        stale.click(staleEvent);
        vi.advanceTimersByTime(5000);
      });

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(stale.button).toHaveTextContent("Copy");
      expectCopyBlockEventUntouched(staleEvent);

      act(() => view.root.render(strictBlock("fresh")));
      const current = captureCopyBlock(view.host, block.testId, block.copyTestId);
      expect(current.wrapper).not.toBe(stale.wrapper);
      const outer = within(view.host).getByTestId("copy-ancestor-outer");
      const distant = within(view.host).getByTestId("copy-distant-sibling");
      outer.removeChild(distant);
      outer.insertBefore(distant, outer.firstChild);

      fireEvent.click(current.button);
      expect(copyText).toHaveBeenCalledExactlyOnceWith(block.value);
      await act(async () => {
        await Promise.resolve();
      });
      expect(current.button).toHaveTextContent("Copied");
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        stale.click(copyBlockEvent(stale));
        vi.advanceTimersByTime(1500);
      });
      expect(copyText).toHaveBeenCalledOnce();
      expect(current.button).toHaveTextContent("Copy");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["wrapper", "pre", "button"] as const)(
    "rejects repeated partial Strict Mode %s ref replay without authorizing it",
    (role) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      const view = renderDirect(
        <StrictMode>
          <CopyBlock {...baseBlock} />
        </StrictMode>,
      );
      const block = captureCopyBlock(view.host, "copy-value", "copy-button");
      const event = copyBlockEvent(block);
      const replayRef = (attach: boolean) => {
        if (role === "wrapper") block.wrapperRef(attach ? block.wrapper : null);
        else if (role === "pre") block.preRef(attach ? block.pre : null);
        else block.buttonRef(attach ? block.button : null);
      };

      act(() => {
        replayRef(false);
        replayRef(true);
        replayRef(false);
        replayRef(true);
        block.click(event);
      });

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectCopyBlockEventUntouched(event);
    },
  );

  it("isolates Strict Mode A/B clipboard settlements and copied-reset timers", async () => {
    vi.useFakeTimers();
    const attempts = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    copyText.mockImplementation(() => attempts[copyText.mock.calls.length - 1]!.promise);
    const strictBlock = (value: string) => (
      <StrictMode>
        <CopyBlock {...baseBlock} value={value} />
      </StrictMode>
    );
    const view = renderDirect(strictBlock("generation A"));
    const staleA = captureCopyBlock(view.host, "copy-value", "copy-button");
    fireEvent.click(staleA.button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith("generation A");

    act(() => view.root.render(strictBlock("generation B")));
    const generationB = captureCopyBlock(view.host, "copy-value", "copy-button");
    const staleWithCurrent = copyBlockEvent(generationB);
    act(() => staleA.click(staleWithCurrent));
    expect(copyText).toHaveBeenCalledOnce();
    expectCopyBlockEventUntouched(staleWithCurrent);

    await act(async () => {
      attempts[0]!.reject(new Error("late generation A failure"));
      await Promise.resolve();
    });
    expect(selectContents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(generationB.button).toHaveTextContent("Copy");

    fireEvent.click(generationB.button);
    expect(copyText).toHaveBeenLastCalledWith("generation B");
    await act(async () => {
      attempts[1]!.resolve(true);
      await attempts[1]!.promise;
    });
    expect(generationB.button).toHaveTextContent("Copied");
    expect(vi.getTimerCount()).toBe(1);

    act(() => view.root.render(strictBlock("generation A")));
    const currentA = captureCopyBlock(view.host, "copy-value", "copy-button");
    expect(currentA.button).toHaveTextContent("Copy");
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      generationB.click(copyBlockEvent(currentA));
      vi.advanceTimersByTime(5000);
    });
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(currentA.button).toHaveTextContent("Copy");

    fireEvent.click(currentA.button);
    expect(copyText).toHaveBeenLastCalledWith("generation A");
    act(() => view.root.render(<StrictMode><div /></StrictMode>));
    await act(async () => {
      attempts[2]!.reject(new Error("late unmounted generation A failure"));
      await Promise.resolve();
    });
    expect(selectContents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the rendered block and claims one exact native click before reentrant producer work", async () => {
    const settlement = deferred<boolean>();
    const currentRef: { value: CapturedCopyBlock | null } = { value: null };
    copyText.mockImplementation(() => {
      const current = currentRef.value;
      if (!current) throw new Error("The current CopyBlock was not captured");
      current.click(copyBlockEvent(current));
      return settlement.promise;
    });
    const view = renderDirect(<CopyBlock {...baseBlock} />);
    const current = captureCopyBlock(view.host, "copy-value", "copy-button");
    currentRef.value = current;
    const icon = current.button.firstElementChild;
    if (!icon) throw new Error("The CopyBlock button has no rendered icon");
    const event = copyBlockEvent(current, current.button, icon, icon);
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    expect(current.wrapper.children).toHaveLength(2);
    expect(current.wrapper.firstElementChild).toBe(current.pre);
    expect(current.wrapper.lastElementChild).toBe(current.button);
    expect(current.pre).toHaveTextContent(baseBlock.value);
    expect(current.button).toHaveAccessibleName(`Copy ${baseBlock.label}`);
    expect(current.button).toHaveTextContent("Copy");

    observer.takeRecords();
    act(() => {
      current.click(event);
      current.click(event);
    });

    expect(copyText).toHaveBeenCalledExactlyOnceWith(baseBlock.value);
    expect(selectContents).not.toHaveBeenCalled();
    expectCopyBlockEventUntouched(event);
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);

    await act(async () => {
      settlement.resolve(true);
      await settlement.promise;
    });
    expect(within(view.host).getByTestId("copy-button")).toHaveTextContent("Copied");
  });

  it("rejects fabricated, crossed, foreign, detached, disabled, mismatched, mutated, and injected sources without consuming current work", () => {
    vi.useFakeTimers();
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const view = renderDirect(<CopyBlock {...baseBlock} />);
    const current = captureCopyBlock(view.host, "copy-value", "copy-button");
    const icon = current.button.firstElementChild;
    if (!icon) throw new Error("The CopyBlock button has no rendered icon");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    const replacement = current.button.cloneNode(true) as HTMLButtonElement;
    document.body.append(foreign, replacement);
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const wrongPath = copyBlockEvent(current);
    Object.defineProperty(wrongPath.nativeEvent, "composedPath", {
      configurable: true,
      value: () => [current.button],
    });
    const events: CopyBlockEvent[] = [
      { ...copyBlockEvent(current), nativeEvent: new Event("click") },
      copyBlockEvent(current, current.button, current.button, current.button, 1),
      { ...copyBlockEvent(current), type: "pointerdown" },
      copyBlockEvent(current, current.button, icon, current.button),
      copyBlockEvent(current, foreign),
      copyBlockEvent(current, detached),
      copyBlockEvent(current, replacement),
      wrongPath,
    ];

    current.button.disabled = true;
    const disabled = copyBlockEvent(current);
    act(() => current.click(disabled));
    current.button.disabled = false;

    const injected = document.createElement("span");
    current.button.append(injected);
    const injectedEvent = copyBlockEvent(current, current.button, injected, injected);
    observer.takeRecords();
    act(() => {
      for (const event of events) current.click(event);
      current.click(injectedEvent);
    });

    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    for (const event of [disabled, injectedEvent, ...events]) expectCopyBlockEventUntouched(event);

    injected.remove();
    current.pre.textContent = "wrong setup value";
    const wrongValue = copyBlockEvent(current);
    observer.takeRecords();
    act(() => current.click(wrongValue));
    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(observer.takeRecords()).toHaveLength(0);
    expectCopyBlockEventUntouched(wrongValue);

    act(() => view.root.render(<CopyBlock {...baseBlock} value="restoring setup value" />));
    act(() => view.root.render(<CopyBlock {...baseBlock} />));
    const recovered = captureCopyBlock(view.host, "copy-value", "copy-button");
    fireEvent.click(recovered.button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(baseBlock.value);

    foreign.remove();
    replacement.remove();
  });

  it.each([
    [
      "value",
      baseBlock,
      { ...baseBlock, value: "beta setup value" },
    ],
    [
      "label",
      baseBlock,
      { ...baseBlock, label: "beta setup" },
    ],
    [
      "pre test ID",
      baseBlock,
      { ...baseBlock, testId: "copy-value-b" },
    ],
    [
      "button test ID",
      baseBlock,
      { ...baseBlock, copyTestId: "copy-button-b" },
    ],
    [
      "copy method on an equal-prop rerender",
      baseBlock,
      { ...baseBlock },
    ],
  ] satisfies [string, CopyBlockProps, CopyBlockProps][])(
    "retires the prior %s publication before parent layout work",
    (_name, blockA, blockB) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      let passiveCleanups = 0;
      const view = renderDirect(
        <CopyBlockBoundary block={blockA} onPassiveCleanup={() => passiveCleanups++} />,
      );
      const stale = captureCopyBlock(view.host, blockA.testId!, blockA.copyTestId);
      let currentAtBoundary!: CapturedCopyBlock;
      let staleEvent!: CopyBlockEvent;

      act(() => {
        view.root.render(
          <CopyBlockBoundary
            block={blockB}
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              currentAtBoundary = captureCopyBlock(view.host, blockB.testId!, blockB.copyTestId);
              expect(currentAtBoundary.wrapper).toBe(stale.wrapper);
              expect(currentAtBoundary.pre).toBe(stale.pre);
              expect(currentAtBoundary.button).toBe(stale.button);
              staleEvent = copyBlockEvent(currentAtBoundary);
              stale.click(staleEvent);
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectCopyBlockEventUntouched(staleEvent);

      const current = captureCopyBlock(view.host, blockB.testId!, blockB.copyTestId);
      fireEvent.click(current.button);
      expect(copyText).toHaveBeenCalledExactlyOnceWith(blockB.value);
    },
  );

  it.each(["crosses-before-current", "current-before-crosses"] as const)(
    "keeps simultaneous config, stdio, and install blocks independent with %s",
    (order) => {
      const values = {
        config: "http config",
        stdio: "stdio config",
        install: "app install",
      };
      const view = renderDirect(
        <div>
          <section data-testid="direct-config">
            <CopyBlock value={values.config} label="config" testId="config-value" copyTestId="config-copy" />
          </section>
          <section data-testid="direct-stdio">
            <CopyBlock value={values.stdio} label="stdio" testId="stdio-value" copyTestId="stdio-copy" />
          </section>
          <section data-testid="direct-install">
            <CopyBlock value={values.install} label="install" testId="install-value" copyTestId="install-copy" />
          </section>
        </div>,
      );
      const config = captureCopyBlock(within(view.host).getByTestId("direct-config"), "config-value", "config-copy");
      const stdio = captureCopyBlock(within(view.host).getByTestId("direct-stdio"), "stdio-value", "stdio-copy");
      const install = captureCopyBlock(within(view.host).getByTestId("direct-install"), "install-value", "install-copy");
      const rejectCrosses = () => {
        config.click(copyBlockEvent(stdio));
        stdio.click(copyBlockEvent(install));
        install.click(copyBlockEvent(config));
      };
      const acceptCurrent = () => {
        fireEvent.click(config.button);
        fireEvent.click(stdio.button);
        fireEvent.click(install.button);
      };

      if (order === "crosses-before-current") {
        act(rejectCrosses);
        acceptCurrent();
      } else {
        acceptCurrent();
        act(rejectCrosses);
      }

      expect(copyText.mock.calls.map(([value]) => value)).toEqual([
        values.config,
        values.stdio,
        values.install,
      ]);
      expect(selectContents).not.toHaveBeenCalled();
    },
  );

  it("retires copy methods across fallback, copied, and timer-driven idle presentations", async () => {
    vi.useFakeTimers();
    const attempts = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    copyText.mockImplementation(() => attempts[copyText.mock.calls.length - 1]!.promise);
    const view = renderDirect(<CopyBlock {...baseBlock} />);
    const idle = captureCopyBlock(view.host, "copy-value", "copy-button");

    fireEvent.click(idle.button);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(baseBlock.value);

    await act(async () => {
      attempts[0].reject(new Error("clipboard unavailable"));
      await Promise.resolve();
    });
    expect(selectContents).toHaveBeenCalledExactlyOnceWith(idle.pre);
    expect(within(view.host).getByTestId("copy-button")).toHaveTextContent("Select & press Ctrl+C");
    expect(vi.getTimerCount()).toBe(1);

    const fallback = captureCopyBlock(view.host, "copy-value", "copy-button");
    act(() => idle.click(copyBlockEvent(fallback)));
    expect(copyText).toHaveBeenCalledTimes(1);
    fireEvent.click(fallback.button);
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      attempts[1].resolve(true);
      await attempts[1].promise;
    });
    expect(within(view.host).getByTestId("copy-button")).toHaveTextContent("Copied");
    expect(vi.getTimerCount()).toBe(1);

    const copied = captureCopyBlock(view.host, "copy-value", "copy-button");
    act(() => fallback.click(copyBlockEvent(copied)));
    expect(copyText).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1500));
    expect(within(view.host).getByTestId("copy-button")).toHaveTextContent("Copy");

    const restored = captureCopyBlock(view.host, "copy-value", "copy-button");
    fireEvent.click(restored.button);
    expect(copyText).toHaveBeenCalledTimes(3);
    expect(copyText).toHaveBeenLastCalledWith(baseBlock.value);
  });

  it.each(["wrapper", "pre", "button"] as const)(
    "retires the publication when its committed %s ref is replaced",
    (role) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      const view = renderDirect(<CopyBlock {...baseBlock} />);
      const stale = captureCopyBlock(view.host, "copy-value", "copy-button");
      const replacement = stale[role].cloneNode(true) as HTMLElement;
      view.host.append(replacement);
      const exactEvent = copyBlockEvent(stale);
      const replacementEvent = copyBlockEvent(
        stale,
        role === "button" ? replacement : stale.button,
      );

      act(() => {
        if (role === "wrapper") stale.wrapperRef(replacement as HTMLDivElement);
        else if (role === "pre") stale.preRef(replacement as HTMLPreElement);
        else stale.buttonRef(replacement as HTMLButtonElement);
        stale.click(exactEvent);
        stale.click(replacementEvent);
      });

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectCopyBlockEventUntouched(exactEvent);
      expectCopyBlockEventUntouched(replacementEvent);
      replacement.remove();
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates equal-looking keyed remounts and late refs in %s order",
    async (order) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      let passiveCleanups = 0;
      const view = renderDirect(
        <CopyBlockBoundary block={baseBlock} onPassiveCleanup={() => passiveCleanups++} />,
      );
      const stale = captureCopyBlock(view.host, "copy-value", "copy-button");
      let currentAtBoundary!: CapturedCopyBlock;

      act(() => {
        view.root.render(
          <CopyBlockBoundary
            block={baseBlock}
            mount="replacement"
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              currentAtBoundary = captureCopyBlock(view.host, "copy-value", "copy-button");
              expect(currentAtBoundary.wrapper).not.toBe(stale.wrapper);
              expect(stale.wrapper.isConnected).toBe(false);
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      const current = captureCopyBlock(view.host, "copy-value", "copy-button");
      act(() => {
        stale.wrapperRef(current.wrapper);
        stale.preRef(current.pre);
        stale.buttonRef(current.button);
        stale.wrapperRef(null);
        stale.preRef(null);
        stale.buttonRef(null);
      });
      const rejectCrosses = () => {
        stale.click(copyBlockEvent(current));
        current.click(copyBlockEvent(stale));
      };
      if (order === "stale-before-current") {
        act(rejectCrosses);
        fireEvent.click(current.button);
      } else {
        fireEvent.click(current.button);
        act(rejectCrosses);
      }
      expect(copyText).toHaveBeenCalledExactlyOnceWith(baseBlock.value);

      act(() => {
        view.root.render(
          <CopyBlockBoundary
            block={baseBlock}
            mount="replacement"
            present={false}
            passiveVisit={2}
            boundary={2}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(current.wrapper.isConnected).toBe(false);
              current.click(copyBlockEvent(current));
            }}
          />,
        );
      });
      expect(copyText).toHaveBeenCalledOnce();

      await act(async () => {
        settlement.reject(new Error("late clipboard rejection"));
        await Promise.resolve();
      });
      expect(selectContents).not.toHaveBeenCalled();
    },
  );
});

describe("Copilot permission exact copy control", () => {
  it("keeps exact success and fallback controls usable through Strict Mode replay", async () => {
    vi.useFakeTimers();
    const attempts = [deferred<boolean>(), deferred<boolean>()];
    let reentry: { hint: CapturedPermissionHint; event: PermissionEvent } | null = null;
    copyText.mockImplementation(() => {
      if (!reentry) throw new Error("The current permission hint was not captured");
      reentry.hint.click(reentry.event);
      reentry.hint.click(permissionEvent(reentry.hint.button));
      return attempts[copyText.mock.calls.length - 1]!.promise;
    });
    const strictHint = (key: string) => (
      <StrictMode>
        <section key={key}>
          <CopilotPermissionsHint testIdPrefix="strict-hint" className="strict-class" scope="comment" />
        </section>
      </StrictMode>
    );
    const view = renderDirect(strictHint("a"));
    const stale = capturePermissionHint("strict-hint");
    const staleIcon = stale.button.firstElementChild;
    if (!staleIcon) throw new Error("The permission button has no rendered icon");
    const successEvent = permissionEvent(stale.button, staleIcon, staleIcon);
    reentry = { hint: stale, event: successEvent };

    act(() => {
      stale.click(successEvent);
      stale.click(successEvent);
    });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(copilotAllowToolLine(undefined, "comment"));
    expect(selectContents).not.toHaveBeenCalled();
    expectEventUntouched(successEvent);

    await act(async () => {
      attempts[0].resolve(true);
      await attempts[0].promise;
    });
    expect(screen.getByTestId("strict-hint-allow-copy")).toHaveTextContent("Copied");

    act(() => view.root.render(strictHint("b")));
    const current = capturePermissionHint("strict-hint");
    expect(current.root).not.toBe(stale.root);
    expect(current.pre).not.toBe(stale.pre);
    expect(current.button).not.toBe(stale.button);

    act(() => {
      stale.rootRef(current.root);
      stale.preRef(current.pre);
      stale.buttonRef(current.button);
      current.rootRef(stale.root);
      current.preRef(stale.pre);
      current.buttonRef(stale.button);
      stale.rootRef(null);
      stale.preRef(null);
      stale.buttonRef(null);
    });

    const currentIcon = current.button.firstElementChild;
    if (!currentIcon) throw new Error("The current permission button has no rendered icon");
    const fallbackEvent = permissionEvent(current.button, currentIcon, currentIcon);
    const crossedEvent = permissionEvent(stale.button);
    reentry = { hint: current, event: fallbackEvent };
    act(() => {
      stale.click(fallbackEvent);
      current.click(crossedEvent);
      current.click(fallbackEvent);
      current.click(fallbackEvent);
    });
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith(copilotAllowToolLine(undefined, "comment"));
    expectEventUntouched(fallbackEvent);
    expectEventUntouched(crossedEvent);

    await act(async () => {
      attempts[1].reject(new Error("clipboard unavailable"));
      await Promise.resolve();
    });
    expect(selectContents).toHaveBeenCalledExactlyOnceWith(current.pre);
    expect(screen.getByTestId("strict-hint-allow-copy")).toHaveTextContent("Select & press Ctrl+C");
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["mutation and restoration", "immediate parent restoration", "higher wrapper restoration"] as const)(
    "permanently retires direct-root Strict Mode publication history after %s",
    async (scenario) => {
      vi.useFakeTimers();
      const strictHint = (key: string) => (
        <StrictMode>
          <div key={key} data-testid="permission-ancestor-outer">
            <span data-testid="permission-distant-sibling">unrelated</span>
            <span>adjacent</span>
            <div data-testid="permission-higher-wrapper">
              <section data-testid="permission-immediate-parent">
                <CopilotPermissionsHint testIdPrefix="placement-hint" scope="comment" />
              </section>
            </div>
          </div>
        </StrictMode>
      );
      const view = renderDirect(strictHint("stale"));
      const stale = capturePermissionHint("placement-hint");

      if (scenario === "mutation and restoration") {
        stale.pre.setAttribute("data-transient", "changed");
        stale.pre.removeAttribute("data-transient");
      } else {
        const detached = within(view.host).getByTestId(
          scenario === "immediate parent restoration"
            ? "permission-immediate-parent"
            : "permission-higher-wrapper",
        );
        const parent = detached.parentNode;
        const nextSibling = detached.nextSibling;
        if (!parent) throw new Error(`The ${scenario} target is not connected`);
        parent.removeChild(detached);
        parent.insertBefore(detached, nextSibling);
      }

      const firstStaleEvent = permissionEvent(stale.button);
      const secondStaleEvent = permissionEvent(stale.button);
      act(() => {
        stale.click(firstStaleEvent);
        stale.click(secondStaleEvent);
        vi.advanceTimersByTime(5000);
      });

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expect(stale.button).toHaveTextContent("Copy");
      expect(vi.getTimerCount()).toBe(0);
      expectEventUntouched(firstStaleEvent);
      expectEventUntouched(secondStaleEvent);

      act(() => view.root.render(strictHint("fresh")));
      const current = capturePermissionHint("placement-hint");
      expect(current.root).not.toBe(stale.root);
      const outer = within(view.host).getByTestId("permission-ancestor-outer");
      const distant = within(view.host).getByTestId("permission-distant-sibling");
      outer.removeChild(distant);
      outer.insertBefore(distant, outer.firstChild);

      const currentEvent = permissionEvent(current.button);
      await act(async () => {
        current.click(currentEvent);
        await Promise.resolve();
      });

      expect(copyText).toHaveBeenCalledExactlyOnceWith(copilotAllowToolLine(undefined, "comment"));
      expect(selectContents).not.toHaveBeenCalled();
      expect(current.button).toHaveTextContent("Copied");
      expect(vi.getTimerCount()).toBe(1);
      expectEventUntouched(currentEvent);

      act(() => {
        stale.click(permissionEvent(stale.button));
        vi.advanceTimersByTime(1500);
      });
      expect(copyText).toHaveBeenCalledOnce();
      expect(current.button).toHaveTextContent("Copy");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves the rendered hint and claims an exact event only once", async () => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const line = copilotAllowToolLine(undefined, "comment");
    const view = renderDirect(<CopilotPermissionsHint testIdPrefix="direct-hint" className="extra-class" scope="comment" />);
    const hint = capturePermissionHint("direct-hint");
    const event = permissionEvent(hint.button);
    const observer = observeMutations(view.host);

    expect(hint.root).toHaveClass("extra-class");
    expect(hint.pre).toHaveTextContent(line);
    expect(hint.button).toHaveAccessibleName("Copy the Copilot CLI allow-tool line");
    expect(hint.button).toHaveTextContent("Copy");
    expect(screen.getByTestId("direct-hint-scope-chip")).toHaveTextContent("comment");

    observer.takeRecords();
    act(() => {
      hint.click(event);
      hint.click(event);
    });

    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith(line);
    expect(selectContents).not.toHaveBeenCalled();
    expectEventUntouched(event);
    expect(observer.takeRecords()).toHaveLength(0);

    await act(async () => {
      settlement.resolve(true);
      await settlement.promise;
    });
    expect(screen.getByTestId("direct-hint-allow-copy")).toHaveTextContent("Copied");
  });

  it("rejects fabricated, crossed, foreign, detached, disabled, mutated, and replacement sources without observable work", () => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const firstView = renderDirect(<CopilotPermissionsHint testIdPrefix="first-hint" scope="read" />);
    renderDirect(<CopilotPermissionsHint testIdPrefix="sibling-hint" scope="comment" />);
    const first = capturePermissionHint("first-hint");
    const sibling = capturePermissionHint("sibling-hint");
    const icon = first.button.firstElementChild;
    if (!icon) throw new Error("The permission button has no rendered icon");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(firstView.host);

    const expectEventInert = (event: PermissionEvent) => {
      const markup = firstView.host.innerHTML;
      observer.takeRecords();
      focus.mockClear();
      act(() => first.click(event));
      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectEventUntouched(event);
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(firstView.host.innerHTML).toBe(markup);
      return event;
    };
    const expectInert = (source: HTMLButtonElement) =>
      expectEventInert(permissionEvent(source));

    expectEventInert({ ...permissionEvent(first.button), nativeEvent: new Event("click") });
    expectEventInert(permissionEvent(first.button, first.button, first.button, 1));
    expectEventInert(permissionEvent(first.button, icon, first.button));
    expectEventInert(permissionEvent(first.button, first.button, first.button, 0, "pointerdown"));
    expectInert(sibling.button);
    expectInert(foreign);
    expectInert(detached);
    first.button.disabled = true;
    expectInert(first.button);
    first.button.disabled = false;

    const injected = document.createElement("span");
    first.button.append(injected);
    expectEventInert(permissionEvent(first.button, injected, injected));
    injected.remove();

    const replacement = first.button.cloneNode(true) as HTMLButtonElement;
    first.button.replaceWith(replacement);
    observer.takeRecords();
    expectInert(replacement);
    expectInert(first.button);

    foreign.remove();
  });

  it.each(["root", "pre", "button"] as const)(
    "does not promote a partial %s detach and reinsert callback sequence",
    (role) => {
      const view = renderDirect(
        <CopilotPermissionsHint testIdPrefix={`partial-${role}`} scope="comment" />,
      );
      const hint = capturePermissionHint(`partial-${role}`);
      const event = permissionEvent(hint.button);
      const observer = observeMutations(view.host);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");

      observer.takeRecords();
      act(() => {
        if (role === "root") {
          hint.rootRef(null);
          hint.rootRef(hint.root);
        } else if (role === "pre") {
          hint.preRef(null);
          hint.preRef(hint.pre);
        } else {
          hint.buttonRef(null);
          hint.buttonRef(hint.button);
        }
        hint.click(event);
      });

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expectEventUntouched(event);
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
    },
  );

  it.each([
    [
      "test ID prefix",
      { testIdPrefix: "props-a", className: "class-a", scope: "read" as const },
      { testIdPrefix: "props-b", className: "class-a", scope: "read" as const },
    ],
    [
      "class name",
      { testIdPrefix: "props", className: "class-a", scope: "read" as const },
      { testIdPrefix: "props", className: "class-b", scope: "read" as const },
    ],
    [
      "scope and allow line",
      { testIdPrefix: "props", className: "class-a", scope: "read" as const },
      { testIdPrefix: "props", className: "class-a", scope: "comment" as const },
    ],
    [
      "scope with an equal allow line",
      { testIdPrefix: "props", className: "class-a" },
      { testIdPrefix: "props", className: "class-a", scope: "full" as const },
    ],
  ])("retires the prior publication at the parent layout boundary for a %s change", (_name, hintA, hintB) => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    let passiveCleanups = 0;
    const view = renderDirect(
      <PermissionHintBoundary hint={hintA} onPassiveCleanup={() => passiveCleanups++} />,
    );
    const stale = capturePermissionHint(hintA.testIdPrefix);
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    let currentAtBoundary!: CapturedPermissionHint;
    let staleEvent!: PermissionEvent;

    act(() => {
      view.root.render(
        <PermissionHintBoundary
          hint={hintB}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            currentAtBoundary = capturePermissionHint(hintB.testIdPrefix);
            expect(currentAtBoundary.root).toBe(stale.root);
            expect(currentAtBoundary.pre).toBe(stale.pre);
            expect(currentAtBoundary.button).toBe(stale.button);
            observer.takeRecords();
            focus.mockClear();
            staleEvent = permissionEvent(currentAtBoundary.button);
            stale.click(staleEvent);
            expect(observer.takeRecords()).toHaveLength(0);
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expectEventUntouched(staleEvent);
    expect(focus).not.toHaveBeenCalled();

    const current = capturePermissionHint(hintB.testIdPrefix);
    expect(current.click).toBe(currentAtBoundary.click);
    const currentEvent = permissionEvent(current.button);
    act(() => current.click(currentEvent));
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith(copilotAllowToolLine(undefined, hintB.scope ?? "full"));
    expectEventUntouched(currentEvent);
  });

  it("retires methods and labels across controlled rejection and timer settlements", async () => {
    vi.useFakeTimers();
    const attempts = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    copyText.mockImplementation(() => attempts[copyText.mock.calls.length - 1]!.promise);
    renderDirect(<CopilotPermissionsHint testIdPrefix="settlement-hint" scope="comment" />);
    const expectedLine = copilotAllowToolLine(undefined, "comment");
    const initial = capturePermissionHint("settlement-hint");
    const initialEvent = permissionEvent(initial.button);

    act(() => initial.click(initialEvent));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenLastCalledWith(expectedLine);

    await act(async () => {
      attempts[0].reject(new Error("clipboard rejected"));
      await Promise.resolve();
    });
    expect(selectContents).toHaveBeenCalledOnce();
    expect(selectContents).toHaveBeenLastCalledWith(initial.pre);
    expect(screen.getByTestId("settlement-hint-allow-copy")).toHaveTextContent("Select & press Ctrl+C");
    expect(vi.getTimerCount()).toBe(1);

    const firstFallback = capturePermissionHint("settlement-hint");
    const staleFallbackEvent = permissionEvent(firstFallback.button);
    act(() => initial.click(staleFallbackEvent));
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expectEventUntouched(staleFallbackEvent);

    act(() => firstFallback.click(permissionEvent(firstFallback.button)));
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith(expectedLine);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      attempts[1].reject(new Error("clipboard rejected again"));
      await Promise.resolve();
    });
    expect(selectContents).toHaveBeenCalledTimes(2);
    expect(selectContents).toHaveBeenLastCalledWith(firstFallback.pre);
    expect(vi.getTimerCount()).toBe(1);

    const secondFallback = capturePermissionHint("settlement-hint");
    act(() => secondFallback.click(permissionEvent(secondFallback.button)));
    expect(copyText).toHaveBeenCalledTimes(3);
    expect(copyText).toHaveBeenLastCalledWith(expectedLine);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      attempts[2].resolve(true);
      await attempts[2].promise;
    });
    expect(selectContents).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("settlement-hint-allow-copy")).toHaveTextContent("Copied");
    expect(vi.getTimerCount()).toBe(1);

    const copied = capturePermissionHint("settlement-hint");
    act(() => secondFallback.click(permissionEvent(copied.button)));
    expect(copyText).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByTestId("settlement-hint-allow-copy")).toHaveTextContent("Copy");
    expect(vi.getTimerCount()).toBe(0);

    const idle = capturePermissionHint("settlement-hint");
    act(() => idle.click(permissionEvent(idle.button)));
    expect(copyText).toHaveBeenCalledTimes(4);
    expect(copyText).toHaveBeenLastCalledWith(expectedLine);
  });

  it.each(["root", "pre", "button"] as const)("retires the exact hierarchy when its %s ref is replaced", (role) => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const view = renderDirect(<CopilotPermissionsHint testIdPrefix={`replace-${role}`} scope="read" />);
    const hint = capturePermissionHint(`replace-${role}`);
    const replacement = hint[role].cloneNode(true) as HTMLElement;
    view.host.append(replacement);
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    observer.takeRecords();
    act(() => {
      if (role === "root") hint.rootRef(replacement as HTMLDivElement);
      else if (role === "pre") hint.preRef(replacement as HTMLPreElement);
      else hint.buttonRef(replacement as HTMLButtonElement);
    });
    observer.takeRecords();
    const exactEvent = permissionEvent(hint.button);
    const replacementEvent = permissionEvent(role === "button" ? replacement as HTMLButtonElement : hint.button);
    act(() => {
      hint.click(exactEvent);
      hint.click(replacementEvent);
    });

    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expectEventUntouched(exactEvent);
    expectEventUntouched(replacementEvent);
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    replacement.remove();
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-looking remount in %s order and retires it before removal",
    async (order) => {
      const settlement = deferred<boolean>();
      copyText.mockReturnValue(settlement.promise);
      const hint = { testIdPrefix: "remount-hint", className: "same-class", scope: "comment" as const };
      let passiveCleanups = 0;
      const view = renderDirect(
        <PermissionHintBoundary hint={hint} onPassiveCleanup={() => passiveCleanups++} />,
      );
      const stale = capturePermissionHint("remount-hint");
      const observer = observeMutations(view.host);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      let currentAtBoundary!: CapturedPermissionHint;

      act(() => {
        view.root.render(
          <PermissionHintBoundary
            hint={hint}
            mount="replacement"
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              currentAtBoundary = capturePermissionHint("remount-hint");
              expect(currentAtBoundary.root).not.toBe(stale.root);
              expect(currentAtBoundary.pre).not.toBe(stale.pre);
              expect(currentAtBoundary.button).not.toBe(stale.button);
              expect(stale.root.isConnected).toBe(false);
              observer.takeRecords();
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      const current = capturePermissionHint("remount-hint");
      expect(current.click).toBe(currentAtBoundary.click);
      const staleWithCurrent = permissionEvent(current.button);
      const currentWithStale = permissionEvent(stale.button);
      const accepted = permissionEvent(current.button);
      observer.takeRecords();
      focus.mockClear();
      act(() => {
        if (order === "stale-before-current") {
          stale.click(staleWithCurrent);
          current.click(currentWithStale);
          current.click(accepted);
        } else {
          current.click(accepted);
          current.click(currentWithStale);
          stale.click(staleWithCurrent);
        }
      });

      expect(copyText).toHaveBeenCalledOnce();
      expect(copyText).toHaveBeenCalledWith(copilotAllowToolLine(undefined, "comment"));
      expect(selectContents).not.toHaveBeenCalled();
      expectEventUntouched(staleWithCurrent);
      expectEventUntouched(currentWithStale);
      expectEventUntouched(accepted);
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);

      let removalEvent!: PermissionEvent;
      act(() => {
        view.root.render(
          <PermissionHintBoundary
            hint={hint}
            mount="replacement"
            present={false}
            passiveVisit={2}
            boundary={2}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(current.root.isConnected).toBe(false);
              observer.takeRecords();
              removalEvent = permissionEvent(current.button);
              current.click(removalEvent);
              expect(observer.takeRecords()).toHaveLength(0);
            }}
          />,
        );
      });
      act(() => current.click(removalEvent));
      expect(copyText).toHaveBeenCalledOnce();
      expect(selectContents).not.toHaveBeenCalled();
      expectEventUntouched(removalEvent);

      await act(async () => {
        settlement.reject(new Error("late rejection"));
        await Promise.resolve();
      });
      expect(selectContents).not.toHaveBeenCalled();
    },
  );

  it("keeps a reused current hierarchy after late old-ref attach and detach callbacks", async () => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const hint = { testIdPrefix: "reused-hint", className: "same-class", scope: "comment" as const };
    let passiveCleanups = 0;
    const view = renderDirect(
      <PermissionHintBoundary hint={hint} onPassiveCleanup={() => passiveCleanups++} />,
    );
    const stale = capturePermissionHint("reused-hint");
    let currentAtBoundary!: CapturedPermissionHint;
    let staleEvent!: PermissionEvent;

    act(() => {
      view.root.render(
        <PermissionHintBoundary
          hint={hint}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            currentAtBoundary = capturePermissionHint("reused-hint");
            expect(currentAtBoundary.root).toBe(stale.root);
            expect(currentAtBoundary.pre).toBe(stale.pre);
            expect(currentAtBoundary.button).toBe(stale.button);
            stale.rootRef(currentAtBoundary.root);
            stale.preRef(currentAtBoundary.pre);
            stale.buttonRef(currentAtBoundary.button);
            stale.rootRef(null);
            stale.preRef(null);
            stale.buttonRef(null);
            staleEvent = permissionEvent(currentAtBoundary.button);
            stale.click(staleEvent);
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expectEventUntouched(staleEvent);

    const current = capturePermissionHint("reused-hint");
    const accepted = permissionEvent(current.button);
    act(() => current.click(accepted));
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith(copilotAllowToolLine(undefined, "comment"));

    await act(async () => {
      settlement.reject(new Error("clipboard rejected"));
      await Promise.resolve();
    });
    expect(selectContents).toHaveBeenCalledOnce();
    expect(selectContents).toHaveBeenCalledWith(current.pre);
  });
});

describe("AgentConnectCard automatic tab navigation", () => {
  const labels = ["Copilot CLI", "VS Code", "Other MCP clients", "Copilot app"] as const;
  const panelText = {
    "Copilot CLI": "~/.copilot/mcp-config.json",
    "VS Code": ".vscode/mcp.json",
    "Other MCP clients": "your client's MCP configuration",
    "Copilot app": "canvas extension",
  } as const;
  const arrowCases = labels.flatMap((from, index) => [
    {
      key: "ArrowDown",
      from,
      to: labels[(index + 1) % labels.length]!,
    },
    {
      key: "ArrowRight",
      from,
      to: labels[(index + 1) % labels.length]!,
    },
    {
      key: "ArrowUp",
      from,
      to: labels[(index - 1 + labels.length) % labels.length]!,
    },
    {
      key: "ArrowLeft",
      from,
      to: labels[(index - 1 + labels.length) % labels.length]!,
    },
  ]);

  it.each(arrowCases)(
    "moves $key from $from to $to once without scrolling or activating setup controls",
    ({ key, from, to }) => {
      const create = vi.fn();
      const dismiss = vi.fn();
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const location = window.location.href;
      renderDirect(
        <StrictMode>
          <AgentConnectCard
            origin="https://markdoc.test"
            scope="comment"
            onCreateToken={create}
            onDismiss={dismiss}
          />
        </StrictMode>,
      );
      expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual(labels);
      fireEvent.click(tab(from));
      const source = tab(from);
      const destination = tab(to);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const scroll = { x: window.scrollX, y: window.scrollY };

      const event = dispatchTabKey(source, key);

      expect(event.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(focus.mock.contexts[0]).toBe(destination);
      expect(destination).toHaveFocus();
      expectSelected(to);
      expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
      expect(screen.getByRole("tabpanel")).toHaveTextContent(panelText[to]);
      expect(window.scrollX).toBe(scroll.x);
      expect(window.scrollY).toBe(scroll.y);
      expect(create).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(copyText).not.toHaveBeenCalled();
      expect(window.location.href).toBe(location);
    },
  );

  it.each([
    ["Home", "Copilot app", "Copilot CLI"],
    ["End", "Copilot CLI", "Copilot app"],
  ] as const)("keeps the %s destination from %s at %s", (key, from, to) => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    fireEvent.click(tab(from));
    const source = tab(from);
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = dispatchTabKey(source, key);

    expect(event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(tab(to));
    expectSelected(to);
    expect(screen.getByRole("tabpanel")).toHaveTextContent(panelText[to]);
  });

  it("keeps native click activation and one roving tab stop", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );

    for (const label of labels) {
      focus.mockClear();
      fireEvent.click(tab(label));
      expectSelected(label);
      expect(screen.getByRole("tabpanel")).toHaveTextContent(panelText[label]);
      expect(focus).not.toHaveBeenCalled();
    }
    expect(copyText).not.toHaveBeenCalled();
  });

  it("leaves Tab, Enter, Space, click, and setup controls on their native paths", () => {
    const create = vi.fn();
    const dismiss = vi.fn();
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard
          origin="https://markdoc.test"
          onCreateToken={create}
          onDismiss={dismiss}
        />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    for (const key of ["Tab", "Enter", " "]) {
      const event = dispatchTabKey(source, key);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");

    fireEvent.click(tab("VS Code"));
    fireEvent.click(screen.getByTestId("agent-connect-create-token"));
    fireEvent.click(screen.getByTestId("agent-connect-dismiss"));
    expectSelected("VS Code");
    expect(create).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe("AgentConnectCard exact keyboard publication", () => {
  it("accepts distinct public capture and bubble wrappers with unrelated prototypes and methods", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    const destination = tab("VS Code");
    const capturePrototype = Object.freeze({ boundary: "capture" });
    const bubblePrototype = Object.freeze({ boundary: "bubble" });
    const captureMethods = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      isDefaultPrevented: vi.fn(() => false),
      isPropagationStopped: vi.fn(() => false),
    };
    const bubbleMethods = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      isDefaultPrevented: vi.fn(() => false),
      isPropagationStopped: vi.fn(() => false),
    };
    let captureWrapper: ReactKeyboardEvent<HTMLDivElement> | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLButtonElement> | null = null;
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const event = tabKeyEvent(source, "ArrowRight");

    dispatchTabKeyWithPublicWrappers(
      source,
      event,
      (current) => {
        captureWrapper = publicTabWrapper(
          current,
          capturePrototype,
          captureMethods,
        );
        return captureWrapper;
      },
      (current) => {
        bubbleWrapper = publicTabWrapper(
          current,
          bubblePrototype,
          bubbleMethods,
        );
        return bubbleWrapper;
      },
    );

    expect(captureWrapper).not.toBe(bubbleWrapper);
    expect(Object.getPrototypeOf(captureWrapper)).toBe(capturePrototype);
    expect(Object.getPrototypeOf(bubbleWrapper)).toBe(bubblePrototype);
    expect(captureMethods.isDefaultPrevented).toHaveBeenCalled();
    expect(captureMethods.isPropagationStopped).toHaveBeenCalled();
    expect(bubbleMethods.isDefaultPrevented).toHaveBeenCalled();
    expect(bubbleMethods.isPropagationStopped).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toBe(destination);
    expectSelected("VS Code");
    expect(destination).toHaveFocus();
  });

  it.each([
    ["capture", "isDefaultPrevented"],
    ["capture", "isPropagationStopped"],
    ["bubble", "isDefaultPrevented"],
    ["bubble", "isPropagationStopped"],
  ] as const)(
    "rejects %s wrapper %s identity drift and accepts a clean successor",
    (phase, methodName) => {
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      renderDirect(
        <StrictMode>
          <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
        </StrictMode>,
      );
      const source = tab("Copilot CLI");
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const event = tabKeyEvent(source, "ArrowDown");
      const methods = (wrapper: ReactKeyboardEvent<HTMLElement>) => {
        const stable = {
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          isDefaultPrevented: vi.fn(() => false),
          isPropagationStopped: vi.fn(() => false),
        };
        const original = vi.fn(() => {
          Object.defineProperty(wrapper, methodName, {
            configurable: true,
            value: vi.fn(() => false),
          });
          return false;
        });
        stable[methodName] = original;
        return stable;
      };
      const wrap = <T extends HTMLElement>(
        current: ReactKeyboardEvent<T>,
        currentPhase: "capture" | "bubble",
      ) => {
        const wrapper = publicTabWrapper(
          current,
          Object.freeze({ currentPhase }),
          {
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            isDefaultPrevented: vi.fn(() => false),
            isPropagationStopped: vi.fn(() => false),
          },
        );
        if (phase === currentPhase) {
          const drifting = methods(wrapper);
          Object.assign(wrapper, drifting);
        }
        return wrapper;
      };

      dispatchTabKeyWithPublicWrappers(
        source,
        event,
        (current) => wrap(current, "capture"),
        (current) => wrap(current, "bubble"),
      );

      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectSelected("Copilot CLI");
      expect(source).toHaveFocus();
      expect(copyText).not.toHaveBeenCalled();

      const accepted = dispatchTabKey(source, "ArrowDown");
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expectSelected("VS Code");
      expect(tab("VS Code")).toHaveFocus();
    },
  );

  it("binds exact facade listener methods to the backing Window and rejects drift and lookalikes", async () => {
    const realAdd = window.addEventListener;
    const realRemove = window.removeEventListener;
    const add = vi.fn(function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      Reflect.apply(realAdd, window, [type, listener, options]);
    });
    const remove = vi.fn(function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      Reflect.apply(realRemove, window, [type, listener, options]);
    });
    let currentAdd: Window["addEventListener"] = add;
    let currentRemove: Window["removeEventListener"] = remove;
    const facade = new Proxy(window, {
      get(target, property) {
        if (property === "addEventListener") return currentAdd;
        if (property === "removeEventListener") return currentRemove;
        if (property === "setTimeout") return target.setTimeout.bind(target);
        if (property === "clearTimeout") return target.clearTimeout.bind(target);
        return Reflect.get(target, property, target);
      },
    });
    vi.spyOn(document, "defaultView", "get").mockReturnValue(facade);
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    const listenerCall = add.mock.calls.find(
      ([type, , options]) => type === "keydown" && options === true,
    );
    const listener = listenerCall?.[1];
    if (typeof listener !== "function") {
      throw new Error("The exact Window key listener was not published");
    }
    const structuralWindow = {
      document,
      window: null as object | null,
      addEventListener: add,
      removeEventListener: remove,
    };
    structuralWindow.window = structuralWindow;
    const lookalikeEvent = tabKeyEvent(source, "ArrowDown");
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    Reflect.apply(listener, structuralWindow, [lookalikeEvent]);
    expect(lookalikeEvent.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");

    currentAdd = vi.fn();
    const drifted = dispatchTabKey(source, "ArrowDown");
    expect(drifted.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");

    currentAdd = add;
    currentRemove = vi.fn();
    const removeDrifted = dispatchTabKey(source, "ArrowDown");
    expect(removeDrifted.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");

    currentRemove = remove;
    const accepted = dispatchTabKey(source, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectSelected("VS Code");
    expect(tab("VS Code")).toHaveFocus();

    const exactListeners = add.mock.calls
      .filter(([type, , options]) => type === "keydown" && options === true)
      .map(([, callback]) => callback);
    await act(() => {
      view.root.render(<StrictMode><div /></StrictMode>);
    });
    const removedListeners = remove.mock.calls
      .filter(([type, , options]) => type === "keydown" && options === true)
      .map(([, callback]) => callback);
    expect(removedListeners).toEqual(expect.arrayContaining(exactListeners));
  });

  it.each([
    ["Control", { ctrlKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["composition", { isComposing: true }],
    ["repeat", { repeat: true }],
    ["non-bubbling", { bubbles: false }],
    ["non-cancelable", { cancelable: false }],
  ] as const)("rejects a %s keydown without prevention, selection, or focus", (_name, init) => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const event = dispatchTabKey(source, "ArrowDown", init);

    expect(event.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");
    expect(source).toHaveFocus();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("rejects unsupported, previously prevented, and propagation-stopped keydowns without consuming a clean event", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    source.focus();
    focus.mockClear();

    const unsupported = dispatchTabKey(source, "PageDown");
    const prevented = tabKeyEvent(source, "ArrowDown");
    prevented.preventDefault();
    preventDefault.mockClear();
    dispatchTabKey(source, prevented);
    const stopped = tabKeyEvent(source, "ArrowDown");
    stopped.stopPropagation();
    dispatchTabKey(source, stopped);

    expect(unsupported.defaultPrevented).toBe(false);
    expect(prevented.defaultPrevented).toBe(true);
    expect(stopped.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");

    const accepted = dispatchTabKey(source, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expectSelected("VS Code");
    expect(tab("VS Code")).toHaveFocus();
  });

  it("rejects fabricated, crossed, foreign-realm, and replayed events without consuming another action", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderDirect(
      <StrictMode>
        <section data-testid="keyboard-card-a">
          <AgentConnectCard origin="https://a.markdoc.test" hideTokenStep />
        </section>
        <section data-testid="keyboard-card-b">
          <AgentConnectCard origin="https://b.markdoc.test" hideTokenStep />
        </section>
      </StrictMode>,
    );
    const cardA = within(view.host).getByTestId("keyboard-card-a");
    const cardB = within(view.host).getByTestId("keyboard-card-b");
    const source = within(cardA).getByRole("tab", { name: "Copilot CLI" }) as HTMLButtonElement;
    const crossed = within(cardB).getByRole("tab", { name: "Copilot CLI" }) as HTMLButtonElement;
    const handler = reactHandler<KeyHandler>(source, "onKeyDown");
    const fabricatedPreventDefault = vi.fn();
    const iframe = document.createElement("iframe");
    view.host.append(iframe);
    const foreignView = iframe.contentWindow;
    const foreignEvent = iframe.contentDocument?.createEvent("KeyboardEvent");
    if (!foreignEvent) throw new Error("The iframe has no keyboard event");
    foreignEvent.initKeyboardEvent(
      "keydown",
      true,
      true,
      foreignView,
      "ArrowDown",
    );

    act(() => {
      handler({
        key: "ArrowDown",
        currentTarget: source,
        preventDefault: fabricatedPreventDefault,
      });
      handler({
        key: "ArrowDown",
        currentTarget: crossed,
        preventDefault: fabricatedPreventDefault,
        nativeEvent: foreignEvent,
      } as unknown as Parameters<KeyHandler>[0]);
    });
    expect(fabricatedPreventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(within(cardA).getByRole("tab", { name: "Copilot CLI" })).toHaveAttribute("aria-selected", "true");

    source.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const accepted = tabKeyEvent(source, "ArrowDown");
    dispatchTabKey(source, accepted);
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(within(cardA).getByRole("tab", { name: "VS Code" })).toHaveFocus();

    preventDefault.mockClear();
    focus.mockClear();
    dispatchTabKey(source, accepted);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(within(cardA).getByRole("tab", { name: "VS Code" })).toHaveAttribute("aria-selected", "true");
    expect(copyText).not.toHaveBeenCalled();
    iframe.remove();
  });

  it("uses the committed realm's active-element, prevention, and focus intrinsics", () => {
    const activeElement = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "activeElement",
    )?.get;
    if (!activeElement) throw new Error("The document has no activeElement getter");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    const destination = tab("VS Code");
    source.focus();
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault")
      .mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(() => {});
    vi.spyOn(Document.prototype, "activeElement", "get").mockReturnValue(null);

    const event = dispatchTabKey(source, "ArrowDown");

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(Reflect.apply(activeElement, document, [])).toBe(destination);
    expectSelected("VS Code");
  });

  it("reads canonical keyboard getters instead of forged event properties", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const event = tabKeyEvent(source, "ArrowDown");
    Object.defineProperty(event, "key", {
      configurable: true,
      value: "ArrowUp",
    });

    dispatchTabKey(source, event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expectSelected("Copilot CLI");
  });

  it("rejects untrusted input and replaced React trust predicates before trusted recovery", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const source = tab("Copilot CLI");
    const handler = reactHandler<
      (event: ReactKeyboardEvent<HTMLButtonElement>) => void
    >(source, "onKeyDown");
    source.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const untrusted = tabKeyEvent(source, "ArrowDown", {}, false);
    dispatchTabKey(source, untrusted);
    expect(untrusted.isTrusted).toBe(false);
    expect(untrusted.defaultPrevented).toBe(false);

    const replacedTrust = tabKeyEvent(source, "ArrowDown");
    dispatchTabKeyWithHandler(source, replacedTrust, (event) => {
      handler(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "isTrusted") return false;
          return Reflect.get(target, property, receiver);
        },
      }));
    });
    expect(replacedTrust.defaultPrevented).toBe(false);

    const replacedPredicate = tabKeyEvent(source, "ArrowDown");
    dispatchTabKeyWithHandler(source, replacedPredicate, (event) => {
      handler(new Proxy(event, {
        get(target, property, receiver) {
          if (property === "isDefaultPrevented") return () => true;
          return Reflect.get(target, property, receiver);
        },
      }));
    });
    expect(replacedPredicate.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");
    expect(source).toHaveFocus();
    expect(copyText).not.toHaveBeenCalled();

    const trusted = dispatchTabKey(source, "ArrowDown");
    expect(trusted.isTrusted).toBe(true);
    expect(trusted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectSelected("VS Code");
    expect(tab("VS Code")).toHaveFocus();
  });

  it("rejects an unfocused selected tab and a focused unselected tab", () => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    const selected = tab("Copilot CLI");
    const unselected = tab("VS Code");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    focus.mockClear();
    preventDefault.mockClear();

    const unfocused = dispatchTabKey(selected, "ArrowDown");
    unselected.focus();
    focus.mockClear();
    const wrongSelection = dispatchTabKey(unselected, "ArrowDown");

    expect(unfocused.defaultPrevented).toBe(false);
    expect(wrongSelection.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Copilot CLI");
    expect(unselected).toHaveFocus();
    outside.remove();
  });

  it.each([
    "tab detach and restoration",
    "tab reorder and restoration",
    "tab replacement and restoration",
    "tablist detach and restoration",
    "selection mutation and restoration",
  ] as const)("retires restored committed history after %s and recovers with a clean successor", (scenario) => {
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const card = (
      <AgentConnectCard
        origin="https://markdoc.test"
        scope="comment"
        hideTokenStep
      />
    );
    const view = renderDirect(<StrictMode>{card}</StrictMode>);
    fireEvent.click(tab("VS Code"));
    const source = tab("VS Code");
    const list = screen.getByRole("tablist");

    if (scenario === "tab detach and restoration") {
      const next = source.nextSibling;
      list.removeChild(source);
      list.insertBefore(source, next);
    } else if (scenario === "tab reorder and restoration") {
      const first = list.firstChild;
      if (!first) throw new Error("The tablist is empty");
      list.append(first);
      list.insertBefore(first, list.firstChild);
    } else if (scenario === "tab replacement and restoration") {
      const replacement = source.cloneNode(true);
      const HTMLButtonElementConstructor =
        source.ownerDocument.defaultView?.HTMLButtonElement;
      if (
        !HTMLButtonElementConstructor ||
        !(replacement instanceof HTMLButtonElementConstructor)
      ) {
        throw new Error("The cloned tab is not an owner-realm button");
      }
      source.replaceWith(replacement);
      replacement.replaceWith(source);
    } else if (scenario === "tablist detach and restoration") {
      const parent = list.parentNode;
      const next = list.nextSibling;
      if (!parent) throw new Error("The tablist has no parent");
      parent.removeChild(list);
      parent.insertBefore(list, next);
    } else {
      source.setAttribute("aria-selected", "false");
      source.setAttribute("aria-selected", "true");
    }

    source.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const rejected = dispatchTabKey(source, "ArrowDown");
    expect(rejected.defaultPrevented).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expectSelected("VS Code");

    act(() => {
      view.root.render(
        <StrictMode>
          <AgentConnectCard
            key="fresh"
            origin="https://markdoc.test"
            scope="comment"
            hideTokenStep
          />
        </StrictMode>,
      );
    });
    const recovered = tab("Copilot CLI");
    recovered.focus();
    focus.mockClear();
    preventDefault.mockClear();
    const accepted = dispatchTabKey(recovered, "ArrowDown");
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expectSelected("VS Code");
  });

  it("rejects partial ref replay and leaves no keyboard work after cleanup", async () => {
    const realQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const view = renderDirect(
      <StrictMode>
        <AgentConnectCard origin="https://markdoc.test" hideTokenStep />
      </StrictMode>,
    );
    await act(async () => {});
    const initialSource = tab("Copilot CLI");
    initialSource.focus();
    vi.useFakeTimers();
    const setTimeout = vi.spyOn(window, "setTimeout");
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    try {
      act(() => {
        view.root.render(
          <StrictMode>
            <AgentConnectCard origin="https://current.markdoc.test" hideTokenStep />
          </StrictMode>,
        );
      });
      const source = tab("Copilot CLI");
      expect(source).toBe(initialSource);
      expect(source).toHaveFocus();
      expect(vi.getTimerCount()).toBe(0);
      const staleHandler = reactHandler<KeyHandler>(source, "onKeyDown");
      const sourceCleanup = reactRefCleanup(source);
      focus.mockClear();
      preventDefault.mockClear();
      setTimeout.mockClear();
      clearTimeout.mockClear();
      let handle: unknown;
      act(() => {
        sourceCleanup();
        expect(setTimeout).toHaveBeenCalledOnce();
        expect(setTimeout.mock.calls[0]?.[1]).toBe(0);
        handle = setTimeout.mock.results[0]?.value;
      });
      expect(handle).not.toBeUndefined();
      expect(handle).not.toBeNull();
      expect(vi.getTimerCount()).toBe(1);
      staleHandler({
        key: "ArrowDown",
        currentTarget: source,
        preventDefault,
      });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expectSelected("Copilot CLI");
      expect(copyText).not.toHaveBeenCalled();
      expect(clearTimeout).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      clearTimeout.mockClear();
      expect(vi.getTimerCount()).toBe(1);
      await act(() => {
        view.root.render(<StrictMode><div /></StrictMode>);
      });
      await new Promise<void>((resolve) => realQueueMicrotask(resolve));
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(copyText).not.toHaveBeenCalled();
      expect(source).toHaveAttribute("aria-selected", "true");
      expect(clearTimeout).toHaveBeenCalledExactlyOnceWith(handle);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setTimeout.mockRestore();
      clearTimeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("AgentConnectCard exact control visits", () => {
  it.each(["callbacks", "origin", "scope", "hide-token"] as const)(
    "retires tab, keyboard, Create, and Dismiss handlers at the %s replacement layout boundary",
    (replacement) => {
      const createA = vi.fn();
      const dismissA = vi.fn();
      const createB = replacement === "callbacks" ? vi.fn() : createA;
      const dismissB = replacement === "callbacks" ? vi.fn() : dismissA;
      const cardA: AgentConnectCardProps = {
        origin: "https://first.markdoc.test",
        scope: "read",
        onCreateToken: createA,
        onDismiss: dismissA,
        hideTokenStep: false,
      };
      const cardB: AgentConnectCardProps = {
        ...cardA,
        origin: replacement === "origin" ? "https://current.markdoc.test" : cardA.origin,
        scope: replacement === "scope" ? "comment" : cardA.scope,
        onCreateToken: createB,
        onDismiss: dismissB,
        hideTokenStep: replacement === "hide-token" ? true : cardA.hideTokenStep,
      };
      let passiveCleanups = 0;
      const view = renderDirect(
        <CardBoundary card={cardA} onPassiveCleanup={() => passiveCleanups++} />,
      );
      fireEvent.click(tab("VS Code"));
      expectSelected("VS Code");
      const stale = captureActions();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const observer = observeMutations(view.host);
      const location = window.location.href;
      let boundaryPreventDefault!: ReturnType<typeof vi.fn>;

      act(() => {
        view.root.render(
          <CardBoundary
            card={cardB}
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              observer.takeRecords();
              focus.mockClear();
              boundaryPreventDefault = invokeActions(stale);
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      expect(boundaryPreventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expectSelected("VS Code");
      expect(createA).not.toHaveBeenCalled();
      expect(dismissA).not.toHaveBeenCalled();
      expect(createB).not.toHaveBeenCalled();
      expect(dismissB).not.toHaveBeenCalled();
      expect(copyText).not.toHaveBeenCalled();
      expect(window.location.href).toBe(location);

      observer.takeRecords();
      act(() => {
        const preventDefault = invokeActions(stale);
        expect(preventDefault).not.toHaveBeenCalled();
      });
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expectSelected("VS Code");
      expect(createA).not.toHaveBeenCalled();
      expect(dismissA).not.toHaveBeenCalled();

      if (replacement === "origin") {
        expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("https://current.markdoc.test");
        expect(screen.getByTestId("agent-connect-config")).not.toHaveTextContent("https://first.markdoc.test");
      }
      if (replacement === "scope") {
        fireEvent.click(tab("Copilot CLI"));
        fireEvent.click(screen.getByText("Optional Copilot CLI permissions"));
        expect(screen.getByTestId("agent-connect-scope-chip")).toHaveTextContent("comment");
      }
      if (replacement === "hide-token") {
        expect(screen.queryByTestId("agent-connect-create-token")).toBeNull();
      } else {
        fireEvent.click(screen.getByTestId("agent-connect-create-token"));
        expect(createB).toHaveBeenCalledOnce();
      }
      fireEvent.click(tab("Copilot app"));
      expectSelected("Copilot app");
      fireEvent.click(screen.getByTestId("agent-connect-dismiss"));
      expect(dismissB).toHaveBeenCalledOnce();
      if (replacement === "callbacks") {
        expect(createA).not.toHaveBeenCalled();
        expect(dismissA).not.toHaveBeenCalled();
      }
      expect(copyText).not.toHaveBeenCalled();
      expect(window.location.href).toBe(location);
    },
  );

  it("keeps absent optional controls absent and their retained handlers inert", () => {
    const create = vi.fn();
    const dismiss = vi.fn();
    const cardA = {
      origin: "https://markdoc.test",
      scope: "comment" as const,
      onCreateToken: create,
      onDismiss: dismiss,
    };
    const cardB = { origin: cardA.origin, scope: cardA.scope };
    let passiveCleanups = 0;
    const view = renderDirect(<CardBoundary card={cardA} onPassiveCleanup={() => passiveCleanups++} />);
    const stale = captureActions();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(view.host);
    let boundaryPreventDefault!: ReturnType<typeof vi.fn>;

    act(() => {
      view.root.render(
        <CardBoundary
          card={cardB}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            observer.takeRecords();
            focus.mockClear();
            boundaryPreventDefault = invokeActions(stale);
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(boundaryPreventDefault).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.queryByTestId("agent-connect-dismiss")).toBeNull();
    expect(screen.getByTestId("agent-connect-create-token").tagName).toBe("A");

    observer.takeRecords();
    act(() => invokeActions(stale));
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-prop remount when handlers run %s",
    (order) => {
      const create = vi.fn();
      const dismiss = vi.fn();
      const card: AgentConnectCardProps = {
        origin: "https://markdoc.test",
        scope: "comment",
        onCreateToken: create,
        onDismiss: dismiss,
      };
      let passiveCleanups = 0;
      const view = renderDirect(
        <CardBoundary card={card} onPassiveCleanup={() => passiveCleanups++} />,
      );
      fireEvent.click(tab("VS Code"));
      const stale = captureActions();
      const oldTabs = screen.getAllByRole("tab");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const observer = observeMutations(view.host);
      let boundaryPreventDefault!: ReturnType<typeof vi.fn>;

      act(() => {
        view.root.render(
          <CardBoundary
            card={card}
            mount="replacement"
            passiveVisit={1}
            boundary={1}
            onPassiveCleanup={() => passiveCleanups++}
            onBoundary={() => {
              expect(passiveCleanups).toBe(0);
              expect(screen.getAllByRole("tab").every((item) => !oldTabs.includes(item))).toBe(true);
              observer.takeRecords();
              focus.mockClear();
              boundaryPreventDefault = invokeActions(stale);
            }}
          />,
        );
      });

      expect(passiveCleanups).toBe(1);
      expect(boundaryPreventDefault).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expect(focus).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expectSelected("Copilot CLI");

      const current = captureActions();
      let stalePreventDefault!: ReturnType<typeof vi.fn>;
      let currentEvent!: KeyboardEvent;
      const invokeCurrent = () => {
        act(() => {
          current.click({ currentTarget: current.clickElement });
        });
        fireEvent.click(current.keyElement);
        current.keyElement.focus();
        focus.mockClear();
        currentEvent = dispatchTabKey(current.keyElement, "ArrowRight");
        act(() => {
          current.create({ currentTarget: current.createElement });
          current.dismiss({ currentTarget: current.dismissElement });
        });
      };
      if (order === "stale-before-current") {
        observer.takeRecords();
        act(() => {
          stalePreventDefault = invokeActions(stale);
        });
        expect(observer.takeRecords()).toHaveLength(0);
        invokeCurrent();
      } else {
        invokeCurrent();
        observer.takeRecords();
        act(() => {
          stalePreventDefault = invokeActions(stale);
        });
        expect(observer.takeRecords()).toHaveLength(0);
      }

      expect(stalePreventDefault).not.toHaveBeenCalled();
      expect(currentEvent.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledOnce();
      expect(focus.mock.contexts[0]).toBe(tab("Other MCP clients"));
      expectSelected("Other MCP clients");
      expect(create).toHaveBeenCalledOnce();
      expect(dismiss).toHaveBeenCalledOnce();
      expect(copyText).not.toHaveBeenCalled();
    },
  );

  it("retires every captured handler before removal reaches the parent layout boundary", () => {
    const create = vi.fn();
    const dismiss = vi.fn();
    const card = { origin: "https://markdoc.test", onCreateToken: create, onDismiss: dismiss };
    let passiveCleanups = 0;
    const view = renderDirect(<CardBoundary card={card} onPassiveCleanup={() => passiveCleanups++} />);
    const stale = captureActions();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(view.host);
    const location = window.location.href;
    let boundaryPreventDefault!: ReturnType<typeof vi.fn>;

    act(() => {
      view.root.render(
        <CardBoundary
          card={card}
          present={false}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            expect(screen.queryByTestId("agent-connect-card")).toBeNull();
            observer.takeRecords();
            focus.mockClear();
            boundaryPreventDefault = invokeActions(stale);
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(boundaryPreventDefault).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    expect(copyText).not.toHaveBeenCalled();
    expect(window.location.href).toBe(location);

    observer.takeRecords();
    act(() => invokeActions(stale));
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("accepts each current control only for its exact element and valid target", () => {
    const create = vi.fn();
    const dismiss = vi.fn();
    const view = renderDirect(
      <AgentConnectCard origin="https://markdoc.test" scope="comment" onCreateToken={create} onDismiss={dismiss} />,
    );
    const observer = observeMutations(view.host);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const other = tab("Other MCP clients");
    const clickOther = reactHandler<ClickHandler>(other, "onClick");

    act(() => clickOther({ currentTarget: other }));
    expectSelected("Other MCP clients");
    expect(focus).not.toHaveBeenCalled();

    const repeatOther = reactHandler<ClickHandler>(other, "onClick");
    observer.takeRecords();
    act(() => repeatOther({ currentTarget: other }));
    expect(observer.takeRecords()).toHaveLength(0);
    expect(focus).not.toHaveBeenCalled();
    expectSelected("Other MCP clients");

    const app = tab("Copilot app");
    const clickApp = reactHandler<ClickHandler>(app, "onClick");
    observer.takeRecords();
    act(() => clickApp({ currentTarget: other }));
    expect(observer.takeRecords()).toHaveLength(0);
    expectSelected("Other MCP clients");

    for (const [key, from, to] of [
      ["ArrowRight", "Other MCP clients", "Copilot app"],
      ["ArrowLeft", "Copilot app", "Other MCP clients"],
      ["Home", "Other MCP clients", "Copilot CLI"],
      ["End", "Copilot CLI", "Copilot app"],
    ] as const) {
      const source = tab(from);
      const destination = tab(to);
      source.focus();
      focus.mockClear();
      const event = dispatchTabKey(source, key);
      expect(event.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledOnce();
      expect(focus.mock.contexts[0]).toBe(destination);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(destination).toHaveFocus();
      expectSelected(to);
    }

    const selected = tab("Copilot app");
    const selectedKey = reactHandler<KeyHandler>(selected, "onKeyDown");
    for (const key of ["PageDown", "End"]) {
      selected.focus();
      observer.takeRecords();
      focus.mockClear();
      const event = dispatchTabKey(selected, key);
      expect(event.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(observer.takeRecords()).toHaveLength(0);
      expectSelected("Copilot app");
    }

    const wrongSourcePreventDefault = vi.fn();
    observer.takeRecords();
    act(() => selectedKey({ key: "Home", currentTarget: other, preventDefault: wrongSourcePreventDefault }));
    expect(wrongSourcePreventDefault).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expectSelected("Copilot app");

    const createElement = screen.getByTestId("agent-connect-create-token") as HTMLButtonElement;
    const dismissElement = screen.getByTestId("agent-connect-dismiss") as HTMLButtonElement;
    act(() => {
      reactHandler<ClickHandler>(createElement, "onClick")({ currentTarget: createElement });
      reactHandler<ClickHandler>(dismissElement, "onClick")({ currentTarget: dismissElement });
    });
    expect(create).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(copyText).not.toHaveBeenCalled();
  });
});
