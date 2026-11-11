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
  type ResolvedTheme,
  type ThemePreference,
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
    vi.restoreAllMocks();
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

  describe("cross-tab storage reset", () => {
    function dispatchAndExpect(
      event: StorageEvent,
      preference: ThemePreference,
      resolved: ResolvedTheme,
      notifications: number,
    ) {
      const subscriber = vi.fn(() => themeStore.getSnapshot());
      const unsubscribe = themeStore.subscribe(subscriber);
      try {
        const attribute = vi.spyOn(document.documentElement, "setAttribute");
        const sideEffects = [
          vi.spyOn(Storage.prototype, "setItem"),
          vi.spyOn(Storage.prototype, "removeItem"),
          vi.spyOn(Storage.prototype, "clear"),
          vi.spyOn(themeStore, "subscribe"),
          vi.spyOn(EventTarget.prototype, "addEventListener"),
          vi.spyOn(window, "setTimeout"),
          vi.spyOn(window, "setInterval"),
          vi.spyOn(window, "requestAnimationFrame"),
          vi.spyOn(globalThis, "fetch"),
          vi.spyOn(XMLHttpRequest.prototype, "open"),
          vi.spyOn(XMLHttpRequest.prototype, "send"),
        ];
        vi.mocked(window.matchMedia).mockClear();

        window.dispatchEvent(event);

        expect(subscriber).toHaveBeenCalledTimes(notifications);
        expect(subscriber.mock.results.map((result) => result.value))
          .toEqual(Array.from({ length: notifications }, () => preference));
        expect(themeStore.getSnapshot()).toBe(preference);
        expect(document.documentElement).toHaveAttribute("data-theme", resolved);
        expect(attribute).toHaveBeenCalledTimes(notifications);
        for (const effect of sideEffects) expect(effect).not.toHaveBeenCalled();
        for (const result of vi.mocked(window.matchMedia).mock.results) {
          expect(result.value.addEventListener).not.toHaveBeenCalled();
          expect(result.value.addListener).not.toHaveBeenCalled();
        }
      } finally {
        unsubscribe();
      }
    }

    it.each([
      ["light", true, "dark"],
      ["dark", false, "light"],
    ] as const)("returns pinned %s to system with OS dark=%s after localStorage clear", (initial, prefersDark, resolved) => {
      setMatchMedia(prefersDark);
      setThemePreference(initial);
      localStorage.clear();

      dispatchAndExpect(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
        "system",
        resolved,
        1,
      );
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    });

    it.each(["local", "synthetic"] as const)(
      "preserves %s keyed theme changes and removals",
      (source) => {
        setMatchMedia(true);
        setThemePreference("light");
        const event = () => new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          storageArea: source === "local" ? localStorage : null,
        });
        localStorage.setItem(THEME_STORAGE_KEY, "dark");
        dispatchAndExpect(event(), "dark", "dark", 1);
        vi.restoreAllMocks();

        localStorage.removeItem(THEME_STORAGE_KEY);
        dispatchAndExpect(event(), "system", "dark", 1);
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
      },
    );

    it.each(["unrelated key", "session clear", "null area"] as const)(
      "ignores %s",
      (source) => {
        setMatchMedia(true);
        setThemePreference("light");
        if (source === "unrelated key") localStorage.setItem("unrelated", "changed");
        else if (source === "session clear") sessionStorage.clear();
        else localStorage.clear();

        dispatchAndExpect(
          new StorageEvent("storage", {
            key: source === "unrelated key" ? "unrelated" : null,
            storageArea: source === "unrelated key" ? localStorage
              : source === "session clear" ? sessionStorage : null,
          }),
          source === "null area" ? "system" : "light",
          "light",
          0,
        );
      },
    );

    it.each(["local", "null"] as const)(
      "ignores %s clear events when localStorage access is denied",
      (source) => {
        setMatchMedia(true);
        setThemePreference("light");
        localStorage.clear();
        const event = new StorageEvent("storage", {
          key: null,
          storageArea: source === "local" ? localStorage : null,
        });
        vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
          throw new DOMException("Storage access denied", "SecurityError");
        });

        dispatchAndExpect(event, "system", "light", 0);
      },
    );
  });

  describe("boot script", () => {
    type StorageMode = "available" | "denied getter" | "throwing getItem";
    type MediaMode = "available" | "missing" | "throwing call" | "denied getter";

    function run(
      stored: string | null,
      prefersDark: boolean,
      storageMode: StorageMode = "available",
      mediaMode: MediaMode = "available",
    ) {
      const attrs: Record<string, string> = {};
      const root = { setAttribute: vi.fn((k: string, v: string) => { attrs[k] = v; }) };
      const sideEffect = vi.fn();
      const getItem = vi.fn((k: string) => {
        if (storageMode === "throwing getItem") throw new Error("Storage read denied");
        return k === THEME_STORAGE_KEY ? stored : null;
      });
      const storageAccess = vi.fn(() => {
        if (storageMode === "denied getter") throw new DOMException("Storage access denied", "SecurityError");
        return { getItem, setItem: sideEffect, removeItem: sideEffect, clear: sideEffect };
      });
      const matchMedia = vi.fn(() => {
        if (mediaMode === "throwing call") throw new Error("Media query unavailable");
        return { matches: prefersDark, addEventListener: sideEffect, addListener: sideEffect };
      });
      const mediaAccess = vi.fn(() => {
        if (mediaMode === "denied getter") throw new Error("Media access denied");
        return mediaMode === "missing" ? undefined : matchMedia;
      });
      const scope = {
        get localStorage() { return storageAccess(); },
        get matchMedia() { return mediaAccess(); },
        document: { documentElement: root },
        addEventListener: sideEffect,
        setTimeout: sideEffect,
        setInterval: sideEffect,
        requestAnimationFrame: sideEffect,
        fetch: sideEffect,
        XMLHttpRequest: sideEffect,
      };
      // Resolve unqualified localStorage through the isolated window getter, without changing shared globals.
      const fn = new Function("window", `with (window) { ${THEME_BOOT_SCRIPT} }`);
      fn(scope);

      expect(root.setAttribute).toHaveBeenCalledExactlyOnceWith("data-theme", attrs["data-theme"]);
      expect(storageAccess).toHaveBeenCalledTimes(1);
      if (storageMode === "denied getter") expect(getItem).not.toHaveBeenCalled();
      else expect(getItem).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY);
      const explicit = storageMode === "available" && (stored === "light" || stored === "dark");
      expect(mediaAccess).toHaveBeenCalledTimes(explicit ? 0 : 1);
      if (!explicit && (mediaMode === "available" || mediaMode === "throwing call")) {
        expect(matchMedia).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
      } else {
        expect(matchMedia).not.toHaveBeenCalled();
      }
      expect(sideEffect).not.toHaveBeenCalled();
      return attrs["data-theme"];
    }

    it.each([
      ["light", "light", "light"],
      ["dark", "dark", "dark"],
      ["system", "light", "dark"],
      ["garbage", "light", "dark"],
      [null, "light", "dark"],
    ] as const)("applies stored %s or the OS default", (stored, lightOS, darkOS) => {
      expect(run(stored, false)).toBe(lightOS);
      expect(run(stored, true)).toBe(darkOS);
    });

    it.each(["denied getter", "throwing getItem"] as const)(
      "follows the OS preference with %s",
      (storageMode) => {
        expect(run(null, true, storageMode)).toBe("dark");
        expect(run(null, false, storageMode)).toBe("light");
      },
    );

    it.each(["missing", "throwing call", "denied getter"] as const)(
      "falls back to light in System mode with %s matchMedia",
      (mediaMode) => {
        for (const storageMode of ["available", "denied getter", "throwing getItem"] as const) {
          expect(run("system", true, storageMode, mediaMode)).toBe("light");
        }
      },
    );

    it.each(["available", "missing", "throwing call", "denied getter"] as const)(
      "preserves explicit preferences without accessing %s matchMedia",
      (mediaMode) => {
        expect(run("light", true, "available", mediaMode)).toBe("light");
        expect(run("dark", false, "available", mediaMode)).toBe("dark");
      },
    );

    it("does not hide or retry unrelated root write failures", () => {
      const error = new Error("Root write failed");
      const setAttribute = vi.fn(() => { throw error; });
      const fn = new Function("localStorage", "document", THEME_BOOT_SCRIPT);

      expect(() => fn(
        { getItem: () => "dark" },
        { documentElement: { setAttribute } },
      )).toThrow(error);
      expect(setAttribute).toHaveBeenCalledExactlyOnceWith("data-theme", "dark");
    });
  });

  describe("recovery resilience", () => {
    afterEach(() => { vi.restoreAllMocks(); restoreMatchMedia(); });

    it("falls back to system/light when storage and matchMedia throw", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
      Object.defineProperty(window, "matchMedia", { value: () => { throw new Error("nope"); }, configurable: true, writable: true });
      expect(readThemePreference()).toBe("system");
      expect(applyTheme("system")).toBe("light");
    });

    it("does not query matchMedia for explicit preferences", () => {
      setMatchMedia(true);
      expect(applyTheme("light")).toBe("light");
      expect(window.matchMedia).not.toHaveBeenCalled();
    });
  });
});
