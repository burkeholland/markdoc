// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState, type ReactNode } from "react";

import { ShareDialog } from "./share-dialog";
import { ApiError, api, type CollaboratorDto } from "@/lib/api";
import { COPY_FALLBACK_HINT, copyText } from "@/lib/clipboard";
import type { DocumentDto } from "@/server/dto";

vi.mock("@/lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clipboard")>();
  return { ...actual, copyText: vi.fn() };
});

const notifications = vi.hoisted(() => ({ markNotificationRead: vi.fn() }));
vi.mock("@/lib/notifications-store", () => ({ markNotificationReadConfirmed: notifications.markNotificationRead }));

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

function people(
  collaborators: CollaboratorDto[] = [alice],
  ownerValue = owner,
  folder: CollaboratorsResponse["folder"] = null,
): CollaboratorsResponse {
  return { owner: ownerValue, linkAccess: "private", folder, collaborators, agents: [] };
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
  accessRequest,
}: {
  open?: boolean;
  document?: DocumentDto;
  isOwner?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDocChange?: (document: DocumentDto) => void;
  onConnectAgent?: () => void;
  accessRequest?: { login: string; name: string | null; notificationId: string | null };
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
        accessRequest={accessRequest}
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
  notifications.markNotificationRead.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShareDialog", () => {
  describe("access requests", () => {
    const request = { login: "zoe", name: "Zoe Example", notificationId: "request-one" };

    it("shows a compact requester-specific decision without loading the share settings", () => {
      renderShare({ accessRequest: request });

      expect(screen.getByRole("dialog", { name: "Share document “Launch Plan”" })).toBeVisible();
      expect(screen.getByText("Zoe Example (@zoe) requested access to this document.")).toBeInTheDocument();
      expect(screen.getByText("Adds a View grant on this document only. Higher access from other grants is kept.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deny request" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Grant view access" })).toBeInTheDocument();
      expect(screen.queryByTestId("share-presentation")).not.toBeInTheDocument();
      expect(api.documents.collaborators).not.toHaveBeenCalled();
      expect(notifications.markNotificationRead).not.toHaveBeenCalled();
    });

    it("grants view access and marks the request read only after the grant succeeds", async () => {
      const onOpenChange = vi.fn();
      renderShare({ accessRequest: request, onOpenChange });

      fireEvent.click(screen.getByTestId("access-request-grant"));

      await waitFor(() => expect(api.documents.addCollaborator).toHaveBeenCalledExactlyOnceWith("doc-1", "zoe", "viewer"));
      expect(notifications.markNotificationRead).toHaveBeenCalledExactlyOnceWith(request.notificationId);
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("waits for the notification read to finish before closing after a grant", async () => {
      const read = deferred<boolean>();
      const onOpenChange = vi.fn();
      notifications.markNotificationRead.mockReturnValueOnce(read.promise);
      renderShare({ accessRequest: request, onOpenChange });

      fireEvent.click(screen.getByTestId("access-request-grant"));

      await waitFor(() => expect(api.documents.addCollaborator).toHaveBeenCalledExactlyOnceWith("doc-1", "zoe", "viewer"));
      expect(notifications.markNotificationRead).toHaveBeenCalledExactlyOnceWith(request.notificationId);
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        read.resolve(true);
        await read.promise;
      });

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("denies by dismissing the request without adding the requester", async () => {
      const onOpenChange = vi.fn();
      renderShare({ accessRequest: request, onOpenChange });

      fireEvent.click(screen.getByTestId("access-request-deny"));

      expect(notifications.markNotificationRead).toHaveBeenCalledExactlyOnceWith(request.notificationId);
      expect(api.documents.addCollaborator).not.toHaveBeenCalled();
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("keeps an unconfirmed notification dismissal open with an explicit error and allows retry", async () => {
      notifications.markNotificationRead.mockResolvedValueOnce(false);
      const onOpenChange = vi.fn();
      renderShare({ accessRequest: request, onOpenChange });
      fireEvent.click(screen.getByTestId("access-request-deny"));
      expect(await screen.findByTestId("access-request-error")).toHaveTextContent("Could not mark this request as resolved");
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(api.documents.addCollaborator).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("access-request-deny"));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(notifications.markNotificationRead).toHaveBeenCalledTimes(2);
    });

    it("keeps a failed grant open and unread so it can be retried", async () => {
      const onOpenChange = vi.fn();
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(apiMessage(500, "Access service unavailable"));
      renderShare({ accessRequest: request, onOpenChange });

      fireEvent.click(screen.getByTestId("access-request-grant"));

      expect(await screen.findByTestId("access-request-error")).toHaveTextContent("Access service unavailable");
      expect(notifications.markNotificationRead).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("resolves the request when the requester already has access", async () => {
      const onOpenChange = vi.fn();
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(
        new ApiError(409, "zoe already has access as viewer", undefined, {
          code: "already-collaborator",
          login: "zoe",
          role: "viewer",
        }),
      );
      renderShare({ accessRequest: request, onOpenChange });

      fireEvent.click(screen.getByTestId("access-request-grant"));

      await waitFor(() => expect(notifications.markNotificationRead).toHaveBeenCalledExactlyOnceWith(request.notificationId));
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("does not offer a decision to a non-owner", () => {
      renderShare({ accessRequest: request, isOwner: false });

      expect(screen.queryByTestId("access-request-grant")).not.toBeInTheDocument();
      expect(screen.queryByTestId("access-request-deny")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
      expect(notifications.markNotificationRead).not.toHaveBeenCalled();
    });
  });

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

  it("explains that folder access is inherited without mixing it into direct collaborators", async () => {
    vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([alice], owner, { id: "folder-1", name: "Planning", linkAccess: "edit" }));

    renderShare();
    await loadedRows();

    expect(screen.getByTestId("folder-inherited-access")).toHaveTextContent(
      "This document inherits access from folder Planning. Folder link access: edit.",
    );
    expect(screen.getAllByTestId("collaborator-row")).toHaveLength(1);
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

  it("picking a suggestion moves focus to the role select; Enter there never adds, held or released - same as main", async () => {
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

    // A held Enter's auto-repeat must not add - the original review bug (#2248 round 1) and must stay fixed.
    fireEvent.keyDown(screen.getByTestId("share-role"), { key: "Enter", repeat: true });
    expect(api.documents.addCollaborator).not.toHaveBeenCalled();

    // The role select has no onKeyDown at all - same as main - so a released, non-repeat Enter here does not
    // add either; only the Add button submits.
    fireEvent.keyDown(screen.getByTestId("share-role"), { key: "Enter" });
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

    // The role select of a listed person says it means to change the role; an add (above) never does.
    await waitFor(() => expect(api.documents.addCollaborator).toHaveBeenCalledWith("doc-1", "bob", "commenter", { change: true }));
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

  describe("adding someone who already has access (#2252)", () => {
    /** What POST /api/documents/:id/collaborators answers when an add would change a role. */
    const refused = (login: string, role: Role) =>
      new ApiError(409, `${login} already has access as ${role}. Send change: true to change the role.`, undefined, {
        error: `${login} already has access as ${role}. Send change: true to change the role.`,
        code: "already-collaborator",
        login,
        role,
      });
    const submit = () => fireEvent.submit(screen.getByTestId("share-login").closest("form")!);
    const problem = () => screen.queryByTestId("share-add-error");

    it.each([false, true])("shows why the add was refused next to the field, keeps the typed handle and leaves the role alone (StrictMode: %s)", async (strict) => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(people([alice, bob]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("bob", "viewer"));
      const dialog = <ShareDialog open onOpenChange={vi.fn()} doc={doc()} isOwner onDocChange={vi.fn()} />;
      render(strict ? <StrictMode>{dialog}</StrictMode> : dialog);
      await loadedRows();
      const loads = vi.mocked(api.documents.collaborators).mock.calls.length;
      screen.getByTestId("share-login").focus();
      await fillLogin(" @Bob ");
      submit();

      const alert = await screen.findByTestId("share-add-error");
      expect(alert).toHaveTextContent("@bob already has access as Viewer. Change the role in the list below.");
      expect(alert.textContent).toBe("@bob already has access as Viewer. Change the role in the list below.");
      expect(alert).toHaveAttribute("role", "alert");
      expect(alert).toHaveAttribute("data-code", "already-collaborator");
      // One request, an add (no change flag), with the role the select showed.
      expect(vi.mocked(api.documents.addCollaborator).mock.calls).toEqual([["doc-1", "@Bob", "editor"]]);
      expect(screen.getByTestId("share-login")).toHaveValue(" @Bob ");
      expect(screen.getByTestId("share-login")).toHaveFocus();
      expect(screen.getByLabelText("Role for bob")).toHaveValue("viewer");
      expect(screen.getByLabelText("Role for alice")).toHaveValue("editor");
      expect(screen.queryByTestId("share-add-note")).not.toBeInTheDocument();
      // The person is in the list already: no reload.
      expect(api.documents.collaborators).toHaveBeenCalledTimes(loads);
      await waitFor(() => expect(screen.getByTestId("share-add")).not.toHaveAttribute("aria-disabled"));
    });

    it("shows the role the server reported in the row too when this dialog's list was out of date", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([collaborator("bob", "commenter")]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("bob", "viewer"));
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      submit();

      expect(await screen.findByTestId("share-add-error")).toHaveTextContent("@bob already has access as Viewer.");
      expect(screen.getByLabelText("Role for bob")).toHaveValue("viewer");
    });

    it("loads the list again when the refused person is not in it, so the row the message points to is there", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([])).mockResolvedValueOnce(people([collaborator("carl", "commenter")]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("carl", "commenter"));
      renderShare();
      await screen.findByText("Nobody else has been added yet.");
      await fillLogin("carl");
      submit();

      expect(await screen.findByLabelText("Role for carl")).toHaveValue("commenter");
      expect(problem()).toHaveTextContent("@carl already has access as Commenter. Change the role in the list below.");
      expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
    });

    it("drops the message when that reload shows the person is gone (removed elsewhere in between)", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([])).mockResolvedValueOnce(people([alice]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("carl", "commenter"));
      renderShare();
      await screen.findByText("Nobody else has been added yet.");
      await fillLogin("carl");
      submit();

      expect(await screen.findByText("@alice")).toBeInTheDocument();
      await waitFor(() => expect(problem()).not.toBeInTheDocument());
      expect(screen.getByTestId("share-login")).toHaveValue("carl");
    });

    it("the next try is sent to the server again, and works as an add once the person was removed elsewhere", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([bob])).mockResolvedValueOnce(people([collaborator("bob", "editor")]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("bob", "viewer")).mockResolvedValueOnce({ ok: true, login: "bob", role: "editor", pending: false });
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      submit();
      await screen.findByTestId("share-add-error");
      await waitFor(() => expect(screen.getByTestId("share-add")).not.toHaveAttribute("aria-disabled"));

      submit();
      await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(""));
      expect(vi.mocked(api.documents.addCollaborator).mock.calls).toEqual([
        ["doc-1", "bob", "editor"],
        ["doc-1", "bob", "editor"],
      ]);
      expect(problem()).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText("Role for bob")).toHaveValue("editor"));
    });

    it("the message follows the row: a role change in the list updates it, removing the person drops it", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([alice, bob]));
      vi.mocked(api.documents.addCollaborator)
        .mockRejectedValueOnce(refused("bob", "viewer"))
        .mockResolvedValueOnce({ ok: true, login: "bob", role: "commenter", pending: false });
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      submit();
      await screen.findByTestId("share-add-error");

      fireEvent.change(screen.getByLabelText("Role for bob"), { target: { value: "commenter" } });
      await waitFor(() => expect(problem()).toHaveTextContent("@bob already has access as Commenter. Change the role in the list below."));
      expect(api.documents.addCollaborator).toHaveBeenLastCalledWith("doc-1", "bob", "commenter", { change: true });

      // Someone else leaving does not touch it; bob leaving does.
      fireEvent.click(screen.getByLabelText("Remove alice"));
      await waitFor(() => expect(screen.queryByText("@alice")).not.toBeInTheDocument());
      expect(problem()).toHaveTextContent("@bob already has access as Commenter.");
      fireEvent.click(screen.getByLabelText("Remove bob"));
      await waitFor(() => expect(screen.queryByText("@bob")).not.toBeInTheDocument());
      expect(problem()).not.toBeInTheDocument();
      expect(screen.getByTestId("share-login")).toHaveValue("bob");
    });

    it.each([
      ["a refusal", () => refused("bob", "viewer"), "@bob already has access as Viewer."],
      ["any other add error", () => apiMessage(400, "That is the owner"), "That is the owner"],
    ])("%s goes away when the handle text changes", async (_label, error, text) => {
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([bob]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(error());
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      submit();
      expect(await screen.findByTestId("share-add-error")).toHaveTextContent(text);

      await fillLogin("bobb");
      expect(problem()).not.toBeInTheDocument();
      await fillLogin("bob");
      expect(problem()).not.toBeInTheDocument();
      expect(api.documents.addCollaborator).toHaveBeenCalledTimes(1);
    });

    it("a reopened dialog, another document and a person who is no longer the owner see no stale message", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(people([bob]));
      const refuseOnce = async (rerender: (ui: ReactNode) => void, document: DocumentDto) => {
        vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(refused("bob", "viewer"));
        rerender(<ShareDialog open onOpenChange={vi.fn()} doc={document} isOwner onDocChange={vi.fn()} />);
        await loadedRows();
        await fillLogin("bob");
        submit();
        await screen.findByTestId("share-add-error");
      };
      const { rerender } = renderShare();

      // Closed and opened again.
      await refuseOnce(rerender, doc());
      rerender(<ShareDialog open={false} onOpenChange={vi.fn()} doc={doc()} isOwner onDocChange={vi.fn()} />);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc()} isOwner onDocChange={vi.fn()} />);
      await loadedRows();
      expect(problem()).not.toBeInTheDocument();

      // Another document in the same dialog.
      await fillLogin("");
      await refuseOnce(rerender, doc());
      rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc({ id: "doc-2" })} isOwner onDocChange={vi.fn()} />);
      await loadedRows();
      expect(problem()).not.toBeInTheDocument();

      // No longer the owner: the add form and its message are not shown at all.
      await fillLogin("");
      await refuseOnce(rerender, doc({ id: "doc-2" }));
      rerender(<ShareDialog open onOpenChange={vi.fn()} doc={doc({ id: "doc-2" })} isOwner={false} onDocChange={vi.fn()} />);
      expect(problem()).not.toBeInTheDocument();
      expect(screen.queryByTestId("share-login")).not.toBeInTheDocument();
    });

    it("a 409 without the code, or with a role this dialog does not know, is shown as the server's own text", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(people([bob]));
      vi.mocked(api.documents.addCollaborator)
        .mockRejectedValueOnce(new ApiError(409, "Conflict of another kind", undefined, { error: "Conflict of another kind", login: "bob", role: "viewer" }))
        .mockRejectedValueOnce(new ApiError(409, "bob already has access as admin", undefined, { code: "already-collaborator", login: "bob", role: "admin" }));
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      submit();
      expect(await screen.findByTestId("share-add-error")).toHaveTextContent("Conflict of another kind");
      expect(problem()).not.toHaveAttribute("data-code");
      await waitFor(() => expect(screen.getByTestId("share-add")).not.toHaveAttribute("aria-disabled"));

      submit();
      await waitFor(() => expect(problem()).toHaveTextContent("bob already has access as admin"));
      expect(problem()).not.toHaveAttribute("data-code");
    });
  });

  describe("one press is one action, and focus stays put (#2252)", () => {
    type Added = Awaited<ReturnType<typeof api.documents.addCollaborator>>;

    it("Add stays focusable while the add runs (aria-disabled, not disabled) and ignores a second press", async () => {
      const request = deferred<Added>();
      vi.mocked(api.documents.addCollaborator).mockReturnValueOnce(request.promise);
      renderShare();
      await loadedRows();
      await fillLogin("zoe");
      const add = screen.getByTestId("share-add");
      add.focus();
      fireEvent.click(add);

      expect(add).toHaveAttribute("aria-disabled", "true");
      expect(add).toHaveAttribute("aria-busy", "true");
      expect(add).not.toBeDisabled();
      expect(add).toHaveFocus();
      fireEvent.click(add);
      fireEvent.submit(add.closest("form")!);
      expect(api.documents.addCollaborator).toHaveBeenCalledTimes(1);

      // Added: the field empties, Add is disabled again, and the focus it held goes to the field, not nowhere.
      request.resolve({ ok: true, login: "zoe", role: "editor", pending: false });
      await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(""));
      expect(screen.getByTestId("share-login")).toHaveFocus();
      await waitFor(() => expect(add).not.toHaveAttribute("aria-disabled"));
      expect(add).toBeDisabled();
      expect(document.activeElement).not.toBe(document.body);
    });

    it("focus that moved on while the add ran is left where the person put it", async () => {
      const request = deferred<Added>();
      vi.mocked(api.documents.addCollaborator).mockReturnValueOnce(request.promise);
      renderShare();
      await loadedRows();
      await fillLogin("zoe");
      const add = screen.getByTestId("share-add");
      add.focus();
      fireEvent.click(add);
      const elsewhere = screen.getByLabelText("Role for alice");
      elsewhere.focus();

      request.resolve({ ok: true, login: "zoe", role: "editor", pending: false });
      await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(""));
      expect(elsewhere).toHaveFocus();
    });

    it("a refused or failed add leaves focus on Add, which stays usable", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(people([bob]));
      vi.mocked(api.documents.addCollaborator).mockRejectedValueOnce(
        new ApiError(409, "refused", undefined, { code: "already-collaborator", login: "bob", role: "viewer" }),
      );
      renderShare();
      await loadedRows();
      await fillLogin("bob");
      const add = screen.getByTestId("share-add");
      add.focus();
      fireEvent.click(add);

      await screen.findByTestId("share-add-error");
      await waitFor(() => expect(add).not.toHaveAttribute("aria-disabled"));
      expect(add).toHaveFocus();
      expect(add).toBeEnabled();
    });

    it("a held Enter's repeats never start an add, in the field or on Add; the first press is left alone", async () => {
      renderShare();
      await loadedRows();
      await fillLogin("zoe");
      const box = screen.getByTestId("share-login");
      const add = screen.getByTestId("share-add");

      // fireEvent returns false when the event was cancelled: a cancelled Enter keydown submits nothing.
      expect(fireEvent.keyDown(box, { key: "Enter", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(add, { key: "Enter", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(screen.getByTestId("share-role"), { key: "Enter", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
      expect(fireEvent.keyDown(add, { key: "Enter" })).toBe(true);
      // Other held keys are none of this guard's business.
      expect(fireEvent.keyDown(box, { key: "a", repeat: true })).toBe(true);
      expect(fireEvent.keyDown(box, { key: "ArrowDown", repeat: true })).toBe(true);
      expect(api.documents.addCollaborator).not.toHaveBeenCalled();
    });

    it("the request carries the role the select showed when it was sent", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(people([]));
      renderShare();
      await screen.findByText("Nobody else has been added yet.");
      await fillLogin("zoe");
      // The role changes and the form is submitted in the same tick, before any effect could run.
      act(() => {
        fireEvent.change(screen.getByTestId("share-role"), { target: { value: "viewer" } });
        fireEvent.submit(screen.getByTestId("share-login").closest("form")!);
      });
      expect(vi.mocked(api.documents.addCollaborator).mock.calls).toEqual([["doc-1", "zoe", "viewer"]]);
      await waitFor(() => expect(screen.getByTestId("share-login")).toHaveValue(""));
    });

    it("a row's role select and Remove stay focusable while their request runs, and ignore a second press", async () => {
      const change = deferred<Added>();
      const removal = deferred<{ ok: true }>();
      vi.mocked(api.documents.collaborators).mockResolvedValueOnce(people([alice, bob]));
      vi.mocked(api.documents.addCollaborator).mockReturnValueOnce(change.promise);
      vi.mocked(api.documents.removeCollaborator).mockReturnValueOnce(removal.promise);
      renderShare();
      await loadedRows();

      const select = screen.getByLabelText("Role for bob");
      select.focus();
      fireEvent.change(select, { target: { value: "commenter" } });
      expect(select).toHaveAttribute("aria-disabled", "true");
      expect(select).not.toBeDisabled();
      expect(select).toHaveFocus();
      // A second pick and a Remove on the busy row are ignored; the select shows the confirmed role meanwhile.
      fireEvent.change(select, { target: { value: "editor" } });
      fireEvent.click(screen.getByLabelText("Remove bob"));
      expect(select).toHaveValue("viewer");
      expect(api.documents.addCollaborator).toHaveBeenCalledTimes(1);
      expect(api.documents.removeCollaborator).not.toHaveBeenCalled();
      change.resolve({ ok: true, login: "bob", role: "commenter", pending: false });
      await waitFor(() => expect(select).toHaveValue("commenter"));
      await waitFor(() => expect(select).not.toHaveAttribute("aria-disabled"));
      expect(select).toHaveFocus();

      const remove = screen.getByLabelText("Remove alice");
      remove.focus();
      fireEvent.click(remove);
      expect(remove).toHaveAttribute("aria-disabled", "true");
      expect(remove).not.toBeDisabled();
      expect(remove).toHaveFocus();
      fireEvent.click(remove);
      expect(api.documents.removeCollaborator).toHaveBeenCalledTimes(1);
      removal.resolve({ ok: true });
      await waitFor(() => expect(screen.queryByText("@alice")).not.toBeInTheDocument());
    });
  });

  it("closes when Done is clicked", async () => {
    const onOpenChange = vi.fn();
    renderShare({ onOpenChange });
    await loadedRows();

    fireEvent.click(within(screen.getByTestId("share-footer")).getByRole("button", { name: "Done" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});