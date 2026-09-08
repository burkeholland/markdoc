// @vitest-environment jsdom
import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AgentConnectCard,
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
type ElementRef<T extends HTMLElement> = (element: T | null) => void;

interface PermissionHintProps {
  testIdPrefix: string;
  className?: string;
  scope?: TokenScopeName | null;
}

interface CapturedPermissionHint {
  root: HTMLDivElement;
  pre: HTMLPreElement;
  button: HTMLButtonElement;
  click: ClickHandler;
  rootRef: ElementRef<HTMLDivElement>;
  preRef: ElementRef<HTMLPreElement>;
  buttonRef: ElementRef<HTMLButtonElement>;
}

interface PermissionEvent {
  currentTarget: HTMLButtonElement;
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

function permissionEvent(currentTarget: HTMLButtonElement): PermissionEvent {
  return { currentTarget, preventDefault: vi.fn(), stopPropagation: vi.fn() };
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
    click: reactHandler<ClickHandler>(button, "onClick"),
    rootRef: reactHandler<ElementRef<HTMLDivElement>>(root, "ref"),
    preRef: reactHandler<ElementRef<HTMLPreElement>>(pre, "ref"),
    buttonRef: reactHandler<ElementRef<HTMLButtonElement>>(button, "ref"),
  };
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
});

describe("Copilot permission exact copy control", () => {
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

  it("rejects sibling, foreign, detached, disabled, and replacement sources without observable work", () => {
    const settlement = deferred<boolean>();
    copyText.mockReturnValue(settlement.promise);
    const firstView = renderDirect(<CopilotPermissionsHint testIdPrefix="first-hint" scope="read" />);
    renderDirect(<CopilotPermissionsHint testIdPrefix="sibling-hint" scope="comment" />);
    const first = capturePermissionHint("first-hint");
    const sibling = capturePermissionHint("sibling-hint");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(firstView.host);

    const expectInert = (source: HTMLButtonElement) => {
      const event = permissionEvent(source);
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

    expectInert(sibling.button);
    expectInert(foreign);
    expectInert(detached);
    first.button.disabled = true;
    expectInert(first.button);
    first.button.disabled = false;

    const replacement = first.button.cloneNode(true) as HTMLButtonElement;
    first.button.replaceWith(replacement);
    observer.takeRecords();
    expectInert(replacement);
    expectInert(first.button);

    foreign.remove();
  });

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
