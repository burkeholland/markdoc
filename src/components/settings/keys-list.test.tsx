// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { ApiTokens } from "@/components/agents/use-api-tokens";
import type { ApiTokenDto, CreatedApiTokenDto } from "@/lib/api";
import { KeysList } from "./keys-list";

const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function key(overrides: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: "key-1",
    name: "Copilot CLI",
    prefix: "mdk_live",
    scope: "comment",
    documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2026-09-01T12:00:00.000Z",
    lastUsedAt: null,
    lastMcpSeenAt: null,
    lastMcpCallAt: null,
    expiresAt: "2026-12-01T12:00:00.000Z",
    ...overrides,
  };
}

function createdKey(overrides: Partial<CreatedApiTokenDto> = {}): CreatedApiTokenDto {
  return {
    id: "key-1",
    name: "Copilot CLI",
    token: "mdk_new_secret",
    prefix: "mdk_new",
    scope: "comment",
    documentIds: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    expiresAt: "2026-12-24T12:00:00.000Z",
    ...overrides,
  };
}

function renderList(props: Partial<ApiTokens> = {}) {
  const tokens = props.tokens === undefined ? [key()] : props.tokens;
  const apiTokens: ApiTokens = {
    tokens,
    error: props.error ?? null,
    reload: props.reload ?? vi.fn().mockResolvedValue(undefined),
    patch: props.patch ?? vi.fn(),
  };
  render(<KeysList {...apiTokens} />);
  return apiTokens;
}

async function requestBody(index = 0) {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : body;
}

function routeTokens({
  patch,
  replace,
  revoke,
}: {
  patch?: Response;
  replace?: Response;
  revoke?: Response;
} = {}) {
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/tokens/key-1" && method === "PATCH") return Promise.resolve(patch ?? response({ token: key({ name: "Claude Desktop" }) }));
    if (url === "/api/tokens/key-1/replace" && method === "POST") return Promise.resolve(replace ?? response({ token: createdKey() }));
    if (url === "/api/tokens/key-1" && method === "DELETE") return Promise.resolve(revoke ?? response({ ok: true }));
    return Promise.resolve(response({ error: "Unexpected request" }, 500));
  });
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("KeysList", () => {
  it("shows loading, error with retry, and empty states", () => {
    renderList({ tokens: null });
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    cleanup();

    const reload = vi.fn().mockResolvedValue(undefined);
    renderList({ tokens: null, error: "Could not load keys.", reload });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load keys.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledOnce();
    cleanup();

    renderList({ tokens: [] });
    expect(screen.getByText(/No keys yet/)).toBeInTheDocument();
  });

  it("renders row details, connection status, and document counts", () => {
    renderList({
      tokens: [
        key({ id: "connected", name: "Connected key", lastMcpSeenAt: "2026-09-24T14:00:00.000Z", documentIds: null }),
        key({ id: "one-doc", name: "One doc key", lastUsedAt: "2026-09-24T13:00:00.000Z", documentIds: ["doc-1"] }),
        key({ id: "many-docs", name: "Many docs key", documentIds: ["doc-1", "doc-2", "doc-3"] }),
      ],
    });

    const rows = screen.getAllByTestId("key-row");
    expect(within(rows[0]).getByTestId("key-name")).toHaveTextContent("Connected key");
    expect(within(rows[0]).getByTestId("key-scope")).toHaveTextContent("Comment & suggest");
    expect(within(rows[0]).getByTestId("key-status")).toHaveTextContent("Connected");
    expect(within(rows[0]).getByTestId("key-status")).toHaveTextContent("all documents");
    expect(within(rows[0]).getByRole("time")).toHaveAttribute("dateTime", "2026-09-24T14:00:00.000Z");
    expect(within(rows[1]).getByTestId("key-status")).toHaveTextContent("1 document");
    expect(within(rows[2]).getByTestId("key-status")).toHaveTextContent("Not connected yet");
    expect(within(rows[2]).getByTestId("key-status")).toHaveTextContent("3 documents");
  });

  it("limits expired keys to revoke", () => {
    renderList({ tokens: [key({ expiresAt: "2026-01-01T00:00:00.000Z" })] });
    fireEvent.click(screen.getByTestId("key-manage"));

    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByTestId("key-revoke")).toBeInTheDocument();
    expect(screen.queryByTestId("key-rename")).toBeNull();
    expect(screen.queryByTestId("key-replace")).toBeNull();
    expect(screen.queryByTestId("key-may-ask")).toBeNull();
  });

  it("toggles details and aria-expanded from Manage", () => {
    renderList();
    const manage = screen.getByTestId("key-manage");

    expect(manage).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("key-details")).toBeNull();
    fireEvent.click(manage);
    expect(manage).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("key-details")).toBeInTheDocument();
  });

  it("renames a key, keeps failed forms open, and skips empty or unchanged names", async () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens({ patch: response({ token: key({ name: "Claude Desktop" }) }) });
    const patch = vi.fn();
    renderList({ patch });
    fireEvent.click(screen.getByTestId("key-manage"));
    fireEvent.click(screen.getByTestId("key-rename"));
    fireEvent.change(screen.getByTestId("key-rename-input"), { target: { value: "Claude Desktop" } });
    fireEvent.click(screen.getByTestId("key-rename-save"));

    await waitFor(() => expect(patch).toHaveBeenCalledWith("key-1", { name: "Claude Desktop" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/key-1", expect.objectContaining({ method: "PATCH" }));
    expect(await requestBody()).toEqual({ name: "Claude Desktop" });
    expect(screen.queryByTestId("key-rename-input")).toBeNull();

    cleanup();
    fetchMock.mockReset();
    routeTokens({ patch: response({ error: "Name is taken" }, 409) });
    renderList();
    fireEvent.click(screen.getByTestId("key-manage"));
    fireEvent.click(screen.getByTestId("key-rename"));
    fireEvent.change(screen.getByTestId("key-rename-input"), { target: { value: "Taken" } });
    fireEvent.click(screen.getByTestId("key-rename-save"));
    await waitFor(() => expect(screen.getByTestId("key-error")).toHaveTextContent("Name is taken"));
    expect(screen.getByTestId("key-rename-input")).toBeInTheDocument();

    fetchMock.mockClear();
    fireEvent.change(screen.getByTestId("key-rename-input"), { target: { value: "Copilot CLI" } });
    fireEvent.click(screen.getByTestId("key-rename-save"));
    await waitFor(() => expect(screen.queryByTestId("key-rename-input")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("key-rename"));
    fireEvent.change(screen.getByTestId("key-rename-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("key-rename-save"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces a key, shows the one time secret, reloads, dismisses, and cancels without a request", async () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens();
    const reload = vi.fn().mockResolvedValue(undefined);
    renderList({ reload });
    fireEvent.click(screen.getByTestId("key-manage"));
    fireEvent.click(screen.getByTestId("key-replace"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("key-replace"));
    fireEvent.click(screen.getByTestId("key-replace-confirm-button"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/key-1/replace", expect.objectContaining({ method: "POST" }));
    expect(screen.getByTestId("key-replaced")).toHaveTextContent("New key for Copilot CLI");
    expect(screen.getByTestId("key-replaced-secret")).toHaveTextContent("mdk_new_secret");
    expect(screen.getByTestId("key-replaced-copy")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss new key"));
    expect(screen.queryByTestId("key-replaced")).toBeNull();
  });

  it("revokes a key, reloads, and cancels without a request", async () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens();
    const reload = vi.fn().mockResolvedValue(undefined);
    renderList({ reload });
    fireEvent.click(screen.getByTestId("key-manage"));
    fireEvent.click(screen.getByTestId("key-revoke"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("key-revoke"));
    fireEvent.click(screen.getByTestId("key-revoke-confirm-button"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/tokens/key-1", expect.objectContaining({ method: "DELETE" }));
  });

  it("optimistically toggles collaborator access and rolls back on failure", async () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens({ patch: response({ error: "Denied" }, 403) });
    const patch = vi.fn();
    renderList({ patch });
    fireEvent.click(screen.getByTestId("key-manage"));
    const toggle = screen.getByTestId("key-may-ask");

    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(patch).toHaveBeenNthCalledWith(1, "key-1", { collaboratorsMayAsk: true });
    expect(await requestBody()).toEqual({ collaboratorsMayAsk: true });
    await waitFor(() => expect(patch).toHaveBeenNthCalledWith(2, "key-1", { collaboratorsMayAsk: false }));
    expect(screen.getByTestId("key-error")).toHaveTextContent("Denied");
  });

  it("locks the collaborator switch while its request is in flight, so requests cannot race", async () => {
    vi.stubGlobal("fetch", fetchMock);
    let answer!: () => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(response({ token: key({ collaboratorsMayAsk: true }) }));
        }),
    );
    renderList();
    fireEvent.click(screen.getByTestId("key-manage"));
    const toggle = screen.getByTestId("key-may-ask");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    fireEvent.click(toggle);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer();
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it("says when an agent last used the key and when it last called a tool", () => {
    renderList({ tokens: [key({ lastMcpSeenAt: "2026-09-24T14:00:00.000Z", lastMcpCallAt: "2026-09-24T15:00:00.000Z" })] });
    fireEvent.click(screen.getByTestId("key-manage"));
    expect(within(screen.getByTestId("key-last-request")).getByRole("time")).toHaveAttribute("dateTime", "2026-09-24T14:00:00.000Z");
    expect(within(screen.getByTestId("key-last-tool-call")).getByRole("time")).toHaveAttribute("dateTime", "2026-09-24T15:00:00.000Z");
    cleanup();

    renderList({ tokens: [key()] });
    fireEvent.click(screen.getByTestId("key-manage"));
    expect(screen.getByTestId("key-last-request")).toHaveTextContent("Never");
    expect(screen.getByTestId("key-last-tool-call")).toHaveTextContent("Never");
  });
});
