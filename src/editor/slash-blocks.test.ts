import { describe, expect, it } from "vitest";
import { calloutKind, calloutMarkdown, footnoteLabelsInSource, nextFootnoteLabel, tocMarkdown } from "./slash-blocks";

describe("slash blocks", () => {
  // Anchors use markdoc's own slugify, the ids the reader gives headings.
  it("builds a nested table of contents relative to the shallowest heading", () => {
    expect(
      tocMarkdown([
        { level: 2, text: "Intro" },
        { level: 3, text: "Why it matters" },
        { level: 2, text: "Setup & use" },
      ]),
    ).toBe("- [Intro](#intro)\n  - [Why it matters](#why-it-matters)\n- [Setup & use](#setup-use)");
  });

  it("numbers duplicate anchors like GitHub, escapes brackets and skips empty headings", () => {
    expect(
      tocMarkdown([
        { level: 1, text: "Notes" },
        { level: 1, text: "" },
        { level: 1, text: "Notes" },
        { level: 1, text: "[draft]" },
      ]),
    ).toBe("- [Notes](#notes)\n- [Notes](#notes-1)\n- [\\[draft\\]](#draft)");
  });

  it("is empty without headings", () => {
    expect(tocMarkdown([])).toBe("");
  });

  it("reads the callout kind from a prefix of the argument", () => {
    expect(calloutKind("")).toBe("note");
    expect(calloutKind("warn")).toBe("warning");
    expect(calloutKind("TIP")).toBe("tip");
    expect(calloutKind("c")).toBe("caution");
    expect(calloutKind("nonsense")).toBe("note");
    expect(calloutMarkdown("important")).toBe("> [!IMPORTANT]\n> ");
  });

  it("picks the next numeric footnote label", () => {
    expect(nextFootnoteLabel([])).toBe("1");
    expect(nextFootnoteLabel(["1", "note", "7", "3"])).toBe("8");
    expect(footnoteLabelsInSource("a[^1] b[^x]\n\n[^1]: one\n[^x]: two")).toEqual(["1", "x", "1", "x"]);
  });
});
