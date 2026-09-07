// @vitest-environment jsdom
import { createElement, StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listTokens = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());

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
}));

import { AgentConnectCard } from "@/components/settings/agent-connect-card";
import { ApiError, api } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY, AGENT_DOCS_URL } from "@/lib/mcp";
import { KeepAgentHereDialog, KeepAgentHerePanel, keepAgentPrompt } from "./keep-agent-here";

type TokenListResponse = Awaited<ReturnType<typeof api.tokens.list>>;

const DOC = { id: "doc-1", title: "Plan" };

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
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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
