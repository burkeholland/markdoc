// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  readThemePreference,
  resolveTheme,
  setThemePreference,
  themeStore,
} from "./theme";

function fakeMatchMedia(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark") ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

// jsdom has no working `matchMedia`; each test installs a fake and `afterEach` puts the original property back
// (or removes the fake when there was none) so the stub does not outlive this file on the shared window.
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

function setMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { value: fakeMatchMedia(matches), configurable: true, writable: true });
}

function restoreMatchMedia() {
  if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
  else Reflect.deleteProperty(window, "matchMedia");
}

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    setMatchMedia(false);
  });
  afterEach(() => {
    restoreMatchMedia();
    localStorage.clear();
  });

  it("resolves system against the OS preference and pins explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("cycles system → light → dark → system", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("round-trips the preference through localStorage and applies the attribute", () => {
    expect(readThemePreference()).toBe("system");
    setThemePreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    setThemePreference("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    localStorage.setItem(THEME_STORAGE_KEY, "bogus");
    expect(readThemePreference()).toBe("system");
  });

  it("system mode follows matchMedia when applied", () => {
    setMatchMedia(true);
    expect(applyTheme("system")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("notifies subscribers when the preference changes", () => {
    const fn = vi.fn();
    const unsubscribe = themeStore.subscribe(fn);
    setThemePreference("dark");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(themeStore.getSnapshot()).toBe("dark");
    expect(themeStore.getServerSnapshot()).toBe("system");
    unsubscribe();
    setThemePreference("light");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe("boot script", () => {
    function run(stored: string | null, prefersDark: boolean) {
      const root = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
      const fn = new Function(
        "localStorage",
        "window",
        "document",
        THEME_BOOT_SCRIPT,
      );
      fn(
        { getItem: (k: string) => (k === THEME_STORAGE_KEY ? stored : null) },
        { matchMedia: (q: string) => ({ matches: q.includes("dark") && prefersDark }) },
        { documentElement: root },
      );
      return root.attrs["data-theme"];
    }

    it("applies the stored preference or the OS default before hydration", () => {
      expect(run(null, true)).toBe("dark");
      expect(run(null, false)).toBe("light");
      expect(run("dark", false)).toBe("dark");
      expect(run("light", true)).toBe("light");
      expect(run("system", true)).toBe("dark");
      expect(run("garbage", false)).toBe("light");
    });

    it("falls back to light when storage throws", () => {
      const root = { attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
      const fn = new Function("localStorage", "window", "document", THEME_BOOT_SCRIPT);
      fn(
        { getItem: () => { throw new Error("denied"); } },
        { matchMedia: () => ({ matches: true }) },
        { documentElement: root },
      );
      expect(root.attrs["data-theme"]).toBe("light");
    });
  });
});
