// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { SyncStatusDto } from "@/lib/api";

const sync = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      documents: {
        ...actual.api.documents,
        sync: (...args: unknown[]) => sync(...args),
      },
    },
  };
});

import { useSyncPolling } from "./use-sync-polling";

const STATUS: SyncStatusDto = {
  status: "in-sync",
  remote: { sha: "4ce1359b", revision: "4ce1359b", url: "https://github.com/o/r/blob/main/a.md", updatedAt: null },
  localChanged: false,
  remoteChanged: false,
  lines: { local: 0, remote: 0 },
  pollMs: 1000,
};

const DOC_ID = "doc-1";

describe("useSyncPolling", () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    sync.mockReset();
    sync.mockResolvedValue(STATUS);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
  });

  /** Let the pending response resolve (or a due tick fire) after `ms` of fake time. */
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  function mount(props: { refreshKey?: number; enabled?: boolean } = {}) {
    const onStatus = vi.fn();
    type Props = { refreshKey: number; enabled: boolean };
    const hook = renderHook(({ refreshKey, enabled }: Props) => useSyncPolling({ documentId: DOC_ID, enabled, refreshKey, onStatus }), {
      initialProps: { refreshKey: props.refreshKey ?? 0, enabled: props.enabled ?? true },
    });
    return { ...hook, onStatus };
  }

  it("polls at once while visible, then every pollMs; a refresh key asks for a fresh read", async () => {
    const { onStatus, rerender } = mount();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenLastCalledWith(DOC_ID, { fresh: false });

    await advance(0);
    expect(onStatus).toHaveBeenCalledWith(STATUS);

    await advance(999);
    expect(sync).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(DOC_ID, { fresh: false });

    rerender({ refreshKey: 1, enabled: true });
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenLastCalledWith(DOC_ID, { fresh: true });
  });

  it("makes no request while the tab is hidden and polls at once when it becomes visible again", async () => {
    mount();
    await advance(1000);
    expect(sync).toHaveBeenCalledTimes(2);

    await advance(500);
    setVisibility("hidden");
    await advance(5000);
    expect(sync).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(sync).toHaveBeenLastCalledWith(DOC_ID, { fresh: false });

    await advance(1000);
    expect(sync).toHaveBeenCalledTimes(4);
  });

  it("does not poll a tab that mounts hidden until it is shown; the status stays in its initial state", async () => {
    visibility = "hidden";
    const { onStatus } = mount();
    await advance(5000);
    expect(sync).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();

    setVisibility("visible");
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(STATUS);
  });

  it("polls at once when the page is restored from the back/forward cache, not on the initial pageshow", async () => {
    mount();
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    // A restore fires visibilitychange right after pageshow, before the request can resolve: one poll, not two.
    setVisibility("visible");
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(2);
    // The cadence restarts from the restore.
    await advance(1000);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("stops polling on unmount and when the document is no longer linked", async () => {
    const { onStatus, unmount } = mount();
    await advance(0);
    expect(sync).toHaveBeenCalledTimes(1);

    unmount();
    await advance(10_000);
    expect(sync).toHaveBeenCalledTimes(1);

    const second = mount({ enabled: false });
    await advance(10_000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(second.onStatus).toHaveBeenCalledWith(null);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });
});
