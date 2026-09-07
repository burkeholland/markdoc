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
import { MCP_PATH } from "@/lib/mcp";

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({ ...await original<typeof import("@/lib/clipboard")>(), copyText }));

beforeEach(() => { copyText.mockReset().mockResolvedValue(true); });

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
