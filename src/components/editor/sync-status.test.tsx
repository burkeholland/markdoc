// @vitest-environment jsdom
import { compile } from "tailwindcss";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  StrictMode,
  createElement,
  useLayoutEffect,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
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

interface DirectView {
  host: HTMLDivElement;
  root: Root;
}

const directViews: DirectView[] = [];
const documentViews: { frame: HTMLIFrameElement; root: Root }[] = [];
const mutationObservers: MutationObserver[] = [];

function renderDirect(node: ReactNode): DirectView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = { host, root: createRoot(host) };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.getAttribute("data-testid") ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.getAttribute("data-testid") ?? element.tagName}`);
  return handler as T;
}

type PublishActionName = "publish" | "pull" | "sync";

interface PublishCallbacks {
  publish: Mock<() => void>;
  pull: Mock<() => void>;
  sync: Mock<() => void>;
}

interface CapturedPublishFrame {
  button: HTMLButtonElement;
  icon: Element;
  status: HTMLSpanElement;
  capture: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  click: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  refs: readonly ((element: Element | null) => void)[];
}

function publishCallbacks(): PublishCallbacks {
  return {
    publish: vi.fn<() => void>(),
    pull: vi.fn<() => void>(),
    sync: vi.fn<() => void>(),
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

function publishButton(
  sync: SyncStatusDto,
  callbacks: PublishCallbacks,
  publishing = false,
) {
  return (
    <PublishStatusButton
      sync={sync}
      publishing={publishing}
      onPublishNow={callbacks.publish}
      onPull={callbacks.pull}
      onSync={callbacks.sync}
    />
  );
}

function capturePublishFrame(host: ParentNode = document): CapturedPublishFrame {
  const button = host.querySelector('[data-testid="publish-button"]');
  if (!(button instanceof (button?.ownerDocument.defaultView?.HTMLButtonElement ?? HTMLButtonElement))) {
    throw new Error("The Publish status button was not committed");
  }
  const icon = button.firstElementChild;
  const status = button.querySelector('[data-testid="publish-status"]');
  if (!icon || !(status instanceof (button.ownerDocument.defaultView?.HTMLSpanElement ?? HTMLSpanElement))) {
    throw new Error("The Publish status descendants were not committed");
  }
  return {
    button,
    icon,
    status,
    capture: reactHandler(button, "onClickCapture"),
    click: reactHandler(button, "onClick"),
    refs: [
      capturePublishRef(button),
      capturePublishRef(icon),
      capturePublishRef(status),
    ],
  };
}

function capturePublishRef<T extends Element>(element: T): (next: Element | null) => void {
  const ref = reactHandler<RefCallback<T>>(element, "ref");
  return (next) => ref(next as T | null);
}

function primaryPublishClick(
  target: Element,
  event = new (target.ownerDocument.defaultView?.MouseEvent ?? MouseEvent)("click", {
    bubbles: true,
    button: 0,
    cancelable: true,
  }),
) {
  target.dispatchEvent(event);
  return event;
}

function detachedReactClick(
  button: HTMLButtonElement,
  nativeEvent: MouseEvent = new (button.ownerDocument.defaultView?.MouseEvent ?? MouseEvent)(
    "click",
    { bubbles: true, button: 0, cancelable: true },
  ),
) {
  return {
    nativeEvent,
    type: "click",
    currentTarget: button,
    target: button,
    button: nativeEvent.button,
    buttons: nativeEvent.buttons,
    altKey: nativeEvent.altKey,
    ctrlKey: nativeEvent.ctrlKey,
    metaKey: nativeEvent.metaKey,
    shiftKey: nativeEvent.shiftKey,
    clientX: nativeEvent.clientX,
    clientY: nativeEvent.clientY,
    detail: nativeEvent.detail,
    bubbles: nativeEvent.bubbles,
    cancelable: nativeEvent.cancelable,
    eventPhase: nativeEvent.eventPhase,
    isTrusted: nativeEvent.isTrusted,
    timeStamp: nativeEvent.timeStamp,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: vi.fn(),
  } as unknown as ReactMouseEvent<HTMLButtonElement>;
}

function expectPublishCalls(
  callbacks: PublishCallbacks,
  accepted?: PublishActionName,
) {
  expect(callbacks.publish).toHaveBeenCalledTimes(accepted === "publish" ? 1 : 0);
  expect(callbacks.pull).toHaveBeenCalledTimes(accepted === "pull" ? 1 : 0);
  expect(callbacks.sync).toHaveBeenCalledTimes(accepted === "sync" ? 1 : 0);
}

function PublishLayoutProbe({
  capture,
  children,
}: {
  capture: () => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    capture();
  }, [capture]);
  return children;
}

function PublishMutationProbe({ mutate }: { mutate: () => void }) {
  useLayoutEffect(mutate, [mutate]);
  return null;
}

function PublishBoundary({
  boundary = 0,
  callbacks,
  onLayout,
  present = true,
  publishing = false,
  sync,
  visit = "a",
}: {
  boundary?: number;
  callbacks: PublishCallbacks;
  onLayout?: () => void;
  present?: boolean;
  publishing?: boolean;
  sync: SyncStatusDto;
  visit?: string;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onLayout?.();
  }, [boundary, onLayout]);
  return present
    ? (
        <section key={visit} data-testid="publish-higher">
          <i data-testid="publish-before" />
          <div data-testid="publish-parent">
            {publishButton(sync, callbacks, publishing)}
          </div>
          <i data-testid="publish-after" />
        </section>
      )
    : null;
}

async function hydratePublishDocument(
  sync: SyncStatusDto,
  callbacks: PublishCallbacks,
) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const ownerDocument = frame.contentDocument;
  if (!ownerDocument) throw new Error("The hydration frame did not have a document");
  const tree = (
    <StrictMode>
      <html>
        {createElement("head")}
        <body>{publishButton(sync, callbacks)}</body>
      </html>
    </StrictMode>
  );
  ownerDocument.open();
  ownerDocument.write(`<!doctype html>${renderToString(tree)}`);
  ownerDocument.close();
  let root!: Root;
  await act(async () => {
    root = hydrateRoot(ownerDocument, tree);
  });
  documentViews.push({ frame, root });
  return { ownerDocument, root };
}

afterEach(() => {
  for (const view of documentViews.splice(0)) {
    act(() => view.root.unmount());
    view.frame.remove();
  }
  for (const view of directViews.splice(0)) {
    act(() => view.root.unmount());
    view.host.remove();
  }
  for (const observer of mutationObservers.splice(0)) observer.disconnect();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Publish status action lifecycle", () => {
  it.each([
    ["in-sync", "publish"],
    ["local-ahead", "publish"],
    ["remote-ahead", "pull"],
    ["diverged", "sync"],
    ["remote-unreadable", "sync"],
  ] as const)("keeps %s mapped to exactly one %s through direct-root Strict Mode replay", (status, action) => {
    const sync = statusSnapshot(status);
    const callbacks = publishCallbacks();
    const layouts: CapturedPublishFrame[] = [];
    const view = renderDirect(
      <StrictMode>
        <PublishLayoutProbe capture={() => layouts.push(capturePublishFrame())}>
          {publishButton(sync, callbacks)}
        </PublishLayoutProbe>
      </StrictMode>,
    );
    const retired = layouts[0];
    const current = capturePublishFrame(view.host);
    if (!retired) throw new Error("Strict Mode did not expose the retired Publish status publication");

    expect(retired.button).toBe(current.button);
    expect(retired.capture).not.toBe(current.capture);
    expect(retired.click).not.toBe(current.click);
    act(() => {
      const stale = detachedReactClick(current.button);
      retired.capture(stale);
      retired.click(stale);
    });
    expectPublishCalls(callbacks);

    const repeated = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
    act(() => {
      primaryPublishClick(current.icon, repeated);
      primaryPublishClick(current.icon, repeated);
    });
    expectPublishCalls(callbacks, action);
  });

  it.each([
    ["in-sync", "publish"],
    ["local-ahead", "publish"],
    ["remote-ahead", "pull"],
    ["diverged", "sync"],
    ["remote-unreadable", "sync"],
  ] as const)("authenticates %s as %s from document-root hydration", async (status, action) => {
    const callbacks = publishCallbacks();
    const { ownerDocument } = await hydratePublishDocument(statusSnapshot(status), callbacks);
    const frame = capturePublishFrame(ownerDocument);
    expect(frame.button.ownerDocument).toBe(ownerDocument);

    act(() => primaryPublishClick(frame.status));
    expectPublishCalls(callbacks, action);
  });

  it("preserves labels, titles, colors, icon structure, type, focus, and keyboard-style activation", () => {
    const cases = [
      ["in-sync", "Up to date", "bg-emerald-300", "Up to date"],
      ["local-ahead", "Publish", "bg-amber-300", "Unpublished changes"],
      ["remote-ahead", "Pull", "lucide-refresh-cw", "GitHub has changes"],
      ["diverged", "Both changed", "lucide-git-merge", "Both changed"],
      ["remote-unreadable", "GitHub file too large", "lucide-triangle-alert", "GitHub file too large"],
    ] as const;

    for (const [status, label, iconClass, title] of cases) {
      const callbacks = publishCallbacks();
      const { unmount } = render(publishButton(statusSnapshot(status), callbacks));
      const frame = capturePublishFrame();
      expect(frame.button).toHaveAttribute("type", "button");
      expect(frame.button).toHaveAttribute("title", title);
      expect(frame.button).toHaveTextContent(label);
      expect(frame.status).toHaveAttribute("data-status", status);
      expect(frame.icon).toHaveClass(iconClass);
      frame.button.focus();
      act(() => primaryPublishClick(
        frame.button,
        new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 0 }),
      ));
      expect(frame.button).toHaveFocus();
      unmount();
    }
  });

  it("retires publishing transitions and restores a fresh exact action", () => {
    const sync = statusSnapshot("local-ahead");
    const callbacks = publishCallbacks();
    const view = renderDirect(<PublishBoundary callbacks={callbacks} sync={sync} />);
    const stale = capturePublishFrame(view.host);

    act(() => view.root.render(
      <PublishBoundary callbacks={callbacks} sync={sync} publishing />,
    ));
    const disabled = capturePublishFrame(view.host);
    expect(disabled.button).toBeDisabled();
    expect(disabled.icon).toHaveClass("animate-spin");
    act(() => {
      const event = detachedReactClick(disabled.button);
      stale.capture(event);
      stale.click(event);
      primaryPublishClick(disabled.button);
    });
    expectPublishCalls(callbacks);

    act(() => view.root.render(
      <PublishBoundary callbacks={callbacks} sync={sync} publishing={false} />,
    ));
    const current = capturePublishFrame(view.host);
    expect(current.button).toBeEnabled();
    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks, "publish");
  });

  it.each([
    "status",
    "remote",
    "remote.sha",
    "remote.revision",
    "remote.url",
    "remote.updatedAt",
    "localChanged",
    "remoteChanged",
    "lines",
    "lines.local",
    "lines.remote",
    "size",
    "limit",
    "pollMs",
    "remoteContent",
  ] as const)("permanently retires mutable %s drift before callback work", (field) => {
    const sync = statusSnapshot("local-ahead", {
      size: null,
      limit: 2_097_152,
      remoteContent: "remote",
    });
    const callbacks = publishCallbacks();
    const view = renderDirect(<PublishBoundary callbacks={callbacks} sync={sync} />);
    const current = capturePublishFrame(view.host);
    const remote = sync.remote;
    const lines = sync.lines;

    if (field === "status") sync.status = "remote-ahead";
    else if (field === "remote") sync.remote = { ...remote };
    else if (field === "remote.sha") remote.sha = "changed-sha";
    else if (field === "remote.revision") remote.revision = "changed-revision";
    else if (field === "remote.url") remote.url = "https://github.com/o/r/blob/main/changed.md";
    else if (field === "remote.updatedAt") remote.updatedAt = "2026-09-08T00:00:00.000Z";
    else if (field === "localChanged") sync.localChanged = false;
    else if (field === "remoteChanged") sync.remoteChanged = true;
    else if (field === "lines") sync.lines = { ...lines };
    else if (field === "lines.local") lines.local++;
    else if (field === "lines.remote") lines.remote++;
    else if (field === "size") sync.size = 1;
    else if (field === "limit") sync.limit = 1;
    else if (field === "pollMs") sync.pollMs = 60_000;
    else sync.remoteContent = "changed remote";

    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks);

    sync.status = "local-ahead";
    sync.remote = remote;
    remote.sha = REMOTE.sha;
    remote.revision = REMOTE.revision;
    remote.url = REMOTE.url;
    remote.updatedAt = REMOTE.updatedAt;
    sync.localChanged = true;
    sync.remoteChanged = false;
    sync.lines = lines;
    lines.local = 2;
    lines.remote = 0;
    sync.size = null;
    sync.limit = 2_097_152;
    sync.pollMs = 2_000;
    sync.remoteContent = "remote";
    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks);

    act(() => view.root.render(
      <PublishBoundary callbacks={callbacks} sync={{ ...sync, remote: { ...remote }, lines: { ...lines } }} />,
    ));
    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks, "publish");
  });

  it.each(["sync-object", "publish-callback", "pull-callback", "sync-callback"] as const)(
    "retires equal-looking %s replacement without letting A borrow B",
    (replacement) => {
      const syncA = statusSnapshot("remote-ahead");
      const callbacksA = publishCallbacks();
      const view = renderDirect(<PublishBoundary callbacks={callbacksA} sync={syncA} />);
      const stale = capturePublishFrame(view.host);
      const syncB = replacement === "sync-object"
        ? { ...syncA, remote: { ...syncA.remote }, lines: { ...syncA.lines } }
        : syncA;
      const callbacksB = {
        publish: replacement === "publish-callback" ? vi.fn() : callbacksA.publish,
        pull: replacement === "pull-callback" ? vi.fn() : callbacksA.pull,
        sync: replacement === "sync-callback" ? vi.fn() : callbacksA.sync,
      };

      act(() => view.root.render(
        <PublishBoundary callbacks={callbacksB} sync={syncB} />,
      ));
      const current = capturePublishFrame(view.host);
      expect(current.button).toBe(stale.button);
      expect(current.click).not.toBe(stale.click);
      act(() => {
        const crossed = detachedReactClick(current.button);
        stale.capture(crossed);
        stale.click(crossed);
      });
      expectPublishCalls(callbacksA);
      expectPublishCalls(callbacksB);

      act(() => primaryPublishClick(current.icon));
      expect(callbacksB.pull).toHaveBeenCalledOnce();
      expect(callbacksB.publish).not.toHaveBeenCalled();
      expect(callbacksB.sync).not.toHaveBeenCalled();
    },
  );

  it.each([
    "button attribute",
    "icon replacement",
    "status text",
    "button detach",
    "parent detach",
    "higher detach",
    "adjacent placement",
  ] as const)("latches post-publication %s mutation through restoration", (change) => {
    const sync = statusSnapshot("diverged");
    const callbacks = publishCallbacks();
    const view = renderDirect(<PublishBoundary callbacks={callbacks} sync={sync} />);
    const current = capturePublishFrame(view.host);
    const parent = view.host.querySelector('[data-testid="publish-parent"]')!;
    const higher = view.host.querySelector('[data-testid="publish-higher"]')!;

    if (change === "button attribute") {
      current.button.dataset.changed = "true";
      delete current.button.dataset.changed;
    } else if (change === "icon replacement") {
      const replacement = current.icon.cloneNode(true) as Element;
      current.icon.replaceWith(replacement);
      replacement.replaceWith(current.icon);
    } else if (change === "status text") {
      current.status.textContent = "Changed";
      current.status.textContent = "Both changed";
    } else if (change === "button detach") {
      const next = current.button.nextSibling;
      current.button.remove();
      parent.insertBefore(current.button, next);
    } else if (change === "parent detach") {
      const next = parent.nextSibling;
      parent.remove();
      higher.insertBefore(parent, next);
    } else if (change === "higher detach") {
      const next = higher.nextSibling;
      higher.remove();
      view.host.insertBefore(higher, next);
    } else {
      const adjacent = document.createElement("b");
      higher.parentNode!.insertBefore(adjacent, higher);
      adjacent.remove();
    }

    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks);
    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks);

    act(() => view.root.render(
      <PublishBoundary boundary={1} callbacks={callbacks} sync={sync} />,
    ));
    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks, "sync");
  });

  it("allows genuinely nonadjacent ancestor churn", () => {
    const callbacks = publishCallbacks();
    const view = renderDirect(
      <PublishBoundary callbacks={callbacks} sync={statusSnapshot("remote-ahead")} />,
    );
    const higher = view.host.querySelector('[data-testid="publish-higher"]')!;
    const before = view.host.querySelector('[data-testid="publish-before"]')!;
    const distant = document.createElement("b");
    higher.insertBefore(distant, before);
    distant.remove();

    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks, "pull");
  });

  it("does not canonize prepublication mutation and restoration", () => {
    const sync = statusSnapshot("diverged");
    const callbacks = publishCallbacks();
    let visits = 0;
    const mutate = () => {
      visits++;
      if (visits !== 1) return;
      const status = document.querySelector('[data-testid="publish-status"]');
      if (!(status instanceof HTMLSpanElement)) {
        throw new Error("The prepublication status text was not committed");
      }
      const nested = document.createElement("b");
      nested.textContent = "Both changed";
      status.replaceChildren(nested);
    };
    const tree = (boundary: number) => (
      <>
        <PublishMutationProbe mutate={mutate} />
        <PublishBoundary boundary={boundary} callbacks={callbacks} sync={sync} />
      </>
    );
    const view = renderDirect(tree(0));

    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks);

    capturePublishFrame(view.host).status.textContent = "Both changed";
    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks);

    act(() => view.root.render(tree(1)));
    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacks, "sync");
  });

  it.each(["button", "icon", "status"] as const)(
    "rejects partial %s ref replay and recovers only on a fresh render",
    (part) => {
      const sync = statusSnapshot("local-ahead");
      const callbacks = publishCallbacks();
      const view = renderDirect(<PublishBoundary callbacks={callbacks} sync={sync} />);
      const stale = capturePublishFrame(view.host);
      const index = part === "button" ? 0 : part === "icon" ? 1 : 2;
      act(() => {
        stale.refs[index]?.(null);
        stale.refs[index]?.(part === "button" ? stale.button : part === "icon" ? stale.icon : stale.status);
        primaryPublishClick(stale.button);
      });
      expectPublishCalls(callbacks);

      act(() => view.root.render(
        <PublishBoundary boundary={1} callbacks={callbacks} sync={sync} />,
      ));
      act(() => primaryPublishClick(capturePublishFrame(view.host).button));
      expectPublishCalls(callbacks, "publish");
    },
  );

  it("rejects a fabricated live wrapper without poisoning the publication", () => {
    const callbacks = publishCallbacks();
    const sync = statusSnapshot("local-ahead");
    const view = renderDirect(<PublishBoundary callbacks={callbacks} sync={sync} />);
    const current = capturePublishFrame(view.host);
    view.host.addEventListener("click", (nativeEvent) => {
      if (!(nativeEvent instanceof MouseEvent)) return;
      const forgedCapture = detachedReactClick(current.button, nativeEvent);
      const forgedBubble = detachedReactClick(current.button, nativeEvent);
      current.capture(forgedCapture);
      current.click(forgedBubble);
    }, { capture: true, once: true });

    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks);
    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacks, "publish");
  });

  it("rejects crossed handlers and native-event reuse without poisoning fresh B", () => {
    const syncA = statusSnapshot("local-ahead");
    const syncB = statusSnapshot("remote-ahead");
    const callbacksA = publishCallbacks();
    const callbacksB = publishCallbacks();
    const view = renderDirect(<PublishBoundary callbacks={callbacksA} sync={syncA} />);
    const stale = capturePublishFrame(view.host);
    const reused = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });

    act(() => primaryPublishClick(stale.button, reused));
    expectPublishCalls(callbacksA, "publish");
    act(() => view.root.render(
      <PublishBoundary boundary={1} callbacks={callbacksB} sync={syncB} visit="b" />,
    ));
    const current = capturePublishFrame(view.host);
    view.host.addEventListener("click", (nativeEvent) => {
      if (!(nativeEvent instanceof MouseEvent)) return;
      stale.capture(detachedReactClick(current.button, nativeEvent));
      stale.click(detachedReactClick(current.button, nativeEvent));
    }, { capture: true, once: true });

    act(() => primaryPublishClick(current.button, reused));
    expectPublishCalls(callbacksB);
    act(() => primaryPublishClick(current.button));
    expectPublishCalls(callbacksB, "pull");
  });

  it("blocks nested B until A returns, then gives B one fresh activation", () => {
    const syncA = statusSnapshot("local-ahead");
    const syncB = statusSnapshot("remote-ahead");
    const callbacksB = publishCallbacks();
    const host = document.createElement("div");
    document.body.append(host);
    const view: DirectView = { host, root: createRoot(host) };
    directViews.push(view);
    const callbacksA = publishCallbacks();
    callbacksA.publish.mockImplementation(() => {
      flushSync(() => {
        view.root.render(<PublishBoundary callbacks={callbacksB} sync={syncB} visit="b" />);
      });
      primaryPublishClick(capturePublishFrame(view.host).button);
    });
    act(() => view.root.render(
      <PublishBoundary callbacks={callbacksA} sync={syncA} visit="a" />,
    ));

    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacksA, "publish");
    expectPublishCalls(callbacksB);

    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expect(callbacksA.publish).toHaveBeenCalledOnce();
    expectPublishCalls(callbacksB, "pull");
  });

  it("retires an equal-looking remount and removal before the parent layout boundary", () => {
    const callbacksA = publishCallbacks();
    const callbacksB = publishCallbacks();
    const sync = statusSnapshot("in-sync");
    const view = renderDirect(
      <PublishBoundary callbacks={callbacksA} sync={sync} visit="a" />,
    );
    const stale = capturePublishFrame(view.host);
    let staleCallsAtBoundary = -1;

    act(() => view.root.render(
      <PublishBoundary
        boundary={1}
        callbacks={callbacksB}
        sync={sync}
        visit="b"
        onLayout={() => {
          const event = detachedReactClick(stale.button);
          stale.capture(event);
          stale.click(event);
          staleCallsAtBoundary = callbacksA.publish.mock.calls.length;
        }}
      />,
    ));
    expect(staleCallsAtBoundary).toBe(0);
    act(() => primaryPublishClick(capturePublishFrame(view.host).button));
    expectPublishCalls(callbacksB, "publish");

    act(() => view.root.render(
      <PublishBoundary
        boundary={2}
        callbacks={callbacksB}
        present={false}
        sync={sync}
        visit="b"
        onLayout={() => {
          const event = detachedReactClick(stale.button);
          stale.capture(event);
          stale.click(event);
        }}
      />,
    ));
    expect(callbacksA.publish).not.toHaveBeenCalled();
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
});
