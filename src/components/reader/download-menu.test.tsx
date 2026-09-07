// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DownloadMenu } from "./download-menu";

const DOC_ID = "doc-919";
const downloadHref = (format: "md" | "html" | "pdf") => `/api/documents/${DOC_ID}/export?format=${format}&download=1`;

afterEach(cleanup);

describe("DownloadMenu", () => {
  it("renders the primary Markdown download as a native link", () => {
    render(<DownloadMenu docId={DOC_ID} />);

    const download = screen.getByRole("link", { name: "Download Markdown" });
    expect(download).toHaveAttribute("href", downloadHref("md"));
    expect(download).toHaveClass("btn", "btn-sm", "btn-outline", "reader-split-main", "gap-1.5");
    expect(within(download).getByText("Download")).toHaveClass("hidden", "sm:inline");
    expect(download).toHaveAccessibleName("Download Markdown");
    expect(screen.queryByRole("button", { name: "Download Markdown" })).not.toBeInTheDocument();

    for (const event of [
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    ]) {
      let preventedBeforeBrowserDefault = true;
      document.addEventListener(
        event.type,
        (observed) => {
          preventedBeforeBrowserDefault = observed.defaultPrevented;
          observed.preventDefault();
        },
        { once: true },
      );
      fireEvent(download, event);
      expect(preventedBeforeBrowserDefault).toBe(false);
    }
  });

  it("keeps the disclosure routes, opening focus, and link activation behavior", async () => {
    render(<DownloadMenu docId={DOC_ID} />);

    const toggle = screen.getByRole("button", { name: "Download as…" });
    const list = screen.getByTestId("reader-download-list");
    expect(list).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reader-download-list");
    expect(toggle).not.toHaveAttribute("aria-haspopup");

    fireEvent.click(toggle);

    const markdown = screen.getByTestId("reader-download-md");
    const html = screen.getByTestId("reader-download-html");
    const pdf = screen.getByTestId("reader-download-pdf");
    expect(list).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(markdown).toHaveAttribute("href", downloadHref("md"));
    expect(html).toHaveAttribute("href", downloadHref("html"));
    expect(pdf).toHaveAttribute("href", downloadHref("pdf"));
    await waitFor(() => expect(markdown).toHaveFocus());

    let preventedBeforeBrowserDefault = true;
    document.addEventListener(
      "click",
      (event) => {
        preventedBeforeBrowserDefault = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    fireEvent.click(html);
    expect(preventedBeforeBrowserDefault).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it("preserves arrow, Home, End, and Escape keyboard behavior", async () => {
    render(<DownloadMenu docId={DOC_ID} />);

    const toggle = screen.getByRole("button", { name: "Download as…" });
    const list = screen.getByTestId("reader-download-list");
    fireEvent.keyDown(toggle, { key: "ArrowDown" });

    const markdown = screen.getByTestId("reader-download-md");
    const html = screen.getByTestId("reader-download-html");
    const pdf = screen.getByTestId("reader-download-pdf");
    await waitFor(() => expect(markdown).toHaveFocus());

    fireEvent.keyDown(markdown, { key: "ArrowDown" });
    expect(html).toHaveFocus();
    fireEvent.keyDown(html, { key: "End" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(pdf, { key: "ArrowDown" });
    expect(markdown).toHaveFocus();
    fireEvent.keyDown(markdown, { key: "ArrowUp" });
    expect(pdf).toHaveFocus();
    fireEvent.keyDown(pdf, { key: "Home" });
    expect(markdown).toHaveFocus();

    fireEvent.keyDown(markdown, { key: "Escape" });
    expect(list).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it("closes when focus or a pointer moves outside", async () => {
    render(
      <>
        <DownloadMenu docId={DOC_ID} />
        <button type="button">Outside</button>
      </>,
    );

    const toggle = screen.getByRole("button", { name: "Download as…" });
    const outside = screen.getByRole("button", { name: "Outside" });
    const list = screen.getByTestId("reader-download-list");

    fireEvent.click(toggle);
    const markdown = screen.getByTestId("reader-download-md");
    await waitFor(() => expect(markdown).toHaveFocus());
    fireEvent.blur(markdown, { relatedTarget: outside });
    expect(list).not.toBeVisible();

    fireEvent.click(toggle);
    expect(list).toBeVisible();
    fireEvent.pointerDown(outside);
    expect(list).not.toBeVisible();
  });
});
