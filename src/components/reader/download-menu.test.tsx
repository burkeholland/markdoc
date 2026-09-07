// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { DownloadMenu } from "./download-menu";

const DOC_ID = "doc-919";
const downloadHref = (format: "md" | "html" | "pdf") => `/api/documents/${DOC_ID}/export?format=${format}&download=1`;

function BoundaryHarness({
  docId,
  present = true,
  boundary,
  onBoundary,
}: {
  docId: string;
  present?: boolean;
  boundary: number;
  onBoundary: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary();
  }, [boundary, onBoundary]);
  return present ? <DownloadMenu docId={docId} /> : null;
}

function trackPointerListeners() {
  const active = new Set<EventListenerOrEventListenerObject>();
  const captured: EventListener[] = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown") {
      active.add(listener);
      if (typeof listener === "function") captured.push(listener);
    }
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown") active.delete(listener);
    remove(type, listener, options);
  });
  return { active, captured };
}

function captureClick(element: HTMLElement) {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error("React props were not attached to the download link");
  const props = (element as unknown as Record<string, { onClick?: () => void } | undefined>)[propsKey];
  if (!props?.onClick) throw new Error("The download link did not have an onClick handler");
  return props.onClick;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("retires a changed document before the parent layout boundary and ignores its captured callbacks", () => {
    const pointers = trackPointerListeners();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const boundaryListeners: number[] = [];
    const onBoundary = () => boundaryListeners.push(pointers.active.size);
    const view = render(<BoundaryHarness docId="doc-a" boundary={0} onBoundary={onBoundary} />);

    fireEvent.click(screen.getByRole("button", { name: "Download as…" }));
    const oldPointer = pointers.captured.at(-1);
    const oldCloseAndFocus = captureClick(screen.getByTestId("reader-download-md"));
    expect(oldPointer).toBeDefined();
    expect(pointers.active.size).toBe(1);

    view.rerender(<BoundaryHarness docId="doc-b" boundary={1} onBoundary={onBoundary} />);

    expect(boundaryListeners).toEqual([0]);
    expect(screen.getByTestId("reader-download-list")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Download as…" })).toHaveAttribute("aria-expanded", "false");
    for (const format of ["md", "html", "pdf"] as const) {
      const links = screen.getAllByTestId(`reader-download-${format}`);
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", `/api/documents/doc-b/export?format=${format}&download=1`);
    }
    expect(pointers.active.size).toBe(0);

    focus.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Download as…" }));
    const currentMarkdown = screen.getByTestId("reader-download-md");
    expect(currentMarkdown).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(pointers.active.size).toBe(1);

    act(() => {
      oldPointer?.(new Event("pointerdown"));
      oldCloseAndFocus();
    });
    expect(screen.getByTestId("reader-download-list")).toBeVisible();
    expect(currentMarkdown).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(pointers.active.size).toBe(1);
  });

  it("retires listeners on removal and keeps a remounted document usable across reopen", () => {
    const pointers = trackPointerListeners();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const boundaryListeners: number[] = [];
    const onBoundary = () => boundaryListeners.push(pointers.active.size);
    const view = render(<BoundaryHarness docId="doc-a" boundary={0} onBoundary={onBoundary} />);

    fireEvent.click(screen.getByRole("button", { name: "Download as…" }));
    const oldPointer = pointers.captured.at(-1);
    const oldCloseAndFocus = captureClick(screen.getByTestId("reader-download-md"));
    expect(oldPointer).toBeDefined();
    expect(pointers.active.size).toBe(1);

    focus.mockClear();
    view.rerender(<BoundaryHarness docId="doc-a" present={false} boundary={1} onBoundary={onBoundary} />);
    act(() => {
      oldPointer?.(new Event("pointerdown"));
      oldCloseAndFocus();
    });
    expect(boundaryListeners).toEqual([0]);
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);

    view.rerender(<BoundaryHarness docId="doc-b" boundary={2} onBoundary={onBoundary} />);
    const toggle = screen.getByRole("button", { name: "Download as…" });
    expect(screen.getByTestId("reader-download-list")).not.toBeVisible();
    expect(boundaryListeners).toEqual([0, 0]);

    fireEvent.click(toggle);
    const currentMarkdown = screen.getByTestId("reader-download-md");
    expect(currentMarkdown).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(pointers.active.size).toBe(1);

    fireEvent.click(toggle);
    expect(screen.getByTestId("reader-download-list")).not.toBeVisible();
    expect(pointers.active.size).toBe(0);
    focus.mockClear();
    fireEvent.click(toggle);
    expect(screen.getByTestId("reader-download-list")).toBeVisible();
    expect(currentMarkdown).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(pointers.active.size).toBe(1);

    act(() => {
      oldPointer?.(new Event("pointerdown"));
      oldCloseAndFocus();
    });
    expect(screen.getByTestId("reader-download-list")).toBeVisible();
    expect(currentMarkdown).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(pointers.active.size).toBe(1);
  });
});
