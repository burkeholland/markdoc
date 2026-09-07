// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DocumentDto } from "@/server/dto";

const collaborators = vi.fn();
const addCollaborator = vi.fn();
const removeCollaborator = vi.fn();
const patchDocument = vi.fn();
const tokensList = vi.fn();
const tokensCreate = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      collaborators: (...args: unknown[]) => collaborators(...args),
      addCollaborator: (...args: unknown[]) => addCollaborator(...args),
      removeCollaborator: (...args: unknown[]) => removeCollaborator(...args),
      patch: (...args: unknown[]) => patchDocument(...args),
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
type CollaboratorResponse = {
  owner: { login: string | null; name: string | null; image: string | null } | null;
  linkAccess: DocumentDto["linkAccess"];
  collaborators: { login: string; name: string | null; image: string | null; role: "editor" | "commenter" | "viewer" }[];
  agents: never[];
};

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function collaboratorResponse(owner: string, collaborator: string): CollaboratorResponse {
  return {
    owner: { login: owner, name: owner, image: null },
    linkAccess: "private",
    collaborators: [{ login: collaborator, name: collaborator, image: null, role: "editor" }],
    agents: [],
  };
}

function collaboratorRows(...logins: string[]): CollaboratorResponse {
  return {
    owner: { login: "alice", name: "Alice", image: null },
    linkAccess: "private",
    collaborators: logins.map((login) => ({ login, name: login[0].toUpperCase() + login.slice(1), image: null, role: "editor" })),
    agents: [],
  };
}

function collaboratorRow(login: string) {
  return screen.getByText(`@${login}`).closest('[data-testid="collaborator-row"]') as HTMLElement;
}

/** `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function renderDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  return render(<ShareDialog open onOpenChange={vi.fn()} doc={props.doc ?? doc} isOwner={props.isOwner ?? true} onDocChange={vi.fn()} />);
}

/** The dialog with its people list loaded (the link row sits under it). */
async function openDialog(props: Partial<{ isOwner: boolean; doc: DocumentDto }> = {}) {
  renderDialog(props);
  await screen.findAllByTestId("collaborator-row");
  return screen.getByRole("dialog");
}

async function expandAgentCard() {
  fireEvent.click(screen.getByTestId("share-agent-toggle"));
  await waitFor(() => expect(screen.getByTestId("token-add")).toBeEnabled());
}

beforeEach(() => {
  collaborators.mockReset().mockResolvedValue({
    owner: { login: "alice", name: "Alice", image: null },
    linkAccess: "private",
    collaborators: [{ login: "bob", name: "Bob", image: null, role: "editor" }],
    agents: [],
  });
  addCollaborator.mockReset().mockResolvedValue({ ok: true, login: "bob", role: "editor", pending: false });
  removeCollaborator.mockReset().mockResolvedValue({ ok: true });
  patchDocument.mockReset().mockResolvedValue({ document: { ...doc, linkAccess: "view" } });
  tokensList.mockReset().mockResolvedValue({ tokens: [] });
  tokensCreate.mockReset().mockImplementation(async (name: string, _expires: number, options: { scope: string; documentIds: string[] | null }) => ({
    token: { id: "tok-1", name, token: "mdk_one_time_secret", prefix: "mdk_one_", scope: options.scope, documentIds: options.documentIds, createdAt: "2026-09-05T00:00:00.000Z", expiresAt: null },
  }));
  copyText.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("ShareDialog collaborator list recovery", () => {
  it("shows a neutral loading state until the initial collaborator request settles", () => {
    collaborators.mockReturnValueOnce(deferred<CollaboratorResponse>().promise);

    renderDialog();

    expect(screen.getByRole("status")).toHaveTextContent("Loading collaborators…");
    expect(screen.queryByText("Nobody else has been added yet.")).toBeNull();
    expect(collaborators).toHaveBeenCalledOnce();
    expect(collaborators).toHaveBeenCalledWith(DOC_ID);
  });

  it("shows the collaborator API reason and Retry instead of an add-collaborator error or empty list", async () => {
    collaborators.mockRejectedValueOnce(new ApiError(503, "Collaborator directory unavailable"));

    renderDialog();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Collaborator directory unavailable");
    expect(alert).not.toHaveTextContent("Could not add collaborator");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("Nobody else has been added yet.")).toBeNull();
  });

  it("guards Retry to one request, exposes its pending state, and recovers the list", async () => {
    const retry = deferred<CollaboratorResponse>();
    collaborators.mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);
    renderDialog();
    const retryButton = await screen.findByRole("button", { name: "Retry" });

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(collaborators).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
    retry.resolve(collaboratorResponse("Recovered owner", "Recovered collaborator"));
    expect(await screen.findByText("Recovered collaborator")).toBeInTheDocument();
    expect(screen.getByText("Recovered owner")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a reopened dialog's newer error when the closed instance succeeds late, then recovers current rows", async () => {
    const closedRequest = deferred<CollaboratorResponse>();
    const reopenedRequest = deferred<CollaboratorResponse>();
    const retry = deferred<CollaboratorResponse>();
    collaborators.mockReturnValueOnce(closedRequest.promise).mockReturnValueOnce(reopenedRequest.promise).mockReturnValueOnce(retry.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    view.rerender(<ShareDialog open={false} onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    reopenedRequest.reject(new ApiError(503, "Reopened request failed"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reopened request failed");

    await act(async () => {
      closedRequest.resolve(collaboratorResponse("Stale owner", "Stale collaborator"));
      await closedRequest.promise;
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Reopened request failed");
    expect(screen.queryByText("Stale owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    retry.resolve(collaboratorResponse("Current owner", "Current collaborator"));
    expect(await screen.findByText("Current collaborator")).toBeInTheDocument();
    expect(screen.getByText("Current owner")).toBeInTheDocument();
  });

  it("does not let an old document's late error replace the switched document's owner and collaborators", async () => {
    const oldRequest = deferred<CollaboratorResponse>();
    const newRequest = deferred<CollaboratorResponse>();
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    collaborators.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    expect(collaborators).toHaveBeenNthCalledWith(2, nextDoc.id);
    newRequest.resolve(collaboratorResponse("Next owner", "Next collaborator"));
    expect(await screen.findByText("Next collaborator")).toBeInTheDocument();

    await act(async () => {
      oldRequest.reject(new ApiError(503, "Old document failed"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Next owner")).toBeInTheDocument();
    expect(screen.getByText("Next collaborator")).toBeInTheDocument();
  });

  it("keeps add errors separate when a successful add refresh cannot load the collaborator list", async () => {
    await openDialog();
    addCollaborator.mockRejectedValueOnce(new ApiError(422, "That account cannot be added"));
    fireEvent.change(screen.getByTestId("share-login"), { target: { value: "charlie" } });
    fireEvent.click(screen.getByTestId("share-add"));
    expect(await screen.findByTestId("share-add-error")).toHaveTextContent("That account cannot be added");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    collaborators.mockRejectedValueOnce("offline");
    fireEvent.click(screen.getByTestId("share-add"));
    const listAlert = await screen.findByTestId("collaborator-list-error");
    expect(listAlert).toHaveTextContent("Could not load collaborators");
    expect(listAlert).not.toHaveTextContent("That account cannot be added");
    expect(screen.queryByTestId("share-add-error")).toBeNull();
    expect(within(listAlert).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByTestId("share-login")).toHaveValue("");
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(collaborators).toHaveBeenCalledTimes(2);
  });
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

describe("ShareDialog · permission actions", () => {
  it("owns role and Remove synchronously per login while other collaborator rows remain independent", async () => {
    const bobRole = deferred<unknown>();
    const charlieRole = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(bobRole.promise).mockReturnValueOnce(charlieRole.promise);
    await openDialog();
    const bobRow = collaboratorRow("bob");
    const charlieRow = collaboratorRow("charlie");
    const bobSelect = within(bobRow).getByRole("combobox", { name: "Role for bob" });
    const charlieSelect = within(charlieRow).getByRole("combobox", { name: "Role for charlie" });

    fireEvent.change(bobSelect, { target: { value: "viewer" } });
    fireEvent.change(bobSelect, { target: { value: "commenter" } });
    fireEvent.click(within(bobRow).getByRole("button", { name: "Remove bob" }));

    expect(addCollaborator).toHaveBeenCalledOnce();
    expect(addCollaborator).toHaveBeenCalledWith(DOC_ID, "bob", "viewer");
    expect(removeCollaborator).not.toHaveBeenCalled();
    expect(bobSelect).toBeDisabled();
    expect(within(bobRow).getByRole("button", { name: "Remove bob" })).toBeDisabled();
    expect(charlieSelect).toBeEnabled();
    expect(within(charlieRow).getByRole("button", { name: "Remove charlie" })).toBeEnabled();

    fireEvent.change(charlieSelect, { target: { value: "commenter" } });
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(addCollaborator).toHaveBeenNthCalledWith(2, DOC_ID, "charlie", "commenter");
    expect(charlieSelect).toBeDisabled();

    await act(async () => {
      bobRole.resolve({});
      charlieRole.resolve({});
      await Promise.all([bobRole.promise, charlieRole.promise]);
    });
    await waitFor(() => expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("viewer"));
    expect(within(collaboratorRow("charlie")).getByRole("combobox")).toHaveValue("commenter");
  });

  it("keeps a failed role confirmed and makes the same role change retryable", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await openDialog();
    const row = collaboratorRow("bob");
    const select = within(row).getByRole("combobox", { name: "Role for bob" });

    fireEvent.change(select, { target: { value: "viewer" } });
    expect(select).toBeDisabled();
    expect(select).toHaveValue("editor");
    await act(async () => {
      failed.reject(new ApiError(409, "Bob's role changed elsewhere"));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Bob's role changed elsewhere");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("editor");
    fireEvent.change(select, { target: { value: "viewer" } });
    expect(addCollaborator).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("share-action-error")).toBeNull();

    await act(async () => {
      retry.resolve({});
      await retry.promise;
    });
    await waitFor(() => expect(select).toHaveValue("viewer"));
  });

  it("suppresses duplicate Remove, surfaces failure, and removes the row on retry", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<unknown>();
    removeCollaborator.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    await openDialog();
    const row = collaboratorRow("bob");
    const remove = within(row).getByRole("button", { name: "Remove bob" });

    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(removeCollaborator).toHaveBeenCalledOnce();
    expect(removeCollaborator).toHaveBeenCalledWith(DOC_ID, "bob");
    expect(remove).toBeDisabled();
    expect(within(row).getByRole("combobox", { name: "Role for bob" })).toBeDisabled();
    await act(async () => {
      failed.reject(new ApiError(503, "Permission service unavailable"));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Permission service unavailable");
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(removeCollaborator).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("share-action-error")).toBeNull();

    await act(async () => {
      retry.resolve({});
      await retry.promise;
    });
    await waitFor(() => expect(screen.queryByText("@bob")).toBeNull());
  });

  it("locks every link choice, retries a failure, and commits only the server-confirmed document", async () => {
    const failed = deferred<unknown>();
    const retry = deferred<{ document: DocumentDto }>();
    const serverDocument = { ...doc, title: "Server-confirmed title", linkAccess: "comment" as const };
    patchDocument.mockReset().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const onDocChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByTestId("collaborator-row");
    const select = screen.getByTestId("link-access");

    fireEvent.change(select, { target: { value: "view" } });
    fireEvent.change(select, { target: { value: "edit" } });
    expect(patchDocument).toHaveBeenCalledOnce();
    expect(patchDocument).toHaveBeenCalledWith(DOC_ID, { linkAccess: "view" });
    expect(select).toBeDisabled();
    expect(select).toHaveValue("private");
    for (const option of within(select).getAllByRole("option")) expect(option).toBeDisabled();

    await act(async () => {
      failed.reject(new ApiError(409, "Link access changed elsewhere"));
      await failed.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Link access changed elsewhere");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("private");
    fireEvent.change(select, { target: { value: "view" } });
    expect(patchDocument).toHaveBeenCalledTimes(2);
    expect(patchDocument).toHaveBeenNthCalledWith(2, DOC_ID, { linkAccess: "view" });

    await act(async () => {
      retry.resolve({ document: serverDocument });
      await retry.promise;
    });
    await waitFor(() => expect(onDocChange).toHaveBeenCalledWith(serverDocument));
    expect(onDocChange).toHaveBeenCalledOnce();
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={serverDocument} isOwner onDocChange={onDocChange} />);
    expect(select).toHaveValue("comment");
    expect(select).toBeEnabled();
  });

  it("does not let a closed dialog's role success or finalizer affect a reopened same-login Remove", async () => {
    const oldRole = deferred<unknown>();
    const currentRemove = deferred<unknown>();
    addCollaborator.mockReset().mockReturnValueOnce(oldRole.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(currentRemove.promise);
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });

    view.rerender(<ShareDialog open={false} onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    const reopenedRow = await screen.findByTestId("collaborator-row");
    fireEvent.click(within(reopenedRow).getByRole("button", { name: "Remove bob" }));
    expect(within(reopenedRow).getByRole("combobox")).toBeDisabled();

    await act(async () => {
      oldRole.resolve({});
      await oldRole.promise;
    });
    expect(within(collaboratorRow("bob")).getByRole("combobox")).toHaveValue("editor");
    expect(within(collaboratorRow("bob")).getByRole("combobox")).toBeDisabled();
    expect(within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" })).toBeDisabled();

    await act(async () => {
      currentRemove.reject(new ApiError(503, "Current Remove failed"));
      await currentRemove.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current Remove failed");
    expect(screen.getByText("@bob")).toBeInTheDocument();
  });

  it("does not let an old document's Remove error replace the current link error or rows", async () => {
    const oldRemove = deferred<unknown>();
    removeCollaborator.mockReset().mockReturnValueOnce(oldRemove.promise);
    patchDocument.mockRejectedValueOnce(new ApiError(503, "Current link change failed"));
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={vi.fn()} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.click(within(collaboratorRow("bob")).getByRole("button", { name: "Remove bob" }));

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={vi.fn()} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    await screen.findByTestId("collaborator-row");
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current link change failed");

    await act(async () => {
      oldRemove.reject(new ApiError(503, "Old Remove failed"));
      await oldRemove.promise.catch(() => undefined);
    });
    expect(screen.getByTestId("share-action-error")).toHaveTextContent("Current link change failed");
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(removeCollaborator).toHaveBeenCalledOnce();
  });

  it("does not let an old document's link success call onDocChange or unlock its successor", async () => {
    const oldLink = deferred<{ document: DocumentDto }>();
    const currentLink = deferred<{ document: DocumentDto }>();
    patchDocument.mockReset().mockReturnValueOnce(oldLink.promise).mockReturnValueOnce(currentLink.promise);
    const onDocChange = vi.fn();
    const nextDoc = { ...doc, id: "doc-920", title: "Next document" };
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByTestId("collaborator-row");
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });

    view.rerender(<ShareDialog open onOpenChange={vi.fn()} doc={nextDoc} isOwner onDocChange={onDocChange} />);
    await waitFor(() => expect(collaborators).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "edit" } });
    expect(patchDocument).toHaveBeenNthCalledWith(2, nextDoc.id, { linkAccess: "edit" });
    expect(screen.getByTestId("link-access")).toBeDisabled();

    await act(async () => {
      oldLink.resolve({ document: { ...doc, linkAccess: "view" } });
      await oldLink.promise;
    });
    expect(onDocChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("link-access")).toBeDisabled();
    expect(screen.getByTestId("link-access")).toHaveValue("private");

    await act(async () => {
      currentLink.reject(new ApiError(503, "Current link request failed"));
      await currentLink.promise.catch(() => undefined);
    });
    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Current link request failed");
    expect(screen.getByTestId("link-access")).toBeEnabled();
  });

  it("handles late permission resolves and rejections after unmount without effects or unhandled rejections", async () => {
    const roleRequest = deferred<unknown>();
    const removeRequest = deferred<unknown>();
    const linkRequest = deferred<unknown>();
    collaborators.mockResolvedValueOnce(collaboratorRows("bob", "charlie"));
    addCollaborator.mockReset().mockReturnValueOnce(roleRequest.promise);
    removeCollaborator.mockReset().mockReturnValueOnce(removeRequest.promise);
    patchDocument.mockReset().mockReturnValueOnce(linkRequest.promise);
    const onDocChange = vi.fn();
    const view = render(<ShareDialog open onOpenChange={vi.fn()} doc={doc} isOwner onDocChange={onDocChange} />);
    await screen.findByText("@charlie");
    fireEvent.change(within(collaboratorRow("bob")).getByRole("combobox"), { target: { value: "viewer" } });
    fireEvent.click(within(collaboratorRow("charlie")).getByRole("button", { name: "Remove charlie" }));
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });
    expect(addCollaborator).toHaveBeenCalledOnce();
    expect(removeCollaborator).toHaveBeenCalledOnce();
    expect(patchDocument).toHaveBeenCalledOnce();

    const unhandled = vi.fn();
    const onUnhandled = (reason: unknown) => unhandled(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      view.unmount();
      await act(async () => {
        roleRequest.resolve({});
        removeRequest.reject(new ApiError(503, "Late Remove failed"));
        linkRequest.reject(new ApiError(503, "Late link failed"));
        await Promise.allSettled([roleRequest.promise, removeRequest.promise, linkRequest.promise]);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(onDocChange).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("ShareDialog · collaborate with an agent", () => {
  it("opens two destinations with management first and creation scoped to this document", async () => {
    await openDialog();
    const toggle = screen.getByTestId("share-agent-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(screen.queryByTestId("token-manager")).toBeNull();
    expect(screen.getByTestId("share-agent-card")).toHaveTextContent("Connect Copilot CLI or any MCP client as a collaborator");

    await expandAgentCard();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(screen.getByTestId("token-manager"));
    expect(within(screen.getByRole("navigation", { name: "Token access" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByTestId("agent-connect-config")).toBeNull();
    fireEvent.click(screen.getByTestId("token-add"));
    const group = screen.getByRole("group", { name: "Scope" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("data-testid"))).toEqual(["token-scope-read", "token-scope-comment", "token-scope-full"]);
    expect(screen.getByTestId("token-scope-comment")).toBeChecked();
    expect(group).toHaveTextContent("Comment & suggest");
    expect(screen.getByTestId("token-restrict")).toBeChecked();
    expect(screen.getByRole("link", { name: "Open all your tokens in Settings" })).toHaveAttribute("href", `/settings?next=${encodeURIComponent(`/d/${DOC_ID}`)}#tokens`);
  });

  it("creates a full-scope token for this document, displays the secret once and never puts it in setup", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-scope-full"));
    fireEvent.click(screen.getByTestId("token-create"));
    await screen.findByTestId("token-created");
    expect(tokensCreate).toHaveBeenCalledTimes(1);
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "full", documentIds: [DOC_ID] });
    expect(screen.getByTestId("token-create")).toBeDisabled();
    expect(screen.getByTestId("share-agent-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("full");
    expect(copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
    expect(screen.getByTestId("agent-connect-config").textContent?.includes(screen.getByTestId("copy-token").textContent!)).toBe(false);
  });

  it("keeps explicit unrestricted creation available", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-restrict"));
    expect(screen.getByTestId("token-restrict")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("token-scope-read"));
    fireEvent.click(screen.getByTestId("token-create"));

    await waitFor(() => expect(tokensCreate).toHaveBeenCalledTimes(1));
    expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "read", documentIds: null });
    await waitFor(() => expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("read"));
    expect(screen.getByTestId("token-created")).toHaveTextContent("All documents you can access");
  });

  it("keeps the comment default: Create a token with nothing changed mints a comment-scoped token for this document", async () => {
    await openDialog();
    await expandAgentCard();
    fireEvent.click(screen.getByTestId("token-add"));
    fireEvent.click(screen.getByTestId("token-create"));
    await waitFor(() => expect(tokensCreate).toHaveBeenCalledWith("GitHub Copilot CLI", 90, { scope: "comment", documentIds: [DOC_ID] }));
    await waitFor(() => expect(screen.getByTestId("token-scope-chip")).toHaveTextContent("comment"));
  });

  it("shows every existing token with management instead of guessing the newest is usable", async () => {
    tokensList.mockResolvedValue({
      tokens: [
        { id: "t-old", name: "Old bot", prefix: "mdk_old_", scope: "read", documentIds: null, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
        { id: "t-new", name: "Newer bot", prefix: "mdk_new_", scope: "comment", documentIds: null, createdAt: "2026-08-01T00:00:00.000Z", lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null },
      ],
    });
    await openDialog();
    await expandAgentCard();
    expect(screen.getAllByTestId("token-row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Rename Old bot" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Replace Newer bot" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect an MCP client" }));
    expect(screen.getByTestId("agent-connect-config")).toHaveTextContent("MARKDOC_TOKEN");
    expect(screen.getByRole("button", { name: "Replace Newer bot" })).toBeVisible();
  });
});
