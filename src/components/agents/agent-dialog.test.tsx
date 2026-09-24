// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ApiTokenDto } from "@/lib/api";
import { AgentDialog } from "./agent-dialog";

const DOC = { id: "doc1", title: "Launch plan" };
const SEEN = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

function makeKey(overrides: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: "k1",
    name: "Copilot CLI",
    prefix: "mdk_abcd",
    scope: "comment",
    documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    lastMcpSeenAt: SEEN,
    lastMcpCallAt: null,
    expiresAt: null,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let listResponse: () => Response;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  listResponse = () => json({ tokens: [] });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/tokens") && (init?.method ?? "GET") === "GET") return listResponse();
    throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog(onOpenChange = vi.fn()) {
  return render(<AgentDialog doc={DOC} open onOpenChange={onOpenChange} />);
}

const wizardShown = async () => screen.findByTestId("agent-setup");
const returningShown = async () => screen.findByTestId("agent-connected");

describe("AgentDialog", () => {
  it("has a plain title and one sentence of explanation", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Connect an AI agent" });
    expect(within(dialog).getByText("It reads, comments and suggests edits. You accept or reject each one.")).toBeInTheDocument();
    await wizardShown();
  });

  it("checks your agents first, then walks a first-time user through setup", async () => {
    renderDialog();
    expect(screen.getByText("Checking your agents…")).toBeInTheDocument();
    expect(await wizardShown()).toHaveAttribute("data-state", "new");
    expect(screen.queryByTestId("agent-connected")).toBeNull();
    expect(screen.getByTestId("agent-create-key")).toBeInTheDocument();
  });

  it("goes straight to the invite when an agent has already connected", async () => {
    listResponse = () => json({ tokens: [makeKey()] });
    renderDialog();
    const returning = await returningShown();

    expect(within(returning).getByTestId("agent-connected-banner")).toHaveTextContent("Copilot CLI is connected");
    expect(within(returning).getByTestId("agent-connected-banner")).toHaveTextContent(/Last seen/);
    expect(within(returning).getByTestId("agent-invite-prompt")).toHaveTextContent('Sit in the Markdoc document "Launch plan" (id doc1)');
    expect(within(returning).getByTestId("agent-invite-copy")).toHaveClass("btn-primary");
    expect(screen.queryByTestId("agent-create-key")).toBeNull();
    expect(screen.queryByTestId("agent-client-copilot-cli")).toBeNull();
  });

  it("links to the key list, coming back to this document", async () => {
    listResponse = () => json({ tokens: [makeKey()] });
    renderDialog();
    await returningShown();
    expect(screen.getByTestId("agent-manage-keys")).toHaveAttribute("href", "/settings?next=%2Fd%2Fdoc1#tokens");
  });

  it("names every connected agent", async () => {
    listResponse = () => json({ tokens: [makeKey(), makeKey({ id: "k2", name: "Cursor" })] });
    renderDialog();
    expect(await screen.findByTestId("agent-connected-banner")).toHaveTextContent("Copilot CLI, Cursor are connected");
  });

  it("counts a key that only this document allows", async () => {
    listResponse = () => json({ tokens: [makeKey({ documentIds: ["doc1"] })] });
    renderDialog();
    await returningShown();
  });

  const notConnected: [string, Partial<ApiTokenDto>][] = [
    ["a key limited to other documents", { documentIds: ["other"] }],
    ["a key that expired", { expiresAt: "2026-01-01T00:00:00.000Z" }],
    ["a key no agent has used", { lastMcpSeenAt: null, lastUsedAt: null }],
  ];
  it.each(notConnected)("does not count %s as connected", async (_label, overrides) => {
    listResponse = () => json({ tokens: [makeKey(overrides)] });
    renderDialog();
    expect(await wizardShown()).toBeInTheDocument();
    expect(screen.queryByTestId("agent-connected")).toBeNull();
  });

  it("still lets you set up when the key list cannot be loaded", async () => {
    listResponse = () => json({ error: "Down" }, 503);
    renderDialog();
    expect(await wizardShown()).toBeInTheDocument();
    expect(screen.getByTestId("agent-create-key")).toBeEnabled();
  });

  it("offers to connect another agent from the invite", async () => {
    listResponse = () => json({ tokens: [makeKey()] });
    renderDialog();
    await returningShown();

    fireEvent.click(screen.getByTestId("agent-connect-another"));

    expect(await wizardShown()).toBeInTheDocument();
    expect(screen.queryByTestId("agent-connected")).toBeNull();
  });

  it("closes from the header button", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    await wizardShown();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
