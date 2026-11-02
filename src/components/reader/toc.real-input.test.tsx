// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReaderToc } from "./toc";

const HEADINGS = [
  { id: "intro", level: 2, text: "Intro" },
  { id: "details", level: 3, text: "Details" },
  { id: "outro", level: 2, text: "Outro" },
];

afterEach(cleanup);

function setup() {
  const view = render(
    <>
      {HEADINGS.map((h) => <h2 key={h.id} id={h.id}>{h.text}</h2>)}
      <ReaderToc headings={HEADINGS} />
    </>,
  );
  const toggle = screen.getByTestId("reader-toc-toggle");
  const entries = screen.getAllByTestId("reader-toc-entry");
  const list = view.container.querySelector("#reader-toc-list")!;
  return { toggle, entries, list };
}

describe("ReaderToc real input", () => {
  it("renders entries with fragment hrefs, indent and an initial current entry", () => {
    const { toggle, entries } = setup();
    expect(entries.map((e) => e.getAttribute("href"))).toEqual(["#intro", "#details", "#outro"]);
    expect(entries[1]).toHaveClass("pl-5");
    // jsdom lays every heading out at top 0, i.e. scrolled past, so the last one is current.
    expect(entries[2]).toHaveAttribute("aria-current", "location");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reader-toc-list");
  });

  it("bounds the desktop contents list and lets it scroll independently", () => {
    const { list } = setup();

    expect(list).toHaveClass(
      "lg:max-h-[calc(100dvh-8rem)]",
      "lg:overflow-y-auto",
      "lg:overscroll-contain",
    );
  });

  it("toggles the disclosure on a synthetic click", () => {
    const { toggle, list } = setup();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list).toHaveClass("flex");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(list).toHaveClass("hidden");
  });

  it("closes when an entry is clicked without blocking navigation", () => {
    const { toggle, entries } = setup();
    fireEvent.click(toggle);
    expect(fireEvent.click(entries[2]!)).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("navigates entries with arrows/Home/End and closes on Escape with focus return", () => {
    const { toggle, entries } = setup();
    fireEvent.click(toggle);
    toggle.focus();
    expect(fireEvent.keyDown(toggle, { key: "ArrowDown" })).toBe(false);
    expect(entries[2]).toHaveFocus();
    fireEvent.keyDown(entries[2]!, { key: "Home" });
    expect(entries[0]).toHaveFocus();
    fireEvent.keyDown(entries[0]!, { key: "ArrowDown" });
    expect(entries[1]).toHaveFocus();
    fireEvent.keyDown(entries[1]!, { key: "End" });
    expect(entries[2]).toHaveFocus();
    fireEvent.keyDown(entries[2]!, { key: "ArrowDown" });
    expect(entries[0]).toHaveFocus();
    fireEvent.keyDown(entries[0]!, { key: "ArrowUp" });
    expect(entries[2]).toHaveFocus();
    fireEvent.keyDown(entries[2]!, { key: "Home" });
    expect(entries[0]).toHaveFocus();
    expect(fireEvent.keyDown(entries[0]!, { key: "Escape" })).toBe(false);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("leaves keys native while closed", () => {
    const { toggle } = setup();
    toggle.focus();
    expect(fireEvent.keyDown(toggle, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(toggle, { key: "Escape" })).toBe(true);
  });
});
