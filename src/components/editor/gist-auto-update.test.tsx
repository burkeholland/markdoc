// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api, ApiError } from "@/lib/api";
import { GIST_AUTO_UPDATE_NOTICE, type GistAutoUpdateDestination, type GistAutoUpdateStatus } from "@/lib/gist-auto-update";
import type { DocumentDto } from "@/server/dto";
import { GistAutoUpdateControl } from "./gist-auto-update";
import { CommitDialog } from "./github-dialog";

const DESTINATION: GistAutoUpdateDestination = {
  gistId: "gist-auto-test",
  filename: "notes.md",
  url: "https://gist.github.com/gist-auto-test",
  visibility: "secret",
  owner: "gist-owner",
};
const DOC: DocumentDto = {
  id: "doc-auto-test",
  title: "Local notes",
  storage: "gist",
  linkAccess: "private",
  ownerId: "owner-auto-test",
  gistId: DESTINATION.gistId,
  gistFile: DESTINATION.filename,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: "2026-09-05T10:00:00.000Z",
  hasUnpublishedChanges: false,
  githubUrl: DESTINATION.url,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T10:00:00.000Z",
};
const OFF: GistAutoUpdateStatus = { enabled: false, status: "off", syncedAt: null, message: null, pending: false, destination: null };
const PENDING: GistAutoUpdateStatus = { ...OFF, enabled: true, status: "pending", destination: DESTINATION };
let serverStatus: GistAutoUpdateStatus;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => act(async () => {});
const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole("button", { name })); });
const advance = (milliseconds = 2_000) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
const state = () => screen.getByTestId("gist-auto-update-state");
async function mount(doc = DOC) {
  const result = render(<GistAutoUpdateControl doc={doc} isOwner />);
  await settle();
  return result;
}
async function consent() {
  await click("Check linked gist");
  await act(async () => { fireEvent.click(screen.getByRole("checkbox", { name: "I acknowledge the sharing and overwrite risks." })); });
}

beforeEach(() => {
  vi.useFakeTimers();
  serverStatus = { ...OFF };
  vi.spyOn(api.documents, "gistAutoUpdate").mockImplementation(async () => serverStatus);
  vi.spyOn(api.documents, "gistAutoUpdatePreview").mockResolvedValue({ destination: DESTINATION });
  vi.spyOn(api.documents, "setGistAutoUpdate").mockImplementation(async (_id, settings) => {
    serverStatus = settings.enabled ? { ...PENDING, destination: settings.destination } : { ...OFF };
    return serverStatus;
  });
  vi.spyOn(api.documents, "retryGistAutoUpdate").mockImplementation(async () => {
    serverStatus = { ...PENDING };
    return serverStatus;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gist auto-update owner opt-in", () => {
  it("defaults to off and only reads lightweight status until an explicit preview", async () => {
    await mount();
    expect(state()).toHaveTextContent("Off");
    expect(state()).toHaveAttribute("data-status", "off");
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await advance(6_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(4);
    expect(api.documents.gistAutoUpdatePreview).not.toHaveBeenCalled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("requires a fresh explicit destination preview and acknowledgement, never a cached status destination", async () => {
    serverStatus = { ...OFF, destination: { ...DESTINATION, visibility: "public", owner: "previous-account" } };
    await mount();
    const destination = screen.getByTestId("gist-auto-update-destination");
    expect(destination).not.toHaveTextContent("previous-account");
    await click("Enable auto-update");
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await click("Check linked gist");
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(within(destination).getByRole("link")).toHaveAttribute("href", DESTINATION.url);
    expect(destination).toHaveTextContent(DESTINATION.filename);
    expect(destination).toHaveTextContent("Secret (unlisted, not private)");
    expect(destination).toHaveTextContent(`GitHub account: @${DESTINATION.owner}`);
    expect(screen.getByText(GIST_AUTO_UPDATE_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/not one atomic operation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("checkbox")); });
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await click("Enable auto-update");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, {
      enabled: true,
      acknowledgeRisk: true,
      destination: DESTINATION,
    });
    expect(state()).toHaveTextContent("Pending");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    await advance(8_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows public visibility and clears consent whenever the destination is rechecked", async () => {
    const destination = { ...DESTINATION, visibility: "public" as const };
    vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValue({ destination });
    await mount();
    await consent();
    expect(screen.getByTestId("gist-auto-update-destination")).toHaveTextContent("Visibility: Public");
    expect(screen.getByRole("checkbox")).toBeChecked();
    await click("Recheck linked gist");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-owner", DOC, false],
    ["local", { ...DOC, storage: "local" }, true],
    ["repository", { ...DOC, storage: "repo" }, true],
    ["unpublished", { ...DOC, publishedAt: null }, true],
    ["missing gist", { ...DOC, gistId: null }, true],
    ["missing file", { ...DOC, gistFile: null }, true],
    ["missing URL", { ...DOC, githubUrl: null }, true],
  ] as const)("hides for %s documents without any API calls", async (_name, doc, isOwner) => {
    render(<GistAutoUpdateControl doc={doc} isOwner={isOwner} />);
    await settle();
    await advance();
    expect(screen.queryByTestId("gist-auto-update")).toBeNull();
    expect(api.documents.gistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.gistAutoUpdatePreview).not.toHaveBeenCalled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("does not fetch or write for document/save rerenders, or reset the checked consent", async () => {
    const { rerender } = await mount();
    await consent();
    for (let n = 0; n < 10; n++) {
      rerender(<GistAutoUpdateControl doc={{ ...DOC, title: `Edit ${n}`, updatedAt: `2026-09-05T10:00:0${n}.000Z`, publishedAt: `2026-09-05T10:00:0${n}.000Z`, hasUnpublishedChanges: true }} isOwner />);
    }
    await settle();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
  });
});

describe("gist auto-update status and recovery", () => {
  it("distinguishes pending, syncing with a newer saved version, and synced-at", async () => {
    serverStatus = { ...PENDING, pending: true };
    await mount();
    expect(state()).toHaveTextContent("Pending");
    expect(screen.getByText("The latest saved version is waiting to publish.")).toBeInTheDocument();
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    serverStatus = { ...PENDING, status: "syncing", pending: true };
    await advance();
    expect(state()).toHaveTextContent("Syncing");
    expect(screen.getByTestId("gist-auto-update-pending")).toHaveTextContent("newest saved version is pending behind the current upload");
    const syncedAt = "2026-09-05T10:20:00.000Z";
    serverStatus = { ...PENDING, status: "synced", syncedAt };
    await advance();
    expect(state()).toHaveTextContent("Synced");
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    expect(screen.getByText(/Last synced at/).querySelector("time")).toHaveAttribute("datetime", syncedAt);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
  });

  it.each(["failed", "conflict"] as const)("only retries %s after the owner requests the latest saved version", async (failure) => {
    serverStatus = { ...PENDING, status: failure, message: failure === "conflict" ? "Outside changes detected." : "GitHub is unavailable." };
    await mount();
    expect(state()).toHaveAttribute("data-status", failure);
    expect(screen.getByText(serverStatus.message!)).toBeInTheDocument();
    if (failure === "conflict") {
      expect(screen.getByText(/Manually reconcile/)).toHaveTextContent("Retry does not force an overwrite or resolve a known conflict");
    }
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.retryGistAutoUpdate).not.toHaveBeenCalled();
    await click("Retry latest saved version");
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    expect(state()).toHaveTextContent("Pending");
    await advance();
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns to conflict when the queued retry's strict preflight cannot reconcile it", async () => {
    const conflict: GistAutoUpdateStatus = { ...PENDING, status: "conflict", message: "Reconcile the outside changes first." };
    serverStatus = conflict;
    await mount();
    await click("Retry latest saved version");
    expect(state()).toHaveTextContent("Pending");
    serverStatus = conflict;
    await advance();
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByRole("button", { name: "Retry latest saved version" })).toBeEnabled();
    await advance(20_000);
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry a rejected retry request", async () => {
    serverStatus = { ...PENDING, status: "failed" };
    vi.mocked(api.documents.retryGistAutoUpdate).mockRejectedValue(new ApiError(503, "GitHub is unavailable."));
    await mount();
    await click("Retry latest saved version");
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub is unavailable.");
    await advance(20_000);
    expect(api.documents.retryGistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("disables explicitly during an upload without claiming that the upload was cancelled", async () => {
    serverStatus = { ...PENDING, status: "syncing", pending: true };
    const message = "Auto-update is off. An upload already in progress may finish.";
    vi.mocked(api.documents.setGistAutoUpdate).mockImplementationOnce(async () => {
      serverStatus = { ...OFF, message };
      return serverStatus;
    });
    await mount();
    expect(screen.getByText(/An update already in progress may still finish/)).toBeInTheDocument();
    await click("Disable auto-update");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledExactlyOnceWith(DOC.id, { enabled: false });
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId("gist-auto-update-pending")).toBeNull();
    expect(screen.getByText(/An update already in progress may still finish/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it.each([409, 503])("keeps Disable available after HTTP %i, without assuming success or retrying automatically", async (httpStatus) => {
    serverStatus = { ...PENDING };
    const message = httpStatus === 409 ? "Publishing configuration is busy. Try again after it finishes." : "Could not save the setting.";
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new ApiError(httpStatus, message));
    await mount();
    await click("Disable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(state()).not.toHaveAttribute("data-status", "off");
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Enable auto-update" })).toBeNull();
    await advance(20_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("can check a mutation's uncertain outcome without sending the mutation again", async () => {
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new Error("Response interrupted."));
    await mount();
    await consent();
    await click("Enable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent("Response interrupted.");
    serverStatus = { ...PENDING };
    await click("Refresh status");
    expect(state()).toHaveTextContent("Pending");
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("stops polling on status errors and only resumes after an explicit refresh", async () => {
    vi.mocked(api.documents.gistAutoUpdate).mockRejectedValueOnce(new ApiError(503, "Status unavailable."));
    await mount();
    expect(state()).toHaveTextContent("Failed");
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Refresh status");
    expect(state()).toHaveTextContent("Off");
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(3);
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
  });

  it("requires an explicit new destination check after a preview failure", async () => {
    vi.mocked(api.documents.gistAutoUpdatePreview).mockRejectedValueOnce(new ApiError(403, "Cannot read this gist."));
    await mount();
    await click("Check linked gist");
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot read this gist.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdatePreview).toHaveBeenCalledTimes(1);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Check linked gist");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("shows a wait-for-save activation refusal without turning the control on or retrying it", async () => {
    const message = "Wait for Markdoc to finish saving before enabling auto-update, then check the linked gist again. The auto-update setting has not changed.";
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValueOnce(new ApiError(409, message));
    await mount();
    await consent();
    await click("Enable auto-update");
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("button", { name: "Disable auto-update" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    await advance(10_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    await click("Refresh status");
    expect(state()).toHaveTextContent("Off");
    await consent();
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Pending");
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(2);
  });

  it("preserves the manual Update gist description through a failed opt-in and never submits via its own controls", async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.documents.setGistAutoUpdate).mockRejectedValue(new ApiError(409, "Review the changed gist first.", undefined, { status: "conflict" }));
    render(<CommitDialog open onOpenChange={vi.fn()} doc={DOC} isOwner onCommit={onCommit} />);
    await settle();
    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "Keep this manual description" } });
    await consent();
    for (const button of within(screen.getByTestId("gist-auto-update")).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByTestId("commit-message")).toHaveValue("Keep this manual description");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await advance(10_000);
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByTestId("commit-submit")); });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Keep this manual description");
  });
});

describe("gist auto-update request lifetimes", () => {
  it.each(["resolve", "reject"] as const)("ignores a late poll that would %s after enabling", async (outcome) => {
    const poll = deferred<GistAutoUpdateStatus>();
    await mount();
    await consent();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(poll.promise);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(2);
    await click("Enable auto-update");
    expect(state()).toHaveTextContent("Pending");
    await act(async () => {
      if (outcome === "resolve") poll.resolve(OFF);
      else poll.reject(new ApiError(503, "Stale status error."));
    });
    expect(state()).toHaveTextContent("Pending");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Disable auto-update" })).toBeEnabled();
  });

  it("ignores a late enabled poll after an explicit disable", async () => {
    const poll = deferred<GistAutoUpdateStatus>();
    serverStatus = { ...PENDING };
    await mount();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(poll.promise);
    await advance();
    await click("Disable auto-update");
    await act(async () => { poll.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.queryByRole("button", { name: "Disable auto-update" })).toBeNull();
  });

  it("ignores an old document's status response", async () => {
    const oldStatus = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(oldStatus.promise);
    const { rerender } = await mount();
    const nextDoc = { ...DOC, id: "another-doc" };
    rerender(<GistAutoUpdateControl doc={nextDoc} isOwner />);
    await settle();
    await act(async () => { oldStatus.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(api.documents.gistAutoUpdate).toHaveBeenNthCalledWith(2, nextDoc.id);
    await advance();
    expect(api.documents.gistAutoUpdate).toHaveBeenLastCalledWith(nextDoc.id);
  });

  it.each([
    { gistId: "new-gist", githubUrl: "https://gist.github.com/new-gist" },
    { gistFile: "renamed.md" },
    { githubUrl: "https://gist.github.com/new-owner/gist-auto-test" },
  ])("ignores an old preview after the destination changes: %j", async (change) => {
    const oldPreview = deferred<{ destination: GistAutoUpdateDestination }>();
    vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(oldPreview.promise);
    const { rerender } = await mount();
    await click("Check linked gist");
    rerender(<GistAutoUpdateControl doc={{ ...DOC, ...change }} isOwner />);
    await settle();
    await act(async () => { oldPreview.resolve({ destination: DESTINATION }); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(screen.getByTestId("gist-auto-update-destination")).not.toHaveTextContent("GitHub account:");
  });

  it("does not apply an old document's successful mutation to a new document", async () => {
    const mutation = deferred<GistAutoUpdateStatus>();
    vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(mutation.promise);
    const { rerender } = await mount();
    await consent();
    await click("Enable auto-update");
    rerender(<GistAutoUpdateControl doc={{ ...DOC, id: "another-doc" }} isOwner />);
    await settle();
    await act(async () => { mutation.resolve(PENDING); });
    expect(state()).toHaveTextContent("Off");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["status", "preview"] as const)("rejects a mismatched %s destination rather than offering opt-in", async (source) => {
    const destination = { ...DESTINATION, filename: "different.md" };
    if (source === "status") serverStatus = { ...PENDING, destination };
    else vi.mocked(api.documents.gistAutoUpdatePreview).mockResolvedValue({ destination });
    await mount();
    if (source === "preview") await click("Check linked gist");
    expect(state()).toHaveTextContent("Conflict");
    expect(screen.getByRole("alert")).toHaveTextContent("The linked gist changed.");
    expect(screen.getByRole("button", { name: "Enable auto-update" })).toBeDisabled();
    expect(api.documents.setGistAutoUpdate).not.toHaveBeenCalled();
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the timer on unmount and never keeps polling a closed dialog", async () => {
    const { unmount } = await mount();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(["status", "preview", "enable"] as const)("ignores an in-flight %s response after unmount", async (kind) => {
    const result = deferred<GistAutoUpdateStatus & { destination: GistAutoUpdateDestination }>();
    if (kind === "status") vi.mocked(api.documents.gistAutoUpdate).mockReturnValueOnce(result.promise);
    if (kind === "preview") vi.mocked(api.documents.gistAutoUpdatePreview).mockReturnValueOnce(result.promise);
    if (kind === "enable") vi.mocked(api.documents.setGistAutoUpdate).mockReturnValueOnce(result.promise);
    const { unmount } = await mount();
    if (kind === "preview") await click("Check linked gist");
    if (kind === "enable") {
      await consent();
      await click("Enable auto-update");
    }
    unmount();
    await act(async () => { result.resolve({ ...PENDING, destination: DESTINATION }); });
    expect(vi.getTimerCount()).toBe(0);
    await advance(20_000);
    expect(api.documents.gistAutoUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gist-auto-update")).toBeNull();
  });
});
