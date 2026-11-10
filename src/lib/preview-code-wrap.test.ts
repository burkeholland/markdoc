// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_CODE_WRAP_STORAGE_KEY, previewCodeWrapStore, setPreviewCodeWrap } from "./preview-code-wrap";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});

describe("preview code wrapping preference", () => {
  it("starts unwrapped and remembers the choice without touching other preferences", () => {
    const stop = previewCodeWrapStore.subscribe(() => {});
    expect(previewCodeWrapStore.getSnapshot()).toBe(false);
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBeNull();
    localStorage.setItem("markdoc:previewFont", "inter");
    setPreviewCodeWrap(true);
    expect(previewCodeWrapStore.getSnapshot()).toBe(true);
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBe("on");
    expect(localStorage.getItem("markdoc:previewFont")).toBe("inter");
    expect(previewCodeWrapStore.getServerSnapshot()).toBe(false);
    setPreviewCodeWrap(false);
    expect(localStorage.getItem(PREVIEW_CODE_WRAP_STORAGE_KEY)).toBe("off");
    stop();
  });

  it("follows other tabs and storage clearing but ignores unrelated keys", () => {
    const heard = vi.fn();
    const stop = previewCodeWrapStore.subscribe(heard);
    localStorage.setItem(PREVIEW_CODE_WRAP_STORAGE_KEY, "on");
    window.dispatchEvent(new StorageEvent("storage", { key: PREVIEW_CODE_WRAP_STORAGE_KEY }));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(previewCodeWrapStore.getSnapshot()).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "markdoc:previewFont" }));
    expect(heard).toHaveBeenCalledTimes(1);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(previewCodeWrapStore.getSnapshot()).toBe(false);
    stop();
    setPreviewCodeWrap(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("still toggles for this visit when the browser refuses storage, and reports the failure", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = new DOMException("denied", "SecurityError");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw denied; });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw denied; });
    expect(previewCodeWrapStore.getSnapshot()).toBe(false);
    setPreviewCodeWrap(true);
    expect(previewCodeWrapStore.getSnapshot()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("for this visit only"), denied);
    setPreviewCodeWrap(false);
    expect(previewCodeWrapStore.getSnapshot()).toBe(false);
  });
});
