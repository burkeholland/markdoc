// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
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

const DISJOINT_SOURCE = [
  "Preamble before the replacement outline.",
  "",
  "# Replacement first",
  "",
  "Replacement section.",
  "",
  "### Replacement nested",
  "",
  "Nested section.",
  "",
  "## Replacement last",
].join("\n");

const LONG_SOURCE = Array.from({ length: 24 }, (_, index) => [
  `${index === 0 ? "#" : "##"} Heading ${index + 1}`,
  "",
  `Section ${index + 1}.`,
]).flat().join("\n");

describe("OutlinePanel active heading reveal", () => {
  let session: CollabSession;
  let sessions: CollabSession[];
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: PropertyDescriptor | undefined;

  function makeSession(docId: string) {
    const next = new CollabSession({
      docId,
      user: makeCollabUser("alice", "Alice"),
      role: "owner",
      autoConnect: false,
      getToken: async () => {
        throw new Error("No provider connection permitted");
      },
    });
    next.keepAlive();
    next.binding.releaseRemoteSync();
    sessions.push(next);
    return next;
  }

  beforeEach(() => {
    sessions = [];
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    session = makeSession("outline-test");
  });

  afterEach(() => {
    cleanup();
    for (const current of sessions) current.destroy();
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.restoreAllMocks();
  });

  function loadHeadings(target = session, source = SOURCE) {
    target.ytext.insert(0, source);
    return target.binding.getHeadings();
  }

  describe("heading titles", () => {
    const longText = "A long outline heading. ".repeat(10).trim();
    const specialText = '<img src="heading"> & <em>literal</em> \'quotes\'';

    it.each([
      ["long", `# ${longText}`, longText],
      ["blank", "#", "Untitled"],
      ["special-character", `# \`${specialText}\``, specialText],
    ])("uses the full %s heading text for the native title and accessible name", (_, source, text) => {
      const headings = loadHeadings(session, source);
      session.localCursor.rich = headings[0].from;
      render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />);

      expect(longText.length).toBeGreaterThanOrEqual(200);
      const nav = screen.getByRole("navigation", { name: "Document outline" });
      const button = within(nav).getByRole<HTMLButtonElement>("button", { name: text });
      const label = button.querySelector("span.truncate");
      expect(button).toHaveAttribute("title", text);
      expect(button).toHaveAccessibleName(text);
      expect(button.textContent).toBe(text);
      expect(label?.textContent).toBe(text);
      expect(label?.childElementCount).toBe(0);
      expect(button.querySelectorAll("*")).toHaveLength(2);
      expect(button).toHaveClass("truncate", "font-medium", "text-accent");
      expect(button).toHaveAttribute("aria-current", "location");
      expect(button).toHaveStyle({ paddingLeft: "24px" });
      expect(button.tabIndex).toBe(0);
      expect(within(nav).getAllByRole("listitem")).toHaveLength(1);
      expect(within(nav).getAllByRole("button")).toEqual([button]);
    });

    it("keeps hover passive and preserves heading selection, keyboard navigation and collapse", () => {
      const headings = loadHeadings();
      session.localCursor.rich = headings[0].from;
      const onSelect = vi.fn();
      const onToggle = vi.fn();
      render(
        <>
          <button type="button">Editor control</button>
          <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
        </>,
      );
      const nav = screen.getByRole("navigation", { name: "Document outline" });
      const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
      const editorControl = screen.getByRole("button", { name: "Editor control" });
      editorControl.focus();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const fetch = vi.spyOn(globalThis, "fetch");
      const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, "open");
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const interval = vi.spyOn(globalThis, "setInterval");
      const animationFrame = vi.spyOn(window, "requestAnimationFrame");
      const html = nav.outerHTML;

      fireEvent.pointerOver(buttons[0]);
      fireEvent.mouseOver(buttons[0]);
      fireEvent.pointerMove(buttons[0]);
      fireEvent.mouseMove(buttons[0]);
      fireEvent.pointerOut(buttons[0]);
      fireEvent.mouseOut(buttons[0]);

      expect(onSelect).not.toHaveBeenCalled();
      expect(onToggle).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(editorControl).toHaveFocus();
      expect(fetch).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(animationFrame).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(nav.outerHTML).toBe(html);
      expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
      expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]]);
      expect(buttons.map((button) => button.title)).toEqual(["First", "Second", "Third"]);
      expect(buttons[1]).toHaveStyle({ paddingLeft: "38px" });

      fireEvent.click(buttons[0]);
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith(headings[0]);
      buttons[0].focus();
      fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
      expect(buttons[1]).toHaveFocus();
      expect(onSelect).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "Hide outline" }));
      expect(onToggle).toHaveBeenCalledOnce();
    });

    it("updates titles after edits, reordering, removal and document replacement", async () => {
      loadHeadings();
      const onSelect = vi.fn();
      const onToggle = vi.fn();
      const rendered = render(<OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />);

      async function expectTitles(expected: string[]) {
        await waitFor(() => {
          const nav = screen.getByRole("navigation", { name: "Document outline" });
          const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
          expect(buttons.map((button) => button.title)).toEqual(expected);
          expect(within(nav).getAllByRole("listitem")).toHaveLength(expected.length);
          expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
          buttons.forEach((button, index) => {
            expect(button.textContent).toBe(expected[index]);
            expect(button).toHaveAccessibleName(expected[index]);
          });
        });
      }

      await expectTitles(["First", "Second", "Third"]);
      const first = screen.getByRole("button", { name: "First" });
      act(() => session.replaceSource([{ from: 2, to: 7, text: "FIRST" }]));
      await expectTitles(["FIRST", "Second", "Third"]);
      expect(screen.getByRole("button", { name: "FIRST" })).toBe(first);
      fireEvent.click(first);
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenLastCalledWith(session.binding.getHeadings()[0]);

      act(() => session.replaceSource([{ from: 0, to: session.ytext.length, text: "## Third\n\n# FIRST\n\n## Second" }]));
      await expectTitles(["Third", "FIRST", "Second"]);
      fireEvent.click(screen.getByRole("button", { name: "Third" }));
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(onSelect).toHaveBeenLastCalledWith(session.binding.getHeadings()[0]);

      act(() => session.replaceSource([{ from: 0, to: "## Third\n\n".length, text: "" }]));
      await expectTitles(["FIRST", "Second"]);
      expect(screen.queryByRole("button", { name: "Third" })).not.toBeInTheDocument();

      const replacement = makeSession("outline-title-replacement");
      const replacementHeadings = loadHeadings(replacement, DISJOINT_SOURCE);
      rendered.rerender(<OutlinePanel session={replacement} open onToggle={onToggle} onSelect={onSelect} />);
      await expectTitles(["Replacement first", "Replacement nested", "Replacement last"]);
      expect(screen.queryByRole("button", { name: "FIRST" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Replacement first" }));
      expect(onSelect).toHaveBeenCalledTimes(3);
      expect(onSelect).toHaveBeenLastCalledWith(replacementHeadings[0]);
    });
  });

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

    const first = screen.getByRole<HTMLButtonElement>("button", { name: "First" });
    const second = screen.getByRole<HTMLButtonElement>("button", { name: "Second" });
    const third = screen.getByRole<HTMLButtonElement>("button", { name: "Third" });
    expect(first).toHaveAttribute("aria-current", "location");
    expect(first).toHaveAttribute("type", "button");
    expect(first).toHaveStyle({ paddingLeft: "24px" });
    expect(second).toHaveStyle({ paddingLeft: "38px" });
    expect(within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button").filter((button) => button.tabIndex === 0)).toEqual([first]);
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
    expect(within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button").filter((button) => button.tabIndex === 0)).toEqual([third]);

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
    // The hint needs the document's text to be in: an outline is not known to be empty before that.
    const pending = render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />);
    expect(screen.queryByText("Headings you add will show up here.")).toBeNull();
    pending.unmount();
    Object.defineProperty(session, "contentReady", { configurable: true, get: () => true });
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
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Third" })).toHaveAttribute("aria-current", "location");
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

    await waitFor(() => expect(within(container).getByRole<HTMLButtonElement>("button", { name: "Third" })).toHaveAttribute("aria-current", "location"));
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => root?.unmount());
    container.remove();
  });

  it("preserves every scroll position with preventScroll across edge wraps and a middle move", () => {
    const headings = loadHeadings(session, LONG_SOURCE);
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const nav = screen.getByRole("navigation", { name: "Document outline" });
    const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const cursor = session.cursorSource;
    buttons[0].focus();
    nav.scrollTop = 91;
    document.documentElement.scrollTop = 73;
    document.body.scrollTop = 37;
    const scrollPositions = {
      outline: nav.scrollTop,
      documentElement: document.documentElement.scrollTop,
      body: document.body.scrollTop,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageXOffset: window.pageXOffset,
      pageYOffset: window.pageYOffset,
    };
    const expectScrollPositions = () => {
      expect({
        outline: nav.scrollTop,
        documentElement: document.documentElement.scrollTop,
        body: document.body.scrollTop,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        pageXOffset: window.pageXOffset,
        pageYOffset: window.pageYOffset,
      }).toEqual(scrollPositions);
    };
    const move = (source: HTMLButtonElement, key: "ArrowDown" | "ArrowUp", destination: HTMLButtonElement) => {
      focus.mockClear();
      const nativeKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      const preventDefault = vi.spyOn(nativeKey, "preventDefault");

      act(() => source.dispatchEvent(nativeKey));

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(destination).toHaveFocus();
      expectScrollPositions();
    };

    move(buttons[0], "ArrowUp", buttons.at(-1)!);
    move(buttons.at(-1)!, "ArrowDown", buttons[0]);
    move(buttons[0], "ArrowDown", buttons[1]);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
    expect(session.cursorSource).toBe(cursor);
    expect(screen.getByTestId("outline")).toBeVisible();
    expect(buttons[0]).toHaveAttribute("aria-current", "location");
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]]);
  });

  it.each(["ArrowDown", "ArrowUp"] as const)("keeps a one-heading outline stable on %s", (key) => {
    const headings = loadHeadings(session, "# Only");
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Only" });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const cursor = session.cursorSource;
    button.focus();
    focus.mockClear();
    const nativeKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(nativeKey, "preventDefault");

    act(() => button.dispatchEvent(nativeKey));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-current", "location");
    expect(button).toHaveAttribute("tabindex", "0");
    expect(session.cursorSource).toBe(cursor);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
  });

  it.each(["ArrowDown", "ArrowUp"] as const)("ignores %s when the outline is empty", (key) => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const list = screen.getByRole("navigation", { name: "Document outline" }).querySelector("ul");
    if (!list) throw new Error("Empty outline list was not rendered");
    const nativeKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const preventDefault = vi.spyOn(nativeKey, "preventDefault");

    act(() => list.dispatchEvent(nativeKey));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
    expect(screen.getByTestId("outline")).toBeVisible();
  });

  it.each([
    ["ArrowDown", 2, 0],
    ["ArrowUp", 0, 2],
  ] as const)("selects only after Enter following a %s wrap", async (key, current, next) => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const buttons = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button");
    const cursor = session.cursorSource;
    buttons[current].focus();

    await user.keyboard(key === "ArrowDown" ? "{ArrowDown}" : "{ArrowUp}");

    expect(buttons[next]).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    expect(session.cursorSource).toBe(cursor);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(headings[next]);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByTestId("outline")).toBeVisible();
  });

  it.each([
    ["Alt", { altKey: true }],
    ["Control", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["repeat", { repeat: true }],
    ["composition", { isComposing: true }],
  ] as const)("rejects a %s-modified wrapping key without side effects", (_kind, init) => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const buttons = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const cursor = session.cursorSource;
    buttons[2].focus();
    focus.mockClear();
    const nativeKey = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    const preventDefault = vi.spyOn(nativeKey, "preventDefault");

    act(() => buttons[2].dispatchEvent(nativeKey));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(buttons[2]).toHaveFocus();
    expect(session.cursorSource).toBe(cursor);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
  });

  it("does not claim an already canceled wrapping key", () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );
    const buttons = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    buttons[2].focus();
    focus.mockClear();
    const nativeKey = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(nativeKey, "preventDefault");
    buttons[2].addEventListener("keydown", (event) => event.preventDefault(), { capture: true, once: true });

    act(() => buttons[2].dispatchEvent(nativeKey));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
    expect(buttons[2]).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("selects a heading on a plain click, Enter and Space (#2352)", async () => {
    const headings = loadHeadings();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={onSelect} />);
    const buttons = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole("button");

    await user.click(buttons[1]);
    expect(onSelect).toHaveBeenLastCalledWith(headings[1]);
    buttons[2].focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(headings[2]);
    buttons[0].focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith(headings[0]);
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("still selects and toggles after something outside React changes its DOM, as Translate does (#2352)", async () => {
    const headings = loadHeadings();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />);
    const outline = screen.getByTestId("outline");
    for (const label of outline.querySelectorAll("span.truncate")) {
      const font = document.createElement("font");
      font.textContent = `${label.textContent} (translated)`;
      label.replaceChildren(font);
    }
    outline.setAttribute("lang", "fr");

    await user.click(outline.querySelectorAll("font")[1]);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(headings[1]);
    await user.click(screen.getByRole("button", { name: "Hide outline" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("shows the collapsed strip and toggles it open", async () => {
    loadHeadings();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<OutlinePanel session={session} open={false} onToggle={onToggle} onSelect={() => {}} />);
    expect(screen.getByTestId("outline-collapsed")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show outline" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("works inside StrictMode", async () => {
    const headings = loadHeadings();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={() => {}} onSelect={onSelect} />
      </StrictMode>,
    );
    await user.click(screen.getByRole("button", { name: "Third" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(headings[2]);
  });
});
