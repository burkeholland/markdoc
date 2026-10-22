// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { ApiTokenDto, CreatedApiTokenDto } from "@/lib/api";
import { AgentsPanel } from "./agents-panel";

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
    id: "key-2",
    name: "Copilot CLI",
    token: "mdk_created_secret",
    prefix: "mdk_created",
    scope: "comment",
    documentIds: null,
    createdAt: "2026-09-24T12:00:00.000Z",
    expiresAt: "2026-12-24T12:00:00.000Z",
    ...overrides,
  };
}

function renderPanel({
  initialTokens = [],
  next,
  userLogin = "octocat",
}: {
  initialTokens?: ApiTokenDto[];
  next?: string | null;
  userLogin?: string;
} = {}) {
  render(<AgentsPanel mcpUrl="https://mcp.markdoc.test/mcp" userLogin={userLogin} next={next} initialTokens={initialTokens} />);
}

function routeTokens(tokens: ApiTokenDto[], create?: CreatedApiTokenDto) {
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    if (url === "/api/tokens" && method === "GET") return Promise.resolve(response({ tokens }));
    if (url === "/api/tokens" && method === "POST" && create) return Promise.resolve(response({ token: create }));
    return Promise.resolve(response({ error: "Unexpected request" }, 500));
  });
}

async function requestBody(index = 0) {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : body;
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AgentsPanel", () => {
  it("shows setup and no keys card when there are no keys", async () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens([]);
    renderPanel({ initialTokens: [] });

    expect(screen.getByRole("heading", { name: "Connect an agent" })).toBeInTheDocument();
    expect(screen.getByTestId("agent-setup")).toBeInTheDocument();
    expect(screen.queryByTestId("keys-card")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/tokens", expect.anything()));
  });

  it("hides setup behind a toggle and lists existing keys", () => {
    vi.stubGlobal("fetch", fetchMock);
    const existing = key({ name: "Claude Desktop" });
    routeTokens([existing]);
    renderPanel({ initialTokens: [existing] });

    expect(screen.getByRole("heading", { name: "Connect another agent" })).toBeInTheDocument();
    expect(screen.queryByTestId("agent-setup")).toBeNull();
    expect(screen.getByTestId("agent-setup-toggle")).toHaveTextContent("Set up");
    expect(screen.getByTestId("keys-card")).toHaveTextContent("Claude Desktop");

    fireEvent.click(screen.getByTestId("agent-setup-toggle"));
    expect(screen.getByTestId("agent-setup")).toBeInTheDocument();
    expect(screen.getByTestId("agent-setup-toggle")).toHaveTextContent("Hide");
  });

  it("keeps setup visible after creating a key and keeps the secret out of the keys list", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const listed = key({ id: "key-2", name: "Copilot CLI", prefix: "mdk_created" });
    let created = false;
    fetchMock.mockImplementation((url, init) => {
      const method = init?.method ?? "GET";
      if (url === "/api/tokens" && method === "GET") return Promise.resolve(response({ tokens: created ? [listed] : [] }));
      if (url === "/api/tokens" && method === "POST") {
        created = true;
        return Promise.resolve(response({ token: createdKey() }));
      }
      return Promise.resolve(response({ error: "Unexpected request" }, 500));
    });
    renderPanel({ initialTokens: [] });

    fireEvent.click(screen.getByTestId("agent-create-key"));

    await waitFor(() => expect(screen.getByTestId("agent-setup-snippet")).toHaveTextContent("mdk_created_secret"));
    await waitFor(() => expect(screen.getByTestId("keys-card")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Connect another agent" })).toBeInTheDocument();
    expect(screen.getByTestId("agent-setup")).toBeInTheDocument();
    expect(screen.getByTestId("keys-card")).toHaveTextContent("Copilot CLI");
    expect(within(screen.getByTestId("keys-card")).queryByText(/mdk_created_secret/)).toBeNull();

    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(postCall?.[0]).toBe("/api/tokens");
    const postIndex = fetchMock.mock.calls.indexOf(postCall!);
    expect(await requestBody(postIndex)).toMatchObject({
      name: "AI agent",
      expiresInDays: 90,
      scope: "comment",
      documentIds: null,
    });
  });

  it("renders the document back link only when next is provided", () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens([]);
    renderPanel({ next: "/documents/doc-1" });
    expect(screen.getByTestId("settings-back-to-document")).toHaveAttribute("href", "/documents/doc-1");

    cleanup();
    fetchMock.mockReset();
    routeTokens([]);
    renderPanel({ next: null });
    expect(screen.queryByTestId("settings-back-to-document")).toBeNull();
  });

  it("mentions the user login in the intro", () => {
    vi.stubGlobal("fetch", fetchMock);
    routeTokens([]);
    renderPanel({ userLogin: "mona" });

    expect(screen.getByText("mona via AI agent")).toBeInTheDocument();
  });
});
