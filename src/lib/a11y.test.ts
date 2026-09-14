// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstTabbable, focusReturnTarget, gridCell, restoreFocus, rovingIndex } from "./a11y";

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

describe("gridCell (insert-table size picker, 6 × 8)", () => {
  const at = (row: number, col: number) => ({ row, col });

  it("ignores non-navigation keys and empty grids", () => {
    expect(gridCell("Enter", at(0, 0), 6, 8)).toBeNull();
    expect(gridCell("Tab", at(0, 0), 6, 8)).toBeNull();
    expect(gridCell("a", at(0, 0), 6, 8)).toBeNull();
    expect(gridCell("ArrowRight", at(0, 0), 0, 8)).toBeNull();
    expect(gridCell("ArrowRight", at(0, 0), 6, 0)).toBeNull();
  });

  it("arrows move one cell and clamp at the edges (the issue's ArrowRight ×2, ArrowDown ×2 → 3 by 3)", () => {
    let cell = at(0, 0);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown"]) cell = gridCell(key, cell, 6, 8)!;
    expect(cell).toEqual(at(2, 2));
    expect(gridCell("ArrowLeft", at(2, 0), 6, 8)).toEqual(at(2, 0));
    expect(gridCell("ArrowUp", at(0, 3), 6, 8)).toEqual(at(0, 3));
    expect(gridCell("ArrowRight", at(1, 7), 6, 8)).toEqual(at(1, 7));
    expect(gridCell("ArrowDown", at(5, 7), 6, 8)).toEqual(at(5, 7));
  });

  it("Home / End stay in the row; with Ctrl they jump to the grid's corners", () => {
    expect(gridCell("Home", at(2, 5), 6, 8)).toEqual(at(2, 0));
    expect(gridCell("End", at(2, 5), 6, 8)).toEqual(at(2, 7));
    expect(gridCell("Home", at(2, 5), 6, 8, { ctrl: true })).toEqual(at(0, 0));
    expect(gridCell("End", at(2, 5), 6, 8, { ctrl: true })).toEqual(at(5, 7));
  });

  it("clamps an off-grid position before moving", () => {
    expect(gridCell("ArrowDown", at(-1, 20), 6, 8)).toEqual(at(1, 7));
    expect(gridCell("ArrowUp", at(9, 9), 6, 8)).toEqual(at(4, 7));
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

  it.each([
    ["hidden control", '<input id="unavailable" style="visibility:hidden" />'],
    ["inherited hidden visibility", '<div style="visibility:hidden"><input id="unavailable" /></div>'],
    ["collapsed visibility", '<input id="unavailable" style="visibility:collapse" />'],
    ["inert control", '<input id="unavailable" inert />'],
    ["inert subtree", '<div inert><input id="unavailable" /></div>'],
    ["disabled fieldset", '<fieldset disabled><input id="unavailable" /></fieldset>'],
    ["later legend", '<fieldset disabled><legend>First</legend><legend><input id="unavailable" /></legend></fieldset>'],
    ["nested first legend outside the outer first legend", '<fieldset disabled><legend>Outer</legend><fieldset><legend><input id="unavailable" /></legend></fieldset></fieldset>'],
    ["disabled nested fieldset inside the outer first legend", '<fieldset disabled><legend><fieldset disabled><legend>Inner</legend><input id="unavailable" /></fieldset></legend></fieldset>'],
  ])("skips a rendered %s without trying to focus it", (_, unavailable) => {
    const root = mount(`<div>${unavailable}<input id="available" /></div>`);
    const first = root.querySelector<HTMLInputElement>("#unavailable")!;
    const second = root.querySelector<HTMLInputElement>("#available")!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const html = root.innerHTML;
    const active = document.activeElement;
    expect(first.disabled).toBe(false);
    expect(first.getClientRects().length).toBeGreaterThan(0);
    expect(firstTabbable(root)).toBe(second);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(active);
    expect(root.innerHTML).toBe(html);
  });

  it.each([
    ["first legend", '<fieldset disabled><legend><input id="eligible" /></legend><input /></fieldset>'],
    ["nested first legends", '<fieldset disabled><legend><fieldset disabled><legend><input id="eligible" /></legend></fieldset></legend></fieldset>'],
    ["visible override", '<div style="visibility:hidden"><input id="eligible" style="visibility:visible" /></div>'],
    ["aria-disabled", '<input id="eligible" aria-disabled="true" />'],
    ["aria-hidden", '<input id="eligible" aria-hidden="true" />'],
    ["zero opacity", '<input id="eligible" style="opacity:0" />'],
    ["DOM order rather than positive tabindex order", '<input id="eligible" tabindex="3" /><input tabindex="1" />'],
  ])("keeps the first eligible control with %s", (_, eligible) => {
    const root = mount(`<div>${eligible}<input /></div>`);
    const first = root.querySelector<HTMLInputElement>("#eligible")!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    expect(first.matches(":disabled")).toBe(false);
    expect(firstTabbable(root)).toBe(first);
    expect(focus).not.toHaveBeenCalled();
  });

  it("skips an inert ancestor outside the search root", () => {
    const ancestor = mount('<div inert><section><input /></section></div>');
    const root = ancestor.querySelector("section")!;
    expect(root.querySelector("input")!.getClientRects().length).toBeGreaterThan(0);
    expect(firstTabbable(root)).toBeNull();
  });

  it("returns null when every rendered candidate is unavailable", () => {
    const root = mount(`<div>
      <input style="visibility:hidden" />
      <input style="visibility:collapse" />
      <div inert><input /></div>
      <fieldset disabled><input /></fieldset>
    </div>`);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    expect(firstTabbable(root)).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  it("returns null when nothing in the body is tabbable, so the caller keeps the default", () => {
    const root = mount(`<div><div data-focus-skip><button>Close</button></div><ul><li>Ctrl+B</li></ul></div>`);
    expect(firstTabbable(root)).toBeNull();
    expect(firstTabbable(null)).toBeNull();
  });
});

describe("focusReturnTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const mount = (html: string) => {
    document.body.innerHTML = html;
  };

  it("is the focused element itself for a toolbar button or an editor pane", () => {
    mount(`<div role="toolbar"><button id="image">Image</button></div><div id="rich" contenteditable="true" tabindex="0"></div>`);
    document.getElementById("image")!.focus();
    expect(focusReturnTarget()?.id).toBe("image");
    document.getElementById("rich")!.focus();
    expect(focusReturnTarget()?.id).toBe("rich");
  });

  it("resolves a menu item to the trigger that controls the menu (Radix: aria-controls while open)", () => {
    mount(`<button id="trigger" aria-controls="menu-1" aria-expanded="true" data-testid="more-menu">⋮</button>
      <div role="menu" id="menu-1" aria-labelledby="trigger"><div role="menuitem" tabindex="-1" id="item">Keyboard shortcuts</div></div>`);
    document.getElementById("item")!.focus();
    expect(document.activeElement?.id).toBe("item");
    expect(focusReturnTarget()?.id).toBe("trigger");
  });

  it("falls back to the menu's aria-labelledby when aria-controls is already gone", () => {
    mount(`<button id="trigger">⋮</button>
      <div role="menu" id="menu-1" aria-labelledby="trigger"><div role="menuitemradio" tabindex="-1" id="item">Heading 1</div></div>`);
    document.getElementById("item")!.focus();
    expect(focusReturnTarget()?.id).toBe("trigger");
  });

  it("keeps the menu item when no trigger can be found, and is null for <body>", () => {
    mount(`<div role="menu"><div role="menuitem" tabindex="-1" id="item">Orphan</div></div>`);
    document.getElementById("item")!.focus();
    expect(focusReturnTarget()?.id).toBe("item");
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    expect(focusReturnTarget()).toBeNull();
  });
});

describe("restoreFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("focuses the remembered element once the closed dialog has let go of focus", () => {
    document.body.innerHTML = `<button id="trigger">⋮</button>`;
    const trigger = document.getElementById("trigger")!;
    expect(document.activeElement).toBe(document.body);
    expect(restoreFocus(trigger)).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves focus alone when a closing handler already placed it, and does nothing for a detached or missing element", () => {
    document.body.innerHTML = `<button id="trigger">⋮</button><div id="rich" tabindex="0"></div>`;
    const trigger = document.getElementById("trigger")!;
    const rich = document.getElementById("rich")!;
    rich.focus();
    expect(restoreFocus(trigger)).toBe(false);
    expect(document.activeElement).toBe(rich);
    rich.blur();
    const detached = document.createElement("button");
    expect(restoreFocus(detached)).toBe(false);
    expect(restoreFocus(null)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
