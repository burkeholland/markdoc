// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINK_CARDS_STORAGE_KEY, linkCardsStore, readLinkCardsSetting, setLinkCardsSetting } from "./link-cards-setting";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the link cards setting (#2317)", () => {
  it("is stored under its own key, beside the theme", () => {
    expect(LINK_CARDS_STORAGE_KEY).toBe("markdoc:linkCards");
  });

  it("is on until this browser has stored off, and only the exact value off turns it off", () => {
    expect(readLinkCardsSetting()).toBe(true);
    for (const value of ["on", "true", "1", "", "OFF", "Off", " off", "off ", "false", "0", "null"]) {
      localStorage.setItem(LINK_CARDS_STORAGE_KEY, value);
      expect(readLinkCardsSetting(), JSON.stringify(value)).toBe(true);
    }
    localStorage.setItem(LINK_CARDS_STORAGE_KEY, "off");
    expect(readLinkCardsSetting()).toBe(false);
    localStorage.removeItem(LINK_CARDS_STORAGE_KEY);
    expect(readLinkCardsSetting()).toBe(true);
  });

  it("writes on or off and reads the same back", () => {
    setLinkCardsSetting(false);
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBe("off");
    expect(readLinkCardsSetting()).toBe(false);
    setLinkCardsSetting(true);
    expect(localStorage.getItem(LINK_CARDS_STORAGE_KEY)).toBe("on");
    expect(readLinkCardsSetting()).toBe(true);
    // Nothing else in the store is touched.
    localStorage.setItem("markdoc:theme", "dark");
    setLinkCardsSetting(false);
    expect(localStorage.getItem("markdoc:theme")).toBe("dark");
    expect(localStorage.length).toBe(2);
  });

  it("a browser that refuses its store gives the default and does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(readLinkCardsSetting()).toBe(true);
    expect(() => setLinkCardsSetting(false)).not.toThrow();
    expect(readLinkCardsSetting()).toBe(true);
  });

  it("tells its readers when it changes here or in another tab, and not for another key", () => {
    const heard = vi.fn();
    const stop = linkCardsStore.subscribe(heard);
    expect(linkCardsStore.getSnapshot()).toBe(true);
    // The server and the first render in the browser show the default.
    expect(linkCardsStore.getServerSnapshot()).toBe(true);

    setLinkCardsSetting(false);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(linkCardsStore.getSnapshot()).toBe(false);

    // Another tab turned it on again.
    localStorage.setItem(LINK_CARDS_STORAGE_KEY, "on");
    window.dispatchEvent(new StorageEvent("storage", { key: LINK_CARDS_STORAGE_KEY, newValue: "on" }));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(linkCardsStore.getSnapshot()).toBe(true);
    // Another tab cleared the whole store.
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(heard).toHaveBeenCalledTimes(3);
    // Another key: not ours.
    window.dispatchEvent(new StorageEvent("storage", { key: "markdoc:theme", newValue: "dark" }));
    expect(heard).toHaveBeenCalledTimes(3);

    stop();
    setLinkCardsSetting(false);
    expect(heard).toHaveBeenCalledTimes(3);
  });
});
