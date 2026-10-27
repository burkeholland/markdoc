// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabSession } from "@/editor/collab/session";
import type { AgentRequestMirror } from "./agent-requests";
import { ConnectAgentButton, PresenceRequests } from "./presence-agents";

function request(over: Partial<AgentRequestMirror>): AgentRequestMirror {
  return { id: "r1", status: "open", mode: "suggest", instruction: "Tighten this", claimedBy: null, result: null, userId: "me", updatedAt: 0, ...over };
}

function session(role: CollabSession["role"] = "editor") {
  return { user: { id: "me", login: "me" }, role } as unknown as CollabSession;
}

const PENDING = [request({ id: "a" }), request({ id: "b", userId: "other" }), request({ id: "c" })];

afterEach(cleanup);

describe("PresenceRequests real input", () => {
  it("cancels on fireEvent and userEvent clicks", async () => {
    const onCancel = vi.fn();
    render(<PresenceRequests session={session()} pending={PENDING} nameOf={() => "Bob"} onCancel={onCancel} />);
    const buttons = screen.getAllByTestId("presence-request-cancel");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onCancel).toHaveBeenLastCalledWith("a");
    await userEvent.setup().click(buttons[1]!);
    expect(onCancel).toHaveBeenLastCalledWith("c");
    expect(screen.getAllByTestId("presence-request-state")[1]).toHaveTextContent("Waiting for an agent · tracked changes · asked by Bob");
  });

  it("lets owners cancel anyone's request and hides Cancel without onCancel", () => {
    const view = render(<PresenceRequests session={session("owner")} pending={PENDING} nameOf={() => null} onCancel={() => {}} />);
    expect(screen.getAllByTestId("presence-request-cancel")).toHaveLength(3);
    view.rerender(<PresenceRequests session={session("owner")} pending={PENDING} nameOf={() => null} />);
    expect(screen.queryByTestId("presence-request-cancel")).toBeNull();
  });

  it("moves focus between Cancel buttons with arrows, Home and End", async () => {
    const user = userEvent.setup();
    render(<PresenceRequests session={session("owner")} pending={PENDING} nameOf={() => null} onCancel={() => {}} />);
    const [a, b, c] = screen.getAllByTestId("presence-request-cancel");
    a!.focus();
    await user.keyboard("{ArrowDown}");
    expect(b).toHaveFocus();
    fireEvent.keyDown(b!, { key: "End" });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c!, { key: "ArrowUp" });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b!, { key: "Home" });
    expect(a).toHaveFocus();
  });

  it("ConnectAgentButton honours a synthetic click", () => {
    const onClick = vi.fn();
    render(<ConnectAgentButton onClick={onClick} />);
    fireEvent.click(screen.getByTestId("connect-agent"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
