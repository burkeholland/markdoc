// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warmEditorWhenIdle } from "./warm-editor";

function setup({ readyState = "complete", wide = true, connection }: { readyState?: DocumentReadyState; wide?: boolean; connection?: { saveData?: boolean; effectiveType?: string } } = {}) {
  vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
  window.matchMedia = vi.fn().mockReturnValue({ matches: wide }) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
  const loadShell = vi.fn(() => Promise.resolve());
  const loadCodePane = vi.fn(() => Promise.resolve());
  return { loadShell, loadCodePane, cancel: warmEditorWhenIdle({ loadShell, loadCodePane }) };
}

describe("warmEditorWhenIdle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for the window's load event and an idle period, then loads the shell and the code pane in turn", async () => {
    const { loadShell, loadCodePane } = setup({ readyState: "interactive" });
    await vi.runAllTimersAsync();
    expect(loadShell).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    expect(loadShell).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    expect(loadShell).toHaveBeenCalledOnce();
    expect(loadCodePane).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.editorWarm).toBeUndefined();
    await vi.advanceTimersToNextTimerAsync();
    expect(loadCodePane).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.editorWarm).toBe("");
    delete document.documentElement.dataset.editorWarm;
  });

  it("leaves the code pane alone on a phone-width screen, which never shows it", async () => {
    const { loadShell, loadCodePane } = setup({ wide: false });
    await vi.runAllTimersAsync();
    expect(loadShell).toHaveBeenCalledOnce();
    expect(loadCodePane).not.toHaveBeenCalled();
  });

  it.each([{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }])("fetches nothing on a data-saving connection (%o)", async (connection) => {
    const { loadShell } = setup({ connection });
    await vi.runAllTimersAsync();
    expect(loadShell).not.toHaveBeenCalled();
  });

  it("fetches nothing once cancelled, and survives a failed load", async () => {
    const cancelled = setup();
    cancelled.cancel();
    await vi.runAllTimersAsync();
    expect(cancelled.loadShell).not.toHaveBeenCalled();

    const failing = setup();
    failing.loadShell.mockRejectedValueOnce(new Error("offline"));
    await vi.runAllTimersAsync();
    expect(failing.loadCodePane).toHaveBeenCalledOnce();
  });
});
