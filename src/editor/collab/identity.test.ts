import { describe, expect, it } from "vitest";
import { createAnonymousUserId, isSameAccount } from "./identity";

describe("collaboration identities", () => {
  it("creates a distinct identity for each anonymous editor page", () => {
    const first = createAnonymousUserId();
    const second = createAnonymousUserId();

    expect(first).toMatch(/^anonymous-/);
    expect(second).not.toBe(first);
  });

  it("does not treat the shared anonymous placeholder as an account", () => {
    expect(isSameAccount("anonymous", "anonymous")).toBe(false);
    expect(isSameAccount("user-123", "user-123")).toBe(true);
    expect(isSameAccount("user-123", "user-456")).toBe(false);
  });
});
