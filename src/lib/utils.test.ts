import { describe, expect, it } from "vitest";
import { findReplaceShortcut, findShortcutAction, type FindShortcutKey } from "./utils";

const press = (overrides: Partial<FindShortcutKey> & Pick<FindShortcutKey, "key">): FindShortcutKey => ({
  code: `Key${overrides.key.toUpperCase()}`,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("findReplaceShortcut", () => {
  it("is Ctrl+H on Windows and Linux", () => {
    expect(findReplaceShortcut(false)).toBe("Mod-H");
  });

  it("is ⌥⌘F on a Mac, where ⌘H hides the application", () => {
    expect(findReplaceShortcut(true)).toBe("Mod-Alt-F");
  });

  it("defaults to the current platform", () => {
    // vitest runs in Node (no `navigator.platform` match), so the default is the Windows/Linux binding.
    expect(findReplaceShortcut()).toBe("Mod-H");
  });
});

describe("findShortcutAction", () => {
  describe("Windows / Linux", () => {
    it("Ctrl+F finds", () => {
      expect(findShortcutAction(press({ key: "f", ctrlKey: true }), false)).toBe("find");
      expect(findShortcutAction(press({ key: "F", ctrlKey: true }), false)).toBe("find");
    });

    it("Ctrl+H finds and replaces", () => {
      expect(findShortcutAction(press({ key: "h", ctrlKey: true }), false)).toBe("replace");
    });

    it("Ctrl+Alt+F and Ctrl+Alt+H are left to the layout (AltGr guard)", () => {
      expect(findShortcutAction(press({ key: "f", ctrlKey: true, altKey: true }), false)).toBeNull();
      expect(findShortcutAction(press({ key: "h", ctrlKey: true, altKey: true }), false)).toBeNull();
    });

    it("Ctrl+Shift+F and Ctrl+Shift+H do nothing", () => {
      expect(findShortcutAction(press({ key: "F", ctrlKey: true, shiftKey: true }), false)).toBeNull();
      expect(findShortcutAction(press({ key: "H", ctrlKey: true, shiftKey: true }), false)).toBeNull();
    });

    it("a bare letter or another Ctrl combination does nothing", () => {
      expect(findShortcutAction(press({ key: "f" }), false)).toBeNull();
      expect(findShortcutAction(press({ key: "h" }), false)).toBeNull();
      expect(findShortcutAction(press({ key: "g", ctrlKey: true }), false)).toBeNull();
    });
  });

  describe("Mac", () => {
    it("⌘F finds", () => {
      expect(findShortcutAction(press({ key: "f", metaKey: true }), true)).toBe("find");
    });

    it("⌥⌘F finds and replaces even though Option turns `key` into ƒ", () => {
      expect(findShortcutAction(press({ key: "ƒ", code: "KeyF", metaKey: true, altKey: true }), true)).toBe("replace");
      expect(findShortcutAction(press({ key: "f", code: "KeyF", metaKey: true, altKey: true }), true)).toBe("replace");
    });

    it("⌘H is not bound (macOS hides the application)", () => {
      expect(findShortcutAction(press({ key: "h", metaKey: true }), true)).toBeNull();
    });

    it("⇧⌘F, ⌥⌘ with another key and a bare ⌥F do nothing", () => {
      expect(findShortcutAction(press({ key: "F", metaKey: true, shiftKey: true }), true)).toBeNull();
      expect(findShortcutAction(press({ key: "µ", code: "KeyM", metaKey: true, altKey: true }), true)).toBeNull();
      expect(findShortcutAction(press({ key: "ƒ", code: "KeyF", altKey: true }), true)).toBeNull();
    });
  });
});
