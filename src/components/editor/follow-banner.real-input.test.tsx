// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, PresenceUser } from "@/editor/collab/session";
import { FollowBanner } from "./follow-banner";

const ADA = {
  id: "collaborator-a",
  name: "Ada",
  color: "#123456",
  section: "Intro",
} as PresenceUser;

function makeSession(target: string | null = ADA.id) {
  const follow = vi.fn<(userId: string | null) => void>();
  const session = {
    version: 0,
    followUserId: target,
    presence: () => [ADA],
    subscribe: () => () => {},
    follow,
  };
  return { session: session as unknown as CollabSession, follow };
}

afterEach(cleanup);

describe("FollowBanner real input", () => {
  it("stops following on a synthetic fireEvent click", () => {
    const { session, follow } = makeSession();
    render(<FollowBanner session={session} />);
    fireEvent.click(screen.getByTestId("follow-stop"));
    expect(follow).toHaveBeenCalledWith(null);
  });

  it("stops following on a userEvent click and keyboard activation", async () => {
    const user = userEvent.setup();
    const { session, follow } = makeSession();
    render(<FollowBanner session={session} />);
    await user.click(screen.getByTestId("follow-stop"));
    expect(follow).toHaveBeenCalledTimes(1);
    screen.getByTestId("follow-stop").focus();
    await user.keyboard("{Enter}");
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it("stops following on a dispatched Escape keydown", () => {
    const { session, follow } = makeSession();
    render(<FollowBanner session={session} />);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(follow).toHaveBeenCalledExactlyOnceWith(null);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores modified, repeated, or already-handled Escape and does not listen when not following", () => {
    const { session, follow } = makeSession();
    const view = render(<FollowBanner session={session} />);
    fireEvent.keyDown(document, { key: "Escape", shiftKey: true });
    fireEvent.keyDown(document, { key: "Escape", repeat: true });
    fireEvent.keyDown(document, { key: "Enter" });
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(follow).not.toHaveBeenCalled();
    view.unmount();

    const idle = makeSession(null);
    render(<FollowBanner session={idle.session} />);
    expect(screen.queryByTestId("follow-banner")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(idle.follow).not.toHaveBeenCalled();
  });
});
