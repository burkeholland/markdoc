// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, EditMode } from "@/editor/collab/session";
import { ModeSwitcher } from "./header";

type ModeRole = "owner" | "editor" | "commenter" | "viewer";

class ModeSession {
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly docId: string,
    readonly role: ModeRole,
    public mode: EditMode,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly setMode = vi.fn((mode: EditMode) => {
    this.mode = mode;
    this.publish();
  });

  setExternalMode(mode: EditMode) {
    this.mode = mode;
    this.publish();
  }

  asCollabSession(): CollabSession {
    return this as unknown as CollabSession;
  }

  private publish() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

function ModeBoundary({
  session,
  present = true,
  boundary = 0,
  onBoundary,
}: {
  session: ModeSession;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <ModeSwitcher session={session.asCollabSession()} /> : null;
}

interface ReactFiber {
  return: ReactFiber | null;
  memoizedProps?: Record<string, unknown>;
}

function captureFiberHandler<T>(element: HTMLElement, property: string): T {
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached while capturing ${property}`);
  let fiber = (element as unknown as Record<string, ReactFiber | undefined>)[fiberKey] ?? null;
  let captured: T | undefined;
  while (fiber) {
    const handler = fiber.memoizedProps?.[property];
    if (typeof handler === "function") captured = handler as T;
    fiber = fiber.return;
  }
  if (captured) return captured;
  throw new Error(`No ${property} handler was found`);
}

function trigger() {
  return screen.getByTestId("mode-switcher");
}

function menu() {
  return screen.getByRole("menu");
}

function radio(name: "Editing" | "Suggesting" | "Viewing") {
  return screen.getByRole("menuitemradio", { name: new RegExp(name) });
}

function openMenu() {
  fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return menu();
}

function captureOpenChange(): (open: boolean) => void {
  return captureFiberHandler(trigger(), "onOpenChange");
}

function captureModeChange(): (value: string) => void {
  return captureFiberHandler(radio("Editing"), "onValueChange");
}

function captureReaderSelect(): () => void {
  return captureFiberHandler(screen.getByTestId("mode-reader"), "onSelect");
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModeSwitcher visit authority", () => {
  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires an open same-document session before replacement layout with %s callbacks",
    (order) => {
      const sessionA = new ModeSession("shared-document", "owner", "editing");
      const sessionB = new ModeSession("shared-document", "owner", "editing");
      const host = document.createElement("div");
      const focusOwner = document.createElement("button");
      focusOwner.textContent = "Persistent focus owner";
      document.body.append(focusOwner, host);
      const root = createRoot(host);

      try {
        act(() => root.render(<ModeBoundary session={sessionA} />));
        openMenu();
        const staleOpenChange = captureOpenChange();
        const staleModeChange = captureModeChange();
        const staleReaderSelect = captureReaderSelect();
        let menuNodesAtBoundary = -1;

        act(() => {
          root.render(
            <ModeBoundary
              session={sessionB}
              boundary={1}
              onBoundary={() => {
                menuNodesAtBoundary = document.querySelectorAll('[role="menu"]').length;
                focusOwner.focus();
                staleOpenChange(true);
                staleModeChange("suggesting");
                staleReaderSelect();
              }}
            />,
          );
        });

        expect(menuNodesAtBoundary).toBe(0);
        expect(screen.queryByRole("menu")).toBeNull();
        expect(focusOwner).toHaveFocus();
        expect(sessionA.setMode).not.toHaveBeenCalled();
        expect(sessionB.setMode).not.toHaveBeenCalled();
        expect(window.open).not.toHaveBeenCalled();

        const currentOpenChange = captureOpenChange();
        act(() => {
          if (order === "stale-before-current") {
            staleOpenChange(true);
            currentOpenChange(true);
          } else {
            currentOpenChange(true);
            staleOpenChange(false);
          }
        });
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

        const currentModeChange = captureModeChange();
        const currentReaderSelect = captureReaderSelect();
        act(() => {
          if (order === "stale-before-current") {
            staleModeChange("suggesting");
            staleReaderSelect();
            currentModeChange("viewing");
            currentReaderSelect();
          } else {
            currentModeChange("viewing");
            currentReaderSelect();
            staleModeChange("suggesting");
            staleReaderSelect();
          }
        });

        expect(sessionA.setMode).not.toHaveBeenCalled();
        expect(sessionB.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
        expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/shared-document", "_blank", "noopener");
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

        act(() => {
          staleOpenChange(false);
          staleOpenChange(true);
        });
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

        act(() => {
          currentOpenChange(false);
          currentOpenChange(false);
          staleOpenChange(true);
        });
        expect(screen.queryByRole("menu")).toBeNull();

        act(() => {
          currentOpenChange(true);
          currentOpenChange(true);
        });
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
        expect(captureOpenChange()).toBe(currentOpenChange);
        expect(captureModeChange()).toBe(currentModeChange);
        expect(captureReaderSelect()).toBe(currentReaderSelect);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("retires removal before parent layout and leaves captured disclosure, mode, and reader callbacks inert", () => {
    const removed = new ModeSession("removed-document", "editor", "suggesting");
    const current = new ModeSession("current-document", "owner", "editing");
    const host = document.createElement("div");
    const focusOwner = document.createElement("button");
    focusOwner.textContent = "Removal focus owner";
    document.body.append(focusOwner, host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={removed} />));
      openMenu();
      const staleOpenChange = captureOpenChange();
      const staleModeChange = captureModeChange();
      const staleReaderSelect = captureReaderSelect();
      let retiredAtBoundary = false;

      act(() => {
        root.render(
          <ModeBoundary
            session={removed}
            present={false}
            boundary={1}
            onBoundary={() => {
              retiredAtBoundary = true;
              focusOwner.focus();
              staleOpenChange(true);
              staleModeChange("viewing");
              staleReaderSelect();
            }}
          />,
        );
      });

      expect(retiredAtBoundary).toBe(true);
      expect(screen.queryByTestId("mode-switcher")).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(focusOwner).toHaveFocus();
      expect(removed.setMode).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();

      act(() => root.render(<ModeBoundary session={current} boundary={2} />));
      expect(screen.queryByRole("menu")).toBeNull();
      const currentOpenChange = captureOpenChange();
      act(() => {
        currentOpenChange(true);
        staleOpenChange(false);
        staleOpenChange(true);
      });
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

      const currentModeChange = captureModeChange();
      const currentReaderSelect = captureReaderSelect();
      act(() => {
        currentModeChange("suggesting");
        staleModeChange("editing");
        currentReaderSelect();
        staleReaderSelect();
      });
      expect(removed.setMode).not.toHaveBeenCalled();
      expect(current.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
      expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/current-document", "_blank", "noopener");
    } finally {
      act(() => root.unmount());
    }
  });

  it("replaces an open owner visit with a closed viewer visit whose disabled choices stay inert", () => {
    const owner = new ModeSession("owner-document", "owner", "editing");
    const viewer = new ModeSession("viewer-document", "viewer", "viewing");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      act(() => root.render(<ModeBoundary session={owner} />));
      openMenu();
      const staleOpenChange = captureOpenChange();
      const staleModeChange = captureModeChange();
      const staleReaderSelect = captureReaderSelect();
      let menuNodesAtBoundary = -1;

      act(() => {
        root.render(
          <ModeBoundary
            session={viewer}
            boundary={1}
            onBoundary={() => {
              menuNodesAtBoundary = document.querySelectorAll('[role="menu"]').length;
              staleOpenChange(true);
              staleModeChange("suggesting");
              staleReaderSelect();
            }}
          />,
        );
      });

      expect(menuNodesAtBoundary).toBe(0);
      expect(screen.queryByRole("menu")).toBeNull();
      openMenu();
      expect(radio("Editing")).toHaveAttribute("aria-disabled", "true");
      expect(radio("Suggesting")).toHaveAttribute("aria-disabled", "true");
      expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");

      const changeMode = captureModeChange();
      act(() => {
        changeMode("unknown");
        changeMode("editing");
        changeMode("suggesting");
      });
      expect(owner.setMode).not.toHaveBeenCalled();
      expect(viewer.setMode).not.toHaveBeenCalled();

      act(() => changeMode("viewing"));
      expect(viewer.setMode).toHaveBeenCalledExactlyOnceWith("viewing");
      expect(window.open).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("ModeSwitcher current behavior", () => {
  it.each([
    ["owner", "editing"],
    ["owner", "suggesting"],
    ["owner", "viewing"],
    ["editor", "editing"],
    ["editor", "suggesting"],
    ["editor", "viewing"],
    ["commenter", "viewing"],
    ["viewer", "viewing"],
  ] as const)("lets a current %s choose %s exactly once", (role, choice) => {
    const session = new ModeSession(`${role}-${choice}`, role, choice === "editing" ? "viewing" : "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    const changeMode = captureModeChange();
    act(() => changeMode(choice));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith(choice);
  });

  it.each(["commenter", "viewer"] as const)(
    "rejects unknown and disabled editing modes for a current %s",
    (role) => {
      const session = new ModeSession(`${role}-disabled`, role, "viewing");
      render(<ModeSwitcher session={session.asCollabSession()} />);
      openMenu();
      const changeMode = captureModeChange();

      act(() => {
        changeMode("arbitrary");
        changeMode("editing");
        changeMode("suggesting");
      });

      expect(session.setMode).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "editor"] as const)("keeps Editing and Suggesting enabled for a current %s", (role) => {
    const session = new ModeSession(`${role}-permissions`, role, "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    expect(radio("Editing")).not.toHaveAttribute("aria-disabled");
    expect(radio("Suggesting")).not.toHaveAttribute("aria-disabled");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");
  });

  it("preserves labels, descriptions, styling, alignment, icons, and live session mode updates", () => {
    const session = new ModeSession("live-mode", "owner", "suggesting");
    render(<ModeSwitcher session={session.asCollabSession()} />);

    expect(trigger()).toHaveTextContent("Suggesting");
    expect(trigger()).toHaveClass("border-green-200", "bg-green-50", "text-green-800");
    expect(trigger().querySelector(".lucide-message-square-plus")).not.toBeNull();
    openMenu();

    const content = menu();
    expect(content).toHaveClass("w-64");
    expect(content).toHaveAttribute("data-align", "end");
    expect(radio("Editing")).toHaveTextContent("Edit the document directly");
    expect(radio("Suggesting")).toHaveTextContent("Edits become suggestions others can accept");
    expect(radio("Viewing")).toHaveTextContent("Read or print the final document");
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mode-reader")).toHaveTextContent("Open reader view");

    act(() => session.setExternalMode("editing"));

    expect(trigger()).toHaveTextContent("Editing");
    expect(trigger()).toHaveClass("border-line-2", "bg-surface", "text-ink-2");
    expect(trigger()).not.toHaveClass("border-green-200");
    expect(trigger().querySelector(".lucide-pen-line")).not.toBeNull();
    expect(radio("Editing")).toHaveAttribute("aria-checked", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-checked", "false");
  });

  it("opens the current reader exactly once with the current document", () => {
    const session = new ModeSession("reader-current", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    act(() => captureReaderSelect()());

    expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/reader-current", "_blank", "noopener");
  });

  it("preserves keyboard selection, Escape and outside close, and trigger focus return", async () => {
    const session = new ModeSession("keyboard-current", "editor", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside control</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside control" });
    modeTrigger.focus();

    fireEvent.keyDown(modeTrigger, { key: "ArrowDown" });
    await waitFor(() => expect(radio("Editing")).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Suggesting")).toHaveFocus();
    await userEvent.keyboard("{Enter}");

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    fireEvent.keyDown(radio("Suggesting"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    fireEvent.pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps one controlled menu through duplicate current open and close notifications", () => {
    const session = new ModeSession("single-disclosure", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const changeOpen = captureOpenChange();

    act(() => {
      changeOpen(true);
      changeOpen(true);
    });
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(captureOpenChange()).toBe(changeOpen);

    act(() => {
      changeOpen(false);
      changeOpen(false);
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
