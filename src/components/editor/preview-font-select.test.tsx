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

describe("the preview font dropdown", () => {
  it("defaults to Instrument Sans and writes nothing until a choice is made", () => {
    render(<PreviewFontSelect />);
    expect((screen.getByRole("combobox", { name: "Preview font" }) as HTMLSelectElement).value).toBe("instrument-sans");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBeNull();
    expect(readPreviewFont()).toBe(DEFAULT_PREVIEW_FONT);
  });

  it("offers the four faces and stores the choice", async () => {
    render(<PreviewFontSelect />);
    const select = screen.getByRole("combobox", { name: "Preview font" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Instrument Sans", "Inter", "Source Serif 4", "IBM Plex Mono"]);
    await userEvent.setup().selectOptions(select, "source-serif");
    expect(select.value).toBe("source-serif");
    expect(localStorage.getItem(PREVIEW_FONT_STORAGE_KEY)).toBe("source-serif");
    expect(readPreviewFont()).toBe("source-serif");
  });

  it("falls back to the default for an unknown stored value", () => {
    localStorage.setItem(PREVIEW_FONT_STORAGE_KEY, "comic-sans");
    expect(readPreviewFont()).toBe(DEFAULT_PREVIEW_FONT);
  });
});
