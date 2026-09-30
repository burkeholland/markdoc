// @vitest-environment jsdom
import {
  StrictMode,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import type { AgentRequestMirror } from "./agent-requests";
import { TooltipProvider } from "@/components/ui/primitives";
import { PresenceStack, type PresenceStackProps } from "./header";
import { PresenceRequests } from "./presence-agents";

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
  readonly docId: string;
  readonly user: { id: string; name: string; login: string; color: string; colorLight: string };
  readonly role: "owner" | "editor";
  private users: PresenceUser[];
  private requests: AgentRequestMirror[];
  private activity: { name: string; action: string; at: number } | null;
  private listeners = new Set<() => void>();
  followUserId: string | null = null;

  constructor({
    docId = "presence-document",
    localId,
    localName,
    users,
    requests = [],
    activity = null,
    role = "owner",
  }: {
    docId?: string;
    localId: string;
    localName: string;
    users: PresenceUser[];
    requests?: AgentRequestMirror[];
    activity?: { name: string; action: string; at: number } | null;
    role?: "owner" | "editor";
  }) {
    this.docId = docId;
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

  setUsers(users: PresenceUser[]) {
    this.users = users;
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
  onConnectAgent: NonNullable<PresenceStackProps["onConnectAgent"]>;
}

function callbacks(): PresenceCallbacks {
  return {
    onJump: vi.fn(),
    onCancelRequest: vi.fn(),
    onConnectAgent: vi.fn(),
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
          onConnectAgent={handlers.onConnectAgent}
        />
      ) : null}
    </TooltipProvider>
  );
}

interface PresenceLeafCallbacks {
  onCancel: (requestId: string) => void;
}

interface PresenceLeafProps {
  session: PresenceSession;
  pending: AgentRequestMirror[];
  callbacks: PresenceLeafCallbacks;
  nameOf: (userId: string) => string | null;
  ownerNameOf?: (login: string) => string | null;
}

function PresenceLeafMount({ session, pending, callbacks: handlers, nameOf, ownerNameOf }: PresenceLeafProps) {
  return (
    <div data-testid="presence-leaves">
      <PresenceRequests
        session={session.asCollabSession()}
        pending={pending}
        nameOf={nameOf}
        ownerNameOf={ownerNameOf}
        onCancel={handlers.onCancel}
      />
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
type CapturedKeyDown = (
  event: ReactKeyboardEvent<HTMLElement>,
) => void;

interface CapturedReactProps {
  onClick?: CapturedClick;
  onKeyDown?: CapturedKeyDown;
  onKeyDownCapture?: CapturedKeyDown;
  ref?: (node: HTMLElement | null) => void;
}

function reactPropsEntry(element: HTMLElement): {
  key: string;
  record: Record<string, CapturedReactProps>;
  props: CapturedReactProps;
} {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the presence control");
  const record = element as unknown as Record<string, CapturedReactProps>;
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

// Production builds minify React's SyntheticBaseEvent class name, so a real click there has a one-letter constructor.
const MangledSyntheticEvent = class a {};

function mangledReactEvent(event: unknown): unknown {
  if (typeof event !== "object" || event === null) throw new Error("React did not deliver an event object");
  const prototype = Object.create(Object.getPrototypeOf(event), {
    constructor: { value: MangledSyntheticEvent },
  });
  const mangled = Object.assign(Object.create(prototype) as object, event);
  expect(Object.getPrototypeOf(mangled).constructor.name).toBe("a");
  return mangled;
}

function interceptKeyDown(
  element: HTMLElement,
  property: "onKeyDown" | "onKeyDownCapture",
  invoke: (
    current: CapturedKeyDown,
    event: ReactKeyboardEvent<HTMLElement>,
  ) => void,
): () => void {
  const { key, record, props } = reactPropsEntry(element);
  const current = props[property];
  if (!current) {
    throw new Error(`The presence control did not have ${property}`);
  }
  const intercepted = {
    ...props,
    [property]: (event: ReactKeyboardEvent<HTMLElement>) =>
      invoke(current, event),
  };
  record[key] = intercepted;
  return () => {
    if (record[key] === intercepted) record[key] = props;
  };
}

function installKeyDownCapture(
  element: HTMLElement,
  handler: CapturedKeyDown,
): () => void {
  const { key, record, props } = reactPropsEntry(element);
  const intercepted = {
    ...props,
    onKeyDownCapture: handler,
  };
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
  if (!(section instanceof HTMLDivElement) || !(list instanceof HTMLUListElement)) {
    throw new Error("The request section and list were not rendered");
  }
  if (!rows.every((row) => row instanceof HTMLLIElement) || !cancels.every((cancel) => cancel instanceof HTMLButtonElement)) {
    throw new Error("The request rows and actions were not rendered");
  }
  return {
    section,
    list,
    rows: rows as HTMLLIElement[],
    cancels: cancels as HTMLButtonElement[],
  };
}

function connectedButton(label = "Other action") {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  document.body.append(button);
  return button;
}

function markPresenceEventTrusted(event: Event) {
  const implementation = Object.getOwnPropertySymbols(event)
    .map(
      (symbol) =>
        (event as unknown as Record<symbol, unknown>)[symbol],
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
    throw new Error("Unable to set jsdom's internal event trust slot");
  }
  Object.defineProperty(implementation, "isTrusted", {
    configurable: true,
    enumerable: true,
    get: () => true,
    set: () => undefined,
  });
  if (!event.isTrusted) {
    throw new Error("The jsdom event trust slot did not update");
  }
}

function presenceKeyDown(
  target: HTMLElement,
  init: KeyboardEventInit,
  trusted = true,
) {
  const ownerWindow = target.ownerDocument.defaultView;
  if (!ownerWindow) throw new Error("The keyboard target has no Window");
  const event = new ownerWindow.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (trusted) markPresenceEventTrusted(event);
  fireEvent(target, event);
  return event;
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
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("PresenceStack", () => {
  const unbrokenSection = "Location".repeat(40);
  const ordinarySection = "Editorial planning and collaborative document review ".repeat(6);
  const literalSection = '  <img src="section" onerror="alert(1)"> & "quoted" \'section\' ‘literal’  '.repeat(4);
  const whitespaceSection = " \t\n ".repeat(60);

  function expectLocations(popover: HTMLElement, expected: (string | undefined)[]) {
    const sections = within(popover).getAllByTestId("presence-section");
    expect(sections).toHaveLength(expected.length);
    return sections.map((section, index) => {
      expect(section.tagName).toBe("DIV");
      expect(section.className).toBe("truncate text-xs text-ink-3");
      expect(section.getAttribute("title")).toBe(expected[index] ?? null);
      expect(section.getAttributeNames().sort()).toEqual(
        expected[index] === undefined ? ["class", "data-testid"] : ["class", "data-testid", "title"],
      );
      expect(section.parentElement?.className).toBe("min-w-0 flex-1");
      expect(section.parentElement?.children).toHaveLength(2);
      expect(section.closest("[data-testid='presence-row']")?.tagName).toBe("LI");
      if (expected[index] !== undefined) {
        expect(section.textContent).toBe(expected[index]);
        expect(section.getAttribute("title")).toBe(section.textContent);
        expect(section.children).toHaveLength(0);
        expect(section.childNodes).toHaveLength(1);
        expect(section.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      }
      return section;
    });
  }

  describe("display-name titles", () => {
    const localName = "  Alexandra Local Collaborator with a complete display identity for the collaborative document review across editorial planning accessibility research technical writing release coordination customer education and documentation maintenance teams  ";
    const remoteName = "  Benjamin Remote Collaborator with a different complete display identity for the shared document review across product engineering content strategy international support quality assurance implementation planning and long term knowledge management teams  ";
    const agentName = "Document Review Assistant for editorial planning accessibility research technical writing release coordination customer education documentation maintenance product engineering content strategy international support and long term knowledge management";

    function expectNames(popover: HTMLElement, expected: string[]) {
      const rows = within(popover).getAllByTestId("presence-row");
      expect(rows).toHaveLength(expected.length);
      return rows.map((row, index) => {
        const spans = row.querySelectorAll("span.truncate");
        expect(spans).toHaveLength(1);
        const span = spans[0];
        expect(span.tagName).toBe("SPAN");
        expect(span.className).toBe("truncate");
        expect(span.getAttribute("title")).toBe(expected[index]);
        expect(span.textContent).toBe(expected[index]);
        expect(span.children).toHaveLength(0);
        expect(span.childNodes).toHaveLength(expected[index] === "" ? 0 : 1);
        expect(span.getAttributeNames().sort()).toEqual(["class", "title"]);
        expect(span.parentElement?.className).toBe("flex items-center gap-1.5 text-sm font-medium text-ink");
        expect(span.parentElement?.parentElement).toBe(row.children[1]);
        expect(row.children[1].className).toBe("min-w-0 flex-1");
        expect(row.children[1].children).toHaveLength(2);
        expect(Array.from(row.querySelectorAll("button, a[href], input, select, textarea, [tabindex], [contenteditable]"))).toEqual(
          within(row).queryAllByRole("button"),
        );
        return span;
      });
    }

    it.each(["Jump", "Follow"] as const)(
      "keeps long displayed identities and hover passive before one explicit %s",
      (action) => {
        vi.useFakeTimers();
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
        for (const name of [localName, remoteName, agentName]) expect(name.length).toBeGreaterThanOrEqual(200);
        expect(new Set([localName, remoteName, agentName]).size).toBe(3);
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected presence fetch"));
        const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(() => { throw new Error("Unexpected presence XHR"); });
        const socketSpy = vi.spyOn(globalThis, "WebSocket").mockImplementation(function () { throw new Error("Unexpected presence WebSocket"); });
        const local = person("local", localName, { isLocal: true, role: "owner", idleSince: Date.now() - 120_000, section: ordinarySection });
        const remote = person("remote", remoteName, { idleSince: Date.now() - 120_000, section: unbrokenSection });
        const working = person("working-agent", agentName, {
          isAgent: true, role: null, cursor: null, section: null, status: "drafting",
          ownerLogin: "owner", ownerName: "Morgan", idleSince: Date.now() - 120_000,
        });
        const idle = person("idle-agent", "Local assistant", {
          isAgent: true, role: null, cursor: null, status: "ready",
          ownerLogin: local.id, ownerName: "Local owner", idleSince: Date.now() - 120_000,
        });
        const noCursor = person("no-cursor", "Reader", { role: "viewer", cursor: null });
        const users = [local, remote, working, idle, noCursor];
        const session = new PresenceSession({
          localId: local.id, localName: local.name, users,
          requests: [request("current-request", local.id, { status: "claimed", claimedBy: working.name })],
        });
        const presenceSpy = vi.spyOn(session, "presence");
        const subscribeSpy = vi.spyOn(session, "subscribe");
        const metaSpy = vi.spyOn(session.meta, "get");
        const handlers = callbacks();
        render(<PresenceBoundary session={session} callbacks={handlers} />);
        const trigger = screen.getByTestId("presence");
        const triggerLabel = `5 people here: ${localName} (you), ${remoteName}, Morgan's ${agentName} (agent: drafting), Local assistant (agent: ready), Reader`;
        expect(trigger.getAttribute("aria-label")).toBe(triggerLabel);
        expect(within(trigger).getByText("+2")).toBeInTheDocument();
        expect(screen.getAllByTestId("presence-avatar").map((avatar) => avatar.getAttribute("data-user-id"))).toEqual(
          users.slice(0, 3).map((user) => user.id),
        );
        const popover = openPresence();
        const names = expectNames(popover, [`${localName} (you)`, remoteName, `Morgan's ${agentName}`, idle.name, noCursor.name]);
        const rows = within(popover).getAllByTestId("presence-row");
        expect(rows.map((row) => row.getAttribute("data-user-id"))).toEqual(users.map((user) => user.id));
        expect(rows.map((row) => row.children.length)).toEqual([2, 3, 2, 2, 3]);
        expect(rows.map((row) => within(row).queryAllByRole("button").map((button) => button.textContent))).toEqual([
          [], ["Jump", "Follow"], [], [], ["Jump", "Follow"],
        ]);
        expect(within(rows[0]).getByText("Owner")).toBeInTheDocument();
        expect(within(rows[1]).getByText("Editor")).toBeInTheDocument();
        expect(within(rows[4]).getByText("Viewer")).toBeInTheDocument();
        expect(rows.map((row) => row.hasAttribute("data-agent"))).toEqual([false, false, true, true, false]);
        expect(within(rows[2]).getByText("Agent")).toBeInTheDocument();
        expect(within(rows[3]).getByText("Agent")).toBeInTheDocument();
        expect(rows.map((row) => row.classList.contains("opacity-60"))).toEqual([false, true, false, true, false]);
        expect(within(rows[2]).getByTestId("presence-avatar-busy")).toHaveAccessibleName(`Morgan's ${agentName} is working`);
        expect(within(rows[3]).queryByTestId("presence-avatar-busy")).toBeNull();
        expect(within(rows[2]).getByRole("img", { name: `${agentName} (agent)` })).toBeInTheDocument();
        expect(rows[0].querySelector(".avatar")?.getAttribute("title")).toBe(localName);
        expect(rows[1].querySelector(".avatar")?.getAttribute("title")).toBe(remoteName);
        expect(within(popover).getByText("5 people here")).toBeInTheDocument();
        const locations = expectLocations(popover, [
          `in ‘${ordinarySection}’`, `Idle · in ‘${unbrokenSection}’`, undefined, undefined, "no cursor",
        ]);
        expect(locations.map((section) => section.textContent)).toEqual([
          `in ‘${ordinarySection}’`, `Idle · in ‘${unbrokenSection}’`, "drafting", "Idle", "no cursor",
        ]);
        expect(within(rows[4]).getByTestId("presence-jump")).toBeDisabled();
        expect(within(rows[1]).getByTestId("presence-follow")).toHaveAttribute("aria-pressed", "false");
        expect(within(popover).getByTestId("presence-request-cancel")).toBeInTheDocument();
        expect(within(popover).queryByTestId("connect-agent")).toBeNull();
        act(() => vi.advanceTimersByTime(0));
        const passiveCounts = () => [
          setTimeoutSpy.mock.calls.length, setIntervalSpy.mock.calls.length,
          clearTimeoutSpy.mock.calls.length, clearIntervalSpy.mock.calls.length,
          presenceSpy.mock.calls.length, subscribeSpy.mock.calls.length, metaSpy.mock.calls.length,
          vi.getTimerCount(),
        ];
        const sessionUsers = session.presence();
        const countsBeforeHover = passiveCounts();
        const markup = popover.innerHTML;
        const focusOwner = document.activeElement;
        for (const name of [...names, ...locations]) {
          fireEvent.pointerEnter(name);
          fireEvent.mouseEnter(name);
          fireEvent.pointerMove(name);
          fireEvent.mouseMove(name);
          fireEvent.mouseLeave(name);
          fireEvent.pointerLeave(name);
        }
        expect(popover.innerHTML).toBe(markup);
        expect(document.activeElement).toBe(focusOwner);
        expect(passiveCounts()).toEqual(countsBeforeHover);
        expect(session.presence()).toBe(sessionUsers);
        expect(session.followUserId).toBeNull();
        expect(trigger.getAttribute("aria-label")).toBe(triggerLabel);
        expect(handlers.onJump).not.toHaveBeenCalled();
        expect(session.follow).not.toHaveBeenCalled();
        expect(handlers.onCancelRequest).not.toHaveBeenCalled();
        expect(handlers.onConnectAgent).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(xhrSpy).not.toHaveBeenCalled();
        expect(socketSpy).not.toHaveBeenCalled();

        fireEvent.click(within(rows[1]).getByRole("button", { name: action }));
        if (action === "Jump") {
          expect(handlers.onJump).toHaveBeenCalledExactlyOnceWith(remote);
          expect(session.follow).not.toHaveBeenCalled();
        } else {
          expect(session.follow).toHaveBeenCalledExactlyOnceWith(remote.id);
          expect(handlers.onJump).not.toHaveBeenCalled();
        }
        expect(handlers.onCancelRequest).not.toHaveBeenCalled();
        expect(handlers.onConnectAgent).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(xhrSpy).not.toHaveBeenCalled();
        expect(socketSpy).not.toHaveBeenCalled();
        expect(screen.queryByTestId("presence-popover")).toBeNull();
      },
    );

    it("refreshes same-ID names and agent display ownership, removes departed titles, and replaces the document session", () => {
      const local = person("local", localName, { isLocal: true });
      const remote = person("remote", remoteName);
      const agent = person("agent", agentName, { isAgent: true, role: null, ownerLogin: "owner", ownerName: "Morgan" });
      const session = new PresenceSession({ docId: "document-a", localId: local.id, localName: local.name, users: [local, remote, agent] });
      const handlers = callbacks();
      const view = render(<PresenceBoundary session={session} callbacks={handlers} />);
      let popover = openPresence();
      const originalNames = expectNames(popover, [`${localName} (you)`, remoteName, `Morgan's ${agentName}`]);
      const oldTitles = Array.from(document.querySelectorAll("[title]"), (element) => element.getAttribute("title"));
      const updatedLocal = { ...local, name: remoteName };
      const updatedRemote = { ...remote, name: "  Updated remote  " };
      const updatedAgent = { ...agent, ownerName: "Taylor" };
      act(() => session.setUsers([updatedLocal, updatedRemote, updatedAgent]));
      const updatedNames = expectNames(popover, [`${remoteName} (you)`, updatedRemote.name, `Taylor's ${agentName}`]);
      updatedNames.forEach((name, index) => expect(name).toBe(originalNames[index]));
      expect(updatedNames[2].getAttribute("title")).not.toBe(agent.name);

      act(() => session.setUsers([updatedLocal, updatedRemote, { ...updatedAgent, ownerLogin: local.id }]));
      expectNames(popover, [`${remoteName} (you)`, updatedRemote.name, agentName]);
      act(() => session.setUsers([updatedLocal, updatedRemote]));
      expectNames(popover, [`${remoteName} (you)`, updatedRemote.name]);
      expect(originalNames[2]).not.toBeInTheDocument();
      expect(within(popover).getByTestId("connect-agent")).toBeInTheDocument();
      const remainingTitles = Array.from(document.querySelectorAll("[title]"), (element) => element.getAttribute("title"));
      expect(remainingTitles).not.toContain(agentName);
      expect(remainingTitles).not.toContain(`Morgan's ${agentName}`);
      expect(remainingTitles).not.toContain(`Taylor's ${agentName}`);

      const replacementLocal = { ...local, name: "Current local", section: "Current local section" };
      const replacementRemote = { ...remote, name: "Current remote", section: "Current remote section" };
      const replacementAgent = { ...agent, name: "Current assistant", ownerName: "Current owner" };
      const replacement = new PresenceSession({
        docId: "document-b", localId: replacementLocal.id, localName: replacementLocal.name,
        users: [replacementLocal, replacementRemote, replacementAgent],
      });
      view.rerender(<PresenceBoundary session={replacement} callbacks={handlers} />);
      expect(replacement.docId).not.toBe(session.docId);
      expect(screen.queryByTestId("presence-popover")).toBeNull();
      originalNames.forEach((name) => expect(name).not.toBeInTheDocument());
      popover = openPresence();
      expectNames(popover, ["Current local (you)", "Current remote", "Current owner's Current assistant"]);
      act(() => session.setUsers([local, remote, agent]));
      expectNames(popover, ["Current local (you)", "Current remote", "Current owner's Current assistant"]);
      const currentTitles = Array.from(document.querySelectorAll("[title]"), (element) => element.getAttribute("title"));
      for (const title of [...oldTitles, ...remainingTitles]) expect(currentTitles).not.toContain(title);
      expect(session.follow).not.toHaveBeenCalled();
      expect(replacement.follow).not.toHaveBeenCalled();
      expect(handlers.onJump).not.toHaveBeenCalled();
      expect(handlers.onCancelRequest).not.toHaveBeenCalled();
      expect(handlers.onConnectAgent).not.toHaveBeenCalled();
      fireEvent.click(within(popover).getByTestId("presence-jump"));
      expect(handlers.onJump).toHaveBeenCalledExactlyOnceWith(replacementRemote);
    });

    it("preserves empty and whitespace-only displayed names without a fallback", () => {
      const local = person("local", "", { isLocal: true });
      const remote = person("remote", "  ");
      const agent = person("agent", "", { isAgent: true, ownerLogin: local.id, ownerName: "Unused owner" });
      const session = new PresenceSession({ localId: local.id, localName: local.name, users: [local, remote, agent] });
      render(<PresenceBoundary session={session} callbacks={callbacks()} />);
      expectNames(openPresence(), [" (you)", "  ", ""]);
    });
  });

  describe("human-location titles", () => {
    describe.each([
      { label: "local active", isLocal: true, idle: false },
      { label: "local with an old activity timestamp", isLocal: true, idle: true },
      { label: "remote active", isLocal: false, idle: false },
      { label: "remote idle", isLocal: false, idle: true },
    ])("$label", ({ isLocal, idle }) => {
      describe.each([10, null])("cursor %s", (cursor) => {
        it.each([
          { label: "unbroken", section: unbrokenSection, location: `in ‘${unbrokenSection}’` },
          { label: "ordinary", section: ordinarySection, location: `in ‘${ordinarySection}’` },
          { label: "literal markup and quotes", section: literalSection, location: `in ‘${literalSection}’` },
          { label: "whitespace-only", section: whitespaceSection, location: `in ‘${whitespaceSection}’` },
          { label: "empty", section: "", location: "at the top" },
          { label: "null", section: null, location: "at the top" },
        ])("preserves the exact $label section copy", ({ section, location }) => {
          if (section) expect(section.length).toBeGreaterThanOrEqual(240);
          const user = person("human", "Human collaborator", {
            isLocal, cursor, section, idleSince: idle ? Date.now() - 120_000 : null,
          });
          const local = person("local", "Local collaborator", { isLocal: true, section: null });
          const session = new PresenceSession({
            localId: isLocal ? user.id : local.id,
            localName: isLocal ? user.name : local.name,
            users: isLocal ? [user] : [local, user],
          });
          render(<PresenceBoundary session={session} callbacks={callbacks()} />);
          const popover = openPresence();
          const expected = `${!isLocal && idle ? "Idle · " : ""}${cursor === null ? "no cursor" : location}`;
          expectLocations(popover, isLocal ? [expected] : ["at the top", expected]);
          const row = within(popover).getAllByTestId("presence-row").at(-1)!;
          expect(row.classList.contains("opacity-60")).toBe(!isLocal && idle);
          expect(within(row).getByText("Editor")).toBeInTheDocument();
          expect(within(row).queryAllByRole("button")).toHaveLength(isLocal ? 0 : 2);
          if (!isLocal) expect(within(row).getByTestId("presence-jump").hasAttribute("disabled")).toBe(cursor === null);
        });
      });
    });

    it.each(["Jump", "Follow"] as const)(
      "updates same-ID locations and idle state, retires departed/session labels, and keeps current %s",
      (action) => {
        const local = person("local", "Local", { isLocal: true, section: ordinarySection });
        const remote = person("remote", "Remote", { section: unbrokenSection });
        const departing = person("departing", "Departing", { section: literalSection });
        const session = new PresenceSession({ docId: "locations-a", localId: local.id, localName: local.name, users: [local, remote, departing] });
        const handlers = callbacks();
        const view = render(<StrictMode><PresenceBoundary session={session} callbacks={handlers} /></StrictMode>);
        let popover = openPresence();
        const original = expectLocations(popover, [`in ‘${ordinarySection}’`, `in ‘${unbrokenSection}’`, `in ‘${literalSection}’`]);
        const updatedLocal = { ...local, section: whitespaceSection, idleSince: Date.now() - 120_000 };
        const updatedRemote = { ...remote, section: literalSection, cursor: 84, idleSince: Date.now() - 120_000 };
        act(() => session.setUsers([updatedLocal, updatedRemote, departing]));
        const updated = expectLocations(popover, [`in ‘${whitespaceSection}’`, `Idle · in ‘${literalSection}’`, `in ‘${literalSection}’`]);
        updated.forEach((section, index) => expect(section).toBe(original[index]));
        act(() => session.setUsers([updatedLocal, { ...updatedRemote, cursor: null }]));
        expectLocations(popover, [`in ‘${whitespaceSection}’`, "Idle · no cursor"]);
        expect(original[2]).not.toBeInTheDocument();
        expect(within(popover).getByTestId("presence-jump")).toBeDisabled();
        act(() => session.setUsers([updatedLocal, { ...updatedRemote, section: "", idleSince: null }]));
        expectLocations(popover, [`in ‘${whitespaceSection}’`, "at the top"]);
        act(() => session.setUsers([updatedLocal, updatedRemote]));
        expectLocations(popover, [`in ‘${whitespaceSection}’`, `Idle · in ‘${literalSection}’`]);
        fireEvent.click(within(popover).getByRole("button", { name: action }));
        if (action === "Jump") {
          expect(handlers.onJump).toHaveBeenCalledExactlyOnceWith(updatedRemote);
          expect(session.follow).not.toHaveBeenCalled();
        } else {
          expect(session.follow).toHaveBeenCalledExactlyOnceWith(updatedRemote.id);
          expect(session.followUserId).toBe(updatedRemote.id);
          expect(handlers.onJump).not.toHaveBeenCalled();
        }
        expect(screen.queryByTestId("presence-popover")).toBeNull();
        popover = openPresence();
        if (action === "Follow") expect(within(popover).getByRole("button", { name: "Following" })).toHaveAttribute("aria-pressed", "true");
        const retired = expectLocations(popover, [`in ‘${whitespaceSection}’`, `Idle · in ‘${literalSection}’`]);
        const replacementLocal = { ...local, name: "Current local", section: null };
        const replacementRemote = { ...remote, name: "Current remote", section: "Current section", cursor: 123 };
        const replacement = new PresenceSession({
          docId: "locations-b", localId: local.id, localName: replacementLocal.name,
          users: [replacementLocal, replacementRemote],
        });
        view.rerender(<StrictMode><PresenceBoundary session={replacement} callbacks={handlers} /></StrictMode>);
        expect(screen.queryByTestId("presence-popover")).toBeNull();
        retired.forEach((section) => expect(section).not.toBeInTheDocument());
        popover = openPresence();
        expectLocations(popover, ["at the top", "in ‘Current section’"]);
        act(() => session.setUsers([local, remote, departing]));
        expectLocations(popover, ["at the top", "in ‘Current section’"]);
        const currentTitles = Array.from(document.querySelectorAll("[title]"), (element) => element.getAttribute("title"));
        for (const section of [ordinarySection, unbrokenSection, literalSection, whitespaceSection]) {
          expect(currentTitles).not.toContain(`in ‘${section}’`);
          expect(currentTitles).not.toContain(`Idle · in ‘${section}’`);
        }
        fireEvent.click(within(popover).getByRole("button", { name: action }));
        if (action === "Jump") {
          expect(handlers.onJump).toHaveBeenCalledTimes(2);
          expect(handlers.onJump).toHaveBeenLastCalledWith(replacementRemote);
          expect(replacement.follow).not.toHaveBeenCalled();
        } else {
          expect(replacement.follow).toHaveBeenCalledExactlyOnceWith(replacementRemote.id);
          expect(replacement.followUserId).toBe(replacementRemote.id);
          expect(handlers.onJump).not.toHaveBeenCalled();
        }
        expect(screen.queryByTestId("presence-popover")).toBeNull();
        expect(handlers.onCancelRequest).not.toHaveBeenCalled();
        expect(handlers.onConnectAgent).not.toHaveBeenCalled();
      },
    );

    it("updates titles on the existing idle tick without adding a timer", () => {
      vi.useFakeTimers();
      const intervalSpy = vi.spyOn(globalThis, "setInterval");
      const local = person("local", "Local", { isLocal: true, section: ordinarySection, idleSince: Date.now() - 50_000 });
      const remote = person("remote", "Remote", { section: unbrokenSection, idleSince: Date.now() - 50_000 });
      const session = new PresenceSession({ localId: local.id, localName: local.name, users: [local, remote] });
      render(<PresenceBoundary session={session} callbacks={callbacks()} />);
      const popover = openPresence();
      const sections = expectLocations(popover, [`in ‘${ordinarySection}’`, `in ‘${unbrokenSection}’`]);
      act(() => vi.advanceTimersByTime(0));
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(intervalSpy.mock.calls[0][1]).toBe(15_000);
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(15_000));
      const updated = expectLocations(popover, [`in ‘${ordinarySection}’`, `Idle · in ‘${unbrokenSection}’`]);
      updated.forEach((section, index) => expect(section).toBe(sections[index]));
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("never titles agent locations from long raw metadata while activity ages and idle status hides it", () => {
      vi.useFakeTimers();
      const local = person("local", "Local", { isLocal: true });
      const agent = person("agent", unbrokenSection, {
        isAgent: true, role: null, ownerLogin: "owner", ownerName: "Morgan",
        section: literalSection, status: ordinarySection, idleSince: Date.now() - 120_000,
      });
      const ownAgent = person("own-agent", literalSection, {
        isAgent: true, isLocal: true, role: null, ownerLogin: local.id,
        section: ordinarySection, cursor: null, status: null,
      });
      const session = new PresenceSession({
        localId: local.id, localName: local.name, users: [local, agent, ownAgent],
        activity: { name: agent.name, action: literalSection, at: Date.now() - 10_000 },
      });
      render(<PresenceBoundary session={session} callbacks={callbacks()} />);
      const popover = openPresence();
      const sections = expectLocations(popover, ["in ‘Overview’", undefined, undefined]);
      expect(sections[1].textContent).toBe(`${ordinarySection} · edited · 10 s ago`);
      expect(sections[1].children).toHaveLength(2);
      expect(within(sections[1]).getByTestId("presence-activity").textContent).toBe("edited · 10 s ago");
      expect(sections[2].textContent).toBe("working");
      const rows = within(popover).getAllByTestId("presence-row");
      expect(rows[1].querySelector("span.truncate")?.getAttribute("title")).toBe(`Morgan's ${agent.name}`);
      expect(rows[2].querySelector("span.truncate")?.getAttribute("title")).toBe(`${ownAgent.name} (you)`);
      expect(within(rows[1]).getByTestId("presence-avatar-busy")).toHaveAccessibleName(`Morgan's ${agent.name} is working`);
      expect(within(rows[1]).getByText("Agent")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(5_000));
      expectLocations(popover, ["in ‘Overview’", undefined, undefined]);
      expect(within(sections[1]).getByTestId("presence-activity").textContent).toBe("edited · 15 s ago");
      act(() => vi.advanceTimersByTime(35_000));
      expectLocations(popover, ["in ‘Overview’", undefined, undefined]);
      expect(sections[1].textContent).toBe("Idle");
      expect(sections[1].children).toHaveLength(1);
      expect(within(sections[1]).queryByTestId("presence-activity")).toBeNull();
      expect(within(rows[1]).queryByTestId("presence-avatar-busy")).toBeNull();
      expect(rows[1]).toHaveClass("opacity-60");
      expect(sections[1].querySelector("[title]")).toBeNull();
      expect(sections[2].querySelector("[title]")).toBeNull();
    });
  });

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
          onConnectAgent={handlers.onConnectAgent}
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
    expectLocations(popover, ["in ‘Overview’", "in ‘Plan’", undefined, "no cursor", "Idle · in ‘Overview’"]);
    expect(within(popover).getByTestId("presence-requests")).toBeInTheDocument();
    expect(within(popover).getByText("Tighten the introduction")).toBeInTheDocument();
    expect(within(popover).getByText("Check the facts")).toBeInTheDocument();
    expect(within(popover).getByText(/Burke's Copilot CLI is on it · tracked changes · asked by you/)).toBeInTheDocument();
    expect(within(popover).getByText(/Waiting for an agent · comments · asked by Bob/)).toBeInTheDocument();
    expect(within(popover).getAllByTestId("presence-request-cancel")).toHaveLength(1);
    expect(within(popover).queryByTestId("connect-agent")).toBeNull();
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

  it("navigates current Cancel controls by semantic key in committed request order without activating work", () => {
    const local = person("keyboard-local", "Keyboard local", {
      isLocal: true,
      role: "editor",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "editor",
    });
    const pending = [
      request("keyboard-a", local.id),
      request("keyboard-foreign-a", "foreign-a"),
      request("keyboard-b", local.id),
      request("keyboard-foreign-b", "foreign-b"),
      request("keyboard-c", local.id),
    ];
    const onCancel = vi.fn<(requestId: string) => void>();
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("The test document has no Window");
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const scrollTo = vi
      .spyOn(ownerWindow, "scrollTo")
      .mockImplementation(() => undefined);
    const scrollBy = vi
      .spyOn(ownerWindow, "scrollBy")
      .mockImplementation(() => undefined);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const keys = [
      { key: "ArrowLeft", code: "Numpad4", move: -1 },
      { key: "ArrowUp", code: "Numpad8", move: -1 },
      { key: "ArrowRight", code: "Numpad6", move: 1 },
      { key: "ArrowDown", code: "Numpad2", move: 1 },
      { key: "Home", code: "Numpad7", move: "first" },
      { key: "End", code: "Numpad1", move: "last" },
    ] as const;

    try {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={pending}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      const section = within(host).getByTestId("presence-requests");
      const list = section.children.item(1);
      const rows = within(host).getAllByTestId("presence-request");
      const cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      if (!(list instanceof HTMLUListElement)) {
        throw new Error("The request list was not rendered");
      }
      expect(rows).toHaveLength(5);
      expect(cancels).toHaveLength(3);
      expect(rows[1]).not.toContainElement(cancels[1]!);
      expect(rows[3]).not.toContainElement(cancels[2]!);
      const markup = host.innerHTML;
      const listScroll = list.scrollTop;
      const pageScroll = ownerWindow.scrollY;
      setTimeoutSpy.mockClear();

      for (const sourceIndex of [0, 1, 2] as const) {
        for (const { key, code, move } of keys) {
          const source = cancels[sourceIndex]!;
          const destinationIndex =
            move === "first"
              ? 0
              : move === "last"
                ? 2
                : sourceIndex + move;
          const accepts =
            destinationIndex >= 0 &&
            destinationIndex < cancels.length &&
            destinationIndex !== sourceIndex;
          source.focus();
          preventDefault.mockClear();
          focus.mockClear();
          scrollTo.mockClear();
          scrollBy.mockClear();

          const event = presenceKeyDown(source, {
            key,
            code,
            location: 3,
          });

          expect(event.defaultPrevented, `${sourceIndex}:${key}`).toBe(
            accepts,
          );
          if (accepts) {
            expect(
              cancels[destinationIndex],
              `${sourceIndex}:${key}`,
            ).toHaveFocus();
            expect(
              preventDefault,
              `${sourceIndex}:${key}`,
            ).toHaveBeenCalledOnce();
            expect(
              focus,
              `${sourceIndex}:${key}`,
            ).toHaveBeenCalledExactlyOnceWith({
              preventScroll: true,
            });
          } else {
            expect(source, `${sourceIndex}:${key}`).toHaveFocus();
            expect(
              preventDefault,
              `${sourceIndex}:${key}`,
            ).not.toHaveBeenCalled();
            expect(focus, `${sourceIndex}:${key}`).not.toHaveBeenCalled();
          }
          expect(onCancel, `${sourceIndex}:${key}`).not.toHaveBeenCalled();
          expect(session.follow, `${sourceIndex}:${key}`).not.toHaveBeenCalled();
          expect(
            timerCallbacks(setTimeoutSpy.mock.calls, CANCEL_GRACE_MS),
            `${sourceIndex}:${key}`,
          ).toHaveLength(0);
          expect(scrollTo, `${sourceIndex}:${key}`).not.toHaveBeenCalled();
          expect(scrollBy, `${sourceIndex}:${key}`).not.toHaveBeenCalled();
          expect(list.scrollTop, `${sourceIndex}:${key}`).toBe(listScroll);
          expect(ownerWindow.scrollY, `${sourceIndex}:${key}`).toBe(
            pageScroll,
          );
          expect(host.innerHTML, `${sourceIndex}:${key}`).toBe(markup);
        }
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("rejects a disabled Cancel destination and leaves a single current Cancel inert", () => {
    const local = person("disabled-local", "Disabled local", {
      isLocal: true,
      role: "owner",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "owner",
    });
    const onCancel = vi.fn<(requestId: string) => void>();
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("The test document has no Window");
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={[
                request("disabled-a", local.id),
                request("disabled-b", local.id),
                request("disabled-c", local.id),
              ]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      let cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      cancels[1]!.disabled = true;
      expect(cancels[1]).toBeDisabled();
      cancels[0]!.focus();
      preventDefault.mockClear();
      focus.mockClear();
      expect(
        presenceKeyDown(cancels[0]!, {
          key: "ArrowRight",
          code: "KeyK",
          location: 2,
        }).defaultPrevented,
      ).toBe(false);
      expect(cancels[0]).toHaveFocus();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();

      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={[request("single-cancel", local.id)]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      cancels = [
        within(host).getByTestId(
          "presence-request-cancel",
        ) as HTMLButtonElement,
      ];
      for (const key of [
        "ArrowLeft",
        "ArrowUp",
        "ArrowRight",
        "ArrowDown",
        "Home",
        "End",
      ]) {
        cancels[0]!.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const event = presenceKeyDown(cancels[0]!, {
          key,
          code: `Unrestricted${key}`,
          location: 1,
        });
        expect(event.defaultPrevented, key).toBe(false);
        expect(preventDefault, key).not.toHaveBeenCalled();
        expect(focus, key).not.toHaveBeenCalled();
        expect(cancels[0], key).toHaveFocus();
      }
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("authenticates independent list and Cancel wrappers around the exact owner Window delivery", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = frame.contentDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) {
      frame.remove();
      throw new Error("The keyboard frame has no owner realm");
    }
    const host = ownerDocument.createElement("div");
    ownerDocument.body.append(host);
    const local = person("realm-local", "Realm local", {
      isLocal: true,
      role: "owner",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "owner",
    });
    const onCancel = vi.fn<(requestId: string) => void>();
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const currentTargetDescriptor = Object.getOwnPropertyDescriptor(
      ownerWindow.Event.prototype,
      "currentTarget",
    );
    const nativePath = ownerWindow.Event.prototype.composedPath;
    if (typeof currentTargetDescriptor?.get !== "function") {
      throw new Error("Event.currentTarget has no intrinsic getter");
    }
    const windowDeliveries: Array<{
      receiver: EventTarget;
      currentTarget: EventTarget | null;
      terminal: EventTarget | undefined;
    }> = [];
    ownerWindow.addEventListener(
      "keydown",
      function (this: EventTarget, event: Event) {
        windowDeliveries.push({
          receiver: this,
          currentTarget: Reflect.apply(
            currentTargetDescriptor.get!,
            event,
            [],
          ) as EventTarget | null,
          terminal: (
            Reflect.apply(nativePath, event, []) as EventTarget[]
          ).at(-1),
        });
      },
      true,
    );
    const implementationSymbol = Object.getOwnPropertySymbols(
      ownerDocument,
    ).find((symbol) => String(symbol) === "Symbol(impl)");
    const backingReceiver = implementationSymbol
      ? (
          ownerDocument as unknown as Record<
            symbol,
            { _globalObject: EventTarget }
          >
        )[implementationSymbol]._globalObject
      : ownerWindow;
    const root = createRoot(host);

    let captureWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
    let bubbleWrapper: ReactKeyboardEvent<HTMLElement> | null = null;
    let capturePrototype: object | null = null;
    let bubblePrototype: object | null = null;
    let capturePrevent: unknown;
    let bubblePrevent: unknown;
    const preventReceivers: object[] = [];
    const preClaimQueries: boolean[] = [];
    let restoreCapture: () => void = () => undefined;
    let restoreBubble: () => void = () => undefined;

    const makeIndependentMethods = (
      event: ReactKeyboardEvent<HTMLElement>,
      trackReceiver: boolean,
      prototype: object | null,
    ) => {
      const originalPrevent = event.preventDefault;
      const originalDefault = event.isDefaultPrevented;
      const originalPropagation = event.isPropagationStopped;
      Object.setPrototypeOf(event, prototype);
      const replacementPrevent = function (
        this: ReactKeyboardEvent<HTMLElement>,
      ) {
        if (trackReceiver) preventReceivers.push(this);
        return Reflect.apply(originalPrevent, this, []);
      };
      const replacementDefault = function (
        this: ReactKeyboardEvent<HTMLElement>,
      ) {
        return Reflect.apply(originalDefault, this, []);
      };
      const replacementPropagation = function (
        this: ReactKeyboardEvent<HTMLElement>,
      ) {
        return Reflect.apply(originalPropagation, this, []);
      };
      Object.defineProperties(event, {
        preventDefault: {
          configurable: true,
          value: replacementPrevent,
        },
        isDefaultPrevented: {
          configurable: true,
          value: replacementDefault,
          writable: true,
        },
        isPropagationStopped: {
          configurable: true,
          value: replacementPropagation,
          writable: true,
        },
        persist: {
          configurable: true,
          value: trackReceiver ? { incompatible: true } : undefined,
          writable: true,
        },
        stopPropagation: {
          configurable: true,
          value: trackReceiver
            ? vi.fn()
            : { incompatible: true },
          writable: true,
        },
      });
      preClaimQueries.push(
        event.isDefaultPrevented(),
        event.isPropagationStopped(),
      );
      return replacementPrevent;
    };

    try {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={[
                request("realm-a", local.id),
                request("realm-b", local.id),
              ]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      const list = within(host).getByRole("list");
      const cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      const source = cancels[0]!;
      const destination = cancels[1]!;
      source.focus();
      const baseline = presenceKeyDown(source, {
        key: "ArrowRight",
        code: "Numpad6",
        location: 3,
        view: ownerWindow,
      });
      expect(baseline.defaultPrevented).toBe(true);
      windowDeliveries.length = 0;
      restoreCapture = interceptKeyDown(
        list,
        "onKeyDownCapture",
        (active, event) => {
          captureWrapper = event;
          capturePrevent = makeIndependentMethods(
            event,
            false,
            Object.create(null),
          );
          capturePrototype = Object.getPrototypeOf(event);
          active(event);
        },
      );
      restoreBubble = interceptKeyDown(
        source,
        "onKeyDown",
        (active, event) => {
          bubbleWrapper = event;
          bubblePrevent = makeIndependentMethods(
            event,
            true,
            Object.freeze({ wrapper: "bubble" }),
          );
          bubblePrototype = Object.getPrototypeOf(event);
          active(event);
        },
      );
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();

      const event = presenceKeyDown(source, {
        key: "ArrowRight",
        code: "Numpad6",
        location: 3,
        view: ownerWindow,
      });

      expect(event.defaultPrevented).toBe(true);
      expect(captureWrapper).not.toBeNull();
      expect(bubbleWrapper).not.toBeNull();
      expect(captureWrapper).not.toBe(bubbleWrapper);
      expect(capturePrototype).not.toBe(bubblePrototype);
      expect(capturePrevent).not.toBe(bubblePrevent);
      expect(captureWrapper!.persist).toBeUndefined();
      expect(typeof bubbleWrapper!.persist).not.toBe("function");
      expect(typeof captureWrapper!.stopPropagation).not.toBe(
        "function",
      );
      expect(bubbleWrapper!.stopPropagation).toEqual(
        expect.any(Function),
      );
      expect(captureWrapper!.nativeEvent).toBe(event);
      expect(bubbleWrapper!.nativeEvent).toBe(event);
      expect(captureWrapper!.eventPhase).toBe(
        ownerWindow.Event.CAPTURING_PHASE,
      );
      expect(bubbleWrapper!.eventPhase).toBe(
        ownerWindow.Event.BUBBLING_PHASE,
      );
      expect(preClaimQueries).toEqual([false, false, false, false]);
      expect(preventReceivers).toEqual([bubbleWrapper]);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(destination).toHaveFocus();
      expect(onCancel).not.toHaveBeenCalled();
      expect(windowDeliveries).toHaveLength(1);
      expect(windowDeliveries[0]!.receiver).toBe(backingReceiver);
      expect(windowDeliveries[0]!.currentTarget).toBe(
        windowDeliveries[0]!.receiver,
      );
      expect(windowDeliveries[0]!.terminal).toBe(
        windowDeliveries[0]!.receiver,
      );

      const foreignFrame = ownerDocument.createElement("iframe");
      ownerDocument.body.append(foreignFrame);
      const foreignWindow = foreignFrame.contentWindow;
      if (!foreignWindow) {
        throw new Error("The structural Window lookalike was absent");
      }
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const rejected = presenceKeyDown(source, {
        key: "ArrowRight",
        code: "Arbitrary",
        view: foreignWindow,
      });
      expect(rejected.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();
      foreignFrame.remove();
    } finally {
      restoreCapture();
      restoreBubble();
      act(() => root.unmount());
      host.remove();
      frame.remove();
    }
  });

  it.each([
    ["persist", "absent"],
    ["persist", "replacement"],
    ["persist", "non-function"],
    ["stopPropagation", "absent"],
    ["stopPropagation", "replacement"],
    ["stopPropagation", "non-function"],
  ] as const)(
    "ignores %s when it is %s on both legitimate React wrappers",
    (property, variant) => {
      const local = person(
        `auxiliary-${property}-${variant}`,
        `Auxiliary ${property} ${variant}`,
        { isLocal: true, role: "owner" },
      );
      const session = new PresenceSession({
        localId: local.id,
        localName: local.name,
        users: [local],
        role: "owner",
      });
      const onCancel = vi.fn<(requestId: string) => void>();
      const ownerWindow = document.defaultView;
      if (!ownerWindow) {
        throw new Error("The test document has no Window");
      }
      const preventDefault = vi.spyOn(
        ownerWindow.Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(
        ownerWindow.HTMLElement.prototype,
        "focus",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let restoreCapture: () => void = () => undefined;
      let restoreBubble: () => void = () => undefined;
      const observed: unknown[] = [];

      const alterAuxiliary = (
        event: ReactKeyboardEvent<HTMLElement>,
      ) => {
        if (variant === "absent") {
          const prevent = event.preventDefault;
          const defaultQuery = event.isDefaultPrevented;
          const propagationQuery = event.isPropagationStopped;
          Object.setPrototypeOf(event, null);
          Object.defineProperties(event, {
            preventDefault: {
              configurable: true,
              value: prevent,
            },
            isDefaultPrevented: {
              configurable: true,
              value: defaultQuery,
              writable: true,
            },
            isPropagationStopped: {
              configurable: true,
              value: propagationQuery,
              writable: true,
            },
          });
          Reflect.deleteProperty(event, property);
          observed.push(property in event);
          return;
        }
        const value =
          variant === "replacement"
            ? vi.fn()
            : Object.freeze({ incompatible: true });
        Object.defineProperty(event, property, {
          configurable: true,
          value,
          writable: true,
        });
        observed.push(event[property]);
      };

      try {
        act(() => {
          root.render(
            <StrictMode>
              <PresenceRequests
                session={session.asCollabSession()}
                pending={[
                  request("auxiliary-a", local.id),
                  request("auxiliary-b", local.id),
                ]}
                nameOf={(id) => id}
                onCancel={onCancel}
              />
            </StrictMode>,
          );
        });
        const list = within(host).getByRole("list");
        const cancels = within(host).getAllByTestId(
          "presence-request-cancel",
        ) as HTMLButtonElement[];
        const source = cancels[0]!;
        const destination = cancels[1]!;
        restoreCapture = interceptKeyDown(
          list,
          "onKeyDownCapture",
          (active, event) => {
            alterAuxiliary(event);
            active(event);
          },
        );
        restoreBubble = interceptKeyDown(
          source,
          "onKeyDown",
          (active, event) => {
            alterAuxiliary(event);
            active(event);
          },
        );
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();

        const event = presenceKeyDown(source, {
          key: "ArrowRight",
          code: `${property}-${variant}`,
        });

        expect(event.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(onCancel).not.toHaveBeenCalled();
        if (variant === "absent") {
          expect(observed).toEqual([false, false]);
        } else if (variant === "replacement") {
          expect(observed).toEqual([
            expect.any(Function),
            expect.any(Function),
          ]);
        } else {
          expect(observed).toEqual([
            { incompatible: true },
            { incompatible: true },
          ]);
        }
      } finally {
        restoreCapture();
        restoreBubble();
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("retains each exact-native pair until its exact button bubble across ineligible delivery and microtask checkpoints", () => {
    const local = person("checkpoint-local", "Checkpoint local", {
      isLocal: true,
      role: "owner",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "owner",
    });
    const onCancel = vi.fn<(requestId: string) => void>();
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("The test document has no Window");
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const checkpoints: number[] = [];
    let checkpointDepth = 1;
    vi.spyOn(ownerWindow, "queueMicrotask").mockImplementation(
      (callback: VoidFunction) => {
        checkpoints.push(checkpoints.length + 1);
        callback();
      },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let restoreCapture: () => void = () => undefined;
    let restoreBubble: () => void = () => undefined;

    try {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={[
                request("checkpoint-a", local.id),
                request("checkpoint-b", local.id),
              ]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      const cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      const source = cancels[0]!;
      const destination = cancels[1]!;
      const ineligibleBubble =
        reactPropsEntry(destination).props.onKeyDown;
      if (!ineligibleBubble) {
        throw new Error("The ineligible Cancel handler was not published");
      }
      restoreCapture = installKeyDownCapture(source, () => {
        const checkpoint = (remaining: number) => {
          if (remaining < 1) return;
          ownerWindow.queueMicrotask(() =>
            checkpoint(remaining - 1),
          );
        };
        checkpoint(checkpointDepth);
      });
      restoreBubble = interceptKeyDown(
        source,
        "onKeyDown",
        (active, event) => {
          ineligibleBubble(event);
          active(event);
        },
      );

      for (const depth of [1, 2]) {
        checkpointDepth = depth;
        checkpoints.length = 0;
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const event = presenceKeyDown(source, {
          key: "ArrowRight",
          code: depth === 1 ? "CheckpointOne" : "CheckpointNested",
        });
        expect(checkpoints).toHaveLength(depth);
        expect(event.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(onCancel).not.toHaveBeenCalled();
      }
    } finally {
      restoreCapture();
      restoreBubble();
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each([
    ["capture", "preventDefault"],
    ["capture", "isDefaultPrevented"],
    ["capture", "isPropagationStopped"],
    ["bubble", "preventDefault"],
    ["bubble", "isDefaultPrevented"],
    ["bubble", "isPropagationStopped"],
  ] as const)(
    "rejects %s-wrapper %s drift and admits a distinct clean successor",
    (phase, method) => {
      const local = person(
        `drift-${phase}-${method}`,
        `Drift ${phase} ${method}`,
        { isLocal: true, role: "owner" },
      );
      const session = new PresenceSession({
        localId: local.id,
        localName: local.name,
        users: [local],
        role: "owner",
      });
      const onCancel = vi.fn<(requestId: string) => void>();
      const ownerWindow = document.defaultView;
      if (!ownerWindow) {
        throw new Error("The test document has no Window");
      }
      const preventDefault = vi.spyOn(
        ownerWindow.Event.prototype,
        "preventDefault",
      );
      const focus = vi.spyOn(
        ownerWindow.HTMLElement.prototype,
        "focus",
      );
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      let restore: () => void = () => undefined;

      try {
        act(() => {
          root.render(
            <StrictMode>
              <PresenceRequests
                session={session.asCollabSession()}
                pending={[
                  request("drift-a", local.id),
                  request("drift-b", local.id),
                ]}
                nameOf={(id) => id}
                onCancel={onCancel}
              />
            </StrictMode>,
          );
        });
        const list = within(host).getByRole("list");
        const cancels = within(host).getAllByTestId(
          "presence-request-cancel",
        ) as HTMLButtonElement[];
        const source = cancels[0]!;
        const destination = cancels[1]!;
        const replacement = vi.fn(() =>
          method === "preventDefault" ? undefined : false,
        );
        const drift = (
          event: ReactKeyboardEvent<HTMLElement>,
        ) => {
          Object.defineProperty(event, method, {
            configurable: true,
            value: replacement,
          });
        };
        if (phase === "capture") {
          restore = interceptKeyDown(
            list,
            "onKeyDownCapture",
            (active, event) => {
              active(event);
              drift(event);
            },
          );
        } else {
          restore = interceptKeyDown(
            source,
            "onKeyDown",
            (active, event) => {
              const original = event[method];
              let reads = 0;
              Object.defineProperty(event, method, {
                configurable: true,
                get: () => {
                  reads += 1;
                  return reads === 1 ? original : replacement;
                },
              });
              active(event);
            },
          );
        }

        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const rejected = presenceKeyDown(source, {
          key: "ArrowRight",
          code: `${phase}-${method}-drift`,
        });
        expect(rejected.defaultPrevented).toBe(false);
        expect(preventDefault).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
        expect(source).toHaveFocus();
        expect(onCancel).not.toHaveBeenCalled();

        restore();
        restore = () => undefined;
        preventDefault.mockClear();
        focus.mockClear();
        const accepted = presenceKeyDown(source, {
          key: "ArrowRight",
          code: `${phase}-${method}-successor`,
        });
        expect(accepted.defaultPrevented).toBe(true);
        expect(destination).toHaveFocus();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(focus).toHaveBeenCalledExactlyOnceWith({
          preventScroll: true,
        });
        expect(onCancel).not.toHaveBeenCalled();
      } finally {
        restore();
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it("rejects modified, stale, replayed, and restored input before a clean successor event recovers", () => {
    const localA = person("reject-local-a", "Reject local A", {
      isLocal: true,
      role: "owner",
    });
    const localB = person("reject-local-b", "Reject local B", {
      isLocal: true,
      role: "owner",
    });
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
      role: "owner",
    });
    const pendingA = [
      request("reject-a", localA.id),
      request("reject-b", localA.id),
      request("reject-c", localA.id),
    ];
    const pendingB = [
      request("reject-a", localB.id),
      request("reject-b", localB.id),
      request("reject-c", localB.id),
    ];
    const onCancelA = vi.fn<(requestId: string) => void>();
    const onCancelB = vi.fn<(requestId: string) => void>();
    const nameOf = (id: string) => id;
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("The test document has no Window");
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const renderRequests = (
      session: PresenceSession,
      pending: AgentRequestMirror[],
      onCancel: (requestId: string) => void,
      instance = "same",
    ) => (
      <StrictMode>
        <PresenceRequests
          key={instance}
          session={session.asCollabSession()}
          pending={pending}
          nameOf={nameOf}
          onCancel={onCancel}
        />
      </StrictMode>
    );

    try {
      act(() => {
        root.render(renderRequests(sessionA, pendingA, onCancelA));
      });
      let list = within(host).getByRole("list");
      let cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      const source = cancels[1]!;
      const rejected: Array<{
        label: string;
        init: KeyboardEventInit;
        trusted?: boolean;
      }> = [
        {
          label: "Alt",
          init: { key: "ArrowRight", altKey: true },
        },
        {
          label: "Control",
          init: { key: "ArrowRight", ctrlKey: true },
        },
        {
          label: "Meta",
          init: { key: "ArrowRight", metaKey: true },
        },
        {
          label: "Shift",
          init: { key: "ArrowRight", shiftKey: true },
        },
        {
          label: "repeat",
          init: { key: "ArrowRight", repeat: true },
        },
        {
          label: "composition",
          init: { key: "ArrowRight", isComposing: true },
        },
        {
          label: "noncancelable",
          init: { key: "ArrowRight", cancelable: false },
        },
        {
          label: "nonbubbling",
          init: { key: "ArrowRight", bubbles: false },
        },
        {
          label: "untrusted",
          init: { key: "ArrowRight" },
          trusted: false,
        },
        { label: "Tab", init: { key: "Tab", code: "Tab" } },
        { label: "Enter", init: { key: "Enter", code: "Enter" } },
        { label: "Space", init: { key: " ", code: "Space" } },
        {
          label: "unrelated semantic key",
          init: { key: "PageDown", code: "ArrowRight" },
        },
      ];
      for (const { label, init, trusted = true } of rejected) {
        source.focus();
        preventDefault.mockClear();
        focus.mockClear();
        const event = presenceKeyDown(
          source,
          {
            code: "Unrestricted",
            ...init,
          },
          trusted,
        );
        expect(event.defaultPrevented, label).toBe(false);
        expect(preventDefault, label).not.toHaveBeenCalled();
        expect(focus, label).not.toHaveBeenCalled();
        expect(source, label).toHaveFocus();
      }

      cancels[0]!.focus();
      preventDefault.mockClear();
      focus.mockClear();
      expect(
        presenceKeyDown(source, {
          key: "ArrowRight",
          code: "WrongFocus",
        }).defaultPrevented,
      ).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(cancels[0]).toHaveFocus();

      source.focus();
      const preCanceled = new ownerWindow.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      markPresenceEventTrusted(preCanceled);
      preCanceled.preventDefault();
      preventDefault.mockClear();
      focus.mockClear();
      fireEvent(source, preCanceled);
      expect(preCanceled.defaultPrevented).toBe(true);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(source).toHaveFocus();

      const staleCapture = reactPropsEntry(list).props.onKeyDownCapture;
      const staleBubble = reactPropsEntry(source).props.onKeyDown;
      if (!staleCapture || !staleBubble) {
        throw new Error("The old keyboard wrappers were not published");
      }
      act(() => {
        root.render(renderRequests(sessionB, pendingB, onCancelB));
      });
      list = within(host).getByRole("list");
      cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      const currentSource = cancels[1]!;
      const currentDestination = cancels[2]!;
      const restoreCapture = interceptKeyDown(
        list,
        "onKeyDownCapture",
        (active, event) => {
          staleCapture(event);
          active(event);
        },
      );
      const restoreBubble = interceptKeyDown(
        currentSource,
        "onKeyDown",
        (active, event) => {
          staleBubble(event);
          active(event);
        },
      );
      currentSource.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const stale = presenceKeyDown(currentSource, {
        key: "ArrowRight",
        code: "StaleCallbackAndSession",
      });
      expect(stale.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(currentSource).toHaveFocus();
      restoreCapture();
      restoreBubble();

      preventDefault.mockClear();
      focus.mockClear();
      const once = new ownerWindow.KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "CleanSuccessor",
        bubbles: true,
        cancelable: true,
      });
      markPresenceEventTrusted(once);
      fireEvent(currentSource, once);
      expect(once.defaultPrevented).toBe(true);
      expect(currentDestination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      currentSource.focus();
      preventDefault.mockClear();
      focus.mockClear();
      fireEvent(currentSource, once);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(currentSource).toHaveFocus();

      const firstRow = within(host).getAllByTestId(
        "presence-request",
      )[0]!;
      const parent = firstRow.parentNode;
      const next = firstRow.nextSibling;
      if (!parent) throw new Error("The request row has no parent");
      parent.append(firstRow);
      parent.insertBefore(firstRow, next);
      currentSource.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const restored = presenceKeyDown(currentSource, {
        key: "ArrowRight",
        code: "RestoredDom",
      });
      expect(restored.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(currentSource).toHaveFocus();

      act(() => {
        root.render(
          renderRequests(
            sessionB,
            pendingB,
            onCancelB,
            "clean-remount",
          ),
        );
      });
      cancels = within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
      cancels[1]!.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const recovered = presenceKeyDown(cancels[1]!, {
        key: "ArrowRight",
        code: "Recovered",
      });
      expect(recovered.defaultPrevented).toBe(true);
      expect(cancels[2]).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(onCancelA).not.toHaveBeenCalled();
      expect(onCancelB).not.toHaveBeenCalled();
      expect(sessionA.follow).not.toHaveBeenCalled();
      expect(sessionB.follow).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("blocks keyboard reentry while retaining Tab, click, Enter, and Space cancellation", () => {
    const local = person("activation-local", "Activation local", {
      isLocal: true,
      role: "owner",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "owner",
    });
    const onCancel = vi.fn<(requestId: string) => void>();
    const ownerWindow = document.defaultView;
    if (!ownerWindow) throw new Error("The test document has no Window");
    const preventDefault = vi.spyOn(
      ownerWindow.Event.prototype,
      "preventDefault",
    );
    const focus = vi.spyOn(
      ownerWindow.HTMLElement.prototype,
      "focus",
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const renderInstance = (instance: string) => {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              key={instance}
              session={session.asCollabSession()}
              pending={[
                request(`${instance}-a`, local.id),
                request(`${instance}-b`, local.id),
              ]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      return within(host).getAllByTestId(
        "presence-request-cancel",
      ) as HTMLButtonElement[];
    };

    try {
      let cancels = renderInstance("reentry");
      const source = cancels[0]!;
      const destination = cancels[1]!;
      const restore = interceptKeyDown(
        source,
        "onKeyDown",
        (active, event) => {
          const original = event.preventDefault;
          Object.defineProperty(event, "preventDefault", {
            configurable: true,
            value: function (
              this: ReactKeyboardEvent<HTMLElement>,
            ) {
              const nested = presenceKeyDown(source, {
                key: "ArrowRight",
                code: "Nested",
              });
              expect(nested.defaultPrevented).toBe(false);
              return Reflect.apply(original, this, []);
            },
          });
          active(event);
        },
      );
      source.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const outer = presenceKeyDown(source, {
        key: "ArrowRight",
        code: "Outer",
      });
      restore();
      expect(outer.defaultPrevented).toBe(true);
      expect(destination).toHaveFocus();
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({
        preventScroll: true,
      });
      expect(onCancel).not.toHaveBeenCalled();

      cancels = renderInstance("tab");
      cancels[0]!.focus();
      preventDefault.mockClear();
      focus.mockClear();
      const tab = presenceKeyDown(cancels[0]!, {
        key: "Tab",
        code: "Tab",
      });
      expect(tab.defaultPrevented).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();

      for (const activation of ["click", "Enter", " "] as const) {
        cancels = renderInstance(`activate-${activation}`);
        const button = cancels[0]!;
        if (activation !== "click") {
          button.focus();
          const key = presenceKeyDown(button, {
            key: activation,
            code: activation === " " ? "Space" : "Enter",
          });
          expect(key.defaultPrevented).toBe(false);
          expect(onCancel).not.toHaveBeenCalled();
        }
        act(() => button.click());
        expect(onCancel).toHaveBeenCalledExactlyOnceWith(
          `activate-${activation}-a`,
        );
        onCancel.mockClear();
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("accepts a Cancel click with a production-mangled React event constructor", () => {
    const local = person("mangled-local", "Mangled local", {
      isLocal: true,
      role: "owner",
    });
    const session = new PresenceSession({
      localId: local.id,
      localName: local.name,
      users: [local],
      role: "owner",
    });
    const onCancel = vi.fn<(requestId: string) => void>();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <StrictMode>
            <PresenceRequests
              session={session.asCollabSession()}
              pending={[
                request("mangled-a", local.id),
                request("mangled-b", local.id),
              ]}
              nameOf={(id) => id}
              onCancel={onCancel}
            />
          </StrictMode>,
        );
      });
      const cancel = within(host).getAllByTestId(
        "presence-request-cancel",
      )[0] as HTMLButtonElement;
      const restore = interceptClick(cancel, (current, event) =>
        current(mangledReactEvent(event)),
      );
      act(() => cancel.click());
      restore();
      expect(onCancel).toHaveBeenCalledExactlyOnceWith("mangled-a");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it.each(["a-before-b", "b-before-a"] as const)(
    "binds request actions to exact sibling controls in %s order",
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
      };
      const callbacksB: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
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
        const cancelA = captureClick(a.cancels[0]);
        const cancelB = captureClick(b.cancels[0]);
        const replacementCancel = a.cancels[0].cloneNode(true) as HTMLButtonElement;
        document.body.append(replacementCancel);
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
          cancelA(movingAEvent);
        });

        expect(callbacksA.onCancel).not.toHaveBeenCalled();
        expect(callbacksB.onCancel).not.toHaveBeenCalled();
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
        });

        expect(callbacksA.onCancel).toHaveBeenCalledExactlyOnceWith("leaf-request-a");
        expect(callbacksB.onCancel).toHaveBeenCalledExactlyOnceWith("leaf-request-b");
      } finally {
        act(() => root.unmount());
        host.remove();
        focusOwner.remove();
        foreign.remove();
        detached.remove();
      }
    },
  );

  it.each(["section", "list", "row", "cancel"] as const)(
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
      };
      const callbacksB: PresenceLeafCallbacks = {
        onCancel: vi.fn(),
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
        const element =
          part === "section"
            ? previous.section
            : part === "list"
              ? previous.list
              : part === "row"
                ? previous.rows[0]
                : previous.cancels[0];
        const staleRef = captureRef(element);
        const replacement = element.cloneNode(true) as typeof element;
        document.body.append(replacement);

        act(() => {
          staleRef(replacement);
          previousCancel({ currentTarget: previous.cancels[0] });
        });
        expect(callbacksA.onCancel).not.toHaveBeenCalled();
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
                        : current.cancels[0];
                sameElementAtBoundary = currentElement === element;
                staleRef(currentElement);
                staleRef(null);
                previousCancel({ currentTarget: current.cancels[0] });
              }}
            />,
          );
        });

        expect(sameElementAtBoundary).toBe(true);
        expect(callbacksA.onCancel).not.toHaveBeenCalled();
        const current = leafElements(screen.getByTestId("presence-leaves"));
        act(() => {
          current.cancels[0].click();
        });
        expect(callbacksB.onCancel).toHaveBeenCalledExactlyOnceWith("ref-request");
      } finally {
        act(() => root.unmount());
        host.remove();
      }
    },
  );

  it.each([
    { control: "Cancel" },
  ] as const)(
    "keeps $control exact through direct Strict Mode replay, corruption, remount, repetition, and reentry",
    ({ control }) => {
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
      const handlers = { onCancel };
      const nameOf = (id: string) => `Name ${id}`;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
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
            instance={instance}
            boundary={boundary}
            onBoundary={onBoundary}
          />
        </StrictMode>
      );
      const targetOf = (elements: ReturnType<typeof leafElements>) =>
        elements.cancels[0]!;
      const rootOf = (elements: ReturnType<typeof leafElements>): HTMLElement =>
        elements.section;

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
        expect(firstCurrentTarget).toHaveClass("btn-outline");

        const originalInstruction = pending[0]!.instruction;
        pending[0]!.instruction = "Transiently changed request";
        act(() => firstCurrentTarget.click());
        pending[0]!.instruction = originalInstruction;
        expect(onCancel).not.toHaveBeenCalled();

        act(() => {
          firstCurrentActionRef(null);
          firstCurrentActionRef(firstCurrentTarget);
          firstCurrentTarget.click();
        });
        expect(onCancel).not.toHaveBeenCalled();

        const label = firstCurrentTarget.lastChild;
        if (!label || label.nodeType !== document.defaultView!.Node.TEXT_NODE) {
          throw new Error("The Strict Mode action label was not a text node");
        }
        const originalLabel = label.nodeValue;
        label.nodeValue = `${originalLabel} changed`;
        label.nodeValue = originalLabel;
        const clone = firstCurrent.rows[0]!.cloneNode(true) as HTMLLIElement;
        firstCurrent.rows[0]!.replaceWith(clone);
        clone.replaceWith(firstCurrent.rows[0]!);
        firstCurrent.list.insertBefore(firstCurrent.rows[1]!, firstCurrent.rows[0]!);
        firstCurrent.list.insertBefore(firstCurrent.rows[0]!, firstCurrent.rows[1]!);
        const parent = firstCurrentRoot.parentNode;
        if (!parent) throw new Error("The Strict Mode publication did not have a parent");
        const nextSibling = firstCurrentRoot.nextSibling;
        firstCurrentRoot.remove();
        parent.insertBefore(firstCurrentRoot, nextSibling);
        act(() => firstCurrentTarget.click());
        expect(onCancel).not.toHaveBeenCalled();

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

        onCancel.mockImplementationOnce(() => {
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

        expect(onCancel).toHaveBeenCalledExactlyOnceWith("strict-request-a");
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
    };
    const callbacksB: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
    };
    const callbacksC: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
    };
    const callbacksD: PresenceLeafCallbacks = {
      onCancel: vi.fn(),
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
      const oldCancelRef = captureRef(old.cancels[0]);
      let changedAtBoundary = false;

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksB}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            boundary={1}
            onBoundary={() => {
              const current = leafElements(screen.getByTestId("presence-leaves"));
              changedAtBoundary =
                current.cancels[0] === old.cancels[0] &&
                current.rows[0].textContent?.includes("Current requester") === true &&
                current.rows[0].textContent?.includes("Current owner's Agent") === true;
              oldCancelRef(current.cancels[0]);
              oldCancelRef(null);
              oldCancel({ currentTarget: current.cancels[0] });
            }}
          />,
        );
      });

      expect(changedAtBoundary).toBe(true);
      expect(callbacksA.onCancel).not.toHaveBeenCalled();
      const changed = leafElements(screen.getByTestId("presence-leaves"));
      const changedCancel = captureClick(changed.cancels[0]);
      const changedCancelRef = captureRef(changed.cancels[0]);
      let remountedAtBoundary = false;

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksC}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            instance="equal-looking-remount"
            boundary={2}
            onBoundary={() => {
              const current = leafElements(screen.getByTestId("presence-leaves"));
              remountedAtBoundary =
                current.cancels[0] !== changed.cancels[0];
              changedCancelRef(current.cancels[0]);
              changedCancelRef(null);
              changedCancel({ currentTarget: changed.cancels[0] });
              changedCancel({ currentTarget: current.cancels[0] });
            }}
          />,
        );
      });

      expect(remountedAtBoundary).toBe(true);
      expect(callbacksB.onCancel).not.toHaveBeenCalled();
      const remounted = leafElements(screen.getByTestId("presence-leaves"));
      const remountedCancel = captureClick(remounted.cancels[0]);
      const remountedCancelRef = captureRef(remounted.cancels[0]);
      act(() => {
        remounted.cancels[0].click();
      });
      expect(callbacksC.onCancel).toHaveBeenCalledExactlyOnceWith("mount-request");

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksC}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            instance="equal-looking-remount"
            present={false}
            boundary={3}
            onBoundary={() => {
              remountedCancelRef(null);
              remountedCancel({ currentTarget: remounted.cancels[0] });
            }}
          />,
        );
      });
      expect(screen.queryByTestId("presence-leaves")).toBeNull();
      expect(callbacksC.onCancel).toHaveBeenCalledOnce();

      act(() => {
        root.render(
          <PresenceLeafBoundary
            session={sessionB}
            pending={pendingB}
            callbacks={callbacksD}
            nameOf={() => "Current requester"}
            ownerNameOf={() => "Current owner"}
            instance="after-removal"
            boundary={4}
          />,
        );
      });
      const afterRemoval = leafElements(screen.getByTestId("presence-leaves"));
      act(() => {
        afterRemoval.cancels[0].click();
      });
      expect(callbacksD.onCancel).toHaveBeenCalledExactlyOnceWith("mount-request");
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
      const oldConnectAgentButton = within(popoverA).getByTestId("connect-agent");
      const oldCancel = captureClick(oldCancelButton);
      const oldJump = captureClick(oldJumpButton);
      const oldFollow = captureClick(oldFollowButton);
      const oldConnectAgent = captureClick(oldConnectAgentButton);
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
              oldConnectAgent({ currentTarget: oldConnectAgentButton });
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
      expect(handlersA.onConnectAgent).not.toHaveBeenCalled();
      expect(sessionA.follow).not.toHaveBeenCalled();
      expect(handlersB.onCancelRequest).not.toHaveBeenCalled();
      expect(handlersB.onJump).not.toHaveBeenCalled();
      expect(handlersB.onConnectAgent).not.toHaveBeenCalled();
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
      const currentConnectAgentButton = within(popoverB).getByTestId("connect-agent");
      act(() => currentConnectAgentButton.click());
      expect(handlersB.onConnectAgent).toHaveBeenCalledOnce();
      expect(screen.queryByTestId("presence-popover")).toBeNull();

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
      const oldConnectAgentButton = within(popoverA).getByTestId("connect-agent");
      const oldCancel = captureClick(oldCancelButton);
      const oldJump = captureClick(oldJumpButton);
      const oldFollow = captureClick(oldFollowButton);
      const oldConnectAgent = captureClick(oldConnectAgentButton);
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
              oldConnectAgent({ currentTarget: oldConnectAgentButton });
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
      expect(handlersA.onConnectAgent).not.toHaveBeenCalled();
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
      expect(handlersB.onConnectAgent).not.toHaveBeenCalled();
      expect(sessionB.follow).not.toHaveBeenCalled();
      expect(activeTimerHandles(setTimeoutSpy.mock.calls, setTimeoutSpy.mock.results, clearTimeoutSpy.mock.calls, [CANCEL_GRACE_MS])).toHaveLength(0);
      expect(activeTimerHandles(setIntervalSpy.mock.calls, setIntervalSpy.mock.results, clearIntervalSpy.mock.calls, [5_000, 15_000])).toHaveLength(1);

      popoverB = screen.getByTestId("presence-popover");
      expect(within(popoverB).queryByTestId("presence-requests")).toBeNull();
      expect(within(popoverB).getByTestId("connect-agent")).toBeEnabled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      focusOwner.remove();
    }
  });
});
