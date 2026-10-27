// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { makeCollabUser } from "@/editor/collab/shared";
import type { WritingGoal } from "@/editor/stats";
import { StatsPopover } from "./stats-popover";
import { getGoal, setGoal } from "@/editor/collab/meta";

const sessions: CollabSession[] = [];

function makeSession(docId: string, role: "owner" | "viewer" = "owner", goal: WritingGoal | null = null): CollabSession {
  const session = new CollabSession({
    docId,
    user: makeCollabUser("alice", "Alice", null, "alice"),
    role,
    getToken: async () => {
      throw new Error("no provider");
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

afterEach(() => {
  cleanup();
  while (sessions.length) sessions.pop()!.destroy();
  vi.restoreAllMocks();
});

describe("StatsPopover · real input", () => {
  it("opens on click, closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<StatsPopover session={makeSession("click")} source="One two three." selection={null} hydrated />);
    const trigger = screen.getByTestId("stats-button");
    expect(screen.getByTestId("word-count")).toHaveTextContent("3 words");
    await user.click(trigger);
    expect(screen.getByTestId("stats-popover")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("stats-popover")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard focusing the first or last control", async () => {
    const user = userEvent.setup();
    render(<StatsPopover session={makeSession("keys", "owner", { kind: "words", mode: "min", value: 10, setBy: null, setAt: 1 })} source="One." selection={null} hydrated />);
    screen.getByTestId("stats-button").focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("goal-mode")).toHaveFocus();
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("goal-clear")).toHaveFocus();
  });

  it("sets a goal by typing and submitting, then clears it", async () => {
    const user = userEvent.setup();
    const session = makeSession("goal");
    render(<StatsPopover session={session} source="One two." selection={null} hydrated />);
    await user.click(screen.getByTestId("stats-button"));
    expect(screen.getByTestId("goal-set")).toBeDisabled();
    await user.selectOptions(screen.getByTestId("goal-mode"), "max");
    await user.type(screen.getByTestId("goal-value"), "12");
    await user.selectOptions(screen.getByTestId("goal-kind"), "minutes");
    await user.type(screen.getByTestId("goal-value"), "{Enter}");
    expect(getGoal(session)).toMatchObject({ kind: "minutes", mode: "max", value: 12, setBy: "alice" });
    await user.click(screen.getByTestId("goal-clear"));
    expect(getGoal(session)).toBeNull();
  });

  it("moves between Set and Clear with arrow keys", async () => {
    const user = userEvent.setup();
    render(<StatsPopover session={makeSession("nav", "owner", { kind: "words", mode: "min", value: 10, setBy: null, setAt: 1 })} source="One." selection={null} hydrated />);
    await user.click(screen.getByTestId("stats-button"));
    screen.getByTestId("goal-set").focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("goal-clear")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("goal-clear")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByTestId("goal-set")).toHaveFocus();
  });

  it("hides the goal form for viewers", async () => {
    const user = userEvent.setup();
    render(<StatsPopover session={makeSession("viewer", "viewer")} source="One." selection={null} hydrated />);
    await user.click(screen.getByTestId("stats-button"));
    expect(screen.getByTestId("goal-summary")).toHaveTextContent("No goal set for this document.");
    expect(screen.queryByTestId("goal-value")).toBeNull();
  });
});
