// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstTabbable, rovingIndex } from "./a11y";

describe("rovingIndex", () => {
  it("ignores non-navigation keys and empty lists", () => {
    expect(rovingIndex("a", 0, 5)).toBe(-1);
    expect(rovingIndex("Enter", 0, 5)).toBe(-1);
    expect(rovingIndex("ArrowDown", 0, 0)).toBe(-1);
    expect(rovingIndex("Home", 0, 0)).toBe(-1);
  });

  it("vertical without wrap clamps at both ends (outline)", () => {
    expect(rovingIndex("ArrowDown", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowDown", 2, 3)).toBe(2);
    expect(rovingIndex("ArrowUp", 2, 3)).toBe(1);
    expect(rovingIndex("ArrowUp", 0, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 1, 3)).toBe(-1);
    expect(rovingIndex("ArrowRight", 1, 3)).toBe(-1);
    // Focus not on any item yet: both arrows land on the first item.
    expect(rovingIndex("ArrowDown", -1, 3)).toBe(0);
    expect(rovingIndex("ArrowUp", -1, 3)).toBe(0);
  });

  it("horizontal with wrap cycles (toolbar)", () => {
    const opts = { orientation: "horizontal", wrap: true } as const;
    expect(rovingIndex("ArrowRight", 0, 3, opts)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowLeft", 0, 3, opts)).toBe(2);
    expect(rovingIndex("ArrowLeft", 1, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowDown", 1, 3, opts)).toBe(-1);
    expect(rovingIndex("ArrowUp", 1, 3, opts)).toBe(-1);
    expect(rovingIndex("ArrowRight", -1, 3, opts)).toBe(0);
    expect(rovingIndex("ArrowLeft", -1, 3, opts)).toBe(2);
  });

  it("Home and End jump regardless of orientation", () => {
    expect(rovingIndex("Home", 2, 4)).toBe(0);
    expect(rovingIndex("End", 0, 4)).toBe(3);
    expect(rovingIndex("Home", 2, 4, { orientation: "horizontal", wrap: true })).toBe(0);
    expect(rovingIndex("End", 0, 4, { orientation: "horizontal", wrap: true })).toBe(3);
  });
});

describe("firstTabbable", () => {
  // jsdom does no layout; treat everything as rendered unless it is display:none (like the browser).
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const hidden = this instanceof HTMLElement && this.style.display === "none";
      return (hidden ? [] : [{}]) as unknown as DOMRectList;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const mount = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
  };

  it("skips the dialog header (Close button) and lands on the first form control", () => {
    const root = mount(`<div>
      <div data-focus-skip><h2>Name this version</h2><button aria-label="Close">x</button></div>
      <form><input data-testid="version-name" /><button type="button">Cancel</button><button type="submit" disabled>Save</button></form>
    </div>`);
    expect(firstTabbable(root)?.getAttribute("data-testid")).toBe("version-name");
  });

  it("passes over disabled, tabindex=-1 and display:none controls", () => {
    const root = mount(`<div>
      <button disabled>Nope</button>
      <input tabindex="-1" />
      <input type="file" style="display:none" />
      <input type="hidden" />
      <a>no href</a>
      <a href="#x" id="link">yes</a>
    </div>`);
    expect(firstTabbable(root)?.id).toBe("link");
  });

  it("returns null when nothing in the body is tabbable, so the caller keeps the default", () => {
    const root = mount(`<div><div data-focus-skip><button>Close</button></div><ul><li>Ctrl+B</li></ul></div>`);
    expect(firstTabbable(root)).toBeNull();
    expect(firstTabbable(null)).toBeNull();
  });
});
