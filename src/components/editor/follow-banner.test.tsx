// @vitest-environment jsdom

import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import { FollowBanner } from "./follow-banner";

type FollowAction = Mock<(userId: string | null) => void>;

const BASE_USER: PresenceUser = {
  id: "collaborator-a",
  name: "Ada",
  color: "#123456",
  colorLight: "#12345633",
  avatar: null,
  login: "ada",
  clientId: 101,
  cursor: 8,
  section: "Introduction",
  idleSince: null,
  role: "editor",
  isLocal: false,
  isAgent: false,
  status: null,
  ownerLogin: null,
  ownerName: null,
};

function user(overrides: Partial<PresenceUser> = {}): PresenceUser {
  return { ...BASE_USER, ...overrides };
}

class ControlledSession {
  version = 0;
  follow: CollabSession["follow"];
  readonly targetReads = vi.fn();
  readonly presence: Mock<() => PresenceUser[]>;
  private target: string | null;
  private users: PresenceUser[];
  private readonly listeners = new Set<() => void>();

  constructor(target: string | null, users: PresenceUser[], follow: FollowAction) {
    this.target = target;
    this.users = users;
    this.follow = follow;
    this.presence = vi.fn(() => this.users);
  }

  get followUserId() {
    this.targetReads();
    return this.target;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publish(target: string | null, users: PresenceUser[]) {
    this.target = target;
    this.users = users;
    this.version++;
  }

  drift(target: string | null, users: PresenceUser[]) {
    this.target = target;
    this.users = users;
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }
}

interface BoundaryProps {
  session: ControlledSession;
  present?: boolean;
  bannerKey?: string;
  domKey?: string;
  passiveKey?: number;
  boundary?: number;
  onBoundary?: () => void;
  onBoundaryCleanup?: () => void;
  onPassiveCleanup?: () => void;
}

function Boundary({
  session,
  present = true,
  bannerKey = "banner-a",
  domKey = "dom-a",
  passiveKey = 0,
  boundary = 0,
  onBoundary,
  onBoundaryCleanup,
  onPassiveCleanup,
}: BoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
    return () => {
      if (boundary > 0) onBoundaryCleanup?.();
    };
  }, [boundary, onBoundary, onBoundaryCleanup]);
  useEffect(() => () => onPassiveCleanup?.(), [onPassiveCleanup, passiveKey]);
  return present ? (
    <div key={domKey}>
      <FollowBanner key={bannerKey} session={session.asCollabSession()} />
    </div>
  ) : null;
}

interface DirectView {
  root: Root;
  host: HTMLDivElement;
  active: boolean;
}

const directViews: DirectView[] = [];

function directRoot(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const view: DirectView = { root: createRoot(host), host, active: true };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

function stopButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="follow-stop"]');
  if (!button) throw new Error("The Follow banner did not publish a Stop button");
  return button;
}

function reactHandler<T>(element: Element, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the Stop button");
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (!handler) throw new Error(`${name} was not attached to the Stop button`);
  return handler as T;
}

type StopHandler = (event: ReactMouseEvent<HTMLButtonElement>) => void;

function activateStop(handler: StopHandler, currentTarget: HTMLButtonElement) {
  const ownerWindow = currentTarget.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The Stop control has no owner window");
  const nativeEvent = new ownerWindow.MouseEvent("click", { bubbles: true, button: 0 });
  Object.defineProperty(nativeEvent, "target", { configurable: true, value: currentTarget });
  handler({
    type: "click",
    currentTarget,
    target: currentTarget,
    nativeEvent,
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function fabricateStop(handler: StopHandler, currentTarget: HTMLButtonElement) {
  handler({
    type: "click",
    currentTarget,
    target: currentTarget,
    nativeEvent: {
      type: "click",
      button: 0,
      target: currentTarget,
    },
  } as unknown as ReactMouseEvent<HTMLButtonElement>);
}

function nativeClick(target: Element, event?: MouseEvent) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The click target has no owner window");
  const nativeEvent =
    event ??
    new ownerWindow.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
    });
  target.dispatchEvent(nativeEvent);
  return nativeEvent;
}

interface KeyListenerRecord {
  readonly target: Document;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  active: boolean;
}

function captureOption(
  options: boolean | AddEventListenerOptions | EventListenerOptions | undefined,
) {
  return typeof options === "boolean" ? options : options?.capture ?? false;
}

function trackDocumentKeys(ownerDocument: Document) {
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The key listener document has no owner window");
  const prototype = ownerWindow.EventTarget.prototype;
  const nativeAdd = prototype.addEventListener;
  const nativeRemove = prototype.removeEventListener;
  const added: KeyListenerRecord[] = [];
  const removed: KeyListenerRecord[] = [];
  vi.spyOn(prototype, "addEventListener").mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (this === ownerDocument && type === "keydown" && listener) {
      added.push({
        target: ownerDocument,
        listener,
        capture: captureOption(options),
        active: true,
      });
    }
    return Reflect.apply(nativeAdd, this, [type, listener, options]);
  });
  vi.spyOn(prototype, "removeEventListener").mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (this === ownerDocument && type === "keydown" && listener) {
      const capture = captureOption(options);
      const current = added.find(
        (record) =>
          record.active &&
          record.listener === listener &&
          record.capture === capture,
      );
      if (current) current.active = false;
      removed.push({
        target: ownerDocument,
        listener,
        capture,
        active: false,
      });
    }
    return Reflect.apply(nativeRemove, this, [type, listener, options]);
  });
  return {
    added,
    removed,
    active: () => added.filter((record) => record.active),
  };
}

function invokeKey(record: KeyListenerRecord, event: Event) {
  if (typeof record.listener === "function") {
    record.listener.call(record.target, event);
  } else {
    record.listener.handleEvent(event);
  }
}

function ownerDocumentOf(target: Node): Document {
  if (target.nodeType === target.DOCUMENT_NODE) return target as Document;
  if (!target.ownerDocument) throw new Error("The key target has no owner document");
  return target.ownerDocument;
}

function escapeEvent(
  target: Node,
  init: KeyboardEventInit & { type?: string } = {},
) {
  const ownerDocument = ownerDocumentOf(target);
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The key target has no owner window");
  const { type = "keydown", ...eventInit } = init;
  return new ownerWindow.KeyboardEvent(type, {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    composed: true,
    ...eventInit,
  });
}

function dispatchKey(target: Node, event = escapeEvent(target)) {
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function preventionsFor(
  spy: MockInstance<Event["preventDefault"]>,
  event: Event,
) {
  return spy.mock.contexts.filter((context) => context === event).length;
}

function directRootIn(ownerDocument: Document, node: React.ReactNode) {
  const host = ownerDocument.createElement("div");
  ownerDocument.body.append(host);
  const view: DirectView = { root: createRoot(host), host, active: true };
  directViews.push(view);
  act(() => view.root.render(node));
  return view;
}

interface WorkProbe {
  action: FollowAction;
  sessions: ControlledSession[];
  host: HTMLElement;
  observer: MutationObserver;
  focus: ReturnType<typeof vi.spyOn>;
  contains: ReturnType<typeof vi.spyOn>;
  eventWork: ReturnType<typeof vi.fn>;
}

function workSnapshot(probe: WorkProbe) {
  return {
    actionCalls: probe.action.mock.calls.length,
    targetReads: probe.sessions.map((session) => session.targetReads.mock.calls.length),
    presenceReads: probe.sessions.map((session) => session.presence.mock.calls.length),
    versions: probe.sessions.map((session) => session.version),
    focusCalls: probe.focus.mock.calls.length,
    containsCalls: probe.contains.mock.calls.length,
    eventCalls: probe.eventWork.mock.calls.length,
    activeElement: document.activeElement,
    markup: probe.host.innerHTML,
  };
}

function expectNoWork(callback: () => void, probe: WorkProbe) {
  probe.observer.takeRecords();
  const before = workSnapshot(probe);
  callback();
  expect(probe.observer.takeRecords()).toHaveLength(0);
  expect(workSnapshot(probe)).toEqual(before);
}

function probeWork(host: HTMLElement, action: FollowAction, sessions: ControlledSession[]): WorkProbe {
  const observer = new MutationObserver(() => undefined);
  observer.observe(host, { attributes: true, childList: true, characterData: true, subtree: true });
  const eventWork = vi.fn();
  host.addEventListener("click", eventWork);
  return {
    action,
    sessions,
    host,
    observer,
    focus: vi.spyOn(HTMLElement.prototype, "focus"),
    contains: vi.spyOn(Node.prototype, "contains"),
    eventWork,
  };
}

function releaseProbe(probe: WorkProbe) {
  probe.observer.disconnect();
  probe.focus.mockRestore();
  probe.contains.mockRestore();
}

afterEach(() => {
  for (const view of directViews.splice(0)) {
    if (view.active) act(() => view.root.unmount());
    view.host.remove();
  }
  cleanup();
  vi.restoreAllMocks();
});

describe("FollowBanner", () => {
  it("preserves visible and hidden rendering, copy, colour, section, dimensions, and accessibility", () => {
    const action = vi.fn<(userId: string | null) => void>();
    const session = new ControlledSession(BASE_USER.id, [user()], action);
    const view = render(<FollowBanner session={session.asCollabSession()} />);

    const banner = screen.getByRole("status");
    const stop = screen.getByRole("button", { name: "Stop (Esc)" });
    expect(banner).toHaveAttribute("data-testid", "follow-banner");
    expect(banner).toHaveAttribute("data-user-id", BASE_USER.id);
    expect(banner).toHaveClass("h-8", "shrink-0");
    expect(banner.style.backgroundColor).toBe("rgb(18, 52, 86)");
    expect(banner).toHaveTextContent("Following Ada · in ‘Introduction’·Stop (Esc)");
    expect(stop).toHaveAttribute("type", "button");
    expect(stop.querySelector("svg")).not.toBeNull();

    session.publish("missing", [user()]);
    view.rerender(<FollowBanner session={session.asCollabSession()} />);
    expect(screen.queryByTestId("follow-banner")).toBeNull();

    session.publish(null, []);
    view.rerender(<FollowBanner session={session.asCollabSession()} />);
    expect(screen.queryByTestId("follow-banner")).toBeNull();
  });

  describe("Strict Mode Stop", () => {
    it("publishes one fresh replay authority and accepts only a genuine current native click", () => {
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      const retiredHandlers: StopHandler[] = [];
      const retiredRefs: ((element: HTMLButtonElement | null) => void)[] = [];
      const view = directRoot(
        <StrictMode>
          <Boundary
            session={session}
            boundary={1}
            onBoundary={() => {
              const retired = document.querySelector<HTMLButtonElement>(
                '[data-testid="follow-stop"]',
              );
              if (!retired) throw new Error("The replayed layout had no Stop control");
              retiredHandlers.push(reactHandler<StopHandler>(retired, "onClick"));
              retiredRefs.push(
                reactHandler<(element: HTMLButtonElement | null) => void>(
                  retired,
                  "ref",
                ),
              );
            }}
          />
        </StrictMode>,
      );
      const stop = stopButton(view.host);
      const handler = reactHandler<StopHandler>(stop, "onClick");
      const currentRef = reactHandler<(element: HTMLButtonElement | null) => void>(
        stop,
        "ref",
      );
      expect(retiredHandlers).toHaveLength(2);
      expect(retiredRefs).toHaveLength(2);
      expect(handler).not.toBe(retiredHandlers[0]);
      expect(currentRef).not.toBe(retiredRefs[0]);
      act(() => {
        retiredRefs[0]?.(stop);
        retiredRefs[0]?.(null);
      });
      const targetReads = session.targetReads.mock.calls.length;
      const presenceReads = session.presence.mock.calls.length;

      activateStop(retiredHandlers[0]!, stop);
      fabricateStop(handler, stop);
      expect(session.targetReads.mock.calls.length).toBe(targetReads);
      expect(session.presence.mock.calls.length).toBe(presenceReads);
      expect(action).not.toHaveBeenCalled();

      const icon = stop.querySelector("svg");
      if (!icon) throw new Error("The Stop control did not publish its icon");
      nativeClick(icon);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
      expect(action.mock.contexts[0]).toBe(session);

      const readsAfterClaim = session.targetReads.mock.calls.length;
      const presenceAfterClaim = session.presence.mock.calls.length;
      nativeClick(stop);
      expect(session.targetReads.mock.calls.length).toBe(readsAfterClaim);
      expect(session.presence.mock.calls.length).toBe(presenceAfterClaim);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it("rejects a consumed event without spending B and closes before repeated or reentrant clicks", () => {
      let reenter = false;
      let currentStop: HTMLButtonElement | null = null;
      const action = vi.fn<(userId: string | null) => void>(function () {
        if (reenter && currentStop) nativeClick(currentStop);
      });
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      const view = directRoot(
        <StrictMode>
          <Boundary session={session} />
        </StrictMode>,
      );
      const firstStop = stopButton(view.host);
      const consumed = nativeClick(firstStop);
      expect(action).toHaveBeenCalledTimes(1);

      session.publish(BASE_USER.id, [user({ name: "Grace" })]);
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={session} passiveKey={1} />
          </StrictMode>,
        );
      });
      currentStop = stopButton(view.host);
      const targetReads = session.targetReads.mock.calls.length;
      const presenceReads = session.presence.mock.calls.length;

      nativeClick(currentStop, consumed);
      expect(session.targetReads.mock.calls.length).toBe(targetReads);
      expect(session.presence.mock.calls.length).toBe(presenceReads);
      expect(action).toHaveBeenCalledTimes(1);

      reenter = true;
      nativeClick(currentStop);
      nativeClick(currentStop);
      expect(action).toHaveBeenCalledTimes(2);
      expect(action.mock.contexts).toEqual([session, session]);
    });

    const replayChanges = [
      "changed presence",
      "restored subtree mutation",
      "same-root detach/reinsert",
      "partial ref replay",
    ] as const;

    it.each(replayChanges)("rejects %s between the two layout setups", (change) => {
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      let banner!: HTMLDivElement;
      let stopRef!: (element: HTMLButtonElement | null) => void;
      let cleanups = 0;
      let setups = 0;
      const view = directRoot(
        <StrictMode>
          <Boundary
            session={session}
            boundary={1}
            onBoundary={() => {
              setups++;
              if (change === "changed presence" && setups === 2) {
                session.drift(BASE_USER.id, [user()]);
              }
              if (banner) return;
              const current = document.querySelector<HTMLDivElement>(
                '[data-testid="follow-banner"]',
              );
              if (!current) throw new Error("The first layout did not publish a Follow banner");
              banner = current;
              if (change === "partial ref replay") {
                stopRef = reactHandler<(element: HTMLButtonElement | null) => void>(
                  stopButton(banner),
                  "ref",
                );
              }
            }}
            onBoundaryCleanup={() => {
              cleanups++;
              if (change === "changed presence") {
                session.drift(BASE_USER.id, [user({ name: "Grace" })]);
              } else if (change === "restored subtree mutation") {
                const separator = banner.children.item(1);
                if (!separator) throw new Error("The Follow banner has no separator");
                separator.textContent = "x";
                separator.textContent = "·";
              } else if (change === "same-root detach/reinsert") {
                const parent = banner.parentNode;
                if (!parent) throw new Error("The Follow banner has no parent");
                const next = banner.nextSibling;
                parent.removeChild(banner);
                parent.insertBefore(banner, next);
              } else {
                stopRef(null);
              }
            }}
          />
        </StrictMode>,
      );
      expect(cleanups).toBe(1);
      const targetReads = session.targetReads.mock.calls.length;
      const presenceReads = session.presence.mock.calls.length;

      nativeClick(stopButton(view.host));
      expect(session.targetReads.mock.calls.length).toBe(targetReads);
      expect(session.presence.mock.calls.length).toBe(presenceReads);
      expect(action).not.toHaveBeenCalled();
    });

    it.each(["stale-before-current", "current-before-stale"] as const)(
      "keeps the current publication usable across a stale replay cross %s",
      (order) => {
        const action = vi.fn<(userId: string | null) => void>();
        const session = new ControlledSession(BASE_USER.id, [user()], action);
        const view = directRoot(
          <StrictMode>
            <Boundary session={session} />
          </StrictMode>,
        );
        const staleStopElement = stopButton(view.host);
        const staleStop = reactHandler<StopHandler>(staleStopElement, "onClick");

        session.publish(BASE_USER.id, [user({ name: "Grace" })]);
        act(() => {
          view.root.render(
            <StrictMode>
              <Boundary session={session} passiveKey={1} />
            </StrictMode>,
          );
        });
        const currentStopElement = stopButton(view.host);
        const probe = probeWork(view.host, action, [session]);
        try {
          if (order === "stale-before-current") {
            expectNoWork(() => activateStop(staleStop, staleStopElement), probe);
          }
          nativeClick(currentStopElement);
          if (order === "current-before-stale") {
            expectNoWork(() => activateStop(staleStop, staleStopElement), probe);
          }
          expect(action).toHaveBeenCalledExactlyOnceWith(null);
          expect(action.mock.contexts[0]).toBe(session);
        } finally {
          releaseProbe(probe);
        }
      },
    );
  });

  describe("owner-document Escape", () => {
    it("claims, prevents, and stops exactly once while preserving native Stop activation", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      const view = directRoot(
        <StrictMode>
          <Boundary session={session} />
        </StrictMode>,
      );
      expect(keys.active()).toHaveLength(1);
      const stale = keys.added.find((record) => !record.active);
      if (!stale) throw new Error("Strict Mode did not retire its first key listener");

      const replayed = escapeEvent(document.body);
      invokeKey(stale, replayed);
      expect(preventionsFor(preventDefault, replayed)).toBe(0);
      expect(action).not.toHaveBeenCalled();

      const accepted = dispatchKey(document.body);
      expect(accepted.defaultPrevented).toBe(true);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
      expect(action.mock.contexts[0]).toBe(session);
      expect(keys.active()).toHaveLength(0);

      const duplicate = dispatchKey(document.body);
      expect(duplicate.defaultPrevented).toBe(false);
      expect(preventionsFor(preventDefault, duplicate)).toBe(0);
      nativeClick(stopButton(view.host));
      expect(action).toHaveBeenCalledTimes(1);

      session.publish(BASE_USER.id, [user({ name: "Grace" })]);
      act(() => {
        view.root.render(<Boundary session={session} bannerKey="fresh" />);
      });
      nativeClick(stopButton(view.host));
      expect(action).toHaveBeenCalledTimes(2);
      expect(action.mock.contexts[1]).toBe(session);
    });

    it("rejects modified, repeated, composing, canceled, stopped, and incomplete events", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      directRoot(
        <StrictMode>
          <FollowBanner session={session.asCollabSession()} />
        </StrictMode>,
      );
      expect(keys.active()).toHaveLength(1);

      const rejected = [
        escapeEvent(document.body, { key: "Enter" }),
        escapeEvent(document.body, { ctrlKey: true }),
        escapeEvent(document.body, { altKey: true }),
        escapeEvent(document.body, { metaKey: true }),
        escapeEvent(document.body, { shiftKey: true }),
        escapeEvent(document.body, { repeat: true }),
        escapeEvent(document.body, { isComposing: true }),
        escapeEvent(document, { bubbles: false }),
        escapeEvent(document, { cancelable: false }),
      ];
      const canceled = escapeEvent(document.body);
      canceled.preventDefault();
      preventDefault.mockClear();
      rejected.push(canceled);
      for (const event of rejected) {
        const target = event.bubbles ? document.body : document;
        dispatchKey(target, event);
        expect(preventionsFor(preventDefault, event)).toBe(0);
      }

      const stopped = escapeEvent(document.body);
      document.body.addEventListener(
        "keydown",
        (event) => event.stopPropagation(),
        { once: true },
      );
      dispatchKey(document.body, stopped);
      expect(stopped.defaultPrevented).toBe(false);
      expect(preventionsFor(preventDefault, stopped)).toBe(0);
      expect(action).not.toHaveBeenCalled();
      expect(keys.active()).toHaveLength(1);

      const accepted = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
    });

    it("rejects fabricated, foreign-realm, stale, replayed, and crossed deliveries", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      directRoot(
        <StrictMode>
          <Boundary session={session} />
        </StrictMode>,
      );
      const current = keys.active()[0];
      const stale = keys.added.find((record) => !record.active);
      if (!current || !stale) throw new Error("Expected current and retired key listeners");

      const outsideDispatch = escapeEvent(document.body);
      invokeKey(current, outsideDispatch);
      invokeKey(stale, outsideDispatch);
      invokeKey(
        current,
        {
          type: "keydown",
          key: "Escape",
          bubbles: true,
          cancelable: true,
        } as unknown as Event,
      );
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const foreignWindow = frame.contentWindow;
      if (!foreignWindow) throw new Error("The foreign frame has no window");
      const foreign = new (foreignWindow as Window & typeof globalThis).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      invokeKey(current, foreign);
      expect(preventionsFor(preventDefault, outsideDispatch)).toBe(0);
      expect(action).not.toHaveBeenCalled();

      document.body.addEventListener(
        "keydown",
        (event) => invokeKey(stale, event),
        { once: true },
      );
      const accepted = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
      invokeKey(current, accepted);
      invokeKey(stale, accepted);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(action).toHaveBeenCalledTimes(1);
      frame.remove();
    });

    it("retires stale listeners across session, user, and callback replacements", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const firstAction = vi.fn<(userId: string | null) => void>();
      const replacementAction = vi.fn<(userId: string | null) => void>();
      const finalAction = vi.fn<(userId: string | null) => void>();
      const first = new ControlledSession(BASE_USER.id, [user()], firstAction);
      const final = new ControlledSession(
        "collaborator-b",
        [user({ id: "collaborator-b", name: "Grace", clientId: 202 })],
        finalAction,
      );
      const view = directRoot(
        <StrictMode>
          <Boundary session={first} />
        </StrictMode>,
      );
      const firstListener = keys.active()[0];
      if (!firstListener) throw new Error("The first publication has no key listener");

      first.publish(BASE_USER.id, [user({ name: "Grace" })]);
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={first} passiveKey={1} />
          </StrictMode>,
        );
      });
      const userListener = keys.active()[0];
      if (!userListener) throw new Error("The user publication has no key listener");
      first.follow = replacementAction;
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={first} passiveKey={2} />
          </StrictMode>,
        );
      });
      const callbackListener = keys.active()[0];
      if (!callbackListener) throw new Error("The callback publication has no key listener");
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={final} passiveKey={3} />
          </StrictMode>,
        );
      });
      expect(keys.active()).toHaveLength(1);

      for (const stale of [firstListener, userListener, callbackListener]) {
        const event = escapeEvent(document.body);
        invokeKey(stale, event);
        expect(preventionsFor(preventDefault, event)).toBe(0);
      }
      const accepted = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(firstAction).not.toHaveBeenCalled();
      expect(replacementAction).not.toHaveBeenCalled();
      expect(finalAction).toHaveBeenCalledExactlyOnceWith(null);
      expect(finalAction.mock.contexts[0]).toBe(final);
    });

    it("fails closed after restored subtree and placement mutations, then recovers fresh", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      const view = directRoot(
        <StrictMode>
          <Boundary session={session} />
        </StrictMode>,
      );
      const banner = view.host.querySelector<HTMLDivElement>(
        '[data-testid="follow-banner"]',
      );
      if (!banner) throw new Error("The publication has no Follow banner");
      const separator = banner.children.item(1);
      if (!separator) throw new Error("The publication has no separator");

      separator.textContent = "changed";
      separator.textContent = "·";
      const restoredMutation = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, restoredMutation)).toBe(0);
      expect(action).not.toHaveBeenCalled();
      expect(keys.active()).toHaveLength(0);

      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={session} bannerKey="banner-b" domKey="dom-b" />
          </StrictMode>,
        );
      });
      const currentBanner = view.host.querySelector<HTMLDivElement>(
        '[data-testid="follow-banner"]',
      );
      if (!currentBanner?.parentNode) throw new Error("The successor has no placement");
      const parent = currentBanner.parentNode;
      const next = currentBanner.nextSibling;
      parent.removeChild(currentBanner);
      parent.insertBefore(currentBanner, next);
      const restoredPlacement = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, restoredPlacement)).toBe(0);
      expect(action).not.toHaveBeenCalled();
      expect(keys.active()).toHaveLength(0);

      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary session={session} bannerKey="banner-c" domKey="dom-c" />
          </StrictMode>,
        );
      });
      const accepted = dispatchKey(document.body);
      expect(preventionsFor(preventDefault, accepted)).toBe(1);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
    });

    it("releases partial Strict Mode replay and cleanup synchronously, then accepts a clean successor", () => {
      const keys = trackDocumentKeys(document);
      const preventDefault = vi.spyOn(Event.prototype, "preventDefault");
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      let stopRef: ((element: HTMLButtonElement | null) => void) | null = null;
      const view = directRoot(
        <StrictMode>
          <Boundary
            session={session}
            boundary={1}
            onBoundary={() => {
              if (stopRef) return;
              stopRef = reactHandler<(element: HTMLButtonElement | null) => void>(
                stopButton(document.body),
                "ref",
              );
            }}
            onBoundaryCleanup={() => stopRef?.(null)}
          />
        </StrictMode>,
      );
      expect(keys.active()).toHaveLength(0);
      for (const stale of keys.added) {
        const event = escapeEvent(document.body);
        invokeKey(stale, event);
        expect(preventionsFor(preventDefault, event)).toBe(0);
      }

      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary
              session={session}
              bannerKey="fresh"
              domKey="fresh"
            />
          </StrictMode>,
        );
      });
      expect(keys.active()).toHaveLength(1);
      const active = keys.active()[0]!;
      let boundaryReached = false;
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary
              session={session}
              present={false}
              boundary={1}
              onBoundary={() => {
                boundaryReached = true;
                expect(keys.active()).toHaveLength(0);
                const event = escapeEvent(document.body);
                invokeKey(active, event);
                expect(preventionsFor(preventDefault, event)).toBe(0);
              }}
            />
          </StrictMode>,
        );
      });
      expect(boundaryReached).toBe(true);
      expect(action).not.toHaveBeenCalled();

      session.publish(BASE_USER.id, [user({ name: "Grace" })]);
      act(() => {
        view.root.render(
          <StrictMode>
            <Boundary
              session={session}
              bannerKey="recovered"
              domKey="recovered"
            />
          </StrictMode>,
        );
      });
      dispatchKey(document.body);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
    });

    it("keeps owner-realm listeners and actions isolated across two documents when supported", () => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const foreignDocument = frame.contentDocument;
      if (!foreignDocument?.defaultView) {
        frame.remove();
        return;
      }
      const mainKeys = trackDocumentKeys(document);
      const foreignKeys = trackDocumentKeys(foreignDocument);
      const mainAction = vi.fn<(userId: string | null) => void>();
      const foreignAction = vi.fn<(userId: string | null) => void>();
      const main = new ControlledSession(BASE_USER.id, [user()], mainAction);
      const foreign = new ControlledSession(
        "collaborator-b",
        [user({ id: "collaborator-b", name: "Grace", clientId: 202 })],
        foreignAction,
      );
      const mainView = directRoot(
        <StrictMode>
          <FollowBanner session={main.asCollabSession()} />
        </StrictMode>,
      );
      const foreignView = directRootIn(
        foreignDocument,
        <StrictMode>
          <FollowBanner session={foreign.asCollabSession()} />
        </StrictMode>,
      );
      expect(mainKeys.active()).toHaveLength(1);
      expect(foreignKeys.active()).toHaveLength(1);

      const foreignEvent = dispatchKey(foreignDocument.body);
      expect(foreignEvent.defaultPrevented).toBe(true);
      expect(mainAction).not.toHaveBeenCalled();
      expect(foreignAction).toHaveBeenCalledExactlyOnceWith(null);
      expect(mainKeys.active()).toHaveLength(1);
      expect(foreignKeys.active()).toHaveLength(0);

      const mainEvent = dispatchKey(document.body);
      expect(mainEvent.defaultPrevented).toBe(true);
      expect(mainAction).toHaveBeenCalledExactlyOnceWith(null);
      act(() => {
        mainView.root.unmount();
        foreignView.root.unmount();
      });
      mainView.active = false;
      foreignView.active = false;
      frame.remove();
    });
  });

  const replacements = [
    "session",
    "follow-target",
    "id",
    "name",
    "color",
    "section",
    "equal-remount",
    "dom-replacement",
  ] as const;
  const replacementOrders = replacements.flatMap((replacement) =>
    (["stale-before-current", "current-before-stale"] as const).map((order) => [replacement, order] as const),
  );

  it.each(replacementOrders)(
    "retires an exact publication for %s and keeps B usable %s",
    (replacement, order) => {
      const action = vi.fn<(userId: string | null) => void>(function () {});
      const a = new ControlledSession(BASE_USER.id, [user()], action);
      let current = a;
      let bannerKey = "banner-a";
      let domKey = "dom-a";
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };
      const view = directRoot(<Boundary session={a} onPassiveCleanup={onPassiveCleanup} />);
      const aStopElement = stopButton(view.host);
      const staleStop = reactHandler<StopHandler>(aStopElement, "onClick");
      const sessions = [a];

      if (replacement === "session") {
        current = new ControlledSession(BASE_USER.id, [user()], action);
        sessions.push(current);
      } else if (replacement === "follow-target" || replacement === "id") {
        const nextId = replacement === "follow-target" ? "collaborator-b" : "collaborator-c";
        a.publish(nextId, [user({ id: nextId, clientId: 202 })]);
      } else if (replacement === "name") {
        a.publish(BASE_USER.id, [user({ name: "Grace" })]);
      } else if (replacement === "color") {
        a.publish(BASE_USER.id, [user({ color: "#654321" })]);
      } else if (replacement === "section") {
        a.publish(BASE_USER.id, [user({ section: "Details" })]);
      } else if (replacement === "equal-remount") {
        bannerKey = "banner-b";
      } else {
        domKey = "dom-b";
      }

      const probe = probeWork(view.host, action, sessions);
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner);
      focusOwner.focus();
      let currentStopElement!: HTMLButtonElement;

      try {
        act(() => {
          view.root.render(
            <Boundary
              session={current}
              bannerKey={bannerKey}
              domKey={domKey}
              passiveKey={1}
              boundary={1}
              onPassiveCleanup={onPassiveCleanup}
              onBoundary={() => {
                expect(passiveCleanups).toBe(0);
                currentStopElement = stopButton(view.host);
                const currentStop = reactHandler<StopHandler>(currentStopElement, "onClick");
                const currentReads = current.targetReads.mock.calls.length;
                const currentPresenceReads = current.presence.mock.calls.length;

                if (order === "stale-before-current") {
                  expectNoWork(() => activateStop(staleStop, aStopElement), probe);
                }
                nativeClick(currentStopElement);
                expect(current.targetReads.mock.calls.length).toBe(currentReads + 1);
                expect(current.presence.mock.calls.length).toBe(currentPresenceReads + 1);
                if (order === "current-before-stale") {
                  expectNoWork(() => activateStop(staleStop, aStopElement), probe);
                }
                expectNoWork(() => activateStop(currentStop, currentStopElement), probe);
              }}
            />,
          );
        });

        expect(passiveCleanups).toBe(1);
        expectNoWork(() => activateStop(staleStop, aStopElement), probe);
        expect(action).toHaveBeenCalledExactlyOnceWith(null);
        expect(action.mock.contexts[0]).toBe(current);
        if (replacement === "equal-remount" || replacement === "dom-replacement") {
          expect(currentStopElement).not.toBe(aStopElement);
        } else {
          expect(currentStopElement).toBe(aStopElement);
        }
      } finally {
        focusOwner.remove();
        releaseProbe(probe);
      }
    },
  );

  it.each(["follow-target removal", "presence removal", "parent removal"] as const)(
    "retires A before the parent layout boundary for %s",
    (removal) => {
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      let passiveCleanups = 0;
      const onPassiveCleanup = () => {
        passiveCleanups++;
      };
      const view = directRoot(<Boundary session={session} onPassiveCleanup={onPassiveCleanup} />);
      const staleStopElement = stopButton(view.host);
      const staleStop = reactHandler<StopHandler>(staleStopElement, "onClick");
      const probe = probeWork(view.host, action, [session]);
      const focusOwner = document.createElement("button");
      document.body.append(focusOwner);
      focusOwner.focus();

      if (removal === "follow-target removal") session.publish(null, [user()]);
      if (removal === "presence removal") session.publish(BASE_USER.id, []);

      try {
        act(() => {
          view.root.render(
            <Boundary
              session={session}
              present={removal !== "parent removal"}
              passiveKey={1}
              boundary={1}
              onPassiveCleanup={onPassiveCleanup}
              onBoundary={() => {
                expect(passiveCleanups).toBe(0);
                expect(view.host.querySelector('[data-testid="follow-banner"]')).toBeNull();
                expectNoWork(() => activateStop(staleStop, staleStopElement), probe);
              }}
            />,
          );
        });

        expect(passiveCleanups).toBe(1);
        expectNoWork(() => activateStop(staleStop, staleStopElement), probe);
        expect(action).not.toHaveBeenCalled();
      } finally {
        focusOwner.remove();
        releaseProbe(probe);
      }
    },
  );

  it("fails closed on unpublished field drift and gives continuing and follow-again publications one claim each", () => {
    const action = vi.fn<(userId: string | null) => void>();
    const session = new ControlledSession(BASE_USER.id, [user()], action);
    const view = directRoot(<Boundary session={session} />);
    const staleStopElement = stopButton(view.host);

    session.publish(BASE_USER.id, [user({ name: "Grace" })]);
    nativeClick(staleStopElement);
    expect(action).not.toHaveBeenCalled();
    const readsAfterRejection = session.targetReads.mock.calls.length;
    const presenceAfterRejection = session.presence.mock.calls.length;
    nativeClick(staleStopElement);
    expect(session.targetReads.mock.calls.length).toBe(readsAfterRejection);
    expect(session.presence.mock.calls.length).toBe(presenceAfterRejection);

    act(() => view.root.render(<Boundary session={session} passiveKey={1} />));
    const continuingStopElement = stopButton(view.host);
    nativeClick(continuingStopElement);
    nativeClick(continuingStopElement);
    expect(action).toHaveBeenCalledTimes(1);

    session.publish(null, []);
    act(() => view.root.render(<Boundary session={session} passiveKey={2} />));
    expect(view.host.querySelector('[data-testid="follow-banner"]')).toBeNull();

    session.publish(BASE_USER.id, [user({ name: "Grace" })]);
    act(() => view.root.render(<Boundary session={session} passiveKey={3} />));
    const followAgainStopElement = stopButton(view.host);
    nativeClick(followAgainStopElement);
    nativeClick(followAgainStopElement);
    expect(action).toHaveBeenCalledTimes(2);
  });

  const wrongStopSources = ["retired A Stop", "foreign connected button", "detached replacement"] as const;
  const wrongStopOrders = wrongStopSources.flatMap((source) =>
    (["wrong-before-current", "current-before-wrong"] as const).map((order) => [source, order] as const),
  );

  it.each(wrongStopOrders)(
    "rejects a %s as B's event source and keeps B usable %s",
    (source, order) => {
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user()], action);
      const view = directRoot(<Boundary session={session} />);
      const aStopElement = stopButton(view.host);

      act(() => view.root.render(<Boundary session={session} domKey="dom-b" passiveKey={1} />));
      const bStopElement = stopButton(view.host);
      const bStop = reactHandler<StopHandler>(bStopElement, "onClick");
      let wrongTarget: HTMLButtonElement;

      if (source === "retired A Stop") {
        wrongTarget = aStopElement;
        document.body.append(wrongTarget);
      } else if (source === "foreign connected button") {
        wrongTarget = document.createElement("button");
        document.body.append(wrongTarget);
      } else {
        const replacement = bStopElement.cloneNode(true);
        if (!(replacement instanceof HTMLButtonElement)) {
          throw new Error("The Stop replacement was not a button");
        }
        wrongTarget = replacement;
      }

      const probe = probeWork(view.host, action, [session]);
      try {
        if (order === "wrong-before-current") {
          expectNoWork(() => activateStop(bStop, wrongTarget), probe);
        }
        nativeClick(bStopElement);
        if (order === "current-before-wrong") {
          expectNoWork(() => activateStop(bStop, wrongTarget), probe);
        }
        expectNoWork(() => activateStop(bStop, bStopElement), probe);
        expect(action).toHaveBeenCalledExactlyOnceWith(null);
        expect(action.mock.contexts[0]).toBe(session);
      } finally {
        wrongTarget.remove();
        releaseProbe(probe);
      }
    },
  );

  it("binds the frozen session action and rejects a detached Stop DOM before session work", () => {
    const originalAction = vi.fn<(userId: string | null) => void>();
    const replacementAction = vi.fn<(userId: string | null) => void>();
    const session = new ControlledSession(BASE_USER.id, [user()], originalAction);
    const view = directRoot(<Boundary session={session} />);
    const originalStopElement = stopButton(view.host);

    session.follow = replacementAction;
    nativeClick(originalStopElement);
    expect(originalAction).toHaveBeenCalledExactlyOnceWith(null);
    expect(originalAction.mock.contexts[0]).toBe(session);
    expect(replacementAction).not.toHaveBeenCalled();

    act(() => view.root.render(<Boundary session={session} domKey="dom-b" passiveKey={1} />));
    const publishedStop = stopButton(view.host);
    const staleStop = reactHandler<StopHandler>(publishedStop, "onClick");
    const clone = publishedStop.cloneNode(true);
    publishedStop.replaceWith(clone);
    const targetReads = session.targetReads.mock.calls.length;
    const presenceReads = session.presence.mock.calls.length;
    activateStop(staleStop, publishedStop);
    expect(session.targetReads.mock.calls.length).toBe(targetReads);
    expect(session.presence.mock.calls.length).toBe(presenceReads);
    expect(originalAction).toHaveBeenCalledTimes(1);
    expect(replacementAction).not.toHaveBeenCalled();

    act(() => view.root.render(<Boundary session={session} domKey="dom-c" passiveKey={2} />));
    const currentStopElement = stopButton(view.host);
    nativeClick(currentStopElement);
    expect(originalAction).toHaveBeenCalledTimes(1);
    expect(replacementAction).toHaveBeenCalledExactlyOnceWith(null);
    expect(replacementAction.mock.contexts[0]).toBe(session);
  });
});
