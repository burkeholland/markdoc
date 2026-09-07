// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import type { AgentRequestMirror } from "./agent-requests";
import { TooltipProvider } from "@/components/ui/primitives";
import { PresenceStack, type PresenceStackProps } from "./header";

const CANCEL_GRACE_MS = 8_000;

function person(
  id: string,
  name: string,
  options: Partial<PresenceUser> = {},
): PresenceUser {
  return {
    id,
    name,
    login: id,
    avatar: null,
    color: "#2563eb",
    colorLight: "#dbeafe",
    clientId: id.length,
    cursor: 10,
    section: "Overview",
    idleSince: null,
    role: "editor",
    isLocal: false,
    isAgent: false,
    status: null,
    ownerLogin: null,
    ownerName: null,
    ...options,
  };
}

function request(
  id: string,
  userId: string,
  options: Partial<AgentRequestMirror> = {},
): AgentRequestMirror {
  return {
    id,
    userId,
    status: "open",
    mode: "suggest",
    instruction: `Instruction for ${id}`,
    claimedBy: null,
    claimedByLogin: null,
    result: null,
    updatedAt: 1,
    ...options,
  };
}

class PresenceSession {
  readonly user: { id: string; name: string; login: string; color: string; colorLight: string };
  readonly role: "owner" | "editor";
  private users: PresenceUser[];
  private requests: AgentRequestMirror[];
  private activity: { name: string; action: string; at: number } | null;
  private listeners = new Set<() => void>();
  followUserId: string | null = null;

  constructor({
    localId,
    localName,
    users,
    requests = [],
    activity = null,
    role = "owner",
  }: {
    localId: string;
    localName: string;
    users: PresenceUser[];
    requests?: AgentRequestMirror[];
    activity?: { name: string; action: string; at: number } | null;
    role?: "owner" | "editor";
  }) {
    this.user = {
      id: localId,
      name: localName,
      login: localId,
      color: "#2563eb",
      colorLight: "#dbeafe",
    };
    this.role = role;
    this.users = users;
    this.requests = requests;
    this.activity = activity;
  }

  readonly meta = {
    get: (key: string) => {
      if (key === "agentRequests") {
        return Object.fromEntries(this.requests.map((item) => [item.id, item]));
      }
      if (key === "agentActivity") return this.activity ?? undefined;
      return undefined;
    },
  };

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly presence = () => this.users;

  readonly follow = vi.fn((userId: string | null) => {
    this.followUserId = userId;
    this.publish();
  });

  setRequests(requests: AgentRequestMirror[]) {
    this.requests = requests;
    this.publish();
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}

interface PresenceCallbacks {
  onJump: NonNullable<PresenceStackProps["onJump"]>;
  onCancelRequest: NonNullable<PresenceStackProps["onCancelRequest"]>;
  onKeepAgent: NonNullable<PresenceStackProps["onKeepAgent"]>;
}

function callbacks(): PresenceCallbacks {
  return {
    onJump: vi.fn(),
    onCancelRequest: vi.fn(),
    onKeepAgent: vi.fn(),
  };
}

function PresenceBoundary({
  session,
  callbacks: handlers,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  session: PresenceSession;
  callbacks: PresenceCallbacks;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return (
    <TooltipProvider>
      {present ? (
        <PresenceStack
          session={session.asCollabSession()}
          onJump={handlers.onJump}
          onCancelRequest={handlers.onCancelRequest}
          onKeepAgent={handlers.onKeepAgent}
        />
      ) : null}
    </TooltipProvider>
  );
}

function openPresence() {
  fireEvent.click(screen.getByTestId("presence"));
  return screen.getByTestId("presence-popover");
}

function captureClick(element: HTMLElement): () => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the presence control");
  const props = (element as unknown as Record<string, { onClick?: () => void } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The presence control did not have an onClick handler");
  return props.onClick;
}

interface ReactFiber {
  return: ReactFiber | null;
  memoizedProps?: Record<string, unknown>;
}

function captureOpenChange(element: HTMLElement): (open: boolean) => void {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached to the presence trigger");
  let fiber = (element as unknown as Record<string, ReactFiber | undefined>)[fiberKey] ?? null;
  while (fiber) {
    const handler = fiber.memoizedProps?.onOpenChange;
    if (typeof handler === "function") return (open) => handler(open);
    fiber = fiber.return;
  }
  throw new Error("The presence popover did not expose an onOpenChange handler");
}

function timerCallbacks(calls: readonly (readonly unknown[])[], delay: number): Array<() => void> {
  const callbacks: Array<() => void> = [];
  for (const call of calls) {
    const callback = call[0];
    if (call[1] === delay && typeof callback === "function") callbacks.push(() => callback());
  }
  return callbacks;
}

function activeTimerHandles(
  calls: readonly (readonly unknown[])[],
  results: readonly { value?: unknown }[],
  clears: readonly (readonly unknown[])[],
  delays: readonly number[],
): unknown[] {
  const handles: unknown[] = [];
  for (const [index, call] of calls.entries()) {
    const delay = call[1];
    if (typeof delay !== "number" || !delays.includes(delay)) continue;
    const handle = results[index]?.value;
    if (!clears.some(([cleared]) => cleared === handle)) handles.push(handle);
  }
  return handles;
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-09-07T20:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PresenceStack", () => {
  it("preserves presence ordering, naming, activity, request ownership, actions, and accessibility", () => {
    const now = Date.now();
    const local = person("alice", "Alice", { isLocal: true, role: "owner" });
    const bob = person("bob", "Bob", { section: "Plan" });
    const agent = person("agent-id", "Copilot CLI", {
      isAgent: true,
      login: null,
      cursor: null,
      section: null,
      role: null,
      status: "drafting",
      ownerLogin: "burke",
      ownerName: "Burke",
      color: "#7c3aed",
    });
    const carol = person("carol", "Carol", { cursor: null });
    const dave = person("dave", "Dave", { idleSince: now - 120_000 });
    const ownRequest = request("owned-request", local.id, {
      status: "claimed",
      claimedBy: "Copilot CLI",
      claimedByLogin: "burke",
      instruction: "Tighten the introduction",
      updatedAt: 20,
    });
    const otherRequest = request("other-request", "bob", {
      mode: "comment",
      instruction: "Check the facts",
      updatedAt: 10,
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local, bob, agent, carol, dave],
      requests: [ownRequest, otherRequest],
      activity: { name: agent.name, action: "suggested", at: now - 10_000 },
      role: "editor",
    });
    const handlers = callbacks();

    render(
      <TooltipProvider>
        <PresenceStack
          session={session.asCollabSession()}
          onJump={handlers.onJump}
          onCancelRequest={handlers.onCancelRequest}
          onKeepAgent={handlers.onKeepAgent}
        />
      </TooltipProvider>,
    );

    const trigger = screen.getByTestId("presence");
    expect(trigger).toHaveAccessibleName(
      "5 people here: Alice (you), Bob, Burke's Copilot CLI (agent: drafting), Carol, Dave",
    );
    expect(screen.getAllByTestId("presence-avatar").map((avatar) => avatar.getAttribute("data-user-id"))).toEqual([
      "alice",
      "bob",
      "agent-id",
    ]);
    expect(within(trigger).getByText("+2")).toBeInTheDocument();
    expect(within(trigger).getByRole("img", { name: "Copilot CLI (agent)" })).toBeInTheDocument();
    expect(screen.getByTestId("presence-avatar-busy")).toHaveAccessibleName("Burke's Copilot CLI is working");

    const popover = openPresence();
    expect(within(popover).getByText("5 people here")).toBeInTheDocument();
    expect(within(popover).getAllByTestId("presence-row").map((row) => row.getAttribute("data-user-id"))).toEqual([
      "alice",
      "bob",
      "agent-id",
      "carol",
      "dave",
    ]);
    expect(within(popover).getByText("Burke's Copilot CLI")).toBeInTheDocument();
    expect(within(popover).getByTestId("presence-status")).toHaveTextContent("drafting");
    expect(within(popover).getByTestId("presence-activity")).toHaveTextContent("proposed changes · 10 s ago");
    expect(within(popover).getByTestId("presence-requests")).toBeInTheDocument();
    expect(within(popover).getByText("Tighten the introduction")).toBeInTheDocument();
    expect(within(popover).getByText("Check the facts")).toBeInTheDocument();
    expect(within(popover).getByText(/Burke's Copilot CLI is on it · tracked changes · asked by you/)).toBeInTheDocument();
    expect(within(popover).getByText(/Waiting for an agent · comments · asked by Bob/)).toBeInTheDocument();
    expect(within(popover).getAllByTestId("presence-request-cancel")).toHaveLength(1);
    expect(within(popover).queryByTestId("keep-agent-here")).toBeNull();
    expect(within(popover).getAllByTestId("presence-row")[0].className).not.toContain("opacity-60");
    expect(within(popover).getAllByTestId("presence-row").at(-1)).toHaveClass("opacity-60");

    fireEvent.click(within(popover).getAllByTestId("presence-follow")[0]);
    expect(session.follow).toHaveBeenCalledOnce();
    expect(session.follow).toHaveBeenCalledWith("bob");
    expect(screen.queryByTestId("presence-popover")).toBeNull();

    const reopened = openPresence();
    fireEvent.click(within(reopened).getAllByTestId("presence-jump")[0]);
    expect(handlers.onJump).toHaveBeenCalledOnce();
    expect(handlers.onJump).toHaveBeenCalledWith(bob);
    expect(screen.queryByTestId("presence-popover")).toBeNull();
  });

  it("retires replacement handlers and timers before the parent layout boundary while B stays independent", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const sharedRequestId = "shared-request";
    const sharedUserId = "shared-user";
    const localA = person("local-a", "Local A", { isLocal: true, role: "owner" });
    const remoteA = person(sharedUserId, "Remote A");
    const localB = person("local-b", "Local B", { isLocal: true, role: "owner" });
    const remoteB = person(sharedUserId, "Remote B", { section: "Current section" });
    const sessionA = new PresenceSession({
      localId: localA.id,
      localName: localA.name,
      users: [localA, remoteA],
      requests: [request(sharedRequestId, localA.id)],
      activity: { name: "Old agent", action: "edited", at: Date.now() },
    });
    const sessionB = new PresenceSession({
      localId: localB.id,
      localName: localB.name,
      users: [localB, remoteB],
      requests: [
        request(sharedRequestId, localB.id, {
          status: "claimed",
          claimedBy: "Current agent",
          claimedByLogin: localB.id,
          instruction: "Current request",
        }),
      ],
    });
    const handlersA = callbacks();
    const handlersB = callbacks();
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Persistent focus owner";
    document.body.append(focusOwner, host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<PresenceBoundary session={sessionA} callbacks={handlersA} />);
      });
      expect(vi.getTimerCount()).toBe(1);
      const popoverA = openPresence();
      const oldOpenChange = captureOpenChange(screen.getByTestId("presence"));
      const oldCancel = captureClick(within(popoverA).getByTestId("presence-request-cancel"));
      const oldJump = captureClick(within(popoverA).getByTestId("presence-jump"));
      const oldFollow = captureClick(within(popoverA).getByTestId("presence-follow"));
      const oldKeepAgent = captureClick(within(popoverA).getByTestId("keep-agent-here"));
      const oldInterval = timerCallbacks(setIntervalSpy.mock.calls, 5_000).at(-1);
      if (!oldInterval) throw new Error("The old freshness interval was not captured");
      expect(screen.getByTestId("presence-waiting")).toHaveAttribute("data-state", "waiting");
      expect(within(popoverA).getByTestId("presence-waiting-note")).toHaveTextContent("1 request waiting for an agent");

      act(() => {
        oldCancel();
        oldCancel();
      });
      expect(handlersA.onCancelRequest).toHaveBeenCalledOnce();
      expect(handlersA.onCancelRequest).toHaveBeenCalledWith(sharedRequestId);
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(1);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      const oldGrace = timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS).at(-1);
      if (!oldGrace) throw new Error("The old cancellation grace timer was not captured");
      let graceTimersAtBoundary = -1;
      let freshnessIntervalsAtBoundary = -1;

      await act(async () => {
        root.render(
          <PresenceBoundary
            session={sessionB}
            callbacks={handlersB}
            boundary={1}
            onBoundary={() => {
              graceTimersAtBoundary = activeTimerHandles(
                setTimeoutSpy.mock.calls,
                setTimeoutSpy.mock.results,
                clearTimeoutSpy.mock.calls,
                [CANCEL_GRACE_MS],
              ).length;
              freshnessIntervalsAtBoundary = activeTimerHandles(
                setIntervalSpy.mock.calls,
                setIntervalSpy.mock.results,
                clearIntervalSpy.mock.calls,
                [5_000, 15_000],
              ).length;
              focusOwner.focus();
              oldCancel();
              oldJump();
              oldFollow();
              oldKeepAgent();
              oldOpenChange(true);
              oldGrace();
              oldInterval();
            }}
          />,
        );
      });

      expect(graceTimersAtBoundary).toBe(0);
      expect(freshnessIntervalsAtBoundary).toBe(1);
      expect(focusOwner).toHaveFocus();
      expect(screen.queryByTestId("presence-popover")).toBeNull();
      expect(screen.getByTestId("presence")).toHaveAccessibleName("2 people here: Local B (you), Remote B");
      expect(screen.getByTestId("presence")).not.toHaveAccessibleName(/Local A|Remote A/);
      expect(handlersA.onCancelRequest).toHaveBeenCalledOnce();
      expect(handlersA.onJump).not.toHaveBeenCalled();
      expect(handlersA.onKeepAgent).not.toHaveBeenCalled();
      expect(sessionA.follow).not.toHaveBeenCalled();
      expect(handlersB.onCancelRequest).not.toHaveBeenCalled();
      expect(handlersB.onJump).not.toHaveBeenCalled();
      expect(handlersB.onKeepAgent).not.toHaveBeenCalled();
      expect(sessionB.follow).not.toHaveBeenCalled();

      let popoverB = openPresence();
      expect(within(popoverB).getByText("Current request")).toBeInTheDocument();
      expect(screen.getByTestId("presence-waiting")).toHaveAttribute("data-state", "working");
      expect(within(popoverB).queryByTestId("presence-waiting-note")).toBeNull();
      const currentJump = captureClick(within(popoverB).getByTestId("presence-jump"));
      act(() => currentJump());
      expect(handlersB.onJump).toHaveBeenCalledOnce();
      expect(handlersB.onJump).toHaveBeenCalledWith(remoteB);

      popoverB = openPresence();
      const currentFollow = captureClick(within(popoverB).getByTestId("presence-follow"));
      act(() => currentFollow());
      expect(sessionB.follow).toHaveBeenCalledOnce();
      expect(sessionB.follow).toHaveBeenCalledWith(sharedUserId);

      popoverB = openPresence();
      const currentKeepAgent = captureClick(within(popoverB).getByTestId("keep-agent-here"));
      act(() => currentKeepAgent());
      expect(handlersB.onKeepAgent).toHaveBeenCalledOnce();

      popoverB = openPresence();
      const currentCancel = captureClick(within(popoverB).getByTestId("presence-request-cancel"));
      act(() => {
        currentCancel();
        currentCancel();
      });
      expect(handlersB.onCancelRequest).toHaveBeenCalledOnce();
      expect(handlersB.onCancelRequest).toHaveBeenCalledWith(sharedRequestId);
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(1);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      const currentGrace = timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS).at(-1);
      if (!currentGrace || currentGrace === oldGrace) throw new Error("The current cancellation grace timer was not captured");

      act(() => oldGrace());
      expect(screen.queryByTestId("presence-request")).toBeNull();
      act(() => currentGrace());
      expect(screen.getByTestId("presence-request")).toHaveTextContent("Current request");
      act(() => oldGrace());
      expect(screen.getByTestId("presence-request")).toHaveTextContent("Current request");
      expect(handlersB.onCancelRequest).toHaveBeenCalledOnce();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);

      act(() => sessionB.setRequests([]));
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });

  it("clears removal work before the parent boundary and ignores old timers after current expiry or settlement", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const sharedRequestId = "removed-and-current";
    const sharedUserId = "same-user";
    const localA = person("removed-local", "Removed local", { isLocal: true, role: "owner" });
    const remoteA = person(sharedUserId, "Removed remote");
    const localB = person("current-local", "Current local", { isLocal: true, role: "owner" });
    const remoteB = person(sharedUserId, "Current remote");
    const sessionA = new PresenceSession({
      localId: localA.id,
      localName: localA.name,
      users: [localA, remoteA],
      requests: [request(sharedRequestId, localA.id)],
    });
    const sessionB = new PresenceSession({
      localId: localB.id,
      localName: localB.name,
      users: [localB, remoteB],
      requests: [request(sharedRequestId, localB.id, { instruction: "Remounted request" })],
    });
    const handlersA = callbacks();
    const handlersB = callbacks();
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Removal focus owner";
    document.body.append(focusOwner, host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<PresenceBoundary session={sessionA} callbacks={handlersA} />);
      });
      const popoverA = openPresence();
      const oldOpenChange = captureOpenChange(screen.getByTestId("presence"));
      const oldCancel = captureClick(within(popoverA).getByTestId("presence-request-cancel"));
      const oldJump = captureClick(within(popoverA).getByTestId("presence-jump"));
      const oldFollow = captureClick(within(popoverA).getByTestId("presence-follow"));
      const oldKeepAgent = captureClick(within(popoverA).getByTestId("keep-agent-here"));
      const oldInterval = timerCallbacks(setIntervalSpy.mock.calls, 15_000).at(-1);
      if (!oldInterval) throw new Error("The removed freshness interval was not captured");
      act(() => oldCancel());
      const oldGrace = timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS).at(-1);
      if (!oldGrace) throw new Error("The removed cancellation grace timer was not captured");
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(1);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      let graceTimersAtBoundary = -1;
      let freshnessIntervalsAtBoundary = -1;

      await act(async () => {
        root.render(
          <PresenceBoundary
            session={sessionA}
            callbacks={handlersA}
            present={false}
            boundary={1}
            onBoundary={() => {
              graceTimersAtBoundary = activeTimerHandles(
                setTimeoutSpy.mock.calls,
                setTimeoutSpy.mock.results,
                clearTimeoutSpy.mock.calls,
                [CANCEL_GRACE_MS],
              ).length;
              freshnessIntervalsAtBoundary = activeTimerHandles(
                setIntervalSpy.mock.calls,
                setIntervalSpy.mock.results,
                clearIntervalSpy.mock.calls,
                [5_000, 15_000],
              ).length;
              focusOwner.focus();
              oldCancel();
              oldJump();
              oldFollow();
              oldKeepAgent();
              oldOpenChange(true);
              oldGrace();
              oldInterval();
            }}
          />,
        );
      });

      expect(graceTimersAtBoundary).toBe(0);
      expect(freshnessIntervalsAtBoundary).toBe(0);
      expect(focusOwner).toHaveFocus();
      expect(screen.queryByTestId("presence")).toBeNull();
      expect(handlersA.onCancelRequest).toHaveBeenCalledOnce();
      expect(handlersA.onJump).not.toHaveBeenCalled();
      expect(handlersA.onKeepAgent).not.toHaveBeenCalled();
      expect(sessionA.follow).not.toHaveBeenCalled();

      await act(async () => {
        root.render(
          <PresenceBoundary
            session={sessionB}
            callbacks={handlersB}
            boundary={2}
          />,
        );
      });
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      expect(screen.queryByTestId("presence-popover")).toBeNull();
      let popoverB = openPresence();
      expect(within(popoverB).getByText("Remounted request")).toBeInTheDocument();
      const currentCancel = captureClick(within(popoverB).getByTestId("presence-request-cancel"));

      act(() => {
        currentCancel();
        currentCancel();
      });
      expect(handlersB.onCancelRequest).toHaveBeenCalledOnce();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(1);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      const firstCurrentGrace = timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS).at(-1);
      if (!firstCurrentGrace || firstCurrentGrace === oldGrace) throw new Error("The first current grace timer was not captured");

      act(() => firstCurrentGrace());
      expect(screen.getByTestId("presence-request")).toHaveTextContent("Remounted request");
      act(() => oldGrace());
      expect(screen.getByTestId("presence-request")).toHaveTextContent("Remounted request");
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);

      act(() => currentCancel());
      expect(handlersB.onCancelRequest).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(1);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      const secondCurrentGrace = timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS).at(-1);
      if (!secondCurrentGrace || secondCurrentGrace === firstCurrentGrace) throw new Error("The second current grace timer was not captured");

      act(() => sessionB.setRequests([]));
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);
      act(() => {
        secondCurrentGrace();
        oldGrace();
        oldInterval();
      });
      expect(screen.queryByTestId("presence-request")).toBeNull();
      expect(handlersB.onCancelRequest).toHaveBeenCalledTimes(2);
      expect(handlersB.onJump).not.toHaveBeenCalled();
      expect(handlersB.onKeepAgent).not.toHaveBeenCalled();
      expect(sessionB.follow).not.toHaveBeenCalled();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);

      popoverB = screen.getByTestId("presence-popover");
      expect(within(popoverB).queryByTestId("presence-requests")).toBeNull();
      expect(within(popoverB).getByTestId("keep-agent-here")).toBeEnabled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});
