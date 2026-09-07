// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useLayoutEffect } from "react";
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

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.tagName}`);
  return handler as T;
}

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
    expect(first).toHaveAttribute("type", "button");
    expect(first).toHaveStyle({ paddingLeft: "24px" });
    expect(second).toHaveStyle({ paddingLeft: "38px" });
    expect(within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole("button").filter((button) => button.tabIndex === 0)).toEqual([first]);
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
    expect(within(screen.getByRole("navigation", { name: "Document outline" })).getAllByRole("button").filter((button) => button.tabIndex === 0)).toEqual([third]);

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
      const previousButtons = within(previousNav).getAllByRole("button");
      const retiredHeading = reactHandler<() => void>(previousButtons[1], "onClick");
      const retiredToggle = reactHandler<() => void>(screen.getByRole("button", { name: "Hide outline" }), "onClick");
      const retiredKeyboard = reactHandler<
        (event: { key: string; currentTarget: HTMLUListElement; preventDefault: () => void }) => void
      >(previousList, "onKeyDown");
      const retiredPreventDefault = vi.fn();
      previousButtons[0].focus();
      focus.mockClear();

      const onBoundary = () => {
        const currentNav = screen.getByRole("navigation", { name: "Document outline" });
        const currentButtons = within(currentNav).getAllByRole("button");
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
          retiredHeading();
          retiredToggle();
          retiredKeyboard({ key: "ArrowDown", currentTarget: previousList, preventDefault: retiredPreventDefault });
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
      const currentButtons = within(currentNav).getAllByRole("button");
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
      fireEvent.click(screen.getByRole("button", { name: "Hide outline" }));
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
      const buttons = within(nav).getAllByRole("button");
      const retiredHeading = reactHandler<() => void>(buttons[1], "onClick");
      const retiredToggle = reactHandler<() => void>(screen.getByRole("button", { name: "Hide outline" }), "onClick");
      const retiredKeyboard = reactHandler<
        (event: { key: string; currentTarget: HTMLUListElement; preventDefault: () => void }) => void
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
              retiredHeading();
              retiredToggle();
              retiredKeyboard({ key: "ArrowDown", currentTarget: list, preventDefault: retiredPreventDefault });
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
});
