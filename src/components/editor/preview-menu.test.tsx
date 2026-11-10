// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_FONT, PREVIEW_FONT_STORAGE_KEY, readPreviewFont } from "@/lib/preview-font";
import { PREVIEW_CODE_WRAP_STORAGE_KEY } from "@/lib/preview-code-wrap";
import { PreviewMenu } from "./preview-menu";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

describe("the preview menu", () => {
  it("contains one global wrap setting and font choices without storing anything initially", async () => {
    const user = userEvent.setup();
    render(<PreviewMenu />);
    const trigger = screen.getByRole("button", { name: "Preview settings" });
    expect(trigger.textContent).toBe("View");
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: /Instrument Sans/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /^Inter$/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Wrap code blocks" }).getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBeNull();
  });

  it("shows each font in its own face without extra descriptive text", async () => {
    const user = userEvent.setup();
    render(<PreviewMenu />);
    await user.click(screen.getByRole("button", { name: "Preview settings" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);
    const serif = screen.getByTestId("preview-font-source-serif");
    expect(serif.textContent).toBe("Source Serif 4");
    expect((serif.querySelector("span[style]") as HTMLElement).style.fontFamily).toContain("--font-source-serif");
  });

  it("works from the keyboard and stores the choice", async () => {
    const user = userEvent.setup();
    render(<PreviewMenu />);
    screen.getByRole("button", { name: "Preview settings" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBe("source-serif");
    expect(readPreviewFont()).toBe("source-serif");
  });

  it("toggles wrapping with the keyboard and restores focus to the sticky menu trigger", async () => {
    const user = userEvent.setup();
    render(<PreviewMenu />);
    const trigger = screen.getByRole("button", { name: "Preview settings" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Wrap code blocks" })).toHaveFocus();
    await user.keyboard(" ");
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBe("on");
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Wrap code blocks" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Enter}");
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBe("off");
    expect(trigger).toHaveFocus();
  });

  it("falls back to the default for an unknown stored value", () => {
    localStorage.setItem(PREVIEW_FONT_STORAGE_KEY, "comic-sans");
    expect(readPreviewFont()).toBe(DEFAULT_PREVIEW_FONT);
  });
});
