// @vitest-environment jsdom
import { StrictMode, useEffect, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.unstubAllGlobals();
  expect(unhandledRejections).toEqual([]);
});

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
