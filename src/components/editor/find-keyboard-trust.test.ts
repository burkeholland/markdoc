// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  readFindKeyboardFacts,
  sameFindKeyboardDelivery,
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

  it("accepts a capture proof only at the coordinator's terminal bubble delivery", () => {
    const intrinsics = trustedFindKeyboardIntrinsics(window);
    if (!intrinsics) throw new Error("Find keyboard intrinsics are unavailable");
    const boundary = document.createElement("div");
    const input = document.createElement("input");
    boundary.append(input);
    document.body.append(boundary);
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
    let captured: ReturnType<typeof readFindKeyboardFacts> = null;
    const matches: boolean[] = [];
    boundary.addEventListener("keydown", (nativeEvent) => {
      captured = readFindKeyboardFacts(intrinsics, nativeEvent, document);
    }, true);
    input.addEventListener("keydown", (nativeEvent) => {
      const current = readFindKeyboardFacts(intrinsics, nativeEvent, document);
      matches.push(Boolean(
        captured &&
        current &&
        sameFindKeyboardDelivery(captured, current, boundary, document)
      ));
    }, true);
    boundary.addEventListener("keydown", (nativeEvent) => {
      const current = readFindKeyboardFacts(intrinsics, nativeEvent, document);
      matches.push(Boolean(
        captured &&
        current &&
        sameFindKeyboardDelivery(captured, current, boundary, document)
      ));
    });
    document.addEventListener("keydown", (nativeEvent) => {
      const current = readFindKeyboardFacts(intrinsics, nativeEvent, document);
      matches.push(Boolean(
        captured &&
        current &&
        sameFindKeyboardDelivery(captured, current, boundary, document)
      ));
    }, { once: true });

    input.dispatchEvent(event);
    const expired = readFindKeyboardFacts(intrinsics, event, document);

    expect(matches).toEqual([false, false, true]);
    expect(expired?.eventPhase).toBe(0);
    expect(expired?.currentTarget).toBeNull();
    expect(captured && expired &&
      sameFindKeyboardDelivery(captured, expired, boundary, document)).toBe(false);
  });
});
