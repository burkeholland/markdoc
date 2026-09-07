// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CollabSession } from "@/editor/collab/session";
import type { VersionSummary } from "@/lib/api";

const versions = vi.fn();
const version = vi.fn();
const renameVersion = vi.fn();
const restoreVersion = vi.fn();
const copyVersion = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      versions: (...args: unknown[]) => versions(...args),
      version: (...args: unknown[]) => version(...args),
      renameVersion: (...args: unknown[]) => renameVersion(...args),
      restoreVersion: (...args: unknown[]) => restoreVersion(...args),
      copyVersion: (...args: unknown[]) => copyVersion(...args),
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

import { ApiError } from "@/lib/api";
import { VersionsPanel } from "./versions-panel";

const DOC_ID = "doc-1484";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(docId: string): CollabSession {
  return { docId, role: "owner" } as unknown as CollabSession;
}

function contentResult(summary: VersionSummary, content: string) {
  return { version: { ...summary, content } };
}

function versionItem(title: string): HTMLElement {
  const item = screen.getByText(title).closest<HTMLElement>('[data-testid="version-item"]');
  if (!item) throw new Error(`Missing version item for ${title}`);
  return item;
}

function spinnerFor(title: string): Element | null {
  return versionItem(title).querySelector(".animate-spin");
}

const named: VersionSummary = {
  id: "ver-1",
  number: 1,
  title: "Draft",
  kind: "named",
  createdBy: "user-alice",
  createdByName: "Alice",
  commitSha: null,
  createdAt: "2026-09-01T09:00:00.000Z",
  size: 12,
};

beforeEach(() => {
  versions.mockReset().mockResolvedValue({ versions: [named] });
  version.mockReset().mockResolvedValue({ version: { ...named, content: "# Draft" } });
  renameVersion.mockReset();
  restoreVersion.mockReset().mockResolvedValue({ ok: true });
  copyVersion.mockReset().mockResolvedValue({ id: "copy-1", title: "Copy" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VersionsPanel · rename a version", () => {
  it("shows the server's validation reason, not the bare 'Invalid request', when the title is rejected", async () => {
    renameVersion.mockRejectedValueOnce(new ApiError(400, "Invalid request", [{ path: ["title"], message: "Title must be 1–200 characters" }]));
    const session = { docId: DOC_ID, role: "owner" } as unknown as CollabSession;
    render(<VersionsPanel session={session} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);

    const [item] = await screen.findAllByTestId("version-item");
    fireEvent.click(within(item).getByText("Draft"));
    fireEvent.click(await screen.findByTestId("version-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: "Final" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Title must be 1–200 characters")).toBeInTheDocument();
    expect(screen.queryByText("Invalid request")).toBeNull();
    expect(renameVersion).toHaveBeenCalledWith(DOC_ID, "ver-1", "Final");
  });
});

describe("VersionsPanel · compare target", () => {
  it("keeps each compact checkbox inside a labelled 24px target that toggles the intended version", async () => {
    const older = { ...named, id: "ver-0", number: 0, title: "Earlier" };
    versions.mockResolvedValueOnce({ versions: [named, older] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: { ...(versionId === named.id ? named : older), content: versionId === named.id ? "# Draft" : "# Earlier" },
    }));
    const onPreview = vi.fn();
    const session = { docId: DOC_ID, role: "owner" } as unknown as CollabSession;
    render(<VersionsPanel session={session} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);

    const draft = await screen.findByRole("checkbox", { name: "Compare v1" });
    const earlier = await screen.findByRole("checkbox", { name: "Compare v0" });
    for (const checkbox of [draft, earlier]) {
      expect(checkbox).toHaveClass("h-3.5", "w-3.5");
      expect(checkbox.closest("label")).toHaveClass("h-6", "w-6");
    }

    fireEvent.click(draft.closest("label")!);
    expect(draft).toBeChecked();
    expect(earlier).not.toBeChecked();

    fireEvent.click(earlier.closest("label")!);
    expect(draft).toBeChecked();
    expect(earlier).toBeChecked();
    await waitFor(() =>
      expect(onPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          version: expect.objectContaining({ id: named.id }),
          base: expect.objectContaining({ version: expect.objectContaining({ id: older.id }) }),
        }),
      ),
    );
  });
});

describe("VersionsPanel · list recovery", () => {
  it("replaces an initial failure with an unfocused retry that makes one request and reaches the empty state", async () => {
    const retry = deferred<{ versions: VersionSummary[] }>();
    const onClose = vi.fn();
    versions.mockReset().mockRejectedValueOnce("offline").mockReturnValueOnce(retry.promise);

    render(<VersionsPanel session={session("versions-retry-empty")} onClose={onClose} onPreview={vi.fn()} refreshKey={0} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load versions");
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry" });
    expect(alert).not.toHaveFocus();
    expect(retryButton).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Close version history" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ versions: [] });
    expect(await screen.findByText("No versions yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(versions).toHaveBeenNthCalledWith(2, "versions-retry-empty");
  });

  it("keeps rows, selection, compare state and cached content through a refresh failure", async () => {
    const older = { ...named, id: "ver-0-recovery", number: 0, title: "Earlier" };
    const current = { ...named, id: "ver-1-recovery" };
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockRejectedValueOnce("refresh unavailable")
      .mockResolvedValueOnce({ versions: [current, older] });
    version.mockResolvedValue({ version: { ...current, content: "# Draft" } });
    const onPreview = vi.fn();
    const props = { session: session("versions-cached"), onClose: vi.fn(), onPreview };
    const rendered = render(<VersionsPanel {...props} refreshKey={0} />);

    const [item] = await screen.findAllByTestId("version-item");
    fireEvent.click(within(item).getByText("Draft"));
    await waitFor(() => expect(version).toHaveBeenCalledTimes(1));
    const compare = screen.getByRole("checkbox", { name: "Compare v1" });
    fireEvent.click(compare);
    expect(compare).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();

    rendered.rerender(<VersionsPanel {...props} refreshKey={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load versions");
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Earlier")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();

    fireEvent.click(within(screen.getAllByTestId("version-item")[0]).getByText("Draft"));
    fireEvent.click(within(screen.getAllByTestId("version-item")[0]).getByText("Draft"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ version: expect.objectContaining({ id: current.id }) })));
    expect(version).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    expect(versions).toHaveBeenCalledTimes(3);
  });

  it("ignores an older document response after the panel switches documents", async () => {
    const oldRequest = deferred<{ versions: VersionSummary[] }>();
    const newRequest = deferred<{ versions: VersionSummary[] }>();
    const oldVersion = { ...named, id: "old-version", title: "Old document version" };
    const newVersion = { ...named, id: "new-version", title: "New document version" };
    versions.mockReset().mockImplementation((docId: string) => (docId === "versions-old" ? oldRequest.promise : newRequest.promise));

    const rendered = render(<VersionsPanel session={session("versions-old")} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await waitFor(() => expect(versions).toHaveBeenCalledWith("versions-old"));
    rendered.rerender(<VersionsPanel session={session("versions-new")} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await waitFor(() => expect(versions).toHaveBeenCalledWith("versions-new"));

    newRequest.resolve({ versions: [newVersion] });
    expect(await screen.findByText("New document version")).toBeInTheDocument();
    oldRequest.resolve({ versions: [oldVersion] });
    await act(async () => {});
    expect(screen.getByText("New document version")).toBeInTheDocument();
    expect(screen.queryByText("Old document version")).toBeNull();
  });
});

describe("VersionsPanel · preview intent ownership", () => {
  it.each([
    ["older request settles first", "older-first"],
    ["newer request settles first", "newer-first"],
  ] as const)("keeps rapid A-then-B selection on B when the %s", async (_label, settlementOrder) => {
    const docId = `rapid-selection-${settlementOrder}`;
    const alpha = { ...named, id: `alpha-${settlementOrder}`, number: 1, title: "Alpha" };
    const beta = { ...named, id: `beta-${settlementOrder}`, number: 2, title: "Beta" };
    const alphaRequest = deferred<ReturnType<typeof contentResult>>();
    const betaRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [beta, alpha] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === alpha.id ? alphaRequest.promise : betaRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Beta"));

    expect(version).toHaveBeenNthCalledWith(1, docId, alpha.id);
    expect(version).toHaveBeenNthCalledWith(2, docId, beta.id);
    expect(spinnerFor("Alpha")).toBeNull();
    expect(spinnerFor("Beta")).not.toBeNull();

    if (settlementOrder === "older-first") {
      await act(async () => {
        alphaRequest.resolve(contentResult(alpha, "# Alpha"));
        await Promise.resolve();
      });
      expect(onPreview).not.toHaveBeenCalled();
      expect(spinnerFor("Beta")).not.toBeNull();
      await act(async () => {
        betaRequest.resolve(contentResult(beta, "# Beta"));
        await Promise.resolve();
      });
    } else {
      await act(async () => {
        betaRequest.resolve(contentResult(beta, "# Beta"));
        await Promise.resolve();
      });
      expect(onPreview).toHaveBeenCalledOnce();
      await act(async () => {
        alphaRequest.resolve(contentResult(alpha, "# Alpha"));
        await Promise.resolve();
      });
    }

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith({ version: beta, content: "# Beta" });
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();
  });

  it("lets a two-version comparison supersede a pending single-version preview", async () => {
    const docId = "single-to-comparison";
    const older = { ...named, id: "single-older", number: 1, title: "Comparison older" };
    const newer = { ...named, id: "single-newer", number: 2, title: "Comparison newer" };
    const olderRequest = deferred<ReturnType<typeof contentResult>>();
    const newerRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [newer, older] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === older.id ? olderRequest.promise : newerRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Comparison newer");
    fireEvent.click(screen.getByText("Comparison newer"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));

    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenCalledWith(docId, older.id);
    expect(version).toHaveBeenCalledWith(docId, newer.id);
    await act(async () => {
      newerRequest.resolve(contentResult(newer, "# Newer"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Comparison newer")).not.toBeNull();

    await act(async () => {
      olderRequest.resolve(contentResult(older, "# Older"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({
      version: newer,
      content: "# Newer",
      base: { version: older, content: "# Older" },
      range: [newer],
    });
  });

  it("keeps Clear authoritative over a pending comparison", async () => {
    const docId = "comparison-clear";
    const older = { ...named, id: "clear-older", number: 1, title: "Clear older" };
    const newer = { ...named, id: "clear-newer", number: 2, title: "Clear newer" };
    const olderRequest = deferred<ReturnType<typeof contentResult>>();
    const newerRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [newer, older] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === older.id ? olderRequest.promise : newerRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Clear older");
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    onPreview.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));
    expect(version).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull();

    await act(async () => {
      olderRequest.resolve(contentResult(older, "# Older"));
      newerRequest.reject(new Error("obsolete comparison"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("obsolete comparison")).toBeNull();
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("does not let a pending preview reopen after Close", async () => {
    const docId = "preview-close";
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "close-version", title: "Close pending" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onClose = vi.fn();
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Close pending");
    fireEvent.click(screen.getByText("Close pending"));
    expect(spinnerFor("Close pending")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(spinnerFor("Close pending")).toBeNull();
    await act(async () => {
      request.resolve(contentResult(current, "# Too late"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledOnce();
  });

  it("keeps Restore busy after the obsolete preview settles", async () => {
    const docId = "preview-restore";
    const previewRequest = deferred<ReturnType<typeof contentResult>>();
    const restoreRequest = deferred<{ ok: boolean }>();
    const current = { ...named, id: "restore-version", title: "Restore pending" };
    versions.mockResolvedValue({ versions: [current] });
    version.mockReturnValueOnce(previewRequest.promise);
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Restore pending");
    fireEvent.click(screen.getByText("Restore pending"));
    fireEvent.click(screen.getByTestId("version-restore"));

    expect(restoreVersion).toHaveBeenCalledWith(docId, current.id);
    expect(spinnerFor("Restore pending")).not.toBeNull();
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Obsolete"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Restore pending")).not.toBeNull();

    await act(async () => {
      restoreRequest.resolve({ ok: true });
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull());
  });

  it("keeps Copy busy when its version preview finishes first", async () => {
    const docId = "preview-copy";
    const previewRequest = deferred<ReturnType<typeof contentResult>>();
    const copyRequest = deferred<{ id: string; title: string }>();
    const current = { ...named, id: "copy-version", title: "Copy pending" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(previewRequest.promise);
    copyVersion.mockReturnValueOnce(copyRequest.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Copy pending");
    fireEvent.click(screen.getByText("Copy pending"));
    fireEvent.click(screen.getByTestId("version-copy"));

    expect(copyVersion).toHaveBeenCalledWith(docId, current.id);
    expect(spinnerFor("Copy pending")).not.toBeNull();
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Preview"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(spinnerFor("Copy pending")).not.toBeNull();

    await act(async () => {
      copyRequest.reject(new Error("copy failed"));
      await Promise.resolve();
    });
    expect(screen.getByText("copy failed")).toBeInTheDocument();
    expect(spinnerFor("Copy pending")).toBeNull();
  });

  it("coalesces concurrent reads of the same version", async () => {
    const docId = "preview-coalescing";
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "coalesced-version", title: "Coalesced" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Coalesced");
    fireEvent.click(screen.getByText("Coalesced"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));

    expect(version).toHaveBeenCalledOnce();
    expect(version).toHaveBeenCalledWith(docId, current.id);
    await act(async () => {
      request.resolve(contentResult(current, "# Shared"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Shared" });
  });

  it("retries once with a fresh request after the current content read fails", async () => {
    const docId = "preview-retry";
    const failedRequest = deferred<ReturnType<typeof contentResult>>();
    const retryRequest = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: "retry-version", title: "Retry content" };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(failedRequest.promise).mockReturnValueOnce(retryRequest.promise);
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Retry content");
    fireEvent.click(screen.getByText("Retry content"));
    await act(async () => {
      failedRequest.reject(new Error("offline"));
      await Promise.resolve();
    });
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(version).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    expect(screen.queryByText("offline")).toBeNull();
    expect(spinnerFor("Retry content")).not.toBeNull();
    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenNthCalledWith(2, docId, current.id);
    await act(async () => {
      retryRequest.resolve(contentResult(current, "# Recovered"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Recovered" });
    expect(version).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale failure without clearing the current preview spinner", async () => {
    const docId = "stale-preview-failure";
    const alpha = { ...named, id: "stale-alpha", number: 1, title: "Stale alpha" };
    const beta = { ...named, id: "stale-beta", number: 2, title: "Current beta" };
    const alphaRequest = deferred<ReturnType<typeof contentResult>>();
    const betaRequest = deferred<ReturnType<typeof contentResult>>();
    versions.mockResolvedValueOnce({ versions: [beta, alpha] });
    version.mockImplementation((_docId: string, versionId: string) => (versionId === alpha.id ? alphaRequest.promise : betaRequest.promise));
    const onPreview = vi.fn();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText("Stale alpha");
    fireEvent.click(screen.getByText("Stale alpha"));
    fireEvent.click(screen.getByText("Current beta"));
    await act(async () => {
      alphaRequest.reject(new Error("obsolete failure"));
      await Promise.resolve();
    });

    expect(screen.queryByText("obsolete failure")).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Current beta")).not.toBeNull();
    await act(async () => {
      betaRequest.resolve(contentResult(beta, "# Current"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith({ version: beta, content: "# Current" });
  });

  it.each(["resolve", "reject"] as const)("ignores a late content %s after unmount", async (settlement) => {
    const docId = `preview-unmount-${settlement}`;
    const request = deferred<ReturnType<typeof contentResult>>();
    const current = { ...named, id: `unmount-${settlement}`, title: `Unmount ${settlement}` };
    versions.mockResolvedValueOnce({ versions: [current] });
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();

    const rendered = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    await screen.findByText(`Unmount ${settlement}`);
    fireEvent.click(screen.getByText(`Unmount ${settlement}`));
    rendered.unmount();
    await act(async () => {
      if (settlement === "resolve") request.resolve(contentResult(current, "# Too late"));
      else request.reject(new Error("too late"));
      await Promise.resolve();
    });

    expect(onPreview).not.toHaveBeenCalled();
    expect(version).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("ignores an old document's late content %s after replacement", async (settlement) => {
    const oldDocId = `preview-old-${settlement}`;
    const newDocId = `preview-new-${settlement}`;
    const request = deferred<ReturnType<typeof contentResult>>();
    const oldVersion = { ...named, id: `old-content-${settlement}`, title: `Old content ${settlement}` };
    const newVersion = { ...named, id: `new-content-${settlement}`, title: `New content ${settlement}` };
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    version.mockReturnValueOnce(request.promise);
    const onPreview = vi.fn();
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    await screen.findByText(`Old content ${settlement}`);
    fireEvent.click(screen.getByText(`Old content ${settlement}`));
    rendered.rerender(<VersionsPanel {...props} session={session(newDocId)} />);
    expect(await screen.findByText(`New content ${settlement}`)).toBeInTheDocument();

    await act(async () => {
      if (settlement === "resolve") request.resolve(contentResult(oldVersion, "# Too late"));
      else request.reject(new Error("too late"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.queryByText("too late")).toBeNull();
    expect(screen.getByText(`New content ${settlement}`)).toBeInTheDocument();
    expect(version).toHaveBeenCalledWith(oldDocId, oldVersion.id);
  });
});
