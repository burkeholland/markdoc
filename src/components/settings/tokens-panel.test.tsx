// @vitest-environment jsdom
import { StrictMode } from "react";
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

/** A `fetch` answer the test settles later, to make one request land after another that started after it. */
function deferred() {
  let settle!: (r: Response) => void;
  const later = new Promise<Response>((r) => (settle = r));
  return { later, settle };
}

/** `POST /api/tokens` answer: minting a token is the user's path to a list reload right before the switch click. */
const minted = () => response({ token: { token: "mdk_new_secret", name: "GitHub Copilot CLI", scope: "comment", documentIds: null } });

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

  it("does not snap the switch back when a list reload that started before the click lands after the PATCH succeeded (#1538)", async () => {
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
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual(["/api/tokens/tok-1", { collaboratorsMayAsk: true }]);

    stale.settle(response({ tokens: [token] }));
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
    fireEvent.click(screen.getByTestId("token-create"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Name is required");
    expect(alert).not.toHaveTextContent("Invalid request");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
