// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  readFindKeyboardFacts,
  trustedFindKeyboardIntrinsics,
} from "./find-keyboard-trust";

const keyDescriptor = Object.getOwnPropertyDescriptor(
  window.KeyboardEvent.prototype,
  "key",
);

afterEach(() => {
  if (keyDescriptor) {
    Object.defineProperty(
      window.KeyboardEvent.prototype,
      "key",
      keyDescriptor,
    );
  }
  document.body.replaceChildren();
});

describe("eager Find keyboard trust", () => {
  it("rejects synthetic keyboard provenance", () => {
    const intrinsics = trustedFindKeyboardIntrinsics(window);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const eventView =
      (window as Window & { _globalObject?: Window })._globalObject ?? window;
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "F3",
      code: "F3",
      view: eventView,
    });
    let trusted: boolean | null = null;
    input.addEventListener("keydown", (nativeEvent) => {
      trusted = intrinsics
        ? readFindKeyboardFacts(intrinsics, nativeEvent, document)?.isTrusted ??
          null
        : null;
    }, { once: true });

    input.dispatchEvent(event);

    expect(trusted).toBe(false);
  });

  it("does not let the lazy Find module baseline a getter poisoned after bootstrap", async () => {
    if (!keyDescriptor || typeof keyDescriptor.get !== "function") {
      throw new Error("The initial KeyboardEvent key getter is unavailable");
    }
    Object.defineProperty(window.KeyboardEvent.prototype, "key", {
      ...keyDescriptor,
      get: () => "F3",
    });

    await import("./find-bar");

    expect(trustedFindKeyboardIntrinsics(window)).toBeNull();

    Object.defineProperty(
      window.KeyboardEvent.prototype,
      "key",
      keyDescriptor,
    );
    expect(trustedFindKeyboardIntrinsics(window)).not.toBeNull();
  });
});
