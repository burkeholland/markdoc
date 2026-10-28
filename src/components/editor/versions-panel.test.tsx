// @vitest-environment jsdom
import { compile } from "tailwindcss";
import {
  StrictMode,
  useLayoutEffect,
  type ComponentProps,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CollabSession } from "@/editor/collab/session";
import type { VersionSummary } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/utils";

const versions = vi.fn();
const version = vi.fn();
const renameVersion = vi.fn();
const restoreVersion = vi.fn();
const copyVersion = vi.fn();
const push = vi.fn();
const router = { push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };
let activeRouter = router;
const pendingNotice = vi.fn();
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
  useRouter: () => activeRouter,
}));

vi.mock("@/lib/notice", () => ({
  setPendingNotice: (...args: unknown[]) => pendingNotice(...args),
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

type CapturedEvent<T extends HTMLElement> = {
  currentTarget: T;
  target: T;
  key?: string;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

interface CapturedProps<T extends HTMLElement> {
  onClick?: (event: CapturedEvent<T>) => void;
  onChange?: (event: CapturedEvent<T>) => void;
  onBlur?: (event: CapturedEvent<T>) => void;
  onKeyDownCapture?: (event: CapturedEvent<T>) => void;
  onKeyDown?: (event: CapturedEvent<T>) => void;
  ref?: (element: T | null) => void;
}

function interceptClick(
  element: HTMLButtonElement,
  invokeHandler: (
    original: NonNullable<CapturedProps<HTMLButtonElement>["onClick"]>,
    event: CapturedEvent<HTMLButtonElement>,
  ) => void,
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the element");
  const record = element as unknown as Record<
    string,
    CapturedProps<HTMLButtonElement>
  >;
  const props = record[propsKey];
  const original = props.onClick;
  if (!original) throw new Error("React click handler was not attached");
  record[propsKey] = {
    ...props,
    onClick: (event) => invokeHandler(original, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

function SettleInLayout({ settle }: { settle: () => void }) {
  useLayoutEffect(() => settle(), [settle]);
  return null;
}

type StrictVersionsProps = ComponentProps<typeof VersionsPanel>;

async function renderStrictVersions(
  root: ReturnType<typeof createRoot>,
  props: StrictVersionsProps,
  generation = "panel",
) {
  await act(async () => {
    root.render(
      <StrictMode>
        <VersionsPanel key={generation} {...props} />
      </StrictMode>,
    );
  });
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

function expectMutationControlsToBeDisabled(disabled: boolean) {
  for (const testId of ["version-restore", "version-rename", "version-copy"]) {
    if (disabled) expect(screen.getByTestId(testId)).toBeDisabled();
    else expect(screen.getByTestId(testId)).toBeEnabled();
  }
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
  activeRouter = router;
  versions.mockReset().mockResolvedValue({ versions: [named] });
  version.mockReset().mockResolvedValue({ version: { ...named, content: "# Draft" } });
  renameVersion.mockReset();
  restoreVersion.mockReset().mockResolvedValue({ ok: true });
  copyVersion.mockReset().mockResolvedValue({ id: "copy-1", title: "Copy" });
  push.mockReset();
  pendingNotice.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VersionsPanel · manual refresh authority", () => {
  it("keeps cached rows visible, coalesces activation, and replaces the list once", async () => {
    const docId = "manual-refresh-success";
    const current = {
      ...named,
      id: `${docId}-current`,
      title: "Current cached version",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 0,
      title: "Older cached version",
    };
    const refreshed = {
      ...named,
      id: `${docId}-refreshed`,
      number: 2,
      title: "Fresh version",
    };
    const request = deferred<{ versions: VersionSummary[] }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockReturnValueOnce(request.promise);

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
        refreshKey: 0,
      });
      await screen.findByText(current.title);
      const refresh = screen.getByRole<HTMLButtonElement>("button", {
        name: "Refresh versions",
      });
      const restore = interceptClick(refresh, (original, event) => {
        original(event);
        original(event);
      });

      act(() => refresh.click());
      restore();
      act(() => refresh.click());

      expect(versions).toHaveBeenCalledTimes(2);
      expect(refresh).toBeDisabled();
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);
      expect(screen.getByText(current.title)).toBeInTheDocument();
      expect(screen.getByText(older.title)).toBeInTheDocument();

      request.resolve({ versions: [refreshed] });
      expect(await screen.findByText(refreshed.title)).toBeInTheDocument();
      expect(screen.queryByText(current.title)).toBeNull();
      expect(screen.queryByText(older.title)).toBeNull();
      expect(screen.getAllByTestId("version-item")).toHaveLength(1);
      expect(refresh).toBeEnabled();
      expect(refresh).not.toHaveAttribute("aria-busy");
      expect(versions).toHaveBeenCalledTimes(2);
      expect(versions).toHaveBeenNthCalledWith(2, docId);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retains rows and interaction state on failure, then recovers through Retry", async () => {
    const docId = "manual-refresh-retry";
    const current = {
      ...named,
      id: `${docId}-current`,
      title: "Refresh retry current",
    };
    const older = {
      ...named,
      id: `${docId}-older`,
      number: 0,
      title: "Refresh retry older",
    };
    const failed = deferred<{ versions: VersionSummary[] }>();
    const retryRequest = deferred<{ versions: VersionSummary[] }>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current, older] })
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retryRequest.promise);
    version.mockResolvedValue({
      version: { ...current, content: "# Refresh retry" },
    });

    try {
      await renderStrictVersions(root, {
        session: session(docId),
        onClose: vi.fn(),
        onPreview,
        refreshKey: 0,
      });
      fireEvent.click(await screen.findByText(current.title));
      await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole("checkbox", { name: `Compare v${current.number}` }),
      );
      await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
      onPreview.mockClear();

      fireEvent.click(
        screen.getByRole("button", { name: "Refresh versions" }),
      );
      failed.reject(new Error("manual refresh unavailable"));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "manual refresh unavailable",
      );
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);
      expect(screen.getByText(current.title)).toBeInTheDocument();
      expect(screen.getByText(older.title)).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", {
          name: `Compare v${current.number}`,
        }),
      ).toBeChecked();
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
      expect(onPreview).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Refresh versions" }),
        ).toBeEnabled(),
      );

      const retry = screen.getByRole<HTMLButtonElement>("button", {
        name: "Retry",
      });
      fireEvent.click(retry);
      fireEvent.click(retry);
      await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));
      expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
      expect(screen.getAllByTestId("version-item")).toHaveLength(2);

      retryRequest.resolve({ versions: [current, older] });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(
        screen.getByRole("checkbox", {
          name: `Compare v${current.number}`,
        }),
      ).toBeChecked();
      expect(screen.getByTestId("version-restore")).toBeInTheDocument();
      expect(onPreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "lets an external refresh retire a pending manual refresh before its late %s",
    async (settlement) => {
      const docId = `manual-refresh-external-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `External initial ${settlement}`,
      };
      const stale = {
        ...named,
        id: `${docId}-stale`,
        title: `External stale ${settlement}`,
      };
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `External current ${settlement}`,
      };
      const manual = deferred<{ versions: VersionSummary[] }>();
      const external = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const props = {
        session: session(docId),
        onClose: vi.fn(),
        onPreview: vi.fn(),
      };
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(external.promise);

      try {
        await renderStrictVersions(root, { ...props, refreshKey: 0 });
        await screen.findByText(initial.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, { ...props, refreshKey: 1 });
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        external.resolve({ versions: [current] });
        expect(await screen.findByText(current.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            manual.resolve({ versions: [stale] });
          } else {
            manual.reject(new Error("obsolete manual failure"));
          }
          await Promise.resolve();
        });

        expect(screen.getByText(current.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete manual failure")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(props.onPreview).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
        expect(versions).toHaveBeenCalledTimes(3);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "lets a mutation reload retire a pending manual refresh before its late %s",
    async (settlement) => {
      const docId = `manual-refresh-mutation-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Mutation initial ${settlement}`,
      };
      const renamed = {
        ...initial,
        title: `Mutation renamed ${settlement}`,
      };
      const stale = {
        ...initial,
        title: `Mutation stale ${settlement}`,
      };
      const manual = deferred<{ versions: VersionSummary[] }>();
      const reload = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(manual.promise)
        .mockReturnValueOnce(reload.promise);
      renameVersion.mockResolvedValueOnce({ ok: true });

      try {
        await renderStrictVersions(root, {
          session: session(docId),
          onClose: vi.fn(),
          onPreview,
          refreshKey: 0,
        });
        fireEvent.click(await screen.findByText(initial.title));
        await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
        onPreview.mockClear();
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        fireEvent.click(screen.getByTestId("version-rename"));
        fireEvent.change(screen.getByTestId("version-rename-input"), {
          target: { value: renamed.title },
        });
        fireEvent.keyDown(screen.getByTestId("version-rename-input"), {
          key: "Enter",
        });
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        reload.resolve({ versions: [renamed] });
        expect(await screen.findByText(renamed.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            manual.resolve({ versions: [stale] });
          } else {
            manual.reject(new Error("obsolete mutation refresh"));
          }
          await Promise.resolve();
        });

        expect(screen.getByText(renamed.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete mutation refresh")).toBeNull();
        expect(onPreview).not.toHaveBeenCalled();
        expect(renameVersion).toHaveBeenCalledExactlyOnceWith(
          docId,
          initial.id,
          renamed.title,
        );
        expect(versions).toHaveBeenCalledTimes(3);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "isolates a replaced document from an old manual refresh %s",
    async (settlement) => {
      const oldDocId = `manual-refresh-old-document-${settlement}`;
      const newDocId = `manual-refresh-new-document-${settlement}`;
      const oldVersion = {
        ...named,
        id: `${oldDocId}-version`,
        title: `Old document ${settlement}`,
      };
      const staleVersion = {
        ...named,
        id: `${oldDocId}-stale`,
        title: `Stale document ${settlement}`,
      };
      const newVersion = {
        ...named,
        id: `${newDocId}-version`,
        title: `New document ${settlement}`,
      };
      const staleRequest = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [oldVersion] })
        .mockReturnValueOnce(staleRequest.promise)
        .mockResolvedValueOnce({ versions: [newVersion] });

      try {
        await renderStrictVersions(root, {
          session: session(oldDocId),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        await screen.findByText(oldVersion.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, {
          session: session(newDocId),
          onClose,
          onPreview,
          refreshKey: 0,
        });
        expect(await screen.findByText(newVersion.title)).toBeInTheDocument();

        await act(async () => {
          if (settlement === "resolve") {
            staleRequest.resolve({ versions: [staleVersion] });
          } else {
            staleRequest.reject(new Error("obsolete document refresh"));
          }
          await Promise.resolve();
        });
        expect(screen.getByText(newVersion.title)).toBeInTheDocument();
        expect(screen.queryByText(staleVersion.title)).toBeNull();
        expect(screen.queryByText("obsolete document refresh")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();
        expect(versions).toHaveBeenNthCalledWith(3, newDocId);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps a replacement mount independent of an old manual refresh %s",
    async (settlement) => {
      const docId = `manual-refresh-mount-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Mount initial ${settlement}`,
      };
      const stale = {
        ...named,
        id: `${docId}-stale`,
        title: `Mount stale ${settlement}`,
      };
      const current = {
        ...named,
        id: `${docId}-current`,
        title: `Mount current ${settlement}`,
      };
      const staleRequest = deferred<{ versions: VersionSummary[] }>();
      const currentRequest = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      const props = {
        session: session(docId),
        onClose,
        onPreview,
        refreshKey: 0,
      };
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(staleRequest.promise)
        .mockReturnValueOnce(currentRequest.promise);

      try {
        await renderStrictVersions(root, props, "A");
        await screen.findByText(initial.title);
        fireEvent.click(
          screen.getByRole("button", { name: "Refresh versions" }),
        );
        await renderStrictVersions(root, props, "B");
        await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));

        currentRequest.resolve({ versions: [current] });
        expect(await screen.findByText(current.title)).toBeInTheDocument();
        await act(async () => {
          if (settlement === "resolve") {
            staleRequest.resolve({ versions: [stale] });
          } else {
            staleRequest.reject(new Error("obsolete mount refresh"));
          }
          await Promise.resolve();
        });
        expect(screen.getByText(current.title)).toBeInTheDocument();
        expect(screen.queryByText(stale.title)).toBeNull();
        expect(screen.queryByText("obsolete mount refresh")).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPreview).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "drops a late manual refresh %s after cleanup",
    async (settlement) => {
      const docId = `manual-refresh-cleanup-${settlement}`;
      const initial = {
        ...named,
        id: `${docId}-initial`,
        title: `Cleanup initial ${settlement}`,
      };
      const request = deferred<{ versions: VersionSummary[] }>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const onClose = vi.fn();
      const onPreview = vi.fn();
      versions
        .mockReset()
        .mockResolvedValueOnce({ versions: [initial] })
        .mockReturnValueOnce(request.promise);

      await renderStrictVersions(root, {
        session: session(docId),
        onClose,
        onPreview,
        refreshKey: 0,
      });
      await screen.findByText(initial.title);
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh versions" }),
      );
      await act(async () => root.unmount());
      await act(async () => {
        if (settlement === "resolve") {
          request.resolve({
            versions: [{ ...initial, title: "Too late after cleanup" }],
          });
        } else {
          request.reject(new Error("too late after cleanup"));
        }
        await Promise.resolve();
      });

      expect(host).toBeEmptyDOMElement();
      expect(onClose).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
      expect(versions).toHaveBeenCalledTimes(2);
      host.remove();
    },
  );

});

describe("VersionsPanel - native version name titles", () => {
  it("keeps long, distinct names literal and hover inert before selection and comparison", async () => {
    const docId = "native-version-titles";
    const prefix = "Release candidate ".repeat(12);
    const newer = {
      ...named,
      id: "title-newer",
      number: 2,
      title: `${prefix}<img src=x onerror="alert('x')"> & final`,
      commitSha: "1234567890abcdef1234567890abcdef12345678",
    };
    const older = { ...named, id: "title-older", title: `${prefix}<b>Earlier</b> & "draft"` };
    const rows = [newer, older];
    const onPreview = vi.fn();
    const onClose = vi.fn();
    versions.mockResolvedValueOnce({ versions: rows });
    version.mockImplementation(async (_docId: string, id: string) =>
      contentResult(id === newer.id ? newer : older, id === newer.id ? "# Newer" : "# Older"),
    );
    render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);

    const items = await screen.findAllByTestId("version-item");
    expect(items).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const span = within(items[index]).getByText(row.title);
      expect(row.title.length).toBeGreaterThanOrEqual(200);
      expect(span.tagName).toBe("SPAN");
      expect(span.textContent).toBe(row.title);
      expect(span).toHaveAttribute("title", row.title);
      expect(span.getAttributeNames().sort()).toEqual(["class", "title"]);
      expect(span.className).toBe("truncate text-[13px] font-medium text-ink");
      expect(span.childElementCount).toBe(0);
      expect(span.tabIndex).toBe(-1);
      expect(within(items[index]).getByTestId("version-kind")).toHaveTextContent(/^Named$/);
      expect(within(items[index]).getByRole("checkbox", { name: `Compare v${row.number}` })).not.toBeChecked();
      expect(within(items[index]).getByRole("button")).toHaveAccessibleName(
        `${row.title}Named v${row.number}· ${relativeTime(row.createdAt)}· Alice${row.commitSha?.slice(0, 7) ?? ""}`,
      );
      expect(within(items[index]).getByTitle(formatDateTime(row.createdAt))).toHaveTextContent(
        `· ${relativeTime(row.createdAt)}`,
      );
    }
    expect(screen.getByTitle(newer.commitSha)).toHaveTextContent(newer.commitSha.slice(0, 7));
    expect(screen.getByTestId("versions-panel").querySelectorAll("img, b, script")).toHaveLength(0);

    const focused = document.activeElement;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const animationFrame = vi.spyOn(window, "requestAnimationFrame");
    const fetch = vi.spyOn(globalThis, "fetch");
    await act(async () => {
      for (const row of rows) {
        const span = screen.getByTitle(row.title);
        fireEvent.pointerOver(span);
        fireEvent.mouseOver(span);
        fireEvent.mouseMove(span);
        fireEvent.mouseOut(span);
        fireEvent.pointerOut(span);
      }
    });
    expect(versions).toHaveBeenCalledExactlyOnceWith(docId);
    for (const effect of [
      version, renameVersion, restoreVersion, copyVersion, push, pendingNotice,
      onPreview, onClose, focus, timeout, interval, animationFrame, fetch,
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
    expect(document.activeElement).toBe(focused);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("version-item")).toHaveLength(2);
    for (const spy of [focus, timeout, interval, animationFrame, fetch]) spy.mockRestore();

    fireEvent.click(screen.getByTitle(newer.title));
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ version: newer, content: "# Newer" }));
    expect(version).toHaveBeenCalledExactlyOnceWith(docId, newer.id);
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy as new doc" })).toHaveAttribute(
      "title", "Copy this version as a new document",
    );
    onPreview.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v2" }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({
      version: newer,
      content: "# Newer",
      base: { version: older, content: "# Older" },
      range: [newer],
    }));
    expect(version).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenNthCalledWith(2, docId, older.id);
    for (const row of rows) expect(screen.getByTitle(row.title).textContent).toBe(row.title);
  });

  it("uses every current kind label for null titles but preserves empty text and title", async () => {
    const cases: { kind: VersionSummary["kind"]; title: string | null; label: string }[] = [
      { kind: "auto", title: null, label: "Autosaved" },
      { kind: "named", title: null, label: "Named version" },
      { kind: "publish", title: null, label: "Published" },
      { kind: "restore", title: null, label: "Restored" },
      { kind: "import", title: null, label: "Imported" },
      { kind: "named", title: "", label: "" },
    ];
    versions.mockResolvedValueOnce({
      versions: cases.map(({ kind, title }, index) => ({
        ...named, id: `title-fallback-${index}`, number: index + 1, kind, title,
      })),
    });
    render(<VersionsPanel session={session("native-title-fallbacks")} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);

    const items = await screen.findAllByTestId("version-item");
    expect(items).toHaveLength(cases.length);
    for (const [index, { kind, label }] of cases.entries()) {
      const span = items[index].querySelector("span.truncate");
      expect(span).toHaveAttribute("title", label);
      expect(span?.textContent).toBe(label);
      expect(items[index]).toHaveAttribute("data-version-kind", kind);
      expect(within(items[index]).queryByTestId("version-kind")).not.toBeInTheDocument();
      expect(within(items[index]).getByRole("checkbox", { name: `Compare v${index + 1}` })).not.toBeChecked();
    }
  });

  it("removes the title with the rename span and replaces it after one accepted rename", async () => {
    const docId = "native-title-rename";
    const current = { ...named, title: "Original version name" };
    const renamed = { ...current, title: 'Renamed <version> & "final"' };
    versions.mockReset()
      .mockResolvedValueOnce({ versions: [current] })
      .mockResolvedValueOnce({ versions: [renamed] });
    version.mockResolvedValueOnce(contentResult(current, "# Draft"));
    renameVersion.mockResolvedValueOnce({ ok: true });
    const onPreview = vi.fn();
    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);

    const oldSpan = await screen.findByTitle(current.title);
    fireEvent.click(oldSpan);
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByTestId("version-rename-input");
    expect(oldSpan).not.toBeInTheDocument();
    expect(screen.queryByTitle(current.title)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("title");
    expect(input).toHaveValue(current.title);
    fireEvent.change(input, { target: { value: renamed.title } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });
    expect((await screen.findByTitle(renamed.title)).textContent).toBe(renamed.title);
    expect(screen.queryByTitle(current.title)).not.toBeInTheDocument();
    expect(screen.queryByTestId("version-rename-input")).not.toBeInTheDocument();
    expect(renameVersion).toHaveBeenCalledExactlyOnceWith(docId, current.id, renamed.title);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(version).toHaveBeenCalledExactlyOnceWith(docId, current.id);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith({ version: current, content: "# Draft" });
  });

  it("updates current list titles and removes old document titles even when row IDs are reused", async () => {
    const current = { ...named, title: "Before list replacement" };
    const updated = { ...current, title: "After list replacement" };
    const otherDocument = { ...current, title: "Other document version" };
    versions.mockReset()
      .mockResolvedValueOnce({ versions: [current] })
      .mockResolvedValueOnce({ versions: [updated] })
      .mockResolvedValueOnce({ versions: [otherDocument] });
    const props = { session: session("native-title-list"), onClose: vi.fn(), onPreview: vi.fn(), refreshKey: 0 };
    const { rerender } = render(<VersionsPanel {...props} />);
    await screen.findByTitle(current.title);

    rerender(<VersionsPanel {...props} refreshKey={1} />);
    expect((await screen.findByTitle(updated.title)).textContent).toBe(updated.title);
    expect(screen.queryByTitle(current.title)).not.toBeInTheDocument();
    rerender(<VersionsPanel {...props} session={session("native-title-other-document")} refreshKey={1} />);
    expect((await screen.findByTitle(otherDocument.title)).textContent).toBe(otherDocument.title);
    expect(screen.queryByTitle(updated.title)).not.toBeInTheDocument();
    expect(screen.queryByTitle(current.title)).not.toBeInTheDocument();
    expect(screen.getAllByTestId("version-item")).toHaveLength(1);
    expect(versions).toHaveBeenCalledTimes(3);
    expect(versions).toHaveBeenNthCalledWith(1, "native-title-list");
    expect(versions).toHaveBeenNthCalledWith(2, "native-title-list");
    expect(versions).toHaveBeenNthCalledWith(3, "native-title-other-document");
    expect(version).not.toHaveBeenCalled();
    expect(renameVersion).not.toHaveBeenCalled();
  });

  it("keeps readonly version titles without exposing rename or restore", async () => {
    const docId = "native-title-readonly";
    const readonlySession = { docId, role: "viewer" } as unknown as CollabSession;
    const onPreview = vi.fn();
    render(<VersionsPanel session={readonlySession} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);

    fireEvent.click(await screen.findByTitle(named.title!));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    expect(screen.getByTitle(named.title!).textContent).toBe(named.title);
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as new doc" })).toBeEnabled();
    expect(version).toHaveBeenCalledExactlyOnceWith(docId, named.id);
    expect(renameVersion).not.toHaveBeenCalled();
    expect(restoreVersion).not.toHaveBeenCalled();
  });
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

describe("VersionsPanel · mutation ownership", () => {
  it("starts one confirmed Restore for two immediate activations and owns its one reload", async () => {
    const docId = "mutation-restore-once";
    const current = { ...named, id: "restore-once", title: "Restore once" };
    const restoreRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ version: current, content: "# Draft" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();

    const restoreButton = screen.getByTestId("version-restore");
    fireEvent.click(restoreButton);
    fireEvent.click(restoreButton);

    expect(confirm).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledWith(docId, current.id);
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Restore once")).not.toBeNull();

    restoreRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).not.toBeChecked();
    expect(spinnerFor("Restore once")).not.toBeNull();

    reloadRequest.resolve({ versions: [current] });
    await waitFor(() => expect(spinnerFor("Restore once")).toBeNull());
    expect(versions).toHaveBeenNthCalledWith(2, docId);
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("declining Restore claims nothing and preserves the current preview intent", async () => {
    const docId = "mutation-restore-declined";
    const current = { ...named, id: "restore-declined", title: "Restore declined" };
    const onPreview = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    versions.mockResolvedValueOnce({ versions: [current] });

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore declined"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();

    fireEvent.click(screen.getByTestId("version-restore"));

    expect(confirm).toHaveBeenCalledOnce();
    expect(restoreVersion).not.toHaveBeenCalled();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Restore declined")).toBeNull();
  });

  it("releases a failed Restore for one retry and reloads only after the retry succeeds", async () => {
    const docId = "mutation-restore-retry";
    const current = { ...named, id: "restore-retry", title: "Restore retry" };
    const firstRequest = deferred<{ ok: boolean }>();
    const retryRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    restoreVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Restore retry"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();

    fireEvent.click(screen.getByTestId("version-restore"));
    firstRequest.reject(new Error("restore unavailable"));
    expect(await screen.findByText("restore unavailable")).toBeInTheDocument();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Restore retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-restore"));
    expect(screen.queryByText("restore unavailable")).toBeNull();
    expect(restoreVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    reloadRequest.resolve({ versions: [current] });
    await waitFor(() => expect(spinnerFor("Restore retry")).toBeNull());
    expect(restoreVersion).toHaveBeenNthCalledWith(2, docId, current.id);
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("submits an Enter-plus-blur Rename once with the trimmed title", async () => {
    const docId = "mutation-rename-once";
    const current = { ...named, id: "rename-once", title: "Rename once" };
    const renamed = { ...current, title: "Final title" };
    const renameRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    const onPreview = vi.fn();
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    renameVersion.mockReturnValueOnce(renameRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Rename once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: "  Final title  " } });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });

    expect(renameVersion).toHaveBeenCalledOnce();
    expect(renameVersion).toHaveBeenCalledWith(docId, current.id, "Final title");
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Rename once")).not.toBeNull();

    renameRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    expect(spinnerFor("Rename once")).not.toBeNull();
    reloadRequest.resolve({ versions: [renamed] });
    expect(await screen.findByText("Final title")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Final title")).toBeNull());
    expect(onPreview).not.toHaveBeenCalled();
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("releases a failed Rename for one retry and refreshes only after the retry succeeds", async () => {
    const docId = "mutation-rename-retry";
    const current = { ...named, id: "rename-retry", title: "Rename retry" };
    const renamed = { ...current, title: "Recovered title" };
    const firstRequest = deferred<{ ok: boolean }>();
    const retryRequest = deferred<{ ok: boolean }>();
    const reloadRequest = deferred<{ versions: VersionSummary[] }>();
    versions.mockReset().mockResolvedValueOnce({ versions: [current] }).mockReturnValueOnce(reloadRequest.promise);
    renameVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Rename retry"));
    fireEvent.click(screen.getByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: "Recovered title" } });
    fireEvent.blur(screen.getByTestId("version-rename-input"));
    firstRequest.reject(new Error("rename unavailable"));

    expect(await screen.findByText("rename unavailable")).toBeInTheDocument();
    expect(renameVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Rename retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: " Recovered title " } });
    fireEvent.keyDown(screen.getByTestId("version-rename-input"), { key: "Enter" });
    expect(screen.queryByText("rename unavailable")).toBeNull();
    expect(renameVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ ok: true });
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    reloadRequest.resolve({ versions: [renamed] });
    expect(await screen.findByText("Recovered title")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Recovered title")).toBeNull());
    expect(renameVersion).toHaveBeenNthCalledWith(2, docId, current.id, "Recovered title");
    expect(versions).toHaveBeenNthCalledWith(2, docId);
  });

  it("starts one Copy for two immediate activations and navigates once", async () => {
    const docId = "mutation-copy-once";
    const current = { ...named, id: "copy-once", title: "Copy once" };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Copy once"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    const copyButton = screen.getByTestId("version-copy");
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(copyVersion).toHaveBeenCalledWith(docId, current.id);
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Copy once")).not.toBeNull();
    copyRequest.resolve({ id: "copied-document", title: "Copied title" });

    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(push).toHaveBeenCalledWith("/d/copied-document");
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Copied title” from version 1.", "success");
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Copy once")).toBeNull();
  });

  it("releases a failed Copy for one retry and publishes effects only after success", async () => {
    const docId = "mutation-copy-retry";
    const current = { ...named, id: "copy-retry", title: "Copy retry" };
    const firstRequest = deferred<{ id: string; title: string }>();
    const retryRequest = deferred<{ id: string; title: string }>();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(retryRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Copy retry"));
    fireEvent.click(screen.getByTestId("version-copy"));
    firstRequest.reject(new Error("copy unavailable"));

    expect(await screen.findByText("copy unavailable")).toBeInTheDocument();
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Copy retry")).toBeNull();

    fireEvent.click(screen.getByTestId("version-copy"));
    expect(screen.queryByText("copy unavailable")).toBeNull();
    expect(copyVersion).toHaveBeenCalledTimes(2);
    expectMutationControlsToBeDisabled(true);
    retryRequest.resolve({ id: "copy-retry-document", title: "Recovered copy" });

    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Recovered copy” from version 1.", "success");
    expect(push).toHaveBeenCalledWith("/d/copy-retry-document");
    expect(copyVersion).toHaveBeenNthCalledWith(2, docId, current.id);
    expect(versions).toHaveBeenCalledOnce();
    expectMutationControlsToBeDisabled(false);
  });

  it("blocks every other mutation kind while one Restore is pending", async () => {
    const docId = "mutation-cross-kind";
    const current = { ...named, id: "cross-kind", title: "Cross kind" };
    const restoreRequest = deferred<{ ok: boolean }>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByText("Cross kind"));
    const renameButton = screen.getByTestId("version-rename");
    const copyButton = screen.getByTestId("version-copy");
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(renameButton);
    fireEvent.click(copyButton);
    fireEvent.click(screen.getByTestId("version-restore"));

    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(renameVersion).not.toHaveBeenCalled();
    expect(copyVersion).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Cross kind")).not.toBeNull();

    restoreRequest.reject(new Error("release owner"));
    expect(await screen.findByText("release owner")).toBeInTheDocument();
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Cross kind")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Restore %s after Close", async (settlement) => {
    const docId = `mutation-close-restore-${settlement}`;
    const current = { ...named, id: `close-restore-${settlement}`, title: `Close restore ${settlement}` };
    const restoreRequest = deferred<{ ok: boolean }>();
    const onClose = vi.fn();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(restoreRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={onClose} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Close restore ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(spinnerFor(`Close restore ${settlement}`)).toBeNull();
    if (settlement === "resolve") restoreRequest.resolve({ ok: true });
    else restoreRequest.reject(new Error("obsolete restore failure"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox", { name: "Compare v1" })).toBeChecked();
    expect(screen.getByTestId("version-restore")).toBeInTheDocument();
    expect(screen.queryByText("obsolete restore failure")).toBeNull();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Copy %s after Close", async (settlement) => {
    const docId = `mutation-close-copy-${settlement}`;
    const current = { ...named, id: `close-copy-${settlement}`, title: `Close copy ${settlement}` };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Close copy ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(spinnerFor(`Close copy ${settlement}`)).toBeNull();

    if (settlement === "resolve") copyRequest.resolve({ id: "obsolete-copy", title: "Obsolete copy" });
    else copyRequest.reject(new Error("obsolete copy failure"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    expect(screen.queryByText("obsolete copy failure")).toBeNull();
    expect(versions).toHaveBeenCalledOnce();
  });

  it("keeps the new document's Copy owner when the replaced document's Restore settles", async () => {
    const oldDocId = "mutation-replacement-old";
    const newDocId = "mutation-replacement-new";
    const oldVersion = { ...named, id: "replacement-old-version", title: "Replacement old" };
    const newVersion = { ...named, id: "replacement-new-version", title: "Replacement new" };
    const oldRestore = deferred<{ ok: boolean }>();
    const currentCopy = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    restoreVersion.mockReturnValueOnce(oldRestore.promise);
    copyVersion.mockReturnValueOnce(currentCopy.promise);
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    fireEvent.click(await screen.findByText("Replacement old"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("version-restore"));
    rendered.rerender(<VersionsPanel {...props} session={session(newDocId)} />);
    fireEvent.click(await screen.findByText("Replacement new"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Replacement new")).not.toBeNull();

    oldRestore.resolve({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(restoreVersion).toHaveBeenCalledWith(oldDocId, oldVersion.id);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(onPreview).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Replacement new")).not.toBeNull();

    currentCopy.resolve({ id: "replacement-copy", title: "Current copy" });
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(copyVersion).toHaveBeenCalledWith(newDocId, newVersion.id);
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(pendingNotice).toHaveBeenCalledWith("Created “Current copy” from version 1.", "success");
    expect(push).toHaveBeenCalledWith("/d/replacement-copy");
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Replacement new")).toBeNull();
  });

  it.each([
    ["restore", "resolve"],
    ["restore", "reject"],
    ["copy", "resolve"],
    ["copy", "reject"],
  ] as const)("retires an old %s before its layout-settled %s reaches UI after replacement", async (kind, settlement) => {
    const oldDocId = `mutation-layout-old-${kind}-${settlement}`;
    const newDocId = `mutation-layout-new-${kind}-${settlement}`;
    const oldVersion = { ...named, id: `layout-old-${kind}-${settlement}`, title: `Layout old ${kind} ${settlement}` };
    const newVersion = { ...named, id: `layout-new-${kind}-${settlement}`, title: `Layout new ${kind} ${settlement}` };
    const mutation = deferred<unknown>();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockImplementation((docId: string) => Promise.resolve({ versions: [docId === oldDocId ? oldVersion : newVersion] }));
    if (kind === "restore") restoreVersion.mockReturnValueOnce(mutation.promise);
    else copyVersion.mockReturnValueOnce(mutation.promise);
    const props = { onClose: vi.fn(), onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} session={session(oldDocId)} />);
    fireEvent.click(await screen.findByText(`Layout old ${kind} ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId(kind === "restore" ? "version-restore" : "version-copy"));

    const settle = () => {
      if (settlement === "reject") mutation.reject(new Error("obsolete layout failure"));
      else if (kind === "restore") mutation.resolve({ ok: true });
      else mutation.resolve({ id: "obsolete-layout-copy", title: "Obsolete layout copy" });
    };
    rendered.rerender(
      <>
        <VersionsPanel {...props} session={session(newDocId)} />
        <SettleInLayout settle={settle} />
      </>,
    );

    expect(await screen.findByText(`Layout new ${kind} ${settlement}`)).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(versions).toHaveBeenCalledTimes(2);
    expect(versions).toHaveBeenNthCalledWith(1, oldDocId);
    expect(versions).toHaveBeenNthCalledWith(2, newDocId);
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.queryByText("obsolete layout failure")).toBeNull();
    expect(screen.queryByText(`Layout old ${kind} ${settlement}`)).toBeNull();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    if (kind === "restore") expect(restoreVersion).toHaveBeenCalledOnce();
    else expect(copyVersion).toHaveBeenCalledOnce();
  });

  it("does not let an old layout-settled finalizer unlock the newer Copy owner", async () => {
    const docId = "mutation-layout-newer-owner";
    const current = { ...named, id: "layout-newer-owner-version", title: "Layout newer owner" };
    const oldRestore = deferred<{ ok: boolean }>();
    const currentCopy = deferred<{ id: string; title: string }>();
    const onClose = vi.fn();
    const onPreview = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    versions.mockResolvedValueOnce({ versions: [current] });
    restoreVersion.mockReturnValueOnce(oldRestore.promise);
    copyVersion.mockReturnValueOnce(currentCopy.promise);
    const props = { session: session(docId), onClose, onPreview, refreshKey: 0 };

    const rendered = render(<VersionsPanel {...props} />);
    fireEvent.click(await screen.findByText("Layout newer owner"));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("version-restore"));
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    fireEvent.click(screen.getByTestId("version-copy"));
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Layout newer owner")).not.toBeNull();

    rendered.rerender(
      <>
        <VersionsPanel {...props} />
        <SettleInLayout settle={() => oldRestore.resolve({ ok: true })} />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expectMutationControlsToBeDisabled(true);
    expect(spinnerFor("Layout newer owner")).not.toBeNull();

    currentCopy.resolve({ id: "layout-current-copy", title: "Layout current copy" });
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(pendingNotice).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/d/layout-current-copy");
    expectMutationControlsToBeDisabled(false);
    expect(spinnerFor("Layout newer owner")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("ignores a late Copy %s after unmount", async (settlement) => {
    const docId = `mutation-unmount-${settlement}`;
    const current = { ...named, id: `mutation-unmount-version-${settlement}`, title: `Mutation unmount ${settlement}` };
    const copyRequest = deferred<{ id: string; title: string }>();
    const onPreview = vi.fn();
    versions.mockResolvedValueOnce({ versions: [current] });
    copyVersion.mockReturnValueOnce(copyRequest.promise);

    const rendered = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);
    fireEvent.click(await screen.findByText(`Mutation unmount ${settlement}`));
    await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
    onPreview.mockClear();
    fireEvent.click(screen.getByTestId("version-copy"));
    rendered.unmount();
    if (settlement === "resolve") copyRequest.resolve({ id: "too-late", title: "Too late" });
    else copyRequest.reject(new Error("too late"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(onPreview).not.toHaveBeenCalled();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("lets an owned post-Rename reload supersede an older list request", async () => {
    const docId = "mutation-owned-list";
    const current = { ...named, id: "owned-list-version", title: "Owned list current" };
    const renamed = { ...current, title: "Owned list renamed" };
    const stale = { ...current, title: "Stale list result" };
    const renameRequest = deferred<{ ok: boolean }>();
    const olderList = deferred<{ versions: VersionSummary[] }>();
    const ownedList = deferred<{ versions: VersionSummary[] }>();
    const nextRefresh = deferred<{ versions: VersionSummary[] }>();
    versions
      .mockReset()
      .mockResolvedValueOnce({ versions: [current] })
      .mockReturnValueOnce(olderList.promise)
      .mockReturnValueOnce(ownedList.promise)
      .mockReturnValueOnce(nextRefresh.promise);

    const first = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    await screen.findByText("Owned list current");
    await waitFor(() => expect(versions).toHaveBeenCalledOnce());
    first.unmount();

    renameVersion.mockReturnValueOnce(renameRequest.promise);
    const second = render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    expect(screen.getByText("Owned list current")).toBeInTheDocument();
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Owned list current"));
    fireEvent.click(await screen.findByTestId("version-rename"));
    fireEvent.change(screen.getByTestId("version-rename-input"), { target: { value: "Owned list renamed" } });
    fireEvent.keyDown(screen.getByTestId("version-rename-input"), { key: "Enter" });
    renameRequest.resolve({ ok: true });

    await waitFor(() => expect(versions).toHaveBeenCalledTimes(3));
    expect(spinnerFor("Owned list current")).not.toBeNull();
    ownedList.resolve({ versions: [renamed] });
    expect(await screen.findByText("Owned list renamed")).toBeInTheDocument();
    await waitFor(() => expect(spinnerFor("Owned list renamed")).toBeNull());
    olderList.resolve({ versions: [stale] });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Owned list renamed")).toBeInTheDocument();
    expect(screen.queryByText("Stale list result")).toBeNull();
    expect(versions).toHaveBeenCalledTimes(3);
    second.unmount();

    render(<VersionsPanel session={session(docId)} onClose={vi.fn()} onPreview={vi.fn()} refreshKey={0} />);
    expect(screen.getByText("Owned list renamed")).toBeInTheDocument();
    await waitFor(() => expect(versions).toHaveBeenCalledTimes(4));
    expect(versions).toHaveBeenNthCalledWith(2, docId);
    expect(versions).toHaveBeenNthCalledWith(3, docId);
    expect(renameVersion).toHaveBeenCalledOnce();
  });
});

describe("VersionsPanel · compare target", () => {
  it("shows a visible compare instruction and associates it with each checkbox", async () => {
    const older = { ...named, id: "ver-0", number: 0, title: "Earlier" };
    versions.mockResolvedValueOnce({ versions: [named, older] });
    version.mockImplementation(async (_docId: string, versionId: string) => ({
      version: { ...(versionId === named.id ? named : older), content: versionId === named.id ? "# Draft" : "# Earlier" },
    }));
    const onPreview = vi.fn();
    const session = { docId: DOC_ID, role: "owner" } as unknown as CollabSession;
    render(<VersionsPanel session={session} onClose={vi.fn()} onPreview={onPreview} refreshKey={0} />);

    expect(await screen.findByTestId("compare-instruction")).toHaveTextContent(
      "Select two versions below to compare their changes.",
    );
    const draft = await screen.findByRole("checkbox", { name: "Compare v1" });
    const earlier = await screen.findByRole("checkbox", { name: "Compare v0" });
    for (const checkbox of [draft, earlier]) {
      expect(checkbox).toHaveClass("h-3.5", "w-3.5");
      expect(checkbox.closest("label")).toHaveClass("h-6", "w-6");
      expect(checkbox).toHaveAttribute("aria-describedby", "compare-instruction");
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

describe("VersionsPanel - sidebar error wrapping", () => {
  const longMessage = "VersionHistoryFailure".repeat(16);
  const literalMessage = '  <img src=x onerror="alert(1)"> & <button>Retry</button>\n  "unchanged"  ';
  const messages = [
    ["unbroken", longMessage],
    ["ordinary", "The version history service is unavailable. Please try again."],
    ["literal", literalMessage],
  ] as const;
  const rawText = { normalizer: (text: string) => text };

  function expectMessage(message: string, kind: "list" | "action") {
    const text = screen.getByText(message, rawText);
    const panel = screen.getByTestId("versions-panel");
    expect(text.tagName).toBe("DIV");
    expect(text.textContent).toBe(message);
    expect(text.childNodes).toHaveLength(1);
    expect(text.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(text.childElementCount).toBe(0);
    expect(text.getAttributeNames()).toEqual(["class"]);
    expect(text.tabIndex).toBe(-1);
    expect(text.className).toBe(kind === "list"
      ? "wrap-anywhere"
      : "mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger wrap-anywhere");
    expect(panel.className).toBe("flex w-[340px] shrink-0 flex-col border-l border-line bg-surface-2");
    expect(panel.children).toHaveLength(2);
    const body = panel.children.item(1);
    expect(body?.className).toBe("scrollbar-thin flex-1 overflow-y-auto p-3");
    if (kind === "list") {
      const alert = screen.getByRole("alert");
      const retry = within(alert).getByRole("button", { name: "Retry" });
      expect(alert.parentElement).toBe(body);
      expect(alert.className).toBe("mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40");
      expect(alert).toHaveAttribute("aria-atomic", "true");
      expect([...alert.children]).toEqual([text, retry]);
      expect(retry.className).toBe("btn btn-outline btn-sm mt-2 gap-1.5");
      expect(retry).toHaveAttribute("type", "button");
      expect(retry.tabIndex).toBe(0);
      expect(retry).toBeEnabled();
    } else {
      expect(text.parentElement).toBe(body);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expectMutationControlsToBeDisabled(false);
    }
    return text;
  }

  function expectPassiveMessage(
    text: HTMLElement,
    onClose: ReturnType<typeof vi.fn>,
    onPreview: ReturnType<typeof vi.fn>,
  ) {
    const panel = screen.getByTestId("versions-panel");
    const nodes = [...panel.querySelectorAll("*")];
    const tabStops = nodes.filter((node) => node instanceof HTMLElement && node.tabIndex >= 0);
    const focused = document.activeElement;
    const markup = panel.outerHTML;
    const observer = new MutationObserver(() => {});
    observer.observe(panel, { attributes: true, childList: true, characterData: true, subtree: true });
    const spies = [
      vi.spyOn(HTMLElement.prototype, "focus"),
      vi.spyOn(globalThis, "setTimeout"),
      vi.spyOn(globalThis, "setInterval"),
      vi.spyOn(globalThis, "queueMicrotask"),
      vi.spyOn(window, "requestAnimationFrame"),
      vi.spyOn(globalThis, "fetch"),
    ];
    const effects = [
      versions, version, renameVersion, restoreVersion, copyVersion,
      push, pendingNotice, onClose, onPreview, ...spies,
    ];
    const counts = effects.map((effect) => effect.mock.calls.length);
    try {
      // Stay synchronous after settlement so polling and React cleanup are outside this interval.
      act(() => {
        fireEvent.pointerOver(text);
        fireEvent.mouseOver(text);
        fireEvent.mouseMove(text);
        fireEvent.mouseOut(text);
        fireEvent.pointerOut(text);
      });
      expect(effects.map((effect) => effect.mock.calls.length)).toEqual(counts);
      expect(observer.takeRecords()).toHaveLength(0);
      expect(panel.outerHTML).toBe(markup);
      expect([...panel.querySelectorAll("*")]).toEqual(nodes);
      expect(nodes.filter((node) => node instanceof HTMLElement && node.tabIndex >= 0)).toEqual(tabStops);
      expect(document.activeElement).toBe(focused);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      observer.disconnect();
      for (const spy of spies) spy.mockRestore();
    }
  }

  it.each(messages)("preserves the %s list failure as passive, wrapped raw text", async (label, message) => {
    const docId = `wrapped-list-${label}`;
    versions.mockRejectedValueOnce(new ApiError(503, message));
    const props = { session: session(docId), onClose: vi.fn(), onPreview: vi.fn(), refreshKey: 0 };
    const { unmount } = render(<VersionsPanel {...props} />);

    await screen.findByText(message, rawText);
    const text = expectMessage(message, "list");
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent))
      .toEqual(["Refresh versions", "Close version history", "Retry"]);
    expectPassiveMessage(text, props.onClose, props.onPreview);
    expect(versions).toHaveBeenCalledExactlyOnceWith(docId);
    unmount();
    expect(text).not.toBeInTheDocument();
    expect(screen.queryByText(message, rawText)).not.toBeInTheDocument();
  });

  it.each(messages)("preserves the %s action failure without changing rows, controls or the compare hint", async (label, message) => {
    const docId = `wrapped-action-${label}`;
    restoreVersion.mockRejectedValueOnce(new ApiError(503, message));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const props = { session: session(docId), onClose: vi.fn(), onPreview: vi.fn(), refreshKey: 0 };
    const { unmount } = render(<VersionsPanel {...props} />);
    const row = await screen.findByTestId("version-item");
    fireEvent.click(within(row).getByText("Draft"));
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledOnce());
    fireEvent.click(within(row).getByRole("checkbox", { name: "Compare v1" }));
    await waitFor(() => expect(props.onPreview).toHaveBeenCalledTimes(2));
    const rowMarkup = row.outerHTML;
    const hint = screen.getByTestId("compare-hint");
    const hintMarkup = hint.outerHTML;
    const buttons = screen.getAllByRole("button");
    const buttonMarkup = buttons.map((button) => button.outerHTML);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await screen.findByText(message, rawText);
    const text = expectMessage(message, "action");
    expect(row.outerHTML).toBe(rowMarkup);
    expect(hint.outerHTML).toBe(hintMarkup);
    expect(screen.getAllByRole("button")).toEqual(buttons);
    expect(buttons.map((button) => button.outerHTML)).toEqual(buttonMarkup);
    expectPassiveMessage(text, props.onClose, props.onPreview);
    expect(restoreVersion).toHaveBeenCalledExactlyOnceWith(docId, named.id);
    unmount();
    expect(text).not.toBeInTheDocument();
    expect(screen.queryByText(message, rawText)).not.toBeInTheDocument();
  });

  it("emits overflow-wrap anywhere from installed Tailwind for the error utility", async () => {
    expect(longMessage.length).toBeGreaterThanOrEqual(240);
    expect(longMessage).not.toMatch(/\s/);
    const { build } = await compile("@tailwind utilities;");
    expect(build(["wrap-anywhere"])).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
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

    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(versions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();

    retry.resolve({ versions: [] });
    expect(await screen.findByText("No versions yet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(versions).toHaveBeenNthCalledWith(2, "versions-retry-empty");
    fireEvent.click(screen.getByRole("button", { name: "Close version history" }));
    expect(onClose).toHaveBeenCalledOnce();
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
    expectMutationControlsToBeDisabled(true);
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Obsolete"));
      await Promise.resolve();
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(spinnerFor("Restore pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);

    await act(async () => {
      restoreRequest.resolve({ ok: true });
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.getByTestId("versions-panel").querySelector(".animate-spin")).toBeNull());
    expect(restoreVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledTimes(2);
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
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
    expectMutationControlsToBeDisabled(true);
    await act(async () => {
      previewRequest.resolve(contentResult(current, "# Preview"));
      await Promise.resolve();
    });
    expect(onPreview).toHaveBeenCalledOnce();
    expect(spinnerFor("Copy pending")).not.toBeNull();
    expectMutationControlsToBeDisabled(true);

    await act(async () => {
      copyRequest.reject(new Error("copy failed"));
      await Promise.resolve();
    });
    expect(screen.getByText("copy failed")).toBeInTheDocument();
    expect(spinnerFor("Copy pending")).toBeNull();
    expectMutationControlsToBeDisabled(false);
    expect(copyVersion).toHaveBeenCalledOnce();
    expect(versions).toHaveBeenCalledOnce();
    expect(pendingNotice).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
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
