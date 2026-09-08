// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  StrictMode,
  createElement,
  useEffect,
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

function InitialSyncDialog(props: ComponentProps<typeof SyncDialog>) {
  return <SyncDialog {...props} />;
}

function ReplacementSyncDialog(props: ComponentProps<typeof SyncDialog>) {
  return <SyncDialog {...props} />;
}

function SyncBoundary({
  actions,
  onOpenChange,
  doc = DOC,
  sync = DIVERGED,
  open = true,
  present = true,
  mount = "initial",
  passiveVisit = 0,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  actions: SyncActions;
  onOpenChange: (open: boolean) => void;
  doc?: DocumentDto;
  sync?: SyncStatusDto | null;
  open?: boolean;
  present?: boolean;
  mount?: "initial" | "replacement";
  passiveVisit?: number;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, passiveVisit]);

  if (!present) return null;
  const props = { open, onOpenChange, doc, sync, actions };
  return mount === "initial" ? <InitialSyncDialog {...props} /> : <ReplacementSyncDialog {...props} />;
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

function observeMutations(host: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {});
  observer.observe(host, { attributes: true, characterData: true, childList: true, subtree: true });
  mutationObservers.push(observer);
  return observer;
}

function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.getAttribute("data-testid") ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.getAttribute("data-testid") ?? element.tagName}`);
  return handler as T;
}

type SyncClickHandler = (event: { currentTarget: HTMLButtonElement; defaultPrevented: boolean }) => void;
type SyncChangeHandler = (event: { currentTarget: HTMLInputElement }) => void;
type SyncDialogCaptureHandler = (event: {
  currentTarget: HTMLDivElement;
  target: EventTarget | null;
}) => void;

interface CapturedSyncCallbacks {
  mergeElement: HTMLButtonElement | null;
  merge: SyncClickHandler | null;
  keepElement: HTMLButtonElement;
  keep: SyncClickHandler;
  takeElement: HTMLButtonElement | null;
  take: SyncClickHandler | null;
  compareElement: HTMLButtonElement | null;
  compare: SyncClickHandler | null;
  inputElement: HTMLInputElement;
  change: SyncChangeHandler;
  closeElement: HTMLButtonElement;
  close: SyncClickHandler;
}

interface CapturedSyncFrame extends CapturedSyncCallbacks {
  bridgeElement: HTMLDivElement;
  rootElement: HTMLDivElement;
  authorizePointer: SyncDialogCaptureHandler;
  releasePointer: SyncDialogCaptureHandler;
  refs: readonly {
    element: HTMLElement;
    ref: (element: HTMLElement | null) => void;
  }[];
}

function optionalClick(testId: string) {
  const element = screen.queryByTestId(testId) as HTMLButtonElement | null;
  return {
    element,
    handler: element ? reactHandler<SyncClickHandler>(element, "onClick") : null,
  };
}

function captureSyncCallbacks(): CapturedSyncCallbacks {
  const merge = optionalClick("sync-merge");
  const keepElement = screen.getByTestId("sync-keep-mine") as HTMLButtonElement;
  const take = optionalClick("sync-take-remote");
  const compare = optionalClick("sync-compare");
  const inputElement = screen.getByTestId("commit-message") as HTMLInputElement;
  const closeElement = screen.getByRole("button", { name: "Close" }) as HTMLButtonElement;
  return {
    mergeElement: merge.element,
    merge: merge.handler,
    keepElement,
    keep: reactHandler<SyncClickHandler>(keepElement, "onClick"),
    takeElement: take.element,
    take: take.handler,
    compareElement: compare.element,
    compare: compare.handler,
    inputElement,
    change: reactHandler<SyncChangeHandler>(inputElement, "onChange"),
    closeElement,
    close: reactHandler<SyncClickHandler>(closeElement, "onClick"),
  };
}

function captureElementRef<T extends HTMLElement>(
  element: T,
): (next: HTMLElement | null) => void {
  const ref = reactHandler<RefCallback<T>>(element, "ref");
  return (next) => ref(next as T | null);
}

function captureSyncFrame(host: HTMLElement): CapturedSyncFrame {
  const callbacks = captureSyncCallbacks();
  const bridgeElement = host.querySelector(".contents");
  const rootElement = screen.getByTestId("sync-dialog");
  if (!(bridgeElement instanceof HTMLDivElement)) {
    throw new Error("The Sync dialog event bridge was not committed");
  }
  if (!(rootElement instanceof HTMLDivElement)) {
    throw new Error("The Sync dialog root was not committed");
  }
  const elements: HTMLElement[] = [
    bridgeElement,
    rootElement,
    callbacks.inputElement,
    callbacks.keepElement,
  ];
  if (callbacks.mergeElement) elements.push(callbacks.mergeElement);
  if (callbacks.takeElement) elements.push(callbacks.takeElement);
  if (callbacks.compareElement) elements.push(callbacks.compareElement);
  return {
    ...callbacks,
    bridgeElement,
    rootElement,
    authorizePointer: reactHandler<SyncDialogCaptureHandler>(
      bridgeElement,
      "onPointerDownCapture",
    ),
    releasePointer: reactHandler<SyncDialogCaptureHandler>(
      bridgeElement,
      "onPointerDown",
    ),
    refs: elements.map((element) => ({
      element,
      ref: captureElementRef(element),
    })),
  };
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

function invokeCapturedCallbacks(callbacks: CapturedSyncCallbacks) {
  const originalValue = Object.getOwnPropertyDescriptor(callbacks.inputElement, "value");
  const readValue = vi.fn(() => "stale message");
  Object.defineProperty(callbacks.inputElement, "value", { configurable: true, get: readValue });
  try {
    callbacks.change({ currentTarget: callbacks.inputElement });
  } finally {
    if (originalValue) Object.defineProperty(callbacks.inputElement, "value", originalValue);
    else delete (callbacks.inputElement as unknown as Record<string, unknown>).value;
  }
  callbacks.merge?.({ currentTarget: callbacks.mergeElement!, defaultPrevented: false });
  callbacks.keep({ currentTarget: callbacks.keepElement, defaultPrevented: false });
  callbacks.take?.({ currentTarget: callbacks.takeElement!, defaultPrevented: false });
  callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
  callbacks.close({ currentTarget: callbacks.closeElement, defaultPrevented: false });
  return readValue;
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

describe("Sync dialog action lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([
    "document-object",
    "document-facts",
    "sync-snapshot",
    "sync-eligibility",
    "actions-object",
    "actions-method",
    "open-callback",
    "equal-value-remount",
    "removal",
  ] as const)("retires every callback publication before the parent layout boundary on %s replacement", async (replacement) => {
    const currentKeep = deferred<void>();
    const sharedMerge = vi.fn(async () => 0);
    const sharedTake = vi.fn(async () => undefined);
    const sharedCompare = vi.fn();
    const oldKeep = vi.fn(async () => undefined);
    const currentKeepAction = vi.fn(() => currentKeep.promise);
    const actionsA = syncActions({
      merge: sharedMerge,
      keepMine: replacement === "actions-method" ? oldKeep : currentKeepAction,
      takeRemote: sharedTake,
      compare: sharedCompare,
    });
    let actionsB = actionsA;
    let docB = DOC;
    let syncB: SyncStatusDto | null = DIVERGED;
    const onOpenA = vi.fn();
    let onOpenB = onOpenA;
    let mount: "initial" | "replacement" = "initial";
    let present = true;

    switch (replacement) {
      case "document-object":
        docB = { ...DOC };
        break;
      case "document-facts":
        docB = RENAMED_DOC;
        break;
      case "sync-snapshot":
        syncB = UPDATED_SYNC;
        break;
      case "sync-eligibility":
        syncB = UNREADABLE_SYNC;
        break;
      case "actions-object":
        actionsB = { ...actionsA };
        break;
      case "actions-method":
        syncB = { ...DIVERGED };
        break;
      case "open-callback":
        onOpenB = vi.fn();
        break;
      case "equal-value-remount":
        mount = "replacement";
        break;
      case "removal":
        present = false;
        break;
    }

    let passiveCleanups = 0;
    const view = renderDirect(
      <SyncBoundary actions={actionsA} onOpenChange={onOpenA} onPassiveCleanup={() => passiveCleanups++} />,
    );
    const stale = captureSyncCallbacks();
    if (replacement === "actions-method") actionsA.keepMine = currentKeepAction;
    const staleInput = stale.inputElement;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const observer = observeMutations(document.body);
    let boundaryValueRead!: ReturnType<typeof vi.fn>;
    let boundaryTimersBefore = -1;
    let boundaryTimersAfter = -1;
    let boundaryMutations = -1;
    let boundaryFocusBefore = -1;
    let boundaryFocusAfter = -1;

    act(() => {
      view.root.render(
        <SyncBoundary
          actions={actionsB}
          onOpenChange={onOpenB}
          doc={docB}
          sync={syncB}
          mount={mount}
          present={present}
          passiveVisit={1}
          boundary={1}
          onPassiveCleanup={() => passiveCleanups++}
          onBoundary={() => {
            expect(passiveCleanups).toBe(0);
            observer.takeRecords();
            focus.mockClear();
            boundaryTimersBefore = vi.getTimerCount();
            boundaryFocusBefore = focus.mock.calls.length;
            boundaryValueRead = invokeCapturedCallbacks(stale);
            boundaryTimersAfter = vi.getTimerCount();
            boundaryFocusAfter = focus.mock.calls.length;
            boundaryMutations = observer.takeRecords().length;
          }}
        />,
      );
    });

    expect(passiveCleanups).toBe(1);
    expect(boundaryValueRead).not.toHaveBeenCalled();
    expect(boundaryTimersAfter).toBe(boundaryTimersBefore);
    expect(boundaryFocusAfter).toBe(boundaryFocusBefore);
    expect(boundaryMutations).toBe(0);
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(currentKeepAction).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();

    observer.takeRecords();
    focus.mockClear();
    let laterValueRead!: ReturnType<typeof vi.fn>;
    const laterTimersBefore = vi.getTimerCount();
    act(() => {
      laterValueRead = invokeCapturedCallbacks(stale);
    });
    expect(laterValueRead).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(laterTimersBefore);
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(currentKeepAction).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();

    if (!present) {
      expect(screen.queryByTestId("sync-dialog")).toBeNull();
      return;
    }

    const currentInput = screen.getByTestId("commit-message") as HTMLInputElement;
    if (replacement === "equal-value-remount") expect(currentInput).not.toBe(staleInput);
    else expect(currentInput).toBe(staleInput);
    if (replacement === "document-facts") expect(currentInput).toHaveValue("Update renamed.md");
    if (replacement === "sync-snapshot") {
      expect(screen.getByTestId("sync-local-lines")).toHaveTextContent("No changes");
      expect(screen.getByTestId("sync-remote-lines")).toHaveTextContent("8 lines changed");
      expect(screen.getByText(/updated /)).toBeInTheDocument();
    }
    if (replacement === "sync-eligibility") {
      expect(screen.getByTestId("sync-dialog")).toHaveAttribute("data-status", "remote-unreadable");
      expect(screen.queryByTestId("sync-merge")).toBeNull();
      expect(screen.queryByTestId("sync-take-remote")).toBeNull();
      expect(screen.queryByTestId("sync-compare")).toBeNull();
    }

    const beforeMessage = captureSyncCallbacks();
    act(() => {
      beforeMessage.inputElement.value = "  Current presentation message  ";
      beforeMessage.change({ currentTarget: beforeMessage.inputElement });
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("  Current presentation message  ");
    const current = captureSyncCallbacks();
    act(() => {
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      invokeCapturedCallbacks(stale);
    });

    expect(currentKeepAction).toHaveBeenCalledExactlyOnceWith("Current presentation message");
    expect(sharedMerge).not.toHaveBeenCalled();
    expect(sharedTake).not.toHaveBeenCalled();
    expect(sharedCompare).not.toHaveBeenCalled();
    expect(oldKeep).not.toHaveBeenCalled();
    expect(onOpenA).not.toHaveBeenCalled();
    expect(onOpenB).not.toHaveBeenCalled();
    expect(screen.getByTestId("commit-message")).toHaveValue("  Current presentation message  ");

    await act(async () => {
      currentKeep.resolve();
    });
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenB).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenB).toHaveBeenCalledExactlyOnceWith(false);
    if (onOpenA !== onOpenB) expect(onOpenA).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenB).toHaveBeenCalledTimes(1);
  });

  it("binds message publications to the current input and Keep mine control", () => {
    const pending = deferred<void>();
    const keepMine = vi.fn(() => pending.promise);
    renderDirect(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={syncActions({ keepMine })} />);
    const old = captureSyncCallbacks();

    act(() => {
      old.inputElement.value = "  Fresh message  ";
      old.change({ currentTarget: old.inputElement });
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("  Fresh message  ");

    const readOldValue = invokeCapturedCallbacks({
      ...old,
      merge: null,
      take: null,
      compare: null,
      close: () => {},
    });
    expect(readOldValue).not.toHaveBeenCalled();
    expect(keepMine).not.toHaveBeenCalled();
    expect(screen.getByTestId("commit-message")).toHaveValue("  Fresh message  ");

    const current = captureSyncCallbacks();
    act(() => {
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
      current.keep({ currentTarget: current.keepElement, defaultPrevented: false });
    });
    expect(keepMine).toHaveBeenCalledExactlyOnceWith("Fresh message");
  });

  it("claims the exact current Close once and leaves all captured controls inert", () => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    const current = captureSyncCallbacks();
    const timersBefore = vi.getTimerCount();

    act(() => {
      fireEvent.click(current.closeElement);
      current.close({ currentTarget: current.closeElement, defaultPrevented: false });
      invokeCapturedCallbacks(current);
    });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(actions.compare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("keeps the current Radix Escape close bound to its presentation", () => {
    const onOpenChange = vi.fn();
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([
    "message",
    "merge",
    "keep",
    "take",
    "compare",
    "escape",
    "outside",
  ] as const)("keeps the current %s interaction usable once after Strict Mode replay", async (family) => {
    vi.useRealTimers();
    const merge = deferred<number>();
    const keep = deferred<void>();
    const take = deferred<void>();
    const actions = syncActions({
      merge: vi.fn(() => merge.promise),
      keepMine: vi.fn(() => keep.promise),
      takeRemote: vi.fn(() => take.promise),
    });
    const onOpenChange = vi.fn();
    renderDirect(
      <StrictMode>
        <SyncDialog
          open
          onOpenChange={onOpenChange}
          doc={DOC}
          sync={DIVERGED}
          actions={actions}
        />
      </StrictMode>,
    );

    if (family === "message") {
      fireEvent.change(screen.getByTestId("commit-message"), {
        target: { value: "Strict replay message" },
      });
      expect(screen.getByTestId("commit-message")).toHaveValue("Strict replay message");
    } else if (family === "merge") {
      fireEvent.click(screen.getByTestId("sync-merge"));
      fireEvent.click(screen.getByTestId("sync-merge"));
      expect(actions.merge).toHaveBeenCalledOnce();
    } else if (family === "keep") {
      fireEvent.click(screen.getByTestId("sync-keep-mine"));
      fireEvent.click(screen.getByTestId("sync-keep-mine"));
      expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update big.md");
    } else if (family === "take") {
      fireEvent.click(screen.getByTestId("sync-take-remote"));
      fireEvent.click(screen.getByTestId("sync-take-remote"));
      expect(actions.takeRemote).toHaveBeenCalledOnce();
    } else if (family === "compare") {
      fireEvent.click(screen.getByTestId("sync-compare"));
      fireEvent.click(screen.getByTestId("sync-compare"));
      expect(actions.compare).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } else if (family === "escape") {
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } else {
      const outside = document.createElement("button");
      document.body.append(outside);
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      fireEvent.click(outside);
      fireEvent.pointerDown(outside, { button: 0, pointerType: "mouse" });
      fireEvent.click(outside);
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      outside.remove();
    }

    await act(async () => {});
  });

  it("rejects crossed replay handlers, refs, and native intent without poisoning the current Strict Mode dialog", async () => {
    vi.useRealTimers();
    const staleActions = syncActions();
    const currentKeep = deferred<void>();
    const currentActions = syncActions({
      keepMine: vi.fn(() => currentKeep.promise),
    });
    const staleOpenChange = vi.fn();
    const currentOpenChange = vi.fn();
    const view = renderDirect(
      <StrictMode>
        <section key="a">
          <SyncDialog
            open
            onOpenChange={staleOpenChange}
            doc={DOC}
            sync={DIVERGED}
            actions={staleActions}
          />
        </section>
      </StrictMode>,
    );
    const stale = captureSyncFrame(view.host);
    stale.authorizePointer({
      currentTarget: stale.bridgeElement,
      target: stale.keepElement,
    });

    act(() => {
      view.root.render(
        <StrictMode>
          <section key="b">
            <SyncDialog
              open
              onOpenChange={currentOpenChange}
              doc={DOC}
              sync={DIVERGED}
              actions={currentActions}
            />
          </section>
        </StrictMode>,
      );
    });
    const current = captureSyncFrame(view.host);

    act(() => {
      stale.refs.forEach(({ ref }, index) => {
        ref(current.refs[index]?.element ?? current.rootElement);
      });
      [...stale.refs].reverse().forEach(({ ref }) => ref(null));
      stale.authorizePointer({
        currentTarget: current.bridgeElement,
        target: current.keepElement,
      });
      current.authorizePointer({
        currentTarget: stale.bridgeElement,
        target: stale.keepElement,
      });
      stale.change({ currentTarget: current.inputElement });
      stale.merge?.({
        currentTarget: current.mergeElement!,
        defaultPrevented: false,
      });
      stale.keep({
        currentTarget: current.keepElement,
        defaultPrevented: false,
      });
      stale.take?.({
        currentTarget: current.takeElement!,
        defaultPrevented: false,
      });
      stale.compare?.({
        currentTarget: current.compareElement!,
        defaultPrevented: false,
      });
      stale.close({
        currentTarget: current.closeElement,
        defaultPrevented: false,
      });

      current.change({ currentTarget: stale.inputElement });
      current.merge?.({
        currentTarget: stale.mergeElement!,
        defaultPrevented: false,
      });
      current.keep({
        currentTarget: stale.keepElement,
        defaultPrevented: false,
      });
      current.take?.({
        currentTarget: stale.takeElement!,
        defaultPrevented: false,
      });
      current.compare?.({
        currentTarget: stale.compareElement!,
        defaultPrevented: false,
      });
      current.close({
        currentTarget: stale.closeElement,
        defaultPrevented: false,
      });
    });

    expect(staleActions.merge).not.toHaveBeenCalled();
    expect(staleActions.keepMine).not.toHaveBeenCalled();
    expect(staleActions.takeRemote).not.toHaveBeenCalled();
    expect(staleActions.compare).not.toHaveBeenCalled();
    expect(currentActions.merge).not.toHaveBeenCalled();
    expect(currentActions.keepMine).not.toHaveBeenCalled();
    expect(currentActions.takeRemote).not.toHaveBeenCalled();
    expect(currentActions.compare).not.toHaveBeenCalled();
    expect(staleOpenChange).not.toHaveBeenCalled();
    expect(currentOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("commit-message")).toHaveValue("Update big.md");

    fireEvent.change(screen.getByTestId("commit-message"), {
      target: { value: "Current replay message" },
    });
    const accepted = captureSyncCallbacks();
    act(() => {
      accepted.keep({
        currentTarget: accepted.keepElement,
        defaultPrevented: false,
      });
      accepted.keep({
        currentTarget: accepted.keepElement,
        defaultPrevented: false,
      });
      stale.refs.forEach(({ ref }) => ref(null));
      stale.close({
        currentTarget: accepted.closeElement,
        defaultPrevented: false,
      });
    });
    expect(currentActions.keepMine).toHaveBeenCalledExactlyOnceWith(
      "Current replay message",
    );
    expect(currentOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent(
      "Published your version",
    );
    const closeCurrent = captureSyncFrame(view.host);
    act(() => {
      closeCurrent.authorizePointer({
        currentTarget: closeCurrent.bridgeElement,
        target: closeCurrent.closeElement,
      });
      stale.releasePointer({
        currentTarget: stale.bridgeElement,
        target: closeCurrent.closeElement,
      });
      closeCurrent.close({
        currentTarget: closeCurrent.closeElement,
        defaultPrevented: false,
      });
    });
    expect(currentOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("resets a normal replacement after retiring a pending Strict Mode successor action", async () => {
    const staleKeep = deferred<void>();
    const currentKeep = deferred<void>();
    const staleActions = syncActions({
      keepMine: vi.fn(() => staleKeep.promise),
    });
    const currentActions = syncActions({
      keepMine: vi.fn(() => currentKeep.promise),
    });
    const onOpenChange = vi.fn();
    const view = renderDirect(
      <StrictMode>
        <SyncDialog
          open
          onOpenChange={onOpenChange}
          doc={DOC}
          sync={DIVERGED}
          actions={staleActions}
        />
      </StrictMode>,
    );

    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(staleActions.keepMine).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();

    act(() => {
      view.root.render(
        <StrictMode>
          <SyncDialog
            open
            onOpenChange={onOpenChange}
            doc={DOC}
            sync={DIVERGED}
            actions={currentActions}
          />
        </StrictMode>,
      );
    });
    expect(screen.getByTestId("sync-keep-mine")).toBeEnabled();
    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(currentActions.keepMine).toHaveBeenCalledExactlyOnceWith(
      "Update big.md",
    );

    await act(async () => {
      staleKeep.resolve();
    });
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent(
      "Published your version",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("claims Compare synchronously, invokes it once, then closes through its frozen callback", () => {
    const order: string[] = [];
    const captured: CapturedSyncCallbacks[] = [];
    const onOpenChange = vi.fn(() => order.push("close"));
    const compare = vi.fn(() => {
      const callbacks = captured[0]!;
      order.push("compare");
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
      callbacks.close({ currentTarget: callbacks.closeElement, defaultPrevented: false });
    });
    const actions = syncActions({ compare });
    renderDirect(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    captured.push(captureSyncCallbacks());
    const callbacks = captured[0]!;
    const timersBefore = vi.getTimerCount();

    act(() => {
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
      callbacks.compare?.({ currentTarget: callbacks.compareElement!, defaultPrevented: false });
    });

    expect(order).toEqual(["compare", "close"]);
    expect(compare).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("synchronously admits only one action and exposes its pending state", () => {
    const pending = deferred<number>();
    const actions = syncActions({
      merge: vi.fn(() => {
        const takeButton = screen.getByTestId("sync-take-remote") as HTMLButtonElement;
        takeButton.click();
        takeButton.click();
        return pending.promise;
      }),
    });

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-merge"));

    expect(actions.merge).toHaveBeenCalledOnce();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-merge")).toBeDisabled();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
    expect(screen.getByTestId("sync-take-remote")).toBeDisabled();
    expect(screen.getByTestId("sync-compare")).toBeDisabled();
    expect(screen.getByTestId("sync-merge").querySelector(".animate-spin")).not.toBeNull();
  });

  it("keeps a specific failure visible and admits exactly one same-action retry", async () => {
    const retry = deferred<number>();
    const merge = vi
      .fn<SyncActions["merge"]>()
      .mockRejectedValueOnce(new ApiError(409, "GitHub rejected this merge"))
      .mockImplementationOnce(() => {
        (screen.getByTestId("sync-merge") as HTMLButtonElement).click();
        return retry.promise;
      });
    const actions = syncActions({ merge });

    render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("GitHub rejected this merge");
    expect(screen.getByTestId("sync-merge")).toBeEnabled();
    expect(merge).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId("sync-merge"));
    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      retry.resolve(2);
    });
    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sync-done")).toHaveTextContent("2 conflicts to resolve in the editor");
  });

  it("ignores stale success and error settlements after close and reopen", async () => {
    const oldSuccess = deferred<number>();
    const oldFailure = deferred<number>();
    const merge = vi
      .fn<SyncActions["merge"]>()
      .mockImplementationOnce(() => oldSuccess.promise)
      .mockImplementationOnce(() => oldFailure.promise);
    const actions = syncActions({ merge });
    const onOpenChange = vi.fn();
    const view = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    await act(async () => {
      oldSuccess.resolve(3);
    });
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    await act(async () => {
      oldFailure.reject(new ApiError(409, "Stale GitHub failure"));
    });
    act(() => vi.advanceTimersByTime(900));

    expect(merge).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("sync-merge")).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("isolates document state and a current pending action from an old finalizer", async () => {
    const oldMerge = deferred<number>();
    const currentKeep = deferred<void>();
    const actions = syncActions({
      merge: vi.fn(() => oldMerge.promise),
      keepMine: vi.fn(() => currentKeep.promise),
    });
    const view = render(<SyncDialog open onOpenChange={vi.fn()} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.change(screen.getByTestId("commit-message"), { target: { value: "Old document message" } });
    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(<SyncDialog open onOpenChange={vi.fn()} doc={SECOND_DOC} sync={DIVERGED} actions={actions} />);

    expect(screen.getByTestId("commit-message")).toHaveValue("Update second.md");
    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(actions.keepMine).toHaveBeenCalledWith("Update second.md");

    await act(async () => {
      oldMerge.resolve(4);
    });
    expect(screen.getByTestId("commit-message")).toHaveValue("Update second.md");
    expect(screen.queryByTestId("sync-done")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
    expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
  });

  it.each(["success", "failure"] as const)(
    "retires an old action %s before a same-id path replacement and cannot let its finalizer unlock newer work",
    async (outcome) => {
      const oldMerge = deferred<number>();
      const currentKeep = deferred<void>();
      const actions = syncActions({
        merge: vi.fn(() => oldMerge.promise),
        keepMine: vi.fn(() => currentKeep.promise),
      });
      const onOpenChange = vi.fn();
      const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

      fireEvent.click(screen.getByTestId("sync-merge"));
      fireEvent.click(screen.getByTestId("sync-merge"));
      view.rerender(
        <SyncBoundary
          actions={actions}
          onOpenChange={onOpenChange}
          doc={RENAMED_DOC}
          boundary={1}
          onBoundary={() => {
            if (outcome === "success") oldMerge.resolve(3);
            else oldMerge.reject(new ApiError(503, "Obsolete GitHub failure"));
          }}
        />,
      );
      fireEvent.click(screen.getByTestId("sync-keep-mine"));
      await act(async () => {
        await Promise.resolve();
      });

      expect(actions.merge).toHaveBeenCalledTimes(1);
      expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update renamed.md");
      expect(screen.getByTestId("commit-message")).toHaveValue("Update renamed.md");
      expect(screen.queryByTestId("sync-done")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();
      expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        currentKeep.resolve();
      });
      expect(screen.getByTestId("sync-done")).toHaveTextContent("Published your version");
    },
  );

  it.each([
    { label: "close", open: false, present: true, outcome: "success" },
    { label: "unmount", open: true, present: false, outcome: "failure" },
  ] as const)("retires a pending action before the parent layout boundary on $label", async ({ open, present, outcome }) => {
    const pending = deferred<number>();
    const readMessage = vi.fn(() => "Obsolete GitHub failure");
    const failure = new Error();
    Object.defineProperty(failure, "message", { get: readMessage });
    const actions = syncActions({ merge: vi.fn(() => pending.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByTestId("sync-merge"));
    view.rerender(
      <SyncBoundary
        actions={actions}
        onOpenChange={onOpenChange}
        open={open}
        present={present}
        boundary={1}
        onBoundary={() => {
          if (outcome === "success") pending.resolve(1);
          else pending.reject(failure);
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(900));

    expect(actions.merge).toHaveBeenCalledTimes(1);
    expect(readMessage).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears an old success-close timer before a replacement parent layout and only the newer visit closes", async () => {
    const currentKeep = deferred<void>();
    const actions = syncActions({ keepMine: vi.fn(() => currentKeep.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncBoundary actions={actions} onOpenChange={onOpenChange} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    const timersWithOldClose = vi.getTimerCount();
    expect(timersWithOldClose).toBeGreaterThan(0);

    let timersAtBoundary = -1;
    view.rerender(
      <SyncBoundary
        actions={actions}
        onOpenChange={onOpenChange}
        doc={RENAMED_DOC}
        boundary={1}
        onBoundary={() => {
          timersAtBoundary = vi.getTimerCount();
        }}
      />,
    );
    expect(timersAtBoundary).toBe(timersWithOldClose - 1);

    fireEvent.click(screen.getByTestId("sync-keep-mine"));
    expect(actions.keepMine).toHaveBeenCalledExactlyOnceWith("Update renamed.md");
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("sync-keep-mine")).toBeDisabled();

    await act(async () => {
      currentKeep.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it("invalidates an old close timer and closes exactly once for the current success", async () => {
    const currentKeep = deferred<void>();
    const actions = syncActions({ keepMine: vi.fn(() => currentKeep.promise) });
    const onOpenChange = vi.fn();
    const view = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    expect(screen.getByTestId("sync-done")).toHaveTextContent("Merged — review, then publish");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    view.rerender(<SyncDialog open={false} onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    view.rerender(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);
    fireEvent.click(screen.getByTestId("sync-keep-mine"));

    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(screen.getByTestId("sync-keep-mine").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      currentKeep.resolve();
    });
    act(() => vi.advanceTimersByTime(899));
    expect(onOpenChange).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("invalidates pending settlements and delayed closes on unmount", async () => {
    const pending = deferred<number>();
    const onOpenChange = vi.fn();
    const pendingView = render(
      <SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions({ merge: vi.fn(() => pending.promise) })} />,
    );

    fireEvent.click(screen.getByTestId("sync-merge"));
    pendingView.unmount();
    await act(async () => {
      pending.resolve(1);
    });
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();

    const timerView = render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={syncActions()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("sync-merge"));
    });
    timerView.unmount();
    act(() => vi.advanceTimersByTime(900));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves Compare without starting a Sync action", () => {
    const actions = syncActions();
    const onOpenChange = vi.fn();
    render(<SyncDialog open onOpenChange={onOpenChange} doc={DOC} sync={DIVERGED} actions={actions} />);

    fireEvent.click(screen.getByTestId("sync-compare"));

    expect(actions.compare).toHaveBeenCalledOnce();
    expect(actions.merge).not.toHaveBeenCalled();
    expect(actions.keepMine).not.toHaveBeenCalled();
    expect(actions.takeRemote).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
