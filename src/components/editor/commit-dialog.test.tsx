// @vitest-environment jsdom
import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { DocumentDto } from "@/server/dto";
import { ApiError } from "@/lib/api";

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
  onAncestorKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
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

const POINTER_DOWN_OUTSIDE = "dismissableLayer.pointerDownOutside";
const EVENT_SUPPRESSION_METHODS = [
  "preventDefault",
  "stopPropagation",
] as const;
const EVENT_SUPPRESSION_MUTATIONS = [
  "replacement",
  "deletion",
  "non-function",
  "throwing",
  "no-op",
] as const;
const EVENT_SUPPRESSION_CASES = EVENT_SUPPRESSION_METHODS.flatMap(
  (method, methodIndex) =>
    EVENT_SUPPRESSION_MUTATIONS.map((mutation, mutationIndex) => ({
      method,
      mutation,
      origin:
        (methodIndex + mutationIndex) % 2 === 0
          ? ("current" as const)
          : ("rejected" as const),
    })),
);

function controlledPointer(type: string, pointerId: number) {
  return new ControlledPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: type === "click" ? 1 : 0,
    pointerId,
    pointerType: "touch",
    isPrimary: true,
  });
}

function outsidePointerNomination(
  originalEvent: Event,
) {
  return new CustomEvent(POINTER_DOWN_OUTSIDE, {
    cancelable: true,
    detail: { originalEvent },
  });
}

function mutateEventSuppressionMethod(
  method: (typeof EVENT_SUPPRESSION_METHODS)[number],
  mutation: (typeof EVENT_SUPPRESSION_MUTATIONS)[number],
) {
  const prototype = window.Event.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error(`Event.prototype.${method} is not an own method`);
  }
  const original = descriptor.value as Event[typeof method];
  if (mutation === "deletion") {
    if (!Reflect.deleteProperty(prototype, method)) {
      throw new Error(`Event.prototype.${method} could not be deleted`);
    }
  } else {
    const value =
      mutation === "replacement"
        ? function (this: Event) {
            Reflect.apply(original, this, []);
          }
        : mutation === "non-function"
          ? null
          : mutation === "throwing"
            ? function () {
                throw new Error(`poisoned Event.prototype.${method}`);
              }
            : function () {};
    Object.defineProperty(prototype, method, { ...descriptor, value });
  }
  return () => {
    Object.defineProperty(prototype, method, descriptor);
  };
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
  onAncestorKeyDown,
}: CommitBoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, visit]);
  const dialog = present ? (
    <CommitDialog
      open={open}
      onOpenChange={currentActions.onOpenChange}
      doc={doc}
      onCommit={currentActions.onCommit}
      isOwner={isOwner}
    />
  ) : null;
  return onAncestorKeyDown ? (
    <div data-testid="commit-synthetic-ancestor" onKeyDown={onAncestorKeyDown}>
      {dialog}
    </div>
  ) : (
    dialog
  );
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

type CommitNavigationKey =
  | "ArrowLeft"
  | "ArrowUp"
  | "ArrowRight"
  | "ArrowDown"
  | "Home"
  | "End";

function markCommitKeyTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) => (event as unknown as Record<symbol, unknown>)[symbol],
    )
    .find(
      (candidate): candidate is { isTrusted: boolean } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "isTrusted" in candidate &&
        candidate.isTrusted === false,
    );
  const descriptor = implementation
    ? Object.getOwnPropertyDescriptor(implementation, "isTrusted")
    : undefined;
  if (!implementation || !descriptor?.writable) {
    throw new Error("Unable to set the jsdom keyboard trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom keyboard trust slot did not update");
  }
}

function createCommitKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The commit action has no owner Window");
  const implementationSymbol = Object.getOwnPropertySymbols(
    target.ownerDocument,
  ).find((symbol) => String(symbol) === "Symbol(impl)");
  const eventView = implementationSymbol
    ? (
        target.ownerDocument as unknown as Record<
          symbol,
          { _globalObject: Window }
        >
      )[implementationSymbol]._globalObject
    : ownerWindow;
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: key === " " ? "Space" : key,
    key,
    view: eventView,
    ...init,
  });
  if (trusted) markCommitKeyTrusted(event);
  return event;
}

function dispatchCommitKey(
  target: HTMLElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const event = createCommitKey(target, key, init, trusted);
  fireEvent(target, event);
  return event;
}

function commitBridge(host: HTMLDivElement) {
  const bridge = host.firstElementChild;
  if (!(bridge instanceof HTMLDivElement)) {
    throw new Error("The Commit dialog bridge was not rendered");
  }
  return bridge;
}

type CommitBridgeKeyHandler = (
  event: ReactKeyboardEvent<HTMLDivElement>,
) => void;

interface CommitBoundaryKeyDelivery {
  readonly nativeEvent: KeyboardEvent;
  readonly captureEvent: ReactKeyboardEvent<HTMLDivElement>;
  readonly bubbleEvent: ReactKeyboardEvent<HTMLDivElement>;
}

function dispatchCommitKeyWithBoundaryProbe(
  host: HTMLDivElement,
  target: HTMLButtonElement,
  key: CommitNavigationKey,
  mutate?: (
    phase: "capture-before" | "capture-after" | "bubble-before",
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void,
): CommitBoundaryKeyDelivery {
  const bridge = commitBridge(host);
  const capture = reactProp<CommitBridgeKeyHandler>(
    bridge,
    "onKeyDownCapture",
  );
  const bubble = reactProp<CommitBridgeKeyHandler>(bridge, "onKeyDown");
  let captureEvent: ReactKeyboardEvent<HTMLDivElement> | null = null;
  let bubbleEvent: ReactKeyboardEvent<HTMLDivElement> | null = null;
  setReactProp(
    bridge,
    "onKeyDownCapture",
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      captureEvent = event;
      mutate?.("capture-before", event);
      capture(event);
      mutate?.("capture-after", event);
    },
  );
  setReactProp(
    bridge,
    "onKeyDown",
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      bubbleEvent = event;
      mutate?.("bubble-before", event);
      bubble(event);
    },
  );
  let nativeEvent: KeyboardEvent | null = null;
  try {
    nativeEvent = dispatchCommitKey(target, key);
  } finally {
    setReactProp(bridge, "onKeyDownCapture", capture);
    setReactProp(bridge, "onKeyDown", bubble);
  }
  if (!captureEvent || !bubbleEvent) {
    throw new Error("React did not deliver both Commit keyboard boundaries");
  }
  if (!nativeEvent) {
    throw new Error("The Commit keyboard event was not dispatched");
  }
  return { nativeEvent, captureEvent, bubbleEvent };
}

function trackCommitNavigationEffects(ownerWindow: Window & typeof globalThis) {
  const nativeFocus = ownerWindow.HTMLElement.prototype.focus;
  const focusCalls: Array<{
    target: HTMLElement;
    options: FocusOptions | undefined;
  }> = [];
  const preventDefault = vi.spyOn(
    ownerWindow.Event.prototype,
    "preventDefault",
  );
  const focus = vi
    .spyOn(ownerWindow.HTMLElement.prototype, "focus")
    .mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      focusCalls.push({ target: this, options });
      Reflect.apply(
        nativeFocus,
        this,
        options === undefined ? [] : [options],
      );
    });
  const scrollTo = vi
    .spyOn(ownerWindow, "scrollTo")
    .mockImplementation(() => undefined);
  const scrollBy = vi
    .spyOn(ownerWindow, "scrollBy")
    .mockImplementation(() => undefined);
  return {
    preventDefault,
    focus,
    focusCalls,
    scrollTo,
    scrollBy,
  };
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

const unbrokenCommitError = "commit-failure-".repeat(20);

function expectCommitError(value: string | null) {
  const form = commitForm();
  const error = form.children.item(4);
  if (!(error instanceof HTMLDivElement)) throw new Error("The commit error slot must remain a div");
  expect(form.childNodes).toHaveLength(6);
  expect([...form.children].map((child) => child.tagName)).toEqual(["DIV", "LABEL", "INPUT", "P", "DIV", "DIV"]);
  expect(error.textContent).toBe(value ?? "");
  expect(error.hidden).toBe(value === null);
  expect(Object.fromEntries([...error.attributes].map(({ name, value }) => [name, value]))).toEqual({
    class: "rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40 wrap-anywhere",
    ...(value === null ? { hidden: "" } : {}),
  });
  expect(error.children).toHaveLength(0);
  expect(error.childNodes).toHaveLength(value ? 1 : 0);
  if (value) expect(error.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(error.tabIndex).toBe(-1);
  expect(error.previousElementSibling).toHaveTextContent("Pending suggestions are not included until they are accepted.");
  expect(error.nextElementSibling?.children).toHaveLength(2);
  expect(error.nextElementSibling?.firstElementChild).toBe(screen.getByRole("button", { name: "Cancel" }));
  expect(error.nextElementSibling?.lastElementChild).toBe(screen.getByTestId("commit-submit"));
  expect(screen.queryByRole("alert")).toBeNull();
  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CommitDialog wrapped failures", () => {
  const messages = [
    { kind: "unbroken", text: unbrokenCommitError },
    { kind: "ordinary", text: "GitHub could not publish this document. Please try again." },
    { kind: "literal markup", text: `<a href="literal">Not a link</a><img src="literal">${unbrokenCommitError}` },
    { kind: "whitespace", text: ` \t First reason\n\n${unbrokenCommitError}\t last reason \n ` },
    { kind: "whitespace only", text: " \t \n  " },
    { kind: "empty", text: "" },
  ];

  it.each(messages)("keeps $kind errors literal in the existing slot through replacement, retry and success", async ({ text }) => {
    expect(unbrokenCommitError.length).toBeGreaterThanOrEqual(240);
    expect(unbrokenCommitError).not.toMatch(/\s/);
    const first = deferred<void>();
    const second = deferred<void>();
    const recovered = deferred<void>();
    const current = actions(first.promise, second.promise, recovered.promise);
    const doc = repoDocument("doc-wrapped", "docs/wrapped.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "current", doc, actions: current });
      await advance(0);
      const input = message();
      const error = expectCommitError(null);
      expect(error).not.toBeVisible();
      expect(input).toHaveValue("Update docs/wrapped.md");
      expect(input).toBeEnabled();
      expect(screen.getByText("Commit message")).toBeInTheDocument();
      fireEvent.change(input, { target: { value: "  Preserve this draft  " } });
      await submit();
      await submit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Preserve this draft");
      expect(expectCommitError(null)).toBe(error);
      expect(screen.getByTestId("commit-submit")).toBeDisabled();

      await reject(first, text);
      await flushPublication();
      expect(expectCommitError(text)).toBe(error);
      expect(error).toBeVisible();
      expect(message()).toBe(input);
      expect(input).toHaveValue("  Preserve this draft  ");
      expect(input).toBeEnabled();
      expect(screen.getByTestId("commit-submit")).toBeEnabled();
      const dialog = screen.getByRole("dialog");
      const controls = [...dialog.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0);
      const focus = document.activeElement;
      const observer = new MutationObserver(() => {});
      observer.observe(dialog, { subtree: true, childList: true, attributes: true, characterData: true });
      const spies = [
        vi.spyOn(HTMLElement.prototype, "focus"),
        vi.spyOn(globalThis, "setTimeout"),
        vi.spyOn(globalThis, "setInterval"),
        vi.spyOn(window, "requestAnimationFrame"),
        vi.spyOn(globalThis, "queueMicrotask"),
        vi.spyOn(globalThis, "fetch"),
      ];
      try {
        expectCommitError(text);
        fireEvent.mouseOver(error);
        fireEvent.mouseMove(error);
        fireEvent.mouseOut(error);
        expect(observer.takeRecords()).toHaveLength(0);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(focus);
        expect([...dialog.querySelectorAll<HTMLElement>("*")].filter((element) => element.tabIndex >= 0)).toEqual(controls);
        expect(screen.queryByRole("tooltip")).toBeNull();
        expect(current.onCommit).toHaveBeenCalledTimes(1);
        expect(current.onOpenChange).not.toHaveBeenCalled();
      } finally {
        observer.disconnect();
        vi.restoreAllMocks();
      }

      await submit();
      await submit();
      expect(current.onCommit.mock.calls).toEqual([["Preserve this draft"], ["Preserve this draft"]]);
      expect(expectCommitError(null)).toBe(error);
      const replacement = ` \t Replacement <b>reason</b>\n${unbrokenCommitError} `;
      await act(async () => {
        second.reject(new ApiError(400, "Invalid request", [{ message: replacement }]));
        await Promise.allSettled([second.promise]);
      });
      expect(expectCommitError(replacement)).toBe(error);
      expect(error.textContent).not.toBe("Invalid request");
      expect(message()).toBe(input);
      expect(input).toHaveValue("  Preserve this draft  ");
      await submit();
      await submit();
      expect(current.onCommit.mock.calls).toEqual(Array.from({ length: 3 }, () => ["Preserve this draft"]));
      expect(expectCommitError(null)).toBe(error);
      await resolve(recovered);
      expect(expectCommitError(null)).toBe(error);
      expect(error).not.toBeVisible();
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

  it("clears a visible failure on close and reopen before the current visit publishes once", async () => {
    const failed = deferred<void>();
    const recovered = deferred<void>();
    const old = actions(failed.promise);
    const current = actions(recovered.promise);
    const doc = repoDocument("doc-error-reopen", "docs/reopen.md");
    const { host, root } = createHost();
    try {
      await render(root, { visit: "old", doc, actions: old });
      await submit();
      await reject(failed, unbrokenCommitError);
      expectCommitError(unbrokenCommitError);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(old.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      await render(root, { visit: "closed", doc, actions: old, open: false });
      expect(screen.queryByRole("dialog")).toBeNull();
      await render(root, { visit: "current", doc, actions: current });
      expectCommitError(null);
      expect(message()).toHaveValue("Update docs/reopen.md");
      await submit();
      await submit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Update docs/reopen.md");
      expect(old.onCommit).toHaveBeenCalledTimes(1);
      await resolve(recovered);
      expectCommitError(null);
      await advance(900);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(old.onOpenChange).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("CommitDialog action keyboard navigation", () => {
  it.each([
    ["Cancel", "Commit", "ArrowRight"],
    ["Cancel", "Commit", "ArrowDown"],
    ["Cancel", "Commit", "End"],
    ["Commit", "Cancel", "ArrowLeft"],
    ["Commit", "Cancel", "ArrowUp"],
    ["Commit", "Cancel", "Home"],
  ] as const)(
    "moves from %s to %s with %s exactly once without action work",
    async (sourceName, destinationName, key) => {
      const effects = trackCommitNavigationEffects(window);
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const current = actions();
      const doc = repoDocument(
        `doc-keyboard-${key}`,
        `docs/keyboard-${key}.md`,
      );
      const { host, root } = createHost();

      try {
        await render(root, { visit: key, doc, actions: current });
        await flushPublication();
        const cancel = screen.getByRole(
          "button",
          { name: "Cancel" },
        ) as HTMLButtonElement;
        const commit = screen.getByTestId(
          "commit-submit",
        ) as HTMLButtonElement;
        const source = sourceName === "Cancel" ? cancel : commit;
        const destination =
          destinationName === "Cancel" ? cancel : commit;
        const messageBefore = message().value;
        const closeTimersBefore = timeout.mock.calls.filter(
          ([, delay]) => delay === 900,
        ).length;
        const scrollBefore = {
          left: document.documentElement.scrollLeft,
          top: document.documentElement.scrollTop,
        };
        source.focus();
        effects.preventDefault.mockClear();
        effects.focus.mockClear();
        effects.focusCalls.length = 0;
        effects.scrollTo.mockClear();
        effects.scrollBy.mockClear();

        const event = dispatchCommitKey(source, key);

        expect(event.defaultPrevented).toBe(true);
        expect(effects.preventDefault).toHaveBeenCalledTimes(1);
        expect(effects.focus).toHaveBeenCalledTimes(1);
        expect(effects.focusCalls).toEqual([
          { target: destination, options: { preventScroll: true } },
        ]);
        expect(destination).toHaveFocus();
        expect(current.onCommit).not.toHaveBeenCalled();
        expect(current.onOpenChange).not.toHaveBeenCalled();
        expect(message()).toHaveValue(messageBefore);
        expect(
          timeout.mock.calls.filter(([, delay]) => delay === 900),
        ).toHaveLength(closeTimersBefore);
        expect(effects.scrollTo).not.toHaveBeenCalled();
        expect(effects.scrollBy).not.toHaveBeenCalled();
        expect(document.documentElement.scrollLeft).toBe(scrollBefore.left);
        expect(document.documentElement.scrollTop).toBe(scrollBefore.top);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("authenticates distinct wrapper boundaries without private React fields or shared prototypes", async () => {
    const effects = trackCommitNavigationEffects(window);
    const current = actions();
    const doc = repoDocument("doc-wrapper-pair", "docs/wrapper-pair.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "wrapper-pair", doc, actions: current });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      effects.focusCalls.length = 0;

      const delivery = dispatchCommitKeyWithBoundaryProbe(
        host,
        cancel,
        "ArrowRight",
        (phase, event) => {
          if (phase === "capture-before" || phase === "bubble-before") {
            Object.defineProperties(event, {
              preventDefault: {
                configurable: true,
                writable: true,
                value: event.preventDefault.bind(event),
              },
              isDefaultPrevented: {
                configurable: true,
                writable: true,
                value: event.isDefaultPrevented.bind(event),
              },
              isPropagationStopped: {
                configurable: true,
                writable: true,
                value: event.isPropagationStopped.bind(event),
              },
            });
            Object.setPrototypeOf(
              event,
              Object.create(Object.getPrototypeOf(event)),
            );
            Reflect.deleteProperty(event, "_reactName");
          }
        },
      );

      expect(delivery.captureEvent).not.toBe(delivery.bubbleEvent);
      expect(Object.getPrototypeOf(delivery.captureEvent)).not.toBe(
        Object.getPrototypeOf(delivery.bubbleEvent),
      );
      expect(delivery.captureEvent.nativeEvent).toBe(delivery.nativeEvent);
      expect(delivery.bubbleEvent.nativeEvent).toBe(delivery.nativeEvent);
      expect(delivery.captureEvent.currentTarget).toBeNull();
      expect(delivery.bubbleEvent.currentTarget).toBeNull();
      expect(delivery.captureEvent.preventDefault).not.toBe(
        delivery.bubbleEvent.preventDefault,
      );
      expect(delivery.captureEvent.isDefaultPrevented).not.toBe(
        delivery.bubbleEvent.isDefaultPrevented,
      );
      expect(delivery.captureEvent.isPropagationStopped).not.toBe(
        delivery.bubbleEvent.isPropagationStopped,
      );
      expect(delivery.captureEvent.isDefaultPrevented()).toBe(false);
      expect(delivery.captureEvent.isPropagationStopped()).toBe(false);
      expect(delivery.bubbleEvent.isDefaultPrevented()).toBe(true);
      expect(delivery.bubbleEvent.isPropagationStopped()).toBe(false);
      expect(delivery.nativeEvent.defaultPrevented).toBe(true);
      expect(effects.preventDefault).toHaveBeenCalledTimes(1);
      expect(effects.focusCalls).toEqual([
        { target: commit, options: { preventScroll: true } },
      ]);
      expect(current.onCommit).not.toHaveBeenCalled();
      expect(current.onOpenChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    "preventDefault",
    "isDefaultPrevented",
    "isPropagationStopped",
  ] as const)(
    "rejects capture wrapper %s drift and admits a clean successor",
    async (property) => {
      const effects = trackCommitNavigationEffects(window);
      const current = actions();
      const doc = repoDocument(
        `doc-capture-${property}`,
        "docs/wrapper-drift.md",
      );
      const { host, root } = createHost();

      try {
        await render(root, {
          visit: `capture-${property}`,
          doc,
          actions: current,
        });
        await flushPublication();
        const cancel = screen.getByRole(
          "button",
          { name: "Cancel" },
        ) as HTMLButtonElement;
        const commit = screen.getByTestId(
          "commit-submit",
        ) as HTMLButtonElement;
        cancel.focus();
        effects.preventDefault.mockClear();
        effects.focus.mockClear();
        effects.focusCalls.length = 0;
        const rejected = dispatchCommitKeyWithBoundaryProbe(
          host,
          cancel,
          "ArrowRight",
          (phase, event) => {
          if (phase === "capture-after") {
            Object.defineProperty(event, property, {
              configurable: true,
              value: vi.fn(() => false),
            });
          }
          },
        );
        expect(rejected.nativeEvent.defaultPrevented).toBe(false);
        expect(effects.preventDefault).not.toHaveBeenCalled();
        expect(effects.focus).not.toHaveBeenCalled();
        expect(cancel).toHaveFocus();

        const accepted = dispatchCommitKey(cancel, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(effects.preventDefault).toHaveBeenCalledTimes(1);
        expect(effects.focus).toHaveBeenCalledTimes(1);
        expect(commit).toHaveFocus();
        expect(current.onCommit).not.toHaveBeenCalled();
        expect(current.onOpenChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    ["ArrowLeft", "Numpad4", "Commit", "Cancel"],
    ["ArrowUp", "Numpad8", "Commit", "Cancel"],
    ["ArrowRight", "Numpad6", "Cancel", "Commit"],
    ["ArrowDown", "Numpad2", "Cancel", "Commit"],
    ["Home", "Numpad7", "Commit", "Cancel"],
    ["End", "Numpad1", "Cancel", "Commit"],
  ] as const)(
    "uses semantic %s from %s without rejecting its numpad code or location",
    async (key, code, sourceName, destinationName) => {
      const effects = trackCommitNavigationEffects(window);
      const current = actions();
      const doc = repoDocument(
        `doc-numpad-${key}`,
        `docs/numpad-${key}.md`,
      );
      const { host, root } = createHost();

      try {
        await render(root, { visit: `numpad-${key}`, doc, actions: current });
        await flushPublication();
        const cancel = screen.getByRole(
          "button",
          { name: "Cancel" },
        ) as HTMLButtonElement;
        const commit = screen.getByTestId(
          "commit-submit",
        ) as HTMLButtonElement;
        const source = sourceName === "Cancel" ? cancel : commit;
        const destination =
          destinationName === "Cancel" ? cancel : commit;
        source.focus();
        effects.preventDefault.mockClear();
        effects.focus.mockClear();
        effects.focusCalls.length = 0;

        const event = dispatchCommitKey(source, key, {
          code,
          location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
        });

        expect(event.defaultPrevented).toBe(true);
        expect(effects.preventDefault).toHaveBeenCalledTimes(1);
        expect(effects.focusCalls).toEqual([
          { target: destination, options: { preventScroll: true } },
        ]);
        expect(destination).toHaveFocus();
        expect(current.onCommit).not.toHaveBeenCalled();
        expect(current.onOpenChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("prevents a same-root synthetic ancestor action before moving focus", async () => {
    const effects = trackCommitNavigationEffects(window);
    const current = actions();
    const ancestorAction = vi.fn();
    const ancestorDelivery = vi.fn(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (!event.defaultPrevented || !event.isDefaultPrevented()) {
          ancestorAction();
        }
      },
    );
    const doc = repoDocument(
      "doc-synthetic-ancestor",
      "docs/synthetic-ancestor.md",
    );
    const { host, root } = createHost();

    try {
      await render(root, {
        visit: "synthetic-ancestor",
        doc,
        actions: current,
        onAncestorKeyDown: ancestorDelivery,
      });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();

      const event = dispatchCommitKey(cancel, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(ancestorDelivery).toHaveBeenCalledTimes(1);
      expect(ancestorAction).not.toHaveBeenCalled();
      expect(effects.preventDefault).toHaveBeenCalledTimes(1);
      expect(effects.focus).toHaveBeenCalledTimes(1);
      expect(commit).toHaveFocus();
      expect(current.onCommit).not.toHaveBeenCalled();
      expect(current.onOpenChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("binds navigation to the listener's backing receiver, intrinsic currentTarget, and path terminal", async () => {
    const currentTargetDescriptor = Object.getOwnPropertyDescriptor(
      window.Event.prototype,
      "currentTarget",
    );
    const composedPath = window.Event.prototype.composedPath;
    if (typeof currentTargetDescriptor?.get !== "function") {
      throw new Error("Event.currentTarget has no intrinsic getter");
    }
    const observations: Array<{
      receiver: EventTarget;
      currentTarget: EventTarget | null;
      terminal: EventTarget | undefined;
    }> = [];
    const observe = function (this: EventTarget, event: Event) {
      observations.push({
        receiver: this,
        currentTarget: Reflect.apply(
          currentTargetDescriptor.get!,
          event,
          [],
        ) as EventTarget | null,
        terminal: (
          Reflect.apply(composedPath, event, []) as EventTarget[]
        ).at(-1),
      });
    };
    window.addEventListener("keydown", observe, true);
    const effects = trackCommitNavigationEffects(window);
    const current = actions();
    const doc = repoDocument("doc-window-proof", "docs/window-proof.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "window-proof", doc, actions: current });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      observations.length = 0;

      const event = dispatchCommitKey(cancel, "ArrowRight");

      expect(event.defaultPrevented).toBe(true);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.receiver).toBe(
        observations[0]!.currentTarget,
      );
      expect(observations[0]!.receiver).toBe(observations[0]!.terminal);
      expect(commit).toHaveFocus();
      expect(effects.preventDefault).toHaveBeenCalledTimes(1);
      expect(effects.focus).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", observe, true);
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(["same-prototype", "structural"] as const)(
    "rejects a %s Window-shaped path terminal and accepts the exact successor",
    async (kind) => {
      const nativePath = window.Event.prototype.composedPath;
      const lookalike = Object.create(
        kind === "same-prototype" ? window.Window.prototype : null,
      ) as Window & Record<string, unknown>;
      Object.defineProperties(lookalike, {
        document: { configurable: true, value: document },
        window: { configurable: true, value: lookalike },
        self: { configurable: true, value: lookalike },
        Window: { configurable: true, value: window.Window },
        Event: { configurable: true, value: window.Event },
        KeyboardEvent: {
          configurable: true,
          value: window.KeyboardEvent,
        },
        Node: { configurable: true, value: window.Node },
        Object: { configurable: true, value: window.Object },
        Reflect: { configurable: true, value: window.Reflect },
      });
      let spoofTerminal = true;
      vi.spyOn(
        window.Event.prototype,
        "composedPath",
      ).mockImplementation(function (this: Event) {
        const actual = Reflect.apply(nativePath, this, []) as EventTarget[];
        return spoofTerminal && actual.length > 0
          ? [...actual.slice(0, -1), lookalike]
          : actual;
      });
      const effects = trackCommitNavigationEffects(window);
      const current = actions();
      const doc = repoDocument(
        `doc-window-lookalike-${kind}`,
        "docs/window-lookalike.md",
      );
      const { host, root } = createHost();

      try {
        await render(root, {
          visit: `window-lookalike-${kind}`,
          doc,
          actions: current,
        });
        await flushPublication();
        const cancel = screen.getByRole(
          "button",
          { name: "Cancel" },
        ) as HTMLButtonElement;
        const commit = screen.getByTestId(
          "commit-submit",
        ) as HTMLButtonElement;
        cancel.focus();
        effects.preventDefault.mockClear();
        effects.focus.mockClear();

        const rejected = dispatchCommitKey(cancel, "ArrowRight");
        expect(rejected.defaultPrevented).toBe(false);
        expect(effects.preventDefault).not.toHaveBeenCalled();
        expect(effects.focus).not.toHaveBeenCalled();
        expect(cancel).toHaveFocus();

        spoofTerminal = false;
        const accepted = dispatchCommitKey(cancel, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(effects.preventDefault).toHaveBeenCalledTimes(1);
        expect(effects.focus).toHaveBeenCalledTimes(1);
        expect(commit).toHaveFocus();
        expect(current.onCommit).not.toHaveBeenCalled();
        expect(current.onOpenChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("leaves boundaries, disabled destinations, unrelated keys, and invalid native facts inert", async () => {
    const effects = trackCommitNavigationEffects(window);
    const pending = deferred<void>();
    const current = actions(pending.promise);
    const doc = repoDocument("doc-inert-keys", "docs/inert-keys.md");
    const { host, root } = createHost();

    try {
      await render(root, { visit: "inert", doc, actions: current });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      const cases: Array<{
        source: HTMLButtonElement;
        key: string;
        init?: KeyboardEventInit;
        trusted?: boolean;
      }> = [
        { source: cancel, key: "ArrowLeft" },
        { source: cancel, key: "ArrowUp" },
        { source: cancel, key: "Home" },
        { source: commit, key: "ArrowRight" },
        { source: commit, key: "ArrowDown" },
        { source: commit, key: "End" },
        { source: cancel, key: "Tab" },
        { source: commit, key: "Enter" },
        { source: cancel, key: " " },
        { source: cancel, key: "ArrowRight", init: { altKey: true } },
        { source: cancel, key: "ArrowRight", init: { ctrlKey: true } },
        { source: cancel, key: "ArrowRight", init: { metaKey: true } },
        { source: cancel, key: "ArrowRight", init: { shiftKey: true } },
        { source: cancel, key: "ArrowRight", init: { repeat: true } },
        {
          source: cancel,
          key: "ArrowRight",
          init: { isComposing: true },
        },
        { source: cancel, key: "ArrowRight", trusted: false },
      ];
      for (const { source, key, init, trusted } of cases) {
        source.focus();
        effects.preventDefault.mockClear();
        effects.focus.mockClear();
        effects.focusCalls.length = 0;
        const event = dispatchCommitKey(
          source,
          key,
          init,
          trusted ?? true,
        );
        expect(event.defaultPrevented, key).toBe(false);
        expect(effects.preventDefault, key).not.toHaveBeenCalled();
        expect(effects.focus, key).not.toHaveBeenCalled();
        expect(source, key).toHaveFocus();
      }

      await submit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith(
        "Update docs/inert-keys.md",
      );
      expect(commit).toBeDisabled();
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      for (const key of [
        "ArrowLeft",
        "ArrowUp",
        "ArrowRight",
        "ArrowDown",
        "Home",
        "End",
      ] as const) {
        const event = dispatchCommitKey(cancel, key);
        expect(event.defaultPrevented, key).toBe(false);
      }
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(cancel).toHaveFocus();
      expect(current.onOpenChange).not.toHaveBeenCalled();
      await resolve(pending);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("navigates the gist actions and preserves click activation", async () => {
    const effects = trackCommitNavigationEffects(window);
    const current = actions();
    const doc = {
      ...repoDocument("doc-gist-navigation", "unused.md"),
      storage: "gist" as const,
      gistId: "gist-navigation",
      gistFile: "navigation.md",
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubUrl: "https://gist.github.com/gist-navigation",
    };
    const { host, root } = createHost();

    try {
      await render(root, { visit: "gist-navigation", doc, actions: current });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const update = screen.getByRole(
        "button",
        { name: "Update gist" },
      ) as HTMLButtonElement;
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      effects.focusCalls.length = 0;
      const event = dispatchCommitKey(cancel, "End");
      expect(event.defaultPrevented).toBe(true);
      expect(effects.focusCalls).toEqual([
        { target: update, options: { preventScroll: true } },
      ]);
      expect(current.onCommit).not.toHaveBeenCalled();
      expect(current.onOpenChange).not.toHaveBeenCalled();

      fireEvent.click(cancel);
      expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(current.onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects restored action order, replay, and cleanup while a fresh root recovers", async () => {
    const effects = trackCommitNavigationEffects(window);
    const stale = actions();
    const doc = repoDocument("doc-history", "docs/history.md");
    const first = createHost();
    try {
      await render(first.root, { visit: "history", doc, actions: stale });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      const staleHandler = reactProp<CommitBridgeKeyHandler>(
        commitBridge(first.host),
        "onKeyDown",
      );
      const actionParent = cancel.parentElement;
      if (!actionParent) throw new Error("Commit actions have no parent");
      actionParent.append(cancel);
      actionParent.insertBefore(cancel, commit);
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const restored = dispatchCommitKey(cancel, "ArrowRight");
      expect(restored.defaultPrevented).toBe(false);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();

      await act(async () => first.root.unmount());
      const fabricated = {
        nativeEvent: createCommitKey(cancel, "ArrowRight"),
      } as ReactKeyboardEvent<HTMLDivElement>;
      expect(() => staleHandler(fabricated)).not.toThrow();
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
    } finally {
      first.host.remove();
    }

    const fresh = actions();
    const second = createHost();
    try {
      await render(second.root, {
        visit: "fresh-history",
        doc: { ...doc },
        actions: fresh,
      });
      await flushPublication();
      const cancel = screen.getByRole(
        "button",
        { name: "Cancel" },
      ) as HTMLButtonElement;
      const commit = screen.getByTestId(
        "commit-submit",
      ) as HTMLButtonElement;
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      const accepted = dispatchCommitKey(cancel, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(commit).toHaveFocus();
      cancel.focus();
      effects.preventDefault.mockClear();
      effects.focus.mockClear();
      fireEvent(cancel, accepted);
      expect(effects.preventDefault).not.toHaveBeenCalled();
      expect(effects.focus).not.toHaveBeenCalled();
      expect(cancel).toHaveFocus();
      expect(stale.onCommit).not.toHaveBeenCalled();
      expect(fresh.onCommit).not.toHaveBeenCalled();
    } finally {
      await act(async () => second.root.unmount());
      second.host.remove();
    }
  });
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
        expectCommitError(null);
        expect(message()).toHaveValue("Update docs/reopen.md");
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        fireEvent.change(message(), { target: { value: "  Current pending  " } });
        await submit();
        expect(current.onCommit).toHaveBeenNthCalledWith(2, "Current pending");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();

        if (stale === "success") await resolve(oldPending);
        else await reject(oldPending, unbrokenCommitError);
        expect(message()).toHaveValue("  Current pending  ");
        expect(screen.getByTestId("commit-submit")).toBeDisabled();
        expectCommitError(null);
        expect(screen.queryByRole("button", { name: "Published" })).toBeNull();
        expect(current.onOpenChange).toHaveBeenCalledTimes(1);

        fireEvent.change(message(), { target: { value: "  Current retry  " } });
        await reject(currentPending, "Current publish failed");
        expect(screen.getByText("Current publish failed")).toBeInTheDocument();
        expectCommitError("Current publish failed");
        expect(screen.getByTestId("commit-submit")).toBeEnabled();
        await submit();
        expectCommitError(null);
        expect(current.onCommit).toHaveBeenNthCalledWith(3, "Current retry");
        await resolve(retryPending);
        expectCommitError(null);
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
          await reject(oldPending, unbrokenCommitError);
          expect(screen.getByTestId("commit-submit")).toBeDisabled();
          expectCommitError(null);
          await resolve(currentPending);
        } else {
          await resolve(currentPending);
          expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
          await reject(oldPending, unbrokenCommitError);
        }

        expect(message()).toHaveValue("Current pending");
        expect(screen.getByRole("button", { name: "Published" })).toBeDisabled();
        expectCommitError(null);
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

  it("keeps first owner-gist publication Published while its control appears", async () => {
    const publish = deferred<void>();
    const current = actions();
    const doc = {
      ...repoDocument("doc-first-gist-publish", "unused.md"),
      storage: "gist" as const,
      gistId: "gist-first-publish",
      gistFile: "first-publish.md",
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      publishedAt: null,
      githubUrl: "https://gist.github.com/gist-first-publish",
    };
    const refreshed = {
      ...doc,
      hasUnpublishedChanges: false,
      publishedAt: "2026-09-08T10:50:00.000Z",
      updatedAt: "2026-09-08T10:50:00.000Z",
    };
    const { host, root } = createHost();

    current.onCommit.mockImplementationOnce(async () => {
      await publish.promise;
      root.render(
        <StrictMode>
          <CommitBoundary
            visit="published"
            doc={refreshed}
            actions={current}
          />
        </StrictMode>,
      );
    });

    try {
      await render(root, { visit: "unpublished", doc, actions: current });
      expect(screen.queryByTestId("gist-auto-update-stub")).toBeNull();
      fireEvent.change(message(), { target: { value: "  First gist publish  " } });
      await clickSubmit();
      expect(current.onCommit).toHaveBeenCalledExactlyOnceWith(
        "First gist publish",
      );

      await resolve(publish);
      expect(screen.getByTestId("gist-auto-update-stub")).toHaveAttribute(
        "data-document",
        doc.id,
      );
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

  describe("public Enter provenance", () => {
    type Stage =
      | "key bridge capture"
      | "key input capture"
      | "key input"
      | "key bridge"
      | "submit bridge capture"
      | "submit form"
      | "submit bridge";
    type PublicEvent = ReactFormEvent<HTMLElement>;
    type Handler = (event: PublicEvent) => void;
    type Delivery = {
      stage: Stage;
      event: PublicEvent;
      prevent: ReturnType<typeof vi.fn<() => void>>;
    };

    function publicEvent(source: PublicEvent) {
      const event: PublicEvent = {
        nativeEvent: source.nativeEvent,
        target: source.target,
        currentTarget: source.currentTarget,
        type: source.type,
        eventPhase: source.eventPhase,
        bubbles: source.bubbles,
        cancelable: source.cancelable,
        isTrusted: source.isTrusted,
        timeStamp: source.timeStamp,
        defaultPrevented: false,
        preventDefault() {
          source.preventDefault();
          event.defaultPrevented = true;
          event.isDefaultPrevented = () => true;
        },
        isDefaultPrevented: () => event.defaultPrevented,
        isPropagationStopped: () => false,
        get stopPropagation(): PublicEvent["stopPropagation"] {
          throw new Error("Enter must not read wrapper stopPropagation");
        },
        get persist(): PublicEvent["persist"] {
          throw new Error("Enter must not read wrapper persistence");
        },
      };
      if (source.nativeEvent instanceof KeyboardEvent) {
        const native = source.nativeEvent;
        Object.assign(event, {
          key: native.key,
          code: native.code,
          location: native.location,
          repeat: native.repeat,
          altKey: native.altKey,
          ctrlKey: native.ctrlKey,
          metaKey: native.metaKey,
          shiftKey: native.shiftKey,
        });
      }
      for (const name of ["_reactName", "isPersistent", "constructor", "isComposing"]) {
        Object.defineProperty(event, name, {
          get: () => {
            throw new Error(`Enter must not read wrapper ${name}`);
          },
        });
      }
      return event;
    }

    function probe(
      host: HTMLDivElement,
      hook?: (delivery: Delivery, handler: Handler) => boolean | void,
      accessor = false,
      forwarding = false,
    ) {
      const bridge = commitBridge(host);
      const input = message();
      const form = commitForm();
      const bindings: Array<[HTMLElement, string, Stage]> = [
        [bridge, "onKeyDownCapture", "key bridge capture"],
        [input, "onKeyDownCapture", "key input capture"],
        [input, "onKeyDown", "key input"],
        [bridge, "onKeyDown", "key bridge"],
        [bridge, "onSubmitCapture", "submit bridge capture"],
        [form, "onSubmit", "submit form"],
        [bridge, "onSubmit", "submit bridge"],
      ];
      const deliveries: Delivery[] = [];
      const sourcePreventions = new WeakMap<PublicEvent, Delivery["prevent"]>();
      const restores = bindings.map(([element, prop, stage]) => {
        const handler = reactProp<Handler>(element, prop);
        const wrapped = (source: PublicEvent) => {
          const event = forwarding ? new Proxy(source, {}) : publicEvent(source);
          let prevent = forwarding ? sourcePreventions.get(source) : undefined;
          if (!prevent) {
            const originalPrevent = event.preventDefault;
            prevent = vi.fn(function (this: PublicEvent) {
              Reflect.apply(originalPrevent, this, []);
            });
            event.preventDefault = prevent;
            if (forwarding) sourcePreventions.set(source, prevent);
          }
          if (accessor) {
            const prototype = Object.create(null);
            for (const key of Object.keys(event)) {
              if (key === "persist" || key === "stopPropagation") continue;
              let value = Reflect.get(event, key);
              Reflect.deleteProperty(event, key);
              Object.defineProperty(prototype, key, {
                configurable: true,
                get: () => value,
                set: (next: unknown) => { value = next; },
              });
            }
            Object.setPrototypeOf(event, prototype);
          }
          const delivery = { stage, event, prevent };
          deliveries.push(delivery);
          try {
            if (hook?.(delivery, handler) !== true) handler(event);
          } finally {
            if (!forwarding) Reflect.set(event, "currentTarget", null);
          }
        };
        setReactProp(element, prop, wrapped);
        return () => {
          if (element.isConnected && reactProp<Handler>(element, prop) === wrapped) {
            setReactProp(element, prop, handler);
          }
        };
      });
      return {
        deliveries,
        restore: () => restores.forEach((restore) => restore()),
        key: (init: KeyboardEventInit = {}) =>
          dispatchCommitKey(input, "Enter", init, false),
        submit: () => {
          const event = nativeSubmit(form);
          fireEvent(form, event);
          return event;
        },
        preventionCount: () =>
          [...new Set(deliveries.map(({ prevent }) => prevent))]
            .reduce((count, prevent) => count + prevent.mock.calls.length, 0),
      };
    }

    async function cleanSuccessor(
      host: HTMLDivElement,
      current: CommitActions,
      text?: string,
    ) {
      if (text !== undefined) {
        fireEvent.change(message(), { target: { value: `  ${text}  ` } });
      }
      await flushPublication();
      const expectedMessage = text ?? message().value.trim();
      const delivery = probe(host);
      try {
        const before = current.onCommit.mock.calls.length;
        const key = delivery.key();
        expect(key.defaultPrevented).toBe(false);
        expect(current.onCommit).toHaveBeenCalledTimes(before);
        expect(delivery.preventionCount()).toBe(0);
        const event = delivery.submit();
        expect(event.defaultPrevented).toBe(true);
        expect(delivery.preventionCount()).toBe(1);
        expect(current.onCommit).toHaveBeenCalledTimes(before + 1);
        expect(current.onCommit).toHaveBeenLastCalledWith(expectedMessage);
      } finally {
        delivery.restore();
      }
    }

    it.each([false, true])(
      "accepts independent public deliveries with inherited accessors=%s and final React 19 query replacement",
      async (accessor) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "public",
            doc: repoDocument("public-enter", "public.md"),
            actions: current,
          });
          fireEvent.change(message(), { target: { value: "  Public Enter  " } });
          await flushPublication();
          const delivery = probe(host, undefined, accessor);
          try {
            expect(delivery.key().defaultPrevented).toBe(false);
            expect(delivery.preventionCount()).toBe(0);
            expect(current.onCommit).not.toHaveBeenCalled();
            const submit = delivery.submit();
            expect(submit.defaultPrevented).toBe(true);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Public Enter");
            expect(new Set(delivery.deliveries.map(({ event }) => event)).size).toBe(7);
            expect(delivery.deliveries.at(-1)?.prevent).toHaveBeenCalledOnce();
            expect(delivery.deliveries.slice(0, -1).every(({ prevent }) =>
              prevent.mock.calls.length === 0,
            )).toBe(true);
            fireEvent(commitForm(), submit);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
          } finally {
            delivery.restore();
          }
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    describe("revision four corrections", () => {
      it.each(["accepted", "blank", "malformed", "unfinished"] as const)(
        "keeps %s Enter authority across native implicit-style button activation",
        async (kind) => {
          const first = deferred<void>();
          const second = deferred<void>();
          const current = actions(first.promise, second.promise);
          const { host, root } = createHost();
          try {
            await render(root, {
              visit: "implicit",
              doc: repoDocument("implicit-enter", "implicit.md"),
              actions: current,
            });
            const text = kind === "blank" ? " \t " : "  Implicit commit  ";
            fireEvent.change(message(), { target: { value: text } });
            await flushPublication();
            const form = commitForm();
            const button = screen.getByTestId<HTMLButtonElement>("commit-submit");
            const submitted: SubmitEvent[] = [];
            const observeSubmit = (event: Event) => {
              expect(event).toBeInstanceOf(SubmitEvent);
              submitted.push(event as SubmitEvent);
            };
            form.addEventListener("submit", observeSubmit, true);
            const delivery = probe(host, ({ stage, event }) => {
              if (stage !== "key input") return;
              if (kind === "unfinished") return true;
              if (kind === "malformed") Reflect.set(event, "code", "Space");
            });
            try {
              const key = delivery.key();
              expect(key.defaultPrevented).toBe(false);
              expect(delivery.preventionCount()).toBe(0);
              expect(current.onCommit).not.toHaveBeenCalled();
              expect(document.activeElement).toBe(message());
              // jsdom supplies a genuine submit from this native click's default
              // activation. This is not OS-trusted implicit keyboard activation.
              const click = new MouseEvent("click", {
                bubbles: true, cancelable: true, detail: 0, button: 0,
              });
              fireEvent(button, click);
              expect(click.defaultPrevented).toBe(false);
              expect(submitted).toHaveLength(1);
              expect(submitted[0].submitter).toBe(button);
              expect(submitted[0].defaultPrevented).toBe(kind === "accepted");
              expect(delivery.preventionCount()).toBe(kind === "accepted" ? 1 : 0);
              if (kind === "accepted") {
                expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Implicit commit");
                expect(delivery.deliveries.at(-1)?.prevent).toHaveBeenCalledOnce();
              } else {
                expect(current.onCommit).not.toHaveBeenCalled();
                expect(document.activeElement).toBe(message());
              }
            } finally {
              form.removeEventListener("submit", observeSubmit, true);
              delivery.restore();
            }
            if (kind === "accepted") {
              await resolve(first);
            } else {
              // Independent pointer activation retains the ordinary blank-message
              // semantics, rather than inheriting the rejected Enter claim.
              fireEvent.click(button, { detail: 1 });
              expect(current.onCommit).toHaveBeenCalledExactlyOnceWith(text.trim());
              await reject(first, "Try the focused button");
              await flushPublication();
              const rejected = probe(host);
              try {
                rejected.key({ repeat: true });
                expect(rejected.preventionCount()).toBe(0);
              } finally {
                rejected.restore();
              }
              button.focus();
              fireEvent.click(button, { detail: 0 });
              expect(current.onCommit).toHaveBeenCalledTimes(2);
              expect(current.onCommit).toHaveBeenLastCalledWith(text.trim());
              await resolve(second);
            }
          } finally {
            await act(async () => root.unmount());
            host.remove();
          }
        },
      );

      it.each([false, true])(
        "accepts live forwarding aliases at all seven boundaries but rejects later Q2 drift=%s",
        async (drift) => {
          const pending = deferred<void>();
          const current = actions(pending.promise);
          const { host, root } = createHost();
          try {
            await render(root, {
              visit: "forwarding",
              doc: repoDocument("forwarding-enter", "forwarding.md"),
              actions: current,
            });
            fireEvent.change(message(), { target: { value: "  Forwarded commit  " } });
            await flushPublication();
            const prior = new Map<string, PublicEvent>();
            let immediateQuery: PublicEvent["isDefaultPrevented"] | undefined;
            const laterQuery = vi.fn(() => true);
            let prevented = false;
            let replaying = false;
            const delivery = probe(host, ({ stage, event }) => {
              if (replaying) return;
              const phase = `${event.type}:${event.eventPhase}`;
              const earlier = prior.get(phase);
              if (earlier) {
                expect(earlier).not.toBe(event);
                expect(earlier.currentTarget).toBe(event.currentTarget);
                expect(earlier.preventDefault).toBe(event.preventDefault);
                expect(earlier.isDefaultPrevented).toBe(event.isDefaultPrevented);
              }
              prior.set(phase, event);
              if (stage !== "submit form") return;
              const prevent = event.preventDefault;
              event.preventDefault = function (this: PublicEvent) {
                Reflect.apply(prevent, this, []);
                immediateQuery = this.isDefaultPrevented;
                prevented = true;
              };
              if (drift) {
                const native = event.nativeEvent;
                const nativeDefault = Object.getOwnPropertyDescriptor(
                  Event.prototype, "defaultPrevented",
                )!.get!;
                Object.defineProperty(native, "defaultPrevented", {
                  get: () => {
                    if (prevented) event.isDefaultPrevented = laterQuery;
                    return Reflect.apply(nativeDefault, native, []);
                  },
                });
              }
            }, false, true);
            try {
              expect(delivery.key().defaultPrevented).toBe(false);
              expect(delivery.preventionCount()).toBe(0);
              expect(current.onCommit).not.toHaveBeenCalled();
              const submitted = delivery.submit();
              expect(submitted.defaultPrevented).toBe(true);
              expect(delivery.deliveries).toHaveLength(7);
              expect(new Set(delivery.deliveries.map(({ event }) => event)).size).toBe(7);
              expect(delivery.preventionCount()).toBe(1);
              const final = delivery.deliveries.at(-1)!;
              expect(final.prevent.mock.contexts).toEqual([final.event]);
              expect(immediateQuery).toBeTypeOf("function");
              expect(laterQuery).not.toHaveBeenCalled();
              if (drift) {
                expect(current.onCommit).not.toHaveBeenCalled();
              } else {
                const formDelivery = delivery.deliveries[5];
                expect(formDelivery.event.isDefaultPrevented).toBe(immediateQuery);
                expect(formDelivery.event.defaultPrevented).toBe(true);
                expect(delivery.deliveries[4].event.defaultPrevented).toBe(false);
                expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Forwarded commit");
              }
              replaying = true;
              fireEvent(commitForm(), submitted);
              expect(delivery.preventionCount()).toBe(1);
              expect(current.onCommit).toHaveBeenCalledTimes(drift ? 0 : 1);
            } finally {
              delivery.restore();
            }
            if (drift) await cleanSuccessor(host, current);
            await resolve(pending);
          } finally {
            await act(async () => root.unmount());
            host.remove();
          }
        },
      );

      it.each(["malformed form", "malformed bridge", "incomplete bridge"] as const)(
        "releases an ended %s submit while retaining the same completed key",
        async (failure) => {
          const pending = deferred<void>();
          const current = actions(pending.promise);
          const { host, root } = createHost();
          try {
            await render(root, {
              visit: "candidate",
              doc: repoDocument("candidate-enter", "candidate.md"),
              actions: current,
            });
            let abandoned: Event | undefined;
            const delivery = probe(host, ({ stage, event }) => {
              if (!stage.startsWith("submit")) return;
              abandoned ??= event.nativeEvent;
              if (event.nativeEvent !== abandoned) return;
              if (stage === "submit form" && failure === "malformed form") {
                event.type = "keydown";
              }
              if (stage === "submit bridge") {
                if (failure === "incomplete bridge") return true;
                if (failure === "malformed bridge") event.currentTarget = document.body;
              }
            });
            try {
              const key = delivery.key();
              expect(key.defaultPrevented).toBe(false);
              const first = delivery.submit();
              expect(first).toBe(abandoned);
              expect(first.eventPhase).toBe(Event.NONE);
              expect(first.defaultPrevented).toBe(false);
              expect(delivery.preventionCount()).toBe(0);
              expect(current.onCommit).not.toHaveBeenCalled();
              fireEvent(commitForm(), first);
              expect(delivery.preventionCount()).toBe(0);
              expect(current.onCommit).not.toHaveBeenCalled();
              const second = delivery.submit();
              expect(second).not.toBe(first);
              expect(second.defaultPrevented).toBe(true);
              expect(delivery.preventionCount()).toBe(1);
              expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Update candidate.md");
              expect(delivery.deliveries.filter(({ stage }) => stage.startsWith("key")))
                .toHaveLength(4);
              fireEvent(commitForm(), first);
              fireEvent(commitForm(), second);
              expect(first.defaultPrevented).toBe(false);
              expect(delivery.preventionCount()).toBe(1);
              expect(current.onCommit).toHaveBeenCalledOnce();
            } finally {
              delivery.restore();
            }
            await resolve(pending);
          } finally {
            await act(async () => root.unmount());
            host.remove();
          }
        },
      );

      it("does not displace a still-dispatching selected submit with a crossed candidate", async () => {
        const first = deferred<void>();
        const second = deferred<void>();
        const current = actions(first.promise, second.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "live-candidate",
            doc: repoDocument("live-candidate-enter", "live-candidate.md"),
            actions: current,
          });
          let crossing = false;
          let crossed: SubmitEvent | undefined;
          const delivery = probe(host, ({ stage, event }) => {
            if (stage !== "submit form" || crossing) return;
            crossing = true;
            expect(event.nativeEvent.eventPhase).toBe(Event.BUBBLING_PHASE);
            crossed = delivery.submit();
            expect(crossed.defaultPrevented).toBe(false);
            expect(delivery.preventionCount()).toBe(0);
            expect(current.onCommit).not.toHaveBeenCalled();
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(true);
            expect(crossed).toBeInstanceOf(SubmitEvent);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
            fireEvent(commitForm(), crossed!);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
          } finally {
            delivery.restore();
          }
          await reject(first, "Clean candidate successor");
          await cleanSuccessor(host, current);
          await resolve(second);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      });

      it.each(["unmount", "replacement"] as const)(
        "does not read or call Q1 after final prevention causes %s",
        async (change) => {
          const pending = deferred<void>();
          const current = actions(pending.promise);
          const doc = repoDocument("retired-query-enter", "retired-query.md");
          const { host, root } = createHost();
          const retiredReads = vi.fn();
          const retiredCalls = vi.fn();
          let retired = false;
          try {
            await render(root, { visit: "first", doc, actions: current });
            const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
            const delivery = probe(host, ({ stage, event }) => {
              if (stage !== "submit bridge") return;
              let query = event.isDefaultPrevented;
              Object.defineProperty(event, "isDefaultPrevented", {
                get: () => {
                  if (retired) retiredReads();
                  return query;
                },
                set: (next: PublicEvent["isDefaultPrevented"]) => {
                  query = function (this: PublicEvent) {
                    if (retired) retiredCalls();
                    return Reflect.apply(next, this, []);
                  };
                },
              });
              const prevent = event.preventDefault;
              event.preventDefault = () => {
                prevent();
                flushSync(() => root.render(
                  <StrictMode>
                    <CommitBoundary
                      visit="replacement"
                      doc={{ ...doc }}
                      actions={current}
                      present={change !== "unmount"}
                    />
                  </StrictMode>,
                ));
                // The fixture's replacement may manage focus; only effects
                // after it retires this delivery belong to the assertion.
                focus.mockClear();
                retired = true;
              };
            });
            try {
              delivery.key();
              expect(delivery.submit().defaultPrevented).toBe(true);
              expect(retired).toBe(true);
              expect(delivery.preventionCount()).toBe(1);
              expect(retiredReads).not.toHaveBeenCalled();
              expect(retiredCalls).not.toHaveBeenCalled();
              expect(current.onCommit).not.toHaveBeenCalled();
              expect(current.onOpenChange).not.toHaveBeenCalled();
              expect(focus).not.toHaveBeenCalled();
            } finally {
              delivery.restore();
              focus.mockRestore();
            }
            await render(root, { visit: "successor", doc: { ...doc }, actions: current });
            await cleanSuccessor(host, current);
            await resolve(pending);
            expect(retiredReads).not.toHaveBeenCalled();
            expect(retiredCalls).not.toHaveBeenCalled();
          } finally {
            await act(async () => root.unmount());
            host.remove();
          }
        },
      );
    });

    const malformed: Array<[string, Record<string, unknown>]> = [
      ["key", { key: "Escape" }],
      ["code", { code: "Space" }],
      ["location", { location: 2 }],
      ["repeat", { repeat: true }],
      ["alt", { altKey: true }],
      ["control", { ctrlKey: true }],
      ["meta", { metaKey: true }],
      ["shift", { shiftKey: true }],
      ["type", { type: "keyup" }],
      ["bubbles", { bubbles: false }],
      ["cancelable", { cancelable: false }],
      ["trust", { isTrusted: true }],
      ["canceled", { defaultPrevented: true }],
      ["default query", { isDefaultPrevented: () => true }],
      ["propagation query", { isPropagationStopped: () => true }],
      ["prevention method", { preventDefault: null }],
    ];
    it.each(malformed)(
      "rejects malformed key %s without consuming the rightful delivery",
      async (_name, change) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "malformed",
            doc: repoDocument("malformed-enter", "malformed.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event, prevent }, handler) => {
            if (stage !== "key input") return;
            const original = new Map(Object.keys(change).map((key) => [key, Reflect.get(event, key)]));
            Object.assign(event, change);
            handler(event);
            expect(prevent).not.toHaveBeenCalled();
            expect(current.onCommit).not.toHaveBeenCalled();
            for (const [key, value] of original) Reflect.set(event, key, value);
            handler(event);
            handler(event);
            return true;
          });
          try {
            delivery.key();
            expect(delivery.preventionCount()).toBe(0);
            delivery.submit();
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledExactlyOnceWith("Update malformed.md");
          } finally {
            delivery.restore();
          }
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each([
      "key bridge capture", "key input capture", "key input", "key bridge",
      "submit bridge capture", "submit form", "submit bridge",
    ] as const)(
      "rejects wrong currentTarget at %s and preserves its rightful delivery",
      async (boundary) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "wrong-target",
            doc: repoDocument("wrong-target-enter", "targets.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event, prevent }, handler) => {
            if (stage !== boundary) return;
            const target = event.currentTarget;
            event.currentTarget = document.body;
            handler(event);
            expect(prevent).not.toHaveBeenCalled();
            expect(current.onCommit).not.toHaveBeenCalled();
            event.currentTarget = target;
            handler(event);
            return true;
          });
          try {
            delivery.key();
            delivery.submit();
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
          } finally {
            delivery.restore();
          }
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each([
      { repeat: true },
      { isComposing: true },
      { ctrlKey: true },
      { code: "Space" },
      { location: 2 },
      { bubbles: false },
      { cancelable: false },
    ])("rejects native key facts %j and immediately recovers", async (init) => {
      const pending = deferred<void>();
      const current = actions(pending.promise);
      const { host, root } = createHost();
      try {
        await render(root, {
          visit: "native",
          doc: repoDocument("native-enter", "native.md"),
          actions: current,
        });
        const delivery = probe(host);
        try {
          delivery.key(init);
          expect(delivery.submit().defaultPrevented).toBe(false);
          expect(delivery.preventionCount()).toBe(0);
          expect(current.onCommit).not.toHaveBeenCalled();
        } finally {
          delivery.restore();
        }
        await cleanSuccessor(host, current);
        await resolve(pending);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["", " \t "])("does not submit blank message %j", async (text) => {
      const pending = deferred<void>();
      const current = actions(pending.promise);
      const { host, root } = createHost();
      try {
        await render(root, {
          visit: "blank",
          doc: repoDocument("blank-enter", "blank.md"),
          actions: current,
        });
        fireEvent.change(message(), { target: { value: text } });
        await flushPublication();
        const delivery = probe(host);
        try {
          delivery.key();
          expect(delivery.submit().defaultPrevented).toBe(false);
          expect(delivery.preventionCount()).toBe(0);
          expect(current.onCommit).not.toHaveBeenCalled();
        } finally {
          delivery.restore();
        }
        await cleanSuccessor(host, current, "Nonblank Enter successor");
        await resolve(pending);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it("keeps crossed genuine keys and submit deliveries separate, then accepts a complete successor after error", async () => {
      const first = deferred<void>();
      const second = deferred<void>();
      const current = actions(first.promise, second.promise);
      const { host, root } = createHost();
      try {
        await render(root, {
          visit: "crossed",
          doc: repoDocument("crossed-enter", "crossed.md"),
          actions: current,
        });
        let outer: PublicEvent | undefined;
        let nested = false;
        let crossed = false;
        const delivery = probe(host, ({ stage, event }, handler) => {
          if (stage !== "key input") return;
          if (!nested) {
            outer = event;
            nested = true;
            dispatchCommitKey(message(), "Enter", {}, false);
          } else if (!crossed && outer) {
            crossed = true;
            const native = event.nativeEvent;
            event.nativeEvent = outer.nativeEvent;
            handler(event);
            event.nativeEvent = native;
          }
        });

        try {
          const key = delivery.key();
          expect(crossed).toBe(true);
          expect(key.defaultPrevented).toBe(false);
          expect(delivery.preventionCount()).toBe(0);
          expect(current.onCommit).not.toHaveBeenCalled();
          const submission = delivery.submit();
          expect(submission.defaultPrevented).toBe(true);
          expect(delivery.preventionCount()).toBe(1);
          expect(current.onCommit).toHaveBeenCalledOnce();
          delivery.submit();
          fireEvent(message(), key);
          expect(delivery.preventionCount()).toBe(1);
          expect(current.onCommit).toHaveBeenCalledOnce();
        } finally {
          delivery.restore();
        }
        await reject(first, "Retry this commit");
        expect(screen.getByText("Retry this commit")).toBeVisible();
        await cleanSuccessor(host, current);
        await resolve(second);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["key bridge", "submit bridge"] as const)(
      "does not complete an unfinished %s dispatch through replay",
      async (missing) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "unfinished",
            doc: repoDocument("unfinished-enter", "unfinished.md"),
            actions: current,
          });
          let omit = true;
          const delivery = probe(host, ({ stage }) => stage === missing && omit);
          try {
            const key = delivery.key();
            const submit = missing === "submit bridge" ? delivery.submit() : null;
            omit = false;
            if (submit) fireEvent(commitForm(), submit);
            else fireEvent(message(), key);
            expect(delivery.preventionCount()).toBe(0);
            expect(current.onCommit).not.toHaveBeenCalled();
          } finally {
            delivery.restore();
          }
          await cleanSuccessor(host, current);
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it("preserves keyboard activation of Commit after an Enter submission fails", async () => {
      const first = deferred<void>();
      const second = deferred<void>();
      const current = actions(first.promise, second.promise);
      const { host, root } = createHost();
      try {
        await render(root, {
          visit: "button",
          doc: repoDocument("button-enter", "button.md"),
          actions: current,
        });
        const delivery = probe(host);
        try {
          delivery.key();
          delivery.submit();
          expect(current.onCommit).toHaveBeenCalledOnce();
        } finally {
          delivery.restore();
        }
        await reject(first, "Try again");
        await flushPublication();
        const button = screen.getByTestId<HTMLButtonElement>("commit-submit");
        button.focus();
        fireEvent.click(button, { detail: 0 });
        expect(current.onCommit).toHaveBeenCalledTimes(2);
        expect(current.onCommit).toHaveBeenLastCalledWith("Update button.md");
        await resolve(second);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["isDefaultPrevented", "isPropagationStopped"] as const)(
      "never invokes a stale %s replaced by an earlier public callback",
      async (method) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        const stale = vi.fn(() => false);
        try {
          await render(root, {
            visit: "method",
            doc: repoDocument("method-enter", "method.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event }) => {
            if (stage !== "submit bridge") return;
            if (method === "isPropagationStopped") {
              event.isPropagationStopped = stale;
              event.isDefaultPrevented = () => {
                event.isPropagationStopped = () => false;
                return false;
              };
            } else {
              event.isDefaultPrevented = stale;
              const native = event.nativeEvent;
              Object.defineProperty(event, "defaultPrevented", {
                get: () => {
                  event.isDefaultPrevented = () => false;
                  return native.defaultPrevented;
                },
              });
            }
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(false);
            expect(stale).not.toHaveBeenCalled();
            expect(delivery.preventionCount()).toBe(0);
            expect(current.onCommit).not.toHaveBeenCalled();
          } finally {
            delivery.restore();
          }
          await cleanSuccessor(host, current);
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    const reentrantBoundaries = ([
      "key bridge capture", "key input capture", "key input", "key bridge",
      "submit bridge capture", "submit form", "submit bridge",
    ] as const).flatMap((boundary) =>
      (["isDefaultPrevented", "isPropagationStopped"] as const).map((method) => ({
        boundary,
        method,
      })),
    );
    it.each([
      ...reentrantBoundaries,
      { boundary: "submit bridge" as const, method: "preventDefault" as const },
    ])(
      "excludes reentrant key and submit attempts from $boundary $method",
      async ({ boundary, method }) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "reentrant",
            doc: repoDocument("reentrant-enter", "reentrant.md"),
            actions: current,
          });
          let attempted = false;
          let innerKey: KeyboardEvent | undefined;
          let innerSubmit: SubmitEvent | undefined;
          const delivery = probe(host, ({ stage, event }) => {
            if (stage !== boundary) return;
            const original = event[method];
            Reflect.set(event, method, () => {
              if (!attempted) {
                attempted = true;
                innerKey = dispatchCommitKey(message(), "Enter", {}, false);
                innerSubmit = nativeSubmit(commitForm());
                fireEvent(commitForm(), innerSubmit);
              }
              return original();
            });
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(true);
            expect(attempted).toBe(true);
            expect(innerKey?.defaultPrevented).toBe(false);
            expect(innerSubmit?.defaultPrevented).toBe(false);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
          } finally {
            delivery.restore();
          }
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each([
      "target", "nativeEvent", "type", "bubbles", "cancelable",
      "defaultPrevented", "isDefaultPrevented", "isPropagationStopped",
    ] as const)(
      "rejects malformed submit %s without preventing or consuming its rightful delivery",
      async (field) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "submit-facts",
            doc: repoDocument("submit-facts-enter", "submit-facts.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event, prevent }, handler) => {
            if (stage !== "submit form") return;
            const original = Reflect.get(event, field);
            const invalid =
              field === "target" ? document.body :
              field === "nativeEvent" ? nativeSubmit(commitForm()) :
              field === "type" ? "keydown" :
              field === "defaultPrevented" ? true :
              field.startsWith("is") ? () => true : false;
            Reflect.set(event, field, invalid);
            handler(event);
            expect(prevent).not.toHaveBeenCalled();
            expect(current.onCommit).not.toHaveBeenCalled();
            Reflect.set(event, field, original);
            handler(event);
            return true;
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(true);
            expect(delivery.preventionCount()).toBe(1);
            expect(current.onCommit).toHaveBeenCalledOnce();
          } finally {
            delivery.restore();
          }
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each([
      "message", "form", "content", "disabled", "focus", "connectivity",
      "Window", "addEventListener", "removeEventListener",
    ] as const)(
      "rejects current %s drift from a public query and accepts a clean successor",
      async (field) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        let restore = () => {};
        try {
          await render(root, {
            visit: "drift",
            doc: repoDocument("drift-enter", "drift.md"),
            actions: current,
          });
          let changed = false;
          const delivery = probe(host, ({ stage, event }) => {
            if (stage !== "submit bridge") return;
            event.isDefaultPrevented = () => {
              if (!changed) {
                changed = true;
                const input = message();
                const form = commitForm();
                const button = screen.getByTestId<HTMLButtonElement>("commit-submit");
                if (field === "message") {
                  const value = input.value;
                  input.value = "Not the authorized message";
                  restore = () => { input.value = value; };
                } else if (field === "form") {
                  input.setAttribute("form", "another-form");
                  restore = () => input.removeAttribute("form");
                } else if (field === "content") {
                  const content = form.parentElement!;
                  content.setAttribute("data-enter-content", "changed");
                  restore = () => content.removeAttribute("data-enter-content");
                } else if (field === "disabled") {
                  button.disabled = true;
                  restore = () => { button.disabled = false; };
                } else if (field === "focus") {
                  button.focus();
                  restore = () => input.focus();
                } else if (field === "connectivity") {
                  const next = input.nextSibling;
                  input.remove();
                  restore = () => {
                    form.insertBefore(input, next);
                    input.focus();
                  };
                } else if (field === "Window") {
                  const descriptor = Object.getOwnPropertyDescriptor(document, "defaultView");
                  let changedRead = false;
                  Object.defineProperty(document, "defaultView", {
                    configurable: true,
                    get: () => {
                      if (!changedRead) {
                        changedRead = true;
                        return null;
                      }
                      return window;
                    },
                  });
                  restore = () => {
                    if (descriptor) Object.defineProperty(document, "defaultView", descriptor);
                    else Reflect.deleteProperty(document, "defaultView");
                  };
                } else {
                  const original = window[field];
                  Reflect.set(window, field, (...args: unknown[]) =>
                    Reflect.apply(original, window, args),
                  );
                  restore = () => Reflect.set(window, field, original);
                }
              }
              return false;
            };
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(false);
            expect(changed).toBe(true);
            expect(delivery.preventionCount()).toBe(0);
            expect(current.onCommit).not.toHaveBeenCalled();
          } finally {
            restore();
            delivery.restore();
          }
          await render(root, {
            visit: "recovered",
            doc: repoDocument("drift-enter-recovered", "recovered.md"),
            actions: current,
          });
          await cleanSuccessor(host, current);
          await resolve(pending);
        } finally {
          restore();
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each(["independent capture", "independent bubble", "later final query"] as const)(
      "does not adopt an unrelated %s replacement after exact prevention",
      async (replacement) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        const allowedQuery = vi.fn(() => true);
        let capture: PublicEvent | undefined;
        try {
          await render(root, {
            visit: "replacement",
            doc: repoDocument("replacement-enter", "replacement.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event }) => {
            if (stage === (replacement === "independent bubble"
              ? "submit form" : "submit bridge capture")) capture = event;
            if (stage !== "submit bridge") return;
            const native = event.nativeEvent;
            const nativeDefault = Object.getOwnPropertyDescriptor(Event.prototype, "defaultPrevented")!.get!;
            let prevented = false;
            const prevent = event.preventDefault;
            event.preventDefault = () => {
              prevent();
              event.isDefaultPrevented = allowedQuery;
              prevented = true;
              if (replacement !== "later final query" && capture) {
                capture.isDefaultPrevented = () => false;
              }
            };
            if (replacement === "later final query") {
              Object.defineProperty(native, "defaultPrevented", {
                get: () => {
                  if (prevented) event.isDefaultPrevented = () => true;
                  return Reflect.apply(nativeDefault, native, []);
                },
              });
            }
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(true);
            expect(delivery.preventionCount()).toBe(1);
            expect(allowedQuery).not.toHaveBeenCalled();
            expect(current.onCommit).not.toHaveBeenCalled();
          } finally {
            delivery.restore();
          }
          await cleanSuccessor(host, current);
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it("keeps callback exclusion through synchronous republication during prevention", async () => {
      const pending = deferred<void>();
      const current = actions(pending.promise);
      const doc = repoDocument("republication-enter", "republication.md");
      const { host, root } = createHost();
      try {
        await render(root, { visit: "first", doc, actions: current });
        let nestedKey: KeyboardEvent | undefined;
        let nestedSubmit: SubmitEvent | undefined;
        const delivery = probe(host, ({ stage, event }) => {
          if (stage !== "submit bridge") return;
          const prevent = event.preventDefault;
          event.preventDefault = () => {
            prevent();
            flushSync(() => root.render(
              <StrictMode>
                <CommitBoundary visit="second" doc={{ ...doc }} actions={current} />
              </StrictMode>,
            ));
            nestedKey = dispatchCommitKey(message(), "Enter", {}, false);
            nestedSubmit = nativeSubmit(commitForm());
            fireEvent(commitForm(), nestedSubmit);
          };
        });
        try {
          delivery.key();
          expect(delivery.submit().defaultPrevented).toBe(true);
          expect(delivery.preventionCount()).toBe(1);
          expect(nestedKey?.defaultPrevented).toBe(false);
          expect(nestedSubmit?.defaultPrevented).toBe(false);
          expect(current.onCommit).not.toHaveBeenCalled();
        } finally {
          delivery.restore();
        }
        await cleanSuccessor(host, current);
        await resolve(pending);
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    });

    it.each(["before prevention", "during prevention"] as const)(
      "rejects DOM invalidation %s and restores a clean route",
      async (when) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const { host, root } = createHost();
        try {
          await render(root, {
            visit: "dom",
            doc: repoDocument("dom-enter", "dom.md"),
            actions: current,
          });
          const delivery = probe(host, ({ stage, event }) => {
            if (stage !== "submit bridge") return;
            const mutate = () => {
              const form = commitForm();
              form.setAttribute("data-enter-drift", "changed");
              form.removeAttribute("data-enter-drift");
            };
            if (when === "before prevention") {
              event.isPropagationStopped = () => {
                mutate();
                return false;
              };
            } else {
              const prevent = event.preventDefault;
              event.preventDefault = () => {
                prevent();
                mutate();
              };
            }
          });
          try {
            delivery.key();
            expect(delivery.submit().defaultPrevented).toBe(when === "during prevention");
            expect(delivery.preventionCount()).toBe(when === "during prevention" ? 1 : 0);
            expect(current.onCommit).not.toHaveBeenCalled();
          } finally {
            delivery.restore();
          }
          await flushPublication();
          await cleanSuccessor(host, current);
          await resolve(pending);
        } finally {
          await act(async () => root.unmount());
          host.remove();
        }
      },
    );

    it.each(["rerender", "close/reopen", "remount", "partial replay", "unmount"] as const)(
      "retires retained Enter claims on %s",
      async (change) => {
        const pending = deferred<void>();
        const current = actions(pending.promise);
        const doc = repoDocument("lifecycle-enter", "lifecycle.md");
        const { host, root } = createHost();
        let unmounted = false;
        try {
          await render(root, { visit: "first", doc, actions: current });
          const oldForm = commitForm();
          const oldInput = message();
          const delivery = probe(host);
          const key = delivery.key();
          delivery.restore();
          if (change === "partial replay") {
            act(() => reactRef(oldInput)(null));
          } else if (change === "unmount") {
            await act(async () => root.unmount());
            unmounted = true;
          } else if (change === "rerender") {
            await render(root, { visit: "next", doc: { ...doc }, actions: current });
          } else {
            await render(root, {
              visit: "closed", doc, actions: current,
              ...(change === "remount" ? { present: false } : { open: false }),
            });
            await render(root, { visit: "next", doc, actions: current });
          }
          const stale = nativeSubmit(oldForm);
          fireEvent(oldInput, key);
          fireEvent(oldForm, stale);
          expect(current.onCommit).not.toHaveBeenCalled();
          expect(stale.defaultPrevented).toBe(false);
          if (change === "partial replay") {
            await render(root, { visit: "fresh", doc: { ...doc }, actions: current });
          }
          if (!unmounted) {
            await cleanSuccessor(host, current);
            await resolve(pending);
          }
        } finally {
          if (!unmounted) await act(async () => root.unmount());
          host.remove();
        }
      },
    );
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

  it.each(EVENT_SUPPRESSION_CASES)(
    "uses captured Event.$method through $mutation drift for a linked $origin nomination and a clean successor",
    async ({ method, mutation, origin }) => {
      vi.stubGlobal("PointerEvent", ControlledPointerEvent);
      const current = actions();
      const doc = repoDocument(
        `doc-${method}-${mutation}-${origin}`,
        "docs/suppression.md",
      );
      const { host, root } = createHost();
      let restoreMethod: (() => void) | null = null;
      let overlayListener: EventListener | null = null;

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
        const reachedSharedLayer = vi.fn();
        overlayListener = reachedSharedLayer;
        overlay.addEventListener(POINTER_DOWN_OUTSIDE, overlayListener);
        restoreMethod = mutateEventSuppressionMethod(method, mutation);

        const foreignNomination = outsidePointerNomination(
          controlledPointer("pointerdown", 31),
        );
        act(() => {
          overlay.dispatchEvent(foreignNomination);
        });
        expect(foreignNomination.defaultPrevented).toBe(false);
        expect(reachedSharedLayer).toHaveBeenCalledExactlyOnceWith(
          foreignNomination,
        );
        reachedSharedLayer.mockClear();

        const linkedPointerDown = controlledPointer("pointerdown", 32);
        act(() => {
          overlay.dispatchEvent(linkedPointerDown);
          if (origin === "rejected") {
            overlay.dispatchEvent(controlledPointer("pointercancel", 32));
          }
        });
        const linkedNomination =
          outsidePointerNomination(linkedPointerDown);
        expect(() => {
          act(() => {
            overlay.dispatchEvent(linkedNomination);
          });
        }).not.toThrow();

        expect(linkedNomination.defaultPrevented).toBe(true);
        expect(reachedSharedLayer).not.toHaveBeenCalled();
        expect(current.onOpenChange).not.toHaveBeenCalled();

        restoreMethod();
        restoreMethod = null;
        overlay.removeEventListener(POINTER_DOWN_OUTSIDE, overlayListener);
        overlayListener = null;
        await flushPublication();
        await advance(0);

        act(() => requestOpenChange(false));
        expect(current.onOpenChange).not.toHaveBeenCalled();
        const successorOverlay = document.querySelector(".dialog-overlay");
        if (!(successorOverlay instanceof HTMLDivElement)) {
          throw new Error("The successor commit dialog overlay was not rendered");
        }
        act(() => {
          successorOverlay.dispatchEvent(controlledPointer("click", 32));
        });
        await flushPublication();
        expect(current.onOpenChange).not.toHaveBeenCalled();

        act(() => {
          successorOverlay.dispatchEvent(controlledPointer("pointerdown", 33));
          successorOverlay.dispatchEvent(controlledPointer("pointerup", 33));
        });
        await Promise.resolve();
        act(() => {
          successorOverlay.dispatchEvent(controlledPointer("click", 33));
        });
        expect(current.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        restoreMethod?.();
        const overlay = document.querySelector(".dialog-overlay");
        if (overlayListener && overlay) {
          overlay.removeEventListener(
            POINTER_DOWN_OUTSIDE,
            overlayListener,
          );
        }
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

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
