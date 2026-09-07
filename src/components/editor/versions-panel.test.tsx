// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CollabSession } from "@/editor/collab/session";
import type { VersionSummary } from "@/lib/api";

const versions = vi.fn();
const version = vi.fn();
const renameVersion = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      versions: (...args: unknown[]) => versions(...args),
      version: (...args: unknown[]) => version(...args),
      renameVersion: (...args: unknown[]) => renameVersion(...args),
      restoreVersion: vi.fn(),
      copyVersion: vi.fn(),
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
});

afterEach(() => {
  cleanup();
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
