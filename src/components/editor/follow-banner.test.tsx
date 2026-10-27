// @vitest-environment jsdom

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  drift(target: string | null, users: PresenceUser[]) {
    this.target = target;
    this.users = users;
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }
}

function stopButton(host: HTMLElement): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-testid="follow-stop"]');
  if (!button) throw new Error("The Follow banner did not publish a Stop button");
  return button;
}

afterEach(() => {
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

  describe("long labels and native title", () => {
    it.each([
      { label: "spaced name", name: "Long collaborator name ".repeat(12), section: null },
      { label: "unbroken name", name: "N".repeat(240), section: null },
      {
        label: "spaced name and section",
        name: "Long collaborator name ".repeat(12),
        section: "Long section heading ".repeat(12),
      },
      { label: "unbroken name and section", name: "N".repeat(240), section: "S".repeat(240) },
      { label: "empty section", name: "N".repeat(240), section: "" },
    ])("constrains $label without shortening literal text or displacing Stop", ({ name, section }) => {
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user({ name, section })], action);
      const view = render(
        <StrictMode>
          <FollowBanner session={session.asCollabSession()} />
        </StrictMode>,
      );
      const banner = screen.getByRole("status");
      const message = banner.firstElementChild;
      const separator = banner.children.item(1);
      const stop = stopButton(view.container);
      const expected = `Following ${name}${section ? ` · in ‘${section}’` : ""}`;

      expect(name.length).toBeGreaterThanOrEqual(200);
      if (section) expect(section.length).toBeGreaterThanOrEqual(200);
      expect(banner).toHaveClass("flex", "h-8", "min-w-0", "shrink-0", "justify-center");
      expect(banner.style.backgroundColor).toBe("rgb(18, 52, 86)");
      expect(banner.children).toHaveLength(3);
      expect(banner.childNodes).toHaveLength(3);
      expect(message?.tagName).toBe("SPAN");
      expect(message).toHaveClass("min-w-0 flex-initial truncate", { exact: true });
      expect(message?.textContent).toBe(expected);
      expect(message).toHaveAttribute("title", expected);
      expect(message?.childNodes).toHaveLength(section ? 3 : 2);
      expect(message?.children).toHaveLength(section ? 1 : 0);
      if (section) {
        expect(message?.firstElementChild?.tagName).toBe("SPAN");
        expect(message?.firstElementChild).toHaveClass("opacity-80", { exact: true });
        expect(message?.firstElementChild?.textContent).toBe(` · in ‘${section}’`);
      }
      expect(separator?.tagName).toBe("SPAN");
      expect(separator?.textContent).toBe("·");
      expect(separator).toHaveClass("shrink-0 opacity-60", { exact: true });
      expect(stop).toHaveClass("shrink-0");
      expect(stop).toHaveAttribute("type", "button");
      expect(stop).toHaveAccessibleName("Stop (Esc)");
      expect(stop.querySelector("svg")).toHaveAttribute("width", "13");
      expect(banner.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(1);

      fireEvent.click(stop);
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
      expect(action.mock.contexts[0]).toBe(session);
    });

    it("keeps special names and sections literal in the existing spans and title", () => {
      const name = '<strong title="name">A & B</strong>'.repeat(8);
      const section = '<img alt="section"> \'quoted\' & <span>text</span>'.repeat(8);
      const action = vi.fn<(userId: string | null) => void>();
      const session = new ControlledSession(BASE_USER.id, [user({ name, section })], action);
      const view = render(<FollowBanner session={session.asCollabSession()} />);
      const banner = screen.getByRole("status");
      const message = banner.firstElementChild;
      const expected = `Following ${name} · in ‘${section}’`;

      expect(name.length).toBeGreaterThanOrEqual(200);
      expect(section.length).toBeGreaterThanOrEqual(200);
      expect(message?.textContent).toBe(expected);
      expect(message).toHaveAttribute("title", expected);
      expect(banner.children).toHaveLength(3);
      expect(message?.childNodes).toHaveLength(3);
      expect(message?.querySelectorAll("*")).toHaveLength(1);
      expect(message?.firstElementChild?.tagName).toBe("SPAN");
      expect(message?.firstElementChild?.children).toHaveLength(0);
      expect(message?.firstElementChild?.textContent).toBe(` · in ‘${section}’`);
      expect(banner.querySelectorAll("strong, img")).toHaveLength(0);

      fireEvent.click(stopButton(view.container));
      expect(action).toHaveBeenCalledExactlyOnceWith(null);
    });

  });
});
