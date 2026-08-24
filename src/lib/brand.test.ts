// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_BOOT_SCRIPT, BRAND_STORAGE_KEY, readBrand, setBrand } from "./brand";

function run(search: string, stored: string | null) {
  const store = new Map<string, string>();
  if (stored !== null) store.set(BRAND_STORAGE_KEY, stored);
  const root = {
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    removeAttribute(k: string) {
      delete this.attrs[k];
    },
  };
  const fn = new Function("localStorage", "location", "document", "URLSearchParams", BRAND_BOOT_SCRIPT);
  fn(
    { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    { search },
    { documentElement: root },
    URLSearchParams,
  );
  return { attr: root.attrs["data-brand"], stored: store.get(BRAND_STORAGE_KEY) };
}

describe("brand switch", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-brand");
  });
  afterEach(() => localStorage.clear());

  it("boot script: nothing stored and no query → no data-brand (the current look stays the default)", () => {
    expect(run("", null)).toEqual({ attr: undefined, stored: undefined });
  });

  it("boot script: ?brand=a|b applies and remembers; the stored value applies on later loads", () => {
    expect(run("?brand=a", null)).toEqual({ attr: "a", stored: "a" });
    expect(run("?brand=b&x=1", "a")).toEqual({ attr: "b", stored: "b" });
    expect(run("", "b")).toEqual({ attr: "b", stored: "b" });
  });

  it("boot script: ?brand=off (or anything else) clears the stored choice", () => {
    expect(run("?brand=off", "a")).toEqual({ attr: undefined, stored: undefined });
    expect(run("?brand=", "b")).toEqual({ attr: undefined, stored: undefined });
    expect(run("", "garbage")).toEqual({ attr: undefined, stored: "garbage" });
  });

  it("boot script survives a storage that throws", () => {
    const root = { attrs: {} as Record<string, string>, setAttribute() {}, removeAttribute() {} };
    const fn = new Function("localStorage", "location", "document", "URLSearchParams", BRAND_BOOT_SCRIPT);
    expect(() =>
      fn(
        {
          getItem: () => {
            throw new Error("denied");
          },
        },
        { search: "?brand=a" },
        { documentElement: root },
        URLSearchParams,
      ),
    ).not.toThrow();
  });

  it("setBrand round-trips through localStorage and the html attribute", () => {
    expect(readBrand()).toBeNull();
    setBrand("a");
    expect(localStorage.getItem(BRAND_STORAGE_KEY)).toBe("a");
    expect(document.documentElement.getAttribute("data-brand")).toBe("a");
    setBrand(null);
    expect(readBrand()).toBeNull();
    expect(document.documentElement.hasAttribute("data-brand")).toBe(false);
  });
});
