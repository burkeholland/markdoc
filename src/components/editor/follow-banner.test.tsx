// @vitest-environment jsdom

import { useEffect, useLayoutEffect, type MouseEvent as ReactMouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
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
  onPassiveCleanup,
}: BoundaryProps) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
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
                activateStop(currentStop, currentStopElement);
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
    const staleStop = reactHandler<StopHandler>(staleStopElement, "onClick");

    session.publish(BASE_USER.id, [user({ name: "Grace" })]);
    activateStop(staleStop, staleStopElement);
    expect(action).not.toHaveBeenCalled();
    const readsAfterRejection = session.targetReads.mock.calls.length;
    const presenceAfterRejection = session.presence.mock.calls.length;
    activateStop(staleStop, staleStopElement);
    expect(session.targetReads.mock.calls.length).toBe(readsAfterRejection);
    expect(session.presence.mock.calls.length).toBe(presenceAfterRejection);

    act(() => view.root.render(<Boundary session={session} passiveKey={1} />));
    const continuingStopElement = stopButton(view.host);
    const continuingStop = reactHandler<StopHandler>(continuingStopElement, "onClick");
    activateStop(continuingStop, continuingStopElement);
    activateStop(continuingStop, continuingStopElement);
    expect(action).toHaveBeenCalledTimes(1);

    session.publish(null, []);
    act(() => view.root.render(<Boundary session={session} passiveKey={2} />));
    expect(view.host.querySelector('[data-testid="follow-banner"]')).toBeNull();

    session.publish(BASE_USER.id, [user({ name: "Grace" })]);
    act(() => view.root.render(<Boundary session={session} passiveKey={3} />));
    const followAgainStopElement = stopButton(view.host);
    const followAgainStop = reactHandler<StopHandler>(followAgainStopElement, "onClick");
    activateStop(followAgainStop, followAgainStopElement);
    activateStop(followAgainStop, followAgainStopElement);
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
        activateStop(bStop, bStopElement);
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
    const originalStop = reactHandler<StopHandler>(originalStopElement, "onClick");

    session.follow = replacementAction;
    activateStop(originalStop, originalStopElement);
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
    const currentStop = reactHandler<StopHandler>(currentStopElement, "onClick");
    activateStop(currentStop, currentStopElement);
    expect(originalAction).toHaveBeenCalledTimes(1);
    expect(replacementAction).toHaveBeenCalledExactlyOnceWith(null);
    expect(replacementAction.mock.contexts[0]).toBe(session);
  });
});
