// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  it("reverts the switch and says why when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(response({ tokens: [token] })).mockResolvedValueOnce(response({ error: "Token service temporarily unavailable" }, 500));
    render(<TokensPanel origin="https://markdoc.test" userLogin="alice" />);

    const toggle = await screen.findByTestId("token-collaborators-may-ask");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    const alert = await screen.findByRole("alert");
    expect(alert).toBe(screen.getByTestId("token-collaborators-may-ask-error"));
    expect(alert).toHaveTextContent("Could not update “Copilot CLI”: Token service temporarily unavailable");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(patches()).toHaveLength(1);
  });
});
