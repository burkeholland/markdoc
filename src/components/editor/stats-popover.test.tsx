// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as Y from "yjs";

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
import { StatsPopover } from "./stats-popover";

const sessions: CollabSession[] = [];

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

afterEach(() => {
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
  vi.restoreAllMocks();
});

describe("StatsPopover writing goal draft", () => {
  it("follows a collaborator setting, changing, and clearing every shared goal field", async () => {
    const session = makeSession("doc");
    render(view(session));
    openPopover();
    expectDraft("words", "min", "");

    await updateSharedGoal(session, goal("words", "min", 250));
    expectDraft("words", "min", "250");

    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "999" } });
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

    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "44" } });
    rendered.rerender(view(second));

    expectDraft("words", "min", "");
    expect(screen.getByTestId("goal-summary")).toHaveAttribute("data-state", "none");
  });

  it("keeps local edits through source, statistics, and unrelated session rerenders", async () => {
    const session = makeSession("doc", "owner", goal("words", "min", 100));
    const rendered = render(view(session, "One two."));
    openPopover();

    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "333" } });
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
    fireEvent.change(screen.getByTestId("goal-mode"), { target: { value: "max" } });
    fireEvent.change(screen.getByTestId("goal-value"), { target: { value: "4.6" } });
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
