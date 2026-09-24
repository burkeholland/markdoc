// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiTokenDto } from "@/lib/api";
import { AgentSetup } from "./agent-setup";
import { useApiTokens } from "./use-api-tokens";

const ORIGIN = "https://docs.example.com";
const SECRET = `mdk_${"s".repeat(40)}`;
const DOC = { id: "doc1", title: "Launch plan" };

function makeKey(overrides: Partial<ApiTokenDto> = {}): ApiTokenDto {
  return {
    id: "existing",
    name: "Copilot CLI",
    prefix: "mdk_abcd",
    scope: "comment",
    documentIds: null,
    collaboratorsMayAsk: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    lastMcpSeenAt: null,
    lastMcpCallAt: null,
    expiresAt: null,
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let server: { tokens: ApiTokenDto[]; creates: Record<string, unknown>[]; failWith: { status: number; error: string } | null };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  server = { tokens: [], creates: [], failWith: null };
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/tokens") && method === "GET") return json({ tokens: server.tokens });
    if (url === "/api/tokens" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      server.creates.push(body);
      if (server.failWith) return json({ error: server.failWith.error }, server.failWith.status);
      const created = makeKey({ id: `new${server.creates.length}`, name: String(body.name), scope: body.scope as ApiTokenDto["scope"], documentIds: body.documentIds as string[] | null });
      server.tokens = [...server.tokens, created];
      return json({ token: { ...created, token: SECRET } }, 201);
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({ doc }: { doc?: { id: string; title: string } }) {
  const { tokens, reload } = useApiTokens();
  return <AgentSetup origin={ORIGIN} tokens={tokens} reload={reload} doc={doc} />;
}

const createKey = () => fireEvent.click(screen.getByTestId("agent-create-key"));

describe("AgentSetup", () => {
  it("starts with one clear action and a plain summary of what it will create", async () => {
    render(<Harness doc={DOC} />);
    expect(screen.getByTestId("agent-client-copilot-cli")).toBeChecked();
    expect(screen.getByRole("button", { name: /create access key/i })).toBeEnabled();
    expect(screen.getByTestId("agent-key-summary")).toHaveTextContent("Comment & suggest · all your documents · expires in 90 days");
    expect(screen.queryByTestId("agent-setup-snippet")).toBeNull();
    expect(screen.queryByTestId("agent-invite-prompt")).toBeNull();
    expect(screen.getByText(/once your agent is connected/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("remembers the chosen agent for next time", async () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByTestId("agent-client-vscode"));
    expect(localStorage.getItem("markdoc:agent-client")).toBe("vscode");
    first.unmount();

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("agent-client-vscode")).toBeChecked());
    expect(screen.getByRole("heading", { name: "Add Markdoc to VS Code" })).toBeInTheDocument();
  });

  it("creates a key and shows the exact command with that key in it", async () => {
    render(<Harness doc={DOC} />);
    createKey();
    const snippet = await screen.findByTestId("agent-setup-snippet");

    expect(server.creates).toEqual([{ name: "Copilot CLI", expiresInDays: 90, scope: "comment", documentIds: null }]);
    expect(snippet).toHaveTextContent(`copilot mcp add --transport http --header "Authorization: Bearer ${SECRET}" markdoc ${ORIGIN}/api/mcp`);
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
    expect(screen.getByTestId("agent-connection")).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("agent-setup-copy")).toHaveFocus();
    expect(screen.getByTestId("agent-invite-prompt")).toHaveTextContent('Sit in the Markdoc document "Launch plan" (id doc1)');
    expect(screen.queryByTestId("agent-create-key")).toBeNull();
  });

  it("switches the snippet to another agent with the same key, without making a second one", async () => {
    render(<Harness doc={DOC} />);
    createKey();
    await screen.findByTestId("agent-setup-snippet");

    fireEvent.click(screen.getByTestId("agent-client-vscode"));
    expect(screen.getByTestId("agent-setup-snippet")).toHaveTextContent(`"Authorization": "Bearer ${SECRET}"`);
    expect(screen.getByRole("heading", { name: "Add Markdoc to VS Code" })).toBeInTheDocument();
    expect(server.creates).toHaveLength(1);
  });

  it("opens the install step and links the setup docs for the Copilot app", async () => {
    render(<Harness doc={DOC} />);
    fireEvent.click(screen.getByTestId("agent-client-copilot-app"));
    createKey();
    await screen.findByTestId("agent-setup-snippet");

    expect(screen.getByTestId("agent-setup-snippet")).toHaveTextContent(`MARKDOC_TOKEN=${SECRET}`);
    expect(screen.getByTestId("agent-client-docs-link")).toHaveAttribute("href", expect.stringContaining("#inside-the-copilot-app"));
    expect(screen.getByText("Install the extension").closest("details")).toHaveAttribute("open");
  });

  it("sends the chosen options: access level, this document only, expiry and name", async () => {
    render(<Harness doc={DOC} />);
    fireEvent.click(screen.getByTestId("agent-options-toggle"));
    fireEvent.click(screen.getByTestId("agent-scope-read"));
    fireEvent.click(screen.getByTestId("agent-only-doc"));
    fireEvent.change(screen.getByTestId("agent-expires"), { target: { value: "never" } });
    fireEvent.change(screen.getByTestId("agent-key-name"), { target: { value: "My laptop" } });
    expect(screen.getByTestId("agent-key-summary")).toHaveTextContent("Read only · this document only · never expires");

    createKey();
    await screen.findByTestId("agent-setup-snippet");
    expect(server.creates[0]).toEqual({ name: "My laptop", expiresInDays: null, scope: "read", documentIds: ["doc1"] });
  });

  it("offers no 'only this document' choice when there is no document", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("agent-options-toggle"));
    expect(screen.queryByTestId("agent-only-doc")).toBeNull();
  });

  it("names the key so it does not collide with one you already have", async () => {
    server.tokens = [makeKey({ name: "Copilot CLI" })];
    render(<Harness doc={DOC} />);
    fireEvent.click(screen.getByTestId("agent-options-toggle"));
    await waitFor(() => expect(screen.getByTestId("agent-key-name")).toHaveValue("Copilot CLI 2"));

    createKey();
    await screen.findByTestId("agent-setup-snippet");
    expect(server.creates[0]).toMatchObject({ name: "Copilot CLI 2" });
  });

  it("shows a taken-name error with the name field open, keeps what was typed, and lets you try again", async () => {
    server.failWith = { status: 409, error: "Another active token has the same @mention name; choose a distinct token name" };
    render(<Harness doc={DOC} />);
    fireEvent.click(screen.getByTestId("agent-options-toggle"));
    fireEvent.change(screen.getByTestId("agent-key-name"), { target: { value: "Taken name" } });
    createKey();

    // The screen says "key", not the server's "token", and the typed name is still in the field.
    expect(await screen.findByTestId("agent-error")).toHaveTextContent("Another key already has that name. Choose a different one.");
    expect(screen.getByTestId("agent-error")).not.toHaveTextContent("token");
    expect(screen.getByTestId("agent-options")).toBeInTheDocument();
    expect(screen.getByTestId("agent-key-name")).toHaveValue("Taken name");
    expect(screen.getByTestId("agent-create-key")).toBeEnabled();

    server.failWith = null;
    fireEvent.change(screen.getByTestId("agent-key-name"), { target: { value: "Work laptop" } });
    createKey();
    await screen.findByTestId("agent-setup-snippet");
    expect(server.creates.at(-1)).toMatchObject({ name: "Work laptop" });
  });

  it("opens the name field when the suggested name turns out to be taken", async () => {
    server.failWith = { status: 409, error: "Another active token has the same @mention name; choose a distinct token name" };
    render(<Harness doc={DOC} />);
    expect(screen.queryByTestId("agent-options")).toBeNull();
    createKey();

    expect(await screen.findByTestId("agent-error")).toHaveTextContent("Another key already has that name");
    expect(screen.getByTestId("agent-options")).toBeInTheDocument();
    expect(screen.getByTestId("agent-key-name")).toHaveValue("Copilot CLI");
  });

  it("keeps the button usable after a server error", async () => {
    server.failWith = { status: 500, error: "Something broke" };
    render(<Harness doc={DOC} />);
    createKey();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke");
    expect(screen.getByTestId("agent-create-key")).toBeEnabled();
    expect(screen.queryByTestId("agent-setup-snippet")).toBeNull();
  });

  it("announces the waiting state politely and shows the secret exactly once", async () => {
    render(<Harness doc={DOC} />);
    createKey();
    await screen.findByTestId("agent-setup-snippet");
    expect(screen.getByTestId("agent-connection")).toHaveAttribute("role", "status");
    expect(document.body.textContent?.split(SECRET).length).toBe(2);
  });

  it("sends one request for a double click", async () => {
    render(<Harness doc={DOC} />);
    const button = screen.getByTestId("agent-create-key");
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByTestId("agent-setup-snippet");
    expect(server.creates).toHaveLength(1);
  });

  it("never writes the secret to storage", async () => {
    render(<Harness doc={DOC} />);
    createKey();
    await screen.findByTestId("agent-setup-snippet");
    const stored = [localStorage, sessionStorage].flatMap((storage) => Object.keys(storage).map((name) => `${name}=${storage.getItem(name)}`));
    expect(stored.join("\n")).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
  });

  it("turns into the connected view once the agent uses the key, and drops the key from the screen", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<Harness doc={DOC} />);
    createKey();
    await screen.findByTestId("agent-setup-snippet");

    server.tokens = server.tokens.map((key) => ({ ...key, lastMcpSeenAt: "2026-09-24T12:00:00.000Z" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const banner = await screen.findByTestId("agent-connected-banner");
    expect(banner).toHaveTextContent("Copilot CLI is connected");
    expect(screen.queryByTestId("agent-setup-snippet")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByTestId("agent-invite-copy")).toHaveClass("btn-primary");
  });

  it("starts over from 'Connect another agent' without keeping the old key", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    render(<Harness doc={DOC} />);
    createKey();
    await screen.findByTestId("agent-setup-snippet");
    server.tokens = server.tokens.map((key) => ({ ...key, lastUsedAt: "2026-09-24T12:00:00.000Z" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await screen.findByTestId("agent-connected-banner");

    fireEvent.click(screen.getByTestId("agent-connect-another"));
    expect(screen.getByTestId("agent-create-key")).toBeInTheDocument();
    expect(screen.getByTestId("agent-client-copilot-cli")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("asks the agent to check in, not to join a document, when there is no document", async () => {
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Ask your agent to check in" })).toBeInTheDocument();
    createKey();
    await screen.findByTestId("agent-setup-snippet");
    expect(screen.getByTestId("agent-invite-prompt")).toHaveTextContent("Check Markdoc for requests");
  });
});
