import { describe, expect, it } from "vitest";
import { sentence } from "./notifications-store";

describe("notification sentences", () => {
  it("directs disabled webhook recovery to the existing hook", () => {
    const text = sentence({
      kind: "webhook.disabled",
      documentTitle: "Launch plan",
      snippet: "https://receiver.example/webhook",
    });

    expect(text).toContain("enable the existing hook in Settings");
    expect(text).not.toContain("re-add it");
  });
});
