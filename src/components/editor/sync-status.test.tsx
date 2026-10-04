// @vitest-environment jsdom
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import type { DocumentDto } from "@/server/dto";
import { api, ApiError, type SyncStatusDto } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { pollDocumentSync } from "./use-sync-polling";
import { PublishStatusButton } from "./header";
import { SyncDialog, type SyncActions } from "./sync-dialog";
import { SYNC_LABELS } from "./labels";

const REMOTE = {
  sha: "4ce1359b",
  revision: "4ce1359b",
  url: "https://github.com/o/r/blob/main/big.md",
  updatedAt: null,
};

const IN_SYNC: SyncStatusDto = {
  status: "in-sync",
  remote: REMOTE,
  localChanged: false,
  remoteChanged: false,
  lines: { local: 0, remote: 0 },
};

const unreadableError = () =>
  new ApiError(413, "The file on GitHub is 3.63 MB; Markdoc documents are limited to 2 MB", undefined, {
    status: "remote-unreadable",
    size: 3_800_000,
    limit: 2_097_152,
    remote: REMOTE,
  });

const DOC: DocumentDto = {
  id: "doc-1",
  title: "Oversized remote",
  storage: "repo",
  linkAccess: "private",
  linkPreview: false,
  ownerId: "owner-1",
  gistId: null,
  gistFile: null,
  repoOwner: "o",
  repoName: "r",
  repoBranch: "main",
  repoPath: "big.md",
  publishedAt: "2026-08-27T00:00:00.000Z",
  hasUnpublishedChanges: true,
  githubUrl: REMOTE.url,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const DIVERGED: SyncStatusDto = {
  ...IN_SYNC,
  status: "diverged",
  localChanged: true,
  remoteChanged: true,
  lines: { local: 2, remote: 3 },
};

const SECOND_DOC: DocumentDto = {
  ...DOC,
  id: "doc-2",
  title: "Second document",
  repoPath: "second.md",
  githubUrl: "https://github.com/o/r/blob/main/second.md",
};

const RENAMED_DOC: DocumentDto = {
  ...DOC,
  repoPath: "renamed.md",
  githubUrl: "https://github.com/o/r/blob/main/renamed.md",
};

const UPDATED_SYNC: SyncStatusDto = {
  ...DIVERGED,
  localChanged: false,
  lines: { local: 0, remote: 8 },
  remote: {
    ...REMOTE,
    sha: "987654321",
    revision: "987654321",
    updatedAt: "2026-09-07T20:00:00.000Z",
  },
};

const UNREADABLE_SYNC: SyncStatusDto = {
  ...IN_SYNC,
  status: "remote-unreadable",
  size: 3_800_000,
  limit: 2_097_152,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function syncActions(overrides: Partial<SyncActions> = {}): SyncActions {
  return {
    merge: vi.fn(async () => 0),
    keepMine: vi.fn(async () => undefined),
    takeRemote: vi.fn(async () => undefined),
    compare: vi.fn(),
    ...overrides,
  };
}

function statusSnapshot(
  status: SyncStatusDto["status"],
  overrides: Partial<SyncStatusDto> = {},
): SyncStatusDto {
  const base: SyncStatusDto = {
    status,
    remote: { ...REMOTE },
    localChanged: status === "local-ahead" || status === "diverged",
    remoteChanged: status === "remote-ahead" || status === "diverged" || status === "remote-unreadable",
    lines: {
      local: status === "local-ahead" || status === "diverged" ? 2 : 0,
      remote: status === "remote-ahead" || status === "diverged" || status === "remote-unreadable" ? 3 : 0,
    },
    pollMs: 2_000,
  };
  if (status === "remote-unreadable") {
    base.size = 3_800_000;
    base.limit = 2_097_152;
  }
  return { ...base, ...overrides };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ["without Strict Mode", false],
  ["in Strict Mode", true],
])("status chip %s", (_name, strict) => {
  type Props = ComponentProps<typeof PublishStatusButton>;
  type Action = "onPublishNow" | "onPull" | "onSync";

  function show(sync: SyncStatusDto, overrides: Partial<Props> = {}) {
    const props: Props = { sync, publishing: false, onPublishNow: vi.fn(), onPull: vi.fn(), onSync: vi.fn(), ...overrides };
    const view = render(<PublishStatusButton {...props} />, { wrapper: strict ? StrictMode : undefined });
    const update = (next: Partial<Props>) => {
      Object.assign(props, next);
      view.rerender(<PublishStatusButton {...props} />);
    };
    return { props, update };
  }
  const chip = () => screen.getByTestId("publish-button") as HTMLButtonElement;
  const placeHold = () => screen.queryByTestId("place-hold");
  /** A click as a pointer sends it: `detail` is the click count. A click from the keyboard has `detail` 0. */
  const pointerClick = (count = 1) => fireEvent.click(chip(), { detail: count });
  const keyboardClick = () => fireEvent.click(chip(), { detail: 0 });
  const expectCalls = (props: Props, counts: Partial<Record<Action, number>>) => {
    expect(props.onPublishNow).toHaveBeenCalledTimes(counts.onPublishNow ?? 0);
    expect(props.onPull).toHaveBeenCalledTimes(counts.onPull ?? 0);
    expect(props.onSync).toHaveBeenCalledTimes(counts.onSync ?? 0);
  };

  it.each([
    ["in-sync", "Up to date", "Up to date", "bg-emerald-300", "onPublishNow"],
    ["local-ahead", "Publish", "Unpublished changes", "bg-amber-300", "onPublishNow"],
    ["remote-ahead", "Pull", "GitHub has changes", "lucide-refresh-cw", "onPull"],
    ["diverged", "Both changed", "Both changed", "lucide-git-merge", "onSync"],
    ["remote-unreadable", "GitHub file too large", "GitHub file too large", "lucide-triangle-alert", "onSync"],
  ] as const)("%s: the chip says %s, its title is %s, and a press runs its one action", (status, label, title, iconClass, action) => {
    const { props } = show(statusSnapshot(status));
    expect(chip()).toHaveAttribute("type", "button");
    expect(chip()).toHaveAttribute("title", title);
    expect(chip()).toHaveTextContent(label);
    expect(chip()).toHaveAccessibleName(label);
    expect(chip()).not.toHaveAttribute("aria-disabled");
    expect(chip()).toBeEnabled();
    expect(screen.getByTestId("publish-status")).toHaveAttribute("data-status", status);
    expect(chip().firstElementChild).toHaveClass(iconClass);
    expect(chip().childElementCount).toBe(2);

    pointerClick();
    expectCalls(props, { [action]: 1 });
    keyboardClick();
    expectCalls(props, { [action]: 2 });
  });

  it("every press acts: presses in a row, with no new status in between, each run the action", () => {
    const { props } = show(statusSnapshot("diverged"));
    pointerClick();
    pointerClick();
    keyboardClick();
    keyboardClick();
    expectCalls(props, { onSync: 4 });
  });

  it("the second and the third click of a multi-click are not presses", () => {
    const { props } = show(statusSnapshot("remote-ahead"));
    pointerClick(2);
    pointerClick(3);
    expectCalls(props, {});
    pointerClick(1);
    pointerClick(2);
    pointerClick(3);
    expectCalls(props, { onPull: 1 });
  });

  it("while a publish or a pull runs the chip is aria-disabled, never disabled, keeps focus and its label, and a press does nothing; it acts again when the request has ended", () => {
    const { props, update } = show(statusSnapshot("remote-ahead"));
    chip().focus();
    update({ publishing: true });
    expect(chip()).toHaveAttribute("aria-disabled", "true");
    expect(chip()).toBeEnabled();
    expect(chip()).toHaveFocus();
    expect(chip()).toHaveTextContent("Pull");
    expect(chip()).toHaveAttribute("title", "GitHub has changes");
    expect(chip().firstElementChild).toHaveClass("animate-spin");

    pointerClick();
    keyboardClick();
    fireEvent.keyDown(chip(), { key: "Enter" });
    fireEvent.keyUp(chip(), { key: "Enter" });
    expectCalls(props, {});
    expect(placeHold()).toBeNull();

    update({ publishing: false });
    expect(chip()).not.toHaveAttribute("aria-disabled");
    expect(chip()).toHaveFocus();
    expect(chip().firstElementChild).toHaveClass("lucide-refresh-cw");
    keyboardClick();
    expectCalls(props, { onPull: 1 });
  });

  it("a press runs the action of the status on screen, with the newest callbacks: never the action of the status before", () => {
    const { props, update } = show(statusSnapshot("local-ahead"));
    const before = { ...props };
    const onPull = vi.fn();
    update({ sync: statusSnapshot("remote-ahead"), onPull });
    expect(chip()).toHaveTextContent("Pull");
    pointerClick();
    expect(onPull).toHaveBeenCalledOnce();
    expectCalls(before, {});

    const onSync = vi.fn();
    update({ sync: statusSnapshot("diverged"), onSync });
    expect(chip()).toHaveTextContent("Both changed");
    keyboardClick();
    expect(onSync).toHaveBeenCalledOnce();
    expect(onPull).toHaveBeenCalledOnce();
    expectCalls(before, {});
  });

  it("Enter acts when the key is released, once; a repeat, a release without a press, Enter with Ctrl and a press that lost focus do nothing", () => {
    const { props } = show(statusSnapshot("remote-ahead"));
    chip().focus();
    // The keydown is cancelled, so the browser does not click the button on it (nor on its repeats).
    expect(fireEvent.keyDown(chip(), { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(chip(), { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(chip(), { key: "Enter", repeat: true })).toBe(false);
    expectCalls(props, {});
    fireEvent.keyUp(chip(), { key: "Enter" });
    expectCalls(props, { onPull: 1 });

    // Repeats of a key that went down somewhere else, then its release here.
    fireEvent.keyDown(chip(), { key: "Enter", repeat: true });
    fireEvent.keyUp(chip(), { key: "Enter" });
    fireEvent.keyUp(chip(), { key: "Enter" });
    fireEvent.keyDown(chip(), { key: "Enter", ctrlKey: true });
    fireEvent.keyUp(chip(), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(chip(), { key: "Enter" });
    chip().blur();
    chip().focus();
    fireEvent.keyUp(chip(), { key: "Enter" });
    expectCalls(props, { onPull: 1 });

    // Space is the browser's own: it clicks a button on release, and the chip leaves the key alone.
    expect(fireEvent.keyDown(chip(), { key: " " })).toBe(true);
    expect(fireEvent.keyUp(chip(), { key: " " })).toBe(true);
    expectCalls(props, { onPull: 1 });
  });

  it("a pointer click that acts keeps the chip's place for the rest of the gesture: the box goes 600 ms later, and at once when focus is back on the chip", () => {
    vi.useFakeTimers();
    const { props } = show(statusSnapshot("diverged"));
    expect(placeHold()).toBeNull();
    pointerClick();
    expect(placeHold()).not.toBeNull();
    expect(placeHold()).toHaveAttribute("aria-hidden", "true");
    act(() => void vi.advanceTimersByTime(599));
    expect(placeHold()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(placeHold()).toBeNull();

    // The dialog the press opened has closed and handed focus back: the chip is there again.
    pointerClick();
    expect(placeHold()).not.toBeNull();
    act(() => chip().focus());
    expect(placeHold()).toBeNull();
    expectCalls(props, { onSync: 2 });
  });

  it("nothing but a pointer click that acts keeps the place: not a key, not the rest of a multi-click, not a press on a chip that is off, not a new status", () => {
    const { props, update } = show(statusSnapshot("diverged"));
    keyboardClick();
    expect(placeHold()).toBeNull();
    chip().focus();
    fireEvent.keyDown(chip(), { key: "Enter" });
    fireEvent.keyUp(chip(), { key: "Enter" });
    expect(placeHold()).toBeNull();
    pointerClick(2);
    expect(placeHold()).toBeNull();
    update({ sync: statusSnapshot("remote-ahead") });
    expect(placeHold()).toBeNull();
    update({ publishing: true });
    pointerClick();
    expect(placeHold()).toBeNull();
    expectCalls(props, { onSync: 2 });
  });

  describe("taking the place of the Publish button", () => {
    /** The header's slot: the plain Publish button until the first status arrives, the chip from then on. */
    function Slot({ sync }: { sync: SyncStatusDto | null }) {
      return (
        <div>
          <input data-testid="title" />
          <div role="menu">
            <button type="button" role="menuitem" data-testid="menu-entry">Commit to GitHub…</button>
          </div>
          {sync ? (
            <PublishStatusButton sync={sync} publishing={false} onPublishNow={vi.fn()} onPull={vi.fn()} onSync={vi.fn()} />
          ) : (
            <button type="button" data-testid="publish-button">Publish</button>
          )}
        </div>
      );
    }
    const swap = (focus: string | null) => {
      const view = render(<Slot sync={null} />, { wrapper: strict ? StrictMode : undefined });
      if (focus) screen.getByTestId(focus).focus();
      const plain = chip();
      view.rerender(<Slot sync={statusSnapshot("remote-ahead")} />);
      expect(chip()).not.toBe(plain);
      expect(chip()).toHaveTextContent("Pull");
    };

    it("focus on the Publish button goes to the chip, not to the page", () => {
      swap("publish-button");
      expect(chip()).toHaveFocus();
    });

    it.each([
      ["the title field", "title"],
      ["an entry of the open Publish menu", "menu-entry"],
    ])("focus on %s stays where it is", (_where, testId) => {
      swap(testId);
      expect(screen.getByTestId(testId)).toHaveFocus();
    });

    it("focus on the page stays on the page", () => {
      swap(null);
      expect(document.body).toHaveFocus();
    });
  });
});

describe("remote-unreadable sync status", () => {
  it("turns the first 413 poll into a labeled status chip that opens Sync", async () => {
    vi.spyOn(api.documents, "sync").mockRejectedValue(unreadableError());
    const sync = await pollDocumentSync(DOC.id, false);
    const onSync = vi.fn();
    const onPublishNow = vi.fn();

    render(<PublishStatusButton sync={sync} publishing={false} onPublishNow={onPublishNow} onPull={vi.fn()} onSync={onSync} />);

    const chip = screen.getByTestId("publish-status");
    expect(chip).toHaveAttribute("data-status", "remote-unreadable");
    expect(chip).toHaveTextContent(SYNC_LABELS["remote-unreadable"]);
    expect(chip).not.toHaveTextContent("Up to date");
    expect(chip).not.toHaveTextContent(/^Publish$/);
    expect(screen.getByTestId("publish-button")).toHaveAttribute("title", "GitHub file too large");
    expect(api.documents.sync).toHaveBeenCalledWith(DOC.id, { fresh: false });

    fireEvent.click(screen.getByTestId("publish-button"));
    expect(onSync).toHaveBeenCalledOnce();
    expect(onPublishNow).not.toHaveBeenCalled();
  });

  it("replaces an in-sync result with remote-unreadable on the next poll", async () => {
    vi.spyOn(api.documents, "sync").mockResolvedValueOnce(IN_SYNC).mockRejectedValueOnce(unreadableError());

    expect((await pollDocumentSync(DOC.id, false)).status).toBe("in-sync");
    expect((await pollDocumentSync(DOC.id, false)).status).toBe("remote-unreadable");
  });

  it("keeps the 413 body's pollMs, so the header polls again at SYNC_POLL_MS rather than in a minute", async () => {
    const error = unreadableError();
    error.body = { ...error.body, pollMs: 2000 };
    vi.spyOn(api.documents, "sync").mockRejectedValue(error);

    const sync = await pollDocumentSync(DOC.id, false);
    expect(sync.status).toBe("remote-unreadable");
    expect(sync.pollMs).toBe(2000);
    expect(sync.size).toBe(3_800_000);
  });

  it("explains the size limit and leaves only force-publish available", () => {
    const actions: SyncActions = {
      merge: vi.fn(),
      keepMine: vi.fn(),
      takeRemote: vi.fn(),
      compare: vi.fn(),
    };
    const sync: SyncStatusDto = {
      ...IN_SYNC,
      status: "remote-unreadable",
      size: 3_800_000,
      limit: 2_097_152,
    };

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={sync} actions={actions} />);

    expect(screen.getByTestId("sync-remote-unreadable")).toHaveTextContent("3.63 MB");
    expect(screen.getByTestId("sync-remote-unreadable")).toHaveTextContent("2 MB");
    expect(screen.getByTestId("sync-keep-mine")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-merge")).toBeNull();
    expect(screen.queryByTestId("sync-take-remote")).toBeNull();
    expect(screen.queryByTestId("sync-compare")).toBeNull();
  });
});

describe("Sync dialog metadata titles", () => {
  const publishedAt = "2026-09-12T08:15:00.000Z";
  const updatedAt = "2026-09-13T09:30:00.000Z";
  const sha = "4ce1359b0123456789abcdef0123456789abcdef";
  const doc = { ...DOC, publishedAt };
  const sync: SyncStatusDto = {
    ...DIVERGED,
    remote: { ...REMOTE, sha, updatedAt },
  };

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-13T12:00:00.000Z").getTime());
  });

  function metadataRows() {
    const local = screen.getByTestId("sync-local-lines").nextElementSibling;
    const remote = screen.getByTestId("sync-remote-lines").nextElementSibling;
    if (!(local instanceof HTMLDivElement) || !(remote instanceof HTMLDivElement)) {
      throw new Error("Sync metadata must remain on the existing summary divs");
    }
    return { local, remote };
  }

  it.each([
    { name: "both timestamps, with timestamp taking precedence over SHA", localTime: publishedAt, remoteTime: updatedAt, remoteSha: sha },
    { name: "no local time and the complete 40-character SHA", localTime: null, remoteTime: null, remoteSha: sha },
    { name: "remote timestamp without a SHA", localTime: publishedAt, remoteTime: updatedAt, remoteSha: null },
    { name: "no metadata", localTime: null, remoteTime: null, remoteSha: null },
    { name: "empty metadata", localTime: "", remoteTime: "", remoteSha: "" },
  ])("preserves visible labels and exposes $name", ({ localTime, remoteTime, remoteSha }) => {
    render(
      <SyncDialog
        open
        onOpenChange={vi.fn()}
        doc={{ ...doc, publishedAt: localTime }}
        sync={{ ...sync, remote: { ...sync.remote, updatedAt: remoteTime, sha: remoteSha } }}
        actions={syncActions()}
      />,
    );
    const { local, remote } = metadataRows();

    expect(local.textContent).toBe(`since ${localTime ? relativeTime(localTime) : "the last sync"}`);
    expect(local.getAttribute("title")).toBe(localTime ? formatDateTime(localTime) : null);
    expect(remote.textContent).toBe(remoteTime ? `updated ${relativeTime(remoteTime)}` : remoteSha ? `at ${remoteSha.slice(0, 7)}` : "\u00a0");
    expect(remote.getAttribute("title")).toBe(remoteTime ? formatDateTime(remoteTime) : remoteSha || null);
    if (remoteSha && !remoteTime) expect(remote.title).toHaveLength(40);
    expect(local.className).toBe("text-xs text-ink-3");
    expect(remote.className).toBe("truncate text-xs text-ink-3");
    expect(local).not.toHaveAttribute("tabindex");
    expect(remote).not.toHaveAttribute("tabindex");
  });

  it.each(["metadata", "document"] as const)("replaces and removes stale titles after %s replacement", (replacement) => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    const view = render(<SyncDialog open onOpenChange={onOpenChange} doc={doc} sync={sync} actions={actions} />);
    const original = metadataRows();
    expect(original.local).toHaveAttribute("title", formatDateTime(publishedAt));
    expect(original.remote).toHaveAttribute("title", formatDateTime(updatedAt));

    const nextDoc = {
      ...(replacement === "document" ? SECOND_DOC : doc),
      publishedAt: "2026-09-10T06:45:00.000Z",
    };
    const nextTime = "2026-09-11T07:00:00.000Z";
    const nextSync = { ...sync, remote: { ...sync.remote, updatedAt: nextTime } };
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={nextDoc} sync={nextSync} actions={actions} />);
    const next = metadataRows();
    expect(next.local).toBe(original.local);
    expect(next.remote).toBe(original.remote);
    expect(next.local).toHaveAttribute("title", formatDateTime(nextDoc.publishedAt));
    expect(next.remote).toHaveAttribute("title", formatDateTime(nextTime));
    expect(next.local.textContent).toBe(`since ${relativeTime(nextDoc.publishedAt)}`);
    expect(next.remote.textContent).toBe(`updated ${relativeTime(nextTime)}`);
    expect(screen.queryByTitle(formatDateTime(publishedAt))).toBeNull();
    expect(screen.queryByTitle(formatDateTime(updatedAt))).toBeNull();

    const noLocalTime = { ...nextDoc, publishedAt: null };
    const shaOnly = { ...nextSync, remote: { ...nextSync.remote, updatedAt: null } };
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={noLocalTime} sync={shaOnly} actions={actions} />);
    expect(metadataRows().local).not.toHaveAttribute("title");
    expect(metadataRows().local.textContent).toBe("since the last sync");
    expect(metadataRows().remote).toHaveAttribute("title", sha);
    expect(metadataRows().remote.textContent).toBe(`at ${sha.slice(0, 7)}`);

    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={noLocalTime} sync={null} actions={actions} />);
    expect(metadataRows().local).not.toHaveAttribute("title");
    expect(metadataRows().remote).not.toHaveAttribute("title");
    expect(metadataRows().remote.textContent).toBe("\u00a0");
    expect(screen.getByTestId("sync-dialog").querySelectorAll("[title]")).toHaveLength(0);
  });

  it("keeps the summary, descriptions and controls unchanged, with inert hover and one accepted action", async () => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    render(<SyncDialog open onOpenChange={onOpenChange} doc={doc} sync={sync} actions={actions} />);
    const { local, remote } = metadataRows();
    const summary = local.parentElement?.parentElement;
    expect(summary?.className).toBe("grid grid-cols-2 gap-3 text-sm");
    expect(summary?.children).toHaveLength(2);
    expect(summary?.children[0]).toBe(local.parentElement);
    expect(summary?.children[1]).toBe(remote.parentElement);
    expect(summary?.querySelectorAll("div")).toHaveLength(8);
    expect(screen.getByText("This document")).toBeInTheDocument();
    expect(screen.getByText("On GitHub")).toBeInTheDocument();
    expect(screen.getByTestId("sync-local-lines").textContent).toBe("2 lines changed");
    expect(screen.getByTestId("sync-remote-lines").textContent).toBe("3 lines changed");
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Sync with GitHub");
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("This document and o/r (main) both changed since they were last in sync.");
    expect(screen.getByTestId("sync-merge")).toHaveAccessibleName("MergeCombine both sets of edits; conflicting lines are marked for you to resolve.");
    expect(screen.getByTestId("sync-keep-mine")).toHaveAccessibleName("Keep mineForce-publish this document over the GitHub file.");
    expect(screen.getByTestId("sync-take-remote")).toHaveAccessibleName("Take GitHubForce-pull; your local edits are kept in version history.");
    expect(screen.getByTestId("sync-compare")).toHaveAccessibleName("Compare GitHub with this document");
    const root = screen.getByTestId("sync-dialog");
    const controls = [...root.querySelectorAll("button")];
    expect(controls.map((control) => control.dataset.testid)).toEqual([
      "sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare",
    ]);
    expect(controls.every((control) => !control.disabled && control.tabIndex === 0)).toBe(true);
    expect(root.querySelectorAll("button, input, a[href], [tabindex]")).toHaveLength(5);
    const keep = screen.getByTestId("sync-keep-mine");
    keep.focus();
    const markup = document.body.innerHTML;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected request during Sync metadata hover");
    });
    const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {
      throw new Error("Unexpected XHR during Sync metadata hover");
    });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const animation = vi.spyOn(window, "requestAnimationFrame");
    try {
      for (const row of [local, remote]) {
        fireEvent.pointerOver(row);
        fireEvent.pointerEnter(row);
        fireEvent.mouseOver(row);
        fireEvent.mouseEnter(row);
        fireEvent.mouseLeave(row);
        fireEvent.mouseOut(row);
        fireEvent.pointerLeave(row);
        fireEvent.pointerOut(row);
      }
      expect(document.body.innerHTML).toBe(markup);
      expect(keep).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(animation).not.toHaveBeenCalled();
      expect(actions.merge).not.toHaveBeenCalled();
      expect(actions.keepMine).not.toHaveBeenCalled();
      expect(actions.takeRemote).not.toHaveBeenCalled();
      expect(actions.compare).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
      fetch.mockRestore();
      send.mockRestore();
      timeout.mockRestore();
      interval.mockRestore();
      animation.mockRestore();
    }

    await act(async () => {
      fireEvent.click(keep);
      fireEvent.click(keep);
    });
    expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update big.md");
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not add metadata to the remote-unreadable branch", () => {
    render(
      <SyncDialog
        open
        onOpenChange={vi.fn()}
        doc={doc}
        sync={{ ...UNREADABLE_SYNC, remote: sync.remote }}
        actions={syncActions()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("The file in o/r (main) cannot be read until it is made smaller or replaced.");
    expect(screen.getByTestId("sync-remote-unreadable")).toHaveTextContent("The GitHub file is 3.63 MB, but Markdoc can read files up to 2 MB.");
    expect(screen.queryByTestId("sync-local-lines")).toBeNull();
    expect(screen.queryByTestId("sync-remote-lines")).toBeNull();
    expect(screen.getByTestId("sync-dialog").querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.getByTestId("sync-keep-mine")).toBeEnabled();
    expect(screen.queryByTestId("sync-merge")).toBeNull();
    expect(screen.queryByTestId("sync-take-remote")).toBeNull();
    expect(screen.queryByTestId("sync-compare")).toBeNull();
  });
});

describe("Sync dialog result wrapping", () => {
  const longErrors = [
    { name: "unbroken", text: "GitHubSyncFailure".repeat(20) },
    { name: "ordinary", text: "GitHub could not accept these changes; your local edits are still available. ".repeat(4) },
    { name: "literal markup", text: '<a href="https://example.com">Retry & keep "my" edits</a><img src=x><script>unexpected()</script>'.repeat(3) },
  ];
  const gistDoc: DocumentDto = {
    ...DOC,
    storage: "gist",
    gistId: "gist-1",
    gistFile: "big.md",
    repoOwner: null,
    repoName: null,
    repoBranch: null,
    repoPath: null,
    githubUrl: "https://gist.github.com/o/gist-1",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  function expectResultRow(row: HTMLElement, text: string, outcome: "error" | "done") {
    const root = screen.getByTestId("sync-dialog");
    const icon = row.firstChild;
    expect(row.tagName).toBe("DIV");
    expect(row.parentElement).toBe(root);
    expect(root.lastElementChild).toBe(row);
    expect(row.previousElementSibling).toBe(screen.getByTestId("commit-message").parentElement);
    expect(row.textContent).toBe(` ${text}`);
    expect(row.childNodes).toHaveLength(3);
    expect([...row.childNodes].map((node) => [node.nodeType, node.nodeValue])).toEqual([
      [Node.ELEMENT_NODE, null],
      [Node.TEXT_NODE, " "],
      [Node.TEXT_NODE, text],
    ]);
    expect(row.children).toHaveLength(1);
    expect(icon).toBe(row.firstElementChild);
    expect(icon).toHaveAttribute("width", "14");
    expect(icon).toHaveAttribute("height", "14");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("shrink-0");
    expect(row.firstElementChild?.tagName).toBe("svg");
    expect(row).toHaveClass("flex", "items-center", "gap-2", "rounded-lg", "px-3", "py-2", "text-sm", "wrap-anywhere");
    if (outcome === "error") {
      expect(row).toHaveAttribute("role", "alert");
      expect(row).not.toHaveAttribute("data-testid");
      expect(row).toHaveClass("bg-red-50", "text-danger", "dark:bg-red-950/40");
    } else {
      expect(row).toHaveAttribute("data-testid", "sync-done");
      expect(row).not.toHaveAttribute("role");
      expect(row).toHaveClass("bg-surface-2", "text-ink-2");
      expect(icon).toHaveClass("text-success");
    }
    expect(row).not.toHaveAttribute("tabindex");
    expect(row).not.toHaveAttribute("title");
    expect(row.querySelectorAll("button, input, a, img, script, [tabindex], [contenteditable], [title]")).toHaveLength(0);
    expect(root.querySelectorAll("button, input, a[href], [tabindex]")).toHaveLength(5);
  }

  function expectPassiveResult(row: HTMLElement, actions: SyncActions, onOpenChange: Mock) {
    const input = screen.getByTestId("commit-message");
    input.focus();
    const markup = document.body.innerHTML;
    const actionCounts = [actions.merge, actions.keepMine, actions.takeRemote, actions.compare]
      .map((action) => vi.mocked(action).mock.calls.length);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected request during Sync result hover");
    });
    const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => {
      throw new Error("Unexpected XHR during Sync result hover");
    });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const animation = vi.spyOn(window, "requestAnimationFrame");
    try {
      for (const target of [row, row.firstElementChild!]) {
        fireEvent.pointerOver(target);
        fireEvent.pointerEnter(target);
        fireEvent.mouseOver(target);
        fireEvent.mouseEnter(target);
        fireEvent.mouseLeave(target);
        fireEvent.mouseOut(target);
        fireEvent.pointerLeave(target);
        fireEvent.pointerOut(target);
      }
      expect(document.body.innerHTML).toBe(markup);
      expect(input).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(animation).not.toHaveBeenCalled();
      expect([actions.merge, actions.keepMine, actions.takeRemote, actions.compare]
        .map((action) => vi.mocked(action).mock.calls.length)).toEqual(actionCounts);
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      // Clear retained spy restorers before teardown switches off fake timers.
      vi.restoreAllMocks();
    }
  }

  describe.each([
    { storage: "repo", doc: DOC },
    { storage: "gist", doc: gistDoc },
  ])("$storage results", ({ doc }) => {
    it.each(longErrors)("keeps a long $name error literal beside its icon and allows one retry", async ({ name, text }) => {
      expect(text.length).toBeGreaterThanOrEqual(240);
      const failure = name === "literal markup"
        ? new ApiError(400, "Validation failed", [{ message: text }])
        : name === "ordinary" ? new ApiError(409, text) : new Error(text);
      const merge = vi.fn<SyncActions["merge"]>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(0);
      const actions = syncActions({ merge });
      const onOpenChange = vi.fn();
      render(<SyncDialog open onOpenChange={onOpenChange} doc={doc} sync={DIVERGED} actions={actions} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync-merge"));
      });
      const row = screen.getByRole("alert");
      expectResultRow(row, text, "error");
      expectPassiveResult(row, actions, onOpenChange);
      expect(merge).toHaveBeenCalledExactlyOnceWith();
      expect(screen.getByTestId("commit-message")).toHaveValue("Update big.md");
      for (const id of ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"]) {
        expect(screen.getByTestId(id)).toBeEnabled();
      }

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync-merge"));
        fireEvent.click(screen.getByTestId("sync-merge"));
      });
      expect(merge).toHaveBeenCalledTimes(2);
      expect(actions.keepMine).not.toHaveBeenCalled();
      expect(actions.takeRemote).not.toHaveBeenCalled();
      expect(actions.compare).not.toHaveBeenCalled();
      expect(row).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expectResultRow(screen.getByTestId("sync-done"), "Merged — review, then publish", "done");
    });

    it.each([
      { name: "clean merge", action: "merge", testId: "sync-merge", conflicts: 0, text: "Merged — review, then publish" },
      { name: "one conflict", action: "merge", testId: "sync-merge", conflicts: 1, text: "1 conflict to resolve in the editor" },
      { name: "multiple conflicts", action: "merge", testId: "sync-merge", conflicts: 2, text: "2 conflicts to resolve in the editor" },
      { name: "Keep mine", action: "keepMine", testId: "sync-keep-mine", conflicts: 0, text: "Published your version" },
      { name: "Take GitHub", action: "takeRemote", testId: "sync-take-remote", conflicts: 0, text: "Replaced with GitHub's copy" },
    ] as const)("preserves the supported $name outcome, icon and close delay", async ({ action, testId, conflicts, text }) => {
      const actions = syncActions({ merge: vi.fn(async () => conflicts) });
      const onOpenChange = vi.fn();
      render(<SyncDialog open onOpenChange={onOpenChange} doc={doc} sync={DIVERGED} actions={actions} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId(testId));
        fireEvent.click(screen.getByTestId(testId));
      });
      expectResultRow(screen.getByTestId("sync-done"), text, "done");
      expect(screen.queryByRole("alert")).toBeNull();
      for (const kind of ["merge", "keepMine", "takeRemote", "compare"] as const) {
        expect(actions[kind]).toHaveBeenCalledTimes(kind === action ? 1 : 0);
      }
      if (action === "keepMine") expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update big.md");
      else expect(actions[action]).toHaveBeenCalledExactlyOnceWith();
      // Off, but never `disabled`: a disabled button would drop the focus it holds.
      for (const id of ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"]) {
        expect(screen.getByTestId(id)).toHaveAttribute("aria-disabled", "true");
        expect(screen.getByTestId(id)).toBeEnabled();
      }
      expectPassiveResult(screen.getByTestId("sync-done"), actions, onOpenChange);
      act(() => vi.advanceTimersByTime(899));
      expect(onOpenChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    });

    it.each([
      { transition: "reopen", outcome: "error" },
      { transition: "reopen", outcome: "done" },
      { transition: "document switch", outcome: "error" },
      { transition: "document switch", outcome: "done" },
    ] as const)("removes a settled $outcome on $transition and starts the next visit clean", async ({ transition, outcome }) => {
      const actions = syncActions({
        merge: outcome === "error"
          ? vi.fn<SyncActions["merge"]>().mockRejectedValue(new ApiError(409, longErrors[0].text))
          : vi.fn(async () => 2),
      });
      const onOpenChange = vi.fn();
      const props = { open: true, onOpenChange, doc, sync: DIVERGED, actions };
      const view = render(<SyncDialog {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync-merge"));
      });
      const row = outcome === "error" ? screen.getByRole("alert") : screen.getByTestId("sync-done");
      expectResultRow(row, outcome === "error" ? longErrors[0].text : "2 conflicts to resolve in the editor", outcome);
      const nextProps = {
        ...props,
        doc: transition === "document switch" ? { ...doc, id: "next-doc", title: "Next document" } : doc,
      };
      if (transition === "reopen") view.rerender(<SyncDialog {...props} open={false} />);
      view.rerender(<SyncDialog {...nextProps} />);
      expect(row).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("sync-done")).toBeNull();
      expect(actions.merge).toHaveBeenCalledOnce();
      expect(actions.keepMine).not.toHaveBeenCalled();
      expect(actions.takeRemote).not.toHaveBeenCalled();
      expect(actions.compare).not.toHaveBeenCalled();
      // The old visit's delayed close went with it.
      act(() => vi.advanceTimersByTime(900));
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync-keep-mine"));
        fireEvent.click(screen.getByTestId("sync-keep-mine"));
      });
      expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update big.md");
      expect(actions.merge).toHaveBeenCalledOnce();
      expect(actions.takeRemote).not.toHaveBeenCalled();
      expect(actions.compare).not.toHaveBeenCalled();
      expectResultRow(screen.getByTestId("sync-done"), "Published your version", "done");
    });
  });

  it("emits inherited anywhere wrapping and nonshrinking icons from installed Tailwind", async () => {
    const { build } = await compile("@tailwind utilities;");
    const css = build(["wrap-anywhere", "shrink-0"]);
    expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
    expect(css).toMatch(/\.shrink-0\s*\{\s*flex-shrink:\s*0;\s*\}/);
    expect(css).not.toMatch(/word-break:|white-space:|text-overflow:|overflow:\s*(hidden|auto|scroll)/);
  });
});

describe.each([
  ["without Strict Mode", false],
  ["in Strict Mode", true],
])("Sync dialog %s", (_name, strict) => {
  type Props = ComponentProps<typeof SyncDialog>;

  function open(overrides: Partial<Props> = {}) {
    const actions = syncActions();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const props: Props = { open: true, onOpenChange, doc: DOC, sync: DIVERGED, actions, ...overrides };
    const view = render(<SyncDialog {...props} />, { wrapper: strict ? StrictMode : undefined });
    const update = (next: Partial<Props>) => {
      Object.assign(props, next);
      view.rerender(<SyncDialog {...props} />);
    };
    return { actions: props.actions, onOpenChange: props.onOpenChange as typeof onOpenChange, update, view };
  }
  const choice = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
  const field = () => screen.getByTestId("commit-message") as HTMLInputElement;
  const CHOICES = ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"] as const;
  const settle = async (run: () => void) => {
    await act(async () => {
      run();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const expectNothingStarted = (actions: SyncActions) => {
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
  };

  it.each([
    ["sync-merge", "merge", "Merged — review, then publish"],
    ["sync-keep-mine", "keepMine", "Published your version"],
    ["sync-take-remote", "takeRemote", "Replaced with GitHub's copy"],
  ] as const)("%s runs its action once, shows the result and closes 900 ms later", async (testId, action, note) => {
    vi.useFakeTimers();
    const { actions, onOpenChange } = open();
    await settle(() => fireEvent.click(choice(testId)));
    expect(actions[action]).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sync-done")).toHaveTextContent(note);
    // The result is the end of this visit: every choice is off and pressing one starts nothing.
    for (const other of CHOICES) {
      expect(choice(other)).toHaveAttribute("aria-disabled", "true");
      expect(choice(other)).not.toBeDisabled();
      fireEvent.click(choice(other));
    }
    act(() => void vi.advanceTimersByTime(899));
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(actions.merge).toHaveBeenCalledTimes(action === "merge" ? 1 : 0);
    expect(actions.keepMine).toHaveBeenCalledTimes(action === "keepMine" ? 1 : 0);
    expect(actions.takeRemote).toHaveBeenCalledTimes(action === "takeRemote" ? 1 : 0);
    expect(actions.compare).not.toHaveBeenCalled();
  });

  it("Merge reports how many conflicts are left", async () => {
    open({ actions: syncActions({ merge: vi.fn(async () => 1) }) });
    await settle(() => fireEvent.click(choice("sync-merge")));
    expect(screen.getByTestId("sync-done")).toHaveTextContent("1 conflict to resolve in the editor");
    cleanup();
    open({ actions: syncActions({ merge: vi.fn(async () => 3) }) });
    await settle(() => fireEvent.click(choice("sync-merge")));
    expect(screen.getByTestId("sync-done")).toHaveTextContent("3 conflicts to resolve in the editor");
  });

  it("the message field takes typing and Keep mine sends what it shows, trimmed", async () => {
    const { actions } = open();
    expect(field()).toHaveValue("Update big.md");
    fireEvent.change(field(), { target: { value: "  Mine wins  " } });
    expect(field()).toHaveValue("  Mine wins  ");
    await settle(() => fireEvent.click(choice("sync-keep-mine")));
    expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Mine wins");
  });

  it("while an action runs every choice is aria-disabled, never disabled, the pressed one keeps focus and other presses start nothing", async () => {
    const pending = deferred<number>();
    const { actions, onOpenChange } = open({ actions: syncActions({ merge: vi.fn(() => pending.promise) }) });
    choice("sync-merge").focus();
    fireEvent.click(choice("sync-merge"));
    for (const testId of CHOICES) {
      expect(choice(testId)).toHaveAttribute("aria-disabled", "true");
      expect(choice(testId)).not.toBeDisabled();
    }
    expect(choice("sync-merge")).toHaveFocus();
    expect(choice("sync-merge").querySelector(".animate-spin")).not.toBeNull();
    for (const testId of CHOICES) fireEvent.click(choice(testId));
    expect(actions.merge).toHaveBeenCalledOnce();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    // The field still takes typing while the request runs.
    fireEvent.change(field(), { target: { value: "typed while busy" } });
    expect(field()).toHaveValue("typed while busy");
    await settle(() => pending.resolve(0));
  });

  it("a failure is shown, stays during the retry, and goes when the retry succeeds; the choices are on again in between", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const takeRemote = vi.fn<() => Promise<void>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    open({ actions: syncActions({ takeRemote }) });
    fireEvent.click(choice("sync-take-remote"));
    await settle(() => first.reject(new ApiError(502, "GitHub is unavailable")));
    const dialog = screen.getByTestId("sync-dialog");
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("GitHub is unavailable");
    // The last thing in the dialog, so its height cannot push a choice.
    expect(alert.nextElementSibling).toBeNull();
    for (const testId of CHOICES) expect(choice(testId)).not.toHaveAttribute("aria-disabled");

    fireEvent.click(choice("sync-take-remote"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("GitHub is unavailable");
    await settle(() => second.resolve());
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Replaced with GitHub's copy");
    expect(takeRemote).toHaveBeenCalledTimes(2);
  });

  it("a failure without a reason falls back to Sync failed", async () => {
    open({ actions: syncActions({ merge: vi.fn(() => Promise.reject({})) }) });
    await settle(() => fireEvent.click(choice("sync-merge")));
    expect(within(screen.getByTestId("sync-dialog")).getByRole("alert")).toHaveTextContent("Sync failed");
  });

  it("the second click of a double-click starts nothing on any choice, also when the first one has already failed", async () => {
    const actions = syncActions({ merge: vi.fn(() => Promise.reject(new Error("Refused"))) });
    const { onOpenChange } = open({ actions });
    await settle(() => fireEvent.click(choice("sync-merge"), { detail: 1 }));
    expect(within(screen.getByTestId("sync-dialog")).getByRole("alert")).toHaveTextContent("Refused");
    for (const testId of CHOICES) {
      await settle(() => fireEvent.click(choice(testId), { detail: 2 }));
      await settle(() => fireEvent.click(choice(testId), { detail: 3 }));
    }
    expect(actions.merge).toHaveBeenCalledOnce();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    // A new press is a retry.
    await settle(() => fireEvent.click(choice("sync-merge"), { detail: 1 }));
    expect(actions.merge).toHaveBeenCalledTimes(2);
  });

  it("Compare opens the comparison once and closes at once, and is refused while an action runs", async () => {
    const pending = deferred<void>();
    const first = open({ actions: syncActions({ takeRemote: vi.fn(() => pending.promise) }) });
    fireEvent.click(choice("sync-take-remote"));
    fireEvent.click(choice("sync-compare"));
    expect(first.actions.compare).not.toHaveBeenCalled();
    expect(first.onOpenChange).not.toHaveBeenCalled();
    await settle(() => pending.reject(new Error("no")));
    fireEvent.click(choice("sync-compare"));
    expect(first.actions.compare).toHaveBeenCalledOnce();
    expect(first.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(first.actions.takeRemote).toHaveBeenCalledOnce();
    expect(first.actions.merge).not.toHaveBeenCalled();
    expect(first.actions.keepMine).not.toHaveBeenCalled();
  });

  it("Enter on a choice acts when the key is released, and a repeat never acts", async () => {
    const { actions, onOpenChange } = open();
    // Repeats and a release that reach a choice from a press that started elsewhere.
    for (const testId of CHOICES) {
      choice(testId).focus();
      expect(fireEvent.keyDown(choice(testId), { key: "Enter", repeat: true })).toBe(false);
      fireEvent.keyUp(choice(testId), { key: "Enter" });
    }
    expectNothingStarted(actions);
    expect(onOpenChange).not.toHaveBeenCalled();

    choice("sync-keep-mine").focus();
    expect(fireEvent.keyDown(choice("sync-keep-mine"), { key: "Enter" })).toBe(false);
    fireEvent.keyDown(choice("sync-keep-mine"), { key: "Enter", repeat: true });
    expect(actions.keepMine).not.toHaveBeenCalled();
    await settle(() => fireEvent.keyUp(choice("sync-keep-mine"), { key: "Enter" }));
    expect(actions.keepMine).toHaveBeenCalledOnce();
    // Enter in the message field is not an action.
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyUp(field(), { key: "Enter" });
    expect(actions.keepMine).toHaveBeenCalledOnce();
    expect(actions.merge).not.toHaveBeenCalled();
  });

  it.each([
    ["sync-merge", "ArrowDown", "sync-keep-mine"],
    ["sync-merge", "ArrowRight", "sync-keep-mine"],
    ["sync-keep-mine", "ArrowUp", "sync-merge"],
    ["sync-keep-mine", "ArrowLeft", "sync-merge"],
    ["sync-take-remote", "Home", "sync-merge"],
    ["sync-keep-mine", "End", "sync-compare"],
  ] as const)("from %s, %s moves focus to %s and starts nothing", (from, key, to) => {
    const { actions, onOpenChange } = open();
    choice(from).focus();
    expect(fireEvent.keyDown(choice(from), { key })).toBe(false);
    expect(choice(to)).toHaveFocus();
    expectNothingStarted(actions);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("arrow keys stop at the ends, ignore modified keys and the message field, and do nothing while the choices are off", async () => {
    const pending = deferred<number>();
    open({ actions: syncActions({ merge: vi.fn(() => pending.promise) }) });
    const press = (testId: string, key: string, init: KeyboardEventInit = {}) => {
      choice(testId).focus();
      return fireEvent.keyDown(choice(testId), { key, ...init });
    };
    for (const key of ["ArrowLeft", "ArrowUp", "Home"]) {
      expect(press("sync-merge", key)).toBe(true);
      expect(choice("sync-merge")).toHaveFocus();
    }
    for (const key of ["ArrowRight", "ArrowDown", "End"]) {
      expect(press("sync-compare", key)).toBe(true);
      expect(choice("sync-compare")).toHaveFocus();
    }
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(press("sync-merge", "ArrowDown", { [modifier]: true })).toBe(true);
      expect(choice("sync-merge")).toHaveFocus();
    }
    field().focus();
    expect(fireEvent.keyDown(field(), { key: "Home" })).toBe(true);
    expect(field()).toHaveFocus();

    fireEvent.click(choice("sync-merge"));
    expect(press("sync-merge", "ArrowDown")).toBe(true);
    expect(choice("sync-merge")).toHaveFocus();
    await settle(() => pending.resolve(0));
  });

  it("with an unreadable GitHub file only Keep mine is there and the arrow keys have nowhere to go", () => {
    const { actions } = open({ sync: UNREADABLE_SYNC });
    expect(screen.queryByTestId("sync-merge")).toBeNull();
    expect(screen.queryByTestId("sync-take-remote")).toBeNull();
    expect(screen.queryByTestId("sync-compare")).toBeNull();
    choice("sync-keep-mine").focus();
    for (const key of ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"]) {
      expect(fireEvent.keyDown(choice("sync-keep-mine"), { key })).toBe(true);
    }
    expect(choice("sync-keep-mine")).toHaveFocus();
    expectNothingStarted(actions);
  });

  it("a status poll (a new sync object, new callbacks) keeps the typed message, the running action, its result, the error and the focus", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    const failing = deferred<number>();
    const keepMine = vi.fn(() => pending.promise);
    const merge = vi.fn(() => failing.promise);
    const { onOpenChange, update } = open({ actions: syncActions({ keepMine, merge }) });
    const poll = () => update({ sync: { ...UPDATED_SYNC }, actions: syncActions({ keepMine, merge }) });

    fireEvent.change(field(), { target: { value: "Typed before the poll" } });
    field().focus();
    field().setSelectionRange(5, 5);
    poll();
    expect(field()).toHaveValue("Typed before the poll");
    expect(field()).toHaveFocus();
    expect([field().selectionStart, field().selectionEnd]).toEqual([5, 5]);
    expect(screen.getByTestId("sync-remote-lines")).toHaveTextContent("8 lines changed");

    fireEvent.click(choice("sync-merge"));
    await settle(() => failing.reject(new Error("Merge refused")));
    poll();
    expect(within(screen.getByTestId("sync-dialog")).getByRole("alert")).toHaveTextContent("Merge refused");

    choice("sync-keep-mine").focus();
    fireEvent.click(choice("sync-keep-mine"));
    poll();
    expect(choice("sync-keep-mine")).toHaveAttribute("aria-disabled", "true");
    expect(choice("sync-keep-mine")).toHaveFocus();
    await settle(() => pending.resolve());
    poll();
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
    expect(field()).toHaveValue("Typed before the poll");
    act(() => void vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(keepMine).toHaveBeenCalledExactlyOnceWith("Typed before the poll");
    expect(merge).toHaveBeenCalledOnce();
  });

  it("closing while an action runs lets go of it: its result neither shows in the next visit nor closes it, and the visit starts clean", async () => {
    vi.useFakeTimers();
    const pending = deferred<number>();
    const failing = deferred<void>();
    const merge = vi.fn(() => pending.promise);
    const takeRemote = vi.fn(() => failing.promise);
    const { onOpenChange, update } = open({ actions: syncActions({ merge, takeRemote }) });
    fireEvent.change(field(), { target: { value: "thrown away" } });
    fireEvent.click(choice("sync-merge"));
    update({ open: false });
    expect(screen.queryByTestId("sync-dialog")).toBeNull();
    update({ open: true });
    expect(field()).toHaveValue("Update big.md");
    for (const testId of CHOICES) expect(choice(testId)).not.toHaveAttribute("aria-disabled");
    await settle(() => pending.resolve(0));
    expect(screen.queryByTestId("sync-done")).toBeNull();
    act(() => void vi.advanceTimersByTime(5_000));
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(choice("sync-take-remote"));
    update({ open: false });
    update({ open: true });
    await settle(() => failing.reject(new Error("Late")));
    expect(within(screen.getByTestId("sync-dialog")).queryByRole("alert")).toBeNull();
    for (const testId of CHOICES) expect(choice(testId)).not.toHaveAttribute("aria-disabled");
  });

  it("another file under the open dialog starts over; a refresh of the same file does not", async () => {
    const { update } = open({ actions: syncActions({ merge: vi.fn(() => Promise.reject(new Error("Refused"))) }) });
    fireEvent.change(field(), { target: { value: "My draft" } });
    await settle(() => fireEvent.click(choice("sync-merge")));
    update({ doc: { ...DOC, title: "Renamed", publishedAt: "2026-09-01T00:00:00.000Z" } });
    expect(field()).toHaveValue("My draft");
    expect(within(screen.getByTestId("sync-dialog")).getByRole("alert")).toHaveTextContent("Refused");
    update({ doc: RENAMED_DOC });
    expect(field()).toHaveValue("Update renamed.md");
    expect(within(screen.getByTestId("sync-dialog")).queryByRole("alert")).toBeNull();
  });

  it("the close after a result uses the newest onOpenChange and is cancelled by an unmount", async () => {
    vi.useFakeTimers();
    const first = open();
    await settle(() => fireEvent.click(choice("sync-merge")));
    const newer = vi.fn<(open: boolean) => void>();
    first.update({ onOpenChange: newer });
    act(() => void vi.advanceTimersByTime(900));
    expect(first.onOpenChange).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledExactlyOnceWith(false);
    cleanup();

    const second = open();
    await settle(() => fireEvent.click(choice("sync-merge")));
    second.view.unmount();
    act(() => void vi.advanceTimersByTime(5_000));
    expect(second.onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape and the Close button ask to close, also while an action runs", async () => {
    const pending = deferred<number>();
    const { onOpenChange } = open({ actions: syncActions({ merge: vi.fn(() => pending.promise) }) });
    fireEvent.keyDown(choice("sync-merge"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(choice("sync-merge"));
    fireEvent.keyDown(choice("sync-merge"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledTimes(3);
    expect(onOpenChange.mock.calls.every(([next]) => next === false)).toBe(true);
    await settle(() => pending.resolve(0));
  });

  // An unprompted visit: the editor opened the dialog on its own, because GitHub refused a commit or a pull.
  const body = () => screen.getByTestId("sync-dialog");
  const expectChoices = (state: "on" | "off") => {
    for (const testId of CHOICES) {
      if (state === "off") expect(choice(testId)).toHaveAttribute("aria-disabled", "true");
      else expect(choice(testId)).not.toHaveAttribute("aria-disabled");
      expect(choice(testId)).not.toBeDisabled();
    }
  };
  /** jsdom lays nothing out; the dialog picks its opening focus among the controls that are rendered. */
  const withLayout = () => vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);

  it("a visit the user asked for is live at once: focus on the first choice, every choice on, no tab stop on the body", async () => {
    withLayout();
    const { actions } = open();
    expect(choice("sync-merge")).toHaveFocus();
    expect(body()).not.toHaveAttribute("tabindex");
    expectChoices("on");
    await settle(() => fireEvent.click(choice("sync-take-remote")));
    expect(actions.takeRemote).toHaveBeenCalledOnce();
  });

  it("an unprompted visit starts on the dialog body with every choice off: Enter, Space and typing in the field start nothing and switch nothing on", () => {
    withLayout();
    const { actions } = open({ unprompted: true });
    expect(body()).toHaveFocus();
    expect(body()).toHaveAttribute("tabindex", "0");
    expectChoices("off");
    for (const key of ["Enter", " ", "a", "Home", "End", "PageDown"]) {
      fireEvent.keyDown(body(), { key });
      fireEvent.keyUp(body(), { key });
    }
    // The pointer is seen for the first time, wherever it is, and a hand that shakes: not a move.
    fireEvent.pointerMove(document, { clientX: 500, clientY: 500 });
    fireEvent.pointerMove(document, { clientX: 524, clientY: 500 });
    fireEvent.pointerMove(document, { clientX: 485, clientY: 515 });
    // A click that is not on the card.
    fireEvent.click(document.body);
    fireEvent.change(field(), { target: { value: "typed while the choices are off" } });
    expect(field()).toHaveValue("typed while the choices are off");
    expect(body()).toHaveFocus();
    expectChoices("off");
    expectNothingStarted(actions);
  });

  it.each(CHOICES)("unprompted: one whole press on %s starts nothing and switches the choices on; the next press acts once", async (testId) => {
    const { actions, onOpenChange } = open({ unprompted: true });
    await settle(() => fireEvent.click(choice(testId), { detail: 1 }));
    expectNothingStarted(actions);
    expect(onOpenChange).not.toHaveBeenCalled();
    expectChoices("on");
    expect(body()).toHaveAttribute("tabindex", "-1");
    // The rest of that double-click is still no press.
    await settle(() => fireEvent.click(choice(testId), { detail: 2 }));
    expectNothingStarted(actions);
    await settle(() => fireEvent.click(choice(testId), { detail: 1 }));
    const started = { "sync-merge": actions.merge, "sync-keep-mine": actions.keepMine, "sync-take-remote": actions.takeRemote, "sync-compare": actions.compare }[testId];
    expect(started).toHaveBeenCalledOnce();
    expect([actions.merge, actions.keepMine, actions.takeRemote, actions.compare].filter((action) => vi.mocked(action).mock.calls.length > 0)).toHaveLength(1);
  });

  it("unprompted: a press on the title or in the message field switches the choices on too", () => {
    const first = open({ unprompted: true });
    fireEvent.click(screen.getByText("Sync with GitHub"));
    expectChoices("on");
    expectNothingStarted(first.actions);
    cleanup();
    const second = open({ unprompted: true });
    fireEvent.click(field());
    expectChoices("on");
    expectNothingStarted(second.actions);
  });

  it("unprompted: the pointer switches the choices on once it has travelled more than 24 px from where it was first seen", async () => {
    const { actions } = open({ unprompted: true });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 300 });
    fireEvent.pointerMove(document, { clientX: 200, clientY: 324 });
    expectChoices("off");
    fireEvent.pointerMove(document, { clientX: 215, clientY: 320 });
    expectChoices("on");
    expectNothingStarted(actions);
    await settle(() => fireEvent.click(choice("sync-take-remote"), { detail: 1 }));
    expect(actions.takeRemote).toHaveBeenCalledOnce();
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
  });

  it.each([
    ["Tab", {}],
    ["Tab", { shiftKey: true }],
    ["ArrowDown", {}],
    ["ArrowUp", {}],
    ["ArrowRight", {}],
    ["ArrowLeft", {}],
  ] as const)("unprompted: %s %j switches the choices on, an arrow key goes to the first choice, and Enter there acts once", async (key, init) => {
    withLayout();
    const { actions } = open({ unprompted: true });
    const moved = fireEvent.keyDown(body(), { key, ...init });
    expectChoices("on");
    expectNothingStarted(actions);
    if (key === "Tab") {
      // The browser moves the focus itself; jsdom does not.
      expect(moved).toBe(true);
      choice("sync-merge").focus();
    } else {
      expect(moved).toBe(false);
    }
    expect(choice("sync-merge")).toHaveFocus();
    fireEvent.keyDown(choice("sync-merge"), { key: "Enter" });
    await settle(() => fireEvent.keyUp(choice("sync-merge"), { key: "Enter" }));
    expect(actions.merge).toHaveBeenCalledOnce();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
  });

  it("unprompted is read when a visit starts: a later change of the prop changes nothing, and every new visit starts over", () => {
    const { update } = open({ unprompted: true });
    update({ unprompted: false });
    expectChoices("off");
    fireEvent.keyDown(body(), { key: "Tab" });
    expectChoices("on");
    // The same dialog again, opened by the editor again: off again.
    update({ open: false });
    update({ open: true, unprompted: true });
    expectChoices("off");
    // Opened by the user: on, and a 409 from one of its own choices (the shell then says "unprompted") leaves it on.
    update({ open: false });
    update({ open: true, unprompted: false });
    expectChoices("on");
    expect(body()).not.toHaveAttribute("tabindex");
    update({ unprompted: true });
    expectChoices("on");
  });

  it("unprompted with an unreadable GitHub file: Keep mine starts off, and an arrow key from the body goes to it", () => {
    withLayout();
    const { actions } = open({ unprompted: true, sync: UNREADABLE_SYNC });
    expect(body()).toHaveFocus();
    expect(choice("sync-keep-mine")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(choice("sync-keep-mine"), { detail: 1 });
    expectNothingStarted(actions);
    expect(choice("sync-keep-mine")).not.toHaveAttribute("aria-disabled");
    cleanup();
    open({ unprompted: true, sync: UNREADABLE_SYNC });
    fireEvent.keyDown(body(), { key: "ArrowDown" });
    expect(choice("sync-keep-mine")).toHaveFocus();
    expect(choice("sync-keep-mine")).not.toHaveAttribute("aria-disabled");
  });
});
