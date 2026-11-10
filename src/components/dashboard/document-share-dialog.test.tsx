// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import type { DocumentDto } from "@/server/dto";
import { DocumentShareDialog } from "./document-share-dialog";
import { useState } from "react";

function document(id = "budget", title = "Budget"): DocumentDto {
  return {
    id, title, ownerId: "owner", storage: "local", linkAccess: "private", linkPreview: true,
    gistId: null, gistFile: null, repoOwner: null, repoName: null, repoBranch: null, repoPath: null,
    publishedAt: null, hasUnpublishedChanges: false, githubUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function metadata(id = "budget", title = "Budget") {
  return { document: document(id, title), role: "owner" as const };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const target = { id: "budget", title: "Budget" };

beforeEach(() => {
  vi.spyOn(api.documents, "get").mockResolvedValue(metadata());
  vi.spyOn(api.documents, "collaborators").mockResolvedValue({
    owner: { login: "owner", name: "Owner", image: null }, collaborators: [], agents: [], folder: null, linkAccess: "private",
  });
  vi.spyOn(api.documents, "addCollaborator").mockResolvedValue({ ok: true, login: "fixture", role: "viewer", pending: true });
  vi.spyOn(api.documents, "patch").mockResolvedValue({ document: document() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("document sharing outside the editor", () => {
  it.each(["loading", "loaded", "retry-loaded"] as const)("returns keyboard focus to the original actions trigger after closing %s metadata", async (phase) => {
    const pending = deferred<Awaited<ReturnType<typeof api.documents.get>>>();
    vi.mocked(api.documents.get).mockReturnValueOnce(pending.promise);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Document actions</button>
        {open && <DocumentShareDialog target={target} onOpenChange={setOpen} />}
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Document actions" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("status");
    const loadingClose = screen.getByRole("button", { name: "Close" });
    loadingClose.focus();
    if (phase === "retry-loaded") {
      await act(async () => pending.reject(new ApiError(503, "Metadata unavailable")));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByTestId("share-presentation");
    } else if (phase === "loaded") {
      await act(async () => pending.resolve(metadata()));
      await screen.findByTestId("share-presentation");
      expect(loadingClose.isConnected).toBe(false);
    }
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("loads fresh owner metadata and reuses the named Share dialog without granting or changing access", async () => {
    render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    await screen.findByTestId("share-presentation");
    expect(screen.getByRole("dialog", { name: "Share “Budget”" })).toBeVisible();
    expect(api.documents.get).toHaveBeenCalledExactlyOnceWith("budget", { signal: expect.any(AbortSignal), cache: "no-store" });
    expect(api.documents.collaborators).toHaveBeenCalledExactlyOnceWith("budget");
    expect(screen.getByTestId("share-login")).toBeVisible();
    expect(api.documents.addCollaborator).not.toHaveBeenCalled();
    expect(api.documents.patch).not.toHaveBeenCalled();
  });

  it.each(["viewer", "commenter", "editor"] as const)("does not expose management UI when current access is %s rather than the stale summary's owner role", async (role) => {
    vi.mocked(api.documents.get).mockResolvedValue({ document: document(), role });
    render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the document owner can manage sharing.");
    expect(screen.queryByTestId("share-login")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(api.documents.collaborators).not.toHaveBeenCalled();
    expect(api.documents.addCollaborator).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 503])("keeps a failed %s metadata request explicit and retries without showing successful sharing UI", async (status) => {
    vi.mocked(api.documents.get).mockRejectedValueOnce(new ApiError(status, "Document sharing unavailable"));
    render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Document sharing unavailable");
    expect(screen.queryByTestId("share-presentation")).not.toBeInTheDocument();
    expect(api.documents.collaborators).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("share-presentation");
    expect(api.documents.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["success", "failure"])("aborts changed targets and ignores a late %s, even when the transport ignores cancellation", async (outcome) => {
    const old = deferred<Awaited<ReturnType<typeof api.documents.get>>>();
    vi.mocked(api.documents.get).mockReturnValueOnce(old.promise).mockResolvedValueOnce(metadata("plan", "Plan"));
    const view = render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading document sharing");
    expect(api.documents.collaborators).not.toHaveBeenCalled();
    const signal = vi.mocked(api.documents.get).mock.calls[0][1]?.signal;
    view.rerender(<DocumentShareDialog target={{ id: "plan", title: "Plan" }} onOpenChange={vi.fn()} />);
    await screen.findByTestId("share-presentation");
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") old.resolve(metadata());
      else old.reject(new ApiError(503, "Stale failure"));
    });
    expect(screen.getByRole("dialog", { name: "Share “Plan”" })).toBeVisible();
    expect(api.documents.collaborators).toHaveBeenCalledExactlyOnceWith("plan");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels a closed loading dialog and checks authorization again on reopening", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.documents.get>>>();
    vi.mocked(api.documents.get).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ document: document(), role: "viewer" });
    const view = render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    const signal = vi.mocked(api.documents.get).mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    await screen.findByRole("alert");
    await act(async () => old.resolve(metadata()));
    expect(screen.queryByTestId("share-login")).not.toBeInTheDocument();
    expect(api.documents.get).toHaveBeenCalledTimes(2);
    expect(api.documents.collaborators).not.toHaveBeenCalled();
  });

  it("updates the existing dialog's link state only after an explicit successful owner change", async () => {
    vi.mocked(api.documents.patch).mockResolvedValue({ document: { ...document(), linkAccess: "view" } });
    render(<DocumentShareDialog target={target} onOpenChange={vi.fn()} />);
    await screen.findByTestId("share-presentation");
    fireEvent.change(screen.getByTestId("link-access"), { target: { value: "view" } });
    await waitFor(() => expect(screen.getByTestId("link-access")).toHaveValue("view"));
    expect(api.documents.patch).toHaveBeenCalledExactlyOnceWith("budget", { linkAccess: "view" });
  });
});
