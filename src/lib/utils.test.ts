import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findReplaceShortcut, findShortcutAction, initials, type FindShortcutKey } from "./utils";

describe.each([false, true])("initials (native Segmenter absent=%s)", (nativeAbsent) => {
  beforeEach(() => {
    if (nativeAbsent) {
      vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
      expect(Intl.Segmenter).toBeUndefined();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["single letter", "a", "A"],
    ["single word", "ada", "AD"],
    ["two words", "Ada Lovelace", "AL"],
    ["many words", "Grace Brewster Hopper", "GH"],
    ["whitespace", "  grace\tbrewster\nhopper  ", "GH"],
    ["ASCII login", "octo-cat", "OC"],
    ["empty name", "", "?"],
    ["blank name", " \t\n ", "?"],
    ["decomposed first", "e\u0301lan Poe", "E\u0301P"],
    ["decomposed last", "Ada o\u0308rn", "AO\u0308"],
    ["supplementary first", "\u{10428}da Poe", "\u{10400}P"],
    ["supplementary last", "Ada \u{10428}oe", "A\u{10400}"],
    ["emoji first", "\u{1f469}\u200d\u{1f4bb} Ada", "\u{1f469}\u200d\u{1f4bb}A"],
    ["emoji last", "Ada \u{1f469}\u200d\u{1f4bb}", "A\u{1f469}\u200d\u{1f4bb}"],
    ["skin tone", "\u{1f44d}\u{1f3fd}", "\u{1f44d}\u{1f3fd}"],
    ["ZWJ family", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}"],
    ["flag", "\u{1f1fa}\u{1f1f8}", "\u{1f1fa}\u{1f1f8}"],
    ["variation selector", "\u2764\ufe0f", "\u2764\ufe0f"],
    ["two complete clusters", "\u{1f44d}\u{1f3fd}e\u0301x", "\u{1f44d}\u{1f3fd}E\u0301"],
    ["single-word uppercase expansion", "\u00dfeta", "SSE"],
    ["multi-word uppercase expansion", "\u00df \u00df", "SSSS"],
    ["Hangul Jamo", "\u1100\u1161\u11a8 Min", "\u1100\u1161\u11a8M"],
    ["SpacingMark", "\u0915\u093e Min", "\u0915\u093eM"],
    ["Prepend", "\u0600A Min", "\u0600AM"],
    ["Indic conjunct", "\u0915\u094d\u0937 Min", "\u0915\u094d\u0937M"],
    ["non-emoji ZWJ boundary", "a\u200dbcd", "A\u200dB"],
  ])("selects %s", (_description, name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});

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
