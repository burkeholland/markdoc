// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DocumentDto } from "@/server/dto";

vi.mock("./gist-auto-update", () => ({
  GistAutoUpdateControl: ({ doc, isOwner }: { doc: DocumentDto; isOwner: boolean }) =>
    isOwner && doc.storage === "gist" && doc.gistId && doc.gistFile && doc.githubUrl && doc.publishedAt ? (
      <div data-testid="gist-auto-update-stub" data-document={doc.id} data-owner={isOwner} />
    ) : null,
}));

import { CommitDialog } from "./github-dialog";

interface CommitActions {
  onCommit: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
  onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;
}

interface CommitBoundaryProps {
  visit: string;
  doc: DocumentDto;
  actions: CommitActions;
  open?: boolean;
  present?: boolean;
  isOwner?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}

interface ControlledPointerEventInit extends MouseEventInit {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
}

class ControlledPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;

  constructor(type: string, init: ControlledPointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function repoDocument(id: string, path: string): DocumentDto {
  return {
    id,
    title: id,
    storage: "repo",
    linkAccess: "private",
    ownerId: "owner",
    gistId: null,
    gistFile: null,
    repoOwner: "octo",
    repoName: "notes",
    repoBranch: "main",
    repoPath: path,
    publishedAt: "2026-09-07T12:00:00.000Z",
    hasUnpublishedChanges: true,
    githubUrl: `https://github.com/octo/notes/blob/main/${path}`,
    createdAt: "2026-09-07T11:00:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
  };
}

function actions(...answers: Promise<void>[]): CommitActions {
  const onCommit = vi.fn<(message: string) => Promise<void>>();
  for (const answer of answers) onCommit.mockReturnValueOnce(answer);
  return { onCommit, onOpenChange: vi.fn() };
}

function CommitBoundary({
  visit,
  doc,
  actions: currentActions,
  open = true,
  present = true,
  isOwner = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: CommitBoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, visit]);
  return present ? (
    <CommitDialog
      open={open}
      onOpenChange={currentActions.onOpenChange}
      doc={doc}
      onCommit={currentActions.onCommit}
      isOwner={isOwner}
    />
  ) : null;
}

function StrictCommitReplayProbe({
  children,
  onFirstLayout,
  onReplayLayout,
}: {
  children: ReactNode;
  onFirstLayout: () => void;
  onReplayLayout: () => void;
}) {
  const layouts = useRef(0);
  useLayoutEffect(() => {
    layouts.current++;
    if (layouts.current === 1) onFirstLayout();
    if (layouts.current === 2) onReplayLayout();
  }, [onFirstLayout, onReplayLayout]);
  return children;
}

function createHost() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

async function render(root: Root, props: CommitBoundaryProps) {
  await act(async () => {
    root.render(
      <StrictMode>
        <CommitBoundary {...props} />
      </StrictMode>,
    );
  });
}

function message() {
  return screen.getByTestId<HTMLInputElement>("commit-message");
}

function reactProp<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const value = props?.[name];
  if (typeof value !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return value as T;
}

function setReactProp(element: HTMLElement, name: string, value: unknown) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const record = element as unknown as Record<string, Record<string, unknown> | undefined>;
  const props = record[propsKey];
  if (!props) throw new Error(`React props were empty on ${element.dataset.testid ?? element.tagName}`);
  record[propsKey] = { ...props, [name]: value };
}

function reactRef<T extends HTMLElement>(element: T): RefCallback<T> {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown } | undefined>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`A callback ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return fiber.ref as RefCallback<T>;
}

function reactAncestorProp<T>(element: HTMLElement, name: string): T {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  let fiber:
    | {
        return?: unknown;
        memoizedProps?: Record<string, unknown>;
      }
    | null = (element as unknown as Record<string, unknown>)[fiberKey] as {
    return?: unknown;
    memoizedProps?: Record<string, unknown>;
  };
  while (fiber) {
    const value = fiber.memoizedProps?.[name];
    if (typeof value === "function") return value as T;
    fiber = (fiber.return as typeof fiber) ?? null;
  }
  throw new Error(`${name} was not attached to a React ancestor of ${element.dataset.testid ?? element.tagName}`);
}

function nativeSubmit(form: HTMLFormElement, submitter: HTMLButtonElement | null = null) {
  const SubmitEventConstructor = form.ownerDocument.defaultView?.SubmitEvent;
  if (!SubmitEventConstructor) throw new Error("The commit form has no owner-document SubmitEvent");
  return new SubmitEventConstructor("submit", {
    bubbles: true,
    cancelable: true,
    submitter,
  });
}

function commitForm() {
  const submitter = screen.getByTestId("commit-submit") as HTMLButtonElement;
  if (!submitter.form) throw new Error("The commit submit control has no form");
  return submitter.form;
}

function commitRefBindings(host: HTMLDivElement) {
  const bridge = host.firstElementChild;
  const form = commitForm();
  const elements = [
    bridge,
    form.children.item(0),
    form,
    form.children.item(1),
    form.children.item(2),
    form.children.item(3),
    form.children.item(4),
    screen.getByRole("button", { name: "Cancel" }),
    screen.getByTestId("commit-submit"),
  ];
  return elements.map((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("The commit publication is missing a ref-bound element");
    return { element, ref: reactRef(element) };
  });
}

async function flushPublication() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function submit() {
  await act(async () => {
    await Promise.resolve();
    const submitter = screen.getByTestId("commit-submit") as HTMLButtonElement;
    const form = submitter.form!;
    form.dispatchEvent(nativeSubmit(form, submitter));
    await Promise.resolve();
  });
}

async function clickSubmit() {
  await flushPublication();
  fireEvent.click(screen.getByTestId("commit-submit"));
  await flushPublication();
}

async function resolve(pending: ReturnType<typeof deferred<void>>) {
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
}

async function reject(pending: ReturnType<typeof deferred<void>>, text: string) {
  await act(async () => {
    pending.reject(new Error(text));
    await pending.promise.catch(() => undefined);
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function commitTimerCall(spy: MockInstance<typeof setTimeout>, index = 0) {
  const matches = spy.mock.calls
    .map((call, callIndex) => ({ call, callIndex }))
    .filter(({ call }) => call[1] === 900);
  const match = matches[index];
  expect(match).toBeDefined();
  const callback = match!.call[0];
  expect(callback).toBeTypeOf("function");
  return {
    callback: callback as () => void,
    handle: spy.mock.results[match!.callIndex].value as ReturnType<typeof setTimeout>,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommitDialog visit authority", () => {
  it("claims one trimmed submit and closes its exact current success once at 900 ms", async () => {
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-current", "docs/current.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "current", doc, actions: current });
      await advance(0);
      expect(message()).toHaveValue("Update docs/current.md");
      expect(message()).toHaveFocus();
      fireEvent.change(message(), { target: { value: "  Publish current draft  " } });
      expect(message()).toHaveValue("  Publish current draft  ");

      await submit();
      await submit();

      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Publish current draft");
      expect(screen.getByTestId("commit-submit")).toBeDisabled();
      await resolve(pending);
      expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();

      await advance(899);
      expect(current.onOpenChange).not.toHaveBeenCalled();
      await advance(1);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

      await submit();
      expect(current.onCommit).toHaveBeenCalledTimes(1);
      await advance(5_000);
      expect(current.onOpenChange).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("hands settled success and its timer to the callback-caused document refresh batch", async () => {
    const publish = deferred<void>();
    const current = actions();
    const doc = repoDocument("doc-refresh", "docs/refresh.md");
    const refreshed = {
      ...doc,
      hasUnpublishedChanges: false,
      publishedAt: "2026-09-07T12:00:01.000Z",
      updatedAt: "2026-09-07T12:00:01.000Z",
    };
    const { host, root } = createHost();

    current.onCommit.mockImplementationOnce(async () => {
      await publish.promise;
      root.render(
        <StrictMode>
          <CommitBoundary
            visit="refreshed"
            doc={refreshed}
            actions={current}
          />
        </StrictMode>,
      );
    });

    try {
      await render(root, { visit: "initial", doc, actions: current });
      fireEvent.change(message(), { target: { value: "  Publish refresh  " } });
      await submit();

      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Publish refresh");
      expect(message()).toHaveValue("  Publish refresh  ");
      expect(screen.getByTestId("commit-submit")).toBeDisabled();

      await resolve(publish);
      expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
      await advance(900);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps Published and its timer for a skipped publish with a fresh equal document", async () => {
    const publish = deferred<void>();
    const current = actions();
    const doc = repoDocument("doc-skipped-refresh", "docs/skipped-refresh.md");
    const { host, root } = createHost();

    current.onCommit.mockImplementationOnce(async () => {
      await publish.promise;
      root.render(
        <StrictMode>
          <CommitBoundary
            visit="skipped"
            doc={{ ...doc }}
            actions={current}
          />
        </StrictMode>,
      );
    });

    try {
      await render(root, { visit: "initial", doc, actions: current });
      fireEvent.change(message(), { target: { value: "  Already current  " } });
      await submit();

      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Already current");
      await resolve(publish);
      expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();

      await advance(899);
      expect(current.onOpenChange).not.toHaveBeenCalled();
      await advance(1);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("preserves a typed draft through a same-destination title refresh", async () => {
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-title-refresh", "docs/title-refresh.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "initial", doc, actions: current });
      fireEvent.change(message(), { target: { value: "  Keep this draft  " } });
      await render(root, {
        visit: "remote-title",
        doc: { ...doc, title: "Collaborator renamed this document" },
        actions: current,
      });

      expect(message()).toHaveValue("  Keep this draft  ");
      await submit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Keep this draft");
      await resolve(pending);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("preserves a typed draft when repository publication metadata first appears", async () => {
    const current = actions();
    const doc = {
      ...repoDocument(
        "doc-publication-metadata",
        "docs/publication-metadata.md",
      ),
      publishedAt: null,
    };
    const { host, root } = createHost();

    try {
      await render(root, { visit: "initial", doc, actions: current });
      fireEvent.change(message(), { target: { value: "  Keep unpublished draft  " } });
      await render(root, {
        visit: "published-remotely",
        doc: { ...doc, publishedAt: "2026-09-08T10:30:00.000Z" },
        actions: current,
      });

      expect(message()).toHaveValue("  Keep unpublished draft  ");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not hand a pending operation to an unrelated metadata refresh", async () => {
    const stalePending = deferred<void>();
    const currentPending = deferred<void>();
    const current = actions(stalePending.promise, currentPending.promise);
    const doc = repoDocument("doc-unrelated-refresh", "docs/unrelated.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "initial", doc, actions: current });
      await submit();
      await render(root, {
        visit: "metadata",
        doc: {
          ...doc,
          updatedAt: "2026-09-07T12:00:01.000Z",
        },
        actions: current,
      });

      expect(screen.getByTestId("commit-submit")).toBeEnabled();
      await resolve(stalePending);
      expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
      expect(current.onOpenChange).not.toHaveBeenCalled();

      await submit();
      expect(current.onCommit).toHaveBeenCalledTimes(2);
      await resolve(currentPending);
      expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
      await advance(900);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["success", "rejection"] as const)(
    "keeps a reopened visit pending and clean through the retired visit's late $stale",
    async (stale) => {
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const retryPending = deferred<void>();
      const current = actions(oldPending.promise, currentPending.promise, retryPending.promise);
      const doc = repoDocument("doc-reopen", "docs/reopen.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: current });
        fireEvent.change(message(), { target: { value: "Old draft" } });
        await submit();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

        await render(root, { visit: "closed", doc, actions: current, open: false });
        await render(root, { visit: "current", doc, actions: current });
        expect(message()).toHaveValue("Update docs/reopen.md");
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        fireEvent.change(message(), { target: { value: "  Current pending  " } });
        await submit();
        expect(current.onCommit).toHaveBeenNthCalledWith(2, "Current pending");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();

        if (stale === "success") await resolve(oldPending);
        else await reject(oldPending, "Old publish failed");
        expect(message()).toHaveValue("  Current pending  ");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();
        expect(screen.queryByText("Old publish failed")).toBeNull();
        expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
        expect(current.onOpenChange).toHaveBeenCalledTimes(1);

        fireEvent.change(message(), { target: { value: "  Current retry  " } });
        await reject(currentPending, "Current publish failed");
        expect(screen.getByText("Current publish failed")).toBeInTheDocument();
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        await submit();
        expect(current.onCommit).toHaveBeenNthCalledWith(3, "Current retry");
        await resolve(retryPending);
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        await advance(900);
        expect(current.onOpenChange).toHaveBeenCalledTimes(2);
        expect(current.onOpenChange).toHaveBeenLastCalledWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["different-document", "same-document-callback", "removal"] as const)(
    "retires a successful timer before parent layout on $transition and leaves the next visit usable",
    async (transition) => {
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const oldDoc = repoDocument("doc-old", "docs/old.md");
      const currentDoc = transition === "same-document-callback" ? oldDoc : repoDocument("doc-current", "docs/current.md");
      const { host, root } = createHost();
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };

      try {
        await render(root, { visit: "old", doc: oldDoc, actions: oldActions, onPassiveCleanup });
        await advance(0);
        fireEvent.change(message(), { target: { value: "Old content" } });
        await submit();
        await resolve(oldPending);
        const oldTimer = commitTimerCall(timeout);
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        const passiveBeforeTransition = passiveCleanups;

        let boundaryReached!: () => void;
        const atBoundary = new Promise<void>((done) => {
          boundaryReached = done;
        });
        let passiveAtBoundary = -1;
        let oldTimerClearedAtBoundary = false;
        let oldCloseCallsAtBoundary = -1;
        let currentCloseCallsAtBoundary = -1;
        root.render(
          <StrictMode>
            <CommitBoundary
              visit="current"
              doc={currentDoc}
              actions={currentActions}
              present={transition !== "removal"}
              boundary={1}
              onPassiveCleanup={onPassiveCleanup}
              onBoundary={() => {
                passiveAtBoundary = passiveCleanups;
                oldTimerClearedAtBoundary = clearTimeout.mock.calls.some(([handle]) => handle === oldTimer.handle);
                oldTimer.callback();
                oldCloseCallsAtBoundary = oldActions.onOpenChange.mock.calls.length;
                currentCloseCallsAtBoundary = currentActions.onOpenChange.mock.calls.length;
                boundaryReached();
              }}
            />
          </StrictMode>,
        );
        await atBoundary;

        expect(passiveAtBoundary).toBe(passiveBeforeTransition);
        expect(oldTimerClearedAtBoundary).toBe(true);
        expect(oldCloseCallsAtBoundary).toBe(0);
        expect(currentCloseCallsAtBoundary).toBe(0);
        await act(async () => {});

        if (transition === "removal") {
          expect(screen.queryByRole("dialog")).toBeNull();
          await render(root, { visit: "current-mounted", doc: currentDoc, actions: currentActions, boundary: 2, onPassiveCleanup });
        }

        expect(message()).toHaveValue(`Update ${currentDoc.repoPath}`);
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
        fireEvent.change(message(), { target: { value: "  Current content  " } });
        await submit();
        expect(currentActions.onCommit).toHaveBeenCalledExactlyOnceWith("Current content");
        await resolve(currentPending);
        oldTimer.callback();
        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        expect(currentActions.onOpenChange).not.toHaveBeenCalled();
        await advance(900);
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates pending replacement settlement and finalizer order: $order",
    async (order) => {
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const doc = repoDocument("doc-shared", "docs/shared.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: oldActions });
        fireEvent.change(message(), { target: { value: "Old pending" } });
        await submit();
        await render(root, { visit: "current", doc, actions: currentActions });
        fireEvent.change(message(), { target: { value: "Current pending" } });
        await submit();
        expect(screen.getByTestId("commit-submit")).toBeDisabled();

        if (order === "stale-before-current") {
          await reject(oldPending, "Retired failure");
          expect(screen.getByTestId("commit-submit")).toBeDisabled();
          expect(screen.queryByText("Retired failure")).toBeNull();
          await resolve(currentPending);
        } else {
          await resolve(currentPending);
          expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
          await reject(oldPending, "Retired failure");
        }

        expect(message()).toHaveValue("Current pending");
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        expect(screen.queryByText("Retired failure")).toBeNull();
        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        await advance(900);
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "keeps a reused current timer handle owned in $order callback order",
    async (order) => {
      const fakeSetTimeout = globalThis.setTimeout;
      const sharedHandle = { shared: true } as unknown as ReturnType<typeof setTimeout>;
      const closeCallbacks: Array<() => void> = [];
      const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 900) {
          closeCallbacks.push(callback as () => void);
          return sharedHandle;
        }
        return fakeSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
      const clearTimeout = vi.spyOn(globalThis, "clearTimeout");
      const oldPending = deferred<void>();
      const currentPending = deferred<void>();
      const oldActions = actions(oldPending.promise);
      const currentActions = actions(currentPending.promise);
      const doc = repoDocument("doc-timer", "docs/timer.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "old", doc, actions: oldActions });
        await submit();
        await resolve(oldPending);
        expect(closeCallbacks).toHaveLength(1);

        await render(root, { visit: "current", doc, actions: currentActions });
        expect(clearTimeout.mock.calls.filter(([handle]) => handle === sharedHandle)).toHaveLength(1);
        await submit();
        await resolve(currentPending);
        expect(closeCallbacks).toHaveLength(2);

        if (order === "stale-before-current") {
          act(() => closeCallbacks[0]());
          expect(currentActions.onOpenChange).not.toHaveBeenCalled();
          expect(clearTimeout.mock.calls.filter(([handle]) => handle === sharedHandle)).toHaveLength(1);
          act(() => closeCallbacks[1]());
        } else {
          act(() => closeCallbacks[1]());
          act(() => closeCallbacks[0]());
        }

        expect(oldActions.onOpenChange).not.toHaveBeenCalled();
        expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(clearTimeout.mock.calls.filter(([handle]) => handle === sharedHandle)).toHaveLength(1);
        expect(timeout.mock.calls.filter((call) => call[1] === 900)).toHaveLength(2);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("binds the owner-only gist control and Cancel to the replacement visit", async () => {
    const oldActions = actions();
    const currentActions = actions();
    const oldDoc = repoDocument("doc-old-owner", "docs/old-owner.md");
    const currentDoc = {
      ...repoDocument("doc-current-owner", "docs/current-owner.md"),
      storage: "gist" as const,
      gistId: "gist-current",
      gistFile: "current.md",
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubUrl: "https://gist.github.com/gist-current",
    };
    const { host, root } = createHost();

    try {
      await render(root, { visit: "old", doc: oldDoc, actions: oldActions, isOwner: false });
      await render(root, { visit: "current", doc: currentDoc, actions: currentActions, isOwner: true });
      expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute("data-document", currentDoc.id);
      expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute("data-owner", "true");
      expect(message()).toHaveValue("Update current.md");
      fireEvent.change(message(), { target: { value: "Manual gist description" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(oldActions.onOpenChange).not.toHaveBeenCalled();
      expect(currentActions.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("publishes controls only after the complete Strict Mode ref and layout replay", async () => {
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-replay", "docs/replay.md");
    const { host, root } = createHost();
    const onFirstLayout = vi.fn();
    const onReplayLayout = vi.fn();

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <StrictCommitReplayProbe
              onFirstLayout={onFirstLayout}
              onReplayLayout={onReplayLayout}
            >
              <CommitDialog
                open
                onOpenChange={current.onOpenChange}
                doc={doc}
                onCommit={current.onCommit}
                isOwner
              />
            </StrictCommitReplayProbe>
          </StrictMode>,
        );
      });

      expect(onFirstLayout).toHaveBeenCalledOnce();
      expect(onReplayLayout).toHaveBeenCalledOnce();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      fireEvent.click(cancel);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps a partial callback-ref replay retired and recovers only with a fresh visit", async () => {
    const stale = actions();
    const fresh = actions();
    const doc = repoDocument("doc-partial-ref", "docs/partial-ref.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "stale", doc, actions: stale });
      const messageBinding = commitRefBindings(host)[4]!;
      act(() => {
        messageBinding.ref(null);
        messageBinding.ref(messageBinding.element);
      });

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(stale.onOpenChange).not.toHaveBeenCalled();

      await render(root, {
        visit: "fresh",
        doc: { ...doc },
        actions: fresh,
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(stale.onOpenChange).not.toHaveBeenCalled();
      expect(fresh.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["restored control attribute", "restored ancestor placement"] as const)(
    "retires %s history while leaving its distinct successor usable",
    async (mutation) => {
      const current = actions();
      const doc = repoDocument(`doc-${mutation}`, "docs/mutation.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "current", doc, actions: current });
        const cancel = screen.getByRole("button", { name: "Cancel" });
        if (mutation === "restored control attribute") {
          const className = cancel.className;
          cancel.className = "mutated";
          cancel.className = className;
        } else {
          const parent = host.parentNode;
          const next = host.nextSibling;
          if (!parent) throw new Error("The direct CommitDialog host has no parent");
          host.remove();
          parent.insertBefore(host, next);
        }

        fireEvent.click(cancel);
        expect(current.onOpenChange).not.toHaveBeenCalled();

        await flushPublication();
        fireEvent.click(cancel);
        expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("prevents rejected rendered submits, ignores foreign provenance, and consumes reentry once", async () => {
    const pending = deferred<void>();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const current = actions();
    const doc = repoDocument("doc-submit-provenance", "docs/submit-provenance.md");
    const { host, root } = createHost();
    const foreignForm = document.createElement("form");
    document.body.append(foreignForm);

    try {
      await render(root, { visit: "current", doc, actions: current });
      const form = commitForm();
      const submitter = screen.getByTestId("commit-submit") as HTMLButtonElement;
      const formHandler = reactProp<(event: ReactFormEvent<HTMLFormElement>) => void>(
        form,
        "onSubmit",
      );
      const foreignNative = nativeSubmit(foreignForm);
      const preventDefault = vi.fn();
      formHandler({
        _reactName: "onSubmit",
        type: "submit",
        nativeEvent: foreignNative,
        currentTarget: form,
        target: form,
        eventPhase: Event.BUBBLING_PHASE,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault,
        isDefaultPrevented: () => false,
        isPropagationStopped: () => false,
        persist: () => undefined,
      } as unknown as ReactFormEvent<HTMLFormElement>);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(foreignNative.defaultPrevented).toBe(false);

      const className = submitter.className;
      submitter.className = "mutated";
      submitter.className = className;
      const rejected = nativeSubmit(form, submitter);
      act(() => {
        form.dispatchEvent(rejected);
      });
      expect(rejected.defaultPrevented).toBe(true);
      expect(current.onCommit).not.toHaveBeenCalled();

      await flushPublication();
      const nested = nativeSubmit(form, submitter);
      current.onCommit.mockImplementationOnce(() => {
        form.dispatchEvent(nested);
        return pending.promise;
      });
      const accepted = nativeSubmit(form, submitter);
      act(() => {
        form.dispatchEvent(accepted);
        form.dispatchEvent(accepted);
      });

      expect(accepted.defaultPrevented).toBe(true);
      expect(nested.defaultPrevented).toBe(true);
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Update docs/submit-provenance.md");
      await resolve(pending);
      expect(timeout.mock.calls.filter((call) => call[1] === 900)).toHaveLength(1);
    } finally {
      foreignForm.remove();
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("prevents a current app-owned submit before a stale form handler rejects it", async () => {
    const pending = deferred<void>();
    const stale = actions();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-stale-submit", "docs/stale-submit.md");
    const { host, root } = createHost();
    type SubmitHandler = (event: ReactFormEvent<HTMLFormElement>) => void;

    try {
      await render(root, { visit: "stale", doc, actions: stale });
      const staleSubmit = reactProp<SubmitHandler>(commitForm(), "onSubmit");

      await render(root, {
        visit: "current",
        doc: { ...doc },
        actions: current,
      });
      const form = commitForm();
      const currentSubmit = reactProp<SubmitHandler>(form, "onSubmit");
      setReactProp(form, "onSubmit", (event: ReactFormEvent<HTMLFormElement>) => {
        staleSubmit(event);
        currentSubmit(event);
      });
      const nativeEvent = nativeSubmit(
        form,
        screen.getByTestId("commit-submit") as HTMLButtonElement,
      );

      act(() => {
        form.dispatchEvent(nativeEvent);
      });

      expect(nativeEvent.defaultPrevented).toBe(true);
      expect(stale.onCommit).not.toHaveBeenCalled();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith(
        "Update docs/stale-submit.md",
      );
      await resolve(pending);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("owns one primary gist Update click and schedules one exact success close", async () => {
    const pending = deferred<void>();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const current = actions(pending.promise);
    const doc = {
      ...repoDocument("doc-gist-submit", "unused.md"),
      storage: "gist" as const,
      gistId: "gist-submit",
      gistFile: "publish.md",
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubUrl: "https://gist.github.com/gist-submit",
    };
    const { host, root } = createHost();

    try {
      await render(root, { visit: "gist", doc, actions: current });
      expect(screen.getByRole("button", { name: "Update gist" })).toBeEnabled();
      fireEvent.change(message(), { target: { value: "  Publish gist description  " } });
      await clickSubmit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Publish gist description");

      await resolve(pending);
      expect(timeout.mock.calls.filter((call) => call[1] === 900)).toHaveLength(1);
      await advance(900);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("claims exact Enter provenance before one implicit native form submit", async () => {
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-enter-submit", "docs/enter.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "current", doc, actions: current });
      fireEvent.change(message(), { target: { value: "  Enter commit  " } });
      await flushPublication();
      fireEvent.keyDown(message(), { key: "Enter" });
      expect(current.onCommit).not.toHaveBeenCalled();

      const form = commitForm();
      const implicitSubmit = nativeSubmit(form);
      act(() => {
        form.dispatchEvent(implicitSubmit);
      });
      expect(implicitSubmit.defaultPrevented).toBe(true);
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Enter commit");
      await resolve(pending);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["close button", "Escape"] as const)(
    "authenticates one owner-document %s dismissal after Strict Mode replay",
    async (dismissal) => {
      const current = actions();
      const doc = repoDocument(`doc-dismiss-${dismissal}`, "docs/dismiss.md");
      const { host, root } = createHost();

      try {
        await render(root, { visit: "current", doc, actions: current });
        if (dismissal === "close button") {
          fireEvent.click(screen.getByRole("button", { name: "Close" }));
        } else {
          fireEvent.keyDown(message(), { key: "Escape" });
        }

        expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("requires the exact Radix outside nomination after a complete linked pointer sequence", async () => {
    vi.stubGlobal("PointerEvent", ControlledPointerEvent);
    const current = actions();
    const doc = repoDocument("doc-touch-dismiss", "docs/touch-dismiss.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "current", doc, actions: current });
      await advance(0);
      const overlay = document.querySelector(".dialog-overlay");
      if (!(overlay instanceof HTMLDivElement)) {
        throw new Error("The commit dialog overlay was not rendered");
      }
      const requestOpenChange = reactAncestorProp<(open: boolean) => void>(
        overlay,
        "onOpenChange",
      );

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        requestOpenChange(false);
      });
      expect(current.onOpenChange).not.toHaveBeenCalled();

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        requestOpenChange(false);
      });
      expect(current.onOpenChange).not.toHaveBeenCalled();

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointercancel", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        requestOpenChange(false);
      });
      expect(current.onOpenChange).not.toHaveBeenCalled();

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
      });
      await Promise.resolve();

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 1,
            pointerId: 99,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
      });
      expect(current.onOpenChange).not.toHaveBeenCalled();

      act(() => {
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        overlay.dispatchEvent(
          new ControlledPointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
        overlay.dispatchEvent(
          new ControlledPointerEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 1,
            pointerId: 17,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
      });
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("seals the genuine React nomination against later body-listener wrapper forgery", async () => {
    const current = actions();
    const reopened = actions();
    const doc = repoDocument("doc-react-delivery", "docs/react-delivery.md");
    const { host, root } = createHost();
    let genuineWrapper: React.MouseEvent<HTMLButtonElement> | null = null;
    let forgeAfterReact: EventListener | null = null;

    try {
      await render(root, { visit: "current", doc, actions: current });
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const bridge = host.firstElementChild;
      if (!(bridge instanceof HTMLDivElement)) {
        throw new Error("The commit dialog bridge was not rendered");
      }
      const genuine = reactProp<
        (event: React.MouseEvent<HTMLButtonElement>) => void
      >(cancel, "onClick");
      const directBridge = reactProp<
        (event: React.MouseEvent<HTMLDivElement>) => void
      >(bridge, "onClick");
      setReactProp(
        cancel,
        "onClick",
        (event: React.MouseEvent<HTMLButtonElement>) => {
          genuineWrapper = event;
          genuine(event);
        },
      );
      forgeAfterReact = (nativeEvent) => {
        if (!genuineWrapper) return;
        const genuineRecord = genuineWrapper as unknown as Record<string, unknown>;
        genuineRecord.currentTarget = bridge;
        directBridge(genuineWrapper as unknown as React.MouseEvent<HTMLDivElement>);
        genuineRecord.currentTarget = null;

        const forged = Object.assign(
          Object.create(Object.getPrototypeOf(genuineWrapper)) as Record<
            string,
            unknown
          >,
          {
            _reactName: "onClick",
            type: "click",
            nativeEvent,
            currentTarget: cancel,
            target: cancel,
            eventPhase: nativeEvent.eventPhase,
            bubbles: nativeEvent.bubbles,
            cancelable: nativeEvent.cancelable,
            defaultPrevented: false,
            button: 0,
            altKey: false,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            preventDefault: () => undefined,
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
            persist: () => undefined,
          },
        );
        genuine(forged as unknown as React.MouseEvent<HTMLButtonElement>);
        forged.currentTarget = bridge;
        directBridge(forged as unknown as React.MouseEvent<HTMLDivElement>);
        (forged as Record<string, unknown>).currentTarget = null;
      };
      document.body.addEventListener("click", forgeAfterReact);

      fireEvent.click(cancel);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);

      document.body.removeEventListener("click", forgeAfterReact);
      forgeAfterReact = null;
      await render(root, {
        visit: "closed",
        doc,
        actions: current,
        open: false,
      });
      await render(root, {
        visit: "reopened",
        doc: { ...doc },
        actions: reopened,
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(reopened.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      if (forgeAfterReact) {
        document.body.removeEventListener("click", forgeAfterReact);
      }
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects stale equal-looking handlers after reopen and accepts the fresh message and Cancel", async () => {
    const stale = actions();
    const fresh = actions();
    const doc = repoDocument("doc-equal-reopen", "docs/equal.md");
    const { host, root } = createHost();
    type ChangeHandler = (event: ReactChangeEvent<HTMLInputElement>) => void;
    type CancelHandler = (event: React.MouseEvent<HTMLButtonElement>) => void;

    try {
      await render(root, { visit: "stale", doc, actions: stale });
      const staleChange = reactProp<ChangeHandler>(message(), "onChange");
      const staleCancel = reactProp<CancelHandler>(
        screen.getByRole("button", { name: "Cancel" }),
        "onClick",
      );

      await render(root, { visit: "closed", doc, actions: stale, open: false });
      await render(root, { visit: "fresh", doc: { ...doc }, actions: fresh });
      const currentMessage = message();
      const currentCancel = screen.getByRole("button", { name: "Cancel" });
      const freshChange = reactProp<ChangeHandler>(currentMessage, "onChange");
      const freshCancel = reactProp<CancelHandler>(currentCancel, "onClick");

      setReactProp(currentMessage, "onChange", staleChange);
      fireEvent.change(currentMessage, { target: { value: "Retired value" } });
      expect(currentMessage).toHaveValue("Update docs/equal.md");

      setReactProp(currentMessage, "onChange", freshChange);
      fireEvent.change(currentMessage, { target: { value: "Fresh value" } });
      expect(currentMessage).toHaveValue("Fresh value");

      await flushPublication();
      const currentFreshCancel = reactProp<CancelHandler>(currentCancel, "onClick");
      setReactProp(currentCancel, "onClick", staleCancel);
      fireEvent.click(currentCancel);
      expect(stale.onOpenChange).not.toHaveBeenCalled();
      expect(fresh.onOpenChange).not.toHaveBeenCalled();

      expect(currentFreshCancel).not.toBe(freshCancel);
      setReactProp(currentCancel, "onClick", currentFreshCancel);
      fireEvent.click(currentCancel);
      expect(stale.onOpenChange).not.toHaveBeenCalled();
      expect(fresh.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
