// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { OutlinePanel } from "./outline";

const SOURCE = [
  "# First",
  "",
  "First section.",
  "",
  "## Second",
  "",
  "Second section.",
  "",
  "## Third",
  "",
  "Third section.",
].join("\n");

describe("OutlinePanel active heading reveal", () => {
  let session: CollabSession;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    session = new CollabSession({
      docId: "outline-test",
      user: makeCollabUser("alice", "Alice"),
      role: "owner",
      autoConnect: false,
      getToken: async () => {
        throw new Error("No provider connection permitted");
      },
    });
    session.keepAlive();
    session.binding.releaseRemoteSync();
  });

  afterEach(() => {
    cleanup();
    session.destroy();
    document.documentElement.scrollTop = 0;
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.restoreAllMocks();
  });

  function loadHeadings() {
    session.ytext.insert(0, SOURCE);
    return session.binding.getHeadings();
  }

  it("reveals once per active-index transition without moving focus or the document", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    render(
      <>
        <button type="button">Editor control</button>
        <OutlinePanel session={session} open onToggle={() => {}} onSelect={onSelect} />
      </>,
    );

    const first = screen.getByRole("button", { name: "First" });
    const second = screen.getByRole("button", { name: "Second" });
    const third = screen.getByRole("button", { name: "Third" });
    expect(first).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).not.toHaveBeenCalled();

    first.focus();
    document.documentElement.scrollTop = 73;
    act(() => session.setLocalCursor("rich", headings[2].from + 1));

    await waitFor(() => expect(third).toHaveAttribute("aria-current", "location"));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances[0]).toBe(third);
    expect(first).toHaveFocus();
    expect(document.documentElement.scrollTop).toBe(73);
    expect(documentScroll).not.toHaveBeenCalled();

    const version = session.version;
    act(() => session.setLocalCursor("rich", headings[2].from + 4));
    await waitFor(() => expect(session.version).toBeGreaterThan(version));
    expect(scrollIntoView).toHaveBeenCalledOnce();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(onSelect).toHaveBeenCalledWith(headings[1]);
  });

  it("does not reveal an empty, closed, or newly opened outline", async () => {
    const rendered = render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />);
    expect(screen.getByText("Headings you add will show up here.")).toBeVisible();
    expect(scrollIntoView).not.toHaveBeenCalled();

    rendered.rerender(<OutlinePanel session={session} open={false} onToggle={() => {}} onSelect={() => {}} />);
    const headings = loadHeadings();
    const version = session.version;
    act(() => session.setLocalCursor("rich", headings[2].from));
    await waitFor(() => expect(session.version).toBeGreaterThan(version));
    expect(scrollIntoView).not.toHaveBeenCalled();

    rendered.rerender(<OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Third" })).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not reveal when hydration replaces the empty server outline", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[2].from;
    const panel = <OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />;
    const html = renderToString(panel);
    expect(html).not.toContain("Third");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, panel);
    });

    await waitFor(() => expect(within(container).getByRole("button", { name: "Third" })).toHaveAttribute("aria-current", "location"));
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => root?.unmount());
    container.remove();
  });
});
