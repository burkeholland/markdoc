// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadMenu } from "./download-menu";

const DOC_ID = "doc-919";
const NEXT_DOC_ID = "doc-920";
const FORMATS = ["md", "html", "pdf"] as const;
type Format = (typeof FORMATS)[number];

const downloadHref = (docId: string, format: Format) =>
  `/api/documents/${docId}/export?format=${format}&download=1`;

function BoundaryHarness({
  docId,
  present = true,
  instance = "menu",
  boundary = 0,
  onBoundary,
}: {
  docId: string;
  present?: boolean;
  instance?: string;
  boundary?: number;
  onBoundary?: () => void;
}) {
  useLayoutEffect(() => {
    if (boundary > 0) onBoundary?.();
  }, [boundary, onBoundary]);
  return present ? <DownloadMenu key={instance} docId={docId} /> : null;
}

function reactHandler<T>(element: HTMLElement, name: string): T {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (!propsKey) throw new Error(`React props were not attached to ${element.dataset.testid ?? element.tagName}`);
  const props = (element as unknown as Record<string, Record<string, unknown> | undefined>)[propsKey];
  const handler = props?.[name];
  if (typeof handler !== "function") throw new Error(`${name} was not attached to ${element.dataset.testid ?? element.tagName}`);
  return handler as T;
}

function reactRef<T extends HTMLElement>(element: T): (node: T | null) => void {
  const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (element as unknown as Record<string, { ref?: unknown }>)[propsKey]
    : undefined;
  if (typeof props?.ref === "function") return props.ref as (node: T | null) => void;
  const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  if (!fiberKey) throw new Error(`React fiber was not attached to ${element.dataset.testid ?? element.tagName}`);
  const fiber = (element as unknown as Record<string, { ref?: unknown }>)[fiberKey];
  if (typeof fiber?.ref !== "function") throw new Error(`React ref was not attached to ${element.dataset.testid ?? element.tagName}`);
  return fiber.ref as (node: T | null) => void;
}

type ToggleClick = (event: { currentTarget: HTMLButtonElement }) => void;
type LinkClick = (event: { currentTarget: HTMLAnchorElement }) => void;
type ToggleKey = (event: {
  currentTarget: HTMLButtonElement;
  target: EventTarget;
  key: string;
  preventDefault: () => void;
}) => void;
type ListKey = (event: {
  currentTarget: HTMLDivElement;
  target: EventTarget;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
}) => void;
type RootKey = (event: {
  currentTarget: HTMLDivElement;
  target: EventTarget;
  key: string;
  preventDefault: () => void;
}) => void;
type RootBlur = (event: {
  currentTarget: HTMLDivElement;
  target: EventTarget;
  relatedTarget: EventTarget | null;
}) => void;

function keyEvent<E extends HTMLElement>(currentTarget: E, target: EventTarget, key: string) {
  return {
    currentTarget,
    target,
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
  };
}

function menuElements() {
  const primary = screen.getByTestId("reader-download") as HTMLAnchorElement;
  const toggle = screen.getByTestId("reader-download-menu") as HTMLButtonElement;
  const list = screen.getByTestId("reader-download-list") as HTMLDivElement;
  const links = Object.fromEntries(
    FORMATS.map((format) => [
      format,
      screen.getByTestId(`reader-download-${format}`) as HTMLAnchorElement,
    ]),
  ) as Record<Format, HTMLAnchorElement>;
  const root = primary.parentElement;
  if (!(root instanceof HTMLDivElement)) throw new Error("Download root was not rendered");
  return { root, primary, toggle, list, links };
}

function trackPointerListeners() {
  const active = new Set<EventListener>();
  const captured: EventListener[] = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown" && typeof listener === "function") {
      active.add(listener);
      captured.push(listener);
    }
    add(type, listener, options);
  });
  vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "pointerdown" && typeof listener === "function") active.delete(listener);
    remove(type, listener, options);
  });
  return { active, captured };
}

function invokePointer(listener: EventListener | undefined, target: EventTarget) {
  if (!listener) throw new Error("Pointer listener was not installed");
  listener({ target } as unknown as Event);
}

function connectedElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const element = document.createElement(tag);
  document.body.append(element);
  return element;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("DownloadMenu presentation", () => {
  it("preserves the split button, exact routes, labels, and closed disclosure relationships", () => {
    render(<DownloadMenu docId={DOC_ID} />);
    const { primary, toggle, list, links } = menuElements();

    expect(primary).toHaveAttribute("href", downloadHref(DOC_ID, "md"));
    expect(primary).toHaveClass("btn", "btn-sm", "btn-outline", "reader-split-main", "gap-1.5");
    expect(primary).toHaveAccessibleName("Download Markdown");
    expect(within(primary).getByText("Download")).toHaveClass("hidden", "sm:inline");
    expect(screen.queryByRole("button", { name: "Download Markdown" })).not.toBeInTheDocument();
    expect(toggle).toHaveClass("btn", "btn-sm", "btn-outline", "reader-split-more");
    expect(toggle).toHaveAccessibleName("Download as…");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "reader-download-list");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    expect(list).toHaveAttribute("id", "reader-download-list");
    expect(list).not.toBeVisible();
    expect(list).toHaveClass("menu", "animate-fade-in", "absolute", "right-0", "top-full", "mt-1.5", "w-48");
    expect(Object.values(links)).toHaveLength(3);
    for (const format of FORMATS) {
      expect(links[format]).toHaveAttribute("href", downloadHref(DOC_ID, format));
    }

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
      fireEvent(primary, event);
      expect(preventedBeforeBrowserDefault).toBe(false);
    }
  });

  it("opens by click, focuses the exact first link once, and toggle-closes without refocusing", () => {
    const pointers = trackPointerListeners();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    let { toggle, list, links } = menuElements();

    fireEvent.click(toggle);
    ({ toggle, list, links } = menuElements());
    expect(list).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
    expect(pointers.active.size).toBe(1);

    focus.mockClear();
    fireEvent.click(toggle);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(focus).not.toHaveBeenCalled();
    expect(pointers.active.size).toBe(0);
  });

  it("opens by ArrowDown and gives Tab and unsupported toggle keys native behavior", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    const { toggle, list, links } = menuElements();

    const enter = fireEvent.keyDown(toggle, { key: "Enter" });
    const tab = fireEvent.keyDown(toggle, { key: "Tab" });
    expect(enter).toBe(true);
    expect(tab).toBe(true);
    expect(list).not.toBeVisible();

    expect(fireEvent.keyDown(toggle, { key: "ArrowDown" })).toBe(false);
    expect(list).toBeVisible();
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("moves through the exact ordered links with wrapping and leaves modifier and unsupported keys native", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { links } = menuElements();
    focus.mockClear();

    expect(fireEvent.keyDown(links.md, { key: "ArrowDown" })).toBe(false);
    expect(links.html).toHaveFocus();
    expect(fireEvent.keyDown(links.html, { key: "End" })).toBe(false);
    expect(links.pdf).toHaveFocus();
    expect(fireEvent.keyDown(links.pdf, { key: "ArrowDown" })).toBe(false);
    expect(links.md).toHaveFocus();
    expect(fireEvent.keyDown(links.md, { key: "ArrowUp" })).toBe(false);
    expect(links.pdf).toHaveFocus();
    expect(fireEvent.keyDown(links.pdf, { key: "Home" })).toBe(false);
    expect(links.md).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(5);

    focus.mockClear();
    expect(fireEvent.keyDown(links.md, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "PageDown" })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "ArrowDown", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(links.md, { key: "Home", shiftKey: true })).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(FORMATS)("lets the exact %s link keep native activation, close once, and refocus the exact toggle once", (format) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { toggle, list, links } = menuElements();
    focus.mockClear();
    let preventedBeforeBrowserDefault = true;
    document.addEventListener(
      "click",
      (event) => {
        preventedBeforeBrowserDefault = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(links[format]);

    expect(preventedBeforeBrowserDefault).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });

  it("handles exact Escape, outside blur, and outside pointer while retaining inside and null-focus behavior", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    const outside = connectedElement("button");
    fireEvent.click(menuElements().toggle);
    let { root, toggle, list, links } = menuElements();
    focus.mockClear();

    fireEvent.blur(links.md, { relatedTarget: null });
    expect(list).toBeVisible();
    fireEvent.blur(links.md, { relatedTarget: links.html });
    expect(list).toBeVisible();
    fireEvent.pointerDown(links.html);
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.blur(links.md, { relatedTarget: outside });
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    focus.mockClear();
    fireEvent.pointerDown(outside);
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    focus.mockClear();
    expect(fireEvent.keyDown(links.pdf, { key: "Escape" })).toBe(false);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith();
    expect(root).toContainElement(toggle);
  });
});

describe("DownloadMenu exact event sources", () => {
  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "accepts an exact toggle click once and ignores sibling, foreign, detached, and equal-looking sources (%s)",
    (order) => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      render(
        <>
          <DownloadMenu docId={DOC_ID} />
          <DownloadMenu docId={NEXT_DOC_ID} />
        </>,
      );
      const toggles = screen.getAllByTestId("reader-download-menu") as HTMLButtonElement[];
      const lists = screen.getAllByTestId("reader-download-list") as HTMLDivElement[];
      const exact = toggles[0]!;
      const sibling = toggles[1]!;
      const foreign = connectedElement("button");
      const detached = document.createElement("button");
      const replacement = exact.cloneNode(true) as HTMLButtonElement;
      document.body.append(replacement);
      const handler = reactHandler<ToggleClick>(exact, "onClick");
      const event = { currentTarget: order === "wrong-before-current" ? sibling : exact };
      focus.mockClear();

      act(() => {
        handler({ currentTarget: foreign });
        handler({ currentTarget: detached });
        handler({ currentTarget: replacement });
        handler(event);
        event.currentTarget = order === "wrong-before-current" ? exact : sibling;
        handler(event);
        event.currentTarget = exact;
        handler(event);
      });

      expect(lists[0]).toBeVisible();
      expect(lists[1]).not.toBeVisible();
      expect(screen.getAllByTestId("reader-download-md")[0]).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["wrong-before-current", "current-before-wrong"] as const)(
    "accepts an exact toggle ArrowDown once without consuming wrong sources (%s)",
    (order) => {
      render(<DownloadMenu docId={DOC_ID} />);
      const { toggle, list } = menuElements();
      const foreign = connectedElement("button");
      const detached = document.createElement("button");
      const replacement = toggle.cloneNode(true) as HTMLButtonElement;
      document.body.append(replacement);
      const handler = reactHandler<ToggleKey>(toggle, "onKeyDown");
      const event = keyEvent(
        order === "wrong-before-current" ? foreign : toggle,
        toggle,
        "ArrowDown",
      );

      act(() => {
        handler(keyEvent(detached, detached, "ArrowDown"));
        handler(keyEvent(replacement, replacement, "ArrowDown"));
        handler(event);
        event.currentTarget = order === "wrong-before-current" ? toggle : foreign;
        handler(event);
        event.currentTarget = toggle;
        handler(event);
      });

      expect(list).toBeVisible();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    },
  );

  it.each(FORMATS)("binds the %s callback to only its exact format element and href", (format) => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { toggle, list, links } = menuElements();
    const handler = reactHandler<LinkClick>(links[format], "onClick");
    const wrongFormat = links[FORMATS[(FORMATS.indexOf(format) + 1) % FORMATS.length]!]!;
    const foreign = connectedElement("a");
    foreign.href = links[format].href;
    const detached = links[format].cloneNode(true) as HTMLAnchorElement;
    const replacement = links[format].cloneNode(true) as HTMLAnchorElement;
    document.body.append(replacement);
    focus.mockClear();

    act(() => {
      handler({ currentTarget: wrongFormat });
      handler({ currentTarget: foreign });
      handler({ currentTarget: detached });
      handler({ currentTarget: replacement });
    });
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();

    act(() => handler({ currentTarget: links[format] }));
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("resolves list movement only from the exact list and exact published target, consuming an event once", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    const { list, links } = menuElements();
    const handler = reactHandler<ListKey>(list, "onKeyDown");
    const foreignList = connectedElement("div");
    const foreignLink = connectedElement("a");
    const detachedList = document.createElement("div");
    const detachedLink = document.createElement("a");
    const replacementList = list.cloneNode(true) as HTMLDivElement;
    document.body.append(replacementList);
    const replacementLink = replacementList.querySelector("a");
    if (!(replacementLink instanceof HTMLAnchorElement)) throw new Error("Replacement list link was not cloned");
    focus.mockClear();

    const wrongList = keyEvent(foreignList, links.md, "ArrowDown");
    const wrongTarget = keyEvent(list, foreignLink, "ArrowDown");
    const detached = keyEvent(detachedList, detachedLink, "ArrowDown");
    const replacement = keyEvent(replacementList, replacementLink, "ArrowDown");
    handler(wrongList);
    handler(wrongTarget);
    handler(detached);
    handler(replacement);
    expect(wrongList.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(detached.preventDefault).not.toHaveBeenCalled();
    expect(replacement.preventDefault).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    const exact = keyEvent(list, links.md, "ArrowDown");
    handler(exact);
    handler(exact);
    expect(exact.preventDefault).toHaveBeenCalledTimes(1);
    expect(links.html).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("binds Escape and blur to the exact root and exact event publication", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(<DownloadMenu docId={DOC_ID} />);
    fireEvent.click(menuElements().toggle);
    let { root, toggle, list, links } = menuElements();
    const rootKey = reactHandler<RootKey>(root, "onKeyDown");
    const rootBlur = reactHandler<RootBlur>(root, "onBlur");
    const foreignRoot = connectedElement("div");
    const foreignTarget = document.createElement("button");
    foreignRoot.append(foreignTarget);
    const detachedRoot = document.createElement("div");
    const detachedTarget = document.createElement("button");
    detachedRoot.append(detachedTarget);
    const outside = connectedElement("button");
    focus.mockClear();

    const wrongRoot = keyEvent(foreignRoot, foreignTarget, "Escape");
    const wrongTarget = keyEvent(root, foreignTarget, "Escape");
    const detached = keyEvent(detachedRoot, detachedTarget, "Escape");
    rootKey(wrongRoot);
    rootKey(wrongTarget);
    rootKey(detached);
    rootBlur({ currentTarget: foreignRoot, target: foreignTarget, relatedTarget: outside });
    rootBlur({ currentTarget: root, target: foreignTarget, relatedTarget: outside });
    rootBlur({ currentTarget: detachedRoot, target: detachedTarget, relatedTarget: outside });
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    expect(wrongRoot.preventDefault).not.toHaveBeenCalled();
    expect(wrongTarget.preventDefault).not.toHaveBeenCalled();
    expect(detached.preventDefault).not.toHaveBeenCalled();

    const exactEscape = keyEvent(root, links.pdf, "Escape");
    act(() => {
      rootKey(exactEscape);
      rootKey(exactEscape);
    });
    expect(exactEscape.preventDefault).toHaveBeenCalledTimes(1);
    expect(list).not.toBeVisible();
    expect(toggle).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    ({ root, toggle, list, links } = menuElements());
    focus.mockClear();
    const currentBlur = reactHandler<RootBlur>(root, "onBlur");
    currentBlur({ currentTarget: root, target: links.md, relatedTarget: null });
    currentBlur({ currentTarget: root, target: links.md, relatedTarget: links.html });
    expect(list).toBeVisible();
    expect(focus).not.toHaveBeenCalled();
    act(() => currentBlur({ currentTarget: root, target: links.md, relatedTarget: outside }));
    expect(list).not.toBeVisible();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("DownloadMenu publication replacement", () => {
  it.each(["stale-before-current", "current-before-stale"] as const)(
    "retires document A before the parent layout boundary and keeps B usable in %s order",
    (order) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const closedA = menuElements();
      const staleClosedToggle = reactHandler<ToggleClick>(closedA.toggle, "onClick");
      fireEvent.click(closedA.toggle);
      const openA = menuElements();
      const staleToggle = reactHandler<ToggleClick>(openA.toggle, "onClick");
      const staleLink = reactHandler<LinkClick>(openA.links.html, "onClick");
      const staleList = reactHandler<ListKey>(openA.list, "onKeyDown");
      const staleRootKey = reactHandler<RootKey>(openA.root, "onKeyDown");
      const staleRootBlur = reactHandler<RootBlur>(openA.root, "onBlur");
      const stalePointer = pointers.captured.at(-1);
      expect(pointers.active.size).toBe(1);

      view.rerender(
        <BoundaryHarness
          docId={NEXT_DOC_ID}
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );

      const closedB = menuElements();
      expect(boundaryListeners).toEqual([0]);
      expect(closedB.list).not.toBeVisible();
      expect(pointers.active.size).toBe(0);
      for (const format of FORMATS) {
        expect(closedB.links[format]).toHaveAttribute("href", downloadHref(NEXT_DOC_ID, format));
      }
      const currentToggle = reactHandler<ToggleClick>(closedB.toggle, "onClick");
      const activation = { currentTarget: closedB.toggle };
      focus.mockClear();
      act(() => {
        if (order === "stale-before-current") staleClosedToggle(activation);
        currentToggle(activation);
        if (order === "current-before-stale") staleClosedToggle(activation);
        staleClosedToggle(activation);
      });
      const openB = menuElements();
      expect(openB.list).toBeVisible();
      expect(openB.links.md).toHaveFocus();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(pointers.active.size).toBe(1);

      const outside = connectedElement("button");
      const staleListEvent = keyEvent(openB.list, openB.links.md, "ArrowDown");
      const staleEscape = keyEvent(openB.root, openB.links.md, "Escape");
      focus.mockClear();
      act(() => {
        staleToggle({ currentTarget: openB.toggle });
        staleLink({ currentTarget: openB.links.html });
        staleList(staleListEvent);
        staleRootKey(staleEscape);
        staleRootBlur({
          currentTarget: openB.root,
          target: openB.links.md,
          relatedTarget: outside,
        });
        invokePointer(stalePointer, outside);
      });
      expect(openB.list).toBeVisible();
      expect(staleListEvent.preventDefault).not.toHaveBeenCalled();
      expect(staleEscape.preventDefault).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(pointers.active.size).toBe(1);

      fireEvent.keyDown(openB.links.md, { key: "ArrowDown" });
      expect(openB.links.html).toHaveFocus();
      fireEvent.click(openB.links.html);
      expect(openB.list).not.toBeVisible();
      expect(openB.toggle).toHaveFocus();
    },
  );

  it.each(["root", "toggle", "list", "md", "html", "pdf"] as const)(
    "retires an exact %s callback-ref replacement and lets the successor own reused DOM",
    (part) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      fireEvent.click(menuElements().toggle);
      const previous = menuElements();
      const element =
        part === "root"
          ? previous.root
          : part === "toggle"
            ? previous.toggle
            : part === "list"
              ? previous.list
              : previous.links[part];
      const staleRef = reactRef(element);
      const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
      const stalePointer = pointers.captured.at(-1);
      const replacement = element.cloneNode(true) as typeof element;
      document.body.append(replacement);

      act(() => staleRef(replacement));
      expect(pointers.active.size).toBe(0);
      focus.mockClear();
      staleToggle({ currentTarget: previous.toggle });
      invokePointer(stalePointer, connectedElement("button"));
      expect(previous.list).toBeVisible();
      expect(focus).not.toHaveBeenCalled();
      replacement.remove();

      view.rerender(
        <BoundaryHarness
          docId={DOC_ID}
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const current = menuElements();
      expect(boundaryListeners).toEqual([1]);
      expect(current.list).toBeVisible();
      expect(pointers.active.size).toBe(1);
      focus.mockClear();
      act(() => staleRef(null));
      expect(current.list).toBeVisible();
      expect(pointers.active.size).toBe(1);
      expect(focus).not.toHaveBeenCalled();

      fireEvent.click(current.toggle);
      expect(current.list).not.toBeVisible();
      expect(pointers.active.size).toBe(0);
    },
  );

  it.each(["stale-before-current", "current-before-stale"] as const)(
    "isolates an equal-looking remount and its reused callback refs in %s order",
    (order) => {
      const pointers = trackPointerListeners();
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const boundaryListeners: number[] = [];
      const view = render(
        <BoundaryHarness
          docId={DOC_ID}
          instance="a"
          boundary={0}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      fireEvent.click(menuElements().toggle);
      const previous = menuElements();
      const staleRootRef = reactRef(previous.root);
      const staleToggleRef = reactRef(previous.toggle);
      const staleListRef = reactRef(previous.list);
      const staleLinkRef = reactRef(previous.links.md);
      const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
      const staleLink = reactHandler<LinkClick>(previous.links.md, "onClick");
      const stalePointer = pointers.captured.at(-1);

      view.rerender(
        <BoundaryHarness
          docId={DOC_ID}
          instance="b"
          boundary={1}
          onBoundary={() => boundaryListeners.push(pointers.active.size)}
        />,
      );
      const currentClosed = menuElements();
      expect(boundaryListeners).toEqual([0]);
      expect(currentClosed.root).not.toBe(previous.root);
      expect(currentClosed.list).not.toBeVisible();
      const currentToggle = reactHandler<ToggleClick>(currentClosed.toggle, "onClick");
      const activation = { currentTarget: currentClosed.toggle };
      act(() => {
        if (order === "stale-before-current") staleToggle(activation);
        currentToggle(activation);
        if (order === "current-before-stale") staleToggle(activation);
      });
      const current = menuElements();
      expect(current.list).toBeVisible();
      expect(current.links.md).toHaveFocus();
      expect(pointers.active.size).toBe(1);

      focus.mockClear();
      act(() => {
        staleRootRef(current.root);
        staleToggleRef(current.toggle);
        staleListRef(current.list);
        staleLinkRef(current.links.md);
        staleRootRef(null);
        staleToggleRef(null);
        staleListRef(null);
        staleLinkRef(null);
        staleLink({ currentTarget: current.links.md });
        invokePointer(stalePointer, connectedElement("button"));
      });
      expect(current.list).toBeVisible();
      expect(current.links.md).toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
      expect(pointers.active.size).toBe(1);

      fireEvent.click(current.links.pdf);
      expect(current.list).not.toBeVisible();
      expect(current.toggle).toHaveFocus();
    },
  );

  it("retires removal before the parent layout boundary and cannot be revived by stale refs or listeners", () => {
    const pointers = trackPointerListeners();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const boundaryListeners: number[] = [];
    const view = render(
      <BoundaryHarness
        docId={DOC_ID}
        boundary={0}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    fireEvent.click(menuElements().toggle);
    const previous = menuElements();
    const staleRootRef = reactRef(previous.root);
    const staleToggle = reactHandler<ToggleClick>(previous.toggle, "onClick");
    const staleLink = reactHandler<LinkClick>(previous.links.pdf, "onClick");
    const stalePointer = pointers.captured.at(-1);

    focus.mockClear();
    view.rerender(
      <BoundaryHarness
        docId={DOC_ID}
        present={false}
        boundary={1}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    act(() => {
      staleRootRef(previous.root);
      staleRootRef(null);
      staleToggle({ currentTarget: previous.toggle });
      staleLink({ currentTarget: previous.links.pdf });
      invokePointer(stalePointer, connectedElement("button"));
    });
    expect(boundaryListeners).toEqual([0]);
    expect(pointers.active.size).toBe(0);
    expect(focus).not.toHaveBeenCalled();

    view.rerender(
      <BoundaryHarness
        docId={NEXT_DOC_ID}
        instance="new"
        boundary={2}
        onBoundary={() => boundaryListeners.push(pointers.active.size)}
      />,
    );
    const current = menuElements();
    expect(boundaryListeners).toEqual([0, 0]);
    fireEvent.click(current.toggle);
    expect(current.list).toBeVisible();
    expect(current.links.md).toHaveFocus();
    expect(pointers.active.size).toBe(1);
  });
});
