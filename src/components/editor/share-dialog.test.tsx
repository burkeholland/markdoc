// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";

import { ShareDialog } from "./share-dialog";
import { ApiError, api, type CollaboratorDto } from "@/lib/api";
import { COPY_FALLBACK_HINT, copyText } from "@/lib/clipboard";
import type { DocumentDto } from "@/server/dto";

vi.mock("@/lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard")>();
  return { ...actual, copyText: vi.fn() };
});

type CollaboratorsResponse = Awaited<ReturnType<typeof api.documents.collaborators>>;
type Role = CollaboratorDto["role"];

const owner = { login: "owner", name: "Owner User", image: null };
const alice = collaborator("alice", "editor", "Alice Example");
const bob = collaborator("bob", "viewer", "Bob Example");

function collaborator(login: string, role: Role = "viewer", name: string | null = null): CollaboratorDto {
  return { login, role, name, image: null, createdAt: "2026-01-01T00:00:00.000Z" };
}

function doc(overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: "doc-1",
    title: "Launch Plan",
    linkAccess: "private",
    ...overrides,
  } as DocumentDto;
}

function people(collaborators: CollaboratorDto[] = [alice], ownerValue = owner): CollaboratorsResponse {
  return { owner: ownerValue, linkAccess: "private", collaborators, agents: [] };
}

function apiMessage(status: number, message: string) {
  return new ApiError(status, message);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderShare({
  open = true,
  document = doc(),
  isOwner = true,
  onOpenChange = vi.fn(),
  onDocChange = vi.fn(),
  onConnectAgent,
}: {
  open?: boolean;
  document?: DocumentDto;
  isOwner?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDocChange?: (document: DocumentDto) => void;
  onConnectAgent?: () => void;
} = {}) {
  return {
    onOpenChange,
    onDocChange,
    ...render(
      <ShareDialog
        open={open}
        onOpenChange={onOpenChange}
        doc={document}
        isOwner={isOwner}
        onDocChange={onDocChange}
        onConnectAgent={onConnectAgent}
      />,
    ),
  };
}

async function loadedRows() {
  await waitFor(() => expect(screen.queryByTestId("collaborator-list-loading")).not.toBeInTheDocument());
  return screen.queryAllByTestId("collaborator-row");
}

async function fillLogin(value: string) {
  fireEvent.change(screen.getByTestId("share-login"), { target: { value } });
  await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(value));
}

beforeEach(() => {
  vi.spyOn(api.github, "searchUsers").mockResolvedValue({ users: [], limited: false });
  vi.spyOn(api.documents, "collaborators").mockResolvedValue(people());
  vi.spyOn(api.documents, "addCollaborator").mockResolvedValue({ ok: true, login: "added", role: "editor", pending: false });
  vi.spyOn(api.documents, "removeCollaborator").mockResolvedValue({ ok: true });
  vi.spyOn(api.documents, "patch").mockResolvedValue({ document: doc({ linkAccess: "view" }) });
  vi.mocked(copyText).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShareDialog", () => {
  it("shows a loading state, then people with access or an empty list", async () => {
    const firstLoad = deferred<CollaboratorsResponse>();
    vi.mocked(api.documents.collaborators).mockReturnValueOnce(firstLoad.promise);

    const { rerender } = renderShare();

    expect(screen.getByTestId("collaborator-list-loading")).toHaveTextContent("Loading");

    firstLoad.resolve(people([alice, bob]));
    expect(await screen.findByTestId("owner-row")).toHaveTextContent("Owner User");
    const rows = screen.getAllByTestId("collaborator-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("@alice");
    expect(rows[1]).toHaveTextContent("@bob");

    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([]));
    rerender(
      <ShareDialog open onOpenChange={vi.fn()} doc={doc({ id: "empty-doc" })} isOwner onDocChange={vi.fn()} />,
    );

    expect(await screen.findByText("Nobody else has been added yet.")).toBeInTheDocument();
  });

  it("keeps the loading row a real list item so the people list stays a valid list for axe", async () => {
    const firstLoad = deferred<CollaboratorsResponse>();
    vi.mocked(api.documents.collaborators).mockReturnValueOnce(firstLoad.promise);

    renderShare();

    const loadingRow = screen.getByTestId("collaborator-list-loading");
    // role="status" must live on an inner element, not the <li> itself: overriding the <li>'s
    // implicit listitem role breaks axe's "list" rule for the "People with access" <ul>.
    expect(loadingRow.tagName).toBe("LI");
    expect(loadingRow).not.toHaveAttribute("role");
    expect(within(loadingRow).getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("list", { name: "People with access" })).toContainElement(loadingRow);
  });

  it("shows a list load error and retries successfully", async () => {
    vi.mocked(api.documents.collaborators)
      .mockRejectedValueOnce(apiMessage(500, "People could not load"))
      .mockResolvedValueOnce(people([bob]));

    renderShare();

    expect(await screen.findByTestId("collaborator-list-error")).toHaveTextContent("People could not load");
    fireEvent.click(screen.getByTestId("collaborator-list-retry"));

    expect(await screen.findByText("@bob")).toBeInTheDocument();
    expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
  });

  it("keeps the error row a real list item so the people list stays a valid list for axe", async () => {
    vi.mocked(api.documents.collaborators).mockRejectedValueOnce(apiMessage(500, "People could not load"));

    renderShare();

    const errorRow = await screen.findByTestId("collaborator-list-error");
    // role="alert" must live on an inner element, not the <li> itself: overriding the <li>'s
    // implicit listitem role breaks axe's "list" rule for the "People with access" <ul>.
    expect(errorRow.tagName).toBe("LI");
    expect(errorRow).not.toHaveAttribute("role");
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("People could not load");
    expect(screen.getByRole("list", { name: "People with access" })).toContainElement(errorRow);
  });

  it("lets an owner add a person with a trimmed login and selected role", async () => {
    vi.mocked(api.documents.collaborators)
      .mockResolvedValueOnce(people([]))
      .mockResolvedValueOnce(people([collaborator("octocat", "commenter", "Octo Cat")]));
    vi.mocked(api.documents.addCollaborator).mockResolvedValueOnce({ ok: true, login: "octocat", role: "commenter", pending: false });

    renderShare();
    expect(await screen.findByText("Nobody else has been added yet.")).toBeInTheDocument();
    expect(screen.getByTestId("share-add")).toBeDisabled();

    await fillLogin("  octocat  ");
    fireEvent.change(screen.getByTestId("share-role"), { target: { value: "commenter" } });
    fireEvent.click(screen.getByTestId("share-add"));

    await waitFor(() => expect(api.documents.addCollaborator).toHaveBeenCalledWith("doc-1", "octocat", "commenter"));
    expect(await screen.findByText("@octocat")).toBeInTheDocument();
    expect(screen.getByTestId("share-login")).toHaveValue("");
  });

  it("shows a rejected add message and keeps the typed handle", async () => {
    vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(apiMessage(409, "That person is already added"));

    renderShare();
    await loadedRows();
    await fillLogin("  bob  ");
    fireEvent.click(screen.getByTestId("share-add"));

    expect(await screen.findByTestId("share-add-error")).toHaveTextContent("That person is already added");
    expect(screen.getByTestId("share-login")).toHaveValue("  bob  ");
  });

  it("picking a suggestion moves focus to the role select, and a held Enter's auto-repeat landing there does not submit", async () => {
    vi.mocked(api.github.searchUsers).mockResolvedValue({
      users: [{ login: "octocat", name: null, avatarUrl: "https://avatars.githubusercontent.com/octocat?s=40" }],
      limited: false,
    });

    renderShare();
    await loadedRows();

    const loginBox = screen.getByTestId("share-login");
    loginBox.focus();
    await fillLogin("octo");
    const list = await screen.findByTestId("share-login-suggestions");
    expect(within(list).getAllByTestId("share-login-option")).toHaveLength(1);

    fireEvent.keyDown(loginBox, { key: "ArrowDown" });
    fireEvent.keyDown(loginBox, { key: "Enter" }); // picks: fills the field, does not add

    expect(loginBox).toHaveValue("octocat");
    expect(screen.queryByTestId("share-login-suggestions")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-role")).toHaveFocus(); // onPick moved focus here
    expect(api.documents.addCollaborator).not.toHaveBeenCalled();

    // A held Enter's auto-repeat now lands on the role select, not the input.
    const notSubmitted = fireEvent.keyDown(screen.getByTestId("share-role"), { key: "Enter" });
    expect(notSubmitted).toBe(false); // preventDefault: the select never implicitly submits the form
    expect(api.documents.addCollaborator).not.toHaveBeenCalled();
  });

  it("shows a note when the added person has not signed in yet", async () => {
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([])).mockResolvedValueOnce(people([]));
    vi.mocked(api.documents.addCollaborator).mockResolvedValueOnce({ ok: true, login: "newbie", role: "viewer", pending: true });

    renderShare();
    await screen.findByText("Nobody else has been added yet.");
    await fillLogin("newbie");
    fireEvent.change(screen.getByTestId("share-role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByTestId("share-add"));

    expect(await screen.findByTestId("share-add-note")).toHaveTextContent("@newbie has not signed in to Markdoc yet");
  });

  it("sends one add request when Add is double clicked", async () => {
    const addRequest = deferred<{ ok: true; login: string; role: string; pending: boolean }>();
    vi.mocked(api.documents.addCollaborator).mockReturnValueOnce(addRequest.promise);

    renderShare();
    await loadedRows();
    await fillLogin("zoe");
    const add = screen.getByTestId("share-add");
    fireEvent.click(add);
    fireEvent.click(add);

    expect(api.documents.addCollaborator).toHaveBeenCalledTimes(1);
    addRequest.resolve({ ok: true, login: "zoe", role: "editor", pending: false });
    await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(""));
  });

  it("changes a collaborator role and restores the confirmed role on failure", async () => {
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([bob]));
    vi.mocked(api.documents.addCollaborator)
      .mockResolvedValueOnce({ ok: true, login: "bob", role: "commenter", pending: false })
      .mockRejectedValueOnce(apiMessage(500, "Role update failed"));

    renderShare();
    const select = await screen.findByLabelText("Role for bob");
    fireEvent.change(select, { target: { value: "commenter" } });

    await waitFor(() => expect(api.documents.addCollaborator).toHaveBeenCalledWith("doc-1", "bob", "commenter"));
    await waitFor(() => expect(select).toHaveValue("commenter"));

    fireEvent.change(select, { target: { value: "editor" } });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Role update failed");
    expect(select).toHaveValue("commenter");
  });

  it("removes a collaborator and keeps the row on failure", async () => {
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([alice, bob]));
    vi.mocked(api.documents.removeCollaborator)
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(apiMessage(500, "Remove failed"));

    renderShare();
    expect(await screen.findByText("@alice")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove alice"));

    await waitFor(() => expect(screen.queryByText("@alice")).not.toBeInTheDocument());
    expect(api.documents.removeCollaborator).toHaveBeenCalledWith("doc-1", "alice");

    fireEvent.click(screen.getByLabelText("Remove bob"));

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Remove failed");
    expect(screen.getByText("@bob")).toBeInTheDocument();
  });

  it("patches link access, reports the returned document, and shows failures", async () => {
    const nextDoc = doc({ linkAccess: "view" });
    const patchRequest = deferred<{ document: DocumentDto }>();
    const onDocChange = vi.fn();
    vi.mocked(api.documents.patch)
      .mockReturnValueOnce(patchRequest.promise)
      .mockRejectedValueOnce(apiMessage(500, "Link access failed"));

    renderShare({ onDocChange });
    await loadedRows();
    const select = screen.getByTestId("link-access");

    fireEvent.change(select, { target: { value: "view" } });
    expect(select).toBeDisabled();
    patchRequest.resolve({ document: nextDoc });

    await waitFor(() => expect(api.documents.patch).toHaveBeenCalledWith("doc-1", { linkAccess: "view" }));
    await waitFor(() => expect(onDocChange).toHaveBeenCalledWith(nextDoc));
    expect(select).not.toBeDisabled();

    fireEvent.change(select, { target: { value: "comment" } });

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Link access failed");
    expect(onDocChange).toHaveBeenCalledTimes(1);
  });

  it("offers the link-preview switch, off by default, only while the link is restricted", async () => {
    const { rerender } = renderShare();
    await loadedRows();
    const toggle = screen.getByRole("switch", { name: "Show title and first lines in link previews" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
    // Everything a preview carries: the metadata's title, description and modified time, the card's name and date.
    expect(toggle).toHaveAccessibleDescription("Slack, Teams and other apps show the title, first lines, your name and when it was last updated.");

    // A link-shared document always previews with its title and first lines: nothing to switch.
    rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc({ linkAccess: "view", linkPreview: false })} isOwner onDocChange={vi.fn()} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("lets the owner turn link previews on and off, one link change at a time", async () => {
    const turnedOn = doc({ linkPreview: true });
    const patchRequest = deferred<{ document: DocumentDto }>();
    const onDocChange = vi.fn();
    vi.mocked(api.documents.patch).mockReturnValueOnce(patchRequest.promise).mockResolvedValueOnce({ document: doc({ linkPreview: false }) });

    const { rerender } = renderShare({ document: doc({ linkPreview: false }), onDocChange });
    await loadedRows();
    const toggle = screen.getByTestId("link-preview");
    toggle.focus();
    fireEvent.click(toggle);

    expect(api.documents.patch).toHaveBeenCalledWith("doc-1", { linkPreview: true });
    // Saving: marked, not disabled (which would drop keyboard focus to the page), and a second toggle waits its turn.
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(api.documents.patch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("link-access")).toBeDisabled();
    patchRequest.resolve({ document: turnedOn });
    await waitFor(() => expect(onDocChange).toHaveBeenCalledWith(turnedOn));
    await waitFor(() => expect(toggle).not.toHaveAttribute("aria-disabled"));
    expect(toggle).toHaveFocus();

    rerender(<ShareDialog open onOpenChange={vi.fn()} doc={turnedOn} isOwner onDocChange={onDocChange} />);
    expect(screen.getByTestId("link-preview")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("link-preview"));
    await waitFor(() => expect(api.documents.patch).toHaveBeenLastCalledWith("doc-1", { linkPreview: false }));
    expect(api.documents.patch).toHaveBeenCalledTimes(2);
  });

  it("shows a failed link-preview change and keeps the confirmed setting", async () => {
    const onDocChange = vi.fn();
    vi.mocked(api.documents.patch).mockRejectedValueOnce(apiMessage(500, "Link preview failed"));

    renderShare({ document: doc({ linkPreview: false }), onDocChange });
    await loadedRows();
    fireEvent.click(screen.getByTestId("link-preview"));

    expect(await screen.findByTestId("share-action-error")).toHaveTextContent("Link preview failed");
    expect(screen.getByTestId("link-preview")).toHaveAttribute("aria-checked", "false");
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it("shows the link-preview setting to a non owner without letting them change it", async () => {
    renderShare({ isOwner: false, document: doc({ linkPreview: true }) });
    await loadedRows();
    const toggle = screen.getByRole("switch", { name: "Show title and first lines in link previews" });

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription(
      "Slack, Teams and other apps show the title, first lines, the owner's name and when it was last updated. Only the owner can change this.",
    );
    fireEvent.click(toggle);
    expect(api.documents.patch).not.toHaveBeenCalled();
  });

  it("shows read only sharing controls to a non owner", async () => {
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([alice]));

    renderShare({ isOwner: false, document: doc({ linkAccess: "comment" }) });
    const row = await screen.findByTestId("collaborator-row");

    expect(screen.queryByTestId("share-login")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Remove alice")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for alice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("link-access")).not.toBeInTheDocument();
    expect(row).toHaveTextContent("editor");
    expect(screen.getByText("Anyone with the link can comment")).toBeInTheDocument();
  });

  it("copies the editor link and shows copied or fallback text", async () => {
    vi.mocked(copyText).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { unmount } = renderShare();
    await loadedRows();

    fireEvent.click(screen.getByTestId("copy-link"));

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/d/doc-1`));
    expect(await screen.findByText("Copied")).toBeInTheDocument();

    unmount();
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people());
    renderShare();
    await loadedRows();
    fireEvent.click(screen.getByTestId("copy-link"));

    expect(await screen.findByText(COPY_FALLBACK_HINT)).toBeInTheDocument();
  });

  it("shows and copies the reader link only when link access is not private", async () => {
    const { rerender } = renderShare({ document: doc({ linkAccess: "private" }) });
    await loadedRows();
    expect(screen.queryByTestId("reader-link")).not.toBeInTheDocument();

    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people());
    rerender(
      <ShareDialog open onOpenChange={vi.fn()} doc={doc({ linkAccess: "view" })} isOwner onDocChange={vi.fn()} />,
    );

    expect(await screen.findByTestId("reader-link")).toHaveTextContent(`${window.location.origin}/p/doc-1`);
    fireEvent.click(screen.getByTestId("copy-reader-link"));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(`${window.location.origin}/p/doc-1`));
  });

  it("renders connect agent only when provided and calls it after close", async () => {
    const onConnectAgent = vi.fn();
    const onOpenChangeSeen = vi.fn();

    function Controlled({ children }: { children?: ReactNode }) {
      const [open, setOpen] = useState(true);
      return children ? (
        <ShareDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChangeSeen(next);
            setOpen(next);
          }}
          doc={doc()}
          isOwner
          onDocChange={vi.fn()}
          onConnectAgent={onConnectAgent}
        />
      ) : (
        <ShareDialog open={open} onOpenChange={setOpen} doc={doc()} isOwner onDocChange={vi.fn()} />
      );
    }

    const { rerender } = render(<Controlled />);
    await loadedRows();
    expect(screen.queryByTestId("share-connect-agent")).not.toBeInTheDocument();

    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people());
    rerender(<Controlled>with agent</Controlled>);
    await loadedRows();
    fireEvent.click(screen.getByTestId("share-connect-agent"));

    await waitFor(() => expect(onOpenChangeSeen).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(onConnectAgent).toHaveBeenCalledOnce());
  });

  it("ignores collaborator responses from a previous document", async () => {
    const oldLoad = deferred<CollaboratorsResponse>();
    const newLoad = deferred<CollaboratorsResponse>();
    vi.mocked(api.documents.collaborators)
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);

    const { rerender } = renderShare({ document: doc({ id: "old-doc", title: "Old" }) });
    await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalledWith("old-doc"));

    rerender(
      <ShareDialog open onOpenChange={vi.fn()} doc={doc({ id: "new-doc", title: "New" })} isOwner onDocChange={vi.fn()} />,
    );
    await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalledWith("new-doc"));

    newLoad.resolve(people([collaborator("current", "viewer", "Current User")]));
    expect(await screen.findByText("@current")).toBeInTheDocument();

    oldLoad.resolve(people([collaborator("stale", "editor", "Stale User")]));
    await act(async () => {});

    expect(screen.getByText("@current")).toBeInTheDocument();
    expect(screen.queryByText("@stale")).not.toBeInTheDocument();
  });

  it("closes when Done is clicked", async () => {
    const onOpenChange = vi.fn();
    renderShare({ onOpenChange });
    await loadedRows();

    fireEvent.click(within(screen.getByTestId("share-footer")).getByRole("button", { name: "Done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});