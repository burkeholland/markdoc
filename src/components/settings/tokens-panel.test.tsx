// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const copyText = vi.hoisted(() => vi.fn());
const selectContents = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", async (original) => ({
  ...await original<typeof import("@/lib/clipboard")>(),
  copyText,
  selectContents,
}));

vi.mock("@/components/settings/copilot-checklist", () => ({
  CopilotChecklist: () => null,
}));

import { TokensPanel } from "./tokens-panel";

const fetchMock = vi.fn<typeof fetch>();

const token = {
  id: "tok-1",
  name: "Copilot CLI",
  prefix: "mdk_abc",
  scope: "comment",
  documentIds: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  lastUsedAt: null,
  lastMcpSeenAt: null,
  lastMcpCallAt: null,
  expiresAt: null,
  collaboratorsMayAsk: false,
};

const createdSecret = {
  id: "created-token",
  name: "Strict agent",
  token: "mdk_strict_secret",
  prefix: "mdk_str",
  scope: "comment" as const,
  documentIds: ["doc-one", "doc-two"],
  createdAt: "2026-09-08T00:00:00.000Z",
  expiresAt: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The PATCH calls `fetch` saw, as `[url, parsed body]`. */
function patches(): Array<[string, unknown]> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PATCH")
    .map(([url, init]) => [String(url), JSON.parse(String(init?.body))] as [string, unknown]);
}

/** A `fetch` answer the test settles later, to make one request land after another that started after it. */
function deferred() {
  let settle!: (r: Response) => void;
  let reject!: (reason: unknown) => void;
  const later = new Promise<Response>((resolve, fail) => {
    settle = resolve;
    reject = fail;
  });
  return { later, settle, reject };
}

/** `POST /api/tokens` answer: minting a token is the user's path to a list reload right before the switch click. */
const minted = () => response({ token: { token: "mdk_new_secret", name: "GitHub Copilot CLI", scope: "comment", documentIds: null } });

function LayoutBoundary({ boundary = 0, onBoundary, children }: {
  boundary?: number;
  onBoundary?: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return children;
}

function PassiveCleanupProbe({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  return null;
}

function AccountPanel({ login, origin = "https://markdoc.test" }: { login: string; origin?: string }) {
  return (
    <section data-testid={`token-account-${login}`} tabIndex={-1}>
      <TokensPanel origin={origin} userLogin={login} />
    </section>
  );
}

function callsFor(method: "GET" | "POST" | "PATCH") {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);
}

const unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};
const directSecretViews: Array<{ host: HTMLDivElement; root: Root }> = [];

beforeEach(() => {
  fetchMock.mockReset();
  copyText.mockReset().mockResolvedValue(true);
  selectContents.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  for (const view of directSecretViews.splice(0)) {
    await act(async () => view.root.unmount());
    view.host.remove();
  }
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(unhandledRejections).toEqual([]);
});

function renderDirectSecret(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directSecretViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function reactProp<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the secret control");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`The secret control has no ${name} callback`);
  return value as T;
}

function invokeHandlerFromNative(
  button: HTMLButtonElement,
  handler: (event: ReactMouseEvent<HTMLButtonElement>) => void,
) {
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const nativeEvent = event as MouseEvent;
    handler({
      type: nativeEvent.type,
      button: nativeEvent.button,
      bubbles: nativeEvent.bubbles,
      cancelable: nativeEvent.cancelable,
      eventPhase: nativeEvent.eventPhase,
      currentTarget: button,
      target: nativeEvent.target,
      nativeEvent,
      defaultPrevented: nativeEvent.defaultPrevented,
    } as ReactMouseEvent<HTMLButtonElement>);
  }, { once: true });
  fireEvent.click(button);
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queueStrictSecret(created = createdSecret) {
  const row = {
    ...token,
    id: created.id,
    name: created.name,
    prefix: created.prefix,
    scope: created.scope,
    documentIds: [...created.documentIds],
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
  };
  fetchMock
    .mockResolvedValueOnce(response({ tokens: [] }))
    .mockResolvedValueOnce(response({ tokens: [] }))
    .mockResolvedValueOnce(response({ token: created }, 201))
    .mockResolvedValueOnce(response({ tokens: [row] }));
  return row;
}

async function showStrictSecret(created = createdSecret) {
  const row = queueStrictSecret(created);
  const view = renderDirectSecret(
    <StrictMode>
      <TokensPanel origin="https://markdoc.test" userLogin="alice" />
    </StrictMode>,
  );
  await screen.findByText("No tokens yet.");
  fireEvent.click(screen.getByTestId("token-add"));
  fireEvent.change(screen.getByTestId("token-name"), { target: { value: created.name } });
  fireEvent.click(screen.getByTestId("token-create"));
  const notice = await screen.findByTestId("token-created");
  await screen.findByRole("button", { name: `Rename ${row.name}` });
  return {
    ...view,
    row,
    notice: notice as HTMLDivElement,
    code: screen.getByTestId("copy-token") as HTMLElement,
    copy: screen.getByRole("button", { name: "Copy token" }) as HTMLButtonElement,
    hide: screen.getByRole("button", { name: "I stored it - hide secret" }) as HTMLButtonElement,
  };
}

async function showStrictRename(row = token) {
  fetchMock
    .mockResolvedValueOnce(response({ tokens: [row] }))
    .mockResolvedValueOnce(response({ tokens: [row] }));
  const view = renderDirectSecret(
    <StrictMode>
      <TokensPanel origin="https://markdoc.test" userLogin="alice" />
    </StrictMode>,
  );
  const rename = await screen.findByRole("button", { name: `Rename ${row.name}` });
  fireEvent.click(rename);
  const input = screen.getByLabelText("Token name") as HTMLInputElement;
  expect(input).toHaveFocus();
  return {
    ...view,
    row,
    rename: rename as HTMLButtonElement,
    form: input.form as HTMLFormElement,
    input,
  };
}

function renameEscape(
  target: HTMLElement,
  init: KeyboardEventInit & { type?: string } = {},
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The token rename input has no owner window");
  const { type = "keydown", ...eventInit } = init;
  const event = new ownerWindow.KeyboardEvent(type, {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    composed: true,
    ...eventInit,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Settings → Agents: account-session authority", () => {
  it.each(["success", "failure"] as const)(
    "retires an old account list %s at the parent layout boundary",
    async (outcome) => {
      const oldList = deferred();
      const currentList = deferred();
      const oldToken = { ...token, id: "old-token", name: "Old account agent" };
      const currentToken = { ...token, id: "current-token", name: "Current account agent" };
      fetchMock.mockReturnValueOnce(oldList.later).mockReturnValueOnce(currentList.later);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <LayoutBoundary>
              <AccountPanel login="old-account" origin="https://old.markdoc.test" />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </LayoutBoundary>,
          );
        });
        expect(callsFor("GET")).toHaveLength(1);

        let reachedBoundary!: () => void;
        const boundaryReached = new Promise<void>((resolve) => {
          reachedBoundary = resolve;
        });
        root.render(
          <LayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              oldList.settle(outcome === "success"
                ? response({ tokens: [oldToken] })
                : response({ error: "Old account list failed" }, 503));
              reachedBoundary();
            }}
          >
            <AccountPanel login="current-account" origin="https://current.markdoc.test" />
          </LayoutBoundary>,
        );
        await boundaryReached;
        await act(async () => {
          await Promise.allSettled([oldList.later]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(screen.getByText("Manage tokens for current-account. Agents can never do more than you can.")).toBeVisible();
        expect(screen.getByText("Loading tokens...")).toBeVisible();
        expect(screen.queryByText(oldToken.name)).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByTestId("token-created")).toBeNull();
        expect(callsFor("GET").map(([url, init]) => [String(url), init?.cache])).toEqual([
          ["/api/tokens?includeRevoked=true", "no-store"],
          ["/api/tokens?includeRevoked=true", "no-store"],
        ]);

        await act(async () => currentList.settle(response({ tokens: [currentToken] })));
        expect(await screen.findByText(currentToken.name)).toBeVisible();
        expect(screen.getAllByTestId("token-row")).toHaveLength(1);
        expect(screen.queryByText(oldToken.name)).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(callsFor("GET")).toHaveLength(2);
        expect(callsFor("POST")).toHaveLength(0);
        expect(callsFor("PATCH")).toHaveLength(0);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps current account creation pending when an old account create settles with %s",
    async (outcome) => {
      const oldCreate = deferred();
      const currentCreate = deferred();
      const currentReload = deferred();
      const currentToken = { ...token, id: "current-created-token", name: "Current account agent" };
      fetchMock
        .mockResolvedValueOnce(response({ tokens: [] }))
        .mockResolvedValueOnce(response({ tokens: [] }))
        .mockReturnValueOnce(oldCreate.later)
        .mockReturnValueOnce(currentCreate.later)
        .mockReturnValueOnce(currentReload.later);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <LayoutBoundary>
              <AccountPanel key="old" login="old-account" />
              <AccountPanel key="current" login="current-account" />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </LayoutBoundary>,
          );
        });
        expect(await screen.findAllByText("No tokens yet.")).toHaveLength(2);
        const oldAccount = within(screen.getByTestId("token-account-old-account"));
        const currentSection = screen.getByTestId("token-account-current-account");
        const currentAccount = within(currentSection);
        fireEvent.click(oldAccount.getByTestId("token-add"));
        fireEvent.change(oldAccount.getByTestId("token-name"), { target: { value: "Old account agent" } });
        fireEvent.click(oldAccount.getByTestId("token-create"));
        fireEvent.click(currentAccount.getByTestId("token-add"));
        fireEvent.change(currentAccount.getByTestId("token-name"), { target: { value: "Current account agent" } });
        fireEvent.click(currentAccount.getByTestId("token-create"));
        currentSection.focus();

        expect(callsFor("POST")).toHaveLength(2);
        expect(callsFor("POST").map(([url, init]) => [String(url), JSON.parse(String(init?.body))])).toEqual([
          ["/api/tokens", { name: "Old account agent", expiresInDays: 90, scope: "comment", documentIds: null }],
          ["/api/tokens", { name: "Current account agent", expiresInDays: 90, scope: "comment", documentIds: null }],
        ]);
        expect(currentAccount.getByTestId("token-name")).toBeDisabled();

        let reachedBoundary!: () => void;
        const boundaryReached = new Promise<void>((resolve) => {
          reachedBoundary = resolve;
        });
        root.render(
          <LayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "success") {
                oldCreate.settle(response({
                  token: { token: "mdk_old_secret", name: "Old account agent", scope: "comment", documentIds: null },
                }, 201));
              } else {
                oldCreate.reject(new Error("Old account create failed"));
              }
              reachedBoundary();
            }}
          >
            <AccountPanel key="current" login="current-account" />
          </LayoutBoundary>,
        );
        await boundaryReached;
        await act(async () => {
          await Promise.allSettled([oldCreate.later]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(screen.queryByTestId("token-account-old-account")).toBeNull();
        expect(currentSection).toHaveFocus();
        expect(currentAccount.getByTestId("token-name")).toBeDisabled();
        expect(currentAccount.getByTestId("token-create")).toBeDisabled();
        expect(screen.queryByTestId("token-created")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByTestId("token-row")).toBeNull();
        expect(callsFor("GET")).toHaveLength(2);
        expect(callsFor("POST")).toHaveLength(2);
        expect(callsFor("PATCH")).toHaveLength(0);

        await act(async () => currentCreate.settle(response({
          token: { token: "mdk_current_secret", name: "Current account agent", scope: "comment", documentIds: null },
        }, 201)));
        expect(await screen.findByTestId("token-created")).toHaveTextContent("Current account agent");
        expect(screen.getAllByTestId("token-created")).toHaveLength(1);
        expect(screen.getByTestId("copy-token")).toHaveTextContent("mdk_current_secret");
        expect(currentAccount.getByTestId("token-name")).toBeDisabled();
        expect(callsFor("GET")).toHaveLength(3);

        await act(async () => currentReload.settle(response({ tokens: [currentToken] })));
        expect(await screen.findByText(currentToken.name)).toBeVisible();
        expect(currentAccount.getByTestId("token-name")).toBeEnabled();
        expect(screen.getAllByTestId("token-row")).toHaveLength(1);
        expect(screen.getAllByTestId("token-created")).toHaveLength(1);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(callsFor("GET")).toHaveLength(3);
        expect(callsFor("POST")).toHaveLength(2);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps the current optimistic row owner when an old account replacement settles with %s",
    async (outcome) => {
      const oldReplace = deferred();
      const currentPatch = deferred();
      const oldToken = { ...token, id: "shared-token", name: "Old account agent" };
      const currentToken = { ...token, id: "shared-token", name: "Current account agent" };
      fetchMock
        .mockResolvedValueOnce(response({ tokens: [oldToken] }))
        .mockResolvedValueOnce(response({ tokens: [currentToken] }))
        .mockReturnValueOnce(oldReplace.later)
        .mockReturnValueOnce(currentPatch.later);
      vi.stubGlobal("confirm", vi.fn(() => true));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      let passiveCleanupsAtBoundary = -1;
      const recordPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await act(async () => {
          root.render(
            <LayoutBoundary>
              <AccountPanel key="old" login="old-account" />
              <AccountPanel key="current" login="current-account" />
              <PassiveCleanupProbe onCleanup={recordPassiveCleanup} />
            </LayoutBoundary>,
          );
        });
        const oldAccount = within(screen.getByTestId("token-account-old-account"));
        const currentSection = screen.getByTestId("token-account-current-account");
        const currentAccount = within(currentSection);
        fireEvent.click(await oldAccount.findByRole("button", { name: "Replace Old account agent" }));
        const currentSwitch = await currentAccount.findByTestId("token-collaborators-may-ask");
        fireEvent.click(currentSwitch);
        currentSection.focus();

        expect(currentSwitch).toHaveAttribute("aria-checked", "true");
        expect(currentSwitch).toBeDisabled();
        expect(callsFor("POST").map(([url, init]) => [String(url), JSON.parse(String(init?.body))])).toEqual([
          ["/api/tokens/shared-token/replace", { confirm: true }],
        ]);
        expect(callsFor("PATCH").map(([url, init]) => [String(url), JSON.parse(String(init?.body))])).toEqual([
          ["/api/tokens/shared-token", { collaboratorsMayAsk: true }],
        ]);

        let reachedBoundary!: () => void;
        const boundaryReached = new Promise<void>((resolve) => {
          reachedBoundary = resolve;
        });
        root.render(
          <LayoutBoundary
            boundary={1}
            onBoundary={() => {
              passiveCleanupsAtBoundary = passiveCleanups;
              if (outcome === "success") {
                oldReplace.settle(response({
                  token: { token: "mdk_old_replacement", name: oldToken.name, scope: "comment", documentIds: null },
                }, 201));
              } else {
                oldReplace.reject(new Error("Old account replacement failed"));
              }
              reachedBoundary();
            }}
          >
            <AccountPanel key="current" login="current-account" />
          </LayoutBoundary>,
        );
        await boundaryReached;
        await act(async () => {
          await Promise.allSettled([oldReplace.later]);
          await Promise.resolve();
        });

        expect(passiveCleanupsAtBoundary).toBe(0);
        expect(screen.queryByTestId("token-account-old-account")).toBeNull();
        expect(currentSection).toHaveFocus();
        expect(screen.getAllByTestId("token-row")).toHaveLength(1);
        expect(screen.getByTestId("token-row")).toHaveTextContent(currentToken.name);
        expect(screen.queryByText(oldToken.name)).toBeNull();
        expect(currentSwitch).toHaveAttribute("aria-checked", "true");
        expect(currentSwitch).toBeDisabled();
        expect(screen.queryByTestId("token-created")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(callsFor("GET")).toHaveLength(2);
        expect(callsFor("POST")).toHaveLength(1);
        expect(callsFor("PATCH")).toHaveLength(1);

        await act(async () => currentPatch.settle(response({
          token: { ...currentToken, collaboratorsMayAsk: true },
        })));
        await waitFor(() => expect(currentSwitch).toBeEnabled());
        expect(currentSwitch).toHaveAttribute("aria-checked", "true");
        expect(screen.getByTestId("token-row")).toHaveTextContent(currentToken.name);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.queryByTestId("token-created")).toBeNull();
        expect(callsFor("GET")).toHaveLength(2);
        expect(callsFor("POST")).toHaveLength(1);
        expect(callsFor("PATCH")).toHaveLength(1);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
});

describe("Settings → Agents: token rename Escape authority", () => {
  it("cancels one direct-root Strict Mode rename, prevents once, and preserves the persisted name without a request", async () => {
    const rename = await showStrictRename();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    fireEvent.change(rename.input, { target: { value: "Unsaved agent name" } });
    const currentInput = screen.getByLabelText("Token name") as HTMLInputElement;
    const accepted = renameEscape(currentInput);

    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault.mock.contexts.filter((context) => context === accepted)).toHaveLength(1);
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(screen.getByRole("button", { name: `Rename ${token.name}` })).toHaveFocus();
    expect(screen.getByTestId("token-row")).toHaveTextContent(token.name);
    expect(screen.queryByText("Unsaved agent name")).toBeNull();
    expect(callsFor("POST")).toHaveLength(0);
    expect(callsFor("PATCH")).toHaveLength(0);
  });

  it("leaves outside and pending Escape events inert without adding a request", async () => {
    const rename = await showStrictRename();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const outside = renameEscape(screen.getByTestId("token-row"));
    expect(outside.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === outside)).toHaveLength(0);
    expect(screen.getByLabelText("Token name")).toBe(rename.input);

    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.later);
    fireEvent.change(rename.input, { target: { value: "Pending agent name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(callsFor("PATCH")).toHaveLength(1);
    const pendingInput = screen.getByLabelText("Token name") as HTMLInputElement;
    expect(pendingInput).toBeDisabled();
    const rejected = renameEscape(pendingInput);

    expect(rejected.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === rejected)).toHaveLength(0);
    expect(screen.getByLabelText("Token name")).toBe(pendingInput);
    expect(callsFor("PATCH")).toHaveLength(1);
    expect(callsFor("POST")).toHaveLength(0);
  });

  it("keeps a manually completed callback ref replay inert without a matching layout replay", async () => {
    const rename = await showStrictRename();
    const save = screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "Cancel rename" }) as HTMLButtonElement;
    const row = screen.getByTestId("token-row") as HTMLLIElement;
    const controls = [row, rename.form, rename.input, save, cancel] as const;
    const refs = controls.map((element) =>
      reactProp<(value: typeof element | null) => void>(element, "ref"));

    act(() => {
      controls.forEach((element, index) => {
        refs[index]?.(null);
        refs[index]?.(element);
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    const currentInput = screen.getByLabelText("Token name") as HTMLInputElement;
    const rejected = renameEscape(currentInput);
    expect(rejected.defaultPrevented).toBe(false);
    expect(screen.getByLabelText("Token name")).toBe(currentInput);
    expect(callsFor("PATCH")).toHaveLength(0);
    expect(callsFor("POST")).toHaveLength(0);
  });

  it("rejects modified, repeated, composing, non-bubbling, non-cancelable, stopped, prevented, fabricated, and foreign keys", async () => {
    const rename = await showStrictRename();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const assertOpen = () => {
      expect(screen.getByLabelText("Token name")).toBe(rename.input);
      expect(callsFor("PATCH")).toHaveLength(0);
      expect(callsFor("POST")).toHaveLength(0);
    };

    for (const init of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { repeat: true },
      { isComposing: true },
      { bubbles: false },
      { cancelable: false },
    ] satisfies KeyboardEventInit[]) {
      const event = renameEscape(rename.input, init);
      expect(event.defaultPrevented).toBe(false);
      expect(preventDefault.mock.contexts.filter((context) => context === event)).toHaveLength(0);
      assertOpen();
    }

    const wrongType = renameEscape(rename.input, { type: "keyup" });
    const wrongKey = renameEscape(rename.input, { key: "Tab" });
    expect(wrongType.defaultPrevented).toBe(false);
    expect(wrongKey.defaultPrevented).toBe(false);
    assertOpen();

    const prevented = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    prevented.preventDefault();
    const preventedBeforeDispatch = preventDefault.mock.contexts.filter(
      (context) => context === prevented,
    ).length;
    act(() => {
      rename.input.dispatchEvent(prevented);
    });
    expect(preventDefault.mock.contexts.filter((context) => context === prevented)).toHaveLength(
      preventedBeforeDispatch,
    );
    assertOpen();

    const stopped = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    rename.input.addEventListener("keydown", (event) => event.stopPropagation(), { once: true });
    act(() => {
      rename.input.dispatchEvent(stopped);
    });
    expect(stopped.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === stopped)).toHaveLength(0);
    assertOpen();

    const inputHandler = reactProp<
      (event: ReactKeyboardEvent<HTMLInputElement>) => void
    >(rename.input, "onKeyDown");
    const fabricatedPrevent = vi.fn();
    const fabricatedNative = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      inputHandler({
        _reactName: "onKeyDown",
        type: "keydown",
        key: "Escape",
        currentTarget: rename.input,
        target: rename.input,
        nativeEvent: fabricatedNative,
        preventDefault: fabricatedPrevent,
      } as unknown as ReactKeyboardEvent<HTMLInputElement>);
    });
    expect(fabricatedPrevent).not.toHaveBeenCalled();
    assertOpen();

    const frame = document.createElement("iframe");
    document.body.append(frame);
    const foreignWindow = frame.contentWindow as (Window & typeof globalThis) | null;
    if (!foreignWindow) throw new Error("The foreign token rename realm was unavailable");
    const foreign = new foreignWindow.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    act(() => {
      rename.input.dispatchEvent(foreign);
    });
    expect(foreign.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === foreign)).toHaveLength(0);
    assertOpen();
    frame.remove();
  });

  it.each([
    "restored input attribute",
    "restored form order",
    "replaced and restored input",
  ] as const)("retires %s history with no prevention, state, or request work", async (mutation) => {
    const rename = await showStrictRename();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    if (mutation === "restored input attribute") {
      rename.input.setAttribute("data-transient", "true");
      rename.input.removeAttribute("data-transient");
    } else if (mutation === "restored form order") {
      const guidance = rename.form.children.item(1);
      if (!guidance) throw new Error("The rename guidance is missing");
      rename.form.append(guidance);
      rename.form.insertBefore(guidance, rename.form.children.item(1));
    } else {
      const replacement = rename.input.cloneNode(true);
      rename.input.replaceWith(replacement);
      replacement.replaceWith(rename.input);
    }

    const event = renameEscape(rename.input);
    expect(event.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === event)).toHaveLength(0);
    expect(screen.getByLabelText("Token name")).toBe(rename.input);
    expect(callsFor("PATCH")).toHaveLength(0);
    expect(callsFor("POST")).toHaveLength(0);
  });

  it("rejects a partial ref replay and post-cleanup handlers, then admits a clean keyed successor", async () => {
    const rename = await showStrictRename();
    const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
    const staleInput = reactProp<
      (event: ReactKeyboardEvent<HTMLInputElement>) => void
    >(rename.input, "onKeyDown");
    const staleForm = reactProp<
      (event: ReactKeyboardEvent<HTMLFormElement>) => void
    >(rename.form, "onKeyDown");
    const inputRef = reactProp<(element: HTMLInputElement | null) => void>(
      rename.input,
      "ref",
    );
    act(() => {
      inputRef(null);
      inputRef(rename.input);
    });
    const replayedInput = screen.getByLabelText("Token name") as HTMLInputElement;
    const replayed = renameEscape(replayedInput);
    expect(replayed.defaultPrevented).toBe(false);
    expect(preventDefault.mock.contexts.filter((context) => context === replayed)).toHaveLength(0);
    expect(screen.getByLabelText("Token name")).toBe(replayedInput);

    fetchMock
      .mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ tokens: [token] }));
    act(() => rename.root.render(
      <StrictMode>
        <TokensPanel key="clean-successor" origin="https://markdoc.test" userLogin="alice" />
      </StrictMode>,
    ));
    const currentRename = await screen.findByRole("button", { name: `Rename ${token.name}` });
    fireEvent.click(currentRename);
    const currentInput = screen.getByLabelText("Token name") as HTMLInputElement;
    expect(currentInput).not.toBe(replayedInput);

    const staleNative = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const stalePrevent = vi.fn();
    const staleWrapper = {
      _reactName: "onKeyDown",
      type: "keydown",
      key: "Escape",
      currentTarget: replayedInput,
      target: replayedInput,
      nativeEvent: staleNative,
      preventDefault: stalePrevent,
    } as unknown as ReactKeyboardEvent<HTMLInputElement>;
    act(() => {
      staleInput(staleWrapper);
      staleForm({
        ...staleWrapper,
        currentTarget: rename.form,
      } as unknown as ReactKeyboardEvent<HTMLFormElement>);
    });
    expect(stalePrevent).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Token name")).toBe(currentInput);

    const accepted = renameEscape(currentInput);
    expect(accepted.defaultPrevented).toBe(true);
    expect(preventDefault.mock.contexts.filter((context) => context === accepted)).toHaveLength(1);
    expect(screen.queryByLabelText("Token name")).toBeNull();
    expect(callsFor("PATCH")).toHaveLength(0);
    expect(callsFor("POST")).toHaveLength(0);
  });
});

describe("Settings → Agents: 'Collaborators may ask this agent' (#1296)", () => {
  it("shows one labelled switch per token, off by default, and PATCHes exactly { collaboratorsMayAsk: true } when turned on", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [token, { ...token, id: "tok-2", name: "Reviewer", collaboratorsMayAsk: true }] })).mockResolvedValueOnce(response({ token: { ...token, collaboratorsMayAsk: true } }));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const switches = await screen.findAllByTestId("token-collaborators-may-ask");
    expect(switches).toHaveLength(2);
    expect(switches[0]).toHaveAttribute("role", "switch");
    expect(switches[0]).toHaveAttribute("aria-checked", "false");
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(switches[0]).toHaveAccessibleName("Collaborators may ask this agent");
    expect(switches[0]).toHaveAccessibleDescription("Off: only you can send requests to it. On: people you share documents with can too.");

    fireEvent.click(switches[0]);

    // Optimistic: on at once, then one PATCH to this token with the flag alone.
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual(["/api/tokens/tok-1", { collaboratorsMayAsk: true }]);
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("turns a switch off again with { collaboratorsMayAsk: false }", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [{ ...token, collaboratorsMayAsk: true }] })).mockResolvedValueOnce(response({ token: { ...token, collaboratorsMayAsk: false } }));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const toggle = await screen.findByTestId("token-collaborators-may-ask");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual(["/api/tokens/tok-1", { collaboratorsMayAsk: false }]);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("reverts the switch and says why when the server refuses, and the next click sends a fresh PATCH", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(response({ error: "Token service temporarily unavailable" }, 500))
      .mockResolvedValueOnce(response({ token: { ...token, collaboratorsMayAsk: true } }));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const toggle = await screen.findByTestId("token-collaborators-may-ask");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    const alert = await screen.findByRole("alert");
    expect(alert).toBe(screen.getByTestId("token-collaborators-may-ask-error"));
    expect(alert).toHaveTextContent("Could not update “Copilot CLI”: Token service temporarily unavailable");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(patches()).toHaveLength(1);

    // The failed flip left nothing behind: clicking again PATCHes again, and this time the row takes the server's answer.
    fireEvent.click(toggle);
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual(["/api/tokens/tok-1", { collaboratorsMayAsk: true }]);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("preserves newly created rows and successful switch changes when an earlier list reload arrives (#1538)", async () => {
    // Mint a token (POST → reload GET), then turn the new switch on while that GET is still in flight: it started before
    // the click, so what it carries (Off) is older than the PATCH's 200 and must not replace it.
    const stale = deferred();
    fetchMock
      .mockResolvedValueOnce(response({ tokens: [token] }))
      .mockResolvedValueOnce(minted())
      .mockReturnValueOnce(stale.later)
      .mockResolvedValueOnce(response({ token: { ...token, collaboratorsMayAsk: true } }));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const toggle = await screen.findByTestId("token-collaborators-may-ask");
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual(["/api/tokens/tok-1", { collaboratorsMayAsk: true }]);
    await waitFor(() => expect(toggle).toBeEnabled());

    stale.settle(response({ tokens: [token, { ...token, id: "tok-2", name: "New agent" }] }));
    await waitFor(() => expect(screen.getAllByTestId("token-row")).toHaveLength(2));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(patches()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the switch on when the stale list reload lands while the PATCH is still in flight, then takes the PATCH's row (#1538)", async () => {
    const stale = deferred();
    const patch = deferred();
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] })).mockResolvedValueOnce(minted()).mockReturnValueOnce(stale.later).mockReturnValueOnce(patch.later);
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const toggle = await screen.findByTestId("token-collaborators-may-ask");
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(patches()).toHaveLength(1));

    // The reload is the newest list load, so it is applied (the minted token shows up) — with the in-flight value laid
    // over the row being PATCHed, not the Off it carries for it.
    stale.settle(response({ tokens: [token, { ...token, id: "tok-2", name: "GitHub Copilot CLI", prefix: "mdk_new" }] }));
    await waitFor(() => expect(screen.getAllByTestId("token-row")).toHaveLength(2));
    const switches = screen.getAllByTestId("token-collaborators-may-ask");
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");

    // The PATCH answers the row as the server has it now; that row replaces ours (here: it was used since the list loaded).
    patch.settle(response({ token: { ...token, collaboratorsMayAsk: true, lastUsedAt: "2026-08-30T00:00:00.000Z" } }));
    await waitFor(() => expect(screen.getAllByTestId("token-row")[0]).toHaveTextContent(/· used /));
    expect(switches[0]).toHaveAttribute("aria-checked", "true");
    expect(switches[1]).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(patches()).toHaveLength(1);
  });

  it("drops a list load that a newer one overtook (StrictMode mounts load twice; the first answer may land last)", async () => {
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.later).mockResolvedValueOnce(response({ tokens: [token] }));
    render(
      <StrictMode>
        <TokensPanel origin="https://markdoc.test" userLogin="alice" />
      </StrictMode>,
    );

    expect(await screen.findAllByTestId("token-row")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    first.settle(response({ tokens: [] }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId("token-row")).toHaveLength(1);
    expect(screen.queryByText("No tokens yet.")).toBeNull();
  });
});

describe("Settings → Agents: the create form shows the validation reason (#1480)", () => {
  it("shows the field's issue message, not the bare \"Invalid request\", when the server rejects the new token", async () => {
    // `handler()` answers a zod failure with `400 { error: "Invalid request", issues }`; the panel's `request()` turns
    // that into `new ApiError(400, "Invalid request", [{ path: ["name"], message: "Name is required" }])`.
    fetchMock
      .mockResolvedValueOnce(response({ tokens: [] }))
      .mockResolvedValueOnce(response({ error: "Invalid request", issues: [{ path: ["name"], message: "Name is required" }] }, 400));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    await screen.findByText("No tokens yet.");
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-create"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Name is required");
    expect(alert).not.toHaveTextContent("Invalid request");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("Settings → Agents: created-secret publication authority", () => {
  it("copies once from a direct-root Strict Mode publication and preserves feedback", async () => {
    const secret = await showStrictSecret();
    const icon = secret.copy.firstElementChild;
    if (!icon) throw new Error("The Copy token control has no icon");
    const ownerWindow = secret.copy.ownerDocument.defaultView!;
    const click = new ownerWindow.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    copyText.mockImplementationOnce(() => {
      secret.copy.dispatchEvent(new ownerWindow.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
      return Promise.resolve(true);
    });

    act(() => {
      fireEvent(icon, click);
      fireEvent(icon, click);
    });

    expect(copyText).toHaveBeenCalledExactlyOnceWith(createdSecret.token);
    expect(selectContents).not.toHaveBeenCalled();
    await waitFor(() => expect(secret.copy).toHaveTextContent("Copied"));
    expect(secret.copy.firstElementChild).toHaveClass("lucide-check");
  });

  it("hides once from a direct-root Strict Mode publication and focuses Tokens", async () => {
    const secret = await showStrictSecret();
    const tokensButton = screen.getByRole("button", { name: "Tokens" });
    const focus = vi.spyOn(tokensButton, "focus");

    fireEvent.click(secret.hide);
    secret.hide.click();

    expect(screen.queryByTestId("token-created")).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    expect(tokensButton).toHaveFocus();
    expect(copyText).not.toHaveBeenCalled();
  });

  it("preserves selection fallback and resets only the feedback it owns", async () => {
    const secret = await showStrictSecret();
    vi.useFakeTimers();
    copyText.mockResolvedValueOnce(false);

    await act(async () => {
      fireEvent.click(secret.copy);
      await Promise.resolve();
    });

    expect(copyText).toHaveBeenCalledExactlyOnceWith(createdSecret.token);
    expect(selectContents).toHaveBeenCalledExactlyOnceWith(secret.code);
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Select & press Ctrl+C");
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Copy");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects fabricated and crossed events without retiring the current controls", async () => {
    const secret = await showStrictSecret();
    const copy = reactProp<(event: ReactMouseEvent<HTMLButtonElement>) => void>(secret.copy, "onClick");
    const hide = reactProp<(event: ReactMouseEvent<HTMLButtonElement>) => void>(secret.hide, "onClick");
    const nativeEvent = new secret.copy.ownerDocument.defaultView!.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    const fabricated = {
      type: "click",
      button: 0,
      bubbles: true,
      cancelable: true,
      eventPhase: 0,
      currentTarget: secret.copy,
      target: secret.copy,
      nativeEvent,
      defaultPrevented: false,
    } as unknown as ReactMouseEvent<HTMLButtonElement>;

    act(() => {
      copy(fabricated);
      invokeHandlerFromNative(secret.hide, copy);
      invokeHandlerFromNative(secret.copy, hide);
    });

    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expect(screen.getByTestId("token-created")).toBe(secret.notice);

    fireEvent.click(secret.copy);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(createdSecret.token);
    await waitFor(() => expect(secret.copy).toHaveTextContent("Copied"));
    fireEvent.click(secret.hide);
    expect(screen.queryByTestId("token-created")).toBeNull();
  });

  it("retires equal-looking controls across a manager visit without letting stale handlers poison the successor", async () => {
    const secret = await showStrictSecret();
    const staleCopy = reactProp<(event: ReactMouseEvent<HTMLButtonElement>) => void>(secret.copy, "onClick");
    const staleHide = reactProp<(event: ReactMouseEvent<HTMLButtonElement>) => void>(secret.hide, "onClick");

    act(() => secret.root.render(
      <StrictMode>
        <TokensPanel origin="https://markdoc.test" userLogin="alice" next="/d/current" />
      </StrictMode>,
    ));

    const currentNotice = screen.getByTestId("token-created");
    const currentCopy = screen.getByRole("button", { name: "Copy token" }) as HTMLButtonElement;
    const currentHide = screen.getByRole("button", { name: "I stored it - hide secret" }) as HTMLButtonElement;
    expect(currentNotice).not.toBe(secret.notice);
    expect(currentCopy).not.toBe(secret.copy);
    expect(currentHide).not.toBe(secret.hide);

    act(() => {
      invokeHandlerFromNative(currentCopy, staleCopy);
      invokeHandlerFromNative(currentHide, staleHide);
    });
    expect(copyText).not.toHaveBeenCalled();
    expect(screen.getByTestId("token-created")).toBe(currentNotice);

    fireEvent.click(currentCopy);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(createdSecret.token);
    await waitFor(() => expect(currentCopy).toHaveTextContent("Copied"));
    fireEvent.click(currentHide);
    expect(screen.queryByTestId("token-created")).toBeNull();
  });

  it.each(["notice", "code", "copy", "hide"] as const)(
    "does not promote a partial %s ref replay",
    async (role) => {
      const secret = await showStrictSecret();
      const element = secret[role];
      const ref = reactProp<(value: typeof element | null) => void>(element, "ref");

      act(() => {
        ref(null);
        ref(element);
      });
      fireEvent.click(secret.copy);

      expect(copyText).not.toHaveBeenCalled();
      expect(selectContents).not.toHaveBeenCalled();
      expect(screen.getByTestId("token-created")).toBe(secret.notice);
    },
  );

  it.each([
    "restored notice attribute",
    "restored secret text",
    "restored control order",
    "restored notice ancestor",
    "restored ancestor sibling",
  ] as const)("permanently retires a publication after a %s mutation", async (mutation) => {
    const secret = await showStrictSecret();
    if (mutation === "restored notice attribute") {
      secret.notice.setAttribute("data-transient", "true");
      secret.notice.removeAttribute("data-transient");
    } else if (mutation === "restored secret text") {
      secret.code.textContent = "mdk_changed";
      secret.code.textContent = createdSecret.token;
    } else if (mutation === "restored control order") {
      const controls = secret.copy.parentElement!;
      controls.insertBefore(secret.hide, secret.copy);
      controls.insertBefore(secret.copy, secret.hide);
    } else if (mutation === "restored notice ancestor") {
      const manager = secret.notice.parentElement!;
      const parent = manager.parentNode!;
      const next = manager.nextSibling;
      manager.remove();
      parent.insertBefore(manager, next);
    } else {
      const marker = document.createElement("div");
      document.body.append(marker);
      marker.remove();
    }

    fireEvent.click(secret.copy);
    fireEvent.click(secret.hide);

    expect(copyText).not.toHaveBeenCalled();
    expect(selectContents).not.toHaveBeenCalled();
    expect(screen.getByTestId("token-created")).toBe(secret.notice);
  });

  it("isolates late clipboard settlement and copied timers from the exact successor", async () => {
    const oldClipboard = deferredValue<boolean>();
    copyText.mockReturnValueOnce(oldClipboard.promise);
    const secret = await showStrictSecret();
    fireEvent.click(secret.copy);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(createdSecret.token);

    const renamed = { ...secret.row, name: "Renamed strict agent" };
    fetchMock.mockResolvedValueOnce(response({ token: renamed }));
    fireEvent.click(screen.getByRole("button", { name: `Rename ${createdSecret.name}` }));
    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: renamed.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByRole("button", { name: `Rename ${renamed.name}` });
    expect(screen.getByTestId("token-created")).toHaveTextContent(`Token “${renamed.name}” created.`);
    const currentCode = screen.getByTestId("copy-token");

    await act(async () => {
      oldClipboard.reject(new Error("late old clipboard rejection"));
      await Promise.resolve();
    });
    expect(selectContents).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Copy");

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy token" }));
      await Promise.resolve();
    });
    expect(copyText).toHaveBeenCalledTimes(2);
    expect(copyText).toHaveBeenLastCalledWith(createdSecret.token);
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Copied");
    expect(vi.getTimerCount()).toBe(1);

    act(() => secret.root.render(
      <StrictMode>
        <TokensPanel origin="https://markdoc.test" userLogin="alice" next="/d/after-copy" />
      </StrictMode>,
    ));
    expect(screen.getByTestId("copy-token")).not.toBe(currentCode);
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Copy");
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Copy token" })).toHaveTextContent("Copy");
  });
});
