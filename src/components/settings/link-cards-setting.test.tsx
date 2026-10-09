// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { LINK_CARDS_STORAGE_KEY } from "@/lib/link-cards-setting";
import { LinkCardsSetting } from "./link-cards-setting";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the Settings row for link cards (#2317)", () => {
  it("is a switch named by its heading, described by its sentence, on by default", () => {
    render(<LinkCardsSetting />);
    const toggle = screen.getByRole("switch", { name: "Turn links to known sites into cards" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Turn links to known sites into cards" })).toBeTruthy();
    const description = document.getElementById(toggle.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toBe(
      'A link to YouTube or X that you paste on an empty line becomes a card that shows the video or post. Off: it stays a link. Cards already in a document stay, and the toolbar button "Video or post from a link" can still add one. The choice is saved in this browser.',
    );
    // Nothing is written until the person chooses.
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBeNull();
  });

  it("a click, Space and Enter each turn it, and the choice is stored", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <LinkCardsSetting />
      </StrictMode>,
    );
    const toggle = screen.getByRole("switch");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBe("off");
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBe("on");
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBe("off");
  });

  it("shows what this browser stored before", () => {
    localStorage.setItem(LINK_CARDS_STORAGE_KEY, "off");
    render(<LinkCardsSetting />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
});
