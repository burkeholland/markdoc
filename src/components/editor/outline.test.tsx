// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { StrictMode, useLayoutEffect } from "react";
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

const OVERLAPPING_SOURCE = [
  "# Shared first",
  "",
  "Shared section.",
  "",
  "## Shared second",
  "",
  "Another shared section.",
  "",
  "## Shared third",
].join("\n");

const LONG_SOURCE = Array.from({ length: 24 }, (_, index) => [
  `${index === 0 ? "#" : "##"} Heading ${index + 1}`,
  "",
  `Section ${index + 1}.`,
]).flat().join("\n");

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

type CapturedClickEvent = {
  currentTarget: HTMLButtonElement;
  target?: EventTarget;
  nativeEvent?: globalThis.MouseEvent;
};
type CapturedClick = (event: CapturedClickEvent) => void;
type CapturedKeyDown = (event: {
  type?: string;
  key: string;
  currentTarget: HTMLUListElement;
  target: EventTarget;
  nativeEvent?: globalThis.KeyboardEvent;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  preventDefault: () => void;
}) => void;
type CapturedRef<T> = (element: T | null) => void;

function OutlineBoundary({
  session,
  present = true,
  boundary = 0,
  onBoundary,
  onToggle,
  onSelect,
}: {
  session: CollabSession;
  present?: boolean;
  boundary?: number;
  onBoundary?: () => void;
  onToggle: () => void;
  onSelect: Parameters<typeof OutlinePanel>[0]["onSelect"];
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} /> : null;
}

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

  it.each([
    ["disjoint", "stale-before-current", SOURCE, DISJOINT_SOURCE],
    ["disjoint", "current-before-stale", SOURCE, DISJOINT_SOURCE],
    ["overlapping", "stale-before-current", OVERLAPPING_SOURCE, OVERLAPPING_SOURCE],
    ["overlapping", "current-before-stale", OVERLAPPING_SOURCE, OVERLAPPING_SOURCE],
  ] as const)("binds %s replacement headings and actions when work runs %s", async (shape, order, previousSource, currentSource) => {
    const previousSession = makeSession(`outline-previous-${shape}-${order}`);
    const currentSession = makeSession(`outline-current-${shape}-${order}`);
    const previousHeadings = loadHeadings(previousSession, previousSource);
    const currentHeadings = loadHeadings(currentSession, currentSource);
    previousSession.localCursor.rich = previousHeadings[0].from;
    currentSession.localCursor.rich = currentHeadings[0].from;
    const previousToggle = vi.fn();
    const previousSelect = vi.fn();
    const currentToggle = vi.fn();
    const currentSelect = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<OutlineBoundary session={previousSession} onToggle={previousToggle} onSelect={previousSelect} />);
      });
      const previousNav = screen.getByRole("navigation", { name: "Document outline" });
      const previousList = previousNav.querySelector("ul");
      if (!previousList) throw new Error("Previous outline list was not rendered");
      const previousButtons = within(previousNav).getAllByRole<HTMLButtonElement>("button");
      const previousToggleButton = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      const retiredHeading = reactHandler<(event: { currentTarget: HTMLButtonElement }) => void>(previousButtons[1], "onClick");
      const retiredToggle = reactHandler<(event: { currentTarget: HTMLButtonElement }) => void>(previousToggleButton, "onClick");
      const retiredKeyboard = reactHandler<
        (event: { key: string; currentTarget: HTMLUListElement; target: EventTarget; preventDefault: () => void }) => void
      >(previousList, "onKeyDown");
      const retiredPreventDefault = vi.fn();
      previousButtons[0].focus();
      focus.mockClear();

      const onBoundary = () => {
        const currentNav = screen.getByRole("navigation", { name: "Document outline" });
        const currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
        expect(currentButtons).toHaveLength(currentHeadings.length);
        expect(currentButtons.every((button) => !previousButtons.includes(button))).toBe(true);
        expect(currentNav.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
        expect(currentButtons[0]).toHaveAttribute("aria-current", "location");
        expect(currentButtons.filter((button) => button.tabIndex === 0)).toEqual([currentButtons[0]]);
        expect(currentButtons).not.toContain(document.activeElement);
        expect(scrollIntoView).not.toHaveBeenCalled();
        if (shape === "disjoint") {
          expect(screen.queryByRole("button", { name: previousHeadings[0].text })).not.toBeInTheDocument();
        }

        const staleWork = () => {
          previousSession.setLocalCursor("rich", previousHeadings.at(-1)!.from);
          retiredHeading({ currentTarget: previousButtons[1] });
          retiredToggle({ currentTarget: previousToggleButton });
          retiredKeyboard({
            key: "ArrowDown",
            currentTarget: previousList,
            target: previousButtons[0],
            preventDefault: retiredPreventDefault,
          });
        };
        const currentWork = () => currentSession.setLocalCursor("rich", currentHeadings.at(-1)!.from);
        if (order === "stale-before-current") {
          staleWork();
          currentWork();
        } else {
          currentWork();
          staleWork();
        }
      };

      await act(async () => {
        root.render(
          <OutlineBoundary
            session={currentSession}
            boundary={1}
            onBoundary={onBoundary}
            onToggle={currentToggle}
            onSelect={currentSelect}
          />,
        );
      });

      const currentNav = screen.getByRole("navigation", { name: "Document outline" });
      const currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView.mock.instances[0]).toBe(currentButtons.at(-1));
      expect(currentNav.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
      expect(currentButtons.at(-1)).toHaveAttribute("aria-current", "location");
      expect(currentButtons.filter((button) => button.tabIndex === 0)).toEqual([currentButtons.at(-1)]);
      expect(previousSelect).not.toHaveBeenCalled();
      expect(previousToggle).not.toHaveBeenCalled();
      expect(currentSelect).not.toHaveBeenCalled();
      expect(currentToggle).not.toHaveBeenCalled();
      expect(retiredPreventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();

      currentButtons[0].focus();
      focus.mockClear();
      fireEvent.keyDown(currentButtons[0], { key: "ArrowDown" });
      expect(currentButtons[1]).toHaveFocus();
      expect(focus).toHaveBeenCalledOnce();
      fireEvent.click(currentButtons[1]);
      expect(currentSelect).toHaveBeenCalledOnce();
      expect(currentSelect).toHaveBeenCalledWith(currentHeadings[1]);
      fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" }));
      expect(currentToggle).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("retires reveal and captured actions before the parent layout boundary on removal", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<OutlineBoundary session={session} onToggle={onToggle} onSelect={onSelect} />);
      });
      const nav = screen.getByRole("navigation", { name: "Document outline" });
      const list = nav.querySelector("ul");
      if (!list) throw new Error("Outline list was not rendered");
      const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
      const toggleButton = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      const retiredHeading = reactHandler<(event: { currentTarget: HTMLButtonElement }) => void>(buttons[1], "onClick");
      const retiredToggle = reactHandler<(event: { currentTarget: HTMLButtonElement }) => void>(toggleButton, "onClick");
      const retiredKeyboard = reactHandler<
        (event: { key: string; currentTarget: HTMLUListElement; target: EventTarget; preventDefault: () => void }) => void
      >(list, "onKeyDown");
      const retiredPreventDefault = vi.fn();
      buttons[0].focus();
      focus.mockClear();

      await act(async () => {
        root.render(
          <OutlineBoundary
            session={session}
            present={false}
            boundary={1}
            onBoundary={() => {
              expect(screen.queryByTestId("outline")).not.toBeInTheDocument();
              session.setLocalCursor("rich", headings.at(-1)!.from);
              retiredHeading({ currentTarget: buttons[1] });
              retiredToggle({ currentTarget: toggleButton });
              retiredKeyboard({
                key: "ArrowDown",
                currentTarget: list,
                target: buttons[0],
                preventDefault: retiredPreventDefault,
              });
            }}
            onToggle={onToggle}
            onSelect={onSelect}
          />,
        );
      });

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
      expect(onToggle).not.toHaveBeenCalled();
      expect(retiredPreventDefault).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each([
    [false, "Show outline"],
    [true, "Hide outline"],
  ] as const)("accepts the exact current %s toggle once and rejects wrong controls", (open, label) => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    render(<OutlinePanel session={session} open={open} onToggle={onToggle} onSelect={onSelect} />);

    const toggle = screen.getByRole<HTMLButtonElement>("button", { name: label });
    const click = reactHandler<CapturedClick>(toggle, "onClick");
    const toggleRef = reactHandler<CapturedRef<HTMLButtonElement>>(toggle, "ref");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);

    click({ currentTarget: foreign });
    click({ currentTarget: detached });
    if (open) click({ currentTarget: screen.getByRole<HTMLButtonElement>("button", { name: "First" }) });
    expect(onToggle).not.toHaveBeenCalled();

    click({ currentTarget: toggle });
    click({ currentTarget: toggle });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();

    const replacement = toggle.cloneNode(true) as HTMLButtonElement;
    toggle.parentElement?.replaceChild(replacement, toggle);
    click({ currentTarget: replacement });
    click({ currentTarget: toggle });
    toggleRef(null);
    toggleRef(replacement);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();

    replacement.parentElement?.replaceChild(toggle, replacement);
    foreign.remove();
  });

  it.each([0, 1, 2])("selects committed heading %i exactly once", (index) => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onSelect = vi.fn();
    render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={onSelect} />);

    const buttons = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button");
    const button = buttons[index];
    const other = buttons[(index + 1) % buttons.length];
    const toggle = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const click = reactHandler<CapturedClick>(button, "onClick");
    const buttonRef = reactHandler<CapturedRef<HTMLButtonElement>>(button, "ref");
    const foreign = document.createElement("button");
    const detached = document.createElement("button");
    document.body.append(foreign);

    click({ currentTarget: other });
    click({ currentTarget: toggle });
    click({ currentTarget: foreign });
    click({ currentTarget: detached });
    expect(onSelect).not.toHaveBeenCalled();

    click({ currentTarget: button });
    click({ currentTarget: button });
    reactHandler<CapturedClick>(other, "onClick")({ currentTarget: button });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(headings[index]);
    expect(onSelect.mock.calls[0][0]).toBe(headings[index]);

    const replacement = button.cloneNode(true) as HTMLButtonElement;
    button.parentElement?.replaceChild(replacement, button);
    click({ currentTarget: replacement });
    click({ currentTarget: button });
    buttonRef(null);
    buttonRef(replacement);
    expect(onSelect).toHaveBeenCalledOnce();

    replacement.parentElement?.replaceChild(button, replacement);
    foreign.remove();
  });

  it.each([
    ["ArrowDown", 2, 0],
    ["ArrowUp", 0, 2],
    ["ArrowDown", 0, 1],
    ["ArrowUp", 2, 1],
    ["Home", 2, 0],
    ["End", 0, 2],
  ] as const)("binds %s navigation to the exact list, source, and frozen destination", (key, current, next) => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const documentScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const cursor = session.cursorSource;
    render(
      <StrictMode>
        <OutlinePanel session={session} open onToggle={onToggle} onSelect={onSelect} />
      </StrictMode>,
    );

    const nav = screen.getByRole("navigation", { name: "Document outline" });
    const list = nav.querySelector("ul");
    if (!list) throw new Error("Outline list was not rendered");
    const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
    const keyDown = reactHandler<CapturedKeyDown>(list, "onKeyDown");
    const preventDefault = vi.fn();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const querySelectorAll = vi.spyOn(list, "querySelectorAll");
    const foreignList = document.createElement("ul");
    const foreignButton = document.createElement("button");
    document.body.append(foreignList, foreignButton);

    buttons[current].focus();
    focus.mockClear();
    keyDown({ key, currentTarget: foreignList, target: buttons[current], preventDefault });
    keyDown({ key, currentTarget: list, target: buttons[(current + 1) % buttons.length], preventDefault });
    foreignButton.focus();
    keyDown({ key, currentTarget: list, target: foreignButton, preventDefault });
    buttons[current].focus();
    keyDown({ key: "Enter", currentTarget: list, target: buttons[current], preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();

    buttons[current].focus();
    focus.mockClear();
    const nativeKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const nativePreventDefault = vi.spyOn(nativeKey, "preventDefault");
    act(() => buttons[current].dispatchEvent(nativeKey));
    expect(nativePreventDefault).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(buttons[next]).toHaveFocus();
    expect(querySelectorAll).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
    expect(session.cursorSource).toBe(cursor);
    expect(screen.getByTestId("outline")).toBeVisible();
    expect(buttons[0]).toHaveAttribute("aria-current", "location");
    expect(buttons.filter((button) => button.tabIndex === 0)).toEqual([buttons[0]]);

    keyDown({ key, currentTarget: list, target: buttons[next], preventDefault });
    expect(nativePreventDefault).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
    foreignList.remove();
    foreignButton.remove();
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

  it.each([
    "detach and reinsert",
    "reorder and restore",
    "replace and restore",
    "disable and restore",
    "mutate and restore",
  ] as const)("permanently rejects a wrap after DOM %s", (change) => {
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
    const root = screen.getByTestId("outline");
    const list = screen.getByRole("navigation", { name: "Document outline" }).querySelector("ul");
    if (!list) throw new Error("Outline list was not rendered");
    const buttons = within(list).getAllByRole<HTMLButtonElement>("button");
    const rows = buttons.map((button) => button.parentElement as HTMLLIElement);

    if (change === "detach and reinsert") {
      const parent = root.parentNode;
      const next = root.nextSibling;
      if (!parent) throw new Error("Outline root had no parent");
      root.remove();
      parent.insertBefore(root, next);
    } else if (change === "reorder and restore") {
      list.append(rows[0]);
      list.insertBefore(rows[0], rows[1]);
    } else if (change === "replace and restore") {
      const replacement = list.cloneNode(true) as HTMLUListElement;
      list.replaceWith(replacement);
      replacement.replaceWith(list);
    } else if (change === "disable and restore") {
      buttons[2].disabled = true;
      buttons[2].disabled = false;
    } else {
      buttons[2].setAttribute("data-outline-item", "changed");
      buttons[2].setAttribute("data-outline-item", "");
    }

    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const cursor = session.cursorSource;
    buttons[2].focus();
    focus.mockClear();
    const nativeKey = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
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
    expect(screen.getByTestId("outline")).toBeVisible();
  });

  it("keeps a callback-replacement successor authoritative across reused elements and stale refs", () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const toggleA = vi.fn();
    const selectA = vi.fn();
    const toggleB = vi.fn();
    const selectB = vi.fn();
    const rendered = render(<OutlinePanel session={session} open onToggle={toggleA} onSelect={selectA} />);

    const rootA = screen.getByTestId("outline");
    const toggleElementA = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const navA = screen.getByRole("navigation", { name: "Document outline" });
    const listA = navA.querySelector("ul");
    if (!listA) throw new Error("Outline list was not rendered");
    const buttonsA = within(navA).getAllByRole<HTMLButtonElement>("button");
    const itemA = buttonsA[1].parentElement;
    if (!(itemA instanceof HTMLLIElement)) throw new Error("Outline row was not rendered");
    const rootRefA = reactHandler<CapturedRef<HTMLElement>>(rootA, "ref");
    const toggleRefA = reactHandler<CapturedRef<HTMLButtonElement>>(toggleElementA, "ref");
    const navRefA = reactHandler<CapturedRef<HTMLElement>>(navA, "ref");
    const listRefA = reactHandler<CapturedRef<HTMLUListElement>>(listA, "ref");
    const itemRefA = reactHandler<CapturedRef<HTMLLIElement>>(itemA, "ref");
    const buttonRefA = reactHandler<CapturedRef<HTMLButtonElement>>(buttonsA[1], "ref");
    const staleToggle = reactHandler<CapturedClick>(toggleElementA, "onClick");
    const staleSelect = reactHandler<CapturedClick>(buttonsA[1], "onClick");
    const staleKey = reactHandler<CapturedKeyDown>(listA, "onKeyDown");

    rendered.rerender(<OutlinePanel session={session} open onToggle={toggleB} onSelect={selectB} />);
    const rootB = screen.getByTestId("outline");
    const toggleElementB = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const navB = screen.getByRole("navigation", { name: "Document outline" });
    const listB = navB.querySelector("ul");
    if (!listB) throw new Error("Outline list was not rendered");
    const buttonsB = within(navB).getAllByRole<HTMLButtonElement>("button");
    const itemB = buttonsB[1].parentElement;
    if (!(itemB instanceof HTMLLIElement)) throw new Error("Outline row was not rendered");
    expect(rootB).toBe(rootA);
    expect(toggleElementB).toBe(toggleElementA);
    expect(navB).toBe(navA);
    expect(listB).toBe(listA);
    expect(buttonsB).toEqual(buttonsA);

    rootRefA(null);
    toggleRefA(null);
    navRefA(null);
    listRefA(null);
    itemRefA(null);
    buttonRefA(null);
    rootRefA(rootB);
    toggleRefA(toggleElementB);
    navRefA(navB);
    listRefA(listB);
    itemRefA(itemB);
    buttonRefA(buttonsB[1]);

    const stalePreventDefault = vi.fn();
    buttonsB[0].focus();
    staleToggle({ currentTarget: toggleElementB });
    staleSelect({ currentTarget: buttonsB[1] });
    staleKey({ key: "ArrowDown", currentTarget: listB, target: buttonsB[0], preventDefault: stalePreventDefault });
    expect(toggleA).not.toHaveBeenCalled();
    expect(selectA).not.toHaveBeenCalled();
    expect(stalePreventDefault).not.toHaveBeenCalled();

    fireEvent.click(buttonsB[1]);
    fireEvent.click(toggleElementB);
    buttonsB[0].focus();
    const currentKey = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    const currentPreventDefault = vi.spyOn(currentKey, "preventDefault");
    act(() => buttonsB[0].dispatchEvent(currentKey));
    expect(selectB).toHaveBeenCalledOnce();
    expect(selectB).toHaveBeenCalledWith(headings[1]);
    expect(toggleB).toHaveBeenCalledOnce();
    expect(currentPreventDefault).toHaveBeenCalledOnce();
    expect(buttonsB[1]).toHaveFocus();
  });

  it.each(["id", "level", "text", "from", "line"] as const)(
    "retires a heading handler when its frozen %s field is mutated in place",
    (field) => {
      const headings = loadHeadings();
      session.localCursor.rich = headings[0].from;
      const selectA = vi.fn();
      const selectB = vi.fn();
      const rendered = render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectA} />);
      const oldButton = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button")[1];
      const staleClick = reactHandler<CapturedClick>(oldButton, "onClick");
      const heading = headings[1];
      const mutable = heading as unknown as Record<typeof field, string | number>;
      mutable[field] =
        field === "id" ? `${heading.id}-changed`
        : field === "text" ? `${heading.text} changed`
        : (heading[field] as number) + 1;

      rendered.rerender(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectB} />);
      const currentButton = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button")[1];
      staleClick({ currentTarget: currentButton });
      expect(selectA).not.toHaveBeenCalled();

      fireEvent.click(currentButton);
      expect(selectB).toHaveBeenCalledOnce();
      expect(selectB.mock.calls[0][0]).toBe(heading);
    },
  );

  it("binds equal-looking heading object and order replacements to the committed rows", () => {
    const headings = loadHeadings();
    session.localCursor.rich = null;
    const selectA = vi.fn();
    const selectB = vi.fn();
    const rendered = render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectA} />);
    const navA = screen.getByRole("navigation", { name: "Document outline" });
    const buttonsA = within(navA).getAllByRole<HTMLButtonElement>("button");
    const staleSecond = reactHandler<CapturedClick>(buttonsA[1], "onClick");
    const replacement = { ...headings[1] };
    headings[1] = replacement;
    [headings[0], headings[1]] = [headings[1], headings[0]];

    rendered.rerender(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectB} />);
    const navB = screen.getByRole("navigation", { name: "Document outline" });
    const buttonsB = within(navB).getAllByRole<HTMLButtonElement>("button");
    staleSecond({ currentTarget: buttonsB[0] });
    expect(selectA).not.toHaveBeenCalled();

    fireEvent.click(buttonsB[0]);
    expect(selectB).toHaveBeenCalledOnce();
    expect(selectB.mock.calls[0][0]).toBe(replacement);
  });

  it.each(["root", "nav", "list", "toggle", "row"] as const)(
    "retires a presentation after exact %s replacement and admits its next commit",
    (part) => {
      const headings = loadHeadings();
      session.localCursor.rich = headings[0].from;
      const toggleA = vi.fn();
      const selectA = vi.fn();
      const toggleB = vi.fn();
      const selectB = vi.fn();
      const rendered = render(<OutlinePanel session={session} open onToggle={toggleA} onSelect={selectA} />);
      const root = screen.getByTestId("outline");
      const nav = screen.getByRole("navigation", { name: "Document outline" });
      const list = nav.querySelector("ul");
      if (!list) throw new Error("Outline list was not rendered");
      const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
      const toggle = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      const row = buttons[1].parentElement;
      if (!(row instanceof HTMLLIElement)) throw new Error("Outline row was not rendered");
      const staleToggle = reactHandler<CapturedClick>(toggle, "onClick");
      const staleSelect = reactHandler<CapturedClick>(buttons[1], "onClick");

      const original =
        part === "root" ? root
        : part === "nav" ? nav
        : part === "list" ? list
        : part === "toggle" ? toggle
        : row;
      const parent = original.parentElement;
      if (!parent) throw new Error("Replacement target had no parent");
      const replacement = original.cloneNode(true) as HTMLElement;
      parent.replaceChild(replacement, original);
      staleSelect({ currentTarget: buttons[1] });
      staleToggle({ currentTarget: toggle });
      expect(selectA).not.toHaveBeenCalled();
      expect(toggleA).not.toHaveBeenCalled();
      parent.replaceChild(original, replacement);

      rendered.rerender(<OutlinePanel session={session} open onToggle={toggleB} onSelect={selectB} />);
      const currentNav = screen.getByRole("navigation", { name: "Document outline" });
      const currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
      const currentToggle = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      fireEvent.click(currentButtons[1]);
      fireEvent.click(currentToggle);
      expect(selectB).toHaveBeenCalledOnce();
      expect(selectB).toHaveBeenCalledWith(headings[1]);
      expect(toggleB).toHaveBeenCalledOnce();
    },
  );

  it("lets stale active-row refs neither scroll nor clear the current reveal owner", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Document outline" });
    const first = within(nav).getAllByRole<HTMLButtonElement>("button")[0];
    const firstItem = first.parentElement;
    if (!(firstItem instanceof HTMLLIElement)) throw new Error("Outline row was not rendered");
    const staleItemRef = reactHandler<CapturedRef<HTMLLIElement>>(firstItem, "ref");
    const staleButtonRef = reactHandler<CapturedRef<HTMLButtonElement>>(first, "ref");

    act(() => session.setLocalCursor("rich", headings[2].from));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
    const currentButtons = within(nav).getAllByRole<HTMLButtonElement>("button");
    staleItemRef(null);
    staleButtonRef(null);
    staleItemRef(currentButtons[0].parentElement as HTMLLIElement);
    staleButtonRef(currentButtons[0]);
    expect(scrollIntoView).toHaveBeenCalledOnce();

    act(() => session.setLocalCursor("rich", headings[1].from));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(scrollIntoView.mock.instances[1]).toBe(currentButtons[1]);
  });

  it("retires equal-looking heading objects supplied by the session", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    let currentHeadings = headings;
    vi.spyOn(session.binding, "getHeadings").mockImplementation(() => currentHeadings);
    const selectA = vi.fn();
    const selectB = vi.fn();
    const rendered = render(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectA} />);
    const previousButton = within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole<HTMLButtonElement>("button")[1];
    const staleClick = reactHandler<CapturedClick>(previousButton, "onClick");
    currentHeadings = headings.map((heading) => ({ ...heading }));

    rendered.rerender(<OutlinePanel session={session} open onToggle={() => {}} onSelect={selectB} />);
    act(() => session.setLocalCursor("rich", headings[0].from + 1));
    const currentButton = await screen.findByRole<HTMLButtonElement>("button", { name: "Second" });
    staleClick({ currentTarget: currentButton });
    expect(selectA).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(currentButton);
    expect(selectB).toHaveBeenCalledOnce();
    expect(selectB.mock.calls[0][0]).toBe(currentHeadings[1]);
  });

  it("keeps open and collapsed transition handlers scoped to their committed controls", () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const toggleA = vi.fn();
    const toggleB = vi.fn();
    const toggleC = vi.fn();
    const rendered = render(<OutlinePanel session={session} open={false} onToggle={toggleA} onSelect={() => {}} />);
    const showA = screen.getByRole<HTMLButtonElement>("button", { name: "Show outline" });
    const staleShow = reactHandler<CapturedClick>(showA, "onClick");

    rendered.rerender(<OutlinePanel session={session} open onToggle={toggleB} onSelect={() => {}} />);
    const hideB = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const staleHide = reactHandler<CapturedClick>(hideB, "onClick");
    staleShow({ currentTarget: hideB });
    expect(toggleA).not.toHaveBeenCalled();
    fireEvent.click(hideB);
    expect(toggleB).toHaveBeenCalledOnce();

    rendered.rerender(<OutlinePanel session={session} open={false} onToggle={toggleC} onSelect={() => {}} />);
    const showC = screen.getByRole<HTMLButtonElement>("button", { name: "Show outline" });
    staleHide({ currentTarget: showC });
    expect(toggleB).toHaveBeenCalledOnce();
    fireEvent.click(showC);
    expect(toggleC).toHaveBeenCalledOnce();
  });

  it("rejects sibling outline controls without consuming either presentation", () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const toggleA = vi.fn();
    const selectA = vi.fn();
    const toggleB = vi.fn();
    const selectB = vi.fn();
    render(
      <>
        <OutlinePanel session={session} open onToggle={toggleA} onSelect={selectA} />
        <OutlinePanel session={session} open onToggle={toggleB} onSelect={selectB} />
      </>,
    );
    const roots = screen.getAllByTestId("outline");
    const toggles = roots.map((root) => within(root).getByRole<HTMLButtonElement>("button", { name: "Hide outline" }));
    const navs = roots.map((root) => within(root).getByRole("navigation", { name: "Document outline" }));
    const lists = navs.map((nav) => nav.querySelector("ul"));
    if (!lists[0] || !lists[1]) throw new Error("Sibling outline lists were not rendered");
    const buttons = navs.map((nav) => within(nav).getAllByRole<HTMLButtonElement>("button"));
    const preventDefault = vi.fn();

    reactHandler<CapturedClick>(toggles[0], "onClick")({ currentTarget: toggles[1] });
    reactHandler<CapturedClick>(buttons[0][1], "onClick")({ currentTarget: buttons[1][1] });
    buttons[1][0].focus();
    reactHandler<CapturedKeyDown>(lists[0], "onKeyDown")({
      key: "ArrowDown",
      currentTarget: lists[1],
      target: buttons[1][0],
      preventDefault,
    });
    expect(toggleA).not.toHaveBeenCalled();
    expect(selectA).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    fireEvent.click(toggles[0]);
    fireEvent.click(buttons[0][1]);
    fireEvent.click(toggles[1]);
    fireEvent.click(buttons[1][1]);
    expect(toggleA).toHaveBeenCalledOnce();
    expect(selectA).toHaveBeenCalledOnce();
    expect(toggleB).toHaveBeenCalledOnce();
    expect(selectB).toHaveBeenCalledOnce();
  });

  it("keeps exact controls authoritative through direct-root StrictMode replay", async () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const collapsedToggle = vi.fn();
    let expandedToggleHandler: CapturedClick | null = null;
    let expandedToggleEvent: CapturedClickEvent | null = null;
    const expandedToggle = vi.fn(() => {
      if (expandedToggleHandler && expandedToggleEvent) expandedToggleHandler(expandedToggleEvent);
    });
    let headingHandler: CapturedClick | null = null;
    let headingEvent: CapturedClickEvent | null = null;
    const select = vi.fn(() => {
      if (headingHandler && headingEvent) headingHandler(headingEvent);
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <OutlinePanel session={session} open={false} onToggle={collapsedToggle} onSelect={select} />
          </StrictMode>,
        );
      });
      const collapsedRoot = within(host).getByTestId("outline-collapsed");
      const show = within(host).getByRole<HTMLButtonElement>("button", { name: "Show outline" });
      const staleCollapsedRootRef = reactHandler<CapturedRef<HTMLElement>>(collapsedRoot, "ref");
      const staleCollapsedToggleRef = reactHandler<CapturedRef<HTMLButtonElement>>(show, "ref");
      const staleShow = reactHandler<CapturedClick>(show, "onClick");
      staleShow({ currentTarget: show });
      expect(collapsedToggle).not.toHaveBeenCalled();
      fireEvent.click(show);
      expect(collapsedToggle).toHaveBeenCalledOnce();

      await act(async () => {
        root.render(
          <StrictMode>
            <OutlinePanel session={session} open onToggle={expandedToggle} onSelect={select} />
          </StrictMode>,
        );
      });
      const expandedRoot = within(host).getByTestId("outline");
      const toggle = within(host).getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      const nav = within(host).getByRole("navigation", { name: "Document outline" });
      const list = nav.querySelector("ul");
      if (!list) throw new Error("Strict outline list was not rendered");
      const buttons = within(nav).getAllByRole<HTMLButtonElement>("button");
      const items = buttons.map((button) => button.parentElement);
      if (items.some((item) => !(item instanceof HTMLLIElement))) throw new Error("Strict outline row was not rendered");
      const staleExpandedRootRef = reactHandler<CapturedRef<HTMLElement>>(expandedRoot, "ref");
      const staleExpandedToggleRef = reactHandler<CapturedRef<HTMLButtonElement>>(toggle, "ref");
      const staleExpandedNavRef = reactHandler<CapturedRef<HTMLElement>>(nav, "ref");
      const staleExpandedListRef = reactHandler<CapturedRef<HTMLUListElement>>(list, "ref");
      const staleExpandedItemRefs = items.map((item) => reactHandler<CapturedRef<HTMLLIElement>>(item as HTMLLIElement, "ref"));
      const staleExpandedButtonRefs = buttons.map((button) => reactHandler<CapturedRef<HTMLButtonElement>>(button, "ref"));
      const staleExpandedToggle = reactHandler<CapturedClick>(toggle, "onClick");
      const staleExpandedHeading = reactHandler<CapturedClick>(buttons[1], "onClick");
      const staleExpandedKey = reactHandler<CapturedKeyDown>(list, "onKeyDown");

      fireEvent.click(toggle);
      expect(expandedToggle).toHaveBeenCalledOnce();
      staleCollapsedRootRef(null);
      staleCollapsedToggleRef(null);
      staleCollapsedRootRef(expandedRoot);
      staleCollapsedToggleRef(toggle);

      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const foreignWindow = iframe.contentWindow;
      const foreignDocument = iframe.contentDocument;
      if (!foreignWindow || !foreignDocument) throw new Error("Cross-document test frame was not created");
      const foreignGlobal = foreignWindow as Window & typeof globalThis;
      const foreignButton = foreignDocument.createElement("button");
      foreignDocument.body.append(foreignButton);
      foreignButton.addEventListener(
        "click",
        (nativeEvent) => {
          staleExpandedHeading({
            currentTarget: buttons[1],
            target: nativeEvent.target ?? foreignButton,
            nativeEvent: nativeEvent as globalThis.MouseEvent,
          });
        },
        { capture: true, once: true },
      );
      foreignButton.dispatchEvent(new foreignGlobal.MouseEvent("click", { bubbles: true }));
      const foreignList = foreignDocument.createElement("ul");
      const foreignListButton = foreignDocument.createElement("button");
      foreignList.append(foreignListButton);
      foreignDocument.body.append(foreignList);
      const foreignPreventDefault = vi.fn();
      foreignListButton.addEventListener(
        "keydown",
        (nativeEvent) => {
          staleExpandedKey({
            key: "ArrowDown",
            currentTarget: list,
            target: nativeEvent.target ?? foreignListButton,
            nativeEvent: nativeEvent as globalThis.KeyboardEvent,
            preventDefault: foreignPreventDefault,
          });
        },
        { capture: true, once: true },
      );
      foreignListButton.dispatchEvent(new foreignGlobal.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(select).not.toHaveBeenCalled();
      expect(foreignPreventDefault).not.toHaveBeenCalled();
      iframe.remove();

      expandedToggleHandler = staleExpandedToggle;
      toggle.addEventListener(
        "click",
        (nativeEvent) => {
          const replayEvent: CapturedClickEvent = {
            currentTarget: toggle,
            target: nativeEvent.target ?? toggle,
            nativeEvent: nativeEvent as globalThis.MouseEvent,
          };
          staleShow(replayEvent);
          expandedToggleEvent = replayEvent;
          staleExpandedToggle(replayEvent);
          staleExpandedToggle(replayEvent);
        },
        { capture: true, once: true },
      );
      fireEvent.click(toggle);
      expect(expandedToggle).toHaveBeenCalledTimes(2);
      expandedToggleEvent = null;

      headingHandler = staleExpandedHeading;
      buttons[1].addEventListener(
        "click",
        (nativeEvent) => {
          const replayEvent: CapturedClickEvent = {
            currentTarget: buttons[1],
            target: nativeEvent.target ?? buttons[1],
            nativeEvent: nativeEvent as globalThis.MouseEvent,
          };
          headingEvent = replayEvent;
          staleExpandedHeading(replayEvent);
          staleExpandedHeading(replayEvent);
        },
        { capture: true, once: true },
      );
      fireEvent.click(buttons[1]);
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenLastCalledWith(headings[1]);
      headingEvent = null;

      buttons.at(-1)!.focus();
      const repeatedKey = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      const repeatedPreventDefault = vi.spyOn(repeatedKey, "preventDefault");
      buttons.at(-1)!.addEventListener(
        "keydown",
        (nativeEvent) => {
          const replayEvent = {
            type: "keydown",
            key: "ArrowDown",
            currentTarget: list,
            target: nativeEvent.target ?? buttons.at(-1)!,
            nativeEvent: nativeEvent as globalThis.KeyboardEvent,
            altKey: nativeEvent.altKey,
            ctrlKey: nativeEvent.ctrlKey,
            metaKey: nativeEvent.metaKey,
            shiftKey: nativeEvent.shiftKey,
            repeat: nativeEvent.repeat,
            isComposing: nativeEvent.isComposing,
            defaultPrevented: nativeEvent.defaultPrevented,
            preventDefault: () => nativeEvent.preventDefault(),
          };
          staleExpandedKey(replayEvent);
          staleExpandedKey(replayEvent);
        },
        { capture: true, once: true },
      );
      act(() => buttons.at(-1)!.dispatchEvent(repeatedKey));
      expect(repeatedPreventDefault).toHaveBeenCalledOnce();
      expect(buttons[0]).toHaveFocus();

      let currentNav = within(host).getByRole("navigation", { name: "Document outline" });
      let currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
      fireEvent.keyDown(currentButtons[0], { key: "End" });
      expect(currentButtons.at(-1)).toHaveFocus();
      currentNav = within(host).getByRole("navigation", { name: "Document outline" });
      currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
      fireEvent.keyDown(currentButtons.at(-1)!, { key: "Home" });
      expect(currentButtons[0]).toHaveFocus();

      const currentRoot = within(host).getByTestId("outline");
      const currentToggle = within(host).getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
      currentNav = within(host).getByRole("navigation", { name: "Document outline" });
      const currentList = currentNav.querySelector("ul");
      if (!currentList) throw new Error("Current Strict outline list was not rendered");
      currentButtons = within(currentNav).getAllByRole<HTMLButtonElement>("button");
      const currentItems = currentButtons.map((button) => button.parentElement as HTMLLIElement);
      staleExpandedRootRef(null);
      staleExpandedToggleRef(null);
      staleExpandedNavRef(null);
      staleExpandedListRef(null);
      staleExpandedItemRefs.forEach((ref) => ref(null));
      staleExpandedButtonRefs.forEach((ref) => ref(null));
      staleExpandedRootRef(currentRoot);
      staleExpandedToggleRef(currentToggle);
      staleExpandedNavRef(currentNav);
      staleExpandedListRef(currentList);
      staleExpandedItemRefs.forEach((ref, index) => ref(currentItems[index]));
      staleExpandedButtonRefs.forEach((ref, index) => ref(currentButtons[index]));

      currentButtons[1].addEventListener(
        "click",
        (nativeEvent) => {
          staleExpandedHeading({
            currentTarget: currentButtons[1],
            target: nativeEvent.target ?? currentButtons[1],
            nativeEvent: nativeEvent as globalThis.MouseEvent,
          });
        },
        { capture: true, once: true },
      );
      fireEvent.click(currentButtons[1]);
      expect(select).toHaveBeenCalledTimes(2);
      expect(select).toHaveBeenLastCalledWith(headings[1]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("rejects an equal-looking unmounted presentation and admits its remount", () => {
    const headings = loadHeadings();
    session.localCursor.rich = headings[0].from;
    const toggleA = vi.fn();
    const selectA = vi.fn();
    const toggleB = vi.fn();
    const selectB = vi.fn();
    const rendered = render(
      <div key="a">
        <OutlinePanel session={session} open onToggle={toggleA} onSelect={selectA} />
      </div>,
    );
    const toggleElementA = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const buttonA = screen.getByRole<HTMLButtonElement>("button", { name: "Second" });
    const staleToggle = reactHandler<CapturedClick>(toggleElementA, "onClick");
    const staleSelect = reactHandler<CapturedClick>(buttonA, "onClick");

    rendered.rerender(
      <section key="b">
        <OutlinePanel session={session} open onToggle={toggleB} onSelect={selectB} />
      </section>,
    );
    const toggleElementB = screen.getByRole<HTMLButtonElement>("button", { name: "Hide outline" });
    const buttonB = screen.getByRole<HTMLButtonElement>("button", { name: "Second" });
    staleToggle({ currentTarget: toggleElementB });
    staleSelect({ currentTarget: buttonB });
    expect(toggleA).not.toHaveBeenCalled();
    expect(selectA).not.toHaveBeenCalled();

    fireEvent.click(toggleElementB);
    fireEvent.click(buttonB);
    expect(toggleB).toHaveBeenCalledOnce();
    expect(selectB).toHaveBeenCalledOnce();
    expect(selectB.mock.calls[0][0]).toBe(headings[1]);
  });
});
