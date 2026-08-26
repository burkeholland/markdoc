import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const offline = vi.hoisted(() => ({
  clearAllLocalDocuments: vi.fn<() => Promise<number>>(),
  hasLocalDocuments: vi.fn<() => Promise<boolean>>(),
}));
const navigateTo = vi.hoisted(() => vi.fn());

vi.mock("@/editor/collab/offline", () => offline);
vi.mock("@/lib/nav", () => ({ navigateTo }));

import { SIGN_OUT_CLEANUP_ERROR, SIGN_OUT_WARNING, signOutSafely } from "./sign-out";

describe("signOutSafely", () => {
  const confirm = vi.fn();
  const alert = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { confirm, alert });
    offline.hasLocalDocuments.mockResolvedValue(true);
    offline.clearAllLocalDocuments.mockResolvedValue(2);
    confirm.mockReturnValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets the user cancel before deleting mirrors or signing out", async () => {
    confirm.mockReturnValue(false);

    await expect(signOutSafely()).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledWith(SIGN_OUT_WARNING);
    expect(offline.clearAllLocalDocuments).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("reaches Auth.js only after cleanup succeeds", async () => {
    await expect(signOutSafely()).resolves.toBe(true);

    expect(offline.clearAllLocalDocuments).toHaveBeenCalledOnce();
    expect(navigateTo).toHaveBeenCalledWith("/api/auth/signout");
    expect(alert).not.toHaveBeenCalled();
  });

  it("surfaces cleanup failure and stays signed in", async () => {
    const error = new Error("blocked by another open connection");
    offline.clearAllLocalDocuments.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(signOutSafely()).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledWith("[markdoc] sign-out cleanup failed", error);
    expect(alert).toHaveBeenCalledWith(SIGN_OUT_CLEANUP_ERROR);
    expect(navigateTo).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
