// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";
import type { Command } from "./commands";

// Regression for #2233: user-event dispatches untrusted synthetic events, which the old
// authenticity gates silently dropped. Every interaction here must take effect.

function command(id: string, title: string, run: Command["run"] = vi.fn()): Command {
  return { id, title, keywords: [], group: "Test", run };
}

function Palette({ items }: { items: Command[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} commands={() => items} />
    </>
  );
}

const input = () => screen.getByTestId("palette-input");
const selected = () => input().getAttribute("aria-activedescendant");

beforeEach(() => {
  window.localStorage?.clear?.();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

async function openPalette(items: Command[]) {
  const user = userEvent.setup();
  render(<Palette items={items} />);
  await user.click(screen.getByText("Open palette"));
  await waitFor(() => expect(document.activeElement).toBe(input()));
  return user;
}

describe("CommandPalette real input", () => {
  it("honors typing, paste, arrows, Home/End and Enter", async () => {
    const run = vi.fn();
    const user = await openPalette([command("alpha", "Alpha"), command("beta", "Beta", run), command("gamma", "Gamma")]);
    await user.keyboard("{ArrowDown}");
    expect(selected()).toBe("palette-item-beta");
    await user.keyboard("{End}");
    expect(selected()).toBe("palette-item-gamma");
    await user.keyboard("{Home}");
    expect(selected()).toBe("palette-item-alpha");
    await user.type(input(), "gam");
    expect(input()).toHaveProperty("value", "gam");
    expect(screen.queryByTestId("palette-item-alpha")).toBeNull();
    await user.clear(input());
    await user.paste("Bet");
    expect(input()).toHaveProperty("value", "Bet");
    expect(selected()).toBe("palette-item-beta");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(screen.getByText("Open palette"));
  });

  it("honors hover and click on results, Back, Backspace and Retry in a child list", async () => {
    const childRun = vi.fn();
    let fail = true;
    const templates: Command = {
      ...command("templates", "Templates…"),
      children: async () => {
        if (fail) {
          fail = false;
          throw new Error("Network down");
        }
        return [command("meeting", "Meeting notes", childRun), command("todo", "Todo list")];
      },
    };
    const user = await openPalette([command("alpha", "Alpha"), templates]);
    await user.hover(screen.getByTestId("palette-item-templates"));
    expect(selected()).toBe("palette-item-templates");
    await user.click(screen.getByTestId("palette-item-templates"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("palette-item-meeting");

    await user.click(screen.getByTestId("palette-back"));
    expect(screen.getByTestId("palette-item-alpha")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    await screen.findByTestId("palette-item-meeting");
    await user.keyboard("{Backspace}");
    expect(screen.getByTestId("palette-item-alpha")).toBeTruthy();

    await user.click(screen.getByTestId("palette-item-templates"));
    await user.type(await screen.findByPlaceholderText("Filter…"), "meet");
    await user.click(screen.getByTestId("palette-item-meeting"));
    await waitFor(() => expect(childRun).toHaveBeenCalledTimes(1));
  });
});
