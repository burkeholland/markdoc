// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, createElement, useEffect, useLayoutEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefCallback } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import * as Y from "yjs";

type ControlledStateSetter = (next: never) => unknown;

const mentionHighlightReentry = vi.hoisted(() => ({
  callback: null as (() => void) | null,
  setters: new WeakMap<ControlledStateSetter, ControlledStateSetter>(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initialState: unknown) => {
    const [value, setValue] = actual.useState(initialState);
    const setter = setValue as ControlledStateSetter;
    let wrapped = mentionHighlightReentry.setters.get(setter);
    if (!wrapped) {
      wrapped = (next: never) => {
        const result = setValue(next as never);
        mentionHighlightReentry.callback?.();
        return result;
      };
      mentionHighlightReentry.setters.set(setter, wrapped);
    }
    return [value, wrapped] as const;
  }) as typeof actual.useState;
  return { ...actual, useState };
});

// A provider that only supplies the awareness instance; tests drive presence by applying a remote client's
// awareness state to it and firing `onAwarenessChange`, as Hocuspocus does when the server relays one.
vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    static last: HocuspocusProvider | null = null;
    constructor(readonly opts: { document: Y.Doc; onAwarenessChange?: (e: { states: unknown[] }) => void }) {
      this.awareness = new Awareness(opts.document);
      HocuspocusProvider.last = this;
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

// The real module, with `claimerName` counted: the request chip must not be asked for a label when nothing about an
// agent changed (#1382).
vi.mock("./agent-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-requests")>();
  return { ...actual, claimerName: vi.fn(actual.claimerName) };
});

vi.mock("@/editor/collab/suggestion-block", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/editor/collab/suggestion-block")>();
  return { ...actual, parseSuggestionBlock: vi.fn(actual.parseSuggestionBlock) };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      documents: {
        collaborators: vi.fn().mockResolvedValue({ owner: null, collaborators: [], agents: [] }),
        reviews: vi.fn().mockResolvedValue({ reviews: [] }),
        comment: vi.fn().mockResolvedValue({ id: "via-api" }),
        createRequest: vi.fn().mockResolvedValue({ request: { id: "req" } }),
      },
      tokens: {
        list: vi.fn().mockResolvedValue({ tokens: [] }),
      },
    },
  };
});

vi.mock("@/lib/notifications-store", () => ({
  markRefsRead: vi.fn(),
  useUnreadRefs: () => new Set<string>(),
}));

import { HocuspocusProvider } from "@hocuspocus/provider";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { api } from "@/lib/api";
import { AGENT_CONNECT_DISMISSED_KEY } from "@/lib/mcp";
import { parseSuggestionBlock } from "@/editor/collab/suggestion-block";
import type { AgentRequestMirror } from "@/server/agent-requests";
import type { ReviewDto } from "@/server/reviews";
import { TooltipProvider } from "@/components/ui/primitives";
import { claimerName, requestInstruction, waitForSynced, type AgentRequestMode } from "./agent-requests";
import { CommentsPanel, isReviewOpen, mentionedAgents, type CommentsPanelProps } from "./comments-panel";

/** The mocked provider of the session under test (see the `@hocuspocus/provider` mock above). */
type FakeProvider = { opts: { onAwarenessChange?: (e: { states: unknown[] }) => void } };
const lastProvider = () => (HocuspocusProvider as unknown as { last: FakeProvider | null }).last!;

function reviewDto(id: string, threadIds: string[], documentId = "doc"): ReviewDto {
  return {
    id,
    documentId,
    authorId: "alice",
    authorName: "Copilot",
    collabAuthorId: "agent:alice:Copilot",
    agent: "Copilot",
    verdict: "request_changes",
    summary: `Review ${id}.`,
    threadIds,
    createdAt: new Date().toISOString(),
  };
}

type ReviewsResponse = Awaited<ReturnType<typeof api.documents.reviews>>;
type CommentResponse = Awaited<ReturnType<typeof api.documents.comment>>;
type CollaboratorsResponse = Awaited<ReturnType<typeof api.documents.collaborators>>;
type TokensResponse = Awaited<ReturnType<typeof api.tokens.list>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type RequestModeKeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
type CommentMenuKeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
type ReactionPickerKeyHandler = (event: ReactKeyboardEvent<HTMLButtonElement>) => void;

function markRequestModeEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
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
    throw new Error("Unable to set jsdom's internal request-mode event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) throw new Error("The request-mode event trust slot did not update");
}

function replaceReactionPickerPathTerminal(
  event: Event,
  terminal: EventTarget,
) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map((symbol) => (event as unknown as Record<symbol, unknown>)[symbol])
    .find((candidate): candidate is {
      _path: Array<{ item: Record<symbol, unknown> }>;
    } => {
      if (!candidate || typeof candidate !== "object") return false;
      return Array.isArray((candidate as { _path?: unknown })._path);
    });
  const entry = implementation?._path.at(-1);
  const currentTerminal = event.composedPath().at(-1);
  const wrapper = entry
    ? Object.getOwnPropertySymbols(entry.item).find(
        (symbol) => entry.item[symbol] === currentTerminal,
      )
    : undefined;
  if (!entry || !wrapper) {
    throw new Error("Unable to replace jsdom's reaction keyboard path terminal");
  }
  const item: Record<symbol, unknown> = {};
  Object.defineProperty(item, wrapper, { value: terminal });
  entry.item = item;
  if (event.composedPath().at(-1) !== terminal) {
    throw new Error("The reaction keyboard path terminal did not update");
  }
}

function requestModeKeyboardEvent(
  element: HTMLButtonElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The request-mode control has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markRequestModeEventTrusted(event);
  return event;
}

function requestModeKey(
  element: HTMLButtonElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = requestModeKeyboardEvent(element, key, init);
  element.dispatchEvent(event);
  return event;
}

function commentMenuKeyboardEvent(
  element: HTMLButtonElement,
  key: "ArrowDown" | "ArrowUp",
  init: Omit<KeyboardEventInit, "key" | "code"> = {},
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The comment action trigger has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markRequestModeEventTrusted(event);
  return event;
}

function commentMenuKey(
  element: HTMLButtonElement,
  key: "ArrowDown" | "ArrowUp",
  init: Omit<KeyboardEventInit, "key" | "code"> = {},
) {
  const event = commentMenuKeyboardEvent(element, key, init);
  element.dispatchEvent(event);
  return event;
}

function reactionPickerKeyboardEvent(
  element: HTMLButtonElement,
  key: "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp" | "Home" | "End",
  init: Omit<KeyboardEventInit, "key" | "code"> = {},
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The reaction option has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markRequestModeEventTrusted(event);
  return event;
}

function reactionPickerKey(
  element: HTMLButtonElement,
  key: "ArrowRight" | "ArrowDown" | "ArrowLeft" | "ArrowUp" | "Home" | "End",
  init: Omit<KeyboardEventInit, "key" | "code"> = {},
) {
  const event = reactionPickerKeyboardEvent(element, key, init);
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function mentionKeyboardEvent(
  element: HTMLTextAreaElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The mention composer has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  markRequestModeEventTrusted(event);
  return event;
}

function mentionKey(
  element: HTMLTextAreaElement,
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
) {
  const event = mentionKeyboardEvent(element, key, init);
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function requestModeHandler(element: HTMLButtonElement) {
  return reactProperty<RequestModeKeyHandler>(element, "onKeyDown");
}

function requestModeCaptureHandler(element: HTMLButtonElement) {
  return reactProperty<RequestModeKeyHandler>(element, "onKeyDownCapture");
}

function requestModeButtonRef(element: HTMLButtonElement) {
  const fiberKey = Object.keys(element).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (!fiberKey) {
    throw new Error("React fiber was not attached to the request mode");
  }
  const ref = (
    element as unknown as Record<
      string,
      { ref?: RefCallback<HTMLButtonElement> | null }
    >
  )[fiberKey]?.ref;
  if (typeof ref !== "function") {
    throw new Error("A callback ref was not attached to the request mode");
  }
  return ref;
}

function dispatchRequestModeKeyWithBoundaryProbe(
  source: HTMLButtonElement,
  key: string,
  alter?: (
    phase: "capture-before" | "capture-after" | "bubble-before",
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void,
  focus = true,
) {
  const propsKey = Object.keys(source).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  if (!propsKey) {
    throw new Error("React props were not attached to the request mode");
  }
  const record = source as unknown as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const props = record[propsKey];
  const captureHandler = props?.onKeyDownCapture;
  const bubbleHandler = props?.onKeyDown;
  if (
    !props ||
    typeof captureHandler !== "function" ||
    typeof bubbleHandler !== "function"
  ) {
    throw new Error("Both request-mode keyboard boundaries must be attached");
  }
  const pair: {
    capture?: ReactKeyboardEvent<HTMLButtonElement>;
    bubble?: ReactKeyboardEvent<HTMLButtonElement>;
  } = {};
  const replacement = {
    ...props,
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      pair.capture = event;
      alter?.("capture-before", event);
      (captureHandler as RequestModeKeyHandler)(event);
      alter?.("capture-after", event);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      pair.bubble = event;
      alter?.("bubble-before", event);
      (bubbleHandler as RequestModeKeyHandler)(event);
    },
  };
  record[propsKey] = replacement;
  if (focus) source.focus();
  const nativeEvent = requestModeKeyboardEvent(source, key);
  try {
    act(() => {
      source.dispatchEvent(nativeEvent);
    });
  } finally {
    if (record[propsKey] === replacement) record[propsKey] = props;
  }
  if (!pair.capture || !pair.bubble) {
    throw new Error("The key did not cross both request-mode boundaries");
  }
  return {
    nativeEvent,
    capture: pair.capture,
    bubble: pair.bubble,
  };
}

function commentMenuHandler(element: HTMLButtonElement) {
  return reactProperty<CommentMenuKeyHandler>(element, "onKeyDown");
}

function commentMenuCaptureHandler(element: HTMLButtonElement) {
  return reactProperty<CommentMenuKeyHandler>(element, "onKeyDownCapture");
}

function reactionPickerHandler(element: HTMLButtonElement) {
  return reactProperty<ReactionPickerKeyHandler>(element, "onKeyDownCapture");
}

function commentMenuItemRef(element: HTMLElement) {
  const fiberKey = Object.keys(element).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (!fiberKey) throw new Error("React fiber was not attached to the menu item");
  const ref = (
    element as unknown as Record<
      string,
      { ref?: RefCallback<HTMLElement> | null }
    >
  )[fiberKey]?.ref;
  if (typeof ref !== "function") {
    throw new Error("React did not publish the composed menu item ref");
  }
  return ref;
}

function fabricatedCommentMenuWrapper(
  element: HTMLButtonElement,
  nativeEvent: KeyboardEvent,
) {
  return {
    _reactName: "onKeyDown",
    type: nativeEvent.type,
    nativeEvent,
    target: element,
    currentTarget: element,
    key: nativeEvent.key,
    code: nativeEvent.code,
    eventPhase: nativeEvent.eventPhase,
    repeat: nativeEvent.repeat,
    altKey: nativeEvent.altKey,
    ctrlKey: nativeEvent.ctrlKey,
    metaKey: nativeEvent.metaKey,
    shiftKey: nativeEvent.shiftKey,
    bubbles: nativeEvent.bubbles,
    cancelable: nativeEvent.cancelable,
    defaultPrevented: nativeEvent.defaultPrevented,
    isTrusted: nativeEvent.isTrusted,
    view: nativeEvent.view,
    isDefaultPrevented: () => nativeEvent.defaultPrevented,
    isPropagationStopped: () => nativeEvent.cancelBubble,
    persist: () => undefined,
  } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
}

interface CapturedReviewMouseEvent {
  type: string;
  currentTarget: EventTarget | null;
  target: EventTarget | null;
  nativeEvent: Event;
}

type ReviewMouseHandler = (event: CapturedReviewMouseEvent) => void;
type ReviewElementRef<T extends HTMLElement> = (element: T | null) => void;

interface CapturedReviewControl {
  element: HTMLButtonElement;
  click: ReviewMouseHandler;
  ref: ReviewElementRef<HTMLButtonElement>;
}

function reactProperty<T>(element: HTMLElement, property: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached while capturing ${property}`);
  const props = (element as unknown as Record<string, Record<string, unknown>>)[propsKey];
  const value = props[property];
  if (!value) throw new Error(`React did not publish ${property}`);
  return value as T;
}

function replaceReactProperties(
  element: HTMLElement,
  replacements: Record<string, unknown>,
) {
  const propsKey = Object.keys(element).find((key) =>
    key.startsWith("__reactProps$"),
  );
  if (!propsKey) throw new Error("React props were not attached");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  const props = record[propsKey];
  record[propsKey] = { ...props, ...replacements };
  return () => {
    record[propsKey] = props;
  };
}

function interceptReviewClick(
  element: HTMLButtonElement,
  invoke: (original: ReviewMouseHandler, event: CapturedReviewMouseEvent) => void,
  property = "onClick",
) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached while intercepting onClick");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  const props = record[propsKey];
  const original = props[property];
  if (typeof original !== "function") throw new Error(`React did not publish ${property}`);
  record[propsKey] = {
    ...props,
    [property]: (event: CapturedReviewMouseEvent) => invoke(original as ReviewMouseHandler, event),
  };
  return () => {
    record[propsKey] = props;
  };
}

// Production builds minify React's SyntheticBaseEvent class name, so a real click there has a one-letter constructor.
const MangledSyntheticEvent = class a {};

function interceptMangledReviewClick(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached while intercepting onClick");
  const record = element as unknown as Record<string, Record<string, unknown>>;
  const props = record[propsKey];
  const original = props.onClick;
  if (typeof original !== "function") throw new Error("React did not publish onClick");
  const intercepted = {
    ...props,
    onClick: (event: CapturedReviewMouseEvent) => {
      const prototype = Object.create(Object.getPrototypeOf(event), {
        constructor: { value: MangledSyntheticEvent },
      });
      const mangled = Object.assign(Object.create(prototype), event) as CapturedReviewMouseEvent;
      expect(Object.getPrototypeOf(mangled).constructor.name).toBe("a");
      (original as ReviewMouseHandler)(mangled);
    },
  };
  record[propsKey] = intercepted;
  return () => {
    if (record[propsKey] === intercepted) record[propsKey] = props;
  };
}

function captureReviewControl(element: HTMLElement, clickProperty = "onClick"): CapturedReviewControl {
  const Button = element.ownerDocument.defaultView?.HTMLButtonElement;
  if (!Button || !(element instanceof Button)) throw new Error("The review control was not a button");
  return {
    element,
    click: reactProperty<ReviewMouseHandler>(element, clickProperty),
    ref: reactProperty<ReviewElementRef<HTMLButtonElement>>(element, "ref"),
  };
}

function reviewMouseEvent(
  control: CapturedReviewControl,
  currentTarget: EventTarget | null = control.element,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
  type = "click",
): CapturedReviewMouseEvent {
  const ownerDocument = currentTarget instanceof Node ? currentTarget.ownerDocument ?? document : document;
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  const nativeEvent = new MouseEventConstructor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: nativeTarget });
  return { type, currentTarget, target, nativeEvent };
}

function invokeReviewControl(
  control: CapturedReviewControl,
  currentTarget: EventTarget | null = control.element,
  target: EventTarget | null = currentTarget,
  nativeTarget: EventTarget | null = target,
) {
  control.click(reviewMouseEvent(control, currentTarget, target, nativeTarget));
}

function dispatchReviewClick(element: HTMLElement, event?: MouseEvent) {
  const MouseEventConstructor = element.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  element.dispatchEvent(event ?? new MouseEventConstructor("click", { bubbles: true, cancelable: true }));
}

interface CapturedSuggestionActions {
  root: HTMLDivElement;
  accept: { element: HTMLButtonElement } | null;
  reject: { element: HTMLButtonElement } | null;
}

function captureSuggestionGroup(
  scope: ParentNode,
  rootTestId: string,
  acceptTestId: string,
  rejectTestId: string,
  index = 0,
): CapturedSuggestionActions {
  const root = scope.querySelectorAll<HTMLElement>(`[data-testid="${rootTestId}"]`).item(index);
  const Root = root?.ownerDocument.defaultView?.HTMLDivElement;
  if (!Root || !(root instanceof Root)) throw new Error(`${rootTestId} was not rendered`);
  const accept = root.querySelector<HTMLButtonElement>(`[data-testid="${acceptTestId}"]`);
  const reject = root.querySelector<HTMLButtonElement>(`[data-testid="${rejectTestId}"]`);
  return {
    root,
    accept: accept ? { element: accept } : null,
    reject: reject ? { element: reject } : null,
  };
}

function captureSuggestionActions(scope: ParentNode = document, index = 0): CapturedSuggestionActions {
  return captureSuggestionGroup(
    scope,
    "suggestion-actions",
    "suggestion-accept-comment",
    "suggestion-reject-comment",
    index,
  );
}

function suggestionEventView(
  ownerDocument: Document,
  ownerWindow: Window & typeof globalThis,
): Window & typeof globalThis {
  const implementationSymbol = Object.getOwnPropertySymbols(ownerDocument).find(
    (symbol) => String(symbol) === "Symbol(impl)",
  );
  return implementationSymbol
    ? (
        ownerDocument as Document &
          Record<
            symbol,
            { _globalObject: Window & typeof globalThis }
          >
      )[implementationSymbol]._globalObject
    : ownerWindow;
}

function suggestionKeyboardEvent(
  element: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The suggestion action has no owner window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: suggestionEventView(element.ownerDocument, ownerWindow),
    ...init,
  });
  if (trusted) markRequestModeEventTrusted(event);
  return event;
}

function dispatchSuggestionKey(
  element: HTMLButtonElement,
  key: string,
  init: KeyboardEventInit = {},
  trusted = true,
) {
  const event = suggestionKeyboardEvent(element, key, init, trusted);
  act(() => element.dispatchEvent(event));
  return event;
}

function captureSuggestionBatchActions(scope: ParentNode = document): CapturedSuggestionActions {
  return captureSuggestionGroup(scope, "suggestion-batch-actions", "accept-all", "reject-all");
}

/**
 * A browser runs a microtask checkpoint after every event listener it calls, so microtasks queued by an earlier
 * listener (a window capture listener, say) have all run before React's root listener sees the click (#2212). jsdom
 * calls the listeners back to back inside one dispatch. This root delays its React click listeners until pending
 * microtasks have drained, the way a real click reaches them.
 */
function createCheckpointRoot(host: HTMLElement) {
  const delivered: Promise<void>[] = [];
  const add = host.addEventListener;
  host.addEventListener = function (
    this: HTMLElement,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type !== "click" || typeof listener !== "function") return add.call(this, type, listener!, options);
    return add.call(
      this,
      type,
      (event: Event) => {
        delivered.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              listener.call(host, event);
              resolve();
            }, 0);
          }),
        );
      },
      options,
    );
  } as typeof host.addEventListener;
  try {
    return { root: createRoot(host), delivered };
  } finally {
    Reflect.deleteProperty(host, "addEventListener");
  }
}

async function checkpointActivate(
  element: HTMLElement,
  delivered: Promise<void>[],
  activation: "pointer" | "Enter" | "Space",
) {
  const user = userEvent.setup({ document: element.ownerDocument });
  await act(async () => {
    if (activation === "pointer") {
      await user.pointer({ keys: "[MouseLeft]", target: element });
    } else {
      element.focus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    while (delivered.length > 0) await Promise.all(delivered.splice(0));
  });
}

function reviewSession(docId: string) {
  const user = makeCollabUser("alice", "Alice");
  const session = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
  session.keepAlive();
  return { session, user };
}

function suggestionPanel(session: CollabSession) {
  return (
    <TooltipProvider>
      <CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />
    </TooltipProvider>
  );
}

function addCommentSuggestion(
  session: CollabSession,
  user: ReturnType<typeof makeCollabUser>,
  target: "root" | "reply" | "document" = "root",
) {
  const text = "The quick brown fox jumps.";
  if (session.ytext.length === 0) session.ytext.insert(0, text);
  const body = "Try this.\n\n```suggestion\nslow red\n```";
  const threadId = session.comments.add({
    from: target === "document" ? 0 : 4,
    to: target === "document" ? 0 : 15,
    body: target === "reply" ? "Could this be clearer?" : body,
    author: user,
  });
  const replyId = target === "reply" ? session.comments.reply(threadId, body, user)! : null;
  return { threadId, replyId };
}

interface CapturedFrame {
  id: number;
  callback: FrameRequestCallback;
  cancelled: boolean;
}

function controlledComposerFrames(reuseIds = false) {
  let nextId = 1;
  const captured: CapturedFrame[] = [];
  const pending = new Set<CapturedFrame>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const owner = { id: reuseIds ? 7 : nextId++, callback, cancelled: false };
    captured.push(owner);
    pending.add(owner);
    return owner.id;
  });
  const cancel = vi.fn((id: number) => {
    const owner = [...pending].find((candidate) => candidate.id === id);
    if (!owner) return;
    owner.cancelled = true;
    pending.delete(owner);
  });
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    captured,
    pending,
    request,
    cancel,
    invoke(owner: CapturedFrame) {
      pending.delete(owner);
      owner.callback(0);
    },
  };
}

interface CapturedBlurTimer {
  id: NodeJS.Timeout;
  callback: () => void;
  cancelled: boolean;
  dueAt: number;
}

function controlledComposerBlurTimers() {
  let now = 0;
  const captured: CapturedBlurTimer[] = [];
  const pending = new Set<CapturedBlurTimer>();
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const reusedId = {} as NodeJS.Timeout;
  const set = vi.spyOn(window, "setTimeout").mockImplementation((handler: (_: void) => void, delay?: number) => {
    if (delay !== 120) return nativeSetTimeout(handler, delay);
    const owner: CapturedBlurTimer = { id: reusedId, callback: () => handler(), cancelled: false, dueAt: now + delay };
    captured.push(owner);
    pending.add(owner);
    return owner.id;
  });
  const clear = vi.spyOn(window, "clearTimeout").mockImplementation((id: Parameters<typeof window.clearTimeout>[0]) => {
    const owner = [...pending].find((candidate) => candidate.id === id);
    if (!owner) {
      nativeClearTimeout(id);
      return;
    }
    owner.cancelled = true;
    pending.delete(owner);
  });
  const invoke = (owner: CapturedBlurTimer) => {
    pending.delete(owner);
    owner.callback();
  };
  return {
    captured,
    pending,
    set,
    clear,
    invoke,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const owner of [...pending].filter((candidate) => candidate.dueAt <= now)) invoke(owner);
    },
  };
}

function ComposerBoundary({
  session,
  visit,
  present = true,
  boundary = 0,
  onBoundary,
  onPassiveCleanup,
}: {
  session: CollabSession;
  visit: string;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onPassiveCleanup?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  useEffect(() => onPassiveCleanup, [onPassiveCleanup, visit]);
  return present ? (
    <TooltipProvider>
      <CommentsPanel key={visit} session={session} onClose={() => {}} onReveal={() => {}} />
    </TooltipProvider>
  ) : null;
}

describe("CommentsPanel", () => {
  let session: CollabSession | null = null;
  let auxiliarySessions: CollabSession[] = [];

  afterEach(() => {
    cleanup();
    session?.destroy();
    for (const extra of auxiliarySessions) extra.destroy();
    session = null;
    auxiliarySessions = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("native author titles", () => {
    const names = [
      `Human ${"long display name ".repeat(14)}<b title="quoted">"A" & 'one'</b>`,
      `Agent ${"another display name ".repeat(12)}<img src="literal">"B" & 'two'`,
    ];
    const authorClass = "truncate text-[13px] font-semibold text-ink";
    const authorSpans = (container: HTMLElement) =>
      Array.from(container.querySelectorAll<HTMLSpanElement>("span.truncate.text-ink"));

    function expectAuthor(span: HTMLSpanElement, name: string) {
      expect(span.tagName).toBe("SPAN");
      expect(span.textContent).toBe(name);
      expect(span.getAttribute("title")).toBe(name);
      expect(span.className).toBe(authorClass);
      expect(span.getAttributeNames().sort()).toEqual(["class", "title"]);
      expect(span.children).toHaveLength(0);
      expect(span.childNodes).toHaveLength(name ? 1 : 0);
      expect(span.tabIndex).toBe(-1);
    }

    function namedSession(docId: string, reverse = false) {
      const fixture = reviewSession(docId);
      const human = makeCollabUser("alice", names[0]);
      const agent = makeCollabUser("agent:alice:Reviewer", names[1]);
      const author = reverse ? agent : human;
      const replier = reverse ? human : agent;
      fixture.session.ytext.insert(0, "Alpha beta gamma.");
      const threadId = fixture.session.comments.add({ from: 0, to: 5, body: "Comment body.", author });
      const replyId = fixture.session.comments.reply(threadId, "Reply body.", replier)!;
      const suggestionId = fixture.session.suggestions.propose({ from: 11, to: 16, insert: "GAMMA" }, author);
      return { ...fixture, author, replier, threadId, replyId, suggestionId };
    }

    it.each([false, true])("preserves human/agent presentation and passive hover across all three sites (reversed: %s)", async (reverse) => {
      const fixture = namedSession(`author-hover-${reverse}`, reverse);
      session = fixture.session;
      const onReveal = vi.fn();
      const onClose = vi.fn();
      const onToast = vi.fn();
      const view = render(<CommentsPanel session={session} onClose={onClose} onReveal={onReveal} onToast={onToast} />);
      await act(async () => {});
      for (const name of names) expect(name.length).toBeGreaterThanOrEqual(200);

      function expectAvatar(span: HTMLSpanElement, name: string, agent: boolean, size: number) {
        const avatar = span.parentElement!.parentElement!.previousElementSibling!;
        expect(avatar).toHaveAttribute("title", agent ? `${name} (agent)` : name);
        expect(avatar).toHaveStyle({ width: `${size}px`, height: `${size}px` });
        expect(avatar.querySelector("svg") !== null).toBe(agent);
        expect(avatar.classList.contains("avatar")).toBe(!agent);
        expect(span.nextElementSibling).toHaveAttribute("data-testid", "comment-timestamp");
        expect(span.nextElementSibling).toHaveClass("shrink-0 text-xs text-ink-4", { exact: true });
        expect(span.nextElementSibling).toHaveTextContent("just now");
      }

      function expectPassiveHover(spans: HTMLSpanElement[]) {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(spans[0]);
        selection.removeAllRanges();
        selection.addRange(range);
        const selected = [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
        const activeElement = document.activeElement;
        const markup = view.container.innerHTML;
        const controls = Array.from(view.container.querySelectorAll("button, input, textarea, a, [role], [tabindex]"));
        const network = [api.documents.collaborators, api.documents.reviews, api.documents.comment, api.documents.createRequest, api.tokens.list];
        const networkCounts = network.map((request) => vi.mocked(request).mock.calls.length);
        const update = vi.fn();
        const selectionChange = vi.fn();
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const fetch = vi.spyOn(globalThis, "fetch");
        const activeComment = vi.spyOn(fixture.session, "setActiveComment");
        const activeSuggestion = vi.spyOn(fixture.session, "setActiveSuggestion");
        const observer = new MutationObserver(() => {});
        observer.observe(view.container, { subtree: true, childList: true, attributes: true, characterData: true });
        fixture.session.ydoc.on("update", update);
        document.addEventListener("selectionchange", selectionChange);
        try {
          // Keep the hover-only measurement synchronous, after React's async setup.
          for (const span of spans) {
            fireEvent.pointerOver(span);
            fireEvent.mouseOver(span);
            fireEvent.mouseMove(span);
            fireEvent.mouseOut(span);
            fireEvent.pointerOut(span);
          }
          expect(observer.takeRecords()).toHaveLength(0);
          expect(view.container.innerHTML).toBe(markup);
          expect(Array.from(view.container.querySelectorAll("button, input, textarea, a, [role], [tabindex]"))).toEqual(controls);
          expect(screen.queryByRole("tooltip")).toBeNull();
          expect(update).not.toHaveBeenCalled();
          expect(focus).not.toHaveBeenCalled();
          expect(fetch).not.toHaveBeenCalled();
          expect(activeComment).not.toHaveBeenCalled();
          expect(activeSuggestion).not.toHaveBeenCalled();
          expect(onReveal).not.toHaveBeenCalled();
          expect(onClose).not.toHaveBeenCalled();
          expect(onToast).not.toHaveBeenCalled();
          expect(network.map((request) => vi.mocked(request).mock.calls.length)).toEqual(networkCounts);
          expect(document.activeElement).toBe(activeElement);
          expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual(selected);
          expect(selectionChange).not.toHaveBeenCalled();
        } finally {
          observer.disconnect();
          fixture.session.ydoc.off("update", update);
          document.removeEventListener("selectionchange", selectionChange);
          focus.mockRestore();
          fetch.mockRestore();
          activeComment.mockRestore();
          activeSuggestion.mockRestore();
          selection.removeAllRanges();
        }
      }

      const commentAuthors = authorSpans(view.container);
      expect(commentAuthors).toHaveLength(2);
      expectAuthor(commentAuthors[0], fixture.author.name);
      expectAuthor(commentAuthors[1], fixture.replier.name);
      expectAvatar(commentAuthors[0], fixture.author.name, reverse, 28);
      expectAvatar(commentAuthors[1], fixture.replier.name, !reverse, 24);
      expect(screen.getByTestId("comment-thread")).toHaveAttribute("role", "article");
      expect(screen.getByTestId("comment-thread")).toHaveAttribute("tabindex", "0");
      expect(screen.getByTestId("comment-thread")).toHaveAttribute("aria-label", `Comment by ${fixture.author.name}`);
      expect(screen.getByTestId("comment-quote")).toHaveAttribute("title", "Alpha");
      expect(screen.getByText("Comment body.")).toBeVisible();
      expect(screen.getByText("Reply body.")).toBeVisible();
      expect(screen.queryByTestId("comment-edited")).toBeNull();
      expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled();
      expectPassiveHover(commentAuthors);

      fireEvent.click(screen.getByTestId("comments-tab-suggestions"));
      await act(async () => {});
      const reviewAuthors = authorSpans(view.container);
      expect(reviewAuthors).toHaveLength(1);
      expectAuthor(reviewAuthors[0], fixture.author.name);
      expectAvatar(reviewAuthors[0], fixture.author.name, reverse, 28);
      expect(screen.getByTestId("suggestion-before").textContent).toBe("gamma");
      expect(screen.getByTestId("suggestion-after").textContent).toBe("GAMMA");
      expect(screen.getByTestId("suggestion-accept")).toBeEnabled();
      expect(screen.getByTestId("suggestion-reject")).toBeEnabled();
      expectPassiveHover(reviewAuthors);

      const decide = vi.spyOn(session, "reviewSuggestion");
      await act(async () => fireEvent.click(screen.getByTestId("suggestion-reject")));
      expect(decide).toHaveBeenCalledExactlyOnceWith("reject", fixture.suggestionId);
      expect(screen.queryByTestId("suggestion-card")).toBeNull();
      expect(authorSpans(view.container)).toHaveLength(0);
      expect(session.ytext.toString()).toBe("Alpha beta gamma.");
    });

    it("keeps exact titles beside edited, request and resolved presentation", async () => {
      const fixture = namedSession("author-states");
      session = fixture.session;
      const request: AgentRequestMirror = {
        id: "author-request", status: "open", mode: "suggest", instruction: "Review this",
        claimedBy: null, result: null, userId: "alice", threadId: fixture.threadId, updatedAt: Date.now(),
      };
      session.meta.set("agentRequests", { [request.id]: request });
      const view = render(suggestionPanel(session));
      await act(async () => {});
      const timestampMarkup = screen.getAllByTestId("comment-timestamp").map((element) => element.outerHTML);
      const requestMarkup = screen.getByTestId("comment-request-chip").outerHTML;
      await act(async () => {
        fixture.session.comments.editBody(fixture.threadId, "Edited comment body.");
        fixture.session.comments.editBody(fixture.threadId, "Edited reply body.", fixture.replyId);
      });
      expect(screen.getByText("Edited comment body.")).toBeVisible();
      expect(screen.getByText("Edited reply body.")).toBeVisible();
      const thread = session.comments.get(fixture.threadId)!;
      const edited = screen.getAllByTestId("comment-edited");
      expect(edited).toHaveLength(2);
      for (const [index, at] of [thread.editedAt!, thread.replies[0].editedAt!].entries()) {
        expect(edited[index]).toHaveTextContent("(edited)");
        expect(edited[index]).toHaveAttribute("title", `Edited ${new Date(at).toLocaleString()}`);
      }
      await act(async () => fixture.session.comments.setResolved(fixture.threadId, true, fixture.user));
      fireEvent.click(screen.getByTestId("comments-tab-resolved"));
      const spans = authorSpans(view.container);
      expect(spans).toHaveLength(2);
      expectAuthor(spans[0], fixture.author.name);
      expectAuthor(spans[1], fixture.replier.name);
      expect(screen.getAllByTestId("comment-edited")).toHaveLength(2);
      expect(screen.getByTestId("comment-resolved-state")).toHaveTextContent("Resolved");
      expect(screen.getByTestId("comment-thread")).toHaveClass("bg-surface/80");
      expect(screen.getByRole("button", { name: "Re-open" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
      expect(screen.getAllByTestId("comment-timestamp").map((element) => element.outerHTML)).toEqual(timestampMarkup);
      expect(screen.getByTestId("comment-request-chip").outerHTML).toBe(requestMarkup);
    });

    it.each(["open", "suggestions"] as const)("shows only current titles after model changes, same-ID replacements, empty names, document changes and removal in %s", async (tab) => {
      const fixture = namedSession(`author-updates-${tab}`);
      session = fixture.session;
      const panel = (current: CollabSession) => (
        <CommentsPanel session={current} onClose={() => {}} onReveal={() => {}} focusTab={{ tab, nonce: 1 }} />
      );
      const view = render(panel(session));
      await act(async () => {});
      const expectedNames = tab === "open" ? [names[0], names[1]] : [names[0]];
      const expectNames = (values: string[]) => {
        const spans = authorSpans(view.container);
        expect(spans).toHaveLength(values.length);
        for (const [index, value] of values.entries()) expectAuthor(spans[index], value);
      };
      expectNames(expectedNames);
      const stored = session.comments.ymap.get(fixture.threadId)!;
      const replies = stored.get("replies") as Y.Array<Record<string, unknown>>;
      await act(async () => {
        fixture.session.ydoc.transact(() => {
          stored.set("authorName", names[1]);
          const reply = replies.get(0);
          replies.delete(0, 1);
          replies.insert(0, [{ ...reply, authorName: names[0] }]);
          for (const [id, suggestion] of fixture.session.suggestions.ymap) {
            fixture.session.suggestions.ymap.set(id, { ...suggestion, authorName: names[1] });
          }
        });
      });
      expectNames(tab === "open" ? [names[1], names[0]] : [names[1]]);
      expect(session.comments.get(fixture.threadId)!.replies[0].id).toBe(fixture.replyId);
      expect(session.suggestions.groups()[0].id).toBe(fixture.suggestionId);

      await act(async () => {
        fixture.session.ydoc.transact(() => {
          const replacement = stored.clone();
          replacement.set("authorName", "");
          fixture.session.comments.ymap.set(fixture.threadId, replacement);
          const currentReplies = replacement.get("replies") as Y.Array<Record<string, unknown>>;
          const reply = currentReplies.get(0);
          currentReplies.delete(0, 1);
          currentReplies.insert(0, [{ ...reply, authorName: "" }]);
          for (const [id, suggestion] of fixture.session.suggestions.ymap) {
            fixture.session.suggestions.ymap.set(id, { ...suggestion, authorName: "" });
          }
        });
      });
      expectNames(tab === "open" ? ["", ""] : [""]);

      const replacement = reviewSession(`author-next-document-${tab}`).session;
      auxiliarySessions.push(replacement);
      Y.applyUpdate(replacement.ydoc, Y.encodeStateAsUpdate(session.ydoc));
      const currentThread = replacement.comments.ymap.get(fixture.threadId)!;
      replacement.ydoc.transact(() => {
        currentThread.set("authorName", names[0]);
        const currentReplies = currentThread.get("replies") as Y.Array<Record<string, unknown>>;
        const reply = currentReplies.get(0);
        currentReplies.delete(0, 1);
        currentReplies.insert(0, [{ ...reply, authorName: names[1] }]);
        for (const [id, suggestion] of replacement.suggestions.ymap) {
          replacement.suggestions.ymap.set(id, { ...suggestion, authorName: names[0] });
        }
      });
      view.rerender(panel(replacement));
      await act(async () => {});
      expectNames(expectedNames);
      await act(async () => {
        fixture.session.comments.ymap.get(fixture.threadId)!.set("authorName", "Retired author");
        for (const [id, suggestion] of fixture.session.suggestions.ymap) {
          fixture.session.suggestions.ymap.set(id, { ...suggestion, authorName: "Retired reviewer" });
        }
      });
      expectNames(expectedNames);
      expect(view.container.querySelector('[title^="Retired"]')).toBeNull();
      await act(async () => replacement.comments.deleteReply(fixture.threadId, fixture.replyId));
      expectNames([names[0]]);
      await act(async () => {
        replacement.comments.remove(fixture.threadId);
        replacement.suggestions.ymap.clear();
      });
      expectNames([]);
      expect(view.container.querySelector('[title=""]')).toBeNull();
    });
  });

  it("uses the canonical session undo action and restores pending reply controls", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const threadId = session.comments.add({ from: 4, to: 15, body: "Could this be clearer?", author: user });
    session.comments.reply(threadId, "Try this.\n\n```suggestion\nslow red\n```", user);

    let action: Parameters<NonNullable<CommentsPanelProps["onToast"]>>[2];
    const onToast: NonNullable<CommentsPanelProps["onToast"]> = (_message, _kind, nextAction) => {
      action = nextAction;
    };
    const undo = vi.spyOn(session, "undo");
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} />);
    const reply = () => document.querySelector<HTMLElement>('[data-testid="comment-reply"][data-reply-id]')!;

    fireEvent.click(screen.getByTestId("suggestion-accept-comment"));
    await waitFor(() => expect(session!.ytext.toString()).toBe("The slow red fox jumps."));
    expect(reply()).toHaveAttribute("data-state", "accepted");
    expect(action?.label).toBe("Undo");

    act(() => action?.onClick?.());
    expect(undo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(session!.ytext.toString()).toBe("The quick brown fox jumps."));
    expect(reply()).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("suggestion-accept-comment")).toBeVisible();
    expect(screen.getByTestId("suggestion-reject-comment")).toBeVisible();
  });

  it.each(["root", "reply"] as const)("does not offer Undo for an identical %s suggestion", async (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox jumps.";
    session.ytext.insert(0, text);
    session.replaceSource([{ from: text.length, to: text.length, text: "!" }]);
    const undoStackItem = session.undoManager.undoStack.at(-1)!;
    const body = "Keep this wording.\n\n```suggestion\nquick brown\n```";
    const threadId = session.comments.add({
      from: 4,
      to: 15,
      body: target === "root" ? body : "Could this be clearer?",
      author: user,
    });
    const replyId = target === "reply" ? session.comments.reply(threadId, body, user)! : undefined;
    const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} />);

    fireEvent.click(screen.getByTestId("suggestion-accept-comment"));
    await waitFor(() => expect(onToast).toHaveBeenCalled());

    expect(onToast.mock.lastCall?.[1]).toBe("error");
    expect(onToast.mock.lastCall?.[2]).toBeUndefined();
    expect(session.undoManager.undoStack).toEqual([undoStackItem]);
    const pending = session.comments.get(threadId)!;
    if (replyId) {
      expect(pending.replies.find((reply) => reply.id === replyId)?.suggestionState).toBeUndefined();
    } else {
      expect(pending.suggestionState).toBeNull();
    }
  });

  it.each(["root", "reply"] as const)("renders a pending %s suggestion as the proposed text with no diff markup", (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const body = "Try this.\n\n```suggestion\nslow red\n```";
    const threadId = session.comments.add({ from: 4, to: 15, body: target === "root" ? body : "Could this be clearer?", author: user });
    if (target === "reply") session.comments.reply(threadId, body, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

    const box = screen.getByTestId("suggestion-box");
    expect(box).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("suggestion-text").textContent).toBe("slow red");
    expect(box.querySelectorAll("ins, del")).toHaveLength(0);
    expect(screen.queryByTestId("suggestion-deletes")).toBeNull();
    expect(screen.getByTestId("suggestion-accept-comment")).toBeEnabled();
    expect(screen.getByTestId("suggestion-reject-comment")).toBeEnabled();
  });

  it.each(["root", "reply"] as const)("renders an empty %s suggestion as 'Deletes the highlighted text'", (target) => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const body = "Drop it.\n\n```suggestion\n```";
    const threadId = session.comments.add({ from: 4, to: 15, body: target === "root" ? body : "Is this needed?", author: user });
    if (target === "reply") session.comments.reply(threadId, body, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

    const box = screen.getByTestId("suggestion-box");
    expect(box).toHaveAttribute("data-state", "pending");
    const deletes = screen.getByTestId("suggestion-deletes");
    expect(deletes).toHaveTextContent("Deletes the highlighted text");
    expect(screen.getByTestId("suggestion-text")).toContainElement(deletes);
    expect(screen.getByTestId("suggestion-text").textContent).toBe("Deletes the highlighted text");
    expect(box.querySelectorAll("ins, del")).toHaveLength(0);
  });

  describe("suggestion action publication", () => {
    it.each([
      { action: "accept" as const, target: "root" as const, buttons: 2 },
      { action: "reject" as const, target: "reply" as const, buttons: 2 },
      { action: "reject" as const, target: "document" as const, buttons: 1 },
    ])("runs one current $action from a $buttons-button set after direct-root Strict Mode replay", async ({ action, target, buttons }) => {
      const fixture = reviewSession(`suggestion-strict-${action}-${target}`);
      session = fixture.session;
      addCommentSuggestion(session, fixture.user, target);
      const accept = vi.spyOn(session, "acceptCommentSuggestion");
      const reject = vi.spyOn(session.comments, target === "reply" ? "rejectReplySuggestion" : "rejectSuggestion");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(<StrictMode>{suggestionPanel(session!)}</StrictMode>);
        });
        const actions = captureSuggestionActions(host);
        expect(actions.root.children).toHaveLength(buttons);
        expect(actions.accept === null).toBe(buttons === 1);
        expect(actions.reject).not.toBeNull();
        const control = action === "accept" ? actions.accept : actions.reject;
        if (!control) throw new Error(`Expected the current ${action} control`);

        await act(async () => dispatchReviewClick(control.element));

        expect(action === "accept" ? accept : reject).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it.each([
      ["accept", "reject", "ArrowRight"],
      ["accept", "reject", "ArrowDown"],
      ["accept", "reject", "End"],
      ["reject", "accept", "ArrowLeft"],
      ["reject", "accept", "ArrowUp"],
      ["reject", "accept", "Home"],
    ] as const)(
      "moves from %s to %s with %s exactly once without deciding the suggestion",
      async (sourceKind, destinationKind, key) => {
        const fixture = reviewSession(
          `suggestion-keyboard-${sourceKind}-${key.toLowerCase()}`,
        );
        session = fixture.session;
        addCommentSuggestion(session, fixture.user);
        const accept = vi.spyOn(session, "acceptCommentSuggestion");
        const reject = vi.spyOn(session.comments, "rejectSuggestion");
        const nativePreventDefault = Event.prototype.preventDefault;
        const nativeFocus = HTMLElement.prototype.focus;
        const preventDefault = vi
          .spyOn(Event.prototype, "preventDefault")
          .mockImplementation(function (this: Event) {
            Reflect.apply(nativePreventDefault, this, []);
          });
        const focus = vi
          .spyOn(HTMLElement.prototype, "focus")
          .mockImplementation(function (
            this: HTMLElement,
            options?: FocusOptions,
          ) {
            void options;
            Reflect.apply(nativeFocus, this, []);
          });
        const rendered = render(
          <StrictMode>{suggestionPanel(session)}</StrictMode>,
        );
        try {
          await screen.findByTestId("suggestion-accept-comment");
          const actions = captureSuggestionActions();
          const source =
            sourceKind === "accept" ? actions.accept : actions.reject;
          const destination =
            destinationKind === "accept" ? actions.accept : actions.reject;
          if (!source || !destination) {
            throw new Error("Both suggestion decisions were not rendered");
          }
          source.element.focus();
          preventDefault.mockClear();
          focus.mockClear();
          const markup = actions.root.innerHTML;

          const event = dispatchSuggestionKey(
            source.element as HTMLButtonElement,
            key,
          );

          expect(event.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(focus).toHaveBeenCalledExactlyOnceWith({
            preventScroll: true,
          });
          expect(focus.mock.instances[0]).toBe(destination.element);
          expect(destination.element).toHaveFocus();
          expect(actions.root.innerHTML).toBe(markup);
          expect(accept).not.toHaveBeenCalled();
          expect(reject).not.toHaveBeenCalled();
          expect(api.documents.comment).not.toHaveBeenCalled();
        } finally {
          rendered.unmount();
          focus.mockRestore();
          preventDefault.mockRestore();
        }
      },
    );

    it.each([
      ["accept", "ArrowLeft"],
      ["accept", "ArrowUp"],
      ["accept", "Home"],
      ["reject", "ArrowRight"],
      ["reject", "ArrowDown"],
      ["reject", "End"],
    ] as const)(
      "leaves the %s %s boundary unprevented without wrapping or crossing cards",
      async (sourceKind, key) => {
        const fixture = reviewSession(
          `suggestion-keyboard-boundary-${sourceKind}-${key.toLowerCase()}`,
        );
        session = fixture.session;
        addCommentSuggestion(session, fixture.user);
        addCommentSuggestion(session, fixture.user);
        render(<StrictMode>{suggestionPanel(session)}</StrictMode>);
        await waitFor(() =>
          expect(screen.getAllByTestId("suggestion-actions")).toHaveLength(2),
        );
        const first = captureSuggestionActions(document, 0);
        const second = captureSuggestionActions(document, 1);
        const source =
          sourceKind === "accept" ? first.accept : first.reject;
        if (!source) throw new Error("The boundary source was not rendered");
        source.element.focus();

        const event = dispatchSuggestionKey(
          source.element as HTMLButtonElement,
          key,
        );

        expect(event.defaultPrevented).toBe(false);
        expect(source.element).toHaveFocus();
        expect(second.accept?.element).not.toHaveFocus();
        expect(second.reject?.element).not.toHaveFocus();
      },
    );

    it("skips absent decisions and accepts a clean successor event", async () => {
      const fixture = reviewSession("suggestion-keyboard-enabled-actions");
      session = fixture.session;
      addCommentSuggestion(session, fixture.user, "document");
      const reject = vi.spyOn(session.comments, "rejectSuggestion");
      const rendered = render(
        <StrictMode>{suggestionPanel(session)}</StrictMode>,
      );
      await screen.findByTestId("suggestion-reject-comment");
      const single = captureSuggestionActions();
      expect(single.accept).toBeNull();
      single.reject!.element.focus();
      for (const key of [
        "ArrowLeft",
        "ArrowUp",
        "ArrowRight",
        "ArrowDown",
        "Home",
        "End",
      ] as const) {
        const event = dispatchSuggestionKey(
          single.reject!.element as HTMLButtonElement,
          key,
        );
        expect(event.defaultPrevented).toBe(false);
        expect(single.reject!.element).toHaveFocus();
      }
      expect(reject).not.toHaveBeenCalled();

      rendered.unmount();
      addCommentSuggestion(session, fixture.user);
      render(<StrictMode>{suggestionPanel(session)}</StrictMode>);
      await screen.findByTestId("suggestion-accept-comment");
      const current = captureSuggestionActions(document, 1);
      current.accept!.element.focus();
      const modified = dispatchSuggestionKey(
        current.accept!.element as HTMLButtonElement,
        "ArrowRight",
        { ctrlKey: true },
      );
      expect(modified.defaultPrevented).toBe(false);
      expect(current.accept!.element).toHaveFocus();

      const accepted = dispatchSuggestionKey(
        current.accept!.element as HTMLButtonElement,
        "ArrowRight",
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(current.reject!.element).toHaveFocus();
      expect(reject).not.toHaveBeenCalled();
    });

    it("skips the disabled Accept decision for an outdated suggestion", async () => {
      const fixture = reviewSession("suggestion-keyboard-outdated");
      session = fixture.session;
      addCommentSuggestion(session, fixture.user);
      session.ytext.insert(7, "changed ");
      const accept = vi.spyOn(session, "acceptCommentSuggestion");
      const reject = vi.spyOn(session.comments, "rejectSuggestion");
      render(<StrictMode>{suggestionPanel(session)}</StrictMode>);
      const acceptButton = await screen.findByTestId(
        "suggestion-accept-comment",
      );
      const actions = captureSuggestionActions();
      expect(acceptButton).toBeDisabled();
      expect(actions.reject!.element).toBeEnabled();
      actions.reject!.element.focus();

      const previous = dispatchSuggestionKey(
        actions.reject!.element as HTMLButtonElement,
        "ArrowLeft",
      );
      const first = dispatchSuggestionKey(
        actions.reject!.element as HTMLButtonElement,
        "Home",
      );

      expect(previous.defaultPrevented).toBe(false);
      expect(first.defaultPrevented).toBe(false);
      expect(actions.reject!.element).toHaveFocus();
      expect(accept).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
    });

    it("keeps batch-review decisions outside each card's keyboard navigation", async () => {
      const fixture = reviewSession("suggestion-keyboard-batch-isolation");
      session = fixture.session;
      addCommentSuggestion(session, fixture.user);
      addCommentSuggestion(session, fixture.user);
      render(<StrictMode>{suggestionPanel(session)}</StrictMode>);
      fireEvent.click(screen.getByTestId("comments-tab-suggestions"));
      await screen.findByTestId("suggestion-batch-actions");
      const batch = captureSuggestionBatchActions();
      const cards = screen.getAllByTestId("suggestion-actions");
      const card = captureSuggestionActions(document, 1);
      batch.accept!.element.focus();

      const batchEvent = dispatchSuggestionKey(
        batch.accept!.element as HTMLButtonElement,
        "ArrowRight",
      );

      expect(batchEvent.defaultPrevented).toBe(false);
      expect(batch.accept!.element).toHaveFocus();
      expect(batch.reject!.element).not.toHaveFocus();
      expect(cards).toHaveLength(2);

      card.accept!.element.focus();
      const cardEvent = dispatchSuggestionKey(
        card.accept!.element as HTMLButtonElement,
        "ArrowRight",
      );
      expect(cardEvent.defaultPrevented).toBe(true);
      expect(card.reject!.element).toHaveFocus();
      expect(batch.accept!.element).not.toHaveFocus();
      expect(batch.reject!.element).not.toHaveFocus();
      expect(api.documents.comment).not.toHaveBeenCalled();
    });

    it.each(["pointer Accept", "keyboard Reject"] as const)(
      "runs one genuine %s action when hydrating at the document root used by Next",
      async (activation) => {
        const fixture = reviewSession(`suggestion-document-hydration-${activation.replace(" ", "-")}`);
        session = fixture.session;
        addCommentSuggestion(session, fixture.user);
        const accept = vi.spyOn(session, "acceptCommentSuggestion");
        const reject = vi.spyOn(session.comments, "rejectSuggestion");
        const frame = document.createElement("iframe");
        document.body.append(frame);
        const ownerDocument = frame.contentDocument;
        if (!ownerDocument?.defaultView) throw new Error("The hydration frame did not have a document window");
        const page = (
          <html>
            {createElement("head")}
            <body>
              <StrictMode>{suggestionPanel(session)}</StrictMode>
            </body>
          </html>
        );
        ownerDocument.open();
        ownerDocument.write(`<!doctype html>${renderToString(page)}`);
        ownerDocument.close();
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const root = await act(async () => hydrateRoot(ownerDocument, page));

        try {
          const actions = captureSuggestionActions(ownerDocument);
          const control = activation === "pointer Accept" ? actions.accept : actions.reject;
          if (!control) throw new Error(`The hydrated ${activation} control was not rendered`);
          const user = userEvent.setup({ document: ownerDocument });
          if (activation === "pointer Accept") {
            await user.pointer({ keys: "[MouseLeft]", target: control.element });
          } else {
            control.element.focus();
            await user.keyboard("{Enter}");
          }
          expect(activation === "pointer Accept" ? accept : reject).toHaveBeenCalledOnce();
          expect(errors).not.toHaveBeenCalled();
        } finally {
          await act(async () => root.unmount());
          errors.mockRestore();
          frame.remove();
        }
      },
    );

    it("keeps the exact presentation while moving from one-button to two-button authority", async () => {
      const fixture = reviewSession("suggestion-conditional-actions");
      session = fixture.session;
      addCommentSuggestion(session, fixture.user);
      (session as unknown as { role: string }).role = "commenter";
      session.setMode("viewing");
      const accept = vi.spyOn(session, "acceptCommentSuggestion");
      const rendered = render(suggestionPanel(session));
      const stale = captureSuggestionActions();

      expect(stale.accept).toBeNull();
      expect(stale.reject).not.toBeNull();
      expect(stale.root.children).toHaveLength(1);
      expect(stale.root.className).toBe("mt-2 flex flex-wrap items-center gap-2");
      expect(stale.reject!.element).toHaveAttribute("type", "button");
      expect(stale.reject!.element).toHaveClass("btn", "btn-sm", "btn-outline", "shrink-0", "gap-1.5", "whitespace-nowrap");
      expect(stale.reject!.element.firstElementChild?.tagName.toLowerCase()).toBe("svg");

      act(() => {
        (session as unknown as { role: string }).role = "owner";
        session!.setMode("editing");
      });
      await waitFor(() => expect(screen.getByTestId("suggestion-accept-comment")).toBeInTheDocument());
      const current = captureSuggestionActions();
      expect(current.root).toBe(stale.root);
      expect(current.root.children).toHaveLength(2);
      expect(current.root.children.item(0)).toBe(current.accept!.element);
      expect(current.root.children.item(1)).toBe(current.reject!.element);
      expect(current.accept!.element).toHaveTextContent("Accept suggestion");
      expect(current.accept!.element).toHaveClass("btn", "btn-sm", "btn-primary", "shrink-0", "gap-1.5", "whitespace-nowrap");

      act(() => dispatchReviewClick(current.accept!.element));
      expect(accept).toHaveBeenCalledOnce();
      rendered.unmount();
    });

  });

  it("switches tabs, follows the empty-state link and closes with plain handlers under Strict Mode", async () => {
    const fixture = reviewSession("comment-navigation-strict");
    session = fixture.session;
    const { threadId } = addCommentSuggestion(session, fixture.user);
    session.comments.setResolved(threadId, true, fixture.user);
    const onClose = vi.fn();

    render(
      <StrictMode>
        <CommentsPanel
          session={session}
          onClose={onClose}
          onReveal={() => {}}
          focusTab={{ tab: "open", nonce: 1 }}
        />
      </StrictMode>,
    );

    await screen.findByTestId("comments-empty-suggestions-button");
    await act(async () => {});
    const open = screen.getByTestId("comments-tab-open");
    const resolved = screen.getByTestId("comments-tab-resolved");
    const suggestions = screen.getByTestId("comments-tab-suggestions");
    const tabpanel = screen.getByRole("tabpanel");
    expect(resolved).toHaveTextContent("Resolved1");
    expect(suggestions).toHaveTextContent("Suggestions1");

    fireEvent.click(resolved);
    await waitFor(() => expect(resolved).toHaveAttribute("aria-selected", "true"));
    fireEvent.click(open);
    await waitFor(() => expect(open).toHaveAttribute("aria-selected", "true"));

    fireEvent.click(await screen.findByTestId("comments-empty-suggestions-button"));
    await waitFor(() => expect(suggestions).toHaveAttribute("aria-selected", "true"));
    expect(tabpanel).toHaveAttribute("aria-labelledby", "comments-tab-suggestions");

    suggestions.focus();
    fireEvent.keyDown(suggestions, { key: "Home" });
    expect(open).toHaveFocus();
    await waitFor(() => expect(open).toHaveAttribute("aria-selected", "true"));
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses one roving tab stop and activates tabs with arrow, Home, and End keys", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

    const tabs = screen.getAllByRole("tab");
    const open = screen.getByRole("tab", { name: "Open" });
    const resolved = screen.getByRole("tab", { name: "Resolved" });
    const suggestions = screen.getByRole("tab", { name: "Suggestions" });
    const tabpanel = screen.getByRole("tabpanel");

    expect(tabs.filter((item) => item.tabIndex === 0)).toEqual([open]);
    expect(resolved).toHaveAttribute("tabindex", "-1");
    expect(suggestions).toHaveAttribute("tabindex", "-1");

    open.focus();
    fireEvent.keyDown(open, { key: "ArrowLeft" });
    expect(suggestions).toHaveFocus();
    expect(suggestions).toHaveAttribute("aria-selected", "true");
    expect(suggestions).toHaveAttribute("tabindex", "0");
    expect(open).toHaveAttribute("tabindex", "-1");
    expect(tabpanel).toHaveAttribute("aria-labelledby", "comments-tab-suggestions");

    fireEvent.keyDown(suggestions, { key: "ArrowRight" });
    expect(open).toHaveFocus();
    expect(open).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(open, { key: "End" });
    expect(suggestions).toHaveFocus();
    fireEvent.keyDown(suggestions, { key: "Home" });
    expect(open).toHaveFocus();

    // Tab leaves the tablist for the "Comment on the document" button beside it, then the empty state's agent line.
    const keyboard = userEvent.setup();
    await keyboard.tab();
    expect(screen.getByTestId("comment-document")).toHaveFocus();
    expect(screen.getByRole("tablist").contains(screen.getByTestId("comment-document"))).toBe(false);
    await keyboard.tab();
    expect(screen.getByTestId("comments-empty-agent")).toHaveFocus();
  });

  it("selects a tab on a plain click and closes with the X", () => {
    const fixture = reviewSession("tabs-plain-click");
    session = fixture.session;
    const onClose = vi.fn();
    render(<CommentsPanel session={session} onClose={onClose} onReveal={() => {}} />);

    for (const name of ["Resolved", "Suggestions", "Open"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      for (const tab of screen.getAllByRole("tab")) {
        expect(tab).toHaveAttribute("aria-selected", String(tab === screen.getByRole("tab", { name })));
      }
      expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `comments-tab-${name.toLowerCase()}`);
    }

    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves to the next tab with ArrowRight, selects and focuses it, and prevents page scroll", () => {
    const fixture = reviewSession("tabs-plain-arrow");
    session = fixture.session;
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
    const open = screen.getByRole("tab", { name: "Open" });
    const resolved = screen.getByRole("tab", { name: "Resolved" });
    open.focus();

    const notPrevented = fireEvent.keyDown(open, { key: "ArrowRight" });

    expect(notPrevented).toBe(false);
    expect(resolved).toHaveAttribute("aria-selected", "true");
    expect(resolved).toHaveAttribute("tabindex", "0");
    expect(resolved).toHaveFocus();
    expect(open).toHaveAttribute("aria-selected", "false");
  });

  it("ignores other keys and modified arrows, and focusing a tab does not select it", () => {
    const fixture = reviewSession("tabs-plain-ignored");
    session = fixture.session;
    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
    const open = screen.getByRole("tab", { name: "Open" });
    open.focus();

    expect(fireEvent.keyDown(open, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(open, { key: "ArrowRight", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(open, { key: "ArrowRight", ctrlKey: true })).toBe(true);
    screen.getByRole("tab", { name: "Resolved" }).focus();

    expect(open).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Resolved" })).toHaveAttribute("aria-selected", "false");
  });

  it("navigates from the focused tab after a programmatic tab change", async () => {
    const fixture = reviewSession("comment-navigation-programmatic");
    session = fixture.session;
    const view = render(
      <CommentsPanel
        session={session}
        onClose={() => {}}
        onReveal={() => {}}
        focusTab={{ tab: "open", nonce: 1 }}
      />,
    );
    const open = screen.getByTestId("comments-tab-open");
    const resolved = screen.getByTestId("comments-tab-resolved");
    const suggestions = screen.getByTestId("comments-tab-suggestions");
    open.focus();

    view.rerender(
      <CommentsPanel
        session={session}
        onClose={() => {}}
        onReveal={() => {}}
        focusTab={{ tab: "suggestions", nonce: 2 }}
      />,
    );
    await waitFor(() => expect(suggestions).toHaveAttribute("aria-selected", "true"));
    expect(open).toHaveFocus();

    fireEvent.keyDown(open, { key: "ArrowRight" });
    expect(resolved).toHaveFocus();
    expect(resolved).toHaveAttribute("aria-selected", "true");

    fireEvent.click(open);
    await waitFor(() => expect(open).toHaveAttribute("aria-selected", "true"));
    open.focus();
    await act(async () => {});
    const allowed = fireEvent.keyDown(open, { key: "Home" });
    expect(allowed).toBe(false);
    expect(open).toHaveFocus();
    expect(open).toHaveAttribute("aria-selected", "true");
  });

  it("tones resolved card backgrounds without dimming their metadata", () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    session.ytext.insert(0, "The quick brown fox jumps.");
    const threadId = session.comments.add({ from: 4, to: 15, body: "@bob This is resolved.", author: user });
    session.comments.reply(threadId, "Thanks.", user);
    session.comments.setResolved(threadId, true, user);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} focusTab={{ tab: "resolved", nonce: 1 }} />);

    const thread = screen.getByTestId("comment-thread");
    expect(thread).toHaveClass("bg-surface/80");
    expect(thread).not.toHaveClass("opacity-80");
    expect(screen.getAllByTestId("comment-timestamp")).toHaveLength(2);
    expect(screen.getByTestId("comment-resolved-state")).toHaveTextContent("Resolved");
    expect(screen.getByTestId("mention-chip")).toHaveTextContent("@bob");
  });

  it("moves focus to the selected tab only when opening focus is requested", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();

    const Harness = ({ open, focusOnMount = false }: { open: boolean; focusOnMount?: boolean }) => (
      <>
        <button type="button">Editor control</button>
        {open && <CommentsPanel session={session!} onClose={() => {}} onReveal={() => {}} focusOnMount={focusOnMount} />}
      </>
    );
    const view = render(<Harness open={false} />);
    const editorControl = screen.getByRole("button", { name: "Editor control" });

    editorControl.focus();
    view.rerender(<Harness open />);
    expect(editorControl).toHaveFocus();

    view.rerender(<Harness open={false} />);
    editorControl.focus();
    view.rerender(<Harness open focusOnMount />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Open" })).toHaveFocus());

    const documentComment = screen.getByTestId("comment-document");
    documentComment.focus();
    act(() => session!.ytext.insert(0, "A"));
    await act(async () => {});
    expect(documentComment).toHaveFocus();
  });

  describe("review metadata loading", () => {
    it("keeps live comments visible behind one neutral initial status until a successful empty result", async () => {
      const initial = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValueOnce(initial.promise);
      const created = reviewSession("reviews-loading");
      session = created.session;
      session.ytext.insert(0, "A live comment.");
      session.comments.add({ from: 0, to: 1, body: "Still available.", author: created.user });

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

      expect(screen.getByTestId("reviews-loading")).toHaveTextContent("Loading review details…");
      expect(screen.getByTestId("comment-thread")).toHaveTextContent("Still available.");
      expect(screen.queryByText("No open comments")).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(screen.getAllByTestId("reviews-loading")).toHaveLength(1);
      expect(screen.queryByText("Nothing resolved yet")).toBeNull();

      await act(async () => {
        initial.resolve({ reviews: [] });
        await initial.promise;
      });

      expect(await screen.findByText("Nothing resolved yet")).toBeInTheDocument();
      expect(screen.queryByTestId("reviews-loading")).toBeNull();
      expect(api.documents.reviews).toHaveBeenCalledOnce();
      expect(api.documents.reviews).toHaveBeenCalledWith("reviews-loading");
    });

    it("retries a first-load failure once and guards repeated activation until genuine empty success", async () => {
      const retry = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews)
        .mockReset()
        .mockRejectedValueOnce(new Error("offline"))
        .mockReturnValueOnce(retry.promise);
      session = reviewSession("reviews-retry").session;

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Couldn’t load review details.");
      expect(within(alert).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(screen.queryByText("No open comments")).toBeNull();

      const retryButton = within(alert).getByRole("button", { name: "Retry" });
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);

      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      expect(within(alert).getByRole("button", { name: "Retrying…" })).toBeDisabled();
      await act(async () => {
        retry.resolve({ reviews: [] });
        await retry.promise;
      });

      expect(await screen.findByText("No open comments")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(api.documents.reviews).toHaveBeenNthCalledWith(2, "reviews-retry");
    });

    it("keeps cached review cards and live comments visible when a thread-count refresh fails", async () => {
      const refresh = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset();
      const created = reviewSession("reviews-cached");
      session = created.session;
      session.ytext.insert(0, "Review this text.");
      const reviewThread = session.comments.add({ from: 0, to: 6, body: "Review finding.", author: created.user });
      const cached = reviewDto("cached", [reviewThread], session.docId);
      vi.mocked(api.documents.reviews)
        .mockResolvedValueOnce({ reviews: [cached] })
        .mockReturnValueOnce(refresh.promise);

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(await screen.findByText("Review cached.")).toBeInTheDocument();

      act(() => {
        session!.comments.add({ from: 7, to: 11, body: "A live follow-up.", author: created.user });
      });

      expect(await screen.findByTestId("reviews-loading")).toHaveTextContent("Refreshing review details…");
      expect(screen.getByText("Review cached.")).toBeInTheDocument();
      await act(async () => {
        refresh.reject(new Error("refresh unavailable"));
        try {
          await refresh.promise;
        } catch {}
      });

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Review details may be out of date.");
      expect(screen.getByText("Review cached.")).toBeInTheDocument();
      expect(screen.getByText("Review finding.")).toBeInTheDocument();
      expect(screen.getByText("A live follow-up.")).toBeInTheDocument();
      expect(screen.getAllByTestId("review-card")).toHaveLength(1);
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
    });

    it("coalesces a burst of thread-count changes during pending work into one current refresh", async () => {
      const stale = deferred<ReviewsResponse>();
      const current = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
      const created = reviewSession("reviews-coalesced");
      session = created.session;
      session.ytext.insert(0, "One two.");

      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      act(() => {
        session!.comments.add({ from: 0, to: 3, body: "First.", author: created.user });
      });
      await act(async () => {});
      act(() => {
        session!.comments.add({ from: 4, to: 7, body: "Second.", author: created.user });
      });
      await act(async () => {});
      expect(api.documents.reviews).toHaveBeenCalledOnce();

      await act(async () => {
        stale.resolve({ reviews: [reviewDto("stale", [], session!.docId)] });
        await stale.promise;
      });

      await waitFor(() => expect(api.documents.reviews).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("reviews-loading")).toHaveTextContent("Loading review details…");
      expect(screen.queryByText("Review stale.")).toBeNull();

      await act(async () => {
        current.resolve({ reviews: [] });
        await current.promise;
      });

      expect(await screen.findByText("Nothing resolved yet")).toBeInTheDocument();
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
    });

    it.each(["resolve", "reject"] as const)("isolates an old document’s stale Retry %s before loading the current document", async (outcome) => {
      const oldRequest = deferred<ReviewsResponse>();
      const newRequest = deferred<ReviewsResponse>();
      let oldCalls = 0;
      vi.mocked(api.documents.reviews).mockReset().mockImplementation((docId) => {
        if (docId !== "reviews-old") return newRequest.promise;
        oldCalls += 1;
        return oldCalls === 1 ? Promise.reject(new Error("old initial failure")) : oldRequest.promise;
      });
      const old = reviewSession("reviews-old");
      const next = reviewSession("reviews-new");
      session = next.session;

      const rendered = render(<CommentsPanel session={old.session} onClose={() => {}} onReveal={() => {}} />);
      const oldAlert = await screen.findByRole("alert");
      fireEvent.click(within(oldAlert).getByRole("button", { name: "Retry" }));
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      rendered.rerender(<CommentsPanel session={next.session} onClose={() => {}} onReveal={() => {}} />);
      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(api.documents.reviews).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("reviews-loading")).toBeInTheDocument();

      await act(async () => {
        if (outcome === "resolve") oldRequest.resolve({ reviews: [reviewDto("old", [], old.session.docId)] });
        else oldRequest.reject(new Error("old failure"));
        try {
          await oldRequest.promise;
        } catch {}
      });

      await waitFor(() => expect(api.documents.reviews).toHaveBeenCalledTimes(3));
      expect(api.documents.reviews).toHaveBeenNthCalledWith(3, "reviews-new");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Review old.")).toBeNull();

      await act(async () => {
        newRequest.resolve({ reviews: [reviewDto("new", [], next.session.docId)] });
        await newRequest.promise;
      });

      expect(await screen.findByText("Review new.")).toBeInTheDocument();
      expect(screen.queryByText("Review old.")).toBeNull();
      old.session.destroy();
    });

    it.each(["resolve", "reject"] as const)("drops a queued refresh and late %s settlement after unmount", async (outcome) => {
      const pending = deferred<ReviewsResponse>();
      vi.mocked(api.documents.reviews).mockReset().mockReturnValue(pending.promise);
      const created = reviewSession(`reviews-unmount-${outcome}`);
      session = created.session;
      const rendered = render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(api.documents.reviews).toHaveBeenCalledOnce();
      act(() => {
        session!.comments.add({ from: 0, to: 0, body: "Queue a refresh.", author: created.user });
      });
      await act(async () => {});

      rendered.unmount();
      await act(async () => {
        if (outcome === "resolve") pending.resolve({ reviews: [] });
        else pending.reject(new Error("late failure"));
        try {
          await pending.promise;
        } catch {}
      });

      expect(api.documents.reviews).toHaveBeenCalledOnce();
    });
  });

  it("keeps a review in Open until every suggestion is decided and every thread resolved; Resolve all clears it", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox jumps over the lazy dog. The end is near.";
    session.ytext.insert(0, text);
    const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
    const suggest = (quote: string, proposed: string) =>
      session!.comments.add({ from: text.indexOf(quote), to: text.indexOf(quote) + quote.length, body: `Tighter.\n\n\`\`\`suggestion\n${proposed}\n\`\`\``, author: agent });
    const pendingIds = [suggest("quick", "fast"), suggest("brown", "red"), suggest("lazy", "sleepy")];
    // A second review whose only thread is already resolved, and a third whose thread was deleted.
    const resolvedId = session.comments.add({ from: text.indexOf("The end"), to: text.indexOf("The end") + 7, body: "Good close.", author: agent });
    session.comments.setResolved(resolvedId, true, user);
    const deletedId = session.comments.add({ from: 0, to: 3, body: "Gone soon.", author: agent });
    session.comments.remove(deletedId);
    const reviews = [reviewDto("r-pending", pendingIds), reviewDto("r-resolved", [resolvedId]), reviewDto("r-deleted", [deletedId])];
    vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as Awaited<ReturnType<typeof api.documents.reviews>>);

    const threads = () => session!.comments.list();
    expect(isReviewOpen(reviews[0], threads(), text)).toBe(true);
    expect(isReviewOpen(reviews[1], threads(), text)).toBe(false);
    expect(isReviewOpen(reviews[2], threads(), text)).toBe(false);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />);
    const cards = () => screen.queryAllByTestId("review-card").map((card) => card.getAttribute("data-review-id"));
    await waitFor(() => expect(cards()).toEqual(["r-pending"]));
    expect(screen.getByRole("tab", { name: /Open/ })).toHaveAttribute("aria-selected", "true");

    // Reject all: the suggestions are decided but the threads stay open, so the card stays and offers Resolve all.
    fireEvent.click(screen.getByTestId("review-reject-all"));
    await waitFor(() => expect(screen.getByTestId("review-resolve-all")).toBeVisible());
    expect(screen.queryByTestId("review-accept-all")).toBeNull();
    expect(cards()).toEqual(["r-pending"]);
    expect(threads().filter((t) => pendingIds.includes(t.id)).every((t) => t.suggestionState === "rejected" && !t.resolved)).toBe(true);

    fireEvent.click(screen.getByTestId("review-resolve-all"));
    await waitFor(() => expect(cards()).toEqual([]));
    expect(threads().filter((t) => pendingIds.includes(t.id)).every((t) => t.resolved)).toBe(true);
    expect(isReviewOpen(reviews[0], threads(), text)).toBe(false);

    // Resolved lists the decided reviews first, then the resolved threads.
    fireEvent.click(screen.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(cards()).toEqual(["r-pending", "r-resolved", "r-deleted"]));
    expect(screen.queryByTestId("review-accept-all")).toBeNull();
    expect(screen.queryByTestId("review-reject-all")).toBeNull();
    expect(screen.queryByTestId("review-resolve-all")).toBeNull();
    expect(screen.getAllByTestId("comment-thread")).toHaveLength(4);
  });

  it("accepting every suggestion of a review resolves its threads, so the card leaves Open at once", async () => {
    const user = makeCollabUser("alice", "Alice");
    session = new CollabSession({
      docId: "doc",
      user,
      role: "owner",
      getToken: async () => "token",
      autoConnect: false,
    });
    session.keepAlive();
    const text = "The quick brown fox.";
    session.ytext.insert(0, text);
    const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
    const a = session.comments.add({ from: 4, to: 9, body: "```suggestion\nfast\n```", author: agent });
    const b = session.comments.add({ from: 10, to: 15, body: "```suggestion\nred\n```", author: agent });
    const reviews = [reviewDto("r1", [a, b])];
    vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as Awaited<ReturnType<typeof api.documents.reviews>>);

    render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("review-accept-all")).toBeVisible());
    fireEvent.click(screen.getByTestId("review-accept-all"));
    await waitFor(() => expect(session!.ytext.toString()).toBe("The fast red fox."));
    await waitFor(() => expect(screen.queryAllByTestId("review-card")).toHaveLength(0));
    expect(screen.queryByTestId("review-resolve-all")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(1));
  });

  describe("card reveal (#992)", () => {
    const mount = (opts: { removed?: boolean; reply?: boolean } = {}) => {
      // jsdom has no scrollIntoView; the active card scrolls itself into view with it.
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice");
      session = new CollabSession({ docId: "doc", user, role: "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.ytext.insert(0, "Intro text. The quick brown fox jumps.");
      const threadId = session.comments.add({ from: 16, to: 27, body: "See [the docs](https://example.com) first.", author: user });
      if (opts.reply) session.comments.reply(threadId, "Following up.", user);
      // A thread whose Y.Map lost its anchor is what the UI renders as "(original text removed)".
      if (opts.removed) session.comments.ymap.get(threadId)!.delete("anchor");
      const onReveal = vi.fn<CommentsPanelProps["onReveal"]>();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      // The panel lives inside the editor shell's TooltipProvider; the composer's Save / send button carries a tooltip.
      render(
        <TooltipProvider>
          <CommentsPanel session={session} onClose={() => {}} onReveal={onReveal} onToast={onToast} />
        </TooltipProvider>,
      );
      return { threadId, onReveal, onToast, card: screen.getByTestId("comment-thread") };
    };

    it("reveals the commented text and activates the thread when the card is clicked", () => {
      const { threadId, onReveal, onToast, card } = mount();
      expect(card).toHaveAttribute("tabindex", "0");
      expect(card).toHaveAccessibleName("Comment by Alice");
      fireEvent.click(card);
      expect(onReveal).toHaveBeenCalledWith(16);
      expect(session!.activeCommentId).toBe(threadId);
      expect(onToast).not.toHaveBeenCalled();
    });

    it("reveals from the quote line and the body, but not from controls inside the card", () => {
      const { onReveal, card } = mount();
      fireEvent.click(screen.getByTitle("quick brown"));
      expect(onReveal).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByText("See", { exact: false }));
      expect(onReveal).toHaveBeenCalledTimes(2);
      const link = card.querySelector("a")!;
      expect(link).toHaveAttribute("href", "https://example.com");
      fireEvent.click(link);
      fireEvent.click(screen.getByTestId("comment-reply"));
      expect(onReveal).toHaveBeenCalledTimes(2);
    });

    it.each(["{Enter}", " "])("reveals when %j is pressed on a focused card", async (key) => {
      const { threadId, onReveal, card } = mount();
      card.focus();
      expect(card).toHaveFocus();
      await userEvent.setup().keyboard(key);
      expect(onReveal).toHaveBeenCalledWith(16);
      expect(session!.activeCommentId).toBe(threadId);
    });

    it("keeps Enter and Space for controls inside the card", async () => {
      const { onReveal } = mount();
      const reply = screen.getByTestId("comment-reply");
      reply.focus();
      await userEvent.setup().keyboard("{Enter}");
      expect(screen.getByTestId("comment-submit")).toBeInTheDocument();
      expect(onReveal).not.toHaveBeenCalled();
    });

    it("sizes only the standalone Reply as a centered 24px target and still opens its composer", () => {
      mount({ reply: true });
      const targets = screen.getAllByTestId("comment-reply");
      const button = targets.find((target) => target.tagName === "BUTTON")!;
      const replyRow = targets.find((target) => target.hasAttribute("data-reply-id"))!;

      expect(button).toHaveClass("min-h-6", "items-center");
      expect(replyRow).not.toHaveClass("min-h-6");
      fireEvent.click(button);
      expect(screen.getByPlaceholderText("Reply…")).toBeInTheDocument();
    });

    it("activates a thread whose text was removed and says why nothing moved", () => {
      const { threadId, onReveal, onToast, card } = mount({ removed: true });
      expect(card).toHaveTextContent("(original text removed)");
      fireEvent.click(card);
      expect(onReveal).not.toHaveBeenCalled();
      expect(session!.activeCommentId).toBe(threadId);
      expect(onToast).toHaveBeenCalledTimes(1);
      const [message, kind] = onToast.mock.calls[0];
      expect(message).toMatch(/removed/i);
      expect(message.length).toBeLessThanOrEqual(60);
      expect(kind).toBe("info");
    });
  });

  describe("API-backed row action ownership", () => {
    interface ActionFixture {
      session: CollabSession;
      user: ReturnType<typeof makeCollabUser>;
      threadIds: [string, string];
      replyIds: [string, string];
    }

    const response = {} as CommentResponse;

    const makeApiSession = (docId: string, source?: CollabSession): ActionFixture => {
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const next = new CollabSession({ docId, user, role: "commenter", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      if (source) {
        Y.applyUpdate(next.ydoc, Y.encodeStateAsUpdate(source.ydoc));
      } else {
        next.ytext.insert(0, "Alpha beta gamma delta epsilon.");
        const first = next.comments.add({ from: 0, to: 5, body: "First root.", author: user });
        const second = next.comments.add({ from: 6, to: 10, body: "Second root.", author: user });
        const firstReply = next.comments.reply(first, "First reply.", user)!;
        const secondReply = next.comments.reply(second, "Second reply.", user)!;
        next.comments.toggleReaction(first, null, "👍", user);
        next.comments.toggleReaction(first, firstReply, "👍", user);
        next.comments.toggleReaction(second, null, "👍", user);
        next.comments.toggleReaction(second, secondReply, "👍", user);
      }
      const threads = next.comments.list();
      session = next;
      return {
        session: next,
        user,
        threadIds: [threads[0].id, threads[1].id],
        replyIds: [threads[0].replies[0].id, threads[1].replies[0].id],
      };
    };

    const panel = (current: CollabSession) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={() => {}} onReveal={() => {}} />
      </TooltipProvider>
    );

    const card = (threadId: string) => document.querySelector<HTMLElement>(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`)!;
    const reply = (threadId: string, replyId: string) => card(threadId).querySelector<HTMLElement>(`[data-testid="comment-reply"][data-reply-id="${replyId}"]`)!;
    const rootReactionRow = (threadId: string) => within(card(threadId)).getAllByTestId("reaction-row")[0];
    const replyReactionRow = (threadId: string, replyId: string) => within(reply(threadId, replyId)).getByTestId("reaction-row");
    const reactionChip = (row: HTMLElement, emoji = "👍") => within(row).getAllByTestId("reaction-chip").find((item) => item.getAttribute("data-emoji") === emoji)!;
    const openRootDelete = async (threadId: string) => {
      fireEvent.pointerDown(within(card(threadId)).getByRole("button", { name: "Comment actions" }), { button: 0 });
      return await screen.findByRole("menuitem", { name: "Delete thread" });
    };
    const invokeRoot = async (kind: "resolve" | "delete" | "reaction", threadId: string) => {
      if (kind === "resolve") fireEvent.click(within(card(threadId)).getByTestId("comment-resolve"));
      else if (kind === "reaction") fireEvent.click(reactionChip(rootReactionRow(threadId)));
      else fireEvent.click(await openRootDelete(threadId));
    };
    const expectRootControlsDisabled = (threadId: string) => {
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeDisabled();
      expect(within(card(threadId)).getByRole("button", { name: "Comment actions" })).toBeDisabled();
      expect(reactionChip(rootReactionRow(threadId))).toBeDisabled();
      expect(within(rootReactionRow(threadId)).getByRole("button", { name: "Add reaction" })).toBeDisabled();
    };
    const settle = async (request: ReturnType<typeof deferred<CommentResponse>>, outcome: "resolve" | "reject", reason = "request failed") => {
      await act(async () => {
        if (outcome === "resolve") request.resolve(response);
        else request.reject(new Error(reason));
        await request.promise.catch(() => {});
      });
    };
    const longActionReason = "CommentActionUnavailable".repeat(16);
    const expectActionError = (target: HTMLElement, text: string) => {
      const alert = within(target).getByTestId("comment-action-error");
      expect(within(target).getAllByRole("alert")).toEqual([alert]);
      expect(alert.tagName).toBe("DIV");
      expect(Object.fromEntries([...alert.attributes].map(({ name, value }) => [name, value]))).toEqual({
        class: "mt-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-danger dark:bg-red-950/40 wrap-anywhere",
        role: "alert",
        "aria-atomic": "true",
        "data-testid": "comment-action-error",
      });
      expect(alert.childNodes).toHaveLength(1);
      expect(alert.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(alert.firstChild?.nodeValue).toBe(text);
      expect(alert.textContent).toBe(text);
      expect(alert.querySelectorAll("*")).toHaveLength(0);
      return alert;
    };
    const expectActionPending = (target: HTMLElement, action: string, text: string) => {
      const status = within(target).getByTestId("comment-action-pending");
      expect(status.tagName).toBe("DIV");
      expect(Object.fromEntries([...status.attributes].map(({ name, value }) => [name, value]))).toEqual({
        class: "mt-1.5 flex items-center gap-1.5 text-xs text-ink-3",
        role: "status",
        "aria-live": "polite",
        "data-testid": "comment-action-pending",
        "data-action": action,
      });
      expect(status.childNodes).toHaveLength(2);
      expect(status.firstElementChild?.tagName).toBe("svg");
      expect(status.firstElementChild).toHaveClass("animate-spin");
      expect(status.firstElementChild).toHaveAttribute("aria-hidden", "true");
      expect(status.lastChild?.nodeType).toBe(Node.TEXT_NODE);
      expect(status.textContent).toBe(text);
      return status;
    };

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue(response);
      vi.mocked(parseSuggestionBlock).mockClear();
    });

    afterEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue({ id: "via-api" } as never);
    });

    it.each(["resolve", "delete", "reaction"] as const)("accepts one immediate duplicate %s, freezes its exact payload, and disables every competing root control", async (kind) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`duplicate-${kind}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;

      let control: HTMLElement;
      if (kind === "resolve") control = within(card(threadId)).getByTestId("comment-resolve");
      else if (kind === "reaction") control = reactionChip(rootReactionRow(threadId));
      else control = await openRootDelete(threadId);
      act(() => {
        control.click();
        control.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      const [documentId, payload] = vi.mocked(api.documents.comment).mock.calls[0];
      expect(documentId).toBe(`duplicate-${kind}`);
      expect(payload).toEqual(
        kind === "resolve"
          ? { action: "resolve", threadId, resolved: true }
          : kind === "delete"
            ? { action: "delete", threadId, replyId: undefined }
            : { action: "react", threadId, replyId: undefined, emoji: "👍" },
      );
      expect(Object.isFrozen(payload)).toBe(true);
      const status = within(card(threadId)).getByTestId("comment-action-pending");
      expect(status).toHaveAttribute("data-action", kind === "reaction" ? "react" : kind);
      expect(status).toHaveTextContent(kind === "resolve" ? "Resolving comment…" : kind === "delete" ? "Deleting comment…" : "Removing 👍 reaction…");
      expectRootControlsDisabled(threadId);

      await settle(pending, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeEnabled();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
    });

    it("lets the first mixed root action own the target before React commits pending UI", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("mixed-root");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const menuDelete = await openRootDelete(threadId);
      const resolve = within(card(threadId)).getByTestId("comment-resolve");
      const reaction = reactionChip(rootReactionRow(threadId));

      act(() => {
        resolve.click();
        reaction.click();
        menuDelete.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("mixed-root", { action: "resolve", threadId, resolved: true });
      expectRootControlsDisabled(threadId);
      expect(within(card(threadId)).getAllByTestId("comment-action-pending")).toHaveLength(1);
      await settle(pending, "resolve");
    });

    it("keeps the panel visit’s owner when its row unmounts for a tab switch", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("tab-switch-owner");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      await invokeRoot("resolve", threadId);

      fireEvent.click(screen.getByRole("tab", { name: "Resolved" }));
      expect(document.querySelector(`[data-thread-id="${threadId}"]`)).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: /Open/ }));
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");
      act(() => {
        within(card(threadId)).getByTestId("comment-resolve").click();
      });
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      await settle(pending, "resolve");
    });

    it("runs independent root, reply, and separate-thread targets concurrently without hiding untouched controls", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise);
      const fixture = makeApiSession("independent-targets");
      render(panel(fixture.session));
      const [first, second] = fixture.threadIds;
      const [firstReply, secondReply] = fixture.replyIds;
      const firstResolve = within(card(first)).getByTestId("comment-resolve");
      const firstReplyReaction = reactionChip(replyReactionRow(first, firstReply));
      const secondReaction = reactionChip(rootReactionRow(second));

      act(() => {
        firstResolve.click();
        firstReplyReaction.click();
        secondReaction.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      expect(vi.mocked(api.documents.comment).mock.calls).toEqual([
        ["independent-targets", { action: "resolve", threadId: first, resolved: true }],
        ["independent-targets", { action: "react", threadId: first, replyId: firstReply, emoji: "👍" }],
        ["independent-targets", { action: "react", threadId: second, replyId: undefined, emoji: "👍" }],
      ]);
      expect(within(card(first)).getAllByTestId("comment-action-pending")).toHaveLength(2);
      expect(within(card(second)).getAllByTestId("comment-action-pending")).toHaveLength(1);
      expect(reactionChip(replyReactionRow(second, secondReply))).toBeEnabled();

      await settle(requests[0], "resolve");
      expect(within(card(first)).getByTestId("comment-resolve")).toBeEnabled();
      expect(reactionChip(replyReactionRow(first, firstReply))).toBeDisabled();
      expect(reactionChip(rootReactionRow(second))).toBeDisabled();
      await settle(requests[1], "resolve");
      await settle(requests[2], "resolve");
    });

    it("does not race a reply owner with a root delete that would remove it", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("delete-reply-conflict");
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const [replyId] = fixture.replyIds;
      const rootDelete = await openRootDelete(threadId);
      const replyReaction = reactionChip(replyReactionRow(threadId, replyId));

      act(() => {
        replyReaction.click();
        rootDelete.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("delete-reply-conflict", {
        action: "react",
        threadId,
        replyId,
        emoji: "👍",
      });
      await settle(pending, "resolve");
    });

    it.each(["resolve", "delete", "reaction"] as const)("shows one current %s failure and clears it for a same-action retry", async (kind) => {
      const first = deferred<CommentResponse>();
      const retry = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
      const fixture = makeApiSession(`retry-${kind}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;

      await invokeRoot(kind, threadId);
      expectRootControlsDisabled(threadId);
      await settle(first, "reject", `${kind} unavailable`);

      const alert = within(card(threadId)).getByRole("alert");
      expect(alert).toHaveTextContent(`${kind} unavailable. Try again.`);
      expect(within(card(threadId)).getAllByRole("alert")).toHaveLength(1);
      expect(within(card(threadId)).getByTestId("comment-resolve")).toBeEnabled();
      expect(reactionChip(rootReactionRow(threadId))).toBeEnabled();

      await invokeRoot(kind, threadId);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toBeVisible();
      await settle(retry, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
    });

    describe.each([
      { label: "unbroken", reason: longActionReason, formatted: `${longActionReason}. Try again.` },
      { label: "ordinary", reason: "Service unavailable.", formatted: "Service unavailable. Try again." },
      {
        label: "literal HTML and quotes",
        reason: '<strong data-reason="quoted">Can\'t update & retry</strong><img src="missing" onerror="alert(1)">',
        formatted: '<strong data-reason="quoted">Can\'t update & retry</strong><img src="missing" onerror="alert(1)">. Try again.',
      },
      { label: "whitespace and trailing periods", reason: " \tFirst  line\nSecond line... \t\n", formatted: "First  line\nSecond line. Try again." },
      { label: "blank fallback", reason: " \t\n ", formatted: null },
    ])("wrapped comment action feedback: $label", ({ reason, formatted }) => {
      it.each([
        { kind: "resolve", action: "resolve", pending: "Resolving comment…", fallback: "Couldn’t resolve the comment. Try again." },
        { kind: "reopen", action: "resolve", pending: "Re-opening comment…", fallback: "Couldn’t re-open the comment. Try again." },
        { kind: "delete", action: "delete", pending: "Deleting comment…", fallback: "Couldn’t delete the comment. Try again." },
        { kind: "reply-delete", action: "delete", pending: "Deleting reply…", fallback: "Couldn’t delete the reply. Try again." },
        { kind: "reaction", action: "react", pending: "Removing 👍 reaction…", fallback: "Couldn’t update the reaction. Try again." },
        { kind: "reply-reaction", action: "react", pending: "Removing 👍 reaction…", fallback: "Couldn’t update the reaction. Try again." },
      ] as const)("preserves exact $kind text, replaces failures, and recovers without changing neighbors", async ({ kind, action, pending, fallback }) => {
        const first = deferred<CommentResponse>();
        const replacement = deferred<CommentResponse>();
        const retry = deferred<CommentResponse>();
        vi.mocked(api.documents.comment)
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(replacement.promise)
          .mockReturnValueOnce(retry.promise);
        const fixture = makeApiSession(`wrapped-${kind}`);
        if (kind === "reopen") {
          for (const id of fixture.threadIds) fixture.session.comments.setResolved(id, true, fixture.user);
        }
        render(panel(fixture.session));
        if (kind === "reopen") fireEvent.click(screen.getByRole("tab", { name: "Resolved2" }));
        const [threadId, neighborId] = fixture.threadIds;
        const [replyId] = fixture.replyIds;
        const isReply = kind === "reply-delete" || kind === "reply-reaction";
        const target = isReply ? reply(threadId, replyId) : card(threadId);
        const neighbor = card(neighborId);
        const neighborHtml = neighbor.outerHTML;
        const initialThreads = fixture.session.comments.list();
        const initialReply = reply(threadId, replyId);
        const initialReplyHtml = initialReply.outerHTML;
        const rootReactions = rootReactionRow(threadId);
        const rootReactionsHtml = rootReactions.outerHTML;
        const payload = action === "resolve"
          ? { action, threadId, resolved: kind !== "reopen" }
          : action === "delete"
            ? { action, threadId, replyId: isReply ? replyId : undefined }
            : { action, threadId, replyId: isReply ? replyId : undefined, emoji: "👍" };
        const invoke = async () => {
          if (kind === "reply-delete") {
            fireEvent.pointerDown(within(target).getByRole("button", { name: "Reply actions" }), { button: 0 });
            fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
          } else if (kind === "reply-reaction") {
            fireEvent.click(reactionChip(replyReactionRow(threadId, replyId)));
          } else {
            await invokeRoot(kind === "reopen" ? "resolve" : kind, threadId);
          }
        };
        const expectUnchanged = () => {
          expect(card(threadId)).toBe(isReply ? target.closest('[data-testid="comment-thread"]') : target);
          expect(reply(threadId, replyId)).toBe(initialReply);
          expect(card(neighborId)).toBe(neighbor);
          expect(neighbor.outerHTML).toBe(neighborHtml);
          expect(fixture.session.comments.list()).toEqual(initialThreads);
          expect(within(neighbor).queryByRole("alert")).toBeNull();
          expect(within(neighbor).queryByRole("status")).toBeNull();
          expect(within(neighbor).getByTestId("comment-resolve")).toBeEnabled();
          if (isReply) {
            expect(within(card(threadId)).getByTestId("comment-resolve")).toBeEnabled();
            expect(rootReactions.outerHTML).toBe(rootReactionsHtml);
          } else if (kind !== "delete") {
            expect(initialReply.outerHTML).toBe(initialReplyHtml);
          }
        };

        expect(longActionReason.length).toBeGreaterThanOrEqual(240);
        expect(longActionReason).not.toMatch(/\s/);
        await invoke();
        expect(api.documents.comment).toHaveBeenCalledTimes(1);
        expect(api.documents.comment).toHaveBeenLastCalledWith(fixture.session.docId, payload);
        const statusContent = expectActionPending(target, action, pending).innerHTML;
        if (isReply) {
          expect(within(target).getByRole("button", { name: "Reply actions" })).toBeDisabled();
          expect(reactionChip(replyReactionRow(threadId, replyId))).toBeDisabled();
        } else {
          expectRootControlsDisabled(threadId);
        }
        expectUnchanged();
        await settle(first, "reject", reason);
        const oldAlert = expectActionError(target, formatted ?? fallback);
        const oldText = oldAlert.firstChild!;
        expect(within(target).queryByRole("status")).toBeNull();
        expectUnchanged();

        await invoke();
        expect(api.documents.comment).toHaveBeenCalledTimes(2);
        expect(oldText.isConnected).toBe(false);
        expect(within(target).queryByRole("alert")).toBeNull();
        expect(expectActionPending(target, action, pending).innerHTML).toBe(statusContent);
        await settle(replacement, "reject", "  Replacement failure...  ");
        const replacementAlert = expectActionError(target, "Replacement failure. Try again.");
        const replacementText = replacementAlert.firstChild!;
        expect(target.textContent).not.toContain(formatted ?? fallback);
        expectUnchanged();

        await invoke();
        expect(api.documents.comment).toHaveBeenCalledTimes(3);
        expect(replacementText.isConnected).toBe(false);
        expect(within(target).queryByRole("alert")).toBeNull();
        expect(expectActionPending(target, action, pending).innerHTML).toBe(statusContent);
        await settle(retry, "resolve");
        expect(within(target).queryByRole("alert")).toBeNull();
        expect(within(target).queryByRole("status")).toBeNull();
        expect(reactionChip(isReply ? replyReactionRow(threadId, replyId) : rootReactionRow(threadId))).toBeEnabled();
        expect(vi.mocked(api.documents.comment).mock.calls).toEqual([
          [fixture.session.docId, payload],
          [fixture.session.docId, payload],
          [fixture.session.docId, payload],
        ]);
        expectUnchanged();
      });
    });

    it("compiles comment action wrap-anywhere to overflow-wrap anywhere, not break-all", async () => {
      const { compile } = await import("tailwindcss");
      const { build } = await compile("@tailwind utilities;");
      const css = build(["wrap-anywhere"]);
      expect(css).toMatch(/\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
      expect(css).not.toMatch(/word-break:\s*break-all/);
    });

    it.each(["resolve", "reject"] as const)("keeps a replacement document’s same-id owner locked through old %s and finalizer settlement", async (oldOutcome) => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeApiSession("old-document");
      const rendered = render(panel(old.session));
      const [threadId] = old.threadIds;
      await invokeRoot("resolve", threadId);

      auxiliarySessions.push(old.session);
      const current = makeApiSession("current-document", old.session);
      expect(current.threadIds[0]).toBe(threadId);
      rendered.rerender(panel(current.session));
      await invokeRoot("resolve", threadId);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");

      await settle(oldRequest, oldOutcome);
      expect(within(card(threadId)).getByTestId("comment-action-pending")).toHaveTextContent("Resolving comment…");
      expect(within(card(threadId)).queryByRole("alert")).toBeNull();
      act(() => {
        within(card(threadId)).getByTestId("comment-resolve").click();
      });
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.documents.comment).mock.calls.map(([documentId]) => documentId)).toEqual(["old-document", "current-document"]);

      await settle(currentRequest, "resolve");
      expect(within(card(threadId)).queryByTestId("comment-action-pending")).toBeNull();
      expect(within(card(threadId)).queryByTestId("comment-resolved-state")).toBeNull();
    });

    it.each(["resolve", "reject"] as const)("does not let old %s replace or clear a newer same-id error", async (oldOutcome) => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeApiSession("retired-error-document");
      const rendered = render(panel(old.session));
      const [threadId] = old.threadIds;
      const retiredReaction = reactProperty<() => void>(reactionChip(rootReactionRow(threadId)), "onClick");
      await invokeRoot("reaction", threadId);

      auxiliarySessions.push(old.session);
      const current = makeApiSession("new-error-document", old.session);
      rendered.rerender(panel(current.session));
      act(() => retiredReaction());
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      await invokeRoot("reaction", threadId);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.documents.comment).mock.calls.map(([documentId]) => documentId)).toEqual(["retired-error-document", "new-error-document"]);
      await settle(currentRequest, "reject", longActionReason);
      const alert = expectActionError(card(threadId), `${longActionReason}. Try again.`);
      const currentHtml = card(threadId).outerHTML;

      await settle(oldRequest, oldOutcome, `old-${longActionReason}`);
      expect(expectActionError(card(threadId), `${longActionReason}. Try again.`)).toBe(alert);
      expect(card(threadId).outerHTML).toBe(currentHtml);
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["root", "resolve"],
      ["reply", "reject"],
    ] as const)("retires a removed %s target before a late %s settlement", async (target, outcome) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`removed-${target}`);
      render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const [replyId] = fixture.replyIds;
      if (target === "root") await invokeRoot("resolve", threadId);
      else fireEvent.click(reactionChip(replyReactionRow(threadId, replyId)));
      expect(api.documents.comment).toHaveBeenCalledTimes(1);

      act(() => {
        if (target === "root") fixture.session.comments.remove(threadId);
        else fixture.session.comments.deleteReply(threadId, replyId);
      });
      if (target === "root") await waitFor(() => expect(document.querySelector(`[data-thread-id="${threadId}"]`)).toBeNull());
      else await waitFor(() => expect(card(threadId).querySelector(`[data-reply-id="${replyId}"]`)).toBeNull());

      await settle(pending, outcome, "removed target failed");
      expect(screen.queryByText(/removed target failed/i)).toBeNull();
      expect(screen.queryByTestId("comment-action-pending")).toBeNull();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
    });

    it.each(["resolve", "reject"] as const)("handles a late %s after panel unmount with zero unhandled rejections", async (outcome) => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession(`unmounted-action-${outcome}`);
      const rendered = render(panel(fixture.session));
      const [threadId] = fixture.threadIds;
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        await invokeRoot("delete", threadId);
        rendered.unmount();
        await settle(pending, outcome, longActionReason);
        await act(async () => {});
        expect(unhandled).toEqual([]);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(api.documents.comment).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it("keeps unrelated memoised cards at zero renders while one target publishes pending and success", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const fixture = makeApiSession("render-isolation");
      render(panel(fixture.session));
      const [first, second] = fixture.threadIds;

      vi.mocked(parseSuggestionBlock).mockClear();
      fireEvent.click(within(card(first)).getByTestId("comment-resolve"));
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "First reply.")).toHaveLength(1);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "Second reply.")).toHaveLength(0);

      await settle(pending, "resolve");
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "First reply.")).toHaveLength(2);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body === "Second reply.")).toHaveLength(0);
      expect(within(card(second)).getByTestId("comment-resolve")).toBeEnabled();
    });
  });

  describe("lazy comment action menu directional focus", () => {
    const directViews: {
      host: HTMLDivElement;
      root: ReturnType<typeof createRoot>;
    }[] = [];
    const directSessions: CollabSession[] = [];

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockClear();
    });

    const mountMenus = async ({
      moderator = false,
      role = "owner",
    }: {
      moderator?: boolean;
      role?: "owner" | "commenter";
    } = {}) => {
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const author = moderator
        ? makeCollabUser("bob", "Bob", null, "bob")
        : user;
      session = new CollabSession({
        docId: `directional-${moderator ? "moderator" : role}`,
        user,
        role,
        getToken: async () => "token",
        autoConnect: false,
      });
      directSessions.push(session);
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, "Alpha beta gamma.");
      const threadId = session.comments.add({
        from: 0,
        to: 5,
        body: "Root.",
        author,
      });
      const replyId = session.comments.reply(threadId, "Reply.", author)!;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directViews.push({ host, root });
      act(() => {
        root.render(
          <StrictMode>
            <TooltipProvider>
              <CommentsPanel
                session={session!}
                onClose={() => {}}
                onReveal={() => {}}
              />
            </TooltipProvider>
          </StrictMode>,
        );
      });
      const card = await waitFor(() => {
        const element = host.querySelector<HTMLElement>(
          `[data-testid="comment-thread"][data-thread-id="${threadId}"]`,
        );
        if (!element) throw new Error("The direct comment card did not mount");
        return element;
      });
      const reply = card.querySelector<HTMLElement>(
        `[data-testid="comment-reply"][data-reply-id="${replyId}"]`,
      );
      if (!reply) throw new Error("The direct reply did not mount");
      return {
        session,
        host,
        root,
        card,
        reply,
        threadId,
        replyId,
        trigger: (name: "Comment actions" | "Reply actions") => {
          const trigger = (name === "Comment actions" ? card : reply)
            .querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
          if (!trigger) throw new Error(`The ${name} trigger did not mount`);
          return trigger;
        },
      };
    };

    afterEach(() => {
      for (const view of directViews.splice(0)) {
        act(() => view.root.unmount());
        view.host.remove();
      }
      for (const directSession of directSessions.splice(0)) {
        if (directSession !== session) directSession.destroy();
      }
    });

    it.each([
      ["Comment actions", "ArrowDown", "Edit"],
      ["Comment actions", "ArrowUp", "Delete thread"],
      ["Reply actions", "ArrowDown", "Edit"],
      ["Reply actions", "ArrowUp", "Delete"],
    ] as const)(
      "opens %s with %s focused on %s without acting or scrolling",
      async (name, key, destination) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountMenus();
        const trigger = view.trigger(name);
        const before = {
          text: session!.ytext.toString(),
          comments: session!.comments.list(),
          scroll: [window.scrollX, window.scrollY],
        };
        trigger.focus();
        focus.mockClear();

        let event!: KeyboardEvent;
        act(() => {
          event = commentMenuKey(trigger, key);
        });

        const item = await screen.findByRole("menuitem", {
          name: destination,
        });
        await waitFor(() => expect(item).toHaveFocus());
        expect(event.defaultPrevented).toBe(true);
        expect(view.trigger(name)).toHaveAttribute("aria-expanded", "true");
        expect(focus).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(session!.ytext.toString()).toBe(before.text);
        expect(session!.comments.list()).toEqual(before.comments);
        expect(api.documents.comment).not.toHaveBeenCalled();
        expect([window.scrollX, window.scrollY]).toEqual(before.scroll);
        expect(
          view.host.querySelector('[data-testid="comment-edit"]'),
        ).toBeNull();
      },
    );

    it.each(["Comment actions", "Reply actions"] as const)(
      "authenticates distinct real capture and bubble wrappers for %s once",
      async (name) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountMenus();
        const trigger = view.trigger(name);
        const capture = commentMenuCaptureHandler(trigger);
        const bubble = commentMenuHandler(trigger);
        const captures: ReactKeyboardEvent<HTMLButtonElement>[] = [];
        const bubbles: ReactKeyboardEvent<HTMLButtonElement>[] = [];
        const restore = replaceReactProperties(trigger, {
          onKeyDownCapture: (
            event: ReactKeyboardEvent<HTMLButtonElement>,
          ) => {
            captures.push(event);
            capture(event);
          },
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
            bubbles.push(event);
            bubble(event);
          },
        });
        trigger.focus();
        focus.mockClear();
        const nativeEvent = commentMenuKeyboardEvent(trigger, "ArrowDown");
        const currentTargetGetter = Object.getOwnPropertyDescriptor(
          Event.prototype,
          "currentTarget",
        )?.get;
        const composedPath = Event.prototype.composedPath;
        if (!currentTargetGetter) {
          throw new Error("Event.currentTarget has no intrinsic getter");
        }
        const nativeDelivery: {
          current: {
            event: Event;
            receiver: EventTarget;
            currentTarget: EventTarget | null;
            terminal: EventTarget | undefined;
          } | null;
        } = { current: null };
        const observeNativeReceiver = function (
          this: EventTarget,
          event: Event,
        ) {
          if (event !== nativeEvent) return;
          nativeDelivery.current = {
            event,
            receiver: this,
            currentTarget: Reflect.apply(
              currentTargetGetter,
              event,
              [],
            ) as EventTarget | null,
            terminal: Reflect.apply(composedPath, event, []).at(-1),
          };
        };
        window.addEventListener("keydown", observeNativeReceiver, true);

        try {
          act(() => trigger.dispatchEvent(nativeEvent));
        } finally {
          window.removeEventListener("keydown", observeNativeReceiver, true);
        }
        restore();

        const item = await screen.findByRole("menuitem", { name: "Edit" });
        const observedDelivery = nativeDelivery.current;
        if (!observedDelivery) {
          throw new Error("The genuine native window delivery was not observed");
        }
        expect(captures).toHaveLength(1);
        expect(bubbles).toHaveLength(1);
        expect(captures[0]).not.toBe(bubbles[0]);
        expect(captures[0]!.nativeEvent).toBe(nativeEvent);
        expect(bubbles[0]!.nativeEvent).toBe(nativeEvent);
        expect(observedDelivery.event).toBe(nativeEvent);
        expect(observedDelivery.receiver).toBe(observedDelivery.currentTarget);
        expect(observedDelivery.receiver).toBe(observedDelivery.terminal);
        expect(nativeEvent.defaultPrevented).toBe(true);
        expect(view.trigger(name)).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByRole("menu")).toHaveLength(1);
        expect(document.activeElement).toBe(item);
        expect(
          focus.mock.instances.filter((instance) => instance === item),
        ).toHaveLength(1);
        expect(api.documents.comment).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["Comment actions", "ArrowDown", "Delete thread"],
      ["Comment actions", "ArrowUp", "Delete thread"],
      ["Reply actions", "ArrowDown", "Delete"],
      ["Reply actions", "ArrowUp", "Delete"],
    ] as const)(
      "focuses the sole moderator %s item with %s",
      async (name, key, destination) => {
        const view = await mountMenus({ moderator: true });
        const trigger = view.trigger(name);
        trigger.focus();

        const event = commentMenuKey(trigger, key);

        const item = await screen.findByRole("menuitem", {
          name: destination,
        });
        await waitFor(() => expect(item).toHaveFocus());
        expect(event.defaultPrevented).toBe(true);
        expect(screen.getAllByRole("menuitem")).toHaveLength(1);
        expect(api.documents.comment).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["Alt-modified", { altKey: true }],
      ["Control-modified", { ctrlKey: true }],
      ["Meta-modified", { metaKey: true }],
      ["Shift-modified", { shiftKey: true }],
      ["repeating", { repeat: true }],
      ["composing", { isComposing: true }],
      ["non-bubbling", { bubbles: false }],
      ["non-cancelable", { cancelable: false }],
    ] as const)(
      "leaves a %s directional event inert",
      async (_name, init) => {
        const view = await mountMenus();
        const trigger = view.trigger("Comment actions");
        trigger.focus();

        const event = commentMenuKey(trigger, "ArrowDown", init);

        expect(event.defaultPrevented).toBe(false);
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("menu")).toBeNull();
        expect(trigger).toHaveFocus();
      },
    );

    it("keeps disabled busy triggers inert", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const view = await mountMenus({ role: "commenter" });
      fireEvent.click(within(view.card).getByTestId("comment-resolve"));
      const trigger = view.trigger("Comment actions");
      expect(trigger).toBeDisabled();

      const event = commentMenuKeyboardEvent(trigger, "ArrowDown");
      act(() => trigger.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve({} as CommentResponse));
    });

    it("rejects untrusted, fabricated, and foreign-realm events before a clean request", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      const handler = commentMenuHandler(trigger);
      trigger.focus();
      const untrusted = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      });
      const nativeForFabrication = commentMenuKeyboardEvent(
        trigger,
        "ArrowDown",
      );
      const fabricated = {
        type: "keydown",
        currentTarget: trigger,
        target: trigger,
        nativeEvent: nativeForFabrication,
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const foreignWindow = frame.contentDocument?.defaultView;
      if (!foreignWindow) throw new Error("The foreign menu realm did not mount");
      const foreign = new foreignWindow.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "ArrowDown",
        key: "ArrowDown",
      });
      markRequestModeEventTrusted(foreign);

      act(() => {
        trigger.dispatchEvent(untrusted);
        handler(fabricated);
        trigger.dispatchEvent(foreign);
      });

      expect(untrusted.defaultPrevented).toBe(false);
      expect(nativeForFabrication.defaultPrevented).toBe(false);
      expect(foreign.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();

      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
      frame.remove();
    });

    it("rejects a fully shaped fabricated bubble wrapper during a genuine native dispatch", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      const bubble = commentMenuHandler(trigger);
      trigger.focus();
      const event = commentMenuKeyboardEvent(trigger, "ArrowDown");
      trigger.addEventListener(
        "keydown",
        (nativeEvent) => {
          bubble(
            fabricatedCommentMenuWrapper(
              trigger,
              nativeEvent as KeyboardEvent,
            ),
          );
          nativeEvent.stopPropagation();
        },
        { once: true },
      );

      act(() => trigger.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).not.toHaveBeenCalled();
      await act(async () => Promise.resolve());
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("requires both exact React dispatch phases before disclosure", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      trigger.focus();
      const captureOnly = commentMenuKeyboardEvent(trigger, "ArrowDown");
      trigger.addEventListener(
        "keydown",
        (event) => event.stopPropagation(),
        { once: true },
      );
      act(() => trigger.dispatchEvent(captureOnly));
      expect(captureOnly.defaultPrevented).toBe(false);

      await act(async () => Promise.resolve());
      const restore = replaceReactProperties(trigger, {
        onKeyDownCapture: () => undefined,
      });
      const bubbleOnly = commentMenuKeyboardEvent(trigger, "ArrowDown");
      act(() => trigger.dispatchEvent(bubbleOnly));
      restore();

      expect(bubbleOnly.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).not.toHaveBeenCalled();
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("rejects the same wrapper at capture and bubble before a clean successor", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      const capture = commentMenuCaptureHandler(trigger);
      const bubble = commentMenuHandler(trigger);
      const restore = replaceReactProperties(trigger, {
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          capture(event);
          bubble(event);
          event.stopPropagation();
        },
      });
      trigger.focus();
      const rejected = commentMenuKeyboardEvent(trigger, "ArrowDown");

      act(() => trigger.dispatchEvent(rejected));
      restore();

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).not.toHaveBeenCalled();
      await act(async () => Promise.resolve());
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("rejects crossed capture and bubble wrappers before a clean successor", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      const capture = commentMenuCaptureHandler(trigger);
      const bubble = commentMenuHandler(trigger);
      const crossed = commentMenuKeyboardEvent(trigger, "ArrowDown");
      let firstCapture = true;
      const restore = replaceReactProperties(trigger, {
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          if (!firstCapture) return;
          firstCapture = false;
          capture(event);
          event.stopPropagation();
          trigger.dispatchEvent(crossed);
        },
        onKeyDown: bubble,
      });
      trigger.focus();
      const source = commentMenuKeyboardEvent(trigger, "ArrowDown");

      act(() => trigger.dispatchEvent(source));
      restore();

      expect(source.defaultPrevented).toBe(false);
      expect(crossed.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).not.toHaveBeenCalled();
      await act(async () => Promise.resolve());
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("rejects a same-prototype owner-window path terminal with exact realm facts", async () => {
      const nativePath = Event.prototype.composedPath;
      const windowLike = Object.create(
        window.Window.prototype,
      ) as Window & Record<string, unknown>;
      Object.defineProperties(windowLike, {
        document: { configurable: true, value: document },
        window: { configurable: true, value: windowLike },
        self: { configurable: true, value: windowLike },
        Window: { configurable: true, value: window.Window },
        Event: { configurable: true, value: window.Event },
        KeyboardEvent: { configurable: true, value: window.KeyboardEvent },
        Node: { configurable: true, value: window.Node },
        Object: { configurable: true, value: window.Object },
        Reflect: { configurable: true, value: window.Reflect },
      });
      expect(Object.getPrototypeOf(windowLike)).toBe(window.Window.prototype);
      expect(windowLike.document).toBe(document);
      expect(windowLike.KeyboardEvent).toBe(window.KeyboardEvent);
      const path = vi
        .spyOn(Event.prototype, "composedPath")
        .mockImplementation(function (this: Event) {
          const actual = nativePath.call(this);
          return actual.length >= 1
            ? [...actual.slice(0, -1), windowLike]
            : actual;
        });
      const stale = await mountMenus();
      const trigger = stale.trigger("Comment actions");
      trigger.focus();

      const rejected = commentMenuKey(trigger, "ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(api.documents.comment).not.toHaveBeenCalled();
      path.mockRestore();

      const successor = await mountMenus();
      const successorTrigger = successor.trigger("Comment actions");
      successorTrigger.focus();
      act(() => commentMenuKey(successorTrigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it.each([
      ["wrong key", { code: "KeyA", key: "a" }],
      ["wrong code", { code: "ArrowUp", key: "ArrowDown" }],
    ])("rejects %s without poisoning a clean request", async (_label, init) => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      trigger.focus();
      const rejected = requestModeKeyboardEvent(trigger, init.key, {
        code: init.code,
      });

      act(() => trigger.dispatchEvent(rejected));

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it.each(["prevented", "propagation-stopped"] as const)(
      "rejects a previously %s event and leaves the publication usable",
      async (state) => {
        const view = await mountMenus();
        const trigger = view.trigger("Comment actions");
        trigger.focus();
        const rejected = commentMenuKeyboardEvent(trigger, "ArrowDown");
        if (state === "prevented") rejected.preventDefault();
        else rejected.stopPropagation();

        act(() => trigger.dispatchEvent(rejected));

        expect(screen.queryByRole("menu")).toBeNull();
        act(() => commentMenuKey(trigger, "ArrowDown"));
        expect(document.activeElement).toBe(
          await screen.findByRole("menuitem", { name: "Edit" }),
        );
      },
    );

    it("rejects wrong focus and detached trigger authority", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      const other = document.createElement("button");
      document.body.append(other);
      other.focus();

      const wrongFocus = commentMenuKey(trigger, "ArrowDown");
      expect(wrongFocus.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();

      trigger.remove();
      const detached = commentMenuKeyboardEvent(trigger, "ArrowDown");
      act(() => trigger.dispatchEvent(detached));
      expect(detached.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      other.remove();
    });

    it("claims event authority before replay and crossed-target reuse", async () => {
      const view = await mountMenus();
      const commentTrigger = view.trigger("Comment actions");
      const replyTrigger = view.trigger("Reply actions");
      commentTrigger.focus();
      const event = commentMenuKeyboardEvent(commentTrigger, "ArrowDown");

      act(() => {
        commentTrigger.dispatchEvent(event);
        commentTrigger.dispatchEvent(event);
        replyTrigger.dispatchEvent(event);
      });

      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });

    it("claims before captured prevention can reenter", async () => {
      const nativePreventDefault = Event.prototype.preventDefault;
      let trigger: HTMLButtonElement | null = null;
      let reentered: KeyboardEvent | null = null;
      vi.spyOn(Event.prototype, "preventDefault").mockImplementation(function (
        this: Event,
      ) {
        if (this instanceof KeyboardEvent && trigger && !reentered) {
          reentered = commentMenuKeyboardEvent(trigger, "ArrowDown");
          trigger.dispatchEvent(reentered);
        }
        return nativePreventDefault.call(this);
      });
      const view = await mountMenus();
      trigger = view.trigger("Comment actions");
      trigger.focus();

      act(() => commentMenuKey(trigger!, "ArrowDown"));

      expect(reentered).not.toBeNull();
      expect(reentered!.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });

    it("does no work after cleanup and a clean instance recovers", async () => {
      const ownerWindow = document.defaultView;
      if (!ownerWindow) throw new Error("The test document has no owner window");
      const addEventListener = vi.spyOn(
        ownerWindow,
        "addEventListener",
      );
      const removeEventListener = vi.spyOn(
        ownerWindow,
        "removeEventListener",
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        const stale = await mountMenus();
        const staleTrigger = stale.trigger("Comment actions");
        const staleCapture = commentMenuCaptureHandler(staleTrigger);
        const staleHandler = commentMenuHandler(staleTrigger);
        const windowKeyListeners = (
          spy: typeof addEventListener | typeof removeEventListener,
        ) =>
          spy.mock.calls.flatMap((call) =>
            call[0] === "keydown" &&
            call[2] === true &&
            typeof call[1] === "function"
              ? [call[1] as EventListener]
              : [],
          );
        const added = windowKeyListeners(addEventListener);
        const alreadyRemoved = windowKeyListeners(removeEventListener);
        const staleListeners = added.filter(
          (listener) => !alreadyRemoved.includes(listener),
        );
        expect(staleListeners.length).toBeGreaterThanOrEqual(2);
        for (const listener of staleListeners) {
          expect(
            added.filter((candidate) => candidate === listener),
          ).toHaveLength(1);
        }

        act(() => stale.root.unmount());
        directViews.splice(
          directViews.findIndex((candidate) => candidate.root === stale.root),
          1,
        );
        stale.host.remove();
        const afterCleanup = commentMenuKeyboardEvent(
          staleTrigger,
          "ArrowDown",
        );
        const fabricated = {
          type: "keydown",
          currentTarget: staleTrigger,
          target: staleTrigger,
          nativeEvent: afterCleanup,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>;

        act(() => staleHandler(fabricated));

        expect(afterCleanup.defaultPrevented).toBe(false);
        expect(screen.queryByRole("menu")).toBeNull();
        const removed = windowKeyListeners(removeEventListener);
        for (const listener of staleListeners) {
          expect(
            removed.filter((candidate) => candidate === listener),
          ).toHaveLength(1);
        }

        const clean = await mountMenus();
        const cleanTrigger = clean.trigger("Comment actions");
        const restore = replaceReactProperties(cleanTrigger, {
          onKeyDownCapture: staleCapture,
          onKeyDown: staleHandler,
        });
        const replayStaleReceivers = function (
          this: EventTarget,
          event: Event,
        ) {
          staleListeners.forEach((listener) => listener.call(this, event));
        };
        ownerWindow.addEventListener("keydown", replayStaleReceivers, true);
        const staleReplay = commentMenuKeyboardEvent(
          cleanTrigger,
          "ArrowDown",
        );
        cleanTrigger.focus();
        try {
          act(() => cleanTrigger.dispatchEvent(staleReplay));
        } finally {
          ownerWindow.removeEventListener(
            "keydown",
            replayStaleReceivers,
            true,
          );
          restore();
        }

        expect(staleReplay.defaultPrevented).toBe(false);
        expect(screen.queryByRole("menu")).toBeNull();
        cleanTrigger.focus();
        focus.mockClear();
        act(() => commentMenuKey(cleanTrigger, "ArrowDown"));
        const edit = await screen.findByRole("menuitem", { name: "Edit" });
        expect(document.activeElement).toBe(edit);
        expect(screen.getAllByRole("menu")).toHaveLength(1);
        expect(
          focus.mock.instances.filter((instance) => instance === edit),
        ).toHaveLength(1);
      } finally {
        addEventListener.mockRestore();
        removeEventListener.mockRestore();
        focus.mockRestore();
      }
    });

    it("retires stale permission facts until a clean render successor", async () => {
      const view = await mountMenus();
      const trigger = view.trigger("Comment actions");
      trigger.focus();
      (view.session as unknown as { role: string }).role = "commenter";

      const rejected = commentMenuKey(trigger, "ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();

      (view.session as unknown as { role: string }).role = "owner";
      act(() => {
        view.session.comments.ymap
          .get(view.threadId)!
          .set("body", "Permission successor.");
      });
      await screen.findByText("Permission successor.");
      const successor = view.trigger("Comment actions");
      successor.focus();
      act(() => commentMenuKey(successor, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("rejects stale callback and ordered-item facts without poisoning the current owner", async () => {
      const view = await mountMenus();
      const original = view.trigger("Comment actions");
      const staleHandler = commentMenuHandler(original);

      act(() => {
        view.session.comments.ymap
          .get(view.threadId)!
          .set("authorId", "bob");
      });
      const current = await waitFor(() => {
        const candidate = view.trigger("Comment actions");
        if (commentMenuHandler(candidate) === staleHandler) {
          throw new Error("The current menu callback was not published");
        }
        return candidate;
      });
      const propsKey = Object.keys(current).find((key) =>
        key.startsWith("__reactProps$"),
      );
      if (!propsKey) throw new Error("React props were not attached to the menu trigger");
      const record = current as unknown as Record<string, Record<string, unknown>>;
      const props = record[propsKey];
      record[propsKey] = { ...props, onKeyDown: staleHandler };
      current.focus();

      const rejected = commentMenuKey(current, "ArrowDown");
      record[propsKey] = props;

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
      current.focus();
      act(() => commentMenuKey(current, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Delete thread" }),
      );
      expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    });

    it("rejects stale reply identity and accepts a committed render successor", async () => {
      const view = await mountMenus();
      const original = view.trigger("Reply actions");
      const storedThread = view.session.comments.ymap.get(view.threadId)!;
      const replies = storedThread.get("replies") as Y.Array<Record<string, unknown>>;
      const reply = replies.get(0);

      act(() => {
        view.session.ydoc.transact(() => {
          replies.delete(0, 1);
          replies.insert(0, [{ ...reply }]);
        });
      });
      original.focus();

      const rejected = commentMenuKey(original, "ArrowUp");

      expect(rejected.defaultPrevented).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();

      act(() => {
        view.session.comments.editBody(
          view.threadId,
          "Reply identity successor.",
          view.replyId,
        );
      });
      await screen.findByText("Reply identity successor.");
      const successor = view.trigger("Reply actions");
      successor.focus();
      act(() => commentMenuKey(successor, "ArrowUp"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Delete" }),
      );
    });

    it.each([
      "detached and reinserted trigger",
      "reordered and restored trigger",
      "replaced and restored trigger",
      "changed and restored trigger",
    ] as const)(
      "retains history for a %s and permits a distinct successor",
      async (mutation) => {
        const stale = await mountMenus();
        const trigger = stale.trigger("Comment actions");
        const parent = trigger.parentElement!;
        const next = trigger.nextSibling;
        if (mutation === "detached and reinserted trigger") {
          trigger.remove();
          parent.insertBefore(trigger, next);
        } else if (mutation === "reordered and restored trigger") {
          parent.append(trigger);
          parent.insertBefore(trigger, next);
        } else if (mutation === "replaced and restored trigger") {
          const replacement = trigger.cloneNode(true);
          parent.replaceChild(replacement, trigger);
          parent.replaceChild(trigger, replacement);
        } else {
          trigger.setAttribute("aria-expanded", "true");
          trigger.setAttribute("aria-expanded", "false");
        }
        await act(async () => {
          await Promise.resolve();
        });
        trigger.focus();

        const rejected = commentMenuKey(trigger, "ArrowDown");

        expect(rejected.defaultPrevented).toBe(false);
        expect(screen.queryByRole("menu")).toBeNull();

        const successor = await mountMenus();
        const successorTrigger = successor.trigger("Comment actions");
        successorTrigger.focus();
        act(() => commentMenuKey(successorTrigger, "ArrowDown"));
        expect(document.activeElement).toBe(
          await screen.findByRole("menuitem", { name: "Edit" }),
        );
      },
    );

    it("rejects a selector-compatible replacement item ref before prevention", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const view = await mountMenus();
      const readComments = view.session.comments.list.bind(
        view.session.comments,
      );
      let replaced = false;
      vi.spyOn(view.session.comments, "list").mockImplementation(() => {
        const item = document.querySelector<HTMLElement>(
          '[role="menuitem"]',
        );
        if (item && !replaced) {
          replaced = true;
          const ref = commentMenuItemRef(item);
          const replacement = item.cloneNode(true) as HTMLElement;
          ref(replacement);
          ref(item);
        }
        return readComments();
      });
      const trigger = view.trigger("Comment actions");
      trigger.focus();
      focus.mockClear();

      const rejected = commentMenuKey(trigger, "ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(replaced).toBe(true);
      expect(
        focus.mock.instances.some(
          (instance) =>
            instance instanceof HTMLElement &&
            instance.getAttribute("role") === "menuitem",
        ),
      ).toBe(false);
      expect(api.documents.comment).not.toHaveBeenCalled();

      vi.mocked(view.session.comments.list).mockRestore();
      const successor = await mountMenus();
      const successorTrigger = successor.trigger("Comment actions");
      successorTrigger.focus();
      act(() => commentMenuKey(successorTrigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it.each(["replace-restore", "reorder-restore"] as const)(
      "retains menu item %s history before prevention",
      async (mutation) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountMenus();
        const readComments = view.session.comments.list.bind(
          view.session.comments,
        );
        let mutated = false;
        vi.spyOn(view.session.comments, "list").mockImplementation(() => {
          const item = document.querySelector<HTMLElement>(
            '[role="menuitem"]',
          );
          if (item && !mutated) {
            mutated = true;
            const parent = item.parentElement!;
            const next = item.nextSibling;
            if (mutation === "replace-restore") {
              const replacement = item.cloneNode(true);
              parent.replaceChild(replacement, item);
              parent.replaceChild(item, replacement);
            } else {
              parent.append(item);
              parent.insertBefore(item, next);
            }
          }
          return readComments();
        });
        const trigger = view.trigger("Comment actions");
        trigger.focus();
        focus.mockClear();

        const rejected = commentMenuKey(trigger, "ArrowUp");

        expect(rejected.defaultPrevented).toBe(false);
        await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
        expect(mutated).toBe(true);
        expect(
          focus.mock.instances.some(
            (instance) =>
              instance instanceof HTMLElement &&
              instance.getAttribute("role") === "menuitem",
          ),
        ).toBe(false);
        expect(api.documents.comment).not.toHaveBeenCalled();

        vi.mocked(view.session.comments.list).mockRestore();
        const successor = await mountMenus();
        const successorTrigger = successor.trigger("Comment actions");
        successorTrigger.focus();
        act(() => commentMenuKey(successorTrigger, "ArrowUp"));
        expect(document.activeElement).toBe(
          await screen.findByRole("menuitem", { name: "Delete thread" }),
        );
      },
    );

    it("retains portal mutation history through failed autofocus and a clean successor", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const view = await mountMenus();
      const readComments = view.session.comments.list.bind(view.session.comments);
      let mutated = false;
      vi.spyOn(view.session.comments, "list").mockImplementation(() => {
        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        const item = menu?.querySelector<HTMLElement>('[role="menuitem"]');
        if (item && !mutated) {
          mutated = true;
          item.setAttribute("data-portal-history", "changed");
          item.removeAttribute("data-portal-history");
        }
        return readComments();
      });
      const trigger = view.trigger("Comment actions");
      trigger.focus();
      focus.mockClear();

      const rejected = commentMenuKey(trigger, "ArrowDown");

      expect(rejected.defaultPrevented).toBe(false);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      await waitFor(() => expect(view.trigger("Comment actions")).toHaveFocus());
      expect(mutated).toBe(true);
      expect(
        focus.mock.instances.some(
          (instance) =>
            instance instanceof HTMLElement &&
            instance.getAttribute("role") === "menuitem",
        ),
      ).toBe(false);

      vi.mocked(view.session.comments.list).mockRestore();
      const successor = view.trigger("Comment actions");
      successor.focus();
      focus.mockClear();
      act(() => commentMenuKey(successor, "ArrowDown"));
      const edit = await screen.findByRole("menuitem", { name: "Edit" });
      expect(document.activeElement).toBe(edit);
      expect(
        focus.mock.instances.filter((instance) => instance === edit),
      ).toHaveLength(1);
    });

    it("retires authority after a captured keyboard descriptor is replaced", async () => {
      const stale = await mountMenus();
      const trigger = stale.trigger("Comment actions");
      trigger.focus();
      const descriptor = Object.getOwnPropertyDescriptor(
        KeyboardEvent.prototype,
        "key",
      );
      if (!descriptor) throw new Error("KeyboardEvent.key has no descriptor");

      try {
        Object.defineProperty(KeyboardEvent.prototype, "key", {
          ...descriptor,
          get: () => "ArrowDown",
        });
        const rejected = commentMenuKeyboardEvent(trigger, "ArrowDown");
        act(() => trigger.dispatchEvent(rejected));
        expect(rejected.defaultPrevented).toBe(false);
      } finally {
        Object.defineProperty(KeyboardEvent.prototype, "key", descriptor);
      }

      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(screen.queryByRole("menu")).toBeNull();

      const successor = await mountMenus();
      const successorTrigger = successor.trigger("Comment actions");
      successorTrigger.focus();
      act(() => commentMenuKey(successorTrigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it("supports repeated same-direction disclosure after close", async () => {
      const view = await mountMenus();
      let trigger = view.trigger("Comment actions");
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      await screen.findByRole("menuitem", { name: "Edit" });

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

      trigger = view.trigger("Comment actions");
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowDown"));
      expect(document.activeElement).toBe(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );
    });

    it.each(["Enter", " "] as const)(
      "retains Radix %s disclosure",
      async (key) => {
        const view = await mountMenus();
        view.trigger("Comment actions").focus();
        const trigger = view.trigger("Comment actions");

        fireEvent.keyDown(trigger, { key });

        expect(
          await screen.findByRole("menuitem", { name: "Edit" }),
        ).toBeInTheDocument();
      },
    );

    it("retains hover arming, pointer disclosure, and item activation", async () => {
      const view = await mountMenus();
      fireEvent.pointerEnter(view.trigger("Comment actions"));
      const trigger = view.trigger("Comment actions");

      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.click(trigger);
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Edit" }),
      );

      expect(
        view.host.querySelector('[data-testid="comment-edit"]'),
      ).toBeInTheDocument();
    });

    it("retains Escape and outside close with trigger focus return", async () => {
      const view = await mountMenus();
      let trigger = view.trigger("Comment actions");
      trigger.focus();
      act(() => commentMenuKey(trigger, "ArrowUp"));
      await screen.findByRole("menuitem", { name: "Delete thread" });

      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(view.trigger("Comment actions")).toHaveFocus();

      trigger = view.trigger("Comment actions");
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.click(trigger);
      await screen.findByRole("menuitem", { name: "Edit" });
      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });
  });

  describe("quick reaction picker keyboard focus", () => {
    type ReactionTarget = "Comment" | "Reply";
    const directViews: {
      host: HTMLDivElement;
      root: ReturnType<typeof createRoot>;
      session: CollabSession;
    }[] = [];

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockClear();
      Element.prototype.scrollIntoView ??= () => {};
    });

    afterEach(() => {
      for (const view of directViews.splice(0)) {
        act(() => view.root.unmount());
        view.host.remove();
        if (view.session !== session) view.session.destroy();
      }
    });

    const mountPickers = async ({
      role = "owner",
      withReaction = false,
    }: {
      role?: "owner" | "commenter";
      withReaction?: boolean;
    } = {}) => {
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const current = new CollabSession({
        docId: `reaction-picker-${role}-${directViews.length}`,
        user,
        role,
        getToken: async () => "token",
        autoConnect: false,
      });
      session = current;
      current.keepAlive();
      current.synced = true;
      current.ytext.insert(0, "Alpha beta gamma.");
      const threadId = current.comments.add({
        from: 0,
        to: 5,
        body: "Root.",
        author: user,
      });
      const replyId = current.comments.reply(threadId, "Reply.", user)!;
      if (withReaction) {
        current.comments.toggleReaction(threadId, null, "👍", user);
        current.comments.toggleReaction(threadId, replyId, "👍", user);
      }
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      directViews.push({ host, root, session: current });
      act(() => {
        root.render(
          <StrictMode>
            <TooltipProvider>
              <CommentsPanel
                session={current}
                onClose={() => {}}
                onReveal={() => {}}
              />
            </TooltipProvider>
          </StrictMode>,
        );
      });
      const card = await waitFor(() => {
        const element = host.querySelector<HTMLElement>(
          `[data-testid="comment-thread"][data-thread-id="${threadId}"]`,
        );
        if (!element) throw new Error("The direct reaction comment did not mount");
        return element;
      });
      const reply = card.querySelector<HTMLElement>(
        `[data-testid="comment-reply"][data-reply-id="${replyId}"]`,
      );
      if (!reply) throw new Error("The direct reaction reply did not mount");
      const row = (target: ReactionTarget) =>
        target === "Comment"
          ? within(card).getAllByTestId("reaction-row")[0]!
          : within(reply).getByTestId("reaction-row");
      const trigger = (target: ReactionTarget) =>
        within(row(target)).getByRole("button", {
          name: "Add reaction",
        }) as HTMLButtonElement;
      return {
        card,
        host,
        reply,
        replyId,
        root,
        row,
        session: current,
        threadId,
        trigger,
      };
    };

    const openPicker = async (
      view: Awaited<ReturnType<typeof mountPickers>>,
      target: ReactionTarget,
      method: "pointer" | "Enter" | " " = "pointer",
    ) => {
      const trigger = view.trigger(target);
      if (method === "pointer") {
        if (trigger.dataset.state === "closed") {
          fireEvent.click(trigger);
        } else {
          fireEvent.pointerDown(trigger, { button: 0 });
        }
      } else {
        trigger.focus();
        fireEvent.keyDown(trigger, { key: method });
      }
      const picker = await screen.findByTestId("reaction-picker");
      const options = within(picker).getAllByTestId(
        "reaction-option",
      ) as HTMLButtonElement[];
      await waitFor(() => expect(options[0]).toHaveFocus());
      return { options, picker, trigger: view.trigger(target) };
    };

    const targetReactions = (
      view: Awaited<ReturnType<typeof mountPickers>>,
      target: ReactionTarget,
    ) => {
      const thread = view.session.comments
        .list()
        .find((candidate) => candidate.id === view.threadId)!;
      return target === "Comment"
        ? thread.reactions
        : thread.replies.find((candidate) => candidate.id === view.replyId)!.reactions;
    };

    it.each([
      ["Comment", "ArrowRight", 5, 0],
      ["Comment", "ArrowDown", 1, 2],
      ["Comment", "ArrowLeft", 0, 5],
      ["Comment", "ArrowUp", 4, 3],
      ["Comment", "Home", 3, 0],
      ["Comment", "End", 2, 5],
      ["Reply", "ArrowRight", 5, 0],
      ["Reply", "ArrowDown", 1, 2],
      ["Reply", "ArrowLeft", 0, 5],
      ["Reply", "ArrowUp", 4, 3],
      ["Reply", "Home", 3, 0],
      ["Reply", "End", 2, 5],
    ] as const)(
      "moves the direct Strict Mode %s picker once with %s from %d to %d",
      async (target, key, sourceIndex, destinationIndex) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        const { options, picker, trigger } = await openPicker(view, target);
        const toggle = vi.spyOn(view.session.comments, "toggleReaction");
        const beforeText = view.session.ytext.toString();
        const beforeReactions = structuredClone(targetReactions(view, target));
        const panelScroll = view.card.parentElement!;
        view.host.scrollTop = 11;
        panelScroll.scrollTop = 17;
        const beforeWindowScroll = [window.scrollX, window.scrollY];
        options[sourceIndex]!.focus();
        focus.mockClear();
        preventDefault.mockClear();
        toggle.mockClear();
        vi.mocked(api.documents.comment).mockClear();
        const publicFocus = vi.fn();
        Object.defineProperty(options[destinationIndex], "focus", {
          configurable: true,
          value: publicFocus,
        });

        const event = reactionPickerKey(options[sourceIndex]!, key);

        expect(event.defaultPrevented).toBe(true);
        expect(options[destinationIndex]).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledOnce();
        expect(focus.mock.instances[0]).toBe(options[destinationIndex]);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(publicFocus).not.toHaveBeenCalled();
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(picker).toBeInTheDocument();
        expect(toggle).not.toHaveBeenCalled();
        expect(api.documents.comment).not.toHaveBeenCalled();
        expect(targetReactions(view, target)).toEqual(beforeReactions);
        expect(view.session.ytext.toString()).toBe(beforeText);
        expect(view.host.querySelector("[data-testid='comment-edit']")).toBeNull();
        expect(view.host.scrollTop).toBe(11);
        expect(panelScroll.scrollTop).toBe(17);
        expect([window.scrollX, window.scrollY]).toEqual(beforeWindowScroll);
      },
    );

    it.each([
      ["Comment", "Home", 0],
      ["Comment", "End", 5],
      ["Reply", "Home", 0],
      ["Reply", "End", 5],
    ] as const)(
      "leaves the direct Strict Mode %s picker %s boundary at %d inert",
      async (target, key, index) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        const { options, picker, trigger } = await openPicker(view, target);
        options[index]!.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const before = structuredClone(targetReactions(view, target));

        const event = reactionPickerKey(options[index]!, key);

        expect(event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(options[index]).toHaveFocus();
        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(picker).toBeInTheDocument();
        expect(targetReactions(view, target)).toEqual(before);
        expect(api.documents.comment).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["Comment", "pointer"],
      ["Comment", "Enter"],
      ["Comment", " "],
      ["Reply", "pointer"],
      ["Reply", "Enter"],
      ["Reply", " "],
    ] as const)(
      "retains %s Add reaction %s opening and Radix autofocus",
      async (target, method) => {
        const view = await mountPickers();
        const { options, trigger } = await openPicker(view, target, method);

        expect(trigger).toHaveAttribute("aria-expanded", "true");
        expect(options[0]).toHaveFocus();
        expect(api.documents.comment).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["Comment", "pointer"],
      ["Comment", "Enter"],
      ["Comment", " "],
      ["Reply", "pointer"],
      ["Reply", "Enter"],
      ["Reply", " "],
    ] as const)(
      "retains %s emoji %s activation without an earlier navigation toggle",
      async (target, activation) => {
        const view = await mountPickers();
        const { options } = await openPicker(view, target);
        const selected = options[2]!;

        if (activation === "pointer") {
          fireEvent.click(selected);
        } else {
          selected.focus();
          await userEvent
            .setup()
            .keyboard(activation === "Enter" ? "{Enter}" : " ");
        }

        await waitFor(() =>
          expect(screen.queryByTestId("reaction-picker")).toBeNull(),
        );
        expect(targetReactions(view, target)["🎉"]).toEqual([
          view.session.user.id,
        ]);
      },
    );

    it.each(["Comment", "Reply"] as const)(
      "retains %s Escape/outside close and trigger focus return",
      async (target) => {
        const view = await mountPickers();
        let opened = await openPicker(view, target);

        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await userEvent.setup().click(document.body);
        await waitFor(() =>
          expect(screen.queryByTestId("reaction-picker")).toBeNull(),
        );
        expect(targetReactions(view, target)).toEqual({});

        opened = await openPicker(view, target);
        fireEvent.keyDown(opened.options[0]!, { key: "Escape" });
        await waitFor(() =>
          expect(screen.queryByTestId("reaction-picker")).toBeNull(),
        );
        expect(view.trigger(target)).toHaveFocus();
        expect(targetReactions(view, target)).toEqual({});
      },
    );

    it("uses captured owner-realm native path, prevention, and focus intrinsics", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers();
      const { options } = await openPicker(view, "Comment");
      const source = options[0]!;
      const destination = options[1]!;
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const event = reactionPickerKeyboardEvent(source, "ArrowRight");
      const publicPath = vi.fn(() => []);
      const publicPrevent = vi.fn();
      const publicFocus = vi.fn();
      Object.defineProperties(event, {
        composedPath: { configurable: true, value: publicPath },
        preventDefault: { configurable: true, value: publicPrevent },
      });
      Object.defineProperty(destination, "focus", {
        configurable: true,
        value: publicFocus,
      });

      act(() => source.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(publicPath).not.toHaveBeenCalled();
      expect(publicPrevent).not.toHaveBeenCalled();
      expect(publicFocus).not.toHaveBeenCalled();
    });

    it("authenticates exact group/option capture and bubble wrappers around the backing Window receiver", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const view = await mountPickers();
      const { options } = await openPicker(view, "Comment");
      const source = options[0]!;
      const destination = options[1]!;
      const group = source.parentElement;
      const ownerWindow = source.ownerDocument.defaultView;
      if (!(group instanceof HTMLDivElement) || !ownerWindow) {
        throw new Error("The reaction keyboard boundary did not mount");
      }
      const groupCapture = reactProperty<
        (event: ReactKeyboardEvent<HTMLDivElement>) => void
      >(group, "onKeyDownCapture");
      const optionCapture = reactProperty<ReactionPickerKeyHandler>(
        source,
        "onKeyDownCapture",
      );
      const optionBubble = reactProperty<ReactionPickerKeyHandler>(
        source,
        "onKeyDown",
      );
      const groupBubble = reactProperty<
        (event: ReactKeyboardEvent<HTMLDivElement>) => void
      >(group, "onKeyDown");
      const boundaries: {
        name: string;
        wrapper: object;
        isDefaultPrevented: () => boolean;
        isPropagationStopped: () => boolean;
        defaultPrevented: boolean;
        propagationStopped: boolean;
      }[] = [];
      const record = (
        name: string,
        event: ReactKeyboardEvent<HTMLElement>,
      ) => {
        boundaries.push({
          name,
          wrapper: event,
          isDefaultPrevented: event.isDefaultPrevented,
          isPropagationStopped: event.isPropagationStopped,
          defaultPrevented: event.isDefaultPrevented(),
          propagationStopped: event.isPropagationStopped(),
        });
      };
      const restoreGroup = replaceReactProperties(group, {
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          record("group capture", event);
          groupCapture(event);
        },
        onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
          record("group bubble", event);
          groupBubble(event);
        },
      });
      const restoreOption = replaceReactProperties(source, {
        onKeyDownCapture: (
          event: ReactKeyboardEvent<HTMLButtonElement>,
        ) => {
          record("option capture", event);
          optionCapture(event);
        },
        onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          record("option bubble", event);
          optionBubble(event);
        },
      });
      const nativeEvent = reactionPickerKeyboardEvent(
        source,
        "ArrowRight",
      );
      const currentTargetGetter = Object.getOwnPropertyDescriptor(
        ownerWindow.Event.prototype,
        "currentTarget",
      )?.get;
      const composedPath = ownerWindow.Event.prototype.composedPath;
      if (!currentTargetGetter) {
        throw new Error("Event.currentTarget has no intrinsic getter");
      }
      const nativeDelivery: {
        receiver?: EventTarget;
        currentTarget?: EventTarget | null;
        terminal?: EventTarget;
      } = {};
      const observeNativeReceiver = function (
        this: EventTarget,
        event: Event,
      ) {
        if (event !== nativeEvent) return;
        nativeDelivery.receiver = this;
        nativeDelivery.currentTarget = Reflect.apply(
          currentTargetGetter,
          event,
          [],
        ) as EventTarget | null;
        nativeDelivery.terminal = Reflect.apply(
          composedPath,
          event,
          [],
        ).at(-1);
      };
      ownerWindow.addEventListener(
        "keydown",
        observeNativeReceiver,
        true,
      );
      source.focus();
      focus.mockClear();

      try {
        act(() => source.dispatchEvent(nativeEvent));
      } finally {
        ownerWindow.removeEventListener(
          "keydown",
          observeNativeReceiver,
          true,
        );
        restoreOption();
        restoreGroup();
      }

      expect(boundaries.map(({ name }) => name)).toEqual([
        "group capture",
        "option capture",
        "option bubble",
        "group bubble",
      ]);
      expect(boundaries[0]!.wrapper).toBe(boundaries[1]!.wrapper);
      expect(boundaries[2]!.wrapper).toBe(boundaries[3]!.wrapper);
      expect(boundaries[0]!.wrapper).not.toBe(boundaries[2]!.wrapper);
      expect(boundaries[0]!.isDefaultPrevented).toBe(
        boundaries[1]!.isDefaultPrevented,
      );
      expect(boundaries[0]!.isPropagationStopped).toBe(
        boundaries[1]!.isPropagationStopped,
      );
      expect(boundaries[2]!.isDefaultPrevented).toBe(
        boundaries[3]!.isDefaultPrevented,
      );
      expect(boundaries[2]!.isPropagationStopped).toBe(
        boundaries[3]!.isPropagationStopped,
      );
      expect(
        boundaries.every(
          ({ defaultPrevented, propagationStopped }) =>
            defaultPrevented === false && propagationStopped === false,
        ),
      ).toBe(true);
      expect(nativeDelivery.receiver).toBe(nativeDelivery.currentTarget);
      expect(nativeDelivery.receiver).toBe(nativeDelivery.terminal);
      expect(nativeEvent.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(targetReactions(view, "Comment")).toEqual({});
    });

    it.each([
      ["Comment", "capture", "present"],
      ["Comment", "capture", "absent"],
      ["Comment", "capture", "mutated"],
      ["Comment", "bubble", "present"],
      ["Comment", "bubble", "absent"],
      ["Comment", "bubble", "mutated"],
      ["Reply", "capture", "present"],
      ["Reply", "capture", "absent"],
      ["Reply", "capture", "mutated"],
      ["Reply", "bubble", "present"],
      ["Reply", "bubble", "absent"],
      ["Reply", "bubble", "mutated"],
    ] as const)(
      "ignores a %s picker private React name on its real %s wrapper when %s",
      async (target, phase, state) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        const { options } = await openPicker(view, target);
        const source = options[0]!;
        const destination = options[1]!;
        const group = source.parentElement;
        if (!(group instanceof HTMLDivElement)) {
          throw new Error("The reaction keyboard group did not mount");
        }
        const property =
          phase === "capture" ? "onKeyDownCapture" : "onKeyDown";
        const element = phase === "capture" ? group : source;
        const handler = reactProperty<
          (event: ReactKeyboardEvent<HTMLElement>) => void
        >(element, property);
        const restore = replaceReactProperties(element, {
          [property]: (event: ReactKeyboardEvent<HTMLElement>) => {
            const wrapper = event as ReactKeyboardEvent<HTMLElement> & {
              _reactName?: unknown;
            };
            if (state === "absent") {
              expect(Reflect.deleteProperty(wrapper, "_reactName")).toBe(true);
              expect("_reactName" in wrapper).toBe(false);
            } else {
              wrapper._reactName =
                state === "present" ? "onKeyDown" : "irrelevant-private-name";
              expect(wrapper._reactName).toBe(
                state === "present" ? "onKeyDown" : "irrelevant-private-name",
              );
            }
            handler(event);
          },
        });
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        try {
          const accepted = reactionPickerKey(source, "ArrowRight");
          expect(accepted.defaultPrevented).toBe(true);
        } finally {
          restore();
        }

        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(targetReactions(view, target)).toEqual({});
      },
    );

    it("rejects a structural Window terminal while retaining exact backing-receiver recovery", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers();
      const { options } = await openPicker(view, "Comment");
      const source = options[0]!;
      const ownerWindow = source.ownerDocument.defaultView;
      if (!ownerWindow) throw new Error("The reaction option has no owner window");
      const structural = Object.create(
        ownerWindow.Window.prototype,
      ) as EventTarget;
      Object.defineProperties(structural, {
        document: { value: source.ownerDocument },
        Window: { value: ownerWindow.Window },
        Event: { value: ownerWindow.Event },
        EventTarget: { value: ownerWindow.EventTarget },
        KeyboardEvent: { value: ownerWindow.KeyboardEvent },
        Node: { value: ownerWindow.Node },
        Object: { value: ownerWindow.Object },
        Reflect: { value: ownerWindow.Reflect },
        UIEvent: { value: ownerWindow.UIEvent },
        window: { value: structural },
        self: { value: structural },
      });
      const rejected = reactionPickerKeyboardEvent(
        source,
        "ArrowRight",
      );
      const currentTargetGetter = Object.getOwnPropertyDescriptor(
        ownerWindow.Event.prototype,
        "currentTarget",
      )?.get;
      const composedPath = ownerWindow.Event.prototype.composedPath;
      if (!currentTargetGetter) {
        throw new Error("Event.currentTarget has no intrinsic getter");
      }
      const listenerObservation: {
        receiver?: EventTarget;
        currentTarget?: EventTarget | null;
        originalPathTerminal?: EventTarget;
      } = {};
      const stageStructuralTerminal = function (
        this: EventTarget,
        event: Event,
      ) {
        if (event !== rejected) return;
        listenerObservation.receiver = this;
        listenerObservation.currentTarget = Reflect.apply(
          currentTargetGetter,
          event,
          [],
        ) as EventTarget | null;
        listenerObservation.originalPathTerminal = Reflect.apply(
          composedPath,
          event,
          [],
        ).at(-1);
        replaceReactionPickerPathTerminal(event, structural);
      };
      ownerWindow.addEventListener(
        "keydown",
        stageStructuralTerminal,
        true,
      );
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();

      try {
        act(() => source.dispatchEvent(rejected));
      } finally {
        ownerWindow.removeEventListener(
          "keydown",
          stageStructuralTerminal,
          true,
        );
      }

      expect(listenerObservation.receiver).toBe(
        listenerObservation.currentTarget,
      );
      expect(listenerObservation.receiver).toBe(
        listenerObservation.originalPathTerminal,
      );
      expect(listenerObservation.receiver).not.toBe(structural);
      expect(rejected.defaultPrevented).toBe(false);
      expect(source).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(targetReactions(view, "Comment")).toEqual({});

      const accepted = reactionPickerKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(options[1]).toHaveFocus();
    });

    it.each([
      ["capture", "isDefaultPrevented"],
      ["capture", "isPropagationStopped"],
      ["bubble", "isDefaultPrevented"],
      ["bubble", "isPropagationStopped"],
    ] as const)(
      "rejects a replaced %s wrapper %s method before a clean successor",
      async (phase, method) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        const { options } = await openPicker(view, "Comment");
        const source = options[0]!;
        const property =
          phase === "capture" ? "onKeyDownCapture" : "onKeyDown";
        const handler = reactProperty<ReactionPickerKeyHandler>(
          source,
          property,
        );
        const restore = replaceReactProperties(source, {
          [property]: (
            event: ReactKeyboardEvent<HTMLButtonElement>,
          ) => {
            handler(event);
            Object.defineProperty(event, method, {
              configurable: true,
              value: () => false,
            });
          },
        });
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = reactionPickerKey(source, "ArrowRight");
        restore();

        expect(rejected.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(targetReactions(view, "Comment")).toEqual({});

        const accepted = reactionPickerKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options[1]).toHaveFocus();
      },
    );

    it.each([
      ["Alt-modified", { altKey: true }],
      ["Control-modified", { ctrlKey: true }],
      ["Meta-modified", { metaKey: true }],
      ["Shift-modified", { shiftKey: true }],
      ["repeating", { repeat: true }],
      ["composing", { isComposing: true }],
      ["non-bubbling", { bubbles: false }],
      ["non-cancelable", { cancelable: false }],
    ] as const)(
      "rejects a %s picker key before a clean successor",
      async (_label, init) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        const { options } = await openPicker(view, "Comment");
        const source = options[0]!;
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = reactionPickerKey(source, "ArrowRight", init);

        expect(rejected.defaultPrevented).toBe(false);
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(targetReactions(view, "Comment")).toEqual({});

        const accepted = reactionPickerKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options[1]).toHaveFocus();
      },
    );

    it.each(["prevented", "propagation-stopped"] as const)(
      "rejects a previously %s picker key without poisoning the publication",
      async (state) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountPickers();
        const { options } = await openPicker(view, "Comment");
        const source = options[0]!;
        source.focus();
        focus.mockClear();
        const rejected = reactionPickerKeyboardEvent(source, "ArrowRight");
        if (state === "prevented") rejected.preventDefault();
        else rejected.stopPropagation();

        act(() => source.dispatchEvent(rejected));

        expect(rejected.defaultPrevented).toBe(state === "prevented");
        expect(source).toHaveFocus();
        expect(focus).not.toHaveBeenCalled();
        const accepted = reactionPickerKey(source, "ArrowRight");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options[1]).toHaveFocus();
      },
    );

    it("rejects untrusted, fabricated, proxied, foreign, and wrong-focus input", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers();
      const { options, picker } = await openPicker(view, "Comment");
      const source = options[0]!;
      const handler = reactionPickerHandler(source);
      source.focus();
      focus.mockClear();
      preventDefault.mockClear();
      const untrusted = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      const nativeForFabrication = reactionPickerKeyboardEvent(
        source,
        "ArrowRight",
      );
      const fabricated = {
        type: "keydown",
        currentTarget: source,
        target: source,
        nativeEvent: nativeForFabrication,
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const foreignWindow = frame.contentDocument?.defaultView;
      if (!foreignWindow) throw new Error("The foreign picker realm did not mount");
      const foreign = new foreignWindow.KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      markRequestModeEventTrusted(foreign);

      act(() => {
        source.dispatchEvent(untrusted);
        handler(fabricated);
        source.dispatchEvent(foreign);
      });

      const restore = replaceReactProperties(source, {
        onKeyDownCapture: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
          handler(new Proxy(event, {})),
      });
      const proxied = reactionPickerKey(source, "ArrowRight");
      restore();
      picker.focus();
      focus.mockClear();
      const wrongFocus = reactionPickerKey(source, "ArrowRight");

      expect(untrusted.defaultPrevented).toBe(false);
      expect(nativeForFabrication.defaultPrevented).toBe(false);
      expect(foreign.defaultPrevented).toBe(false);
      expect(proxied.defaultPrevented).toBe(false);
      expect(wrongFocus.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(targetReactions(view, "Comment")).toEqual({});
      source.focus();
      focus.mockClear();
      const accepted = reactionPickerKey(source, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(options[1]).toHaveFocus();
      frame.remove();
    });

    it("rejects stale reaction/callback authority and accepts the current handler", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers();
      let opened = await openPicker(view, "Comment");
      const staleHandler = reactionPickerHandler(opened.options[0]!);
      act(() => {
        view.session.comments.toggleReaction(
          view.threadId,
          null,
          "👍",
          view.session.user,
        );
      });
      await waitFor(() =>
        expect(screen.getByLabelText("React with 👍")).toHaveAttribute(
          "data-mine",
          "true",
        ),
      );
      opened = {
        ...opened,
        options: screen.getAllByTestId(
          "reaction-option",
        ) as HTMLButtonElement[],
      };
      const current = opened.options[0]!;
      const restore = replaceReactProperties(current, {
        onKeyDownCapture: staleHandler,
      });
      current.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = reactionPickerKey(current, "ArrowRight");
      restore();

      expect(rejected.defaultPrevented).toBe(false);
      expect(current).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      const accepted = reactionPickerKey(current, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(opened.options[1]).toHaveFocus();
      expect(targetReactions(view, "Comment")["👍"]).toEqual([
        view.session.user.id,
      ]);
    });

    it("retires changed permission facts until a complete clean render", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers();
      const { options } = await openPicker(view, "Comment");
      const source = options[0]!;
      source.focus();
      (view.session as unknown as { role: string }).role = "viewer";
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = reactionPickerKey(source, "ArrowRight");

      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      (view.session as unknown as { role: string }).role = "owner";
      act(() => {
        view.session.comments.editBody(view.threadId, "Permission successor.");
      });
      await screen.findByText("Permission successor.");
      const current = screen.getAllByTestId(
        "reaction-option",
      ) as HTMLButtonElement[];
      current[0]!.focus();
      focus.mockClear();
      const accepted = reactionPickerKey(current[0]!, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(current[1]).toHaveFocus();
    });

    it("does no picker work while its exact target is busy and recovers afterward", async () => {
      const pending = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(pending.promise);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const view = await mountPickers({ role: "commenter", withReaction: true });
      const { options } = await openPicker(view, "Reply");
      const staleSource = options[0]!;
      fireEvent.click(
        within(view.row("Reply")).getByTestId("reaction-chip"),
      );
      await waitFor(() => expect(staleSource).toBeDisabled());
      staleSource.focus();
      focus.mockClear();
      preventDefault.mockClear();

      const rejected = reactionPickerKey(staleSource, "ArrowRight");

      expect(rejected.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve({} as CommentResponse));
      await waitFor(() => expect(staleSource).toBeEnabled());
      staleSource.focus();
      focus.mockClear();
      const accepted = reactionPickerKey(staleSource, "ArrowRight");
      expect(accepted.defaultPrevented).toBe(true);
      expect(options[1]).toHaveFocus();
    });

    it.each([
      "detached and reinserted portal",
      "detached and reinserted group",
      "reordered and restored options",
      "replaced and restored option",
      "attribute-mutated and restored option",
    ] as const)(
      "retains %s history and permits a clean reopened picker",
      async (mutation) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountPickers();
        let opened = await openPicker(view, "Comment");
        const source = opened.options[0]!;
        if (mutation === "detached and reinserted portal") {
          const parent = opened.picker.parentNode!;
          const next = opened.picker.nextSibling;
          opened.picker.remove();
          parent.insertBefore(opened.picker, next);
        } else if (mutation === "detached and reinserted group") {
          const group = source.parentElement!;
          const parent = group.parentNode!;
          const next = group.nextSibling;
          group.remove();
          parent.insertBefore(group, next);
        } else if (mutation === "reordered and restored options") {
          const group = source.parentElement!;
          const second = opened.options[1]!;
          group.append(source);
          group.insertBefore(source, second);
        } else if (mutation === "replaced and restored option") {
          const replacement = source.cloneNode(true);
          if (!(replacement instanceof HTMLButtonElement)) {
            throw new Error("The replacement reaction option was not a button");
          }
          source.replaceWith(replacement);
          replacement.replaceWith(source);
        } else {
          source.setAttribute("data-mine", "true");
          source.removeAttribute("data-mine");
        }
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = reactionPickerKey(source, "ArrowRight");

        expect(rejected.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        expect(targetReactions(view, "Comment")).toEqual({});

        fireEvent.keyDown(source, { key: "Escape" });
        await waitFor(() =>
          expect(screen.queryByTestId("reaction-picker")).toBeNull(),
        );
        opened = await openPicker(view, "Comment");
        opened.options[0]!.focus();
        focus.mockClear();
        const accepted = reactionPickerKey(
          opened.options[0]!,
          "ArrowRight",
        );
        expect(accepted.defaultPrevented).toBe(true);
        expect(opened.options[1]).toHaveFocus();
      },
    );

    it("claims publication, movement, wrapper, native event, and destination before replay or prevention reentry", async () => {
      const nativePreventDefault = Event.prototype.preventDefault;
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const view = await mountPickers();
      const { options } = await openPicker(view, "Comment");
      const source = options[0]!;
      source.focus();
      focus.mockClear();
      let reentered: KeyboardEvent | null = null;
      preventDefault.mockImplementation(function (this: Event) {
        if (this instanceof KeyboardEvent && !reentered) {
          reentered = reactionPickerKeyboardEvent(source, "ArrowRight");
          source.dispatchEvent(reentered);
        }
        return nativePreventDefault.call(this);
      });
      preventDefault.mockClear();
      const event = reactionPickerKeyboardEvent(source, "ArrowRight");

      act(() => {
        source.dispatchEvent(event);
        source.dispatchEvent(event);
        options[1]!.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
      expect(reentered).not.toBeNull();
      expect(reentered!.defaultPrevented).toBe(false);
      expect(options[1]).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledOnce();
      expect(targetReactions(view, "Comment")).toEqual({});
    });

    it("rejects cleanup input and lets a distinct complete Strict Mode picker recover", async () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const stale = await mountPickers();
      const opened = await openPicker(stale, "Comment");
      const source = opened.options[0]!;
      const handler = reactionPickerHandler(source);
      act(() => stale.root.unmount());
      directViews.splice(
        directViews.findIndex((view) => view.root === stale.root),
        1,
      );
      stale.host.remove();
      const nativeEvent = reactionPickerKeyboardEvent(source, "ArrowRight");
      focus.mockClear();
      preventDefault.mockClear();

      handler({
        type: "keydown",
        currentTarget: source,
        target: source,
        nativeEvent,
      } as unknown as ReactKeyboardEvent<HTMLButtonElement>);

      expect(nativeEvent.defaultPrevented).toBe(false);
      expect(focus).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();

      const clean = await mountPickers();
      const successor = await openPicker(clean, "Reply");
      successor.options[0]!.focus();
      focus.mockClear();
      const accepted = reactionPickerKey(
        successor.options[0]!,
        "ArrowRight",
      );
      expect(accepted.defaultPrevented).toBe(true);
      expect(successor.options[1]).toHaveFocus();
    });
  });

  describe("bulk review action ownership", () => {
    interface BatchFixture {
      session: CollabSession;
      user: ReturnType<typeof makeCollabUser>;
      threadIds: string[];
    }

    const response = {} as CommentResponse;
    const words = ["Alpha", "beta", "gamma", "delta"];

    const makeBatchSession = (docId: string, count = 2, source?: CollabSession, suggestions = true): BatchFixture => {
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const next = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      if (source) {
        Y.applyUpdate(next.ydoc, Y.encodeStateAsUpdate(source.ydoc));
      } else {
        const text = "Alpha beta gamma delta.";
        next.ytext.insert(0, text);
        const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
        for (const [index, word] of words.slice(0, count).entries()) {
          next.comments.add({
            from: text.indexOf(word),
            to: text.indexOf(word) + word.length,
            body: suggestions ? `Finding ${index + 1}.\n\n\`\`\`suggestion\n${word.toUpperCase()}\n\`\`\`` : `Finding ${index + 1}.`,
            author: agent,
          });
        }
      }
      vi.spyOn(next, "commentsViaApi", "get").mockReturnValue(true);
      session = next;
      return { session: next, user, threadIds: next.comments.list().map((thread) => thread.id) };
    };

    const addLocalBatchSuggestion = (fixture: BatchFixture, word = "delta") => {
      const text = fixture.session.ytext.toString();
      const from = text.indexOf(word);
      const agent = makeCollabUser("agent:alice:Local", "Local");
      fixture.session.suggestions.proposeEdits(
        [{ from, to: from + word.length, insert: word.toUpperCase() }],
        agent,
      );
    };

    const batchPanel = (current: CollabSession, onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>(), onClose = () => {}) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={onClose} onReveal={() => {}} onToast={onToast} />
      </TooltipProvider>
    );
    const reviewCard = (reviewId: string) => document.querySelector<HTMLElement>(`[data-testid="review-card"][data-review-id="${reviewId}"]`)!;
    const reviewControl = (reviewId: string, testId: string) => within(reviewCard(reviewId)).getByTestId(testId);
    const threadCard = (threadId: string) => document.querySelector<HTMLElement>(`[data-testid="comment-thread"][data-thread-id="${threadId}"]`)!;
    const settleBatch = async (request: ReturnType<typeof deferred<CommentResponse>>, outcome: "resolve" | "reject", reason = "request failed") => {
      await act(async () => {
        if (outcome === "resolve") request.resolve(response);
        else request.reject(new Error(reason));
        await request.promise.catch(() => {});
      });
    };

    beforeEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue(response);
      vi.mocked(api.documents.reviews).mockReset().mockResolvedValue({ reviews: [] } as ReviewsResponse);
    });

    afterEach(() => {
      vi.mocked(api.documents.comment).mockReset().mockResolvedValue({ id: "via-api" } as never);
      vi.mocked(api.documents.reviews).mockReset().mockResolvedValue({ reviews: [] } as ReviewsResponse);
    });

    it.each(["accept", "reject"] as const)("gives the first immediate review %s activation one frozen ordered batch", async (action) => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession(`review-${action}`);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const primary = await screen.findByTestId(`review-${action}-all`);
      const mixed = screen.getByTestId(`review-${action === "accept" ? "reject" : "accept"}-all`);

      act(() => {
        primary.click();
        primary.click();
        mixed.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenLastCalledWith(fixture.session.docId, {
        action: "suggestion",
        threadId: fixture.threadIds[0],
        replyId: undefined,
        decision: action,
      });
      expect(primary).toBeDisabled();
      expect(mixed).toBeDisabled();
      expect(primary).toHaveTextContent(action === "accept" ? "Accepting…" : "Rejecting…");
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve")).toBeDisabled();
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-batch-pending")).toHaveTextContent(
        action === "accept" ? "Accepting suggestion…" : "Rejecting suggestion…",
      );

      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(api.documents.comment).toHaveBeenLastCalledWith(fixture.session.docId, {
        action: "suggestion",
        threadId: fixture.threadIds[1],
        replyId: undefined,
        decision: action,
      });
      await settleBatch(requests[1], "resolve");

      expect(vi.mocked(api.documents.comment).mock.calls.map(([, payload]) => payload.threadId)).toEqual(fixture.threadIds);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith(`${action === "accept" ? "Accepted" : "Rejected"} 2 suggestions from Copilot.`, "success");
    });

    it("gives immediate duplicate Resolve all activation one owner and one current summary", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession("review-resolve", 2, undefined, false);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const control = await screen.findByTestId("review-resolve-all");

      act(() => {
        control.click();
        control.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith("review-resolve", {
        action: "resolve",
        threadId: fixture.threadIds[0],
        resolved: true,
      });
      expect(control).toBeDisabled();
      expect(control).toHaveTextContent("Resolving…");
      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      await settleBatch(requests[1], "resolve");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Resolved 2 comments from Copilot.", "success");
    });

    it.each(["accept", "reject"] as const)("owns Suggestions-tab %s all before immediate duplicate or mixed activation", async (action) => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
      const fixture = makeBatchSession(`suggestions-${action}`);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(screen.getByRole("tab", { name: /Suggestions/ }));
      const primary = screen.getByTestId(`${action}-all`);
      const mixed = screen.getByTestId(`${action === "accept" ? "reject" : "accept"}-all`);

      act(() => {
        primary.click();
        primary.click();
        mixed.click();
      });

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(primary).toBeDisabled();
      expect(mixed).toBeDisabled();
      expect(primary).toHaveTextContent(action === "accept" ? "Accepting…" : "Rejecting…");
      await settleBatch(requests[0], "resolve");
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      await settleBatch(requests[1], "resolve");
      expect(vi.mocked(api.documents.comment).mock.calls).toEqual(
        fixture.threadIds.map((threadId) => [
          fixture.session.docId,
          { action: "suggestion", threadId, replyId: undefined, decision: action },
        ]),
      );
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith(`${action === "accept" ? "Accepted" : "Rejected"} 2 suggestions.`, "success");
    });

    it.each([
      ["accept", "local", 0, true],
      ["reject", "local", 0, true],
      ["accept", "comments", 2, false],
      ["reject", "comments", 2, false],
      ["accept", "mixed", 1, true],
      ["reject", "mixed", 1, true],
    ] as const)(
      "publishes one exact direct-root Strict Mode %s batch for %s targets",
      async (action, source, commentCount, withLocal) => {
        const fixture = makeBatchSession(`strict-suggestions-${action}-${source}`, commentCount);
        if (withLocal) addLocalBatchSuggestion(fixture);
        const reviewLocal = vi.spyOn(fixture.session, "reviewSuggestion");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
          await act(async () => {
            root.render(<StrictMode>{batchPanel(fixture.session)}</StrictMode>);
          });
          const tab = await within(host).findByRole("tab", { name: /Suggestions/ });
          if (tab.getAttribute("aria-selected") !== "true") {
            await act(async () => {
              dispatchReviewClick(tab);
            });
          }
          const actions = captureSuggestionBatchActions(host);
          const control = action === "accept" ? actions.accept : actions.reject;
          if (!control) throw new Error(`${action} all was not published`);

          await act(async () => {
            dispatchReviewClick(control.element);
            await Promise.resolve();
          });

          if (withLocal) {
            expect(reviewLocal).toHaveBeenCalledExactlyOnceWith(action === "accept" ? "acceptAll" : "rejectAll");
          } else {
            expect(reviewLocal).not.toHaveBeenCalled();
          }
          await waitFor(() => expect(api.documents.comment).toHaveBeenCalledTimes(commentCount));
          expect(vi.mocked(api.documents.comment).mock.calls.map(([, payload]) => payload.threadId)).toEqual(fixture.threadIds);
        } finally {
          act(() => root.unmount());
          host.remove();
        }
      },
    );

    it("keeps a successor batch owned when the retired session settles late", async () => {
      const retiredRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(retiredRequest.promise)
        .mockReturnValueOnce(currentRequest.promise);
      const retired = makeBatchSession("suggestions-retired-session", 1);
      const retiredToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const currentToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(<StrictMode>{batchPanel(retired.session, retiredToast)}</StrictMode>);
        });
        await act(async () => {
          dispatchReviewClick(await within(host).findByRole("tab", { name: /Suggestions/ }));
        });
        act(() => dispatchReviewClick(captureSuggestionBatchActions(host).reject!.element));
        expect(api.documents.comment).toHaveBeenCalledOnce();

        auxiliarySessions.push(retired.session);
        const current = makeBatchSession("suggestions-current-session", 1, retired.session);
        await act(async () => {
          root.render(<StrictMode>{batchPanel(current.session, currentToast)}</StrictMode>);
        });
        act(() => dispatchReviewClick(captureSuggestionBatchActions(host).reject!.element));
        expect(api.documents.comment).toHaveBeenCalledTimes(2);

        await settleBatch(retiredRequest, "reject", "retired failure");
        expect(captureSuggestionBatchActions(host).reject?.element).toBeDisabled();
        expect(retiredToast).not.toHaveBeenCalled();
        expect(currentToast).not.toHaveBeenCalled();
        await settleBatch(currentRequest, "resolve");
        expect(currentToast).toHaveBeenCalledOnce();
        expect(retiredToast).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it.each(["reorder", "remove", "outdated"] as const)(
      "rejects a %s target drift without poisoning the restored batch",
      async (drift) => {
        const fixture = makeBatchSession(`suggestions-target-${drift}`, 0);
        addLocalBatchSuggestion(fixture, "gamma");
        addLocalBatchSuggestion(fixture, "delta");
        const reviewLocal = vi.spyOn(fixture.session, "reviewSuggestion");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
          await act(async () => {
            root.render(<StrictMode>{batchPanel(fixture.session)}</StrictMode>);
          });
          const stale = captureSuggestionBatchActions(host).reject!;
          const groups = fixture.session.suggestions.groups.bind(fixture.session.suggestions);
          const drifted = vi.spyOn(fixture.session.suggestions, "groups").mockImplementation((sourceText) => {
            const current = groups(sourceText);
            if (drift === "reorder") return [...current].reverse();
            if (drift === "remove") return current.slice(1);
            return current.map((group) => ({ ...group, outdated: true }));
          });

          act(() => dispatchReviewClick(stale.element));
          expect(reviewLocal).not.toHaveBeenCalled();
          drifted.mockRestore();
          await act(async () => {
            root.render(<StrictMode>{batchPanel(fixture.session)}</StrictMode>);
          });
          const current = captureSuggestionBatchActions(host).reject!;
          act(() => dispatchReviewClick(current.element));
          expect(reviewLocal).toHaveBeenCalledExactlyOnceWith("rejectAll");
        } finally {
          act(() => root.unmount());
          host.remove();
        }
      },
    );

    it("rejects a new local target introduced after the batch owner is claimed", async () => {
      const fixture = makeBatchSession("suggestions-target-added-after-claim", 0);
      addLocalBatchSuggestion(fixture, "gamma");
      const reviewLocal = vi.spyOn(fixture.session, "reviewSuggestion");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(<StrictMode>{batchPanel(fixture.session)}</StrictMode>);
        });
        const stale = captureSuggestionBatchActions(host).reject!;
        const intrinsicSet = Map.prototype.set;
        let introduced = false;
        Map.prototype.set = function (key, value) {
          const result = Reflect.apply(intrinsicSet, this, [key, value]);
          const owner = value as { action?: unknown };
          if (!introduced && key === "suggestions" && owner.action === "suggestions-reject") {
            introduced = true;
            addLocalBatchSuggestion(fixture, "delta");
          }
          return result;
        };
        try {
          act(() => dispatchReviewClick(stale.element));
        } finally {
          Map.prototype.set = intrinsicSet;
        }

        expect(introduced).toBe(true);
        expect(reviewLocal).not.toHaveBeenCalled();
        expect(fixture.session.suggestions.groups()).toHaveLength(2);

        await act(async () => {});
        const current = captureSuggestionBatchActions(host).reject!;
        act(() => dispatchReviewClick(current.element));
        expect(reviewLocal).toHaveBeenCalledExactlyOnceWith("rejectAll");
        expect(fixture.session.suggestions.groups()).toHaveLength(0);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it("keeps local target scans bounded for a large published batch and one activation", async () => {
      const created = reviewSession("suggestions-linear-snapshot");
      session = created.session;
      const sourceWords = Array.from({ length: 120 }, (_, index) => `word${index}`);
      const sourceText = sourceWords.join(" ");
      session.ytext.insert(0, sourceText);
      const agent = makeCollabUser("agent:alice:Linear", "Linear");
      let from = 0;
      session.suggestions.proposeEdits(
        sourceWords.map((word) => {
          const edit = { from, to: from + word.length, insert: word.toUpperCase() };
          from += word.length + 1;
          return edit;
        }),
        agent,
      );
      session.undoManager.clear();
      const groups = vi.spyOn(session.suggestions, "groups");
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => {
          root.render(<StrictMode>{batchPanel(session!)}</StrictMode>);
        });
        const renderScans = groups.mock.calls.length;
        groups.mockClear();

        act(() => dispatchReviewClick(captureSuggestionBatchActions(host).reject!.element));
        const activationScans = groups.mock.calls.length;

        expect(renderScans).toBeLessThan(30);
        expect(activationScans).toBeLessThan(30);
        expect(session.suggestions.groups()).toHaveLength(0);
        expect(session.undoManager.undoStack).toHaveLength(1);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it("ignores a batch click after permission is lost and uses the current toast callback after a re-render", async () => {
      const fixture = makeBatchSession("suggestions-permission-callback", 1);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const firstToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const secondToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      try {
        await act(async () => {
          root.render(<StrictMode>{batchPanel(fixture.session, firstToast)}</StrictMode>);
        });
        await act(async () => {
          dispatchReviewClick(await within(host).findByRole("tab", { name: /Suggestions/ }));
        });
        const permissionStale = captureSuggestionBatchActions(host).accept!;
        (fixture.session as unknown as { role: string }).role = "viewer";
        act(() => dispatchReviewClick(permissionStale.element));
        expect(api.documents.comment).not.toHaveBeenCalled();
        (fixture.session as unknown as { role: string }).role = "owner";

        await act(async () => {
          root.render(<StrictMode>{batchPanel(fixture.session, secondToast)}</StrictMode>);
        });
        const current = captureSuggestionBatchActions(host).accept!;
        act(() => dispatchReviewClick(current.element));
        expect(api.documents.comment).toHaveBeenCalledOnce();
        await waitFor(() => expect(secondToast).toHaveBeenCalledOnce());
        expect(firstToast).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it("keeps local Suggestions-tab bulk review in one text-and-annotation undo step", async () => {
      const created = reviewSession("local-suggestion-batch");
      session = created.session;
      const original = "Alpha beta gamma.";
      session.ytext.insert(0, original);
      const agent = makeCollabUser("agent:alice:Copilot", "Copilot");
      session.suggestions.proposeEdits(
        [
          { from: 0, to: 5, insert: "ALPHA" },
          { from: 6, to: 10, insert: "BETA" },
        ],
        agent,
      );
      session.undoManager.clear();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(session, onToast));
      fireEvent.click(screen.getByRole("tab", { name: /Suggestions/ }));
      fireEvent.click(screen.getByTestId("accept-all"));

      await waitFor(() => expect(screen.queryByTestId("suggestion-card")).toBeNull());
      expect(session.ytext.toString()).toBe("ALPHA BETA gamma.");
      expect(session.undoManager.undoStack).toHaveLength(1);
      act(() => session!.undo());
      expect(session.suggestions.groups(session.ytext.toString())).toHaveLength(2);
      expect(session.suggestions.cleanText()).toBe(original);
      expect(onToast).toHaveBeenCalledOnce();
      expect(onToast).toHaveBeenCalledWith("Accepted 2 suggestions.", "success");
    });

    it("runs two non-overlapping review owners independently while a row owner excludes its review batch", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise);
      const fixture = makeBatchSession("independent-reviews");
      const reviews = [
        reviewDto("r1", [fixture.threadIds[0]], fixture.session.docId),
        reviewDto("r2", [fixture.threadIds[1]], fixture.session.docId),
      ];
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as ReviewsResponse);
      render(batchPanel(fixture.session));
      await waitFor(() => expect(screen.getAllByTestId("review-reject-all")).toHaveLength(2));

      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(reviewControl("r2", "review-reject-all")).toBeEnabled();
      fireEvent.click(reviewControl("r2", "review-reject-all"));
      expect(api.documents.comment).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.documents.comment).mock.calls.map(([, payload]) => payload.threadId)).toEqual(fixture.threadIds);
      await settleBatch(requests[1], "resolve");
      expect(reviewControl("r1", "review-reject-all")).toBeDisabled();
      await settleBatch(requests[0], "resolve");

      fireEvent.click(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve"));
      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      expect(reviewControl("r1", "review-reject-all")).toBeDisabled();
      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(api.documents.comment).toHaveBeenCalledTimes(3);
      await settleBatch(requests[2], "resolve");
      expect(reviewControl("r1", "review-reject-all")).toBeEnabled();
    });

    it("reports exact partial counts, releases the owner, and retries only the failed target", async () => {
      const requests = [deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>(), deferred<CommentResponse>()];
      vi.mocked(api.documents.comment)
        .mockReturnValueOnce(requests[0].promise)
        .mockReturnValueOnce(requests[1].promise)
        .mockReturnValueOnce(requests[2].promise)
        .mockReturnValueOnce(requests[3].promise);
      const fixture = makeBatchSession("partial-retry", 3);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));

      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[0], fixture.user));
      await settleBatch(requests[0], "resolve");
      await settleBatch(requests[1], "reject", "second failed");
      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[2], fixture.user));
      await settleBatch(requests[2], "resolve");

      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenLastCalledWith("Rejected 2 suggestions from Copilot (2 done, 1 failed, 0 outdated skipped).", "error");
      const retry = await screen.findByTestId("review-reject-all");
      expect(retry).toBeEnabled();
      fireEvent.click(retry);
      expect(api.documents.comment).toHaveBeenCalledTimes(4);
      expect(api.documents.comment).toHaveBeenLastCalledWith("partial-retry", {
        action: "suggestion",
        threadId: fixture.threadIds[1],
        replyId: undefined,
        decision: "reject",
      });
      act(() => fixture.session.comments.rejectSuggestion(fixture.threadIds[1], fixture.user));
      await settleBatch(requests[3], "resolve");
      expect(onToast).toHaveBeenCalledTimes(2);
      expect(onToast).toHaveBeenLastCalledWith("Rejected 1 suggestion from Copilot.", "success");
    });

    it("freezes proposed replacement text and dispatches local accepts in captured order", async () => {
      const requests = [deferred<boolean>(), deferred<boolean>()];
      const fixture = makeBatchSession("frozen-proposals");
      vi.spyOn(fixture.session, "commentsViaApi", "get").mockReturnValue(false);
      const accept = vi
        .spyOn(fixture.session, "acceptCommentSuggestion")
        .mockImplementationOnce(() => requests[0].promise as unknown as boolean)
        .mockImplementationOnce(() => requests[1].promise as unknown as boolean);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      render(batchPanel(fixture.session));
      fireEvent.click(await screen.findByTestId("review-accept-all"));

      expect(accept).toHaveBeenCalledTimes(1);
      expect(accept).toHaveBeenLastCalledWith(fixture.threadIds[0], "ALPHA", undefined);
      await act(async () => {
        requests[0].resolve(true);
        await requests[0].promise;
      });
      expect(accept).toHaveBeenCalledTimes(2);
      expect(accept).toHaveBeenLastCalledWith(fixture.threadIds[1], "BETA", undefined);
      await act(async () => {
        requests[1].resolve(true);
        await requests[1].promise;
      });
    });

    it("counts a newly outdated target without dispatching it and publishes one current summary", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("outdated-count");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      const control = await screen.findByTestId("review-accept-all");
      fireEvent.click(control);
      act(() => fixture.session.ytext.insert(7, "!"));
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Accepted 1 suggestion from Copilot (1 done, 0 failed, 1 outdated skipped).", "success");
    });

    it("stops every later dispatch when a captured target is removed mid-loop", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("removed-mid-loop", 3);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      act(() => fixture.session.comments.remove(fixture.threadIds[1]));
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(onToast).toHaveBeenCalledWith("Rejected 1 suggestion from Copilot (1 done, 0 failed, 2 outdated skipped).", "success");
    });

    it("retires a removed review before settlement without dispatching or publishing anything later", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("removed-review");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews)
        .mockResolvedValueOnce({ reviews: [review] } as ReviewsResponse)
        .mockResolvedValueOnce({ reviews: [] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      act(() => fixture.session.comments.add({ from: 0, to: 0, body: "Refresh reviews.", author: fixture.user }));
      await waitFor(() => expect(screen.queryByTestId("review-card")).toBeNull());
      await settleBatch(request, "resolve");

      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(onToast).not.toHaveBeenCalled();
      expect(within(threadCard(fixture.threadIds[0])).getByTestId("comment-resolve")).toBeEnabled();
    });

    it("keeps replacement-session ownership independent when old and new settlements arrive out of order", async () => {
      const oldRequest = deferred<CommentResponse>();
      const currentRequest = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
      const old = makeBatchSession("old-batch-document", 1);
      const reviewFor = (current: CollabSession) => reviewDto("same-review", [current.comments.list()[0].id], current.docId);
      vi.mocked(api.documents.reviews).mockImplementation(async (documentId) => {
        const current = documentId === old.session.docId ? old.session : session!;
        return { reviews: [reviewFor(current)] } as ReviewsResponse;
      });
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const rendered = render(batchPanel(old.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));

      auxiliarySessions.push(old.session);
      const current = makeBatchSession("new-batch-document", 1, old.session);
      rendered.rerender(batchPanel(current.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      expect(vi.mocked(api.documents.comment).mock.calls.map(([documentId]) => documentId)).toEqual(["old-batch-document", "new-batch-document"]);

      await settleBatch(currentRequest, "resolve");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("review-reject-all")).toBeEnabled();
      await settleBatch(oldRequest, "reject", "old failure");
      expect(onToast).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("review-reject-all")).toBeEnabled();
      expect(screen.queryByText(/old failure/i)).toBeNull();
    });

    it("retires on unmount with no later dispatch, toast, or unhandled rejection", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("batch-unmount");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const rendered = render(batchPanel(fixture.session, onToast));
      fireEvent.click(await screen.findByTestId("review-reject-all"));
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        rendered.unmount();
        await settleBatch(request, "reject", "late batch failure");
        await act(async () => {});
        expect(api.documents.comment).toHaveBeenCalledTimes(1);
        expect(onToast).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    describe("real browser click delivery (#2212)", () => {
      const mountCheckpoint = async (panel: ReactNode) => {
        const host = document.createElement("div");
        document.body.append(host);
        const { root, delivered } = createCheckpointRoot(host);
        await act(async () => {
          root.render(<StrictMode>{panel}</StrictMode>);
        });
        return {
          host,
          delivered,
          dispose: () => {
            act(() => root.unmount());
            host.remove();
          },
        };
      };

      it.each([
        { action: "accept", target: "root", activation: "pointer" },
        { action: "accept", target: "root", activation: "Enter" },
        { action: "accept", target: "reply", activation: "Space" },
        { action: "reject", target: "root", activation: "Space" },
        { action: "reject", target: "reply", activation: "pointer" },
        { action: "reject", target: "document", activation: "Enter" },
      ] as const)(
        "decides a $target suggestion with $activation $action once when React sees the click after a microtask checkpoint",
        async ({ action, target, activation }) => {
          const fixture = reviewSession(`checkpoint-${action}-${target}-${activation}`);
          session = fixture.session;
          const { threadId, replyId } = addCommentSuggestion(session, fixture.user, target);
          const accept = vi.spyOn(session, "acceptCommentSuggestion");
          const reject = vi.spyOn(session.comments, target === "reply" ? "rejectReplySuggestion" : "rejectSuggestion");
          const mounted = await mountCheckpoint(suggestionPanel(session));
          try {
            const actions = captureSuggestionActions(mounted.host);
            const control = action === "accept" ? actions.accept : actions.reject;
            if (!control) throw new Error(`The ${action} control was not rendered`);

            await checkpointActivate(control.element, mounted.delivered, activation);

            if (action === "accept") {
              expect(accept).toHaveBeenCalledOnce();
              expect(accept).toHaveBeenCalledWith(threadId, "slow red", replyId ?? undefined);
              expect(reject).not.toHaveBeenCalled();
              expect(session.ytext.toString()).toBe("The slow red fox jumps.");
            } else {
              expect(reject).toHaveBeenCalledOnce();
              expect(reject.mock.calls[0].slice(0, target === "reply" ? 2 : 1)).toEqual(
                target === "reply" ? [threadId, replyId] : [threadId],
              );
              expect(accept).not.toHaveBeenCalled();
              expect(session.ytext.toString()).toBe("The quick brown fox jumps.");
            }
            await waitFor(() => expect(within(mounted.host).queryByTestId("suggestion-actions")).toBeNull());
          } finally {
            mounted.dispose();
          }
        },
      );

      it.each([
        { action: "accept", targets: "comments", activation: "pointer" },
        { action: "reject", targets: "comments", activation: "Enter" },
        { action: "accept", targets: "local", activation: "Space" },
        { action: "reject", targets: "local", activation: "pointer" },
        { action: "accept", targets: "mixed", activation: "Enter" },
        { action: "reject", targets: "mixed", activation: "Space" },
      ] as const)(
        "runs $action all for $targets targets with $activation when React sees the click after a microtask checkpoint",
        async ({ action, targets, activation }) => {
          const commentCount = targets === "local" ? 0 : targets === "mixed" ? 1 : 2;
          const fixture = makeBatchSession(`checkpoint-batch-${action}-${targets}-${activation}`, commentCount);
          if (targets !== "comments") addLocalBatchSuggestion(fixture);
          const reviewLocal = vi.spyOn(fixture.session, "reviewSuggestion");
          const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
          const mounted = await mountCheckpoint(batchPanel(fixture.session, onToast));
          try {
            const tab = within(mounted.host).getByRole("tab", { name: /Suggestions/ });
            if (tab.getAttribute("aria-selected") !== "true") {
              await checkpointActivate(tab, mounted.delivered, "pointer");
            }
            const control = within(mounted.host).getByTestId(`${action}-all`);
            expect(control).toBeEnabled();

            await checkpointActivate(control, mounted.delivered, activation);

            await waitFor(() => expect(onToast).toHaveBeenCalledOnce());
            const total = commentCount + (targets === "comments" ? 0 : 1);
            expect(onToast).toHaveBeenCalledWith(
              `${action === "accept" ? "Accepted" : "Rejected"} ${total} suggestion${total === 1 ? "" : "s"}.`,
              "success",
            );
            if (targets === "comments") expect(reviewLocal).not.toHaveBeenCalled();
            else expect(reviewLocal).toHaveBeenCalledExactlyOnceWith(action === "accept" ? "acceptAll" : "rejectAll");
            expect(vi.mocked(api.documents.comment).mock.calls).toEqual(
              fixture.threadIds.map((threadId) => [
                fixture.session.docId,
                { action: "suggestion", threadId, replyId: undefined, decision: action },
              ]),
            );
            if (targets !== "comments") {
              expect(fixture.session.ytext.toString()).toBe(
                action === "accept" ? "Alpha beta gamma DELTA." : "Alpha beta gamma delta.",
              );
            }
          } finally {
            mounted.dispose();
          }
        },
      );

      it("retires a pending Suggestions-tab batch when Close unmounts the panel, with no late toast or second dispatch", async () => {
        const requests = [deferred<CommentResponse>(), deferred<CommentResponse>()];
        vi.mocked(api.documents.comment).mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);
        const fixture = makeBatchSession("checkpoint-batch-close", 2);
        const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
        function ClosablePanel() {
          const [open, setOpen] = useState(true);
          return open ? batchPanel(fixture.session, onToast, () => setOpen(false)) : <p data-testid="panel-closed" />;
        }
        const unhandled: unknown[] = [];
        const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
        window.addEventListener("unhandledrejection", onUnhandled);
        const mounted = await mountCheckpoint(<ClosablePanel />);
        try {
          const tab = within(mounted.host).getByRole("tab", { name: /Suggestions/ });
          if (tab.getAttribute("aria-selected") !== "true") {
            await checkpointActivate(tab, mounted.delivered, "pointer");
          }
          const rejectAll = within(mounted.host).getByTestId("reject-all");
          await checkpointActivate(rejectAll, mounted.delivered, "pointer");
          expect(api.documents.comment).toHaveBeenCalledOnce();
          expect(rejectAll).toBeDisabled();
          expect(rejectAll).toHaveTextContent("Rejecting…");

          await checkpointActivate(
            within(mounted.host).getByRole("button", { name: "Close comments" }),
            mounted.delivered,
            "pointer",
          );
          expect(within(mounted.host).queryByTestId("comments-panel")).toBeNull();
          expect(within(mounted.host).getByTestId("panel-closed")).toBeInTheDocument();

          await settleBatch(requests[0], "reject", "late batch failure");
          await act(async () => {});

          expect(api.documents.comment).toHaveBeenCalledOnce();
          expect(onToast).not.toHaveBeenCalled();
          expect(unhandled).toEqual([]);
        } finally {
          window.removeEventListener("unhandledrejection", onUnhandled);
          mounted.dispose();
        }
      });
    });

    it("keeps unrelated cards at zero render effects while one review publishes ownership and settlement", async () => {
      const request = deferred<CommentResponse>();
      vi.mocked(api.documents.comment).mockReturnValue(request.promise);
      const fixture = makeBatchSession("batch-render-isolation");
      const reviews = [
        reviewDto("r1", [fixture.threadIds[0]], fixture.session.docId),
        reviewDto("r2", [fixture.threadIds[1]], fixture.session.docId),
      ];
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as ReviewsResponse);
      render(batchPanel(fixture.session));
      await waitFor(() => expect(screen.getAllByTestId("review-reject-all")).toHaveLength(2));
      await act(async () => {});

      vi.mocked(parseSuggestionBlock).mockClear();
      fireEvent.click(reviewControl("r1", "review-reject-all"));
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 1."))).not.toHaveLength(0);
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 2."))).toHaveLength(0);
      await settleBatch(request, "resolve");
      expect(vi.mocked(parseSuggestionBlock).mock.calls.filter(([body]) => body.includes("Finding 2."))).toHaveLength(0);
    });

    it("accepts only a genuine exact owner-document review action event without consuming fabricated sources", async () => {
      const fixture = makeBatchSession("review-event-provenance");
      const reviews = [
        reviewDto("r1", [fixture.threadIds[0]], fixture.session.docId),
        reviewDto("r2", [fixture.threadIds[1]], fixture.session.docId),
      ];
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews } as ReviewsResponse);
      render(batchPanel(fixture.session));
      await waitFor(() => expect(screen.getAllByTestId("review-accept-all")).toHaveLength(2));
      const accept = captureReviewControl(reviewControl("r1", "review-accept-all"));
      const reject = captureReviewControl(reviewControl("r1", "review-reject-all"));
      const sibling = captureReviewControl(reviewControl("r2", "review-accept-all"));
      const foreign = document.createElement("button");
      const foreignChild = document.createElement("span");
      foreign.append(foreignChild);
      document.body.append(foreign);
      const otherDocument = document.implementation.createHTMLDocument("foreign");
      const otherDocumentButton = otherDocument.createElement("button");
      otherDocument.body.append(otherDocumentButton);
      const clone = accept.element.cloneNode(true) as HTMLButtonElement;
      document.body.append(clone);
      const icon = accept.element.firstElementChild!;
      const focus = vi.spyOn(HTMLElement.prototype, "focus");

      act(() => {
        invokeReviewControl(accept, sibling.element);
        invokeReviewControl(accept, reject.element);
        invokeReviewControl(accept, foreign, foreignChild);
        invokeReviewControl(accept, otherDocumentButton);
        invokeReviewControl(accept, clone);
        accept.click(reviewMouseEvent(accept, accept.element, icon, accept.element));
        accept.click(reviewMouseEvent(accept, accept.element, accept.element, accept.element, "pointerdown"));
        accept.click({
          ...reviewMouseEvent(accept),
          nativeEvent: new Event("click", { bubbles: true }),
        });
      });

      expect(api.documents.comment).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => {
        dispatchReviewClick(accept.element, event);
        dispatchReviewClick(accept.element, event);
      });
      expect(api.documents.comment).toHaveBeenCalledTimes(1);
      expect(api.documents.comment).toHaveBeenCalledWith(fixture.session.docId, {
        action: "suggestion",
        threadId: fixture.threadIds[0],
        replyId: undefined,
        decision: "accept",
      });
      foreign.remove();
      clone.remove();
    });

    it.each(["toggle", "accept", "reject", "resolve", "thread"] as const)(
      "keeps the %s review control exact and usable after direct-root Strict Mode replay",
      async (kind) => {
        Element.prototype.scrollIntoView ??= () => {};
        const suggestions = kind !== "resolve" && kind !== "thread";
        const fixture = makeBatchSession(`review-strict-${kind}`, 1, undefined, suggestions);
        const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
        vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
        const active = vi.spyOn(fixture.session, "setActiveComment");
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        try {
          await act(async () => {
            root.render(<StrictMode>{batchPanel(fixture.session)}</StrictMode>);
          });
          const card = await within(host).findByTestId("review-card");
          if (kind === "toggle") {
            act(() => dispatchReviewClick(within(card).getByTestId("review-toggle")));
            expect(within(card).getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "true");
          } else if (kind === "thread") {
            act(() => dispatchReviewClick(within(card).getByTestId("review-toggle")));
            act(() => dispatchReviewClick(within(card).getByTestId("review-thread-link")));
            expect(active).toHaveBeenCalledExactlyOnceWith(fixture.threadIds[0]);
          } else {
            const testId = kind === "accept" ? "review-accept-all" : kind === "reject" ? "review-reject-all" : "review-resolve-all";
            act(() => dispatchReviewClick(within(card).getByTestId(testId)));
            expect(api.documents.comment).toHaveBeenCalledTimes(1);
            expect(api.documents.comment).toHaveBeenCalledWith(
              fixture.session.docId,
              kind === "resolve"
                ? { action: "resolve", threadId: fixture.threadIds[0], resolved: true }
                : { action: "suggestion", threadId: fixture.threadIds[0], replyId: undefined, decision: kind },
            );
          }
        } finally {
          act(() => root.unmount());
          host.remove();
        }
      },
    );

    it.each(["toggle", "accept", "reject", "resolve", "thread"] as const)(
      "accepts a %s review click with a production-mangled React event constructor",
      async (kind) => {
        Element.prototype.scrollIntoView ??= () => {};
        const suggestions = kind !== "resolve" && kind !== "thread";
        const fixture = makeBatchSession(`review-mangled-${kind}`, 1, undefined, suggestions);
        const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
        vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
        const active = vi.spyOn(fixture.session, "setActiveComment");
        render(batchPanel(fixture.session));
        const card = await screen.findByTestId("review-card");
        const mangledClick = (element: HTMLElement) => {
          const restore = interceptMangledReviewClick(element);
          act(() => dispatchReviewClick(element));
          restore();
        };

        if (kind === "toggle" || kind === "thread") {
          mangledClick(within(card).getByTestId("review-toggle"));
          expect(within(card).getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "true");
        }
        if (kind === "thread") {
          mangledClick(within(card).getByTestId("review-thread-link"));
          expect(active).toHaveBeenCalledExactlyOnceWith(fixture.threadIds[0]);
        } else if (kind !== "toggle") {
          const testId = kind === "accept" ? "review-accept-all" : kind === "reject" ? "review-reject-all" : "review-resolve-all";
          mangledClick(within(card).getByTestId(testId));
          expect(api.documents.comment).toHaveBeenCalledTimes(1);
          expect(api.documents.comment).toHaveBeenCalledWith(
            fixture.session.docId,
            kind === "resolve"
              ? { action: "resolve", threadId: fixture.threadIds[0], resolved: true }
              : { action: "suggestion", threadId: fixture.threadIds[0], replyId: undefined, decision: kind },
          );
        }
      },
    );

    it.each(["transient descendant mutation", "transient disabled state", "detach and reinsert"] as const)(
      "fails closed after %s even when the exact review-card DOM is restored",
      async (scenario) => {
        const fixture = makeBatchSession(`review-${scenario.replaceAll(" ", "-")}`);
        const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
        vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
        const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
        const rendered = render(batchPanel(fixture.session, onToast));
        const stale = captureReviewControl(await screen.findByTestId("review-accept-all"));
        const card = reviewCard("r1");

        if (scenario === "transient descendant mutation") {
          const descendant = stale.element.firstElementChild;
          if (!descendant) throw new Error("Accept all did not render its committed icon");
          const replacement = descendant.cloneNode(true) as Element;
          descendant.replaceWith(replacement);
          replacement.replaceWith(descendant);
        } else if (scenario === "transient disabled state") {
          stale.element.disabled = true;
          stale.element.disabled = false;
        } else {
          const parent = card.parentNode;
          const next = card.nextSibling;
          if (!parent) throw new Error("Review card did not have a committed parent");
          card.remove();
          parent.insertBefore(card, next);
        }

        act(() => dispatchReviewClick(stale.element));
        expect(api.documents.comment).not.toHaveBeenCalled();

        rendered.rerender(batchPanel(fixture.session, vi.fn()));
        const current = captureReviewControl(screen.getByTestId("review-accept-all"));
        expect(current.click).not.toBe(stale.click);
        act(() => {
          stale.click(reviewMouseEvent(current));
          dispatchReviewClick(current.element);
        });
        expect(api.documents.comment).toHaveBeenCalledOnce();
      },
    );

    it("requires complete callback-ref replay and ignores late stale refs after a current successor", async () => {
      const fixture = makeBatchSession("review-partial-ref-replay");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const rendered = render(batchPanel(fixture.session));
      const stale = captureReviewControl(await screen.findByTestId("review-reject-all"));

      act(() => {
        stale.ref(null);
        stale.ref(stale.element);
        dispatchReviewClick(stale.element);
      });
      expect(api.documents.comment).not.toHaveBeenCalled();

      rendered.rerender(batchPanel(fixture.session));
      const current = captureReviewControl(screen.getByTestId("review-reject-all"));
      act(() => {
        stale.ref(current.element);
        stale.ref(null);
        dispatchReviewClick(current.element);
      });
      expect(api.documents.comment).toHaveBeenCalledOnce();
    });

    it("consumes one native event and action before repeated or reentrant thread work", async () => {
      Element.prototype.scrollIntoView ??= () => {};
      const fixture = makeBatchSession("review-thread-one-use", 1, undefined, false);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const active = vi.spyOn(fixture.session, "setActiveComment");
      render(batchPanel(fixture.session));
      const toggle = await screen.findByTestId("review-toggle");
      act(() => dispatchReviewClick(toggle));
      const link = captureReviewControl(screen.getByTestId("review-thread-link"));
      active.mockImplementation(() => {
        link.element.click();
      });
      const restore = interceptReviewClick(link.element, (original, event) => {
        original(event);
        original(event);
      });
      const repeated = new MouseEvent("click", { bubbles: true, cancelable: true });

      act(() => {
        dispatchReviewClick(link.element, repeated);
        dispatchReviewClick(link.element, repeated);
      });
      restore();
      expect(active).toHaveBeenCalledExactlyOnceWith(fixture.threadIds[0]);

      act(() => dispatchReviewClick(link.element));
      expect(active).toHaveBeenCalledTimes(2);
    });

    it("binds toggle and ordered thread links to their one exact card publication", async () => {
      Element.prototype.scrollIntoView ??= () => {};
      const fixture = makeBatchSession("review-toggle-links", 2, undefined, false);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const active = vi.spyOn(fixture.session, "setActiveComment");
      const rendered = render(batchPanel(fixture.session));
      const toggleA = captureReviewControl(await screen.findByTestId("review-toggle"));

      act(() => dispatchReviewClick(toggleA.element));
      const toggleB = captureReviewControl(screen.getByTestId("review-toggle"));
      expect(toggleB.element).toHaveAttribute("aria-expanded", "true");
      expect(toggleB.element).toBe(toggleA.element);
      act(() => invokeReviewControl(toggleA, toggleB.element));
      expect(toggleB.element).toHaveAttribute("aria-expanded", "true");

      const links = screen.getAllByTestId("review-thread-link").map((element) => captureReviewControl(element));
      const rows = screen.getAllByTestId("review-thread-row");
      const list = screen.getByTestId("review-threads");
      act(() => invokeReviewControl(links[0], links[1].element));
      expect(active).not.toHaveBeenCalled();
      act(() => dispatchReviewClick(links[0].element));
      expect(active).toHaveBeenCalledOnce();
      expect(active).toHaveBeenCalledWith(fixture.threadIds[0]);

      list.append(rows[0]);
      act(() => dispatchReviewClick(links[0].element));
      expect(active).toHaveBeenCalledOnce();
      list.insertBefore(rows[0], rows[1]);
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => {
        dispatchReviewClick(links[0].element, event);
        dispatchReviewClick(links[0].element, event);
      });
      expect(active).toHaveBeenCalledOnce();
      rendered.rerender(batchPanel(fixture.session));
      const currentLink = screen.getAllByTestId("review-thread-link")[0];
      act(() => dispatchReviewClick(currentLink));
      expect(active).toHaveBeenCalledTimes(2);
      expect(active).toHaveBeenLastCalledWith(fixture.threadIds[0]);

      act(() => dispatchReviewClick(screen.getByTestId("review-toggle")));
      expect(screen.getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "false");
    });

    it("permanently rejects a publication after exact-card DOM replacement or reorder", async () => {
      Element.prototype.scrollIntoView ??= () => {};
      const fixture = makeBatchSession("review-dom-replacement", 2, undefined, false);
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const active = vi.spyOn(fixture.session, "setActiveComment");
      const rendered = render(batchPanel(fixture.session));
      const toggle = captureReviewControl(await screen.findByTestId("review-toggle"));
      const card = reviewCard("r1");
      const header = within(card).getByTestId("review-header");
      const actions = within(card).getByTestId("review-actions");

      for (const replaced of [card, header, actions, toggle.element]) {
        const clone = replaced.cloneNode(true) as HTMLElement;
        replaced.replaceWith(clone);
        act(() => invokeReviewControl(toggle));
        expect(within(card).getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "false");
        clone.replaceWith(replaced);
      }
      card.append(header);
      act(() => invokeReviewControl(toggle));
      expect(toggle.element).toHaveAttribute("aria-expanded", "false");
      card.insertBefore(header, card.firstChild);
      act(() => dispatchReviewClick(toggle.element));
      expect(screen.getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "false");
      rendered.rerender(batchPanel(fixture.session));
      act(() => dispatchReviewClick(screen.getByTestId("review-toggle")));
      expect(screen.getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "true");

      const link = captureReviewControl(screen.getAllByTestId("review-thread-link")[0]);
      const list = screen.getByTestId("review-threads");
      const row = screen.getAllByTestId("review-thread-row")[0];
      for (const replaced of [list, row, link.element]) {
        const clone = replaced.cloneNode(true) as HTMLElement;
        replaced.replaceWith(clone);
        act(() => invokeReviewControl(link));
        expect(active).not.toHaveBeenCalled();
        clone.replaceWith(replaced);
      }
      act(() => dispatchReviewClick(link.element));
      expect(active).not.toHaveBeenCalled();
      rendered.rerender(batchPanel(fixture.session));
      act(() => dispatchReviewClick(screen.getAllByTestId("review-thread-link")[0]));
      expect(active).toHaveBeenCalledExactlyOnceWith(fixture.threadIds[0]);
    });

    it("retires text and operation publications while preserving the current same-DOM control", async () => {
      const fixture = makeBatchSession("review-fact-replacement");
      const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const rendered = render(batchPanel(fixture.session));
      const staleToggle = captureReviewControl(await screen.findByTestId("review-toggle"));

      act(() => {
        fixture.session.ytext.insert(fixture.session.ytext.length, "!");
        rendered.rerender(batchPanel(fixture.session));
      });
      const currentToggle = captureReviewControl(screen.getByTestId("review-toggle"));
      expect(currentToggle.element).toBe(staleToggle.element);
      act(() => invokeReviewControl(staleToggle, currentToggle.element));
      expect(currentToggle.element).toHaveAttribute("aria-expanded", "false");
      act(() => dispatchReviewClick(currentToggle.element));
      expect(screen.getByTestId("review-toggle")).toHaveAttribute("aria-expanded", "true");

      act(() => dispatchReviewClick(screen.getByTestId("review-toggle")));
      const staleReject = captureReviewControl(screen.getByTestId("review-reject-all"));
      vi.spyOn(fixture.session, "commentsViaApi", "get").mockReturnValue(false);
      rendered.rerender(batchPanel(fixture.session));
      const currentReject = captureReviewControl(screen.getByTestId("review-reject-all"));
      expect(currentReject.element).toBe(staleReject.element);
      act(() => invokeReviewControl(staleReject, currentReject.element));
      expect(fixture.session.comments.get(fixture.threadIds[0])?.suggestionState).toBeFalsy();
      act(() => dispatchReviewClick(currentReject.element));
      expect(fixture.session.comments.get(fixture.threadIds[0])?.suggestionState).toBe("rejected");
    });

    it.each(["review", "thread", "permission"] as const)(
      "re-reads mutable %s primitives before a batch claim without poisoning the restored control",
      async (mutation) => {
        const fixture = makeBatchSession(`review-mutable-${mutation}`);
        const review = reviewDto("r1", fixture.threadIds, fixture.session.docId);
        vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
        render(batchPanel(fixture.session));
        const control = captureReviewControl(await screen.findByTestId("review-reject-all"));
        const storedThread = fixture.session.comments.ymap.get(fixture.threadIds[0]) as Y.Map<unknown>;

        if (mutation === "review") review.summary = "Mutated in place";
        if (mutation === "permission") (fixture.session as unknown as { role: string }).role = "viewer";

        act(() => {
          if (mutation === "thread") storedThread.set("body", "Mutated in place");
          invokeReviewControl(control);
          expect(api.documents.comment).not.toHaveBeenCalled();
          if (mutation === "review") review.summary = "Review r1.";
          if (mutation === "thread") storedThread.set("body", "Finding 1.\n\n```suggestion\nALPHA\n```");
          if (mutation === "permission") (fixture.session as unknown as { role: string }).role = "owner";
          dispatchReviewClick(control.element);
        });
        expect(api.documents.comment).toHaveBeenCalledOnce();
      },
    );

    it.each(["stale-before-current", "current-before-stale"] as const)(
      "retires an equal-looking remount before parent layout and keeps the current control usable %s",
      async (order) => {
        const fixture = makeBatchSession(`review-remount-${order}`, 1, undefined, false);
        const review = reviewDto("same-review", fixture.threadIds, fixture.session.docId);
        vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
        const host = document.createElement("div");
        document.body.append(host);
        const root = createRoot(host);
        let passiveCleanups = 0;
        try {
          await act(async () => {
            root.render(<ComposerBoundary session={fixture.session} visit="A" />);
          });
          const stale = captureReviewControl(host.querySelector('[data-testid="review-toggle"]')!);
          let checkedAtBoundary = false;
          await act(async () => {
            root.render(
              <ComposerBoundary
                session={fixture.session}
                visit="B"
                boundary={1}
                onBoundary={() => {
                  stale.click(reviewMouseEvent(stale));
                  expect(stale.element.isConnected).toBe(false);
                  expect(host.querySelector('[data-testid="review-toggle"]')).toBeNull();
                  expect(passiveCleanups).toBe(0);
                  checkedAtBoundary = true;
                }}
                onPassiveCleanup={() => {
                  passiveCleanups += 1;
                }}
              />,
            );
          });
          expect(checkedAtBoundary).toBe(true);
          await waitFor(() => expect(host.querySelector('[data-testid="review-toggle"]')).toBeInTheDocument());
          const current = captureReviewControl(host.querySelector('[data-testid="review-toggle"]')!);
          act(() => {
            if (order === "stale-before-current") {
              invokeReviewControl(stale, current.element);
              dispatchReviewClick(current.element);
            } else {
              dispatchReviewClick(current.element);
              invokeReviewControl(stale, current.element);
            }
          });
          expect(host.querySelector('[data-testid="review-toggle"]')).toHaveAttribute("aria-expanded", "true");
          act(() => {
            stale.ref(current.element);
            stale.ref(null);
          });
          const currentAfterLateRefs = captureReviewControl(host.querySelector('[data-testid="review-toggle"]')!);
          act(() => dispatchReviewClick(currentAfterLateRefs.element));
          expect(host.querySelector('[data-testid="review-toggle"]')).toHaveAttribute("aria-expanded", "false");
        } finally {
          act(() => root.unmount());
          host.remove();
        }
      },
    );

    it("retires a removed card before parent layout and late old refs cannot clear its replacement", async () => {
      const fixture = makeBatchSession("review-removal-layout", 1, undefined, false);
      const review = reviewDto("same-review", fixture.threadIds, fixture.session.docId);
      vi.mocked(api.documents.reviews).mockResolvedValue({ reviews: [review] } as ReviewsResponse);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let passiveCleanups = 0;
      try {
        await act(async () => {
          root.render(<ComposerBoundary session={fixture.session} visit="A" />);
        });
        const stale = captureReviewControl(host.querySelector('[data-testid="review-toggle"]')!);
        let checkedAtBoundary = false;
        act(() =>
          root.render(
            <ComposerBoundary
              session={fixture.session}
              visit="B"
              present={false}
              boundary={1}
              onBoundary={() => {
                invokeReviewControl(stale);
                expect(passiveCleanups).toBe(0);
                checkedAtBoundary = true;
              }}
              onPassiveCleanup={() => {
                passiveCleanups += 1;
              }}
            />,
          ),
        );
        expect(checkedAtBoundary).toBe(true);
        await act(async () => {
          root.render(<ComposerBoundary session={fixture.session} visit="C" />);
        });
        const current = captureReviewControl(host.querySelector('[data-testid="review-toggle"]')!);
        act(() => {
          stale.ref(current.element);
          stale.ref(null);
          dispatchReviewClick(current.element);
        });
        expect(host.querySelector('[data-testid="review-toggle"]')).toHaveAttribute("aria-expanded", "true");
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });
  });

  describe("composer submission ownership", () => {
    const TEXT = "Intro text. The quick brown fox jumps.";
    const AGENTS = [
      { name: "First agent", login: "alice/First", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false },
      { name: "Second agent", login: "alice/Second", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false },
    ];

    const mountComposer = async (
      opts: {
        documentComposer?: CommentsPanelProps["documentComposer"];
        onClose?: () => void;
      } = {},
    ) => {
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({ docId: "composer-doc", user, role: "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [],
        agents: AGENTS,
      } as unknown as CollaboratorsResponse);
      const add = vi.spyOn(session.comments, "add");
      const onPendingDone = vi.fn();
      const props = (documentComposer: CommentsPanelProps["documentComposer"]) => (
        <TooltipProvider>
          <CommentsPanel
            session={session!}
            onClose={opts.onClose ?? (() => {})}
            onReveal={() => {}}
            onPendingDone={onPendingDone}
            documentComposer={documentComposer}
          />
        </TooltipProvider>
      );
      const view = render(props(opts.documentComposer ?? null));
      if (!opts.documentComposer) act(() => session!.setPendingComment({ from: 0, to: 5 }));
      const box = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      return {
        add,
        box,
        onPendingDone,
        user,
        view,
        setDocumentComposer: (next: CommentsPanelProps["documentComposer"]) => view.rerender(props(next)),
      };
    };

    const invokeSubmitHandler = (button: HTMLElement): Promise<void> => {
      const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
      if (!propsKey) throw new Error("React props were not attached to the submit button");
      const props = (button as unknown as Record<string, { onClick?: () => Promise<void> } | undefined>)[propsKey];
      const result = props?.onClick?.();
      if (!result) throw new Error("The submit button did not return its submission");
      return result;
    };

    afterEach(() => {
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as CollaboratorsResponse);
    });

    it("claims mixed Enter/click activation once and freezes body, mode and ordered agent intent while pending", async () => {
      const request = deferred<string>();
      const { add, box, onPendingDone, user } = await mountComposer();
      add.mockReturnValue(request.promise as unknown as string);
      const submitted = "  @alice/First @alice/Second draft  ";
      fireEvent.change(box, { target: { value: submitted } });
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("composer-mode-rewrite"));
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");

      const submit = screen.getByTestId("comment-submit");
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const suggestion = screen.getByTestId("comment-suggest-change");
      const chip = screen.getAllByTestId("composer-chip")[0];
      act(() => {
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        fireEvent.change(box, { target: { value: "changed after claim" } });
        screen.getByTestId("composer-mode-comment").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        suggestion.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({ from: 0, to: 5, body: submitted.trim(), author: user });
      expect(box).toHaveValue(submitted);
      expect(box).toBeDisabled();
      expect(submit).toBeDisabled();
      expect(cancel).toBeDisabled();
      expect(suggestion).toBeDisabled();
      expect(chip).toBeDisabled();
      expect(screen.getByTestId("composer-mode-comment")).toBeDisabled();
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      expect(onPendingDone).not.toHaveBeenCalled();

      await act(async () => request.resolve("thread-1"));
      await waitFor(() =>
        expect(api.documents.createRequest).toHaveBeenCalledWith("composer-doc", {
          mode: "rewrite",
          instruction: "draft",
          selection: { from: 0, to: 5, quote: "Intro" },
          threadId: "thread-1",
          agent: "alice/First",
        }),
      );
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("claims two immediate clicks as one physical submission and clears current work once", async () => {
      const request = deferred<string>();
      const { add, box, onPendingDone, user } = await mountComposer();
      add.mockReturnValue(request.promise as unknown as string);
      fireEvent.change(box, { target: { value: "@ali" } });
      await screen.findByTestId("mention-suggestions");
      const submit = screen.getByTestId("comment-submit");
      const mention = screen.getAllByTestId("mention-option")[0];

      act(() => {
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        mention.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith({ from: 0, to: 5, body: "@ali", author: user });
      expect(box).toHaveValue("@ali");
      expect(onPendingDone).not.toHaveBeenCalled();
      await act(async () => request.resolve("thread-1"));
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("retains a current failed draft, releases its controls and allows one deliberate retry", async () => {
      const first = deferred<string>();
      const retry = deferred<string>();
      const failure = new Error("submit failed");
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        const { add, box, onPendingDone, user } = await mountComposer();
        add.mockReturnValueOnce(first.promise as unknown as string).mockReturnValueOnce(retry.promise as unknown as string);
        fireEvent.change(box, { target: { value: "retry this" } });
        let currentSubmission!: Promise<void>;
        act(() => {
          currentSubmission = invokeSubmitHandler(screen.getByTestId("comment-submit"));
        });
        expect(add).toHaveBeenCalledTimes(1);

        await act(async () => {
          const rejection = expect(currentSubmission).rejects.toBe(failure);
          first.reject(failure);
          await rejection;
        });
        await waitFor(() => expect(screen.getByTestId("comment-submit")).toBeEnabled());
        expect(box).toBeEnabled();
        expect(box).toHaveValue("retry this");
        expect(onPendingDone).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("comment-submit"));
        expect(add).toHaveBeenCalledTimes(2);
        expect(add).toHaveBeenNthCalledWith(1, { from: 0, to: 5, body: "retry this", author: user });
        expect(add).toHaveBeenNthCalledWith(2, { from: 0, to: 5, body: "retry this", author: user });
        await act(async () => retry.resolve("thread-2"));
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it("keeps a keyed replacement draft locked until its own later success when the old success settles first", async () => {
      const oldRequest = deferred<string>();
      const currentRequest = deferred<string>();
      const { add, box: oldBox, onPendingDone, setDocumentComposer } = await mountComposer({ documentComposer: { mention: false, nonce: 1 } });
      add.mockReturnValueOnce(oldRequest.promise as unknown as string).mockReturnValueOnce(currentRequest.promise as unknown as string);
      fireEvent.change(oldBox, { target: { value: "old draft" } });
      fireEvent.click(screen.getByTestId("comment-submit"));

      setDocumentComposer({ mention: false, nonce: 2 });
      const currentBox = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      expect(currentBox).not.toBe(oldBox);
      fireEvent.change(currentBox, { target: { value: "current draft" } });
      fireEvent.click(screen.getByTestId("comment-submit"));
      expect(add).toHaveBeenCalledTimes(2);

      await act(async () => oldRequest.resolve("old-thread"));
      expect(currentBox).toHaveValue("current draft");
      expect(currentBox).toBeDisabled();
      expect(screen.getByTestId("comment-submit")).toBeDisabled();
      expect(onPendingDone).not.toHaveBeenCalled();

      await act(async () => currentRequest.resolve("current-thread"));
      expect(onPendingDone).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("lets current replacement success retire first, then consumes the old rejection without stale or unhandled effects", async () => {
      const oldRequest = deferred<string>();
      const currentRequest = deferred<string>();
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      try {
        const { add, box: oldBox, onPendingDone, setDocumentComposer } = await mountComposer({ documentComposer: { mention: false, nonce: 1 } });
        add.mockReturnValueOnce(oldRequest.promise as unknown as string).mockReturnValueOnce(currentRequest.promise as unknown as string);
        fireEvent.change(oldBox, { target: { value: "old draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));
        setDocumentComposer({ mention: false, nonce: 2 });
        const currentBox = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
        fireEvent.change(currentBox, { target: { value: "current draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));

        await act(async () => currentRequest.resolve("current-thread"));
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId("pending-comment")).toBeNull();
        await act(async () => {
          oldRequest.reject(new Error("old failure"));
          await Promise.allSettled([oldRequest.promise]);
        });
        expect(onPendingDone).toHaveBeenCalledTimes(1);
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });

    it.each(["removal", "close", "layout unmount"] as const)("retires pending ownership on %s before a late rejection", async (retirement) => {
      const request = deferred<string>();
      const unhandled: unknown[] = [];
      const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event.reason);
      window.addEventListener("unhandledrejection", onUnhandled);
      let removePanel = () => {};
      try {
        const mounted = await mountComposer({ onClose: () => removePanel() });
        removePanel = () => mounted.view.unmount();
        mounted.add.mockReturnValue(request.promise as unknown as string);
        fireEvent.change(mounted.box, { target: { value: "retired draft" } });
        fireEvent.click(screen.getByTestId("comment-submit"));

        if (retirement === "removal") {
          act(() => session!.setPendingComment(null));
          await waitFor(() => expect(screen.queryByTestId("pending-comment")).toBeNull());
        }
        else if (retirement === "close") fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
        else mounted.view.unmount();

        if (retirement === "removal") {
          act(() => session!.setPendingComment({ from: 0, to: 5 }));
          const replacement = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
          fireEvent.change(replacement, { target: { value: "replacement draft" } });
          expect(replacement).toBeEnabled();
          await act(async () => {
            request.reject(new Error("removed failure"));
            await Promise.allSettled([request.promise]);
          });
          expect(replacement).toHaveValue("replacement draft");
          expect(replacement).toBeEnabled();
        } else {
          await act(async () => {
            request.reject(new Error("unmounted failure"));
            await Promise.allSettled([request.promise]);
          });
          expect(screen.queryByTestId("comments-panel")).toBeNull();
        }
        expect(mounted.add).toHaveBeenCalledTimes(1);
        expect(mounted.onPendingDone).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }
    });
  });

  describe("composer focus and selection ownership", () => {
    const TEXT = "Intro text. The quick brown fox jumps.";
    const AGENT = {
      name: "Copilot CLI",
      login: "alice/Copilot-CLI",
      ownerLogin: "alice",
      ownerName: "Alice",
      present: false,
      collaboratorsMayAsk: false,
    };

    const mountDirectComposer = (frames: ReturnType<typeof controlledComposerFrames>, visit = "A") => {
      const fixture = reviewSession(`composer-focus-${visit}`);
      session = fixture.session;
      session.synced = true;
      session.ytext.insert(0, TEXT);
      session.setPendingComment({ from: 12, to: 27 });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      act(() => root.render(<ComposerBoundary session={session!} visit={visit} />));
      const box = host.querySelector<HTMLTextAreaElement>('[data-testid="comment-composer"]');
      if (!box || frames.captured.length === 0) throw new Error("Composer did not mount with its focus frame");
      return { box, host, root };
    };

    const focusCallsFor = (spy: ReturnType<typeof vi.spyOn>, element: HTMLTextAreaElement) =>
      spy.mock.instances.filter((instance: unknown) => instance === element);

    const replaceAtBoundary = (
      mounted: ReturnType<typeof mountDirectComposer>,
      transition: "replacement" | "removal",
      onBoundary: () => void,
      onPassiveCleanup: () => void,
    ) => {
      act(() => {
        mounted.root.render(
          <ComposerBoundary
            session={session!}
            visit="B"
            present={transition === "replacement"}
            boundary={1}
            onBoundary={onBoundary}
            onPassiveCleanup={onPassiveCleanup}
          />,
        );
      });
      if (transition === "removal") {
        act(() => mounted.root.render(<ComposerBoundary session={session!} visit="B" boundary={2} onPassiveCleanup={onPassiveCleanup} />));
      }
      const box = mounted.host.querySelector<HTMLTextAreaElement>('[data-testid="comment-composer"]');
      if (!box) throw new Error("Current composer did not mount");
      return box;
    };

    afterEach(() => {
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as CollaboratorsResponse);
    });

    it.each([
      ["replacement", "stale-before-current"],
      ["replacement", "current-before-stale"],
      ["removal", "stale-before-current"],
      ["removal", "current-before-stale"],
    ] as const)("physically retires the initial focus frame before parent layout on %s (%s)", (transition, order) => {
      const frames = controlledComposerFrames(true);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const selection = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
      const mounted = mountDirectComposer(frames);
      const staleBox = mounted.box;
      const staleFrame = frames.captured[0];
      let passiveCleanups = 0;

      try {
        const currentBox = replaceAtBoundary(
          mounted,
          transition,
          () => {
            expect(staleFrame.cancelled).toBe(true);
            expect(frames.pending.has(staleFrame)).toBe(false);
            expect(passiveCleanups).toBe(0);
          },
          () => {
            passiveCleanups += 1;
          },
        );
        const currentFrame = frames.captured.at(-1)!;
        expect(currentFrame).not.toBe(staleFrame);
        expect(currentFrame.id).toBe(staleFrame.id);
        focus.mockClear();
        selection.mockClear();

        act(() => {
          if (order === "stale-before-current") {
            frames.invoke(staleFrame);
            frames.invoke(currentFrame);
          } else {
            frames.invoke(currentFrame);
            frames.invoke(staleFrame);
          }
        });

        expect(focusCallsFor(focus, staleBox)).toHaveLength(0);
        expect(focusCallsFor(focus, currentBox)).toHaveLength(1);
        expect(focusCallsFor(selection, staleBox)).toHaveLength(0);
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    it("keeps replayed visits independent when React preserves the same textarea element", () => {
      const frames = controlledComposerFrames(true);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fixture = reviewSession("composer-focus-replay");
      session = fixture.session;
      session.synced = true;
      session.ytext.insert(0, TEXT);
      session.setPendingComment({ from: 12, to: 27 });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        act(() =>
          root.render(
            <StrictMode>
              <ComposerBoundary session={session!} visit="strict" />
            </StrictMode>,
          ),
        );
        const box = host.querySelector<HTMLTextAreaElement>('[data-testid="comment-composer"]')!;
        const staleFrame = frames.captured[0];
        const currentFrame = frames.captured.at(-1)!;
        expect(currentFrame).not.toBe(staleFrame);
        expect(currentFrame.id).toBe(staleFrame.id);
        expect(staleFrame.cancelled).toBe(true);
        expect(frames.pending.has(currentFrame)).toBe(true);
        focus.mockClear();
        act(() => {
          frames.invoke(staleFrame);
          frames.invoke(currentFrame);
        });
        expect(focusCallsFor(focus, box)).toHaveLength(1);
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    });

    it("selects the quote inside the Ctrl+Shift+S handler, so the value change's selectionchange cannot cancel it (#2212)", () => {
      const frames = controlledComposerFrames();
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        act(() => mounted.box.focus());
        fireEvent.keyDown(mounted.box, { key: "S", ctrlKey: true, shiftKey: true });
        // A real browser fires selectionchange for the new value before the next frame; React turns it into onSelect.
        act(() => {
          document.dispatchEvent(new Event("selectionchange"));
        });
        act(() => {
          for (const frame of [...frames.pending]) frames.invoke(frame);
        });
        expect(mounted.box).toHaveValue("```suggestion\nThe quick brown\n```");
        expect(mounted.box).toHaveFocus();
        expect(mounted.box.value.slice(mounted.box.selectionStart, mounted.box.selectionEnd)).toBe("The quick brown");
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    it("applies each current suggestion and formatting range exactly once", () => {
      const frames = controlledComposerFrames();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const selection = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        focus.mockClear();
        selection.mockClear();
        fireEvent.click(screen.getByTestId("comment-suggest-change"));
        // The suggestion selection is applied in the click handler itself; no frame is left to run (#2212).
        expect(frames.pending.size).toBe(0);
        expect(mounted.box.value.slice(mounted.box.selectionStart, mounted.box.selectionEnd)).toBe("The quick brown");
        expect(focusCallsFor(focus, mounted.box)).toHaveLength(1);
        expect(focusCallsFor(selection, mounted.box)).toHaveLength(1);

        const cases = [
          { key: "b", value: "**draft**", range: [2, 7] },
          { key: "i", value: "*draft*", range: [1, 6] },
          { key: "e", value: "`draft`", range: [1, 6] },
          { key: "k", value: "[draft]()", range: [8, 8] },
        ] as const;
        for (const current of cases) {
          fireEvent.change(mounted.box, { target: { value: "draft" } });
          mounted.box.setSelectionRange(0, 5);
          fireEvent.select(mounted.box);
          focus.mockClear();
          selection.mockClear();
          fireEvent.keyDown(mounted.box, { key: current.key, ctrlKey: true });
          const operation = frames.captured.at(-1)!;
          expect([...frames.pending]).toEqual([operation]);
          act(() => frames.invoke(operation));
          expect(mounted.box).toHaveValue(current.value);
          expect(focusCallsFor(focus, mounted.box)).toHaveLength(1);
          expect(focusCallsFor(selection, mounted.box)).toHaveLength(1);
          expect(selection).toHaveBeenLastCalledWith(...current.range);
        }
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    // Suggestion insertion selects its quote synchronously (#2212), so only formatting leaves a selection pending.
    it.each([
      ["formatting", "replacement"],
      ["formatting", "removal"],
    ] as const)("retires a pending %s selection before parent layout on %s and keeps B usable", (_operation, transition) => {
      const frames = controlledComposerFrames(true);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const selection = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        fireEvent.change(mounted.box, { target: { value: "draft" } });
        mounted.box.setSelectionRange(0, 5);
        fireEvent.keyDown(mounted.box, { key: "b", ctrlKey: true });
        const staleFrame = frames.captured.at(-1)!;
        expect(frames.pending.has(staleFrame)).toBe(true);
        let passiveCleanups = 0;
        const currentBox = replaceAtBoundary(
          mounted,
          transition,
          () => {
            expect(staleFrame.cancelled).toBe(true);
            expect(frames.pending.has(staleFrame)).toBe(false);
            expect(passiveCleanups).toBe(0);
          },
          () => {
            passiveCleanups += 1;
          },
        );
        const currentAutoFocus = frames.captured.at(-1)!;
        focus.mockClear();
        selection.mockClear();
        act(() => {
          frames.invoke(staleFrame);
          frames.invoke(currentAutoFocus);
        });
        expect(focusCallsFor(focus, mounted.box)).toHaveLength(0);
        expect(focusCallsFor(selection, mounted.box)).toHaveLength(0);

        fireEvent.change(currentBox, { target: { value: "current" } });
        currentBox.setSelectionRange(0, 7);
        focus.mockClear();
        selection.mockClear();
        fireEvent.keyDown(currentBox, { key: "i", ctrlKey: true });
        const currentFormat = frames.captured.at(-1)!;
        act(() => frames.invoke(currentFormat));
        expect(focusCallsFor(focus, currentBox)).toHaveLength(1);
        expect(focusCallsFor(selection, currentBox)).toHaveLength(1);
        expect(selection).toHaveBeenLastCalledWith(1, 8);
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    it.each([
      ["instruction", "replacement"],
      ["instruction", "removal"],
      ["mention", "replacement"],
      ["mention", "removal"],
    ] as const)("retires a pending %s caret before parent layout on %s without changing B", async (operation, transition) => {
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [],
        agents: [AGENT],
      } as unknown as CollaboratorsResponse);
      const frames = controlledComposerFrames(true);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const selection = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
        if (operation === "instruction") {
          fireEvent.change(mounted.box, { target: { value: `@${AGENT.login}` } });
          await screen.findByTestId("composer-agent-row");
          fireEvent.click(screen.getAllByTestId("composer-chip")[0]);
        } else {
          fireEvent.change(mounted.box, { target: { value: "@alice/C" } });
          fireEvent.click((await screen.findAllByTestId("mention-option"))[0]);
        }
        const staleFrame = frames.captured.at(-1)!;
        const currentBox = replaceAtBoundary(
          mounted,
          transition,
          () => {
            expect(staleFrame.cancelled).toBe(true);
            expect(frames.pending.has(staleFrame)).toBe(false);
          },
          () => {},
        );
        const currentAutoFocus = frames.captured.at(-1)!;
        act(() => frames.invoke(currentAutoFocus));
        fireEvent.change(currentBox, { target: { value: "current draft" } });
        focus.mockClear();
        selection.mockClear();
        act(() => frames.invoke(staleFrame));
        expect(currentBox).toHaveValue("current draft");
        expect(focusCallsFor(focus, mounted.box)).toHaveLength(0);
        expect(focusCallsFor(selection, mounted.box)).toHaveLength(0);
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    it("supersedes an older frame and preserves a newer user caret action", () => {
      const frames = controlledComposerFrames();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const selection = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        fireEvent.change(mounted.box, { target: { value: "draft" } });
        mounted.box.setSelectionRange(0, 5);
        fireEvent.keyDown(mounted.box, { key: "b", ctrlKey: true });
        const older = frames.captured.at(-1)!;
        fireEvent.keyDown(mounted.box, { key: "i", ctrlKey: true });
        const newer = frames.captured.at(-1)!;
        expect(older.cancelled).toBe(true);
        expect([...frames.pending]).toEqual([newer]);

        mounted.box.setSelectionRange(2, 2);
        fireEvent.select(mounted.box);
        expect(newer.cancelled).toBe(true);
        expect(frames.pending.size).toBe(0);
        focus.mockClear();
        selection.mockClear();
        act(() => {
          frames.invoke(older);
          frames.invoke(newer);
        });
        expect(focusCallsFor(focus, mounted.box)).toHaveLength(0);
        expect(focusCallsFor(selection, mounted.box)).toHaveLength(0);
        expect(mounted.box.selectionStart).toBe(2);
        expect(mounted.box.selectionEnd).toBe(2);
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });

    it.each(["replacement", "removal"] as const)("clears A's blur timer before parent layout on %s and leaves B's reused timer authoritative", async (transition) => {
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [],
        agents: [AGENT],
      } as unknown as CollaboratorsResponse);
      const frames = controlledComposerFrames(true);
      const mounted = mountDirectComposer(frames);

      try {
        act(() => frames.invoke(frames.captured[0]));
        fireEvent.change(mounted.box, { target: { value: "@alice/C" } });
        await screen.findByTestId("mention-suggestions");
        const timers = controlledComposerBlurTimers();
        fireEvent.blur(mounted.box);
        const staleTimer = timers.captured[0];
        expect(timers.set).toHaveBeenCalledWith(expect.any(Function), 120);

        const currentBox = replaceAtBoundary(
          mounted,
          transition,
          () => {
            expect(staleTimer.cancelled).toBe(true);
            expect(timers.pending.has(staleTimer)).toBe(false);
          },
          () => {},
        );
        act(() => frames.invoke(frames.captured.at(-1)!));
        fireEvent.change(currentBox, { target: { value: "@alice/C" } });
        await screen.findByTestId("mention-suggestions");
        fireEvent.blur(currentBox);
        const currentTimer = timers.captured.at(-1)!;
        expect(currentTimer).not.toBe(staleTimer);
        expect(currentTimer.id).toBe(staleTimer.id);

        act(() => timers.invoke(staleTimer));
        expect(timers.pending.has(currentTimer)).toBe(true);
        expect(currentBox).toHaveValue("@alice/C");
        expect(screen.getByTestId("mention-suggestions")).toBeInTheDocument();
        act(() => timers.advance(119));
        expect(screen.getByTestId("mention-suggestions")).toBeInTheDocument();
        act(() => timers.advance(1));
        expect(screen.queryByTestId("mention-suggestions")).toBeNull();
      } finally {
        act(() => mounted.root.unmount());
        mounted.host.remove();
      }
    });
  });

  describe("agent requests from comments (#1024)", () => {
    // As the collaborators route lists it (#1296): whose it is, and — off by default — whether others may ask it.
    const AGENT = { name: "Copilot CLI", login: "alice/Copilot-CLI", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: false };
    const TEXT = "Intro text. The quick brown fox jumps.";

    type Role = "owner" | "editor" | "commenter";
    type ListedAgent = Awaited<ReturnType<typeof api.documents.collaborators>>["agents"][number];
    let restoreRequestModeScrollIntoView: (() => void) | null = null;
    const mockRequestModeScrollIntoView = () => {
      if (restoreRequestModeScrollIntoView) return;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
      restoreRequestModeScrollIntoView = () => {
        if (descriptor) Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
        else delete (Element.prototype as Partial<Element>).scrollIntoView;
        restoreRequestModeScrollIntoView = null;
      };
    };
    const mount = (opts: { role?: Role; viewing?: boolean; me?: { id: string; name: string; login: string }; agents?: ListedAgent[]; onCancelRequest?: (id: string) => void } = {}) => {
      mockRequestModeScrollIntoView();
      const me = opts.me ?? { id: "alice", name: "Alice", login: "alice" };
      const user = makeCollabUser(me.id, me.name, null, me.login);
      session = new CollabSession({ docId: "doc", user, role: opts.role ?? "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      // The provider is mocked: nothing is ever unsynced, and a synced session lets waitForSynced resolve at once.
      session.synced = true;
      if (opts.viewing) session.setMode("viewing");
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [{ login: "bob", name: "Bob", image: null }],
        agents: opts.agents ?? [AGENT],
      } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      render(
        <TooltipProvider>
          <CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} onToast={onToast} onCancelRequest={opts.onCancelRequest} />
        </TooltipProvider>,
      );
      return { onToast, user };
    };
    /** Opens the new-comment composer on "quick brown" and waits for the picker to know the agent. */
    const openComposer = async () => {
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      const box = await screen.findByPlaceholderText(/Add a comment/);
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      return box as HTMLTextAreaElement;
    };
    const type = async (box: HTMLTextAreaElement, text: string) => {
      box.focus();
      await userEvent.setup().paste(text);
    };
    const mirror = (over: Partial<AgentRequestMirror> & { id: string }): AgentRequestMirror => ({
      status: "open",
      mode: "suggest",
      instruction: "Tighten this",
      claimedBy: null,
      result: null,
      userId: "alice",
      threadId: null,
      updatedAt: Date.now(),
      ...over,
    });
    const setMirrors = (list: AgentRequestMirror[]) => {
      act(() => session!.meta.set("agentRequests", Object.fromEntries(list.map((r) => [r.id, r]))));
    };
    const directRequestModeViews: {
      host: HTMLDivElement;
      root: ReturnType<typeof createRoot>;
      renderVisit: (visit: string) => void;
    }[] = [];
    const directRequestModeTree = (visit: string) => (
      <StrictMode>
        <section key={visit} data-request-mode-visit={visit}>
          <TooltipProvider>
            <CommentsPanel session={session!} onClose={() => {}} onReveal={() => {}} />
          </TooltipProvider>
        </section>
      </StrictMode>
    );
    const mountDirectRequestModes = async (
      opts: {
        role?: Role;
        viewing?: boolean;
        agents?: ListedAgent[];
        value?: string;
      } = {},
    ) => {
      mockRequestModeScrollIntoView();
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({
        docId: "request-mode-direct",
        user,
        role: opts.role ?? "owner",
        getToken: async () => "token",
        autoConnect: false,
      });
      session.keepAlive();
      session.synced = true;
      if (opts.viewing) session.setMode("viewing");
      session.ytext.insert(0, TEXT);
      session.setPendingComment({ from: 16, to: 27 });
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: [],
        agents: opts.agents ?? [AGENT],
      } as unknown as CollaboratorsResponse);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const renderVisit = (visit: string) => {
        act(() => root.render(directRequestModeTree(visit)));
      };
      directRequestModeViews.push({ host, root, renderVisit });
      renderVisit("A");
      const box = await waitFor(() => {
        const element = host.querySelector<HTMLTextAreaElement>('[data-testid="comment-composer"]');
        if (!element) throw new Error("The direct request-mode composer did not mount");
        return element;
      });
      fireEvent.change(box, {
        target: { value: opts.value ?? "@alice/Copilot-CLI tighten this" },
      });
      await waitFor(() => {
        if (!host.querySelector('[data-testid="composer-agent-row"]')) {
          throw new Error("The direct request-mode row did not mount");
        }
      });
      const radio = (mode: AgentRequestMode) => {
        const element = host.querySelector<HTMLButtonElement>(
          `[data-testid="composer-mode-${mode}"]`,
        );
        if (!element) throw new Error(`The direct ${mode} request mode did not mount`);
        return element;
      };
      const group = () => {
        const element = host.querySelector<HTMLDivElement>('[role="radiogroup"]');
        if (!element) throw new Error("The direct request-mode group did not mount");
        return element;
      };
      return { box, group, host, radio, renderVisit, root };
    };
    const mountDirectMentions = async (
      opts: {
        collaborators?: CollaboratorsResponse["collaborators"];
        agents?: ListedAgent[];
        expectedOptions?: number;
      } = {},
    ) => {
      mockRequestModeScrollIntoView();
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({
        docId: "mention-keyboard-direct",
        user,
        role: "owner",
        getToken: async () => "token",
        autoConnect: false,
      });
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, TEXT);
      session.setPendingComment({ from: 16, to: 27 });
      vi.mocked(api.documents.collaborators).mockResolvedValue({
        owner: { login: "alice", name: "Alice", image: null },
        collaborators: opts.collaborators ?? [
          { login: "bob", name: "Bob", image: null },
          { login: "carol", name: "Carol", image: null },
        ],
        agents: opts.agents ?? [AGENT],
      } as unknown as CollaboratorsResponse);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const renderVisit = (visit: string) => {
        act(() => root.render(directRequestModeTree(visit)));
      };
      directRequestModeViews.push({ host, root, renderVisit });
      renderVisit("A");
      const box = await waitFor(() => {
        const element = host.querySelector<HTMLTextAreaElement>(
          '[data-testid="comment-composer"]',
        );
        if (!element) throw new Error("The direct mention composer did not mount");
        return element;
      });
      box.focus();
      fireEvent.change(box, { target: { value: "@" } });
      const list = await waitFor(() => {
        const listId = box.getAttribute("aria-controls");
        const element = listId
          ? box.ownerDocument.getElementById(listId)
          : null;
        if (!(element instanceof HTMLUListElement)) {
          throw new Error("The exact mention list did not mount");
        }
        return element;
      });
      const options = () =>
        Array.from(
          (box.getAttribute("aria-controls")
            ? box.ownerDocument.getElementById(
                box.getAttribute("aria-controls")!,
              )
            : null)?.children ?? [],
        ).filter(
          (element): element is HTMLLIElement =>
            element instanceof HTMLLIElement &&
            element.dataset.testid === "mention-option",
        );
      await waitFor(() =>
        expect(options()).toHaveLength(opts.expectedOptions ?? 3),
      );
      return { box, host, list, options, renderVisit, root };
    };

    afterEach(() => {
      mentionHighlightReentry.callback = null;
      for (const view of directRequestModeViews.splice(0)) {
        act(() => view.root.unmount());
        view.host.remove();
      }
      // Reset, not clear: a rejecting implementation must never outlive the test that set it (#1082).
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.documents.comment).mockClear();
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
      restoreRequestModeScrollIntoView?.();
    });

    it("shows the mode row only while the body mentions an agent the picker knows", async () => {
      mount();
      const box = await openComposer();
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
      await type(box, "@alice/Copilot-CLI tighten this");
      const row = await screen.findByTestId("composer-agent-row");
      // Controls only: nothing under the box reads as hint text.
      expect(Array.from(row.querySelectorAll("*")).filter((el) => el.childElementCount === 0 && !el.closest("button"))).toEqual([]);
      const group = screen.getByRole("radiogroup", { name: "How should Copilot CLI answer?" });
      const radios = within(group).getAllByRole("radio");
      expect(radios.map((r) => r.textContent)).toEqual(["Tracked changes", "Comment only", "Rewrite directly"]);
      expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
      expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
      expect(screen.getAllByTestId("composer-chip").length).toBeGreaterThan(0);
      // A human mention alone is just a comment.
      fireEvent.change(box, { target: { value: "@bob what do you think?" } });
      await waitFor(() => expect(screen.queryByTestId("composer-agent-row")).toBeNull());
      // An agent the document does not know is not a request either (the row must never guess).
      fireEvent.change(box, { target: { value: "@carol/Some-Bot help" } });
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
    });

    describe("mention-suggestion keyboard authority", () => {
      type MentionPhase =
        | "root-capture"
        | "textarea-capture"
        | "textarea-bubble"
        | "root-bubble";
      type MentionPhaseWrappers = ReadonlyMap<MentionPhase, Record<string, unknown>>;

      const replaceMentionPhaseWrappers = (
        root: HTMLElement,
        box: HTMLTextAreaElement,
        options: {
          onDefaultQuery?: (
            phase: MentionPhase,
            driftPropagation: () => void,
            wrapper: Record<string, unknown>,
            wrappers: MentionPhaseWrappers,
          ) => void;
          replaceTextareaDefaultQuery?: boolean;
          driftTextareaPostDefaultQuery?: boolean;
          poisonPrivateMembers?: boolean;
          shareBubbleWrapper?: boolean;
          onPreventDefault?: (wrappers: MentionPhaseWrappers) => void;
          onPostDefaultPreventedRead?: (
            phase: MentionPhase,
            wrappers: MentionPhaseWrappers,
          ) => void;
        } = {},
      ) => {
        const preventions = new Map<MentionPhase, ReturnType<typeof vi.fn>>();
        const phaseWrappers = new Map<MentionPhase, Record<string, unknown>>();
        let prevented = false;
        const wrap = (
          event: ReactKeyboardEvent<HTMLElement>,
          phase: MentionPhase,
        ) => {
          if (phase === "root-bubble" && options.shareBubbleWrapper) {
            const shared = phaseWrappers.get("textarea-bubble");
            if (!shared) throw new Error("Missing textarea-bubble wrapper");
            Object.defineProperty(shared, "currentTarget", {
              configurable: true,
              get: () => event.currentTarget,
            });
            phaseWrappers.set(phase, shared);
            return shared as unknown as ReactKeyboardEvent<HTMLElement>;
          }
          const wrapper = Object.create({ phase }) as Record<string, unknown>;
          phaseWrappers.set(phase, wrapper);
          const names = [
            "nativeEvent",
            "type",
            "target",
            "currentTarget",
            "eventPhase",
            "bubbles",
            "cancelable",
            "defaultPrevented",
            "isTrusted",
            "key",
            "code",
            "location",
            "charCode",
            "keyCode",
            "which",
            "locale",
            "detail",
            "view",
            "repeat",
            "isComposing",
            "altKey",
            "ctrlKey",
            "metaKey",
            "shiftKey",
          ] as const;
          const scalars = Object.fromEntries(
            names.map((name) => [
              name,
              (event as unknown as Record<string, unknown>)[name],
            ]),
          );
          for (const name of names) {
            Object.defineProperty(wrapper, name, {
              configurable: true,
              enumerable: true,
              get: () => {
                if (name === "defaultPrevented") {
                  if (prevented) {
                    options.onPostDefaultPreventedRead?.(phase, phaseWrappers);
                  }
                  return event.defaultPrevented;
                }
                return scalars[name];
              },
            });
          }
          const preventDefault = vi.fn(() => {
            event.preventDefault();
            prevented = true;
            if (
              phase === "textarea-bubble" &&
              options.replaceTextareaDefaultQuery
            ) {
              const replacement = () => {
                if (options.driftTextareaPostDefaultQuery) {
                  Object.defineProperty(wrapper, "isDefaultPrevented", {
                    configurable: true,
                    value: () => true,
                  });
                }
                return true;
              };
              Object.defineProperty(wrapper, "isDefaultPrevented", {
                configurable: true,
                value: replacement,
              });
            }
            options.onPreventDefault?.(phaseWrappers);
          });
          preventions.set(phase, preventDefault);
          const isPropagationStopped = () => event.isPropagationStopped();
          Object.assign(wrapper, {
            preventDefault,
            isDefaultPrevented: () => {
              options.onDefaultQuery?.(
                phase,
                () => {
                  Object.defineProperty(wrapper, "isPropagationStopped", {
                    configurable: true,
                    value: () => false,
                  });
                },
                wrapper,
                phaseWrappers,
              );
              return event.isDefaultPrevented();
            },
            isPropagationStopped,
          });
          if (options.poisonPrivateMembers) {
            for (const name of [
              "_reactName",
              "persist",
              "isPersistent",
              "stopPropagation",
            ]) {
              Object.defineProperty(wrapper, name, {
                configurable: true,
                get: () => {
                  throw new Error(`private ${name} was read`);
                },
              });
            }
          }
          return wrapper as unknown as ReactKeyboardEvent<HTMLElement>;
        };
        const rootCapture = reactProperty<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDownCapture");
        const rootBubble = reactProperty<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDown");
        const textareaCapture = reactProperty<
          (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
        >(box, "onKeyDownCapture");
        const textareaBubble = reactProperty<
          (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
        >(box, "onKeyDown");
        const restoreRoot = replaceReactProperties(root, {
          onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) =>
            rootCapture(wrap(event, "root-capture") as ReactKeyboardEvent<HTMLDivElement>),
          onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) =>
            rootBubble(wrap(event, "root-bubble") as ReactKeyboardEvent<HTMLDivElement>),
        });
        const restoreTextarea = replaceReactProperties(box, {
          onKeyDownCapture: (event: ReactKeyboardEvent<HTMLTextAreaElement>) =>
            textareaCapture(wrap(event, "textarea-capture") as ReactKeyboardEvent<HTMLTextAreaElement>),
          onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) =>
            textareaBubble(wrap(event, "textarea-bubble") as ReactKeyboardEvent<HTMLTextAreaElement>),
        });
        return {
          preventions,
          phaseWrappers,
          restore: () => {
            restoreTextarea();
            restoreRoot();
          },
        };
      };

      it("accepts four independent public phase wrappers and React 19's post-prevention query replacement", async () => {
        const preventDefault = vi.spyOn(window.Event.prototype, "preventDefault");
        const { box, options } = await mountDirectMentions();
        const root = box.parentElement;
        if (!root) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const wrappers = replaceMentionPhaseWrappers(root, box, {
          replaceTextareaDefaultQuery: true,
        });
        const changes: MutationRecord[] = [];
        const observer = new MutationObserver((records) => changes.push(...records));
        observer.observe(box, {
          attributes: true,
          attributeFilter: ["aria-activedescendant"],
        });
        preventDefault.mockClear();

        try {
          const accepted = mentionKey(box, "End");
          changes.push(...observer.takeRecords());
          expect(accepted.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(wrappers.preventions.get("textarea-bubble")).toHaveBeenCalledOnce();
          expect(wrappers.preventions.get("root-capture")).not.toHaveBeenCalled();
          expect(wrappers.preventions.get("textarea-capture")).not.toHaveBeenCalled();
          expect(wrappers.preventions.get("root-bubble")).not.toHaveBeenCalled();
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
          expect(changes).toHaveLength(1);
          expect(box).toHaveFocus();
          expect(box).toHaveValue("@");
          expect(api.documents.comment).not.toHaveBeenCalled();
          expect(api.documents.createRequest).not.toHaveBeenCalled();
        } finally {
          observer.disconnect();
          wrappers.restore();
        }
      });

      it.each(["throwing", "drifting", "reentrant"] as const)(
        "rejects %s public phase queries without spending a clean successor",
        async (kind) => {
          const { box, options } = await mountDirectMentions();
          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          let reentered = false;
          const wrappers = replaceMentionPhaseWrappers(root, box, {
            onDefaultQuery: (phase, driftPropagation) => {
              if (phase !== "root-capture") return;
              if (kind === "throwing") throw new Error("query failure");
              if (kind === "drifting") {
                driftPropagation();
                return;
              }
              if (kind === "reentrant" && !reentered) {
                reentered = true;
                mentionKey(box, "End");
              }
            },
          });

          try {
            const rejected = mentionKey(box, "End");
            expect(rejected.defaultPrevented).toBe(false);
            expect(options()[1]).toHaveAttribute("aria-selected", "true");
          } finally {
            wrappers.restore();
          }

          const clean = mentionKey(box, "End");
          expect(clean.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
        },
      );

      it("revalidates complete scalar accessors after queries while ignoring private members", async () => {
        const accepted = await mountDirectMentions();
        const acceptedRoot = accepted.box.parentElement;
        if (!acceptedRoot) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(accepted.options()[1]);
        await waitFor(() =>
          expect(accepted.options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const privateMembers = replaceMentionPhaseWrappers(
          acceptedRoot,
          accepted.box,
          {
            poisonPrivateMembers: true,
            replaceTextareaDefaultQuery: true,
          },
        );
        try {
          const event = mentionKey(accepted.box, "End");
          expect(event.defaultPrevented).toBe(true);
          expect(accepted.options()[2]).toHaveAttribute("aria-selected", "true");
        } finally {
          privateMembers.restore();
        }

        const drifted = await mountDirectMentions();
        const driftedRoot = drifted.box.parentElement;
        if (!driftedRoot) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(drifted.options()[1]);
        await waitFor(() =>
          expect(drifted.options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const scalarDrift = replaceMentionPhaseWrappers(
          driftedRoot,
          drifted.box,
          {
            onDefaultQuery: (phase, _driftPropagation, wrapper) => {
              if (phase === "root-capture") {
                Object.defineProperty(wrapper, "key", {
                  configurable: true,
                  value: "Home",
                });
              }
            },
          },
        );
        try {
          const rejected = mentionKey(drifted.box, "End");
          expect(rejected.defaultPrevented).toBe(false);
          expect(drifted.options()[1]).toHaveAttribute("aria-selected", "true");
        } finally {
          scalarDrift.restore();
        }
        const clean = mentionKey(drifted.box, "End");
        expect(clean.defaultPrevented).toBe(true);
        expect(drifted.options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it("retains exactly one post-prevention default-query replacement", async () => {
        const { box, options } = await mountDirectMentions();
        const root = box.parentElement;
        if (!root) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const wrappers = replaceMentionPhaseWrappers(root, box, {
          replaceTextareaDefaultQuery: true,
          driftTextareaPostDefaultQuery: true,
        });
        try {
          const rejectedAfterPrevention = mentionKey(box, "End");
          expect(rejectedAfterPrevention.defaultPrevented).toBe(true);
          expect(options()[1]).toHaveAttribute("aria-selected", "true");
        } finally {
          wrappers.restore();
        }

        const clean = mentionKey(box, "End");
        expect(clean.defaultPrevented).toBe(true);
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it.each(["root-capture", "textarea-capture", "root-bubble"] as const)(
        "rejects a post-prevention query replacement on independent %s",
        async (phase) => {
          const { box, options } = await mountDirectMentions();
          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          const replacement = vi.fn(() => phase === "root-bubble");
          const wrappers = replaceMentionPhaseWrappers(root, box, {
            replaceTextareaDefaultQuery: true,
            onPreventDefault: (phases) => {
              const other = phases.get(phase);
              if (!other) throw new Error(`Missing ${phase} wrapper`);
              expect(other).not.toBe(phases.get("textarea-bubble"));
              Object.defineProperty(other, "isDefaultPrevented", {
                configurable: true,
                value: replacement,
              });
            },
          });
          try {
            const event = mentionKey(box, "End");
            expect(event.defaultPrevented).toBe(true);
            expect(wrappers.preventions.get("textarea-bubble")).toHaveBeenCalledOnce();
            expect(replacement).not.toHaveBeenCalled();
            expect(options()[1]).toHaveAttribute("aria-selected", "true");
            expect(box).toHaveFocus();
            expect(box).toHaveValue("@");
            expect(api.documents.comment).not.toHaveBeenCalled();
            expect(api.documents.createRequest).not.toHaveBeenCalled();
          } finally {
            wrappers.restore();
          }
          const clean = mentionKey(box, "End");
          expect(clean.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
        },
      );

      it.each(["root-capture", "textarea-bubble"] as const)(
        "pins the prevention query before the %s defaultPrevented getter can replace it",
        async (phase) => {
          const { box, options } = await mountDirectMentions();
          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          const replacement = vi.fn(() => true);
          let getterRan = false;
          const wrappers = replaceMentionPhaseWrappers(root, box, {
            replaceTextareaDefaultQuery: true,
            onPostDefaultPreventedRead: (current, phases) => {
              if (current !== phase || getterRan) return;
              getterRan = true;
              const textareaBubble = phases.get("textarea-bubble");
              if (!textareaBubble) throw new Error("Missing textarea-bubble wrapper");
              Object.defineProperty(textareaBubble, "isDefaultPrevented", {
                configurable: true,
                value: replacement,
              });
            },
          });
          try {
            const event = mentionKey(box, "End");
            expect(event.defaultPrevented).toBe(true);
            expect(getterRan).toBe(true);
            expect(wrappers.preventions.get("textarea-bubble")).toHaveBeenCalledOnce();
            expect(replacement).not.toHaveBeenCalled();
            expect(options()[1]).toHaveAttribute("aria-selected", "true");
          } finally {
            wrappers.restore();
          }
          const clean = mentionKey(box, "End");
          expect(clean.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
        },
      );

      it("rejects drift inside the first post-prevention query getter", async () => {
        const { box, options } = await mountDirectMentions();
        const root = box.parentElement;
        if (!root) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const replacement = vi.fn(() => true);
        const changed = vi.fn(() => true);
        const stateChanges = vi.fn();
        mentionHighlightReentry.callback = stateChanges;
        const wrappers = replaceMentionPhaseWrappers(root, box, {
          onPreventDefault: (phases) => {
            const textareaBubble = phases.get("textarea-bubble");
            if (!textareaBubble) throw new Error("Missing textarea-bubble wrapper");
            Object.defineProperty(textareaBubble, "isDefaultPrevented", {
              configurable: true,
              get: () => {
                Object.defineProperty(textareaBubble, "isDefaultPrevented", {
                  configurable: true,
                  value: changed,
                });
                return replacement;
              },
            });
          },
        });
        try {
          const event = mentionKey(box, "End");
          expect(event.defaultPrevented).toBe(true);
          expect(wrappers.preventions.get("textarea-bubble")).toHaveBeenCalledOnce();
          expect(replacement).not.toHaveBeenCalled();
          expect(changed).not.toHaveBeenCalled();
          expect(stateChanges).not.toHaveBeenCalled();
          expect(options()[1]).toHaveAttribute("aria-selected", "true");
        } finally {
          mentionHighlightReentry.callback = null;
          wrappers.restore();
        }
        const clean = mentionKey(box, "End");
        expect(clean.defaultPrevented).toBe(true);
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it("accepts the replacement on an exact textarea-bubble alias at root-bubble", async () => {
        const { box, options } = await mountDirectMentions();
        const root = box.parentElement;
        if (!root) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const wrappers = replaceMentionPhaseWrappers(root, box, {
          replaceTextareaDefaultQuery: true,
          shareBubbleWrapper: true,
        });
        try {
          const event = mentionKey(box, "End");
          expect(event.defaultPrevented).toBe(true);
          expect(wrappers.phaseWrappers.get("root-bubble")).toBe(
            wrappers.phaseWrappers.get("textarea-bubble"),
          );
          expect(wrappers.preventions.get("textarea-bubble")).toHaveBeenCalledOnce();
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
          expect(box).toHaveFocus();
          expect(box).toHaveValue("@");
        } finally {
          wrappers.restore();
        }
      });

      it.each([
        ["scalar", "root-capture", "textarea-capture"],
        ["scalar", "root-capture", "root-bubble"],
        ["query-before", "root-capture", "root-capture"],
        ["query-before", "root-capture", "textarea-bubble"],
        ["query-before", "textarea-capture", "root-capture"],
        ["query-after", "root-capture", "root-capture"],
        ["query-after", "root-capture", "textarea-bubble"],
        ["query-after", "textarea-capture", "root-capture"],
        ["query-after", "textarea-bubble", "root-capture"],
      ] as const)(
        "rejects %s mutation from %s to %s with no highlight or unrelated effects",
        async (kind, source, destination) => {
          const prevention = vi.spyOn(window.Event.prototype, "preventDefault");
          const focus = vi.spyOn(window.HTMLElement.prototype, "focus");
          const selection = vi.spyOn(window.HTMLTextAreaElement.prototype, "setSelectionRange");
          const { box, options } = await mountDirectMentions();
          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          const beforeSelection = [box.selectionStart, box.selectionEnd];
          const scroll = vi.mocked(Element.prototype.scrollIntoView);
          const changes: MutationRecord[] = [];
          const observer = new MutationObserver((records) => changes.push(...records));
          observer.observe(box, {
            attributes: true,
            attributeFilter: ["aria-activedescendant"],
          });
          let prevented = false;
          let mutations = 0;
          const replacedQuery = vi.fn(() => destination === "textarea-bubble");
          const mutate = (phases: MentionPhaseWrappers) => {
            if (mutations || phases.size !== 4) return;
            const target = phases.get(destination);
            if (!target) throw new Error(`Missing ${destination} wrapper`);
            mutations += 1;
            Object.defineProperty(target, "isDefaultPrevented", {
              configurable: true,
              value: replacedQuery,
            });
          };
          const wrappers = replaceMentionPhaseWrappers(root, box, {
            replaceTextareaDefaultQuery: true,
            onPreventDefault: (phases) => {
              prevented = true;
              if (kind === "query-after" && source === "textarea-bubble") {
                const textareaBubble = phases.get("textarea-bubble");
                if (!textareaBubble) throw new Error("Missing textarea-bubble wrapper");
                Object.defineProperty(textareaBubble, "isDefaultPrevented", {
                  configurable: true,
                  value: () => {
                    mutate(phases);
                    return true;
                  },
                });
              }
            },
            onDefaultQuery: (phase, _drift, _wrapper, phases) => {
              if (
                phase === source &&
                (kind === "query-before" && !prevented ||
                  kind === "query-after" && prevented)
              ) {
                mutate(phases);
              }
            },
            onPostDefaultPreventedRead: (phase, phases) => {
              if (kind === "scalar" && phase === source) mutate(phases);
            },
          });
          prevention.mockClear();
          focus.mockClear();
          selection.mockClear();
          scroll.mockClear();
          try {
            const rejected = mentionKey(box, "End");
            changes.push(...observer.takeRecords());
            expect(mutations).toBe(1);
            expect(rejected.defaultPrevented).toBe(kind !== "query-before");
            expect(prevention).toHaveBeenCalledTimes(kind === "query-before" ? 0 : 1);
            expect(replacedQuery).not.toHaveBeenCalled();
            expect(changes).toHaveLength(0);
            expect(options()[1]).toHaveAttribute("aria-selected", "true");
            expect(box).toHaveFocus();
            expect(box).toHaveValue("@");
            expect([box.selectionStart, box.selectionEnd]).toEqual(beforeSelection);
            expect(focus).not.toHaveBeenCalled();
            expect(selection).not.toHaveBeenCalled();
            expect(scroll).not.toHaveBeenCalled();
            expect(api.documents.comment).not.toHaveBeenCalled();
            expect(api.documents.createRequest).not.toHaveBeenCalled();
            expect(session!.comments.list()).toHaveLength(0);
            wrappers.restore();
            prevention.mockClear();
            const clean = mentionKey(box, "End");
            changes.push(...observer.takeRecords());
            expect(clean.defaultPrevented).toBe(true);
            expect(prevention).toHaveBeenCalledOnce();
            expect(changes).toHaveLength(1);
            expect(options()[2]).toHaveAttribute("aria-selected", "true");
          } finally {
            observer.disconnect();
            wrappers.restore();
          }
        },
      );

      it("keeps the rightful native pair through crossed and nested genuine keys", async () => {
        const preventDefault = vi.spyOn(
          window.Event.prototype,
          "preventDefault",
        );
        const { box, options } = await mountDirectMentions();
        const root = box.parentElement;
        if (!root) throw new Error("The mention composer had no root");
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const rootCapture = reactProperty<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDownCapture");
        const rootBubble = reactProperty<
          (event: ReactKeyboardEvent<HTMLDivElement>) => void
        >(root, "onKeyDown");
        const outer = mentionKeyboardEvent(box, "ArrowUp");
        const nested = mentionKeyboardEvent(box, "End");
        const ownerWindow = box.ownerDocument.defaultView;
        if (!ownerWindow) throw new Error("The mention composer had no owner window");
        const crossBeforeReact = (event: Event) => {
          if (event !== outer) return;
          rootCapture({
            nativeEvent: mentionKeyboardEvent(box, "End"),
          } as ReactKeyboardEvent<HTMLDivElement>);
          rootBubble({
            nativeEvent: outer,
          } as ReactKeyboardEvent<HTMLDivElement>);
          box.dispatchEvent(nested);
        };
        ownerWindow.addEventListener("keydown", crossBeforeReact, true);
        preventDefault.mockClear();
        try {
          act(() => {
            box.dispatchEvent(outer);
          });
        } finally {
          ownerWindow.removeEventListener("keydown", crossBeforeReact, true);
        }

        expect(nested.defaultPrevented).toBe(false);
        expect(outer.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(options()[0]).toHaveAttribute("aria-selected", "true");
      });

      it("does not let an ended stopped delivery fence a rightful successor", async () => {
        const { box, options } = await mountDirectMentions();
        const ownerWindow = box.ownerDocument.defaultView;
        if (!ownerWindow) throw new Error("The mention composer had no owner window");
        const stopped = mentionKeyboardEvent(box, "End");
        const haltAfterPairing = (event: Event) => {
          if (event === stopped) event.stopPropagation();
        };
        ownerWindow.addEventListener("keydown", haltAfterPairing, true);
        try {
          act(() => {
            box.dispatchEvent(stopped);
          });
        } finally {
          ownerWindow.removeEventListener("keydown", haltAfterPairing, true);
        }
        expect(stopped.defaultPrevented).toBe(false);
        expect(options()[0]).toHaveAttribute("aria-selected", "true");

        const rightful = mentionKey(box, "End");
        expect(rightful.defaultPrevented).toBe(true);
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it("survives nested microtask checkpoints before the genuine delivery", async () => {
        const { box, options } = await mountDirectMentions();
        await new Promise<void>((resolve) => {
          queueMicrotask(() => queueMicrotask(resolve));
        });
        const event = mentionKey(box, "End");
        expect(event.defaultPrevented).toBe(true);
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it("excludes reentry from the actual highlight state callback", async () => {
        const preventDefault = vi.spyOn(
          window.Event.prototype,
          "preventDefault",
        );
        const { box, options } = await mountDirectMentions();
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const outer = mentionKeyboardEvent(box, "End");
        const nested = mentionKeyboardEvent(box, "Home");
        preventDefault.mockClear();
        mentionHighlightReentry.callback = () => {
          mentionHighlightReentry.callback = null;
          box.dispatchEvent(nested);
        };
        try {
          act(() => {
            box.dispatchEvent(outer);
          });
        } finally {
          mentionHighlightReentry.callback = null;
        }

        expect(outer.defaultPrevented).toBe(true);
        expect(nested.defaultPrevented).toBe(false);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(options()[2]).toHaveAttribute("aria-selected", "true");

        const clean = mentionKey(box, "Home");
        expect(clean.defaultPrevented).toBe(true);
        expect(options()[0]).toHaveAttribute("aria-selected", "true");
      });

      it("uses the exact Window receiver through a public proxy and removes exact listeners on cleanup", async () => {
        const add = vi.spyOn(window, "addEventListener");
        const remove = vi.spyOn(window, "removeEventListener");
        try {
          const mounted = await mountDirectMentions();
          const { box, options } = mounted;
          const ownerWindow = box.ownerDocument.defaultView as
            | (Window & typeof globalThis)
            | null;
          if (!ownerWindow) throw new Error("The mention composer had no owner window");
          const proxyEvent = mentionKeyboardEvent(box, "End");
          Object.defineProperty(proxyEvent, "view", {
            configurable: true,
            value: new Proxy(ownerWindow, {}),
          });
          act(() => {
            box.dispatchEvent(proxyEvent);
          });
          expect(proxyEvent.defaultPrevented).toBe(false);
          expect(options()[0]).toHaveAttribute("aria-selected", "true");
          const clean = mentionKey(box, "End");
          expect(clean.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");

          const listeners = add.mock.calls
            .filter(
              ([type, listener]) =>
                type === "keydown" &&
                typeof listener === "function" &&
                (listener.name === "onWindowCapture" ||
                  listener.name === "onWindowBubble"),
            )
            .slice(-2);
          expect(listeners).toHaveLength(2);
          remove.mockClear();
          act(() => mounted.root.unmount());
          for (const [type, listener, listenerOptions] of listeners) {
            if (listenerOptions === undefined) {
              expect(remove).toHaveBeenCalledWith(type, listener);
            } else {
              expect(remove).toHaveBeenCalledWith(
                type,
                listener,
                listenerOptions,
              );
            }
          }
          const retired = mentionKeyboardEvent(box, "End");
          act(() => {
            box.dispatchEvent(retired);
          });
          expect(retired.defaultPrevented).toBe(false);
        } finally {
          remove.mockRestore();
          add.mockRestore();
        }
      });

      it("accepts the exact backing Window listener receiver", async () => {
        const ownerWindow = window as Window & typeof globalThis;
        const backingWindow = suggestionEventView(document, ownerWindow);
        const originalAdd = ownerWindow.addEventListener;
        const originalRemove = ownerWindow.removeEventListener;
        const add = vi.fn((...args: Parameters<typeof originalAdd>) =>
          Reflect.apply(originalAdd, backingWindow, args),
        );
        const remove = vi.fn((...args: Parameters<typeof originalRemove>) =>
          Reflect.apply(originalRemove, backingWindow, args),
        );
        const addDescriptor = Object.getOwnPropertyDescriptor(
          ownerWindow,
          "addEventListener",
        );
        const removeDescriptor = Object.getOwnPropertyDescriptor(
          ownerWindow,
          "removeEventListener",
        );
        Object.defineProperty(ownerWindow, "addEventListener", {
          configurable: true,
          value: add,
        });
        Object.defineProperty(ownerWindow, "removeEventListener", {
          configurable: true,
          value: remove,
        });
        try {
          const { box, options } = await mountDirectMentions();
          const event = mentionKeyboardEvent(box, "End", {
            view: backingWindow,
          });
          act(() => {
            box.dispatchEvent(event);
          });
          expect(event.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
        } finally {
          if (addDescriptor) {
            Object.defineProperty(
              ownerWindow,
              "addEventListener",
              addDescriptor,
            );
          } else {
            delete (ownerWindow as { addEventListener?: unknown })
              .addEventListener;
          }
          if (removeDescriptor) {
            Object.defineProperty(
              ownerWindow,
              "removeEventListener",
              removeDescriptor,
            );
          } else {
            delete (ownerWindow as { removeEventListener?: unknown })
              .removeEventListener;
          }
        }
      });

      it.each([
        ["Home", 0],
        ["End", 2],
      ] as const)(
        "%s selects the exact boundary once and is inert there without focus, value, submit, format, or scroll work",
        async (key, destination) => {
          const preventDefault = vi.spyOn(
            window.Event.prototype,
            "preventDefault",
          );
          const focus = vi.spyOn(
            window.HTMLElement.prototype,
            "focus",
          );
          const selection = vi.spyOn(
            window.HTMLTextAreaElement.prototype,
            "setSelectionRange",
          );
          const mounted = await mountDirectMentions();
          const { box, options } = mounted;
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(box).toHaveAttribute(
              "aria-activedescendant",
              options()[1]!.id,
            ),
          );
          const scrollIntoView = Element.prototype
            .scrollIntoView as ReturnType<typeof vi.fn>;
          const activeDescendantChanges: MutationRecord[] = [];
          const observer = new MutationObserver((records) =>
            activeDescendantChanges.push(...records),
          );
          observer.observe(box, {
            attributes: true,
            attributeFilter: ["aria-activedescendant"],
          });
          const beforeValue = box.value;
          const beforeSelection = [box.selectionStart, box.selectionEnd];
          preventDefault.mockClear();
          focus.mockClear();
          selection.mockClear();
          scrollIntoView.mockClear();
          vi.mocked(api.documents.comment).mockClear();
          vi.mocked(api.documents.createRequest).mockClear();

          const accepted = mentionKey(box, key);
          activeDescendantChanges.push(...observer.takeRecords());

          expect(accepted.defaultPrevented).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(options().filter((option) => option.getAttribute("aria-selected") === "true")).toEqual([
            options()[destination],
          ]);
          expect(box).toHaveAttribute(
            "aria-activedescendant",
            options()[destination]!.id,
          );
          expect(activeDescendantChanges).toHaveLength(1);
          expect(box).toHaveFocus();
          expect(box).toHaveValue(beforeValue);
          expect([box.selectionStart, box.selectionEnd]).toEqual(beforeSelection);
          expect(focus).not.toHaveBeenCalled();
          expect(selection).not.toHaveBeenCalled();
          expect(scrollIntoView).not.toHaveBeenCalled();
          expect(api.documents.comment).not.toHaveBeenCalled();
          expect(api.documents.createRequest).not.toHaveBeenCalled();
          expect(session!.comments.list()).toHaveLength(0);

          activeDescendantChanges.length = 0;
          preventDefault.mockClear();
          const inert = mentionKey(box, key);
          activeDescendantChanges.push(...observer.takeRecords());
          observer.disconnect();

          expect(inert.defaultPrevented).toBe(false);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(activeDescendantChanges).toHaveLength(0);
          expect(box).toHaveAttribute(
            "aria-activedescendant",
            options()[destination]!.id,
          );
          expect(box).toHaveValue(beforeValue);
          expect(api.documents.comment).not.toHaveBeenCalled();
          expect(api.documents.createRequest).not.toHaveBeenCalled();
        },
      );

      it.each(["Enter", "Tab"] as const)(
        "retains wrapped arrows and %s picking while Escape only closes the list",
        async (pickKey) => {
          const { box, options } = await mountDirectMentions();
          const first = options()[0]!;
          const last = options()[2]!;

          expect(first).toHaveAttribute("aria-selected", "true");
          mentionKey(box, "ArrowUp");
          expect(last).toHaveAttribute("aria-selected", "true");
          mentionKey(box, "ArrowDown");
          expect(first).toHaveAttribute("aria-selected", "true");
          mentionKey(box, "ArrowDown");
          expect(options()[1]).toHaveAttribute("aria-selected", "true");

          const picked = fireEvent.keyDown(box, { key: pickKey });
          expect(picked).toBe(false);
          expect(box).toHaveValue("@carol ");
          expect(box).toHaveFocus();
          expect(screen.queryByTestId("mention-suggestions")).toBeNull();
          expect(session!.comments.list()).toHaveLength(0);
        },
      );

      it("keeps a current publication across routine rerenders", async () => {
        const { box, options, renderVisit } = await mountDirectMentions();
        const originalRows = options();

        renderVisit("A");

        expect(options()).toEqual(originalRows);
        const accepted = mentionKey(box, "End");
        expect(accepted.defaultPrevented).toBe(true);
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it("keeps accepting wrapped arrows when the only suggestion remains selected", async () => {
        const { box, options } = await mountDirectMentions({
          collaborators: [
            {
              login: "bob",
              role: "editor",
              createdAt: "2026-09-08T00:00:00.000Z",
              name: "Bob",
              image: null,
            },
          ],
          agents: [],
          expectedOptions: 1,
        });

        expect(options()[0]).toHaveAttribute("aria-selected", "true");
        for (const key of ["ArrowDown", "ArrowDown", "ArrowUp"] as const) {
          const accepted = mentionKey(box, key);
          expect(accepted.defaultPrevented).toBe(true);
          expect(options()[0]).toHaveAttribute("aria-selected", "true");
        }
      });

      it("retains Escape close without cancelling the focused composer", async () => {
        const { box } = await mountDirectMentions();
        const escaped = fireEvent.keyDown(box, { key: "Escape" });
        expect(escaped).toBe(false);
        await waitFor(() =>
          expect(screen.queryByTestId("mention-suggestions")).toBeNull(),
        );
        expect(box).toHaveValue("@");
        expect(box).toHaveFocus();
        expect(screen.getByTestId("pending-comment")).toBeInTheDocument();
      });

      it.each(["Home", "End"] as const)(
        "%s rejects modified, repeated, composing, untrusted, fabricated, foreign, canceled, stopped, unfocused, and crossed input before a clean event",
        async (key) => {
          const iframe = document.createElement("iframe");
          document.body.append(iframe);
          const foreignWindow = iframe.contentWindow as
            | (Window & typeof globalThis)
            | null;
          if (!foreignWindow) throw new Error("No foreign event realm");
          const { box, options } = await mountDirectMentions();
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          const unchanged = () => {
            expect(options()[1]).toHaveAttribute("aria-selected", "true");
            expect(box).toHaveAttribute(
              "aria-activedescendant",
              options()[1]!.id,
            );
            expect(box).toHaveValue("@");
            expect(session!.comments.list()).toHaveLength(0);
          };
          const reject = (init: KeyboardEventInit) => {
            const event = mentionKey(box, key, init);
            expect(event.defaultPrevented).toBe(false);
            unchanged();
          };

          for (const init of [
            { ctrlKey: true },
            { altKey: true },
            { metaKey: true },
            { shiftKey: true },
            { repeat: true },
            { isComposing: true },
            { cancelable: false },
            { bubbles: false },
          ] satisfies KeyboardEventInit[]) {
            reject(init);
          }

          const untrusted = new window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          });
          act(() => {
            box.dispatchEvent(untrusted);
          });
          expect(untrusted.defaultPrevented).toBe(false);
          unchanged();

          const canceled = mentionKeyboardEvent(box, key);
          canceled.preventDefault();
          act(() => {
            box.dispatchEvent(canceled);
          });
          unchanged();

          const stopped = mentionKeyboardEvent(box, key);
          stopped.stopPropagation();
          act(() => {
            box.dispatchEvent(stopped);
          });
          expect(stopped.defaultPrevented).toBe(false);
          unchanged();

          const fabricatedPrevent = vi.fn();
          const targetHandler = reactProperty<
            (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
          >(box, "onKeyDown");
          act(() => {
            targetHandler({
              key,
              currentTarget: box,
              target: box,
              preventDefault: fabricatedPrevent,
            } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>);
          });
          expect(fabricatedPrevent).not.toHaveBeenCalled();
          unchanged();

          const foreign = new foreignWindow.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          });
          markRequestModeEventTrusted(foreign);
          act(() => {
            box.dispatchEvent(foreign);
          });
          expect(foreign.defaultPrevented).toBe(false);
          unchanged();
          iframe.remove();

          const submit = screen.getByTestId("comment-submit");
          submit.focus();
          reject({});
          box.focus();
          fireEvent.change(box, { target: { value: "@b" } });
          fireEvent.change(box, { target: { value: "@" } });
          await waitFor(() => expect(options()).toHaveLength(3));
          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );

          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          const rootCapture = reactProperty<
            (event: ReactKeyboardEvent<HTMLDivElement>) => void
          >(root, "onKeyDownCapture");
          const crossedPrevent = vi.fn();
          act(() => {
            rootCapture({
              key,
              currentTarget: root,
              target: box,
              nativeEvent: mentionKeyboardEvent(box, key),
              preventDefault: crossedPrevent,
            } as unknown as ReactKeyboardEvent<HTMLDivElement>);
            targetHandler({
              key,
              currentTarget: box,
              target: box,
              nativeEvent: mentionKeyboardEvent(box, key),
              preventDefault: crossedPrevent,
            } as unknown as ReactKeyboardEvent<HTMLTextAreaElement>);
          });
          expect(crossedPrevent).not.toHaveBeenCalled();
          unchanged();

          const clean = mentionKey(box, key);
          expect(clean.defaultPrevented).toBe(true);
          expect(options()[key === "Home" ? 0 : 2]).toHaveAttribute(
            "aria-selected",
            "true",
          );
        },
      );

      it("rejects a trusted owner-realm event whose public view is a self-window-shaped owner-document lookalike", async () => {
        const preventDefault = vi.spyOn(
          window.Event.prototype,
          "preventDefault",
        );
        const { box, options } = await mountDirectMentions();
        fireEvent.mouseEnter(options()[1]);
        await waitFor(() =>
          expect(options()[1]).toHaveAttribute("aria-selected", "true"),
        );
        const activeDescendant = box.getAttribute("aria-activedescendant");
        const lookalike: Record<string, unknown> = {
          document: box.ownerDocument,
        };
        lookalike.window = lookalike;
        const crossed = mentionKeyboardEvent(box, "End");
        Object.defineProperty(crossed, "view", {
          configurable: true,
          value: lookalike,
        });
        const intrinsicView = Object.getOwnPropertyDescriptor(
          window.UIEvent.prototype,
          "view",
        )?.get;
        if (!intrinsicView) throw new Error("No owner-realm UIEvent view getter");
        expect(intrinsicView.call(crossed)).toBeNull();
        expect(crossed.view).toBe(lookalike);
        preventDefault.mockClear();

        act(() => {
          box.dispatchEvent(crossed);
        });

        expect(crossed.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(options()[1]).toHaveAttribute("aria-selected", "true");
        expect(box).toHaveAttribute("aria-activedescendant", activeDescendant);

        const clean = mentionKey(box, "End");
        expect(clean.defaultPrevented).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(options()[2]).toHaveAttribute("aria-selected", "true");
      });

      it.each(["Home", "End"] as const)(
        "%s binds its exact highlight and React callbacks, claims replay once, and lets the current successor act",
        async (key) => {
          const { box, options } = await mountDirectMentions();
          const root = box.parentElement;
          if (!root) throw new Error("The mention composer had no root");
          const staleRootCapture = reactProperty(root, "onKeyDownCapture");
          const staleRootBubble = reactProperty(root, "onKeyDown");
          const staleTextareaCapture = reactProperty(box, "onKeyDownCapture");
          const staleTextareaBubble = reactProperty(box, "onKeyDown");

          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          const restoreRoot = replaceReactProperties(root, {
            onKeyDownCapture: staleRootCapture,
            onKeyDown: staleRootBubble,
          });
          const restoreTextarea = replaceReactProperties(box, {
            onKeyDownCapture: staleTextareaCapture,
            onKeyDown: staleTextareaBubble,
          });
          const stale = mentionKey(box, key);
          restoreTextarea();
          restoreRoot();
          expect(stale.defaultPrevented).toBe(false);
          expect(options()[1]).toHaveAttribute("aria-selected", "true");

          const accepted = mentionKeyboardEvent(box, key);
          act(() => {
            box.dispatchEvent(accepted);
          });
          expect(accepted.defaultPrevented).toBe(true);
          const destination = key === "Home" ? 0 : 2;
          expect(options()[destination]).toHaveAttribute(
            "aria-selected",
            "true",
          );

          fireEvent.mouseEnter(options()[1]);
          await waitFor(() =>
            expect(options()[1]).toHaveAttribute("aria-selected", "true"),
          );
          act(() => {
            box.dispatchEvent(accepted);
          });
          expect(options()[1]).toHaveAttribute("aria-selected", "true");
          const current = mentionKey(box, key);
          expect(current.defaultPrevented).toBe(true);
          expect(options()[destination]).toHaveAttribute(
            "aria-selected",
            "true",
          );
        },
      );

      it.each([
        [
          "detached and restored row",
          (list: HTMLUListElement, rows: HTMLLIElement[]) => {
            const row = rows[1]!;
            const next = row.nextSibling;
            row.remove();
            list.insertBefore(row, next);
          },
        ],
        [
          "reordered and restored rows",
          (list: HTMLUListElement, rows: HTMLLIElement[]) => {
            const first = rows[0]!;
            const second = rows[1]!;
            list.append(first);
            list.insertBefore(first, second);
          },
        ],
        [
          "replaced and restored row",
          (list: HTMLUListElement, rows: HTMLLIElement[]) => {
            const row = rows[1]!;
            const replacement = row.cloneNode(true);
            list.replaceChild(replacement, row);
            list.replaceChild(row, replacement);
          },
        ],
        [
          "detached and restored list",
          (list: HTMLUListElement) => {
            const parent = list.parentNode;
            const next = list.nextSibling;
            if (!parent) throw new Error("The mention list had no parent");
            list.remove();
            parent.insertBefore(list, next);
          },
        ],
      ] as const)(
        "rejects %s history and recovers only through a clean successor",
        async (_label, mutate) => {
          const { box, list, options } = await mountDirectMentions();
          const originalRows = options();
          mutate(list, originalRows);
          expect(options()).toEqual(originalRows);

          const restored = mentionKey(box, "End");
          expect(restored.defaultPrevented).toBe(false);
          expect(options()[0]).toHaveAttribute("aria-selected", "true");
          expect(box).toHaveAttribute(
            "aria-activedescendant",
            options()[0]!.id,
          );
          expect(box).toHaveValue("@");
          expect(session!.comments.list()).toHaveLength(0);

          const successor = mentionKey(box, "End");
          expect(successor.defaultPrevented).toBe(true);
          expect(options()[2]).toHaveAttribute("aria-selected", "true");
        },
      );

      it("retires owner-realm authority changes, pending submission, cleanup, and partial visit replacement before a clean composer recovers", async () => {
        const pending = deferred<Awaited<ReturnType<typeof api.documents.createRequest>>>();
        vi.mocked(api.documents.createRequest).mockReturnValue(pending.promise);
        const mounted = await mountDirectMentions();
        let { box } = mounted;
        const keyDescriptor = Object.getOwnPropertyDescriptor(
          window.KeyboardEvent.prototype,
          "key",
        );
        if (!keyDescriptor) throw new Error("KeyboardEvent.key had no descriptor");
        Object.defineProperty(window.KeyboardEvent.prototype, "key", {
          ...keyDescriptor,
          get: () => "End",
        });
        const poisoned = mentionKey(box, "End");
        expect(poisoned.defaultPrevented).toBe(false);
        Object.defineProperty(
          window.KeyboardEvent.prototype,
          "key",
          keyDescriptor,
        );
        fireEvent.mouseEnter(mounted.options()[1]);
        const recoveredAuthority = mentionKey(box, "End");
        expect(recoveredAuthority.defaultPrevented).toBe(true);

        fireEvent.change(box, {
          target: { value: "@alice/Copilot-CLI @" },
        });
        await waitFor(() =>
          expect(box).toHaveAttribute("aria-expanded", "true"),
        );
        fireEvent.click(screen.getByTestId("comment-submit"));
        await waitFor(() =>
          expect(api.documents.createRequest).toHaveBeenCalledOnce(),
        );
        expect(box).toBeDisabled();
        const pendingKey = mentionKey(box, "Home");
        expect(pendingKey.defaultPrevented).toBe(false);

        await act(async () => {
          pending.resolve({ request: { id: "request" } } as never);
          await pending.promise;
        });
        await waitFor(() =>
          expect(screen.queryByTestId("pending-comment")).toBeNull(),
        );
        const retiredBox = box;
        act(() => {
          session!.setPendingComment({ from: 16, to: 27 });
          mounted.renderVisit("B");
        });
        box = await waitFor(() => {
          const element = mounted.host.querySelector<HTMLTextAreaElement>(
            '[data-testid="comment-composer"]',
          );
          if (!element || element === retiredBox) {
            throw new Error("The clean successor composer did not mount");
          }
          return element;
        });
        const retiredKey = mentionKeyboardEvent(retiredBox, "End");
        act(() => {
          retiredBox.dispatchEvent(retiredKey);
        });
        expect(retiredKey.defaultPrevented).toBe(false);

        box.focus();
        fireEvent.change(box, { target: { value: "@" } });
        await waitFor(() =>
          expect(box).toHaveAttribute("aria-expanded", "true"),
        );
        const clean = mentionKey(box, "End");
        expect(clean.defaultPrevented).toBe(true);
        const activeId = box.getAttribute("aria-activedescendant");
        const active = activeId
          ? box.ownerDocument.getElementById(activeId)
          : null;
        expect(active).toHaveAttribute("data-login", "alice/Copilot-CLI");
      });
    });

    it("radios: click and arrow keys choose a mode; the choice is what the request is posted with", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI shorter please");
      await screen.findByTestId("composer-agent-row");
      expect(box).toHaveFocus();
      fireEvent.click(screen.getByTestId("composer-mode-comment"));
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "false");
      screen.getByTestId("composer-mode-comment").focus();
      act(() => requestModeKey(screen.getByTestId("composer-mode-comment") as HTMLButtonElement, "ArrowRight"));
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveFocus();
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      act(() => requestModeKey(screen.getByTestId("composer-mode-rewrite") as HTMLButtonElement, "ArrowRight"));
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-checked", "true");
      act(() => requestModeKey(screen.getByTestId("composer-mode-suggest") as HTMLButtonElement, "ArrowLeft"));
      expect(screen.getByTestId("composer-mode-rewrite")).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1].mode).toBe("rewrite");
    });

    describe("request-mode keyboard authority", () => {
      it("pairs distinct genuine React capture and bubble wrappers for one native key", async () => {
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");

        const pair = dispatchRequestModeKeyWithBoundaryProbe(
          suggest,
          "ArrowRight",
        );

        expect(pair.capture).not.toBe(pair.bubble);
        expect(pair.capture.nativeEvent).toBe(pair.nativeEvent);
        expect(pair.bubble.nativeEvent).toBe(pair.nativeEvent);
        expect(pair.capture.isDefaultPrevented()).toBe(false);
        expect(pair.bubble.isDefaultPrevented()).toBe(true);
        expect(pair.nativeEvent.defaultPrevented).toBe(true);
        expect(view.radio("comment")).toHaveFocus();
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
      });

      it("accepts independent phase prototypes, methods and public scalar accessors without private fields", async () => {
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const methods = new Map<
          string,
          Record<
            "preventDefault" | "isDefaultPrevented" | "isPropagationStopped",
            (...args: never[]) => unknown
          >
        >();
        const receivers: object[] = [];

        const pair = dispatchRequestModeKeyWithBoundaryProbe(
          suggest,
          "ArrowRight",
          (phase, event) => {
            if (!phase.endsWith("before")) return;
            Object.setPrototypeOf(
              event,
              Object.create(Object.getPrototypeOf(event)),
            );
            const key = event.key;
            const code = event.code;
            Object.defineProperties(event, {
              key: {
                configurable: true,
                enumerable: true,
                get: () => key,
              },
              code: {
                configurable: true,
                enumerable: true,
                get: () => code,
              },
              _reactName: {
                configurable: true,
                value: undefined,
              },
              persist: {
                configurable: true,
                value: "not a function",
              },
              isPersistent: {
                configurable: true,
                value: null,
              },
              stopPropagation: {
                configurable: true,
                value: { ignored: true },
              },
            });
            const originals = {
              preventDefault: event.preventDefault,
              isDefaultPrevented: event.isDefaultPrevented,
              isPropagationStopped: event.isPropagationStopped,
            };
            const replacements = Object.fromEntries(
              Object.entries(originals).map(([name, original]) => [
                name,
                function (this: object) {
                  receivers.push(this);
                  return Reflect.apply(original, this, []);
                },
              ]),
            ) as Record<
              keyof typeof originals,
              (...args: never[]) => unknown
            >;
            for (const [name, replacement] of Object.entries(replacements)) {
              Object.defineProperty(event, name, {
                configurable: true,
                enumerable: true,
                value: replacement,
                writable: true,
              });
            }
            methods.set(phase, replacements);
          },
        );

        expect(pair.capture).not.toBe(pair.bubble);
        expect(Object.getPrototypeOf(pair.capture)).not.toBe(
          Object.getPrototypeOf(pair.bubble),
        );
        expect(methods.get("capture-before")?.preventDefault).not.toBe(
          methods.get("bubble-before")?.preventDefault,
        );
        expect(methods.get("capture-before")?.isDefaultPrevented).not.toBe(
          methods.get("bubble-before")?.isDefaultPrevented,
        );
        expect(methods.get("capture-before")?.isPropagationStopped).not.toBe(
          methods.get("bubble-before")?.isPropagationStopped,
        );
        expect(receivers.length).toBeGreaterThanOrEqual(5);
        expect(
          receivers.every(
            (receiver) => receiver === pair.capture || receiver === pair.bubble,
          ),
        ).toBe(true);
        expect(pair.nativeEvent.defaultPrevented).toBe(true);
        expect(view.radio("comment")).toHaveFocus();
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
      });

      it("keeps an exact pair across nested microtask checkpoints between React phases", async () => {
        const checkpoint = vi
          .spyOn(window, "queueMicrotask")
          .mockImplementation((callback: VoidFunction) => callback());
        const view = await mountDirectRequestModes();
        const pair = dispatchRequestModeKeyWithBoundaryProbe(
          view.radio("suggest"),
          "ArrowRight",
          (phase) => {
            if (phase !== "capture-after") return;
            window.queueMicrotask(() => {
              window.queueMicrotask(() => undefined);
            });
          },
        );

        expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(pair.nativeEvent.defaultPrevented).toBe(true);
        expect(view.radio("comment")).toHaveFocus();
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
      });

      it("binds the exact backing Window receiver, rejects a lookalike and removes the listener on cleanup", async () => {
        const additions = vi.spyOn(window, "addEventListener");
        const removals = vi.spyOn(window, "removeEventListener");
        const view = await mountDirectRequestModes();
        const listener = additions.mock.calls
          .filter(
            ([type, candidate, options]) =>
              type === "keydown" &&
              options === true &&
              typeof candidate === "function" &&
              !removals.mock.calls.some(
                ([removedType, removedCandidate, removedOptions]) =>
                  removedType === type &&
                  removedCandidate === candidate &&
                  removedOptions === options,
              ),
          )
          .map(([, candidate]) => candidate)
          .at(-1);
        if (typeof listener !== "function") {
          throw new Error("No request-mode Window capture listener was added");
        }
        const suggest = view.radio("suggest");
        const lookalike = Object.create(
          Object.getPrototypeOf(window),
        ) as Record<string, unknown>;
        Object.defineProperties(lookalike, {
          document: { configurable: true, value: document },
          self: { configurable: true, value: lookalike },
          window: { configurable: true, value: lookalike },
        });
        const rejected = requestModeKeyboardEvent(suggest, "ArrowRight");
        suggest.focus();
        act(() => {
          Reflect.apply(listener, lookalike, [rejected]);
        });
        expect(rejected.defaultPrevented).toBe(false);
        expect(suggest).toHaveFocus();
        expect(suggest).toHaveAttribute("aria-checked", "true");

        const receivers: EventTarget[] = [];
        let intrinsicCurrentTarget: EventTarget | null = null;
        let originalTerminal: EventTarget | null = null;
        function observeBackingReceiver(this: EventTarget, event: Event) {
          receivers.push(this);
          intrinsicCurrentTarget = event.currentTarget;
          originalTerminal = event.composedPath().at(-1) ?? null;
        }
        window.addEventListener("keydown", observeBackingReceiver, true);
        try {
          act(() => requestModeKey(suggest, "ArrowRight"));
        } finally {
          window.removeEventListener(
            "keydown",
            observeBackingReceiver,
            true,
          );
        }
        expect(receivers).toHaveLength(1);
        expect(receivers[0]).toBe(intrinsicCurrentTarget);
        expect(receivers[0]).toBe(originalTerminal);
        expect(view.radio("comment")).toHaveFocus();
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");

        act(() => view.root.unmount());
        const trackedView = directRequestModeViews.findIndex(
          (candidate) => candidate.root === view.root,
        );
        if (trackedView >= 0) directRequestModeViews.splice(trackedView, 1);
        view.host.remove();
        expect(removals).toHaveBeenCalledWith("keydown", listener, true);
      });

      it("does not let wrong-source capture or crossed bubble delivery consume the rightful pair", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const comment = view.radio("comment");
        const wrongCapture = requestModeCaptureHandler(comment);
        const wrongBubble = requestModeHandler(comment);
        suggest.focus();
        focus.mockClear();

        const pair = dispatchRequestModeKeyWithBoundaryProbe(
          suggest,
          "ArrowRight",
          (phase, event) => {
            if (phase === "capture-before") wrongCapture(event);
            if (phase === "capture-after") wrongBubble(event);
          },
          false,
        );

        expect(pair.nativeEvent.defaultPrevented).toBe(true);
        expect(comment).toHaveFocus();
        expect(comment).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it.each([
        ["capture default query", "capture-before", "isDefaultPrevented"],
        ["capture propagation query", "capture-before", "isPropagationStopped"],
        ["bubble default query", "bubble-before", "isDefaultPrevented"],
        ["bubble propagation query", "bubble-before", "isPropagationStopped"],
        ["bubble prevention", "bubble-before", "preventDefault"],
      ] as const)(
        "excludes reentry during the public %s and accepts only the outer event",
        async (_attempt, alteredPhase, property) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
          const view = await mountDirectRequestModes();
          const suggest = view.radio("suggest");
          suggest.focus();
          focus.mockClear();
          preventDefault.mockClear();
          let reentered = false;
          let nestedDefaultPrevented: boolean | null = null;

          const pair = dispatchRequestModeKeyWithBoundaryProbe(
            suggest,
            "ArrowRight",
            (phase, event) => {
              if (phase !== alteredPhase) return;
              const original = event[property];
              Object.defineProperty(event, property, {
                configurable: true,
                enumerable: true,
                value: function (this: object) {
                  if (!reentered) {
                    reentered = true;
                    nestedDefaultPrevented =
                      requestModeKey(suggest, "ArrowRight").defaultPrevented;
                  }
                  return Reflect.apply(original, this, []);
                },
                writable: true,
              });
            },
            false,
          );

          expect(reentered).toBe(true);
          expect(nestedDefaultPrevented).toBe(false);
          expect(pair.nativeEvent.defaultPrevented).toBe(true);
          expect(view.radio("comment")).toHaveFocus();
          expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
          expect(preventDefault).toHaveBeenCalledTimes(1);
          expect(focus).toHaveBeenCalledTimes(1);
        },
      );

      it.each([
        ["capture default query", "capture-before", "isDefaultPrevented"],
        ["capture propagation query", "capture-before", "isPropagationStopped"],
        ["bubble default query", "bubble-before", "isDefaultPrevented"],
        ["bubble propagation query", "bubble-before", "isPropagationStopped"],
        ["bubble prevention", "bubble-before", "preventDefault"],
      ] as const)(
        "rejects method replacement after the public %s, then accepts a fresh event",
        async (_attempt, alteredPhase, property) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const view = await mountDirectRequestModes();
          const suggest = view.radio("suggest");
          suggest.focus();
          focus.mockClear();

          const rejected = dispatchRequestModeKeyWithBoundaryProbe(
            suggest,
            "ArrowRight",
            (phase, event) => {
              if (phase !== alteredPhase) return;
              const original = event[property];
              Object.defineProperty(event, property, {
                configurable: true,
                enumerable: true,
                value: function (this: object) {
                  const result = Reflect.apply(original, this, []);
                  Object.defineProperty(this, property, {
                    configurable: true,
                    enumerable: true,
                    value: () => result,
                    writable: true,
                  });
                  return result;
                },
                writable: true,
              });
            },
            false,
          );

          expect(rejected.nativeEvent.defaultPrevented).toBe(
            property === "preventDefault",
          );
          expect(suggest).toHaveFocus();
          expect(suggest).toHaveAttribute("aria-checked", "true");
          expect(focus).not.toHaveBeenCalled();

          act(() => requestModeKey(suggest, "ArrowRight"));
          expect(view.radio("comment")).toHaveFocus();
          expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
          expect(focus).toHaveBeenCalledTimes(1);
        },
      );

      it.each([
        ["capture query", "capture-before", "isDefaultPrevented"],
        ["bubble query", "bubble-before", "isDefaultPrevented"],
        ["prevention", "bubble-before", "preventDefault"],
      ] as const)(
        "rejects a throwing public %s without poisoning a clean event",
        async (_attempt, alteredPhase, property) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const view = await mountDirectRequestModes();
          const suggest = view.radio("suggest");
          suggest.focus();
          focus.mockClear();

          const rejected = dispatchRequestModeKeyWithBoundaryProbe(
            suggest,
            "ArrowRight",
            (phase, event) => {
              if (phase !== alteredPhase) return;
              Object.defineProperty(event, property, {
                configurable: true,
                enumerable: true,
                value: () => {
                  throw new Error("hostile request-mode public method");
                },
                writable: true,
              });
            },
            false,
          );

          expect(rejected.nativeEvent.defaultPrevented).toBe(false);
          expect(suggest).toHaveFocus();
          expect(suggest).toHaveAttribute("aria-checked", "true");
          expect(focus).not.toHaveBeenCalled();

          act(() => requestModeKey(suggest, "ArrowRight"));
          expect(view.radio("comment")).toHaveFocus();
          expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
          expect(focus).toHaveBeenCalledTimes(1);
        },
      );

      it.each([
        ["ArrowRight", "suggest", "comment"],
        ["ArrowDown", "comment", "rewrite"],
        ["ArrowLeft", "rewrite", "comment"],
        ["ArrowUp", "comment", "suggest"],
        ["ArrowRight", "rewrite", "suggest"],
        ["ArrowLeft", "suggest", "rewrite"],
        ["Home", "rewrite", "suggest"],
        ["End", "suggest", "rewrite"],
      ] as const)(
        "moves a direct Strict Mode row once with %s from %s to %s without scrolling",
        async (key, initial, destination) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
          const view = await mountDirectRequestModes();
          if (initial !== "suggest") fireEvent.click(view.radio(initial));
          const source = view.radio(initial);
          source.focus();
          focus.mockClear();
          preventDefault.mockClear();
          const destinationBeforeKey = view.radio(destination);
          const publicFocus = vi.fn();
          Object.defineProperty(destinationBeforeKey, "focus", {
            configurable: true,
            value: publicFocus,
          });
          const beforeScroll = [window.scrollX, window.scrollY];
          expect(["suggest", "comment", "rewrite"].map((mode) => view.radio(mode as AgentRequestMode).tabIndex))
            .toEqual(["suggest", "comment", "rewrite"].map((mode) => mode === initial ? 0 : -1));

          let event!: KeyboardEvent;
          act(() => {
            event = requestModeKey(source, key);
          });

          const selected = view.radio(destination);
          expect(event.defaultPrevented).toBe(true);
          expect(selected).toHaveFocus();
          expect(selected).toHaveAttribute("aria-checked", "true");
          expect(["suggest", "comment", "rewrite"].map((mode) => view.radio(mode as AgentRequestMode).tabIndex))
            .toEqual(["suggest", "comment", "rewrite"].map((mode) => mode === destination ? 0 : -1));
          expect(preventDefault).toHaveBeenCalledTimes(1);
          expect(focus).toHaveBeenCalledTimes(1);
          expect(focus.mock.instances[0]).toBe(selected);
          expect(focus).toHaveBeenCalledWith({ preventScroll: true });
          expect(publicFocus).not.toHaveBeenCalled();
          expect([window.scrollX, window.scrollY]).toEqual(beforeScroll);
          expect(api.documents.comment).not.toHaveBeenCalled();
          expect(api.documents.createRequest).not.toHaveBeenCalled();
        },
      );

      it.each([
        ["Home", "suggest"],
        ["End", "rewrite"],
      ] as const)("leaves an already-focused %s destination inert", async (key, mode) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        if (mode !== "suggest") fireEvent.click(view.radio(mode));
        const source = view.radio(mode);
        source.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const event = requestModeKey(source, key);

        expect(event.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(source).toHaveAttribute("aria-checked", "true");
      });

      it("focuses restricted destinations without selecting them and keeps one roving tab stop", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const view = await mountDirectRequestModes({ role: "commenter" });
        const comment = view.radio("comment");
        const suggest = view.radio("suggest");
        const rewrite = view.radio("rewrite");
        comment.focus();
        focus.mockClear();

        let previous!: KeyboardEvent;
        act(() => {
          previous = requestModeKey(comment, "ArrowLeft");
        });

        expect(previous.defaultPrevented).toBe(true);
        expect(suggest).toHaveFocus();
        expect(suggest).toHaveAttribute("aria-disabled", "true");
        expect(suggest).toHaveAttribute("aria-checked", "false");
        expect(comment).toHaveAttribute("aria-checked", "true");
        expect([suggest.tabIndex, comment.tabIndex, rewrite.tabIndex]).toEqual([-1, 0, -1]);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });

        focus.mockClear();
        let next!: KeyboardEvent;
        act(() => {
          next = requestModeKey(suggest, "ArrowRight");
        });
        expect(next.defaultPrevented).toBe(true);
        expect(comment).toHaveFocus();
        expect(comment).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it("keeps native pointer selection and request submission unchanged", async () => {
        const view = await mountDirectRequestModes();
        const rewrite = view.radio("rewrite");

        fireEvent.click(rewrite);

        expect(rewrite).toHaveAttribute("aria-checked", "true");
        expect(rewrite.tabIndex).toBe(0);
        fireEvent.click(view.host.querySelector('[data-testid="comment-submit"]')!);
        await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
        expect(vi.mocked(api.documents.createRequest).mock.calls[0][1].mode).toBe("rewrite");
      });

      it("uses captured owner-realm composedPath and focus intrinsics with public bubble prevention", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const comment = view.radio("comment");
        const handler = requestModeHandler(suggest);
        const propsKey = Object.keys(suggest).find((key) =>
          key.startsWith("__reactProps$"),
        );
        if (!propsKey) {
          throw new Error("React props were not attached to the request mode");
        }
        const record = suggest as unknown as Record<
          string,
          Record<string, unknown>
        >;
        const props = record[propsKey];
        const publicPreventDefault = vi.fn<
          ReactKeyboardEvent<HTMLButtonElement>["preventDefault"]
        >();
        record[propsKey] = {
          ...props,
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
            const original = event.preventDefault;
            publicPreventDefault.mockImplementation(function (this: object) {
              return Reflect.apply(original, this, []);
            });
            Object.defineProperty(event, "preventDefault", {
              configurable: true,
              value: publicPreventDefault,
            });
            handler(event);
          },
        };
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = requestModeKeyboardEvent(suggest, "ArrowRight");
        const publicComposedPath = vi.fn(() => []);
        const publicFocus = vi.fn();
        Object.defineProperty(event, "composedPath", {
          configurable: true,
          value: publicComposedPath,
        });
        Object.defineProperty(comment, "focus", {
          configurable: true,
          value: publicFocus,
        });

        act(() => suggest.dispatchEvent(event));
        record[propsKey] = props;

        expect(event.defaultPrevented).toBe(true);
        expect(comment).toHaveAttribute("aria-checked", "true");
        expect(comment).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(publicComposedPath).not.toHaveBeenCalled();
        expect(publicPreventDefault).toHaveBeenCalledTimes(1);
        expect(publicFocus).not.toHaveBeenCalled();
      });

      it("rejects a replaced public native key before accepting a fresh genuine pair", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const comment = view.radio("comment");
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const replaced = requestModeKeyboardEvent(suggest, "ArrowRight");
        Object.defineProperty(replaced, "key", {
          configurable: true,
          value: "End",
        });

        act(() => suggest.dispatchEvent(replaced));

        expect(replaced.defaultPrevented).toBe(false);
        expect(suggest).toHaveFocus();
        expect(suggest).toHaveAttribute("aria-checked", "true");
        expect(comment).toHaveAttribute("aria-checked", "false");
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();

        act(() => requestModeKey(suggest, "ArrowRight"));

        expect(comment).toHaveFocus();
        expect(comment).toHaveAttribute("aria-checked", "true");
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it("rejects a replacement React wrapper predicate before accepting the genuine pair", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const handler = requestModeHandler(suggest);
        const propsKey = Object.keys(suggest).find((key) => key.startsWith("__reactProps$"));
        if (!propsKey) throw new Error("React props were not attached to the request mode");
        const record = suggest as unknown as Record<string, Record<string, unknown>>;
        const props = record[propsKey];
        record[propsKey] = {
          ...props,
          onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
            handler(
              new Proxy(event, {
                get(target, property, receiver) {
                  if (property === "isDefaultPrevented") return () => true;
                  return Reflect.get(target, property, receiver);
                },
              }),
            ),
        };
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const replaced = requestModeKey(suggest, "ArrowRight");
        record[propsKey] = props;

        expect(replaced.defaultPrevented).toBe(false);
        expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();

        act(() => requestModeKey(suggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it.each([
        ["Alt-modified", { altKey: true }],
        ["Control-modified", { ctrlKey: true }],
        ["Meta-modified", { metaKey: true }],
        ["Shift-modified", { shiftKey: true }],
        ["repeating", { repeat: true }],
        ["composing", { isComposing: true }],
        ["non-bubbling", { bubbles: false }],
        ["non-cancelable", { cancelable: false }],
      ] as const)("rejects a %s key without prevention, focus or mode work", async (_name, init) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const event = requestModeKey(suggest, "ArrowRight", init);

        expect(event.defaultPrevented).toBe(false);
        expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => requestModeKey(suggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
      });

      it.each(["prevented", "propagation-stopped"] as const)(
        "rejects a previously %s key and leaves the clean publication usable",
        async (state) => {
          const focus = vi.spyOn(HTMLElement.prototype, "focus");
          const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
          const view = await mountDirectRequestModes();
          const suggest = view.radio("suggest");
          suggest.focus();
          focus.mockClear();
          const event = requestModeKeyboardEvent(suggest, "ArrowRight");
          if (state === "prevented") event.preventDefault();
          else event.stopPropagation();
          preventDefault.mockClear();

          act(() => suggest.dispatchEvent(event));

          expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");
          expect(focus).not.toHaveBeenCalled();
          expect(preventDefault).not.toHaveBeenCalled();
          act(() => requestModeKey(suggest, "ArrowRight"));
          expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        },
      );

      it("rejects untrusted, fabricated and foreign-realm events before one owner-realm event", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const handler = requestModeHandler(suggest);
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const untrusted = new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        });
        const nativeForFabrication = requestModeKeyboardEvent(suggest, "ArrowRight");
        const fabricated = {
          type: "keydown",
          currentTarget: suggest,
          target: suggest,
          nativeEvent: nativeForFabrication,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
        const frame = document.createElement("iframe");
        document.body.append(frame);
        const foreignWindow = frame.contentDocument?.defaultView;
        if (!foreignWindow) throw new Error("The foreign request-mode realm did not mount");
        const foreign = new foreignWindow.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        });
        markRequestModeEventTrusted(foreign);

        act(() => {
          suggest.dispatchEvent(untrusted);
          handler(fabricated);
          suggest.dispatchEvent(foreign);
        });

        expect(untrusted.defaultPrevented).toBe(false);
        expect(nativeForFabrication.defaultPrevented).toBe(false);
        expect(foreign.defaultPrevented).toBe(false);
        expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => requestModeKey(suggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        frame.remove();
      });

      it("claims the publication, action, React event and native event before replay", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const event = requestModeKeyboardEvent(suggest, "ArrowRight");

        act(() => {
          suggest.dispatchEvent(event);
          view.radio("comment").dispatchEvent(event);
        });

        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
        expect(preventDefault).toHaveBeenCalledTimes(1);
      });

      it("rejects wrong focus and a stale value/mode callback without poisoning current controls", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const staleHandler = requestModeHandler(suggest);
        view.box.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const wrongFocus = requestModeKey(suggest, "ArrowRight");
        expect(wrongFocus.defaultPrevented).toBe(false);
        expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");

        fireEvent.change(view.box, {
          target: { value: "@alice/Copilot-CLI changed current value" },
        });
        fireEvent.click(view.radio("comment"));
        const currentSuggest = view.radio("suggest");
        const propsKey = Object.keys(currentSuggest).find((key) => key.startsWith("__reactProps$"));
        if (!propsKey) throw new Error("React props were not attached to the current request mode");
        const record = currentSuggest as unknown as Record<string, Record<string, unknown>>;
        const props = record[propsKey];
        record[propsKey] = { ...props, onKeyDown: staleHandler };
        currentSuggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        const staleEvent = requestModeKey(currentSuggest, "ArrowRight");
        record[propsKey] = props;

        expect(staleEvent.defaultPrevented).toBe(false);
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();

        currentSuggest.focus();
        focus.mockClear();
        act(() => requestModeKey(currentSuggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveFocus();
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it("rejects stale agent order and permission facts, then accepts the committed successor", async () => {
        const second = {
          ...AGENT,
          name: "Second",
          login: "alice/Second",
        };
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes({
          agents: [AGENT, second],
          value: "@alice/Copilot-CLI @alice/Second tighten this",
        });
        const suggest = view.radio("suggest");
        const staleHandler = requestModeHandler(suggest);
        fireEvent.change(view.box, {
          target: { value: "@alice/Second @alice/Copilot-CLI tighten this" },
        });
        act(() => session!.setMode("viewing"));
        await waitFor(() => expect(view.radio("suggest")).toHaveAttribute("aria-disabled", "true"));
        const currentSuggest = view.radio("suggest");
        const propsKey = Object.keys(currentSuggest).find((key) => key.startsWith("__reactProps$"));
        if (!propsKey) throw new Error("React props were not attached to the permission successor");
        const record = currentSuggest as unknown as Record<string, Record<string, unknown>>;
        const props = record[propsKey];
        record[propsKey] = { ...props, onKeyDown: staleHandler };
        currentSuggest.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const rejected = requestModeKey(currentSuggest, "ArrowRight");
        record[propsKey] = props;

        expect(rejected.defaultPrevented).toBe(false);
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        act(() => requestModeKey(currentSuggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveFocus();
      });

      it.each([
        "detached and reinserted group",
        "reordered and restored radios",
        "replaced and restored radio",
        "changed and restored radio",
      ] as const)("retires %s and lets a distinct clean composer recover", async (mutation) => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const group = view.group();
        const suggest = view.radio("suggest");
        const rewrite = view.radio("rewrite");
        if (mutation === "detached and reinserted group") {
          const parent = group.parentNode!;
          const next = group.nextSibling;
          group.remove();
          parent.insertBefore(group, next);
        } else if (mutation === "reordered and restored radios") {
          group.insertBefore(rewrite, suggest);
          group.append(rewrite);
        } else if (mutation === "replaced and restored radio") {
          const replacement = suggest.cloneNode(true);
          const Button = suggest.ownerDocument.defaultView?.HTMLButtonElement;
          if (!Button || !(replacement instanceof Button)) {
            throw new Error("The replacement request mode was not a button");
          }
          suggest.replaceWith(replacement);
          replacement.replaceWith(suggest);
        } else {
          suggest.setAttribute("aria-checked", "false");
          suggest.setAttribute("aria-checked", "true");
        }
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();

        let rejected!: globalThis.KeyboardEvent;
        act(() => {
          rejected = requestModeKey(suggest, "ArrowRight");
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(view.radio("suggest")).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();

        view.renderVisit("B");
        const currentBox = await waitFor(() => {
          const element = view.host.querySelector<HTMLTextAreaElement>('[data-testid="comment-composer"]');
          if (!element) throw new Error("The clean successor composer did not mount");
          return element;
        });
        fireEvent.change(currentBox, {
          target: { value: "@alice/Copilot-CLI clean successor" },
        });
        await waitFor(() => expect(view.radio("suggest")).toBeInTheDocument());
        const currentSuggest = view.radio("suggest");
        currentSuggest.focus();
        focus.mockClear();
        act(() => requestModeKey(currentSuggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it("rejects a partial ref replay after Window staging and lets a distinct composer recover", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const view = await mountDirectRequestModes();
        const suggest = view.radio("suggest");
        const ref = requestModeButtonRef(suggest);
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();
        function replayOneRef() {
          ref(null);
          ref(suggest);
        }
        window.addEventListener("keydown", replayOneRef, {
          capture: true,
          once: true,
        });

        let rejected!: globalThis.KeyboardEvent;
        act(() => {
          rejected = requestModeKey(suggest, "ArrowRight");
        });

        expect(rejected.defaultPrevented).toBe(false);
        expect(suggest).toHaveFocus();
        expect(suggest).toHaveAttribute("aria-checked", "true");
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();

        view.renderVisit("B");
        const currentBox = await waitFor(() => {
          const element = view.host.querySelector<HTMLTextAreaElement>(
            '[data-testid="comment-composer"]',
          );
          if (!element) {
            throw new Error("The clean request-mode composer did not mount");
          }
          return element;
        });
        fireEvent.change(currentBox, {
          target: { value: "@alice/Copilot-CLI clean ref successor" },
        });
        await waitFor(() => expect(view.radio("suggest")).toBeInTheDocument());
        const currentSuggest = view.radio("suggest");
        currentSuggest.focus();
        focus.mockClear();
        act(() => requestModeKey(currentSuggest, "ArrowRight"));
        expect(view.radio("comment")).toHaveFocus();
        expect(view.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });

      it("does no keyboard work while pending or after cleanup, and a clean composer recovers", async () => {
        const focus = vi.spyOn(HTMLElement.prototype, "focus");
        const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
        const pending = deferred<string>();
        const view = await mountDirectRequestModes();
        vi.spyOn(session!.comments, "add").mockReturnValue(pending.promise as unknown as string);
        const suggest = view.radio("suggest");
        const staleHandler = requestModeHandler(suggest);
        fireEvent.click(view.host.querySelector('[data-testid="comment-submit"]')!);
        await waitFor(() => expect(view.radio("suggest")).toBeDisabled());
        suggest.focus();
        focus.mockClear();
        preventDefault.mockClear();

        const pendingEvent = requestModeKey(suggest, "ArrowRight");

        expect(pendingEvent.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        const retiredSession = session!;
        act(() => view.root.unmount());
        const trackedView = directRequestModeViews.findIndex((candidate) => candidate.root === view.root);
        if (trackedView >= 0) directRequestModeViews.splice(trackedView, 1);
        view.host.remove();
        const afterCleanup = requestModeKeyboardEvent(suggest, "ArrowRight");
        const fabricated = {
          type: "keydown",
          currentTarget: suggest,
          target: suggest,
          nativeEvent: afterCleanup,
        } as unknown as ReactKeyboardEvent<HTMLButtonElement>;
        staleHandler(fabricated);
        expect(afterCleanup.defaultPrevented).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        expect(preventDefault).not.toHaveBeenCalled();
        await act(async () => pending.resolve("thread"));

        auxiliarySessions.push(retiredSession);
        session = null;
        const clean = await mountDirectRequestModes();
        const cleanSuggest = clean.radio("suggest");
        cleanSuggest.focus();
        focus.mockClear();
        act(() => requestModeKey(cleanSuggest, "ArrowRight"));
        expect(clean.radio("comment")).toHaveAttribute("aria-checked", "true");
        expect(focus).toHaveBeenCalledTimes(1);
      });
    });

    it("a commenter can only ask for comments: the other modes are disabled with a tooltip and Comment only is preselected", async () => {
      // Alice opened her agent to collaborators (#1296); otherwise Carol could not send at all (see the locked-agent tests).
      mount({ role: "commenter", me: { id: "carol", name: "Carol", login: "carol" }, agents: [{ ...AGENT, collaboratorsMayAsk: true }] });
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI is this right?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.queryByTestId("agent-owner-only")).toBeNull();
      // Someone else's agent is named with its owner.
      expect(screen.getByRole("radiogroup", { name: "How should Alice's Copilot CLI answer?" })).toBeInTheDocument();
      const suggest = screen.getByTestId("composer-mode-suggest");
      const rewrite = screen.getByTestId("composer-mode-rewrite");
      const comment = screen.getByTestId("composer-mode-comment");
      expect(suggest).toHaveAttribute("aria-disabled", "true");
      expect(rewrite).toHaveAttribute("aria-disabled", "true");
      expect(comment).not.toHaveAttribute("aria-disabled");
      expect(comment).toHaveAttribute("aria-checked", "true");
      // Disabled radios are not `disabled`: they can take focus, and then say why.
      fireEvent.click(suggest);
      expect(comment).toHaveAttribute("aria-checked", "true");
      act(() => suggest.focus());
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Needs edit access");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const [, payload] = vi.mocked(api.documents.createRequest).mock.calls[0];
      expect(payload.mode).toBe("comment");
      expect(payload.threadId).toBe("via-api");
    });

    it("an editor in viewing mode is treated like a commenter (session.canEdit is mode-aware)", async () => {
      mount({ role: "editor", viewing: true });
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI ok?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByTestId("composer-mode-suggest")).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
    });

    it("posting a comment that mentions an agent creates exactly one request with the thread, quote, range and cleaned instruction — and no 'Sent to agents' toast", async () => {
      const { onToast } = mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI   @bob  tighten this\nplease  ");
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const threads = session!.comments.list();
      expect(threads).toHaveLength(1);
      expect(threads[0].body).toBe("@alice/Copilot-CLI   @bob  tighten this\nplease");
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "suggest",
        instruction: "@bob tighten this please",
        selection: { from: 16, to: 27, quote: "quick brown" },
        threadId: threads[0].id,
        // The first agent mention is the addressee (#1296); the server verifies it against a live token.
        agent: "alice/Copilot-CLI",
      });
      expect(onToast).not.toHaveBeenCalled();
      // The composer closed as it always does.
      expect(screen.queryByTestId("pending-comment")).toBeNull();
    });

    it("a mention that is nothing but the mention still carries an instruction", () => {
      expect(requestInstruction("@alice/Copilot-CLI")).toBe("Please take a look at this.");
      expect(requestInstruction("  @alice/Copilot-CLI \n ")).toBe("Please take a look at this.");
      expect(requestInstruction("@bob and @alice/Copilot-CLI: check  the  numbers")).toBe("@bob and : check the numbers");
    });

    it("a comment without an agent mention never posts a request", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@bob looks fine to me");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(session!.comments.list()).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(api.documents.createRequest).not.toHaveBeenCalled();
    });

    it("retries a 404 while the server catches up, and says so (comment kept) when the request never lands", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { onToast } = mount();
        const box = await openComposer();
        await type(box, "@alice/Copilot-CLI hi");
        await screen.findByTestId("composer-agent-row");
        const notFound = Object.assign(new Error("Comment not found"), { status: 404 });
        vi.mocked(api.documents.createRequest).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockResolvedValueOnce({ request: { id: "r" } } as never);
        fireEvent.click(screen.getByTestId("comment-submit"));
        await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
        await act(() => vi.advanceTimersByTimeAsync(300));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(2);
        await act(() => vi.advanceTimersByTimeAsync(600));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(3);
        await act(() => vi.advanceTimersByTimeAsync(1500));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(3);
        expect(onToast).not.toHaveBeenCalled();
        expect(session!.comments.list()).toHaveLength(1);

        // Four 404s in a row: give up, keep the comment, tell the user. Exactly four (one per attempt) so nothing
        // rejecting is left on the mock for later tests; the fake clock runs every retry inside this test.
        vi.mocked(api.documents.createRequest).mockClear().mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound).mockRejectedValueOnce(notFound);
        act(() => session!.setPendingComment({ from: 0, to: 5 }));
        const again = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
        await type(again, "@alice/Copilot-CLI again");
        await screen.findByTestId("composer-agent-row");
        fireEvent.click(screen.getByTestId("comment-submit"));
        await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
        await act(() => vi.advanceTimersByTimeAsync(2000));
        expect(api.documents.createRequest).toHaveBeenCalledTimes(4);
        expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request did not reach the agent — mention them again.", "error");
        expect(session!.comments.list()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a refused request (403 agent-owner-only, 400 unknown-agent) shows the server's sentence and keeps the comment; no retry (#1296)", async () => {
      const { onToast } = mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI summarise");
      await screen.findByTestId("composer-agent-row");
      const locked = Object.assign(new Error("Alice's Copilot CLI only takes requests from Alice"), { status: 403 });
      vi.mocked(api.documents.createRequest).mockRejectedValueOnce(locked);
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request was refused: Alice's Copilot CLI only takes requests from Alice", "error"));
      expect(api.documents.createRequest).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ agent: "alice/Copilot-CLI", instruction: "summarise" });
      expect(session!.comments.list()).toHaveLength(1);

      const unknown = Object.assign(new Error("Unknown agent @alice/copilot-cli"), { status: 400 });
      vi.mocked(api.documents.createRequest).mockClear().mockRejectedValueOnce(unknown);
      act(() => session!.setPendingComment({ from: 0, to: 5 }));
      const again = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      await type(again, "@alice/Copilot-CLI again");
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(onToast).toHaveBeenCalledWith("The comment is posted, but the request was refused: Unknown agent @alice/copilot-cli", "error"));
      expect(api.documents.createRequest).toHaveBeenCalledTimes(1);
      expect(session!.comments.list()).toHaveLength(2);
    });

    it("does not post before the session is synced", async () => {
      mount();
      session!.synced = false;
      const waited = waitForSynced(session!, 200);
      let settled = false;
      void waited.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false);
      session!.synced = true;
      act(() => session!.setMode("editing"));
      await waited;
      expect(settled).toBe(true);
    });

    it("shows the thread's latest request as a chip: waiting → working → done (with detail), and nothing once cancelled", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
      setMirrors([mirror({ id: "r1", threadId, status: "open" })]);
      const chip = await screen.findByTestId("comment-request-chip");
      expect(chip).toHaveAttribute("data-status", "open");
      expect(chip).toHaveTextContent("Waiting for an agent");
      // The chip is in the header row, before the ⋯ actions.
      const card = screen.getByTestId("comment-thread");
      const order = Array.from(card.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid"));
      expect(order.indexOf("comment-timestamp")).toBeLessThan(order.indexOf("comment-request-chip"));
      expect(order.indexOf("comment-request-chip")).toBeLessThan(order.indexOf("comment-resolve"));
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Copilot CLI is working…"));
      // A newer request on the same thread wins.
      setMirrors([
        mirror({ id: "r1", threadId, status: "done", result: { suggestions: 2, comments: 0 }, updatedAt: Date.now() - 1000 }),
        mirror({ id: "r2", threadId, status: "claimed", claimedBy: "Copilot CLI", updatedAt: Date.now() }),
      ]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveAttribute("data-request-id", "r2"));
      setMirrors([mirror({ id: "r2", threadId, status: "done", result: { suggestions: 2, comments: 1 } })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Done: 2 suggestions, 1 comment"));
      // Detail is for the first minute; older done requests collapse to a plain Done.
      setMirrors([mirror({ id: "r2", threadId, status: "done", result: { suggestions: 2, comments: 1 }, updatedAt: Date.now() - 120_000 })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Done$/));
      setMirrors([mirror({ id: "r2", threadId, status: "cancelled" })]);
      await waitFor(() => expect(screen.queryByTestId("comment-request-chip")).toBeNull());
    });

    it("falls back to the requestId the server stamped on the thread when the mirror has no threadId", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      act(() => session!.comments.ymap.get(threadId)!.set("requestId", "legacy"));
      setMirrors([mirror({ id: "legacy", status: "claimed", claimedBy: "Copilot CLI", threadId: undefined })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveAttribute("data-request-id", "legacy"));
    });

    it("the chip names someone else's agent with its owner — 'Alice's Copilot CLI is working…' — and the owner's own plainly (#1296)", async () => {
      const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice", userId: "drew" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…"));
      // A mirror from before #1296 has no claimedByLogin: nobody knows whose it is, so the bare name stays.
      setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", userId: "drew" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Copilot CLI is working…/));
      cleanup();
      session!.destroy();

      mount();
      const ownThread = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: makeCollabUser("alice", "Alice", null, "alice") });
      setMirrors([mirror({ id: "r2", threadId: ownThread, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice" })]);
      await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent(/^Copilot CLI is working…/));
    });

    describe("the request chip only re-renders for an agent's name (#1382)", () => {
      const remotes: Awareness[] = [];
      afterEach(() => {
        for (const a of remotes.splice(0)) a.destroy();
        vi.mocked(claimerName).mockClear();
        window.localStorage.removeItem(AGENT_CONNECT_DISMISSED_KEY);
      });
      /** How often the chips asked for a claimer's label so far: one call per RequestChip render of a claimed request. */
      const labelCalls = () => vi.mocked(claimerName).mock.calls.length;
      /**
       * Another browser or an agent, as the server relays it: `join` publishes its awareness state into the session's
       * awareness (a person: `login`; an agent: `isAgent` with its owner's `userLogin`/`userName`, the shape
       * src/server/agent-presence.ts writes) and `leave` removes it; each then fires the provider's awareness callback
       * (what Hocuspocus does) and waits a tick so the session's microtask notification and React's render are done.
       */
      const remote = () => {
        const doc = new Y.Doc();
        const awareness = new Awareness(doc);
        remotes.push(awareness);
        const relay = async (change: () => void) => {
          await act(async () => {
            change();
            lastProvider().opts.onAwarenessChange?.({ states: [] });
            await new Promise((r) => setTimeout(r, 0));
          });
        };
        return {
          join: (user: Record<string, unknown>) =>
            relay(() => {
              awareness.setLocalState({ user: { color: "#2563eb", colorLight: "#2563eb33", avatar: null, role: "editor", ...user }, lastActive: Date.now() });
              applyAwarenessUpdate(session!.awareness, encodeAwarenessUpdate(awareness, [doc.clientID]), "server");
            }),
          leave: () => relay(() => removeAwarenessStates(session!.awareness, [doc.clientID], "server")),
        };
      };
      const agentUser = (name: string, ownerLogin: string, ownerName: string | null) => ({ id: `agent:${ownerLogin}:${name}`, name, login: null, role: null, isAgent: true, status: "reading", userLogin: ownerLogin, userName: ownerName });
      // Listed by the collaborators route without its owner's name (Olive is in no one's collaborator list here): the
      // login stands in on the chip until Olive's agent shows up in presence carrying `userName`.
      const SCRIBE = { name: "Scribe", login: "olive/Scribe", ownerLogin: "olive", ownerName: null, present: false, collaboratorsMayAsk: true };
      const chips = () => screen.getAllByTestId("comment-request-chip").map((c) => [c.getAttribute("data-status"), c.getAttribute("data-request-id"), c.textContent]);

      it("does not render unchanged comment cards when document text changes outside their anchors", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const ids = Array.from({ length: 20 }, () => session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user }));
        setMirrors(ids.map((threadId, index) => mirror({
          id: `r${index}`, threadId, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew",
        })));
        await waitFor(() => expect(chips()).toHaveLength(20));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        const before = labelCalls();
        const original = session!.comments.list();
        await act(async () => {
          session!.ytext.insert(session!.ytext.length, "!");
          session!.setMode("suggesting");
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(session!.comments.list().every((thread, index) => thread === original[index])).toBe(true);
        expect(labelCalls() - before).toBe(0);
        expect(chips()).toHaveLength(20);
      });

      it("a person joining or leaving presence never re-renders a claimed chip; an agent's owner name arriving does", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const first = session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user });
        const second = session!.comments.add({ from: 16, to: 27, body: "@olive/Scribe and this", author: user });
        setMirrors([
          mirror({ id: "r1", threadId: first, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
          mirror({ id: "r2", threadId: second, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
        ]);
        await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["olive's Scribe is working…", "olive's Scribe is working…"]));
        // Let a tick pass so the collaborators fetch and the first renders are behind us.
        await act(() => new Promise((r) => setTimeout(r, 20)));
        const chipsBefore = chips();
        const before = labelCalls();
        expect(before).toBeGreaterThan(0);

        // A person joins and leaves: the picker's candidate list changes twice, the chips have nothing new to say.
        const carol = remote();
        await carol.join({ id: "carol", name: "Carol", login: "carol" });
        expect(session!.presence().map((u) => u.login)).toContain("carol");
        expect.soft(labelCalls() - before).toBe(0);
        await carol.leave();
        expect(session!.presence().map((u) => u.login)).not.toContain("carol");
        expect.soft(labelCalls() - before).toBe(0);
        expect(chips()).toEqual(chipsBefore);

        // The same channel does reach the chips when it carries an agent's name.
        const scribe = remote();
        await scribe.join(agentUser("Scribe", "olive", "Olive"));
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["Olive's Scribe is working…", "Olive's Scribe is working…"]));
        expect(labelCalls() - before).toBeGreaterThanOrEqual(2);
      });

      it("your own agent stays bare, also once it is present carrying your name", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [AGENT, SCRIBE] });
        const theirs = session!.comments.add({ from: 0, to: 5, body: "@olive/Scribe shorter", author: user });
        const mine = session!.comments.add({ from: 16, to: 27, body: "@drew/Copilot-CLI and this", author: user });
        setMirrors([
          mirror({ id: "r1", threadId: theirs, status: "claimed", claimedBy: "Scribe", claimedByLogin: "olive", userId: "drew" }),
          mirror({ id: "r2", threadId: mine, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "drew", userId: "drew" }),
        ]);
        await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["olive's Scribe is working…", "Copilot CLI is working…"]));
        const own = remote();
        await own.join(agentUser("Copilot CLI", "drew", "Drew"));
        const scribe = remote();
        await scribe.join(agentUser("Scribe", "olive", "Olive"));
        await waitFor(() => expect(chips().map((c) => c[2])).toEqual(["Olive's Scribe is working…", "Copilot CLI is working…"]));
      });

      it("the picker's own-token fetch and the 'Connect an agent' row appearing and being dismissed never re-render a claimed chip", async () => {
        const { user } = mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
        const threadId = session!.comments.add({ from: 30, to: 35, body: "@alice/Copilot-CLI shorter", author: user });
        setMirrors([mirror({ id: "r1", threadId, status: "claimed", claimedBy: "Copilot CLI", claimedByLogin: "alice", userId: "drew" })]);
        await waitFor(() => expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…"));
        await act(() => new Promise((r) => setTimeout(r, 20)));
        const before = labelCalls();
        // A new-comment composer (outside the card) opens its picker: the panel fetches Drew's tokens, finds none, and
        // `connect.due` flips on; dismissing the row flips it off. Neither concerns the card's chip.
        const box = await openComposer();
        await type(box, "@");
        await screen.findByTestId("mention-connect-row");
        await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect.soft(labelCalls() - before).toBe(0);
        fireEvent.click(screen.getByTestId("mention-connect-dismiss"));
        await waitFor(() => expect(screen.queryByTestId("mention-connect-row")).toBeNull());
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect.soft(labelCalls() - before).toBe(0);
        expect(screen.getByTestId("comment-request-chip")).toHaveTextContent("Alice's Copilot CLI is working…");
      });
    });

    it("the picker greys out an agent its owner keeps to themself; picking it still mentions, but the composer refuses to send (#1296)", async () => {
      mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" } });
      const box = await openComposer();
      await type(box, "@");
      const options = await screen.findAllByTestId("mention-option");
      expect(options.map((o) => o.getAttribute("data-login"))).toEqual(["alice", "bob", "alice/Copilot-CLI"]);
      const [alice, bob, agent] = options;
      expect(alice).not.toHaveAttribute("aria-disabled");
      expect(bob).not.toHaveAttribute("aria-disabled");
      expect(agent).toHaveAttribute("aria-disabled", "true");
      expect(agent).toHaveAttribute("data-locked");
      expect(agent).toHaveAttribute("title", "Only Alice can ask this agent");
      expect(agent).toHaveTextContent("Alice's Copilot CLI");
      expect(agent).toHaveTextContent("owner only");
      expect(screen.getAllByTestId("mention-option").filter((o) => o.hasAttribute("data-locked"))).toHaveLength(1);

      fireEvent.click(agent);
      await waitFor(() => expect(box.value).toBe("@alice/Copilot-CLI "));
      await type(box, "tighten this");
      await screen.findByTestId("composer-agent-row");
      const notice = screen.getByTestId("agent-owner-only");
      expect(notice).toHaveTextContent("Alice's Copilot CLI only takes requests from Alice.");
      // A sibling after the row, not inside it: the row stays controls only.
      expect(screen.getByTestId("composer-agent-row").contains(notice)).toBe(false);
      expect(screen.getByTestId("composer-agent-row").nextElementSibling).toBe(notice);
      expect(screen.getByTestId("comment-submit")).toBeDisabled();
      // Enter does nothing either: no comment, no request, no 403 round trip.
      fireEvent.keyDown(box, { key: "Enter" });
      fireEvent.click(screen.getByTestId("comment-submit"));
      await new Promise((r) => setTimeout(r, 30));
      expect(session!.comments.list()).toHaveLength(0);
      expect(api.documents.createRequest).not.toHaveBeenCalled();
      // Take the agent out of the body: the notice goes and the send comes back.
      fireEvent.change(box, { target: { value: "@bob tighten this" } });
      await waitFor(() => expect(screen.queryByTestId("agent-owner-only")).toBeNull());
      expect(screen.getByTestId("comment-submit")).toBeEnabled();
    });

    it("an agent whose owner switched 'Collaborators may ask' on is an ordinary row for others, and the owner's own is never locked (#1296)", async () => {
      mount({ role: "editor", me: { id: "drew", name: "Drew", login: "drew" }, agents: [{ ...AGENT, collaboratorsMayAsk: true }] });
      let box = await openComposer();
      await type(box, "@ali");
      let options = await screen.findAllByTestId("mention-option");
      let agent = options.find((o) => o.getAttribute("data-login") === AGENT.login)!;
      expect(agent).not.toHaveAttribute("aria-disabled");
      expect(agent).not.toHaveAttribute("data-locked");
      expect(agent).toHaveTextContent("Alice's Copilot CLI");
      fireEvent.click(agent);
      await screen.findByTestId("composer-agent-row");
      expect(screen.queryByTestId("agent-owner-only")).toBeNull();
      expect(screen.getByTestId("comment-submit")).toBeEnabled();
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ agent: "alice/Copilot-CLI" });
      cleanup();
      session!.destroy();

      mount();
      box = await openComposer();
      await type(box, "@ali");
      options = await screen.findAllByTestId("mention-option");
      agent = options.find((o) => o.getAttribute("data-login") === AGENT.login)!;
      expect(agent).not.toHaveAttribute("aria-disabled");
      expect(agent).toHaveTextContent(/^Copilot CLIagent$/);
    });

    it.each([
      ["the requester", { id: "carol", name: "Carol", login: "carol" }, "commenter" as Role, true],
      ["the document owner", { id: "alice", name: "Alice", login: "alice" }, "owner" as Role, true],
      ["another collaborator", { id: "bob", name: "Bob", login: "bob" }, "editor" as Role, false],
    ])("the × cancels for %s", async (_who, me, role, canCancel) => {
      const onCancelRequest = vi.fn();
      const { user } = mount({ role, me, onCancelRequest });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "open", userId: "carol" })]);
      await screen.findByTestId("comment-request-chip");
      const cancel = screen.queryByTestId("comment-request-cancel");
      if (!canCancel) {
        expect(cancel).toBeNull();
        return;
      }
      expect(cancel).toHaveAccessibleName("Cancel request");
      fireEvent.click(cancel!);
      expect(onCancelRequest).toHaveBeenCalledWith("r1");
      // Optimistic: the chip is gone at once and the card was not "revealed" by the click.
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
      setMirrors([mirror({ id: "r1", threadId, status: "cancelled", userId: "carol" })]);
      await new Promise((r) => setTimeout(r, 10));
      expect(screen.queryByTestId("comment-request-chip")).toBeNull();
    });

    it("no × once the request is done", async () => {
      const { user } = mount({ onCancelRequest: vi.fn() });
      const threadId = session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "done", result: { suggestions: 1, comments: 0 } })]);
      await screen.findByTestId("comment-request-chip");
      expect(screen.queryByTestId("comment-request-cancel")).toBeNull();
    });

    it("a reply that mentions an agent asks on the thread, preselecting the thread's last mode", async () => {
      const { user } = mount();
      const threadId = session!.comments.add({ from: 16, to: 27, body: "First thoughts", author: user });
      setMirrors([mirror({ id: "r1", threadId, status: "done", mode: "comment", result: { suggestions: 0, comments: 1 } })]);
      await screen.findByTestId("comment-request-chip");
      fireEvent.click(screen.getByTestId("comment-reply"));
      const box = (await screen.findByPlaceholderText("Reply…")) as HTMLTextAreaElement;
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      await type(box, "@alice/Copilot-CLI and the numbers?");
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByTestId("composer-mode-comment")).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "comment",
        instruction: "and the numbers?",
        selection: { from: 16, to: 27, quote: "quick brown" },
        threadId,
        agent: "alice/Copilot-CLI",
      });
      expect(session!.comments.list()[0].replies).toHaveLength(1);
    });

    it("quick-instruction chips insert after the mention and keep the caret in the box", async () => {
      mount();
      const box = await openComposer();
      await type(box, "@alice/Copilot-CLI");
      await screen.findByTestId("composer-agent-row");
      const chips = screen.getAllByTestId("composer-chip");
      const first = chips[0].textContent!;
      fireEvent.click(chips[0]);
      await waitFor(() => expect(box.value).toBe(`@alice/Copilot-CLI ${first}`));
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.selectionStart).toBe(box.value.length);
      // With text past the mention the chip goes at the caret, spaced.
      box.setSelectionRange(box.value.length, box.value.length);
      const second = chips[1].textContent!;
      fireEvent.click(chips[1]);
      await waitFor(() => expect(box.value).toBe(`@alice/Copilot-CLI ${first} ${second}`));
      expect(screen.getByTestId("composer-agent-row")).toBeInTheDocument();
    });

    it("the edit composer never offers the row", async () => {
      const { user } = mount();
      session!.comments.add({ from: 16, to: 27, body: "@alice/Copilot-CLI shorter", author: user });
      // The lazily mounted menu arms and opens on pointer down.
      fireEvent.pointerDown(await screen.findByRole("button", { name: "Comment actions" }), { button: 0 });
      fireEvent.click(await screen.findByText("Edit"));
      const box = (await screen.findByDisplayValue("@alice/Copilot-CLI shorter")) as HTMLTextAreaElement;
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      fireEvent.change(box, { target: { value: "@alice/Copilot-CLI shorter still" } });
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("composer-agent-row")).toBeNull();
    });

    it("mentionedAgents matches the picker's agents case-insensitively, once each, in order", () => {
      const candidates = [
        { login: "bob", name: "Bob", image: null },
        { login: "alice/Copilot-CLI", name: "Copilot CLI", image: null, agent: { ownerLogin: "alice", canAsk: true } },
        { login: "bob/Reviewer", name: "Reviewer", image: null, agent: { ownerLogin: "bob", canAsk: true } },
      ];
      expect(mentionedAgents("@bob/reviewer then @ALICE/copilot-cli and @bob/Reviewer again", candidates).map((c) => c.name)).toEqual(["Reviewer", "Copilot CLI"]);
      expect(mentionedAgents("@bob only, and @alice/Other-Bot", candidates)).toEqual([]);
    });

    it("the picker lists the user's own tokens once it opens, marked as not here yet", async () => {
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [{ id: "t1", name: "Copilot CLI" }, { id: "t2", name: "Night Shift" }] } as never);
      mount();
      const box = await openComposer();
      await new Promise((r) => setTimeout(r, 20));
      // Not on panel mount, nor on opening a composer: only once a picker opens.
      expect(api.tokens.list).not.toHaveBeenCalled();
      await type(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const options = await screen.findAllByTestId("mention-option");
      const logins = options.map((o) => o.getAttribute("data-login"));
      expect(logins).toEqual(["bob", "alice/Copilot-CLI", "alice/Night-Shift"]);
      // The document already knows Copilot CLI (activity): its entry is the ordinary one, not the own-token hint.
      expect(options[1]).not.toHaveAttribute("data-own");
      expect(options[2]).toHaveAttribute("data-own");
      expect(options[2]).toHaveTextContent("your agent · not here yet");
      // Choosing the own token makes the row appear: it is a request too.
      fireEvent.click(options[2]);
      await screen.findByTestId("composer-agent-row");
      expect(screen.getByRole("radiogroup", { name: "How should Night Shift answer?" })).toBeInTheDocument();
    });
  });

  describe("mention candidate identity lifecycle", () => {
    const ownedSessions = new Set<CollabSession>();
    const remoteAwareness = new Set<Awareness>();

    const collaboratorResponse = (opts: {
      owner?: { login: string; name: string; image: null } | null;
      collaborators?: { login: string; name: string | null; image: null }[];
      agents?: CollaboratorsResponse["agents"];
    } = {}) =>
      ({
        owner: opts.owner ?? null,
        collaborators: opts.collaborators ?? [],
        agents: opts.agents ?? [],
      }) as CollaboratorsResponse;

    const tokenResponse = (...names: string[]) =>
      ({
        tokens: names.map((name, index) => ({ id: `token-${index}`, name })),
      }) as TokensResponse;

    const makeSession = (docId: string, name: string, login: string | null) => {
      const user = makeCollabUser(`${docId}-${login ?? "anonymous"}`, name, null, login);
      const next = new CollabSession({ docId, user, role: "owner", getToken: async () => "token", autoConnect: false });
      next.keepAlive();
      next.setPendingComment({ from: 0, to: 0 });
      ownedSessions.add(next);
      session = next;
      return next;
    };

    const addPresence = (target: CollabSession, user: Record<string, unknown>) => {
      const doc = new Y.Doc();
      const awareness = new Awareness(doc);
      remoteAwareness.add(awareness);
      awareness.setLocalState({ user: { color: "#2563eb", colorLight: "#2563eb33", avatar: null, role: "editor", ...user }, lastActive: Date.now() });
      applyAwarenessUpdate(target.awareness, encodeAwarenessUpdate(awareness, [doc.clientID]), "server");
      return awareness;
    };

    const panel = (current: CollabSession) => (
      <TooltipProvider>
        <CommentsPanel session={current} onClose={() => {}} onReveal={() => {}} onConnectAgent={() => {}} />
      </TooltipProvider>
    );

    const mountPanel = (initial: CollabSession) => {
      const view = render(panel(initial));
      return {
        replace(next: CollabSession) {
          session = next;
          view.rerender(panel(next));
        },
        unmount: view.unmount,
      };
    };

    const openPicker = async () => {
      const box = (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
      box.focus();
      await userEvent.setup().paste("@");
      return box;
    };

    const option = (login: string) => screen.queryAllByTestId("mention-option").find((row) => row.getAttribute("data-login") === login);

    beforeEach(() => {
      vi.mocked(api.tokens.list).mockReset().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockReset().mockResolvedValue({ owner: null, collaborators: [], agents: [] } as never);
    });

    afterEach(() => {
      for (const awareness of remoteAwareness) awareness.destroy();
      remoteAwareness.clear();
      for (const owned of ownedSessions) owned.destroy();
      ownedSessions.clear();
      session = null;
      window.localStorage.removeItem(AGENT_CONNECT_DISMISSED_KEY);
      vi.mocked(api.tokens.list).mockReset().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockReset().mockResolvedValue({ owner: null, collaborators: [], agents: [] } as never);
    });

    describe("native mention titles", () => {
      const names = [
        `  Alexandra Long Display Identity with a literal <b title="quoted">"first" & 'name'</b> and enough additional family, team, department, organization, and collaboration detail to remain readable in full even when the narrow mention option clips its visible label.  `,
        `  Beatrice Different Display Identity with a literal <img src="not-an-image">"second" & 'name' and distinct additional family, team, department, organization, and collaboration detail that must survive replacement without leaking the previous person's tooltip.  `,
      ];
      const agentName = "ReviewAgent123456789ReviewAgent123456789ReviewAgent123456789ReviewAgent123456789";
      const absentAgentName = "AbsentAgent123456789AbsentAgent123456789AbsentAgent123456789AbsentAgent123456789";
      const longLogin = "person-12345678901234567890123456789012";
      const agentLogin = (owner: string, name = agentName) => `${owner}/${name.slice(0, 39)}`;
      const nameClass = "min-w-0 flex-1 truncate text-[13px]";
      const loginClass = "truncate text-xs text-ink-3";

      function expectLabel(element: Element | null, text: string, className = nameClass) {
        if (!(element instanceof HTMLSpanElement)) throw new Error("Missing mention label span");
        expect(element.textContent).toBe(text);
        expect(element.getAttribute("title")).toBe(text);
        expect(element.className).toBe(className);
        expect(element.getAttributeNames().sort()).toEqual(["class", "title"]);
        expect(element.children).toHaveLength(0);
        expect(element.tabIndex).toBe(-1);
      }

      function expectName(login: string, name: string) {
        const row = option(login);
        if (!row) throw new Error(`Missing mention option ${login}`);
        expectLabel(row.children.item(1), name);
        return row;
      }

      it.each(["comment", "reply"] as const)("keeps full literal titles and agent reasons without new controls or hover actions in a %s", async (kind) => {
        for (const name of names) expect(name.length).toBeGreaterThanOrEqual(200);
        expect(names[0]).not.toBe(names[1]);
        expect(agentName).toHaveLength(80);
        expect(absentAgentName).toHaveLength(80);
        expect(longLogin).toHaveLength(39);
        vi.mocked(api.documents.collaborators).mockResolvedValue(collaboratorResponse({
          collaborators: [
            { login: longLogin, name: names[0], image: null },
            { login: "beatrice", name: names[1], image: null },
          ],
          agents: [
            { login: agentLogin("alice"), name: agentName, ownerLogin: "alice", ownerName: "Alice", present: true, collaboratorsMayAsk: false },
            { login: agentLogin("allowed"), name: agentName, ownerLogin: "allowed", ownerName: names[0], present: false, collaboratorsMayAsk: true },
            { login: agentLogin("locked"), name: agentName, ownerLogin: "locked", ownerName: names[1], present: false, collaboratorsMayAsk: false },
          ],
        }));
        vi.mocked(api.tokens.list).mockResolvedValue(tokenResponse(agentName, absentAgentName, "Overflow"));
        const current = makeSession(`mention-title-${kind}`, "Alice", "alice");
        addPresence(current, { id: `agent:alice:${agentName}`, name: agentName, login: null, isAgent: true, userLogin: "alice", userName: "Alice" });
        if (kind === "reply") {
          current.setPendingComment(null);
          current.comments.add({ from: 0, to: 0, body: "Existing thread", author: current.user });
        }
        mountPanel(current);
        if (kind === "reply") fireEvent.click(await screen.findByTestId("comment-reply"));
        const box = await screen.findByTestId("comment-composer") as HTMLTextAreaElement;
        box.focus();
        await userEvent.setup().paste("@");
        await waitFor(() => expect(option(agentLogin("alice", absentAgentName))).toBeVisible());
        const rows = screen.getAllByTestId("mention-option");
        expect(rows.map((row) => row.dataset.login)).toEqual([
          longLogin, "beatrice", agentLogin("alice"), agentLogin("allowed"), agentLogin("locked"), agentLogin("alice", absentAgentName),
        ]);
        expect(option("alice/Overflow")).toBeUndefined();
        const displayNames = [names[0], names[1], agentName, `${names[0].trim()}'s ${agentName}`, `${names[1].trim()}'s ${agentName}`, absentAgentName];
        const reason = `Only ${names[1].trim()} can ask this agent`;
        const metadata = [
          `@${longLogin}`, "@beatrice", "agent", "agent", "owner only", "your agent · not here yet",
        ];
        const metadataTitles = [
          `@${longLogin}`, "@beatrice", "Agent of @alice", "Agent of @allowed", reason, "One of your API tokens; it has not been in this document yet",
        ];
        const list = screen.getByRole("listbox", { name: "Mention someone" });
        expect(box).toHaveAttribute("aria-controls", list.id);
        const requests = [api.documents.collaborators, api.documents.reviews, api.documents.comment, api.documents.createRequest, api.tokens.list];
        const requestCounts = requests.map((request) => vi.mocked(request).mock.calls.length);
        const fetch = vi.spyOn(globalThis, "fetch");
        const update = vi.fn();
        current.ydoc.on("update", update);
        const controls = Array.from(document.querySelectorAll("button, input, textarea, a, [tabindex]"));
        try {
          for (const [index, row] of rows.entries()) {
            expectName(row.dataset.login!, displayNames[index]);
            expect(row.childNodes).toHaveLength(3);
            expect(row.children).toHaveLength(3);
            expect(row).toHaveAttribute("role", "option");
            expect(row.id).toBe(`${list.id}-option-${index}`);
            expect(row.tabIndex).toBe(-1);
            expect(row.querySelectorAll("button, input, textarea, a, [tabindex]")).toHaveLength(0);
            const avatar = row.children[0];
            expect(avatar).toHaveStyle({ width: "20px", height: "20px" });
            expect(avatar.querySelector("svg") !== null).toBe(index >= 2);
            expect(avatar).toHaveAttribute("title", index < 2 ? displayNames[index] : `${index === 5 ? absentAgentName : agentName} (agent)`);
            const meta = row.children[2];
            expect(meta.textContent).toBe(metadata[index]);
            expect(meta.getAttribute("title")).toBe(metadataTitles[index]);
            expect(meta.className).toBe(index < 2 ? loginClass : `flex min-w-0 items-center gap-1 truncate text-xs text-ink-${index === 4 ? "3" : "4"}`);
            expect(meta.children).toHaveLength(index === 4 ? 1 : 0);
            if (index < 2) expectLabel(meta, metadata[index], loginClass);
            expect(row.hasAttribute("data-own")).toBe(index === 5);
            expect(row.hasAttribute("data-locked")).toBe(index === 4);
            expect(row.getAttribute("aria-disabled")).toBe(index === 4 ? "true" : null);
            expect(row.getAttribute("title")).toBe(index === 4 ? reason : null);
            fireEvent.mouseEnter(row.children[1]);
            fireEvent.mouseOver(meta);
            expect(row).toHaveAttribute("aria-selected", "true");
            expect(row.className).toBe(`menu-item py-1.5 bg-surface-3${index === 4 ? " text-ink-3" : ""}`);
            expect(box).toHaveAttribute("aria-activedescendant", row.id);
            expect(box).toHaveFocus();
            expect(box.value).toBe("@");
          }
          expect(requests.map((request) => vi.mocked(request).mock.calls.length)).toEqual(requestCounts);
          expect(fetch).not.toHaveBeenCalled();
          expect(update).not.toHaveBeenCalled();
          expect(Array.from(document.querySelectorAll("button, input, textarea, a, [tabindex]"))).toEqual(controls);
          expect(screen.queryByRole("tooltip")).toBeNull();
          expect(current.comments.list()).toHaveLength(kind === "reply" ? 1 : 0);
          if (kind === "reply") expect(current.comments.list()[0].replies).toHaveLength(0);
        } finally {
          current.ydoc.off("update", update);
        }
        fireEvent.change(box, { target: { value: "@PERSON" } });
        fireEvent.select(box);
        expect(screen.getAllByTestId("mention-option")).toHaveLength(1);
        expectName(longLogin, names[0]);
        fireEvent.keyDown(box, { key: "Escape" });
        await waitFor(() => expect(screen.queryByTestId("mention-option")).toBeNull());
        fireEvent.change(box, { target: { value: "@review" } });
        expect(screen.getAllByTestId("mention-option").map((row) => row.dataset.login)).toEqual([
          agentLogin("alice"), agentLogin("allowed"), agentLogin("locked"),
        ]);
        expectName(agentLogin("allowed"), displayNames[3]);
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });

      it("updates same-ID presence names and owner decoration, restores cached identities on removal, and keeps empty names raw", async () => {
        vi.mocked(api.documents.collaborators).mockResolvedValue(collaboratorResponse({
          collaborators: [
            { login: longLogin, name: names[0], image: null },
            { login: "empty", name: "", image: null },
            { login: "spaces", name: "  ", image: null },
            { login: "fallback", name: null, image: null },
          ],
          agents: [{ login: agentLogin("owner"), name: agentName, ownerLogin: "owner", ownerName: null, present: false, collaboratorsMayAsk: true }],
        }));
        const current = makeSession("mention-title-presence", "Alice", "alice");
        const human = addPresence(current, { id: "same-person", name: names[1], login: longLogin });
        const departing = addPresence(current, { id: "departing", name: "Temporary <i>label</i>", login: "departing" });
        const agent = addPresence(current, { id: `agent:owner:${agentName}`, name: agentName, login: null, isAgent: true, userLogin: "owner", userName: names[0] });
        mountPanel(current);
        const box = await openPicker();
        await waitFor(() => expect(option("empty")).toBeVisible());
        const humanRow = expectName(longLogin, names[1]);
        const agentRow = expectName(agentLogin("owner"), `${names[0].trim()}'s ${agentName}`);
        expectName("empty", "");
        expectName("spaces", "  ");
        expectName("fallback", "fallback");
        const departingRow = expectName("departing", "Temporary <i>label</i>");

        const relay = async (change: () => void) => {
          await act(async () => {
            change();
            lastProvider().opts.onAwarenessChange?.({ states: [] });
          });
        };
        await relay(() => {
          human.setLocalStateField("user", { ...human.getLocalState()!.user, name: names[0] });
          agent.setLocalStateField("user", { ...agent.getLocalState()!.user, userName: names[1] });
          for (const awareness of [human, agent]) applyAwarenessUpdate(current.awareness, encodeAwarenessUpdate(awareness, [awareness.clientID]), "server");
        });
        await waitFor(() => {
          expect(expectName(longLogin, names[0])).toBe(humanRow);
          expect(expectName(agentLogin("owner"), `${names[1].trim()}'s ${agentName}`)).toBe(agentRow);
        });
        expect(agentRow.children[2]).toHaveAttribute("title", "Agent of @owner");
        expect(box.value).toBe("@");

        await relay(() => removeAwarenessStates(current.awareness, [human.clientID, agent.clientID, departing.clientID], "server"));
        await waitFor(() => {
          expectName(longLogin, names[0]);
          expectName(agentLogin("owner"), `owner's ${agentName}`);
        });
        expect(option("departing")).toBeUndefined();
        expect(departingRow).not.toBeInTheDocument();
        expect(Array.from(document.querySelectorAll("span[title]")).some((span) => span.getAttribute("title") === `${names[1].trim()}'s ${agentName}`)).toBe(false);
        act(() => current.setPendingComment(null));
        await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());
        act(() => current.setPendingComment({ from: 0, to: 0 }));
        await openPicker();
        expectName(longLogin, names[0]);
        expectName(agentLogin("owner"), `owner's ${agentName}`);
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });

      it.each(["pointer", "Enter"] as const)("inserts once with current %s selection after document replacement and ignores retired controls", async (selection) => {
        vi.mocked(api.documents.collaborators).mockResolvedValueOnce(collaboratorResponse({
          collaborators: [{ login: longLogin, name: names[0], image: null }],
        })).mockResolvedValueOnce(collaboratorResponse({
          collaborators: [{ login: longLogin, name: names[1], image: null }],
        }));
        const oldSession = makeSession("mention-title-old", "Alice", "alice");
        const view = mountPanel(oldSession);
        const retiredBox = await openPicker();
        await waitFor(() => expect(option(longLogin)).toBeVisible());
        const retiredRow = expectName(longLogin, names[0]);
        const retiredClick = reactProperty<() => void>(retiredRow, "onClick");
        act(() => oldSession.setPendingComment(null));
        await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());
        const current = makeSession("mention-title-current", "Alice", "alice");
        view.replace(current);
        const box = await openPicker();
        await waitFor(() => expect(option(longLogin)).toBeVisible());
        const row = expectName(longLogin, names[1]);
        expectLabel(row.children[2], `@${longLogin}`, loginClass);
        expect(retiredRow).not.toBeInTheDocument();
        expect(retiredBox).not.toBeInTheDocument();
        fireEvent.click(retiredRow);
        act(() => retiredClick());
        mentionKey(retiredBox, "Enter");
        expect(box.value).toBe("@");
        fireEvent.mouseEnter(row.children[1]);
        expect(box).toHaveAttribute("aria-activedescendant", row.id);
        expect(box.value).toBe("@");
        if (selection === "pointer") {
          fireEvent.mouseDown(row.children[1]);
          fireEvent.click(row.children[1]);
        } else {
          mentionKey(box, "Enter");
        }
        expect(box.value).toBe(`@${longLogin} `);
        await waitFor(() => expect(screen.queryByTestId("mention-option")).toBeNull());
        expect(current.comments.list()).toHaveLength(0);
        expect(oldSession.comments.list()).toHaveLength(0);
        expect(api.documents.comment).not.toHaveBeenCalled();
        expect(api.documents.createRequest).not.toHaveBeenCalled();
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(api.tokens.list).toHaveBeenCalledTimes(2);
      });
    });

    it("shows only current presence while replacement viewer requests settle, then publishes only current collaborators, agents, permissions, and tokens", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      const currentTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => currentTokens.promise);

      const oldSession = makeSession("old-doc", "Alice", "Alice");
      const view = mountPanel(oldSession);
      await openPicker();
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });

      const currentSession = makeSession("current-doc", "Carol", "CAROL");
      addPresence(currentSession, { id: "live", name: "Live Person", login: "live" });
      addPresence(currentSession, {
        id: "agent:old-owner:Shared Agent",
        name: "Shared Agent",
        login: null,
        isAgent: true,
        status: "reading",
        userLogin: "old-owner",
        userName: "Old Owner",
      });
      view.replace(currentSession);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(api.tokens.list).toHaveBeenCalledTimes(2);
        expect(option("live")).toBeVisible();
      });
      expect(option("old-owner/Shared-Agent")).toHaveAttribute("data-locked");

      await act(async () => {
        oldCollaborators.resolve(
          collaboratorResponse({
            collaborators: [{ login: "retired", name: "Retired Person", image: null }],
            agents: [
              { name: "Retired Agent", login: "alice/Retired-Agent", ownerLogin: "alice", ownerName: "Alice", present: false, collaboratorsMayAsk: true },
              { name: "Shared Agent", login: "old-owner/Shared-Agent", ownerLogin: "old-owner", ownerName: "Old Owner", present: false, collaboratorsMayAsk: true },
            ],
          }),
        );
        oldTokens.resolve(tokenResponse("Old Token"));
        await Promise.all([oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("retired")).toBeUndefined();
      expect(option("alice/Retired-Agent")).toBeUndefined();
      expect(option("alice/Old-Token")).toBeUndefined();
      expect(option("old-owner/Shared-Agent")).toHaveAttribute("data-locked");

      await act(async () => {
        currentCollaborators.resolve(
          collaboratorResponse({
            owner: { login: "carol", name: "Carol", image: null },
            collaborators: [{ login: "current", name: "Current Person", image: null }],
            agents: [{ name: "Current Agent", login: "drew/Current-Agent", ownerLogin: "drew", ownerName: "Drew", present: false, collaboratorsMayAsk: true }],
          }),
        );
        currentTokens.resolve(tokenResponse("Current Token"));
        await Promise.all([currentCollaborators.promise, currentTokens.promise]);
      });
      await waitFor(() => {
        expect(option("current")).toBeVisible();
        expect(option("drew/Current-Agent")).not.toHaveAttribute("data-locked");
        expect(option("CAROL/Current-Token")).toHaveAttribute("data-own");
      });
      expect(option("retired")).toBeUndefined();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
      expect(api.tokens.list).toHaveBeenCalledTimes(2);
    });

    it("keeps a same-viewer replacement session empty until its own evidence settles, including the Connect-an-agent decision", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      const currentTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise).mockImplementationOnce(() => currentTokens.promise);

      const view = mountPanel(makeSession("first-doc", "Alice", "Alice"));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));

      const replacement = makeSession("second-doc", "Alice", "alice");
      addPresence(replacement, { id: "current-live", name: "Current Live", login: "current-live" });
      view.replace(replacement);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(api.tokens.list).toHaveBeenCalledTimes(2);
        expect(option("current-live")).toBeVisible();
      });

      await act(async () => {
        oldCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "first-doc-person", name: "First Doc Person", image: null }] }));
        oldTokens.resolve(tokenResponse());
        await Promise.all([oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("first-doc-person")).toBeUndefined();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();

      await act(async () => {
        currentCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "second-doc-person", name: "Second Doc Person", image: null }] }));
        currentTokens.resolve(tokenResponse());
        await Promise.all([currentCollaborators.promise, currentTokens.promise]);
      });
      expect(await screen.findByTestId("mention-connect-row")).toBeVisible();
      expect(option("second-doc-person")).toBeVisible();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
      expect(api.tokens.list).toHaveBeenCalledTimes(2);
    });

    it("does not let an old picker opening eagerly load tokens for a closed replacement session", async () => {
      vi.mocked(api.documents.collaborators).mockResolvedValue(collaboratorResponse({ collaborators: [{ login: "person", name: "Person", image: null }] }));
      vi.mocked(api.tokens.list).mockResolvedValue(tokenResponse("Agent"));

      const oldSession = makeSession("old-doc", "Alice", "alice");
      const view = mountPanel(oldSession);
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      act(() => oldSession.setPendingComment(null));
      await waitFor(() => expect(screen.queryByTestId("comment-composer")).toBeNull());

      const replacement = makeSession("replacement-doc", "Carol", "carol");
      replacement.setPendingComment(null);
      view.replace(replacement);
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalledTimes(2));
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(api.tokens.list).toHaveBeenCalledTimes(1);

      act(() => replacement.setPendingComment({ from: 0, to: 0 }));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(2));
    });

    it("publishes no old viewer result or failure after replacement with a null-login viewer", async () => {
      const oldCollaborators = deferred<CollaboratorsResponse>();
      const currentCollaborators = deferred<CollaboratorsResponse>();
      const oldTokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => oldCollaborators.promise).mockImplementationOnce(() => currentCollaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => oldTokens.promise);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const view = mountPanel(makeSession("old-doc", "Alice", "alice"));
      await openPicker();
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));

      const anonymous = makeSession("anonymous-doc", "Anonymous", null);
      addPresence(anonymous, { id: "anonymous-live", name: "Anonymous Live", login: "anonymous-live" });
      view.replace(anonymous);
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(2);
        expect(option("anonymous-live")).toBeVisible();
      });
      expect(api.tokens.list).toHaveBeenCalledTimes(1);

      await act(async () => {
        currentCollaborators.resolve(collaboratorResponse({ collaborators: [{ login: "anonymous-current", name: "Anonymous Current", image: null }] }));
        oldCollaborators.reject(new Error("old collaborators failed"));
        oldTokens.reject(new Error("old tokens failed"));
        await Promise.allSettled([currentCollaborators.promise, oldCollaborators.promise, oldTokens.promise]);
      });
      expect(option("anonymous-current")).toBeVisible();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
      expect(debug).not.toHaveBeenCalled();
      expect(api.tokens.list).toHaveBeenCalledTimes(1);
    });

    it("ignores collaborator success and token failure after unmount", async () => {
      const collaborators = deferred<CollaboratorsResponse>();
      const tokens = deferred<TokensResponse>();
      vi.mocked(api.documents.collaborators).mockImplementationOnce(() => collaborators.promise);
      vi.mocked(api.tokens.list).mockImplementationOnce(() => tokens.promise);
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

      const view = mountPanel(makeSession("unmounted-doc", "Alice", "alice"));
      await openPicker();
      await waitFor(() => {
        expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
        expect(api.tokens.list).toHaveBeenCalledTimes(1);
      });
      view.unmount();

      await act(async () => {
        collaborators.resolve(collaboratorResponse({ collaborators: [{ login: "late", name: "Late Person", image: null }] }));
        tokens.reject(new Error("late tokens failed"));
        await Promise.allSettled([collaborators.promise, tokens.promise]);
      });
      expect(screen.queryByTestId("mention-option")).toBeNull();
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
      expect(debug).not.toHaveBeenCalled();
      expect(api.documents.collaborators).toHaveBeenCalledTimes(1);
      expect(api.tokens.list).toHaveBeenCalledTimes(1);
    });
  });

  describe("document comments, empty state and the connect row (#1025)", () => {
    const AGENT = { name: "Copilot CLI", login: "alice/Copilot-CLI", ownerLogin: "alice", present: false };
    const TEXT = "Intro text. The quick brown fox jumps.";
    const DISMISSED_KEY = "markdoc:agent-connect-dismissed";

    const mount = (opts: { role?: "owner" | "editor" | "commenter"; documentComposer?: CommentsPanelProps["documentComposer"]; onConnectAgent?: () => void; collaborators?: boolean } = {}) => {
      Element.prototype.scrollIntoView ??= () => {};
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session = new CollabSession({ docId: "doc", user, role: opts.role ?? "owner", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      session.synced = true;
      session.ytext.insert(0, TEXT);
      vi.mocked(api.documents.collaborators).mockResolvedValue(
        (opts.collaborators === false
          ? { owner: null, collaborators: [], agents: [] }
          : { owner: { login: "alice", name: "Alice", image: null }, collaborators: [{ login: "bob", name: "Bob", image: null }], agents: [AGENT] }) as unknown as Awaited<
          ReturnType<typeof api.documents.collaborators>
        >,
      );
      const onReveal = vi.fn<(offset: number) => void>();
      const onToast = vi.fn<NonNullable<CommentsPanelProps["onToast"]>>();
      const props = (documentComposer: CommentsPanelProps["documentComposer"]) => (
        <TooltipProvider>
          <CommentsPanel session={session!} onClose={() => {}} onReveal={onReveal} onToast={onToast} onConnectAgent={opts.onConnectAgent} documentComposer={documentComposer} />
        </TooltipProvider>
      );
      const view = render(props(opts.documentComposer ?? null));
      return { onReveal, onToast, user, setDocumentComposer: (next: CommentsPanelProps["documentComposer"]) => view.rerender(props(next)) };
    };
    const composer = async () => (await screen.findByPlaceholderText(/Add a comment/)) as HTMLTextAreaElement;
    const paste = async (box: HTMLTextAreaElement, text: string) => {
      box.focus();
      await userEvent.setup().paste(text);
    };

    afterEach(() => {
      window.localStorage.removeItem(DISMISSED_KEY);
      vi.mocked(api.documents.createRequest).mockReset().mockResolvedValue({ request: { id: "req" } } as never);
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [] } as never);
      vi.mocked(api.documents.collaborators).mockResolvedValue({ owner: null, collaborators: [], agents: [] } as unknown as Awaited<ReturnType<typeof api.documents.collaborators>>);
    });

    it("the header button opens a composer on the whole document; the posted card says Whole document, anchors at {0,0} and reveals offset 0", async () => {
      const { onReveal } = mount();
      expect(screen.queryByTestId("pending-comment")).toBeNull();
      fireEvent.click(screen.getByTestId("comment-document"));
      const pending = await screen.findByTestId("pending-comment");
      expect(session!.pendingComment).toEqual({ from: 0, to: 0 });
      expect(within(pending).getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
      expect(within(pending).queryByTestId("comment-quote")).toBeNull();
      // No anchored text: nothing to turn into a ```suggestion block.
      expect(within(pending).queryByTestId("comment-suggest-change")).toBeNull();
      const box = await composer();
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.value).toBe("");
      await paste(box, "Overall: reads well, but the intro is long.");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(session!.comments.list()).toHaveLength(1));
      const [thread] = session!.comments.list();
      expect(thread.range).toEqual({ from: 0, to: 0 });
      expect(thread.quote).toBe("");
      const card = await screen.findByTestId("comment-thread");
      expect(within(card).getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
      expect(within(card).queryByTestId("comment-quote")).toBeNull();
      // Typing at the start of the document does not move it: the anchor is the document, not its first character.
      act(() => session!.ytext.insert(0, "x".repeat(200)));
      expect(session!.comments.list()[0].range).toEqual({ from: 0, to: 0 });
      fireEvent.click(card);
      expect(onReveal).toHaveBeenCalledWith(0);
      // No agent was mentioned: no request.
      await new Promise((r) => setTimeout(r, 20));
      expect(api.documents.createRequest).not.toHaveBeenCalled();
    });

    it("the empty state's 'Comment and mention an agent' seeds `@`, opens the picker at once and posts a request with selection: null", async () => {
      mount();
      expect(screen.queryByText(/Ask an agent/)).toBeNull();
      fireEvent.click(await screen.findByTestId("comments-empty-agent"));
      const box = await composer();
      await waitFor(() => expect(box).toHaveFocus());
      expect(box.value).toBe("@");
      expect(box.selectionStart).toBe(1);
      expect(box.selectionEnd).toBe(1);
      // The picker is up before anything else is typed, and it fetched the user's own tokens.
      await screen.findByTestId("mention-suggestions", {}, { timeout: 300 });
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const options = await screen.findAllByTestId("mention-option");
      fireEvent.click(options.find((o) => o.getAttribute("data-login") === AGENT.login)!);
      await screen.findByTestId("composer-agent-row");
      await paste(box, "review the whole thing");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      const [thread] = session!.comments.list();
      expect(thread.range).toEqual({ from: 0, to: 0 });
      expect(api.documents.createRequest).toHaveBeenCalledWith("doc", {
        mode: "suggest",
        instruction: "review the whole thing",
        selection: null,
        threadId: thread.id,
        agent: "alice/Copilot-CLI",
      });
    });

    it("a reply that mentions an agent on a document thread also asks with selection: null", async () => {
      mount();
      const user = makeCollabUser("alice", "Alice", null, "alice");
      const id = session!.comments.add({ from: 0, to: 0, body: "Overall thoughts?", author: user });
      const card = await screen.findByTestId("comment-thread");
      fireEvent.click(within(card).getByTestId("comment-reply"));
      const box = (await screen.findByPlaceholderText(/Reply/)) as HTMLTextAreaElement;
      // No "Suggest a change" on a document thread's reply composer either.
      expect(screen.queryByTestId("comment-suggest-change")).toBeNull();
      await waitFor(() => expect(api.documents.collaborators).toHaveBeenCalled());
      await paste(box, `@${AGENT.login} what do you think?`);
      await screen.findByTestId("composer-agent-row");
      fireEvent.click(screen.getByTestId("comment-submit"));
      await waitFor(() => expect(api.documents.createRequest).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.documents.createRequest).mock.calls[0][1]).toMatchObject({ selection: null, threadId: id });
    });

    it("the shell's documentComposer request opens the composer (seeded when asked), and a later plain one starts empty", async () => {
      const { setDocumentComposer } = mount();
      setDocumentComposer({ mention: true, nonce: 1 });
      let box = await composer();
      await waitFor(() => expect(box.value).toBe("@"));
      await screen.findByTestId("mention-suggestions");
      // Esc with the picker open closes the picker; a second Esc cancels the composer.
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("mention-suggestions")).toBeNull());
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("pending-comment")).toBeNull());
      expect(session!.pendingComment).toBeNull();
      setDocumentComposer({ mention: false, nonce: 2 });
      box = await composer();
      expect(box.value).toBe("");
      expect(screen.getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
    });

    it("a panel that mounts with documentComposer already set (the hint bar opens the panel and asks at once) is seeded too", async () => {
      mount({ documentComposer: { mention: true, nonce: 7 } });
      const box = await composer();
      await waitFor(() => expect(box.value).toBe("@"));
      expect(session!.pendingComment).toEqual({ from: 0, to: 0 });
      await screen.findByTestId("mention-suggestions");
      expect(screen.getByTestId("comment-quote-document")).toHaveTextContent("Whole document");
    });

    it("a suggestion on a document thread can be rejected but never accepted", async () => {
      mount({ role: "owner" });
      const user = makeCollabUser("alice", "Alice", null, "alice");
      session!.comments.add({ from: 0, to: 0, body: "Try this.\n\n```suggestion\nA whole new intro\n```", author: user });
      const card = await screen.findByTestId("comment-thread");
      expect(within(card).getByTestId("suggestion-box")).toHaveAttribute("data-state", "pending");
      expect(within(card).queryByTestId("suggestion-accept-comment")).toBeNull();
      expect(within(card).getByTestId("suggestion-reject-comment")).toBeVisible();
      fireEvent.click(within(card).getByTestId("suggestion-reject-comment"));
      await waitFor(() => expect(session!.comments.list()[0].suggestionState).toBe("rejected"));
      expect(session!.ytext.toString()).toBe(TEXT);
    });

    it("the `@` picker shows 'Connect an agent' for a user with no token, once, until dismissed — and never with a token", async () => {
      const onConnectAgent = vi.fn();
      mount({ onConnectAgent });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      let box = await composer();
      await paste(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      const row = await screen.findByTestId("mention-connect-row");
      expect(row).toHaveTextContent("No agent connected yet");
      // The options are still listed above it.
      expect(screen.getAllByTestId("mention-option").length).toBeGreaterThan(0);
      expect(screen.getByTestId("mention-connect-docs")).toHaveAttribute("href", "https://github.com/burkeholland/markdoc/blob/main/docs/agents.md");
      expect(screen.getByTestId("mention-connect-docs")).toHaveAttribute("target", "_blank");
      fireEvent.click(screen.getByTestId("mention-connect-agent"));
      expect(onConnectAgent).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("mention-connect-dismiss"));
      await waitFor(() => expect(screen.queryByTestId("mention-connect-row")).toBeNull());
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBe("1");
      // The list is still there; only the footer went.
      expect(screen.getAllByTestId("mention-option").length).toBeGreaterThan(0);

      // A fresh panel remembers the dismissal.
      cleanup();
      session!.destroy();
      mount({ onConnectAgent });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      box = await composer();
      await paste(box, "@");
      await screen.findAllByTestId("mention-option");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();

      // With a token the row is never due.
      cleanup();
      session!.destroy();
      window.localStorage.removeItem(DISMISSED_KEY);
      vi.mocked(api.tokens.list).mockClear().mockResolvedValue({ tokens: [{ id: "t1", name: "Copilot CLI" }] } as never);
      mount({ onConnectAgent });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      box = await composer();
      await paste(box, "@");
      await waitFor(() => expect(api.tokens.list).toHaveBeenCalledTimes(1));
      await screen.findAllByTestId("mention-option");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("mention-connect-row")).toBeNull();
    });

    it("with nobody to mention, `@` still opens the picker for the connect row alone; without onConnectAgent only the docs link is offered", async () => {
      mount({ collaborators: false });
      act(() => session!.setPendingComment({ from: 16, to: 27 }));
      const box = await composer();
      await paste(box, "@");
      const popover = await screen.findByTestId("mention-suggestions");
      expect(within(popover).queryByRole("listbox")).toBeNull();
      expect(within(popover).getByTestId("mention-connect-row")).toBeVisible();
      expect(within(popover).queryByTestId("mention-connect-agent")).toBeNull();
      expect(within(popover).getByTestId("mention-connect-docs")).toBeVisible();
      // Arrow keys and Enter with no options do nothing odd: Enter sends the comment as usual.
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("mention-suggestions")).toBeNull());
      expect(box.value).toBe("@");
    });

    it("a viewer sees neither the header button nor the empty-state line", async () => {
      const user = makeCollabUser("vic", "Vic", null, "vic");
      session = new CollabSession({ docId: "doc", user, role: "viewer", getToken: async () => "token", autoConnect: false });
      session.keepAlive();
      render(<CommentsPanel session={session} onClose={() => {}} onReveal={() => {}} />);
      expect(screen.queryByTestId("comment-document")).toBeNull();
      expect(screen.queryByTestId("comments-empty-agent")).toBeNull();
      expect(await screen.findByText("No open comments")).toBeInTheDocument();
    });
  });
});