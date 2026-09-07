// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReaderToc } from "./toc";

const headings = [
  { id: "overview", level: 2, text: "Overview" },
  { id: "details", level: 3, text: "Details" },
];

afterEach(cleanup);

describe("ReaderToc mobile disclosure", () => {
  it("closes on Escape and returns focus to the Contents button", () => {
    render(<ReaderToc headings={headings} />);
    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    const firstLink = screen.getByRole("link", { name: "Overview" });
    firstLink.focus();

    fireEvent.keyDown(firstLink, { key: "Escape" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("list")).toHaveClass("hidden");
  });

  it("keeps heading links in native Tab order with unchanged hrefs and closes when one is clicked", () => {
    render(<ReaderToc headings={headings} />);
    const toggle = screen.getByRole("button", { name: "Contents" });
    fireEvent.click(toggle);
    const links = screen.getAllByRole("link");

    expect(links.map((link) => link.getAttribute("href"))).toEqual(["#overview", "#details"]);
    expect(links.every((link) => !link.hasAttribute("role") && !link.hasAttribute("tabindex"))).toBe(true);
    fireEvent.click(links[1]);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("list")).toHaveClass("hidden");
  });
});
