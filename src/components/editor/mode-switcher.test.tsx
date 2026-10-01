// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession, EditMode } from "@/editor/collab/session";
import { ModeSwitcher } from "./header";

type ModeRole = "owner" | "editor" | "commenter" | "viewer";
type ModeName = "Editing" | "Suggesting" | "Viewing";

class ModeSession {
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    public docId: string,
    public role: ModeRole,
    public mode: EditMode,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setMode = vi.fn((mode: EditMode) => {
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

const LABELS: Record<EditMode, ModeName> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };

function trigger(): HTMLButtonElement {
  return screen.getByTestId("mode-switcher") as HTMLButtonElement;
}

function menu() {
  return screen.getByRole("menu");
}

function radio(name: ModeName) {
  return screen.getByRole("menuitemradio", { name: new RegExp(name) });
}

function pointerDown(element: Element, init: PointerEventInit = {}) {
  fireEvent(element, new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
    ...init,
  }));
}

function openMenu() {
  pointerDown(trigger());
  return menu();
}

async function waitForOutsideListener() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModeSwitcher", () => {
  it.each([
    ["owner", "editing"],
    ["owner", "suggesting"],
    ["owner", "viewing"],
    ["editor", "editing"],
    ["editor", "suggesting"],
    ["editor", "viewing"],
    ["commenter", "viewing"],
    ["viewer", "viewing"],
  ] as const)("lets a %s choose %s once and closes the menu", async (role, choice) => {
    const session = new ModeSession(`${role}-${choice}`, role, choice === "editing" ? "viewing" : "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    openMenu();

    fireEvent.click(radio(LABELS[choice]));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith(choice);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(modeTrigger).toHaveAttribute("data-state", "closed");
    expect(modeTrigger).toHaveTextContent(LABELS[choice]);
    await waitFor(() => expect(modeTrigger).toHaveFocus());
  });

  it.each(["commenter", "viewer"] as const)("disables Editing and Suggesting for a %s", (role) => {
    const session = new ModeSession(`${role}-disabled`, role, "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    expect(radio("Editing")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Suggesting")).toHaveAttribute("aria-disabled", "true");
    expect(radio("Viewing")).not.toHaveAttribute("aria-disabled");

    fireEvent.click(radio("Editing"));
    fireEvent.click(radio("Suggesting"));

    expect(session.setMode).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();
  });

  it.each(["owner", "editor"] as const)("keeps every mode enabled for a %s", (role) => {
    const session = new ModeSession(`${role}-permissions`, role, "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    for (const name of ["Editing", "Suggesting", "Viewing"] as const) {
      expect(radio(name)).not.toHaveAttribute("aria-disabled");
    }
  });

  it("shows labels, descriptions, styling, icons, and live session mode updates", () => {
    const session = new ModeSession("live-mode", "owner", "suggesting");
    render(<ModeSwitcher session={session.asCollabSession()} />);

    expect(trigger()).toHaveTextContent("Suggesting");
    expect(trigger()).toHaveClass("border-green-200", "bg-green-50", "text-green-800");
    expect(trigger().querySelector(".lucide-message-square-plus")).not.toBeNull();
    openMenu();

    const content = menu();
    expect(content).toHaveClass("w-64");
    expect(content).toHaveAttribute("data-align", "end");
    expect(screen.getAllByRole("menuitemradio").map((row) => row.textContent?.replace(/^✓/, ""))).toEqual([
      "EditingEdit the document directly",
      "SuggestingEdits become suggestions others can accept",
      "ViewingRead or print the final document",
    ]);
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

  it("opens the reader view once for the current document and closes the menu", async () => {
    const session = new ModeSession("reader-current", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    openMenu();

    fireEvent.click(screen.getByTestId("mode-reader"));

    expect(window.open).toHaveBeenCalledExactlyOnceWith("/p/reader-current", "_blank", "noopener");
    expect(session.setMode).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(modeTrigger).toHaveFocus());
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ] as const)("picks Suggesting with arrows and %s, then returns focus to the trigger", async (_name, key) => {
    const session = new ModeSession(`keyboard-${_name}`, "editor", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();

    fireEvent.keyDown(modeTrigger, { key: "ArrowDown" });
    await waitFor(() => expect(radio("Editing")).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Suggesting")).toHaveFocus();
    await userEvent.keyboard(key);

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());
    expect(modeTrigger).toHaveTextContent("Suggesting");
  });

  it("opens from the keyboard with Enter and Space on the trigger", () => {
    const session = new ModeSession("keyboard-open", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();

    fireEvent.keyDown(modeTrigger, { key: "Enter" });
    expect(menu()).toBeInTheDocument();
    fireEvent.keyDown(radio("Editing"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.keyDown(modeTrigger, { key: " " });
    expect(menu()).toBeInTheDocument();
  });

  it.each([
    ["owner", "Editing"],
    ["viewer", "Viewing"],
  ] as const)("opens with ArrowUp for a %s, focuses %s and keeps the page from scrolling", async (role, focused) => {
    const session = new ModeSession(`arrow-up-${role}`, role, "viewing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    modeTrigger.focus();
    const prevented: boolean[] = [];
    const recordArrowUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") prevented.push(event.defaultPrevented);
    };
    document.addEventListener("keydown", recordArrowUp);

    await userEvent.keyboard("{ArrowUp}");

    expect(menu()).toBeInTheDocument();
    expect(modeTrigger).toHaveAttribute("data-state", "open");
    await waitFor(() => expect(radio(focused)).toHaveFocus());
    expect(prevented).toEqual([true]);
    expect(session.setMode).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());
    document.removeEventListener("keydown", recordArrowUp);
  });

  it("closes on Escape and on outside clicks, returning focus only after Escape or a plain click", async () => {
    const session = new ModeSession("close-current", "editor", "editing");
    render(
      <>
        <ModeSwitcher session={session.asCollabSession()} />
        <button type="button">Outside control</button>
      </>,
    );
    const modeTrigger = trigger();
    const outside = screen.getByRole("button", { name: "Outside control" });
    modeTrigger.focus();

    openMenu();
    fireEvent.keyDown(radio("Editing"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    await waitForOutsideListener();
    pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    menu().focus();
    await waitForOutsideListener();
    pointerDown(outside, { button: 2 });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(modeTrigger).not.toHaveFocus();

    await userEvent.click(modeTrigger);
    await waitFor(() => expect(menu()).toBeInTheDocument());
    menu().focus();
    await waitForOutsideListener();
    pointerDown(outside, { ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(modeTrigger).not.toHaveFocus();
    expect(session.setMode).not.toHaveBeenCalled();
  });

  it("toggles closed when the trigger is pressed again", async () => {
    const session = new ModeSession("trigger-toggle", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    const modeTrigger = trigger();
    openMenu();

    pointerDown(modeTrigger);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(modeTrigger).toHaveFocus());
    expect(session.setMode).not.toHaveBeenCalled();
  });

  it.each(["editing", "suggesting", "viewing"] as const)(
    "chooses %s once under Strict Mode",
    async (choice) => {
      const session = new ModeSession(`strict-${choice}`, "owner", choice === "viewing" ? "editing" : "viewing");
      render(
        <StrictMode>
          <ModeSwitcher session={session.asCollabSession()} />
        </StrictMode>,
      );
      const modeTrigger = trigger();
      modeTrigger.focus();
      openMenu();
      expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);

      fireEvent.click(radio(LABELS[choice]));

      expect(session.setMode).toHaveBeenCalledExactlyOnceWith(choice);
      expect(screen.queryByRole("menu")).toBeNull();
      await waitFor(() => expect(modeTrigger).toHaveFocus());
    },
  );

  it("still accepts a pick after unrelated DOM changes next to the menu", () => {
    const session = new ModeSession("busy-dom", "owner", "editing");
    render(<ModeSwitcher session={session.asCollabSession()} />);
    openMenu();

    act(() => {
      document.body.prepend(document.createElement("span"));
      document.body.append(document.createElement("div"));
      menu().setAttribute("data-side", "top");
    });
    fireEvent.click(radio("Suggesting"));

    expect(session.setMode).toHaveBeenCalledExactlyOnceWith("suggesting");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
