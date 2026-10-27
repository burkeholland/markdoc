// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollabSession } from "@/editor/collab/session";
import type { VersionSummary } from "@/lib/api";

const versions = vi.fn();
const version = vi.fn();
const restoreVersion = vi.fn();
const copyVersion = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    documents: {
      versions: (...args: unknown[]) => versions(...args),
      version: (...args: unknown[]) => version(...args),
      renameVersion: vi.fn(),
      restoreVersion: (...args: unknown[]) => restoreVersion(...args),
      copyVersion: (...args: unknown[]) => copyVersion(...args),
    },
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
vi.mock("@/lib/notice", () => ({ setPendingNotice: vi.fn() }));

import { VersionDiffView, VersionsPanel } from "./versions-panel";

function row(id: string, number: number, title: string): VersionSummary {
  return {
    id,
    number,
    title,
    kind: "named",
    createdBy: "user-alice",
    createdByName: "Alice",
    commitSha: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    size: 12,
  };
}

function session(docId: string, current = ""): CollabSession {
  return {
    docId,
    role: "owner",
    version: 0,
    subscribe: () => () => {},
    ytext: { toString: () => current },
  } as unknown as CollabSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

let doc = 0;
function setup(rows: VersionSummary[]) {
  const docId = `real-input-${++doc}`;
  versions.mockResolvedValue({ versions: rows });
  const onClose = vi.fn();
  const onPreview = vi.fn();
  render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);
  return { docId, onClose, onPreview };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  versions.mockReset();
  version.mockReset().mockImplementation(async (_doc: string, id: string) => ({ version: { ...row(id, 1, id), content: `# ${id}` } }));
  restoreVersion.mockReset().mockResolvedValue({ ok: true });
  copyVersion.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VersionsPanel · real input", () => {
  it("opens a preview when a row is clicked", async () => {
    const { onPreview } = setup([row("a", 2, "Second"), row("b", 1, "First")]);
    await userEvent.click(await screen.findByText("Second"));
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ content: "# a" })));
  });

  it("closes through the toolbar and clears the preview", async () => {
    const { onClose, onPreview } = setup([row("a", 1, "Only")]);
    await screen.findByText("Only");
    await userEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus across toolbar buttons with arrow keys, Home and End", async () => {
    setup([row("a", 1, "Only")]);
    await screen.findByText("Only");
    const refresh = screen.getByRole("button", { name: "Refresh versions" });
    const close = screen.getByRole("button", { name: "Close version history" });
    refresh.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(close).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(refresh).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(close).toHaveFocus();
  });

  it("moves focus between version rows with ArrowDown/ArrowUp", async () => {
    setup([row("a", 2, "Second"), row("b", 1, "First")]);
    await screen.findByText("Second");
    const first = screen.getByText("Second").closest("button")!;
    const second = screen.getByText("First").closest("button")!;
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
  });

  it("issues one refresh request for a burst of clicks while one is in flight", async () => {
    setup([row("a", 1, "Only")]);
    await screen.findByText("Only");
    const pending = deferred<{ versions: VersionSummary[] }>();
    versions.mockReturnValueOnce(pending.promise);
    const refresh = screen.getByRole("button", { name: "Refresh versions" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(refresh).toBeDisabled();
    pending.resolve({ versions: [row("c", 2, "Fresh")] });
    expect(await screen.findByText("Fresh")).toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  it("restores a version after confirmation and ignores a second click while pending", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup([row("a", 1, "Only")]);
    await userEvent.click(await screen.findByText("Only"));
    const pending = deferred<{ ok: boolean }>();
    restoreVersion.mockReturnValueOnce(pending.promise);
    const restore = await screen.findByTestId("version-restore");
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(restoreVersion).toHaveBeenCalledOnce();
    pending.resolve({ ok: true });
  });
});

describe("VersionDiffView · real input", () => {
  const preview = {
    version: row("v", 7, "Diff fixture"),
    content: "first old\n\nshared one\n\nsecond old\n\nshared two\n\nthird old",
  };
  const current = "first new\n\nshared one\n\nsecond new\n\nshared two\n\nthird new";

  it("steps through changes with ] and [ and jumps with Home/End", async () => {
    render(<VersionDiffView session={session("diff", current)} preview={preview} />);
    const root = screen.getByTestId("version-diff");
    const counter = screen.getByTestId("diff-counter");
    const start = counter.textContent;
    root.focus();
    await userEvent.keyboard("]");
    expect(counter.textContent).not.toBe(start);
    await userEvent.keyboard("[[");
    expect(counter.textContent).toBe(start);
    await userEvent.keyboard("{End}");
    expect(screen.getByTestId("diff-next")).toBeDisabled();
    await userEvent.keyboard("{Home}");
    expect(screen.getByTestId("diff-prev")).toBeDisabled();
  });

  it("moves between header actions with arrow keys", async () => {
    const base = { version: row("base", 6, "Base"), content: current };
    render(<VersionDiffView session={session("diff", current)} preview={{ ...preview, base }} />);
    const swap = screen.getByTestId("diff-swap");
    swap.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByTestId("diff-next")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(swap).toHaveFocus();
  });
});
