// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DocumentDto } from "@/server/dto";

const collaborators = vi.fn();
const addCollaborator = vi.fn();
const tokensList = vi.fn();
const tokensCreate = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      collaborators: (...args: unknown[]) => collaborators(...args),
      addCollaborator: (...args: unknown[]) => addCollaborator(...args),
      removeCollaborator: vi.fn(),
      patch: vi.fn(),
    },
    tokens: {
      list: (...args: unknown[]) => tokensList(...args),
      create: (...args: unknown[]) => tokensCreate(...args),
    },
    github: {
      searchUsers: async () => ({ users: [], limited: false }),
    },
  },
}));

const copyText = vi.fn();
vi.mock("@/lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard")>();
  return { ...actual, copyText: (...args: unknown[]) => copyText(...args) };
});

import { ApiError } from "@/lib/api";
import { ShareDialog } from "./share-dialog";

const DOC_ID = "doc-919";

const doc: DocumentDto = {
  id: DOC_ID,
  title: "Share me",
  storage: "local",
  linkAccess: "private",
  ownerId: "user-alice",
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

/** `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function renderDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  return render(<ShareDialog open onOpenChange={vi.fn()} doc={props.doc ?? doc} isOwner={props.isOwner ?? true} onDocChange={vi.fn()} />);
}

/** The dialog with its people list loaded (the link row sits under it). */
async function openDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  renderDialog(props);
  await screen.findByTestId("collaborator-row");
  return screen.getByRole("dialog");
}

async function expandAgentCard() {
  fireEvent.click(screen.getByTestId("share-agent-toggle"));
  await screen.findByTestId("share-agent-create-token");
}

beforeEach(() => {
  collaborators.mockReset().mockResolvedValue({
    owner: { login: "alice", name: "Alice", image: null },
    collaborators: [{ login: "bob", name: "Bob", image: null, role: "editor" }],
    agents: [],
  });
  addCollaborator.mockReset();
  tokensList.mockReset().mockResolvedValue({ tokens: [] });
  tokensCreate.mockReset().mockImplementation(async (name: string, _expires: number, options: { scope: string; documentIds: string[] | null }) => ({
    token: { id: "tok-1", name, token: "mdk_one_time_secret", prefix: "mdk_one_", scope: options.scope, documentIds: options.documentIds },
  }));
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("ShareDialog layout", () => {
  it("puts the copy-link row under the people list, before General access and the agent card; the footer is just Done", async () => {
    const dialog = await openDialog();
    const login = screen.getByTestId("share-login");
    const row = screen.getByTestId("collaborator-row");
    const copyLink = screen.getByTestId("copy-link");
    const linkAccess = screen.getByTestId("link-access");
    const toggle = screen.getByTestId("share-agent-toggle");
    expect(precedes(login, row)).toBe(true);
    expect(precedes(row, copyLink)).toBe(true);
    expect(precedes(copyLink, linkAccess)).toBe(true);
    expect(precedes(linkAccess, toggle)).toBe(true);

    // The row shows the editor link, truncated, next to the button; the hint says who can open it.
    const linkRow = screen.getByTestId("editor-link");
    expect(within(linkRow).getByText(`${window.location.origin}/d/${DOC_ID}`, { selector: "code" })).toBeInTheDocument();
    expect(linkRow).toContainElement(copyLink);
    expect(screen.getByTestId("copy-link-hint")).toHaveTextContent("Anyone listed above can open this link.");

    const footer = screen.getByTestId("share-footer");
    expect(within(footer).getAllByRole("button")).toHaveLength(1);
    expect(within(footer).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(footer).not.toContainElement(copyLink);
    expect(within(dialog).queryByTestId("copy-link-fallback")).toBeNull();
  });

  it("reuses the General access description as the hint when the link is not restricted", async () => {
    await openDialog({ doc: { ...doc, linkAccess: "view" } });
    expect(screen.getByTestId("copy-link-hint")).toHaveTextContent("Signed-out visitors can read the document.");
    expect(screen.getByTestId("reader-link")).toHaveTextContent(`/p/${DOC_ID}`);
  });

  it("shows the link row to non-owners too", async () => {
    await openDialog({ isOwner: false });
    expect(screen.queryByTestId("share-login")).toBeNull();
    expect(screen.getByTestId("copy-link")).toBeInTheDocument();
    expect(screen.getByTestId("editor-link")).toHaveTextContent(`/d/${DOC_ID}`);
  });

  it("Copy link flips to Copied, and shows the selectable field when both copy paths fail", async () => {
    await openDialog();
    fireEvent.click(screen.getByTestId("copy-link"));
    await waitFor(() => expect(screen.getByTestId("copy-link")).toHaveTextContent("Copied"));
    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/d/${DOC_ID}`);

    copyText.mockResolvedValue(false);
    fireEvent.click(screen.getByTestId("copy-link"));
    const field = await screen.findByTestId("copy-link-fallback");
    expect(field).toHaveValue(`${window.location.origin}/d/${DOC_ID}`);
    expect(field).toHaveFocus();
    expect(screen.getByTestId("editor-link")).toContainElement(field);
  });
});

describe("ShareDialog · add a collaborator", () => {
  it("shows the server's validation reason, not the bare 'Invalid request', when the handle is rejected", async () => {
    addCollaborator.mockRejectedValueOnce(new ApiError(400, "Invalid request", [{ path: ["login"], message: "Enter a GitHub handle" }]));
    await openDialog();
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "someone.else" } });
    fireEvent.click(screen.getByTestId("share-add"));

    expect(await screen.findByText("Enter a GitHub handle")).toBeInTheDocument();
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "someone.else", "editor");
    expect(screen.getByTestId("share-login")).toHaveValue("someone.else");
  });
});

describe("ShareDialog · collaborate with an agent", () => {
  it("is collapsed by default and opens into the three steps with the scope picker defaulting to comment, restricted to this document", async () => {
    await openDialog();
    const toggle = screen.getByTestId("share-agent-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("share-agent-config")).toBeNull();
    expect(screen.getByTestId("share-agent-card")).toHaveTextContent("Connect Copilot CLI or any MCP client as a collaborator");

    await expandAgentCard();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(screen.getByTestId("share-agent-config"));
    expect(screen.getByTestId("share-agent-config")).toHaveTextContent("MARKDOC_TOKEN");

    const group = screen.getByRole("radiogroup", { name: "Token scope" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual(["share-agent-scope-read", "share-agent-scope-comment", "share-agent-scope-full"]);
    expect(screen.getByTestId("share-agent-scope-comment")).toBeChecked();
    expect(group).toHaveTextContent("Comment & suggest");
    expect(screen.getByTestId("share-agent-restrict")).toBeChecked();
    // Steps in order: token, config, paste.
    const card = screen.getByTestId("share-agent-card");
    expect(precedes(screen.getByTestId("share-agent-create-token"), screen.getByTestId("share-agent-config"))).toBe(true);
    expect(precedes(screen.getByTestId("share-agent-config"), screen.getByTestId("share-agent-setup-link"))).toBe(true);
    expect(card).toHaveTextContent("/mcp add");
    expect(screen.getByTestId("share-agent-setup-link")).toHaveAttribute("href", "/settings#tokens");
  });

  it("mints a full-scope token restricted to this document, inlines it and locks the picker", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("share-agent-scope-full"));
    expect(screen.getByTestId("share-agent-scope-full")).toBeChecked();
    fireEvent.click(screen.getByTestId("share-agent-create-token"));

    await waitFor(() => expect(screen.getByTestId("share-agent-config")).toHaveTextContent("mdk_one_time_secret"));
    expect(tokensCreate).toHaveBeenCalledTimes(1);
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "full", documentIds: [DOC_ID] });
    expect(screen.queryByTestId("share-agent-create-token")).toBeNull();
    expect(screen.getByTestId("share-agent-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("share-agent-scope-chip")).toHaveTextContent("full");
    expect(screen.getByTestId("share-agent-minted-note")).toHaveTextContent("It is full-access: it can do anything you can in this document.");
    expect(screen.getByTestId("share-agent-minted-note")).not.toHaveTextContent("other documents");
    for (const scope of ["read", "comment", "full"]) expect(screen.getByTestId(`share-agent-scope-${scope}`)).toBeDisabled();
    expect(screen.getByTestId("share-agent-restrict")).toBeDisabled();
    expect(screen.getByTestId("share-agent-restrict")).toBeChecked();
  });

  it("sends documentIds: null when Only this document is unticked and words the note per scope", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("share-agent-restrict"));
    expect(screen.getByTestId("share-agent-restrict")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("share-agent-scope-read"));
    fireEvent.click(screen.getByTestId("share-agent-create-token"));

    await waitFor(() => expect(tokensCreate).toHaveBeenCalledTimes(1));
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "read", documentIds: null });
    await waitFor(() => expect(screen.getByTestId("share-agent-scope-chip")).toHaveTextContent("read"));
    expect(screen.getByTestId("share-agent-minted-note")).toHaveTextContent("It is read-only: it can read and follow the document but not comment or edit. It also works in your other documents.");
  });

  it("keeps the comment default: Create a token with nothing changed mints a comment-scoped token for this document", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("share-agent-create-token"));
    await waitFor(() => expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "comment", documentIds: [DOC_ID] }));
    await waitFor(() => expect(screen.getByTestId("share-agent-scope-chip")).toHaveTextContent("comment"));
    expect(screen.getByTestId("share-agent-card")).toHaveTextContent("comment-scoped");
  });

  it("names the newest existing token and keeps the placeholder until one is minted here", async () => {
    tokensList.mockResolvedValue({
      tokens: [
        { id: "t-old", name: "Old bot", prefix: "mdk_old_", scope: "read", documentIds: null, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
        { id: "t-new", name: "Newer bot", prefix: "mdk_new_", scope: "comment", documentIds: null, createdAt: "2026-08-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
      ],
    });
    await openDialog();
    await expandAgentCard();
    await waitFor(() => expect(screen.getByTestId("share-agent-card")).toHaveTextContent("your token Newer bot (mdk_new_…)"));
    expect(screen.getByTestId("share-agent-config")).toHaveTextContent("MARKDOC_TOKEN");
    expect(screen.getByTestId("share-agent-scope-chip")).toHaveTextContent("comment");
  });
});
