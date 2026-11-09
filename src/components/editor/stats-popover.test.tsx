// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  class HocuspocusProvider {
    awareness: InstanceType<typeof Awareness>;
    constructor(opts: { document: Y.Doc }) {
      this.awareness = new Awareness(opts.document);
    }
    destroy() {
      this.awareness.destroy();
    }
  }
  return { HocuspocusProvider };
});

import { CollabSession } from "@/editor/collab/session";
import { getGoal, setGoal } from "@/editor/collab/meta";
import { makeCollabUser } from "@/editor/collab/shared";
import type { WritingGoal } from "@/editor/stats";
import { StatsPopover, useLocalSelection, type SourceSelection } from "./stats-popover";

const sessions: CollabSession[] = [];
const unhandledRejections: unknown[] = [];

function recordUnhandledRejection(reason: unknown) {
  unhandledRejections.push(reason);
}

function makeSession(docId: string, role: "owner" | "viewer" = "owner", goal: WritingGoal | null = null): CollabSession {
  const session = new CollabSession({
    docId,
    user: makeCollabUser("alice", "Alice", null, "alice"),
    role,
    getToken: async () => {
      throw new Error("Provider access is forbidden in stats popover tests");
    },
    autoConnect: false,
    deferLocal: true,
  });
  session.keepAlive();
  session.synced = true;
  vi.spyOn(session.binding, "hasHeldSync", "get").mockReturnValue(false);
  if (goal) setGoal(session, goal);
  sessions.push(session);
  return session;
}

function goal(kind: WritingGoal["kind"], mode: WritingGoal["mode"], value: number, setBy = "bob"): WritingGoal {
  return { kind, mode, value, setBy, setAt: value };
}

function view(session: CollabSession, source = "One two three.") {
  return <StatsPopover session={session} source={source} selection={null} hydrated />;
}

function setLocalSelection(session: CollabSession, anchor: number, head: number) {
  session.awareness.setLocalStateField("cursor", {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, anchor)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(session.ytext, head)),
  });
}

function seedSelection(session: CollabSession, source: string, anchor: number, head: number) {
  session.ytext.insert(0, source);
  setLocalSelection(session, anchor, head);
}

function trackSelectionSubscriptions(session: CollabSession) {
  const awarenessOn = vi.spyOn(session.awareness, "on");
  const awarenessOff = vi.spyOn(session.awareness, "off");
  const originalSubscribe = session.subscribe;
  const textUnsubscribes: { calls: number }[] = [];
  const subscribe = vi.spyOn(session, "subscribe").mockImplementation((listener) => {
    const unsubscribe = originalSubscribe(listener);
    const tracked = { calls: 0 };
    textUnsubscribes.push(tracked);
    return () => {
      tracked.calls++;
      unsubscribe();
    };
  });
  const awarenessCalls = (spy: typeof awarenessOn | typeof awarenessOff) =>
    spy.mock.calls.filter(([event]) => event === "change").length;
  return {
    awarenessOff,
    awarenessOn,
    subscribe,
    textUnsubscribes,
    activeAwareness: () => awarenessCalls(awarenessOn) - awarenessCalls(awarenessOff),
    activeText: () => subscribe.mock.calls.length - textUnsubscribes.filter(({ calls }) => calls > 0).length,
  };
}

function SelectionProbe({ session, onSelection }: { session: CollabSession; onSelection?: (selection: SourceSelection) => void }) {
  const selection = useLocalSelection(session);
  useLayoutEffect(() => onSelection?.(selection), [onSelection, selection]);
  return <output data-testid="selection-probe">{selection ? `${selection.from}:${selection.to}` : "none"}</output>;
}

function SelectionStats({ session, source }: { session: CollabSession; source: string }) {
  const selection = useLocalSelection(session);
  return <StatsPopover session={session} source={source} selection={selection} hydrated />;
}

const emptySelectionCases: { label: string; select: (session: CollabSession) => void }[] = [
  { label: "missing", select: () => {} },
  { label: "collapsed", select: (session) => setLocalSelection(session, 4, 4) },
];

function openPopover() {
  fireEvent.click(screen.getByTestId("stats-button"));
  expect(screen.getByTestId("stats-popover")).toBeVisible();
}

function expectDraft(kind: WritingGoal["kind"], mode: WritingGoal["mode"], value: string) {
  expect(screen.getByTestId("goal-kind")).toHaveValue(kind);
  expect(screen.getByTestId("goal-mode")).toHaveValue(mode);
  expect(screen.getByTestId("goal-value")).toHaveValue(Number(value) || null);
}

async function updateSharedGoal(session: CollabSession, next: WritingGoal | null) {
  await act(async () => {
    setGoal(session, next);
    await Promise.resolve();
  });
}

beforeEach(() => {
  unhandledRejections.length = 0;
  process.on("unhandledRejection", recordUnhandledRejection);
});

afterEach(async () => {
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
  await Promise.resolve();
  process.off("unhandledRejection", recordUnhandledRejection);
  vi.restoreAllMocks();
  expect(unhandledRejections).toEqual([]);
});

describe("StatsPopover local selection authority", () => {
  it("publishes current awareness and text changes once while keeping one subscription to each", async () => {
    const session = makeSession("current-selection");
    seedSelection(session, "One two three.", 0, 3);
    const subscriptions = trackSelectionSubscriptions(session);
    const publications = vi.fn();

    render(<SelectionProbe session={session} onSelection={publications} />);
    await act(async () => {});

    expect(screen.getByTestId("selection-probe")).toHaveTextContent("0:3");
    expect(subscriptions.activeAwareness()).toBe(1);
    expect(subscriptions.activeText()).toBe(1);
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }]);

    act(() => setLocalSelection(session, 4, 7));
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("4:7");
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }, { from: 4, to: 7 }]);

    act(() => session.awareness.setLocalStateField("stats-test-revision", 1));
    await act(async () => {
      session.ytext.insert(session.ytext.length, " Four.");
      await Promise.resolve();
    });
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([null, { from: 0, to: 3 }, { from: 4, to: 7 }]);

    await act(async () => {
      session.ytext.insert(0, "Zero ");
      await Promise.resolve();
    });
    expect(screen.getByTestId("selection-probe")).toHaveTextContent("9:12");
    expect(publications.mock.calls.map(([selection]) => selection)).toEqual([
      null,
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 9, to: 12 },
    ]);
    expect(subscriptions.activeAwareness()).toBe(1);
    expect(subscriptions.activeText()).toBe(1);
  });

  it.each(emptySelectionCases)("renders no selection counts for a $label local selection", async ({ select }) => {
    const session = makeSession("empty-selection");
    const source = "One two three.";
    session.ytext.insert(0, source);
    select(session);

    render(<SelectionStats session={session} source={source} />);
    await act(async () => {});
    openPopover();

    expect(screen.queryByTestId("selection-count")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Selection" })).toBeNull();
  });
});

describe("StatsPopover writing goal draft", () => {
  it("follows a collaborator setting, changing, and clearing every shared goal field", async () => {
    const session = makeSession("doc");
    render(view(session));
    openPopover();
    expectDraft("words", "min", "");

    await updateSharedGoal(session, goal("words", "min", 250));
    expectDraft("words", "min", "250");

    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "999" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    await updateSharedGoal(session, goal("minutes", "max", 7, "carol"));
    expectDraft("minutes", "max", "7");
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @carol");

    await updateSharedGoal(session, null);
    expectDraft("words", "min", "");
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "none");
  });

  it("drops the previous document draft when navigation supplies a goal-less session", () => {
    const first = makeSession("first", "owner", goal("minutes", "max", 12));
    const second = makeSession("second");
    const rendered = render(view(first));
    openPopover();
    expectDraft("minutes", "max", "12");

    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "44" } });
    rendered.rerender(view(second));

    expect(screen.queryByTestId("stats-popover")).toBeNull();
    openPopover();
    expectDraft("words", "min", "");
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "none");
  });

  it("keeps local edits through source, statistics, and unrelated session rerenders", async () => {
    const session = makeSession("doc", "owner", goal("words", "min", 100));
    const rendered = render(view(session, "One two."));
    openPopover();

    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "333" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    await act(async () => {
      session.ytext.insert(0, "An unrelated source update.");
      await Promise.resolve();
    });
    rendered.rerender(view(session, "One two three four five."));

    expect(screen.getByTestId("word-count")).toHaveTextContent("5 words");
    expectDraft("minutes", "max", "333");
    expect(getGoal(session)).toMatchObject({ kind: "words", mode: "min", value: 100 });
  });

  it("submits and clears only the current session, preserving rounding and attribution", async () => {
    const previous = makeSession("previous", "owner", goal("words", "min", 400));
    const current = makeSession("current");
    let previousWrites = 0;
    let currentWrites = 0;
    previous.meta.observe(() => previousWrites++);
    current.meta.observe(() => currentWrites++);

    const rendered = render(view(previous));
    openPopover();
    rendered.rerender(view(current));
    expect(screen.queryByTestId("stats-popover")).toBeNull();
    openPopover();
    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.input(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
    fireEvent.change(screen.getByTestId("goal-kind"), { target: { value: "minutes" } });
    fireEvent.submit(screen.getByTestId("goal-set").closest("form")!);

    await waitFor(() => expect(getGoal(current)).toMatchObject({ kind: "minutes", mode: "max", value: 5, setBy: "alice" }));
    expect(getGoal(previous)).toMatchObject({ kind: "words", mode: "min", value: 400 });
    expect(previousWrites).toBe(0);
    expect(currentWrites).toBe(1);
    expectDraft("minutes", "max", "5");

    fireEvent.click(screen.getByTestId("goal-clear"));
    await waitFor(() => expect(getGoal(current)).toBeNull());
    expect(getGoal(previous)).toMatchObject({ value: 400 });
    expect(previousWrites).toBe(0);
    expect(currentWrites).toBe(2);
    expectDraft("words", "min", "");
  });

  it("keeps shared goal progress and attribution read-only while following remote updates", async () => {
    const session = makeSession("read-only", "viewer", goal("minutes", "max", 3));
    render(view(session));
    openPopover();

    expect(screen.getByTestId("goal-summary")).toHaveTextContent("At most 3 min read");
    expect(screen.getAllByTestId("goal-ring")).toHaveLength(2);
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @bob");
    expect(screen.queryByTestId("goal-set")).toBeNull();
    expect(screen.queryByTestId("goal-clear")).toBeNull();

    await updateSharedGoal(session, goal("words", "min", 10, "carol"));
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("At least 10 words");
    expect(screen.getByTestId("goal-section")).toHaveTextContent("Set by @carol");
    expect(screen.queryByTestId("goal-value")).toBeNull();

    await updateSharedGoal(session, null);
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("No goal set for this document");
    expect(screen.queryAllByTestId("goal-ring")).toHaveLength(0);
  });
});

describe("StatsPopover loading state", () => {
  it("shows placeholders until ready, then the statistics and goal progress on the same instance", async () => {
    const session = makeSession("loading", "owner", goal("words", "min", 10));
    const source = "One two three.";
    session.ytext.insert(0, source);
    const selection = { from: 0, to: 3 };
    const popover = (ready: boolean) => <StatsPopover key="initial" session={session} source={source} selection={selection} hydrated ready={ready} />;

    const { rerender } = render(popover(false));
    await act(async () => {});
    openPopover();
    const wordCount = screen.getByTestId("word-count");

    expect(wordCount).toHaveTextContent("— words");
    expect(screen.queryByTestId("selection-count")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Selection" })).toBeNull();
    const wordsRow = screen.getByTestId("stats-table").querySelector('[data-stat="words"]')!;
    expect(wordsRow).toHaveTextContent("—");
    expect(wordsRow.querySelectorAll("td")).toHaveLength(2);
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "loading");
    expect(screen.queryByTestId("goal-ring")).toBeNull();

    rerender(popover(true));

    expect(screen.getByTestId("word-count")).toBe(wordCount);
    expect(wordCount).toHaveTextContent("3 words");
    expect(screen.getByTestId("selection-count")).toHaveTextContent("1 of 3 selected");
    expect(screen.getByRole("columnheader", { name: "Selection" })).toBeVisible();
    expect(wordsRow).toHaveTextContent("3");
    expect(wordsRow.querySelectorAll("td")).toHaveLength(3);
    expect(screen.getByTestId("goal-summary")).not.toHaveAttribute("data-state", "loading");
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("At least 10 words");
    expect(screen.getAllByTestId("goal-ring").length).toBeGreaterThan(0);
  });
});
