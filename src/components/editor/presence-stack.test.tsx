// @vitest-environment jsdom
import { StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import type { AgentRequestMirror } from "./agent-requests";
import { TooltipProvider } from "@/components/ui/primitives";
import { PresenceStack, type PresenceStackProps } from "./header";
import { KeepAgentHereButton, PresenceRequests } from "./presence-agents";

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

interface PresenceLeafCallbacks {
  onCancel: (requestId: string) => void;
  onKeep: () => void;
}

interface PresenceLeafProps {
  session: PresenceSession;
  pending: AgentRequestMirror[];
  callbacks: PresenceLeafCallbacks;
  nameOf: (userId: string) => string | null;
  ownerNameOf?: (login: string) => string | null;
  primary?: boolean;
}

function PresenceLeafMount({ session, pending, callbacks: handlers, nameOf, ownerNameOf, primary }: PresenceLeafProps) {
  return (
    <div data-testid="presence-leaves">
      <PresenceRequests
        session={session.asCollabSession()}
        pending={pending}
        nameOf={nameOf}
        ownerNameOf={ownerNameOf}
        onCancel={handlers.onCancel}
      />
      <KeepAgentHereButton onClick={handlers.onKeep} primary={primary} />
    </div>
  );
}

function PresenceLeafBoundary({
  present = true,
  instance = "leaf",
  boundary = 0,
  onBoundary,
  ...props
}: PresenceLeafProps & {
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <PresenceLeafMount key={instance} {...props} /> : null;
}

function openPresence() {
  fireEvent.click(screen.getByTestId("presence"));
  return screen.getByTestId("presence-popover");
}

type CapturedClick = (event: unknown) => void;

function reactPropsEntry(element: HTMLElement): {
  key: string;
  record: Record<string, { onClick?: CapturedClick; ref?: (node: HTMLElement | null) => void }>;
  props: { onClick?: CapturedClick; ref?: (node: HTMLElement | null) => void };
} {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the presence control");
  const record = element as unknown as Record<string, { onClick?: CapturedClick; ref?: (node: HTMLElement | null) => void }>;
  return { key: propsKey, record, props: record[propsKey]! };
}

function captureClick(element: HTMLElement): CapturedClick {
  if (!(element instanceof HTMLButtonElement)) throw new Error("The presence control was not a button");
  const props = reactPropsEntry(element).props;
  if (!props?.onClick) throw new Error("The presence control did not have an onClick handler");
  return props.onClick;
}

function interceptClick(
  element: HTMLButtonElement,
  invoke: (current: CapturedClick, event: unknown) => void,
): () => void {
  const { key, record, props } = reactPropsEntry(element);
  const current = props.onClick;
  if (!current) throw new Error("The presence control did not have an onClick handler");
  const intercepted = { ...props, onClick: (event: unknown) => invoke(current, event) };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function captureRef<T extends HTMLElement>(element: T): (node: T | null) => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, { ref?: unknown }>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as (node: T | null) => void;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error("React fiber was not attached to the presence control");
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error("The presence control did not have a callback ref");
  return fiber.ref as (node: T | null) => void;
}

function leafElements(root: HTMLElement) {
  const scope = within(root);
  const section = scope.getByTestId("presence-requests");
  const list = section.children.item(1);
  const rows = scope.getAllByTestId("presence-request");
  const cancels = scope.queryAllByTestId("presence-request-cancel");
  const keep = scope.getByTestId("keep-agent-here");
  if (!(section instanceof HTMLDivElement) || !(list instanceof HTMLUListElement)) {
    throw new Error("The request section and list were not rendered");
  }
  if (!rows.every((row) => row instanceof HTMLLIElement) || !cancels.every((cancel) => cancel instanceof HTMLButtonElement) || !(keep instanceof HTMLButtonElement)) {
    throw new Error("The request rows and actions were not rendered");
  }
  return {
    section,
    list,
    rows: rows as HTMLLIElement[],
    cancels: cancels as HTMLButtonElement[],
    keep,
  };
}

function connectedButton(label = "Other action") {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  document.body.append(button);
  return button;
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
  document.body.replaceChildren();
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

  it.each(["a-before-b", "b-before-a"] as const)(
    "binds request and keep-agent actions to exact sibling controls in %s order",
    (order) => {
      const localA = person("leaf-local-a", "Leaf local A", { isLocal: true, role: "owner" });
      const localB = person("leaf-local-b", "Leaf local B", { isLocal: true, role: "editor" });
      const sessionA = new PresenceSession({
        localId: localA.id,
        localName: localA.name,
        users: [localA],
        role: "owner",
      });
      const sessionB = new PresenceSession({
        localId: localB.id,
        localName: localB.name,
        users: [localB],
        role: "editor",
      });
      const pendingA = [
        request("leaf-request-a", localA.id, { instruction: "First owner request" }),
        request("leaf-request-a-2", "another-user", { instruction: "Second owner request" }),
      ];
      const pendingB = [
        request("leaf-request-b", localB.id, { instruction: "Editor request" }),
        request("leaf-request-b-2", "foreign-user", { instruction: "Not cancellable" }),
      ];
      const callbacksA: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
        onKeep: vi.fn(),
      };
      const callbacksB: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
        onKeep: vi.fn(),
      };
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      const foreign = connectedButton("Cancel request");
      const detached = document.createElement("button");
      focusOwner.textContent = "Leaf focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);

      try {
        act(() => {
          root.render(
            <>
              <div data-testid="leaf-a">
                <PresenceLeafMount
                  session={sessionA}
                  pending={pendingA}
                  callbacks={callbacksA}
                  nameOf={(id) => id}
                  primary
                />
              </div>
              <div data-testid="leaf-b">
                <PresenceLeafMount
                  session={sessionB}
                  pending={pendingB}
                  callbacks={callbacksB}
                  nameOf={(id) => id}
                />
              </div>
            </>,
          );
        });
        const a = leafElements(screen.getByTestId("leaf-a"));
        const b = leafElements(screen.getByTestId("leaf-b"));
        expect(a.cancels).toHaveLength(2);
        expect(b.cancels).toHaveLength(1);
        expect(a.keep).toHaveClass("btn-primary");
        expect(b.keep).toHaveClass("btn-outline", "btn-sm");
        const cancelA = captureClick(a.cancels[0]);
        const cancelB = captureClick(b.cancels[0]);
        const keepA = captureClick(a.keep);
        const keepB = captureClick(b.keep);
        const replacementCancel = a.cancels[0].cloneNode(true) as HTMLButtonElement;
        const replacementKeep = a.keep.cloneNode(true) as HTMLButtonElement;
        document.body.append(replacementCancel, replacementKeep);
        const markup = host.innerHTML;
        const movingAEvent = { currentTarget: foreign as HTMLElement };
        focusOwner.focus();

        act(() => {
          cancelA({ currentTarget: a.cancels[1] });
          cancelA({ currentTarget: b.cancels[0] });
          cancelA({ currentTarget: b.rows[1] });
          cancelA({ currentTarget: foreign });
          cancelA({ currentTarget: detached });
          cancelA({ currentTarget: replacementCancel });
          cancelB({ currentTarget: a.cancels[0] });
          keepA({ currentTarget: b.keep });
          keepA({ currentTarget: foreign });
          keepA({ currentTarget: detached });
          keepA({ currentTarget: replacementKeep });
          keepB({ currentTarget: a.keep });
          cancelA(movingAEvent);
        });

        expect(callbacksA.onCancel).not.toHaveBeenCalled();
        expect(callbacksB.onCancel).not.toHaveBeenCalled();
        expect(callbacksA.onKeep).not.toHaveBeenCalled();
        expect(callbacksB.onKeep).not.toHaveBeenCalled();
        expect(focusOwner).toHaveFocus();
        expect(host.innerHTML).toBe(markup);
        expect(sessionA.follow).not.toHaveBeenCalled();
        expect(sessionB.follow).not.toHaveBeenCalled();

        act(() => {
          if (order === "a-before-b") {
            a.cancels[0].click();
            b.cancels[0].click();
          } else {
            b.cancels[0].click();
            a.cancels[0].click();
          }
          a.keep.click();
          a.keep.click();
          b.keep.click();
          b.keep.click();
        });

        expect(callbacksA.onCancel).toHaveBeenCalledExactlyOnceWith("leaf-request-a");
        expect(callbacksB.onCancel).toHaveBeenCalledExactlyOnceWith("leaf-request-b");
        expect(callbacksA.onKeep).toHaveBeenCalledOnce();
        expect(callbacksB.onKeep).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
        focusOwner.remove();
        foreign.remove();
        detached.remove();
      }
    },
  );

  it.each(["section", "list", "row", "cancel", "keep"] as const)(
    "retires an exact %s ref replacement without letting late old refs clear same-element successors",
    (part) => {
      const local = person("ref-local", "Ref local", { isLocal: true, role: "owner" });
      const session = new PresenceSession({
        localId: local.id,
        localName: local.name,
        users: [local],
      });
      const pending = [request("ref-request", local.id)];
      const callbacksA: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
        onKeep: vi.fn(),
      };
      const callbacksB: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
        onKeep: vi.fn(),
      };
      const nameOf = (id: string) => id;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);

      try {
        act(() => {
          root.render(
            <PresenceLeafBoundary
              session={session}
              pending={pending}
              callbacks={callbacksA}
              nameOf={nameOf}
            />,
          );
        });
        const previous = leafElements(screen.getByTestId("presence-leaves"));
        const previousCancel = captureClick(previous.cancels[0]);
        const previousKeep = captureClick(previous.keep);
        const element =
          part === "section"
            ? previous.section
            : part === "list"
              ? previous.list
              : part === "row"
                ? previous.rows[0]
                : part === "cancel"
                  ? previous.cancels[0]
                  : previous.keep;
        const staleRef = captureRef(element);
        const replacement = element.cloneNode(true) as typeof element;
        document.body.append(replacement);

        act(() => {
          staleRef(replacement);
          if (part === "keep") {
            previousKeep({ currentTarget: previous.keep });
          } else {
            previousCancel({ currentTarget: previous.cancels[0] });
          }
        });
        expect(callbacksA.onCancel).not.toHaveBeenCalled();
        expect(callbacksA.onKeep).not.toHaveBeenCalled();
        replacement.remove();

        let sameElementAtBoundary = false;
        act(() => {
          root.render(
            <PresenceLeafBoundary
              session={session}
              pending={pending}
              callbacks={callbacksB}
              nameOf={nameOf}
              boundary={1}
              onBoundary={() => {
                const current = leafElements(screen.getByTestId("presence-leaves"));
                const currentElement =
                  part === "section"
                    ? current.section
                    : part === "list"
                      ? current.list
                      : part === "row"
                        ? current.rows[0]
                        : part === "cancel"
                          ? current.cancels[0]
                          : current.keep;
                sameElementAtBoundary = currentElement === element;
                staleRef(currentElement);
                staleRef(null);
                previousCancel({ currentTarget: current.cancels[0] });
                previousKeep({ currentTarget: current.keep });
              }}
            />,
          );
        });

        expect(sameElementAtBoundary).toBe(true);
        expect(callbacksA.onCancel).not.toHaveBeenCalled();
        expect(callbacksA.onKeep).not.toHaveBeenCalled();
        const current = leafElements(screen.getByTestId("presence-leaves"));
        act(() => {
          current.cancels[0].click();
          current.keep.click();
        });
        expect(callbacksB.onCancel).toHaveBeenCalledExactlyOnceWith("ref-request");
        expect(callbacksB.onKeep).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    { control: "Cancel", primary: undefined },
    { control: "Keep agent outline", primary: false },
    { control: "Keep agent primary", primary: true },
  ] as const)(
    "keeps $control exact through direct Strict Mode replay, corruption, remount, repetition, and reentry",
    ({ control, primary }) => {
      const local = person(`strict-${control}`, `Strict ${control}`, { isLocal: true, role: "owner" });
      const session = new PresenceSession({
        localId: local.id,
        localName: local.name,
        users: [local],
        role: "owner",
      });
      const pending = [
        request("strict-request-a", local.id, { instruction: "Strict first request" }),
        request("strict-request-b", "strict-other", { instruction: "Strict second request" }),
      ];
      const onCancel = vi.fn<(requestId: string) => void>();
      const onKeep = vi.fn<() => void>();
      const handlers = { onCancel, onKeep };
      const nameOf = (id: string) => `Name ${id}`;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const isCancel = control === "Cancel";
      let retired:
        | {
            click: CapturedClick;
            rootRef: (node: HTMLElement | null) => void;
            actionRef: (node: HTMLButtonElement | null) => void;
          }
        | undefined;

      const renderStrictLeaf = (instance: string, boundary: number, onBoundary?: () => void) => (
        <StrictMode>
          <PresenceLeafBoundary
            session={session}
            pending={pending}
            callbacks={handlers}
            nameOf={nameOf}
            primary={primary}
            instance={instance}
            boundary={boundary}
            onBoundary={onBoundary}
          />
        </StrictMode>
      );
      const targetOf = (elements: ReturnType<typeof leafElements>) =>
        isCancel ? elements.cancels[0]! : elements.keep;
      const rootOf = (elements: ReturnType<typeof leafElements>): HTMLElement =>
        isCancel ? elements.section : elements.keep;

      try {
        act(() => {
          root.render(
            renderStrictLeaf("strict-a", 1, () => {
              if (retired) return;
              const elements = leafElements(screen.getByTestId("presence-leaves"));
              const target = targetOf(elements);
              retired = {
                click: captureClick(target),
                rootRef: captureRef<HTMLElement>(rootOf(elements)),
                actionRef: captureRef(target),
              };
            }),
          );
        });
        if (!retired) throw new Error("Strict Mode did not expose the retired publication");
        const retiredPublication = retired;
        const firstCurrent = leafElements(screen.getByTestId("presence-leaves"));
        const firstCurrentTarget = targetOf(firstCurrent);
        const firstCurrentRoot = rootOf(firstCurrent);
        const firstCurrentClick = captureClick(firstCurrentTarget);
        const firstCurrentRootRef = captureRef<HTMLElement>(firstCurrentRoot);
        const firstCurrentActionRef = captureRef(firstCurrentTarget);
        expect(firstCurrentClick).not.toBe(retiredPublication.click);
        expect(firstCurrentTarget).toHaveClass(
          ...(primary ? ["btn-primary"] : isCancel ? ["btn-outline"] : ["btn-outline", "btn-sm"]),
        );

        if (isCancel) {
          const originalInstruction = pending[0]!.instruction;
          pending[0]!.instruction = "Transiently changed request";
          act(() => firstCurrentTarget.click());
          pending[0]!.instruction = originalInstruction;
        } else {
          const originalClassName = firstCurrentTarget.className;
          firstCurrentTarget.className = `${originalClassName} changed`;
          act(() => firstCurrentTarget.click());
          firstCurrentTarget.className = originalClassName;
        }
        expect(onCancel).not.toHaveBeenCalled();
        expect(onKeep).not.toHaveBeenCalled();

        act(() => {
          firstCurrentActionRef(null);
          firstCurrentActionRef(firstCurrentTarget);
          firstCurrentTarget.click();
        });
        expect(onCancel).not.toHaveBeenCalled();
        expect(onKeep).not.toHaveBeenCalled();

        const label = firstCurrentTarget.lastChild;
        if (!label || label.nodeType !== document.defaultView!.Node.TEXT_NODE) {
          throw new Error("The Strict Mode action label was not a text node");
        }
        const originalLabel = label.nodeValue;
        label.nodeValue = `${originalLabel} changed`;
        label.nodeValue = originalLabel;
        if (isCancel) {
          const clone = firstCurrent.rows[0]!.cloneNode(true) as HTMLLIElement;
          firstCurrent.rows[0]!.replaceWith(clone);
          clone.replaceWith(firstCurrent.rows[0]!);
          firstCurrent.list.insertBefore(firstCurrent.rows[1]!, firstCurrent.rows[0]!);
          firstCurrent.list.insertBefore(firstCurrent.rows[0]!, firstCurrent.rows[1]!);
        }
        const parent = firstCurrentRoot.parentNode;
        if (!parent) throw new Error("The Strict Mode publication did not have a parent");
        const nextSibling = firstCurrentRoot.nextSibling;
        firstCurrentRoot.remove();
        parent.insertBefore(firstCurrentRoot, nextSibling);
        act(() => firstCurrentTarget.click());
        expect(onCancel).not.toHaveBeenCalled();
        expect(onKeep).not.toHaveBeenCalled();

        act(() => root.render(renderStrictLeaf("strict-b", 2)));
        const current = leafElements(screen.getByTestId("presence-leaves"));
        const currentTarget = targetOf(current);
        const currentRoot = rootOf(current);
        const currentClick = captureClick(currentTarget);
        expect(currentTarget).not.toBe(firstCurrentTarget);
        expect(currentClick).not.toBe(firstCurrentClick);

        act(() => {
          retiredPublication.rootRef(currentRoot);
          retiredPublication.actionRef(currentTarget);
          retiredPublication.actionRef(null);
          retiredPublication.rootRef(null);
          firstCurrentRootRef(currentRoot);
          firstCurrentActionRef(currentTarget);
          firstCurrentActionRef(null);
          firstCurrentRootRef(null);
          retiredPublication.click({});
          firstCurrentClick({});
          currentClick({});
        });
        expect(onCancel).not.toHaveBeenCalled();
        expect(onKeep).not.toHaveBeenCalled();

        const action = isCancel ? onCancel : onKeep;
        action.mockImplementationOnce(() => {
          currentTarget.dispatchEvent(new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }));
        });
        const restore = interceptClick(currentTarget, (active, event) => {
          retiredPublication.click(event);
          firstCurrentClick(event);
          active(event);
          active(event);
        });
        act(() => {
          currentTarget.click();
          currentTarget.click();
        });
        restore();

        if (isCancel) {
          expect(onCancel).toHaveBeenCalledExactlyOnceWith("strict-request-a");
          expect(onKeep).not.toHaveBeenCalled();
        } else {
          expect(onKeep).toHaveBeenCalledOnce();
          expect(onCancel).not.toHaveBeenCalled();
        }
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("retires changed and equal-looking leaf mounts before parent boundaries and removal", () => {
    const localA = person("mount-local-a", "Mount local A", { isLocal: true, role: "owner" });
    const localB = person("mount-local-b", "Mount local B", { isLocal: true, role: "owner" });
    const sessionA = new PresenceSession({
      localId: localA.id,
      localName: localA.name,
      users: [localA],
      role: "editor",
    });
    const sessionB = new PresenceSession({
      localId: localB.id,
      localName: localB.name,
      users: [localB],
      role: "owner",
    });
    const pendingA = [request("mount-request", localA.id, { instruction: "Old request" })];
    const pendingB = [
      request("mount-request", "another-user", {
        status: "claimed",
        claimedBy: "Agent",
        claimedByLogin: "agent-owner",
        instruction: "Current request",
        mode: "comment",
      }),
    ];
    const callbacksA: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
      onKeep: vi.fn(),
    };
    const callbacksB: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
      onKeep: vi.fn(),
    };
    const callbacksC: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
      onKeep: vi.fn(),
    };
    const callbacksD: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
      onKeep: vi.fn(),
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionA}
            pending={pendingA}
            callbacks={callbacksA}
            nameOf={() => "Old requester"}
            ownerNameOf={() => "Old owner"}
          />,
        );
      });
      const old = leafElements(screen.getByTestId("presence-leaves"));
      const oldCancel = captureClick(old.cancels[0]);
      const oldKeep = captureClick(old.keep);
      const oldCancelRef = captureRef(old.cancels[0]);
      const oldKeepRef = captureRef(old.keep);
      let changedAtBoundary = false;

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksB}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            primary
            boundary={1}
            onBoundary={() => {
              const current = leafElements(screen.getByTestId("presence-leaves"));
              changedAtBoundary =
                current.cancels[0] === old.cancels[0] &&
                current.keep === old.keep &&
                current.rows[0].textContent?.includes("Current requester") === true &&
                current.rows[0].textContent?.includes("Current owner's Agent") === true &&
                current.keep.classList.contains("btn-primary");
              oldCancelRef(current.cancels[0]);
              oldCancelRef(null);
              oldKeepRef(current.keep);
              oldKeepRef(null);
              oldCancel({ currentTarget: current.cancels[0] });
              oldKeep({ currentTarget: current.keep });
            }}
          />,
        );
      });

      expect(changedAtBoundary).toBe(true);
      expect(callbacksA.onCancel).not.toHaveBeenCalled();
      expect(callbacksA.onKeep).not.toHaveBeenCalled();
      const changed = leafElements(screen.getByTestId("presence-leaves"));
      const changedCancel = captureClick(changed.cancels[0]);
      const changedKeep = captureClick(changed.keep);
      const changedCancelRef = captureRef(changed.cancels[0]);
      const changedKeepRef = captureRef(changed.keep);
      let remountedAtBoundary = false;

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksC}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            primary
            instance="equal-looking-remount"
            boundary={2}
            onBoundary={() => {
              const current = leafElements(screen.getByTestId("presence-leaves"));
              remountedAtBoundary =
                current.cancels[0] !== changed.cancels[0] &&
                current.keep !== changed.keep;
              changedCancelRef(current.cancels[0]);
              changedCancelRef(null);
              changedKeepRef(current.keep);
              changedKeepRef(null);
              changedCancel({ currentTarget: changed.cancels[0] });
              changedCancel({ currentTarget: current.cancels[0] });
              changedKeep({ currentTarget: changed.keep });
              changedKeep({ currentTarget: current.keep });
            }}
          />,
        );
      });

      expect(remountedAtBoundary).toBe(true);
      expect(callbacksB.onCancel).not.toHaveBeenCalled();
      expect(callbacksB.onKeep).not.toHaveBeenCalled();
      const remounted = leafElements(screen.getByTestId("presence-leaves"));
      const remountedCancel = captureClick(remounted.cancels[0]);
      const remountedKeep = captureClick(remounted.keep);
      const remountedCancelRef = captureRef(remounted.cancels[0]);
      const remountedKeepRef = captureRef(remounted.keep);
      act(() => {
        remounted.keep.click();
        remounted.cancels[0].click();
      });
      expect(callbacksC.onCancel).toHaveBeenCalledExactlyOnceWith("mount-request");
      expect(callbacksC.onKeep).toHaveBeenCalledOnce();

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksC}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            primary
            instance="equal-looking-remount"
            present={false}
            boundary={3}
            onBoundary={() => {
              remountedCancelRef(null);
              remountedKeepRef(null);
              remountedCancel({ currentTarget: remounted.cancels[0] });
              remountedKeep({ currentTarget: remounted.keep });
            }}
          />,
        );
      });
      expect(screen.queryByTestId("presence-leaves")).toBeNull();
      expect(callbacksC.onCancel).toHaveBeenCalledOnce();
      expect(callbacksC.onKeep).toHaveBeenCalledOnce();

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksD}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            primary
            instance="after-removal"
            boundary={4}
          />,
        );
      });
      const afterRemoval = leafElements(screen.getByTestId("presence-leaves"));
      act(() => {
        afterRemoval.cancels[0].click();
        afterRemoval.keep.click();
      });
      expect(callbacksD.onCancel).toHaveBeenCalledExactlyOnceWith("mount-request");
      expect(callbacksD.onKeep).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
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
      const oldCancelButton = within(popoverA).getByTestId("presence-request-cancel");
      const oldJumpButton = within(popoverA).getByTestId("presence-jump");
      const oldFollowButton = within(popoverA).getByTestId("presence-follow");
      const oldKeepAgentButton = within(popoverA).getByTestId("keep-agent-here");
      const oldCancel = captureClick(oldCancelButton);
      const oldJump = captureClick(oldJumpButton);
      const oldFollow = captureClick(oldFollowButton);
      const oldKeepAgent = captureClick(oldKeepAgentButton);
      const oldInterval = timerCallbacks(setIntervalSpy.mock.calls, 5_000).at(-1);
      if (!oldInterval) throw new Error("The old freshness interval was not captured");
      expect(screen.getByTestId("presence-waiting")).toHaveAttribute("data-state", "waiting");
      expect(within(popoverA).getByTestId("presence-waiting-note")).toHaveTextContent("1 request waiting for an agent");

      act(() => oldCancelButton.click());
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
              oldCancel({ currentTarget: oldCancelButton });
              oldJump({ currentTarget: oldJumpButton });
              oldFollow({ currentTarget: oldFollowButton });
              oldKeepAgent({ currentTarget: oldKeepAgentButton });
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
      const currentJumpButton = within(popoverB).getByTestId("presence-jump");
      const currentJump = captureClick(currentJumpButton);
      act(() => currentJump({ currentTarget: currentJumpButton }));
      expect(handlersB.onJump).toHaveBeenCalledOnce();
      expect(handlersB.onJump).toHaveBeenCalledWith(remoteB);

      popoverB = openPresence();
      const currentFollowButton = within(popoverB).getByTestId("presence-follow");
      const currentFollow = captureClick(currentFollowButton);
      act(() => currentFollow({ currentTarget: currentFollowButton }));
      expect(sessionB.follow).toHaveBeenCalledOnce();
      expect(sessionB.follow).toHaveBeenCalledWith(sharedUserId);

      popoverB = openPresence();
      const currentKeepAgentButton = within(popoverB).getByTestId("keep-agent-here");
      act(() => currentKeepAgentButton.click());
      expect(handlersB.onKeepAgent).toHaveBeenCalledOnce();

      popoverB = openPresence();
      const currentCancelButton = within(popoverB).getByTestId("presence-request-cancel");
      act(() => currentCancelButton.click());
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
      const oldCancelButton = within(popoverA).getByTestId("presence-request-cancel");
      const oldJumpButton = within(popoverA).getByTestId("presence-jump");
      const oldFollowButton = within(popoverA).getByTestId("presence-follow");
      const oldKeepAgentButton = within(popoverA).getByTestId("keep-agent-here");
      const oldCancel = captureClick(oldCancelButton);
      const oldJump = captureClick(oldJumpButton);
      const oldFollow = captureClick(oldFollowButton);
      const oldKeepAgent = captureClick(oldKeepAgentButton);
      const oldInterval = timerCallbacks(setIntervalSpy.mock.calls, 15_000).at(-1);
      if (!oldInterval) throw new Error("The removed freshness interval was not captured");
      act(() => oldCancelButton.click());
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
              oldCancel({ currentTarget: oldCancelButton });
              oldJump({ currentTarget: oldJumpButton });
              oldFollow({ currentTarget: oldFollowButton });
              oldKeepAgent({ currentTarget: oldKeepAgentButton });
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
      const currentCancelButton = within(popoverB).getByTestId("presence-request-cancel");
      const currentCancel = captureClick(currentCancelButton);

      act(() => currentCancelButton.click());
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

      const reappearedCancelButton = screen.getByTestId("presence-request-cancel");
      const reappearedCancel = captureClick(reappearedCancelButton);
      act(() => {
        currentCancel({ currentTarget: currentCancelButton });
        currentCancel({ currentTarget: reappearedCancelButton });
        reappearedCancel({ currentTarget: currentCancelButton });
        reappearedCancelButton.click();
      });
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
