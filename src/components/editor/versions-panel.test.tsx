// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

    const item = await screen.findByTestId("version-item");
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
