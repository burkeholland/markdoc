// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_FONT, PREVIEW_FONT_STORAGE_KEY, readPreviewFont } from "@/lib/preview-font";
import { PreviewFontSelect } from "./preview-font-select";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the preview font menu", () => {
  it("is an Aa button; the default is checked and nothing is stored until a choice is made", async () => {
    const user = userEvent.setup();
    render(<PreviewFontSelect />);
    const trigger = screen.getByRole("button", { name: "Preview font" });
    expect(trigger.textContent).toBe("Aa");
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: /Instrument Sans/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Sans · Inter/ }).getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBeNull();
  });

  it("shows each option in its own face with a description", async () => {
    const user = userEvent.setup();
    render(<PreviewFontSelect />);
    await user.click(screen.getByRole("button", { name: "Preview font" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    const serif = screen.getByTestId("preview-font-source-serif");
    expect(serif.textContent).toContain("Book-like, made for long reading");
    expect((serif.querySelector("span[style]") as HTMLElement).style.fontFamily).toContain("--font-source-serif");
  });

  it("works from the keyboard and stores the choice", async () => {
    const user = userEvent.setup();
    render(<PreviewFontSelect />);
    screen.getByRole("button", { name: "Preview font" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBe("source-serif");
    expect(readPreviewFont()).toBe("source-serif");
  });

  it("falls back to the default for an unknown stored value", () => {
    localStorage.setItem(PREVIEW_FONT_STORAGE_KEY, "comic-sans");
    expect(readPreviewFont()).toBe(DEFAULT_PREVIEW_FONT);
  });
});
