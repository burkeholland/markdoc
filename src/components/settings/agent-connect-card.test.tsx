// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type ComponentProps, type ReactNode } from "react";
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
      let currentPreventDefault!: ReturnType<typeof vi.fn>;
      if (order === "stale-before-current") {
        observer.takeRecords();
        act(() => {
          stalePreventDefault = invokeActions(stale);
        });
        expect(observer.takeRecords()).toHaveLength(0);
        act(() => {
          currentPreventDefault = invokeActions(current);
        });
      } else {
        act(() => {
          currentPreventDefault = invokeActions(current);
        });
        observer.takeRecords();
        act(() => {
          stalePreventDefault = invokeActions(stale);
        });
        expect(observer.takeRecords()).toHaveLength(0);
      }

      expect(stalePreventDefault).not.toHaveBeenCalled();
      expect(currentPreventDefault).toHaveBeenCalledOnce();
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
      const handler = reactHandler<KeyHandler>(source, "onKeyDown");
      const preventDefault = vi.fn();
      focus.mockClear();
      act(() => handler({ key, currentTarget: source, preventDefault }));
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(focus.mock.contexts[0]).toBe(destination);
      expect(destination).toHaveFocus();
      expectSelected(to);
    }

    const selected = tab("Copilot app");
    const selectedKey = reactHandler<KeyHandler>(selected, "onKeyDown");
    for (const key of ["PageDown", "End"]) {
      const preventDefault = vi.fn();
      observer.takeRecords();
      focus.mockClear();
      act(() => selectedKey({ key, currentTarget: selected, preventDefault }));
      expect(preventDefault).not.toHaveBeenCalled();
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
