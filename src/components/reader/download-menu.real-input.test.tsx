// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadMenu } from "./download-menu";

const DOC_ID = "doc-7";
const href = (format: string) => `/api/documents/${DOC_ID}/export?format=${format}&download=1`;

afterEach(cleanup);

function elements() {
  return {
    primary: screen.getByTestId("reader-download"),
    toggle: screen.getByTestId("reader-download-menu"),
    list: screen.getByTestId("reader-download-list"),
    md: screen.getByTestId("reader-download-md"),
    html: screen.getByTestId("reader-download-html"),
    pdf: screen.getByTestId("reader-download-pdf"),
  };
}

describe("DownloadMenu real input", () => {
  it("renders the split button and disclosure relationships", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { primary, toggle, list, md, html, pdf } = elements();
    expect(primary).toHaveAttribute("href", href("md"));
    expect(primary).toHaveAccessibleName("Download Markdown");
    expect(toggle).toHaveAccessibleName("Download as…");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reader-download-list");
    expect(list).toHaveAttribute("id", "reader-download-list");
    expect(list).not.toBeVisible();
    expect([md, html, pdf].map((a) => a.getAttribute("href"))).toEqual([href("md"), href("html"), href("pdf")]);
  });

  it("opens on a synthetic click, focuses the first link, and closes on a second click", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, md } = elements();
    fireEvent.click(toggle);
    expect(list).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(md).toHaveFocus();
    fireEvent.click(toggle);
    expect(list).not.toBeVisible();
  });

  it("opens with ArrowDown/ArrowUp and navigates links with wrapping", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, md, html, pdf } = elements();
    expect(fireEvent.keyDown(toggle, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(toggle, { key: "ArrowUp" })).toBe(false);
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(pdf, { key: "ArrowDown" });
    expect(md).toHaveFocus();
    fireEvent.keyDown(md, { key: "ArrowDown" });
    expect(html).toHaveFocus();
    fireEvent.keyDown(html, { key: "End" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(pdf, { key: "Home" });
    expect(md).toHaveFocus();
    fireEvent.keyDown(md, { key: "ArrowUp" });
    expect(pdf).toHaveFocus();
    expect(fireEvent.keyDown(pdf, { key: "ArrowDown", ctrlKey: true })).toBe(true);
    expect(pdf).toHaveFocus();
  });

  it("closes on Escape and returns focus to the toggle", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, html } = elements();
    fireEvent.click(toggle);
    html.focus();
    expect(fireEvent.keyDown(html, { key: "Escape" })).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it("closes and refocuses the toggle when a link is activated, without blocking the download", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, pdf } = elements();
    fireEvent.click(toggle);
    let prevented = true;
    document.addEventListener("click", (e) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    }, { once: true });
    fireEvent.click(pdf);
    expect(prevented).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it("closes on outside pointer down and on blur to an outside element, but not inside", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const outside = document.createElement("button");
    document.body.append(outside);
    const { toggle, list, md, html } = elements();
    fireEvent.click(toggle);
    fireEvent.pointerDown(html);
    fireEvent.blur(md, { relatedTarget: html });
    fireEvent.blur(md, { relatedTarget: null });
    expect(list).toBeVisible();
    fireEvent.blur(md, { relatedTarget: outside });
    expect(list).not.toBeVisible();
    fireEvent.click(toggle);
    fireEvent.pointerDown(outside);
    expect(list).not.toBeVisible();
    outside.remove();
  });

  it("works end-to-end with userEvent keyboard input", async () => {
    const user = userEvent.setup();
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, html } = elements();
    await user.click(toggle);
    expect(list).toBeVisible();
    await user.keyboard("{ArrowDown}");
    expect(html).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });
});
