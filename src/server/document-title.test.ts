import { describe, expect, it } from "vitest";
import { boundTitle, DOCUMENT_TITLE_MAX } from "@/server/document-title";

describe("boundTitle", () => {
  it("leaves ordinary titles alone apart from trimming", () => {
    expect(boundTitle("Meeting notes")).toBe("Meeting notes");
    expect(boundTitle("  padded  ")).toBe("padded");
    expect(boundTitle("x".repeat(DOCUMENT_TITLE_MAX))).toHaveLength(DOCUMENT_TITLE_MAX);
    expect(boundTitle("")).toBe("");
  });

  it("clips to the maximum deterministically and drops whitespace left at the cut", () => {
    const long = "A".repeat(DOCUMENT_TITLE_MAX + 5000);
    expect(boundTitle(long)).toBe("A".repeat(DOCUMENT_TITLE_MAX));
    expect(boundTitle(long)).toBe(boundTitle(long));
    const words = "word ".repeat(60); // the 200th character falls on a space
    const cut = boundTitle(words);
    expect(cut.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX);
    expect(cut).toBe(cut.trimEnd());
    expect(cut.endsWith("word")).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const title = "x".repeat(DOCUMENT_TITLE_MAX - 1) + "😀😀";
    const cut = boundTitle(title);
    expect(cut).toBe("x".repeat(DOCUMENT_TITLE_MAX - 1));
    expect(cut.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX);
  });
});
