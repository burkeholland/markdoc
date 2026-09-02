import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as chrome from "./chrome-classes";

/**
 * The placeholder `src/app/d/[id]/editor-client.tsx` paints the shell's chrome before the shell's chunks
 * have loaded (#1545). It only works while both trees draw their boxes from these constants, at the
 * shell's heights — header 57/65 px, toolbar 48, pane-label row 48, status bar 41, rail 224 / 40 — so
 * the numbers are pinned here, and the module stays a leaf (its chunk is on the first-paint budget).
 */
describe("chrome-classes", () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("pins the shell's heights and widths", () => {
    expect(chrome.HEADER_BOX).toMatch(/\bh-14\b/);
    expect(chrome.HEADER_BOX).toMatch(/\bmd:h-16\b/);
    expect(chrome.HEADER_BOX).toMatch(/\bbox-content\b.*\bborder-b\b/);
    expect(chrome.TOOLBAR_BOX).toMatch(/\bh-12\b/);
    expect(chrome.PANE_LABEL_ROW_BOX).toMatch(/\bh-12\b/);
    expect(chrome.STATUS_BOX).toMatch(/\bh-10\b/);
    expect(chrome.STATUS_BOX).toMatch(/\bbox-content\b.*\bborder-t\b/);
    expect(chrome.RAIL_BOX).toMatch(/\bw-56\b/);
    expect(chrome.RAIL_COLLAPSED_BOX).toMatch(/\bw-10\b/);
    expect(chrome.SHELL_BOX).toMatch(/\bh-screen\b/);
  });

  it("exports plain, distinct class strings without responsive visibility (that is each tree's own)", () => {
    const values = Object.values(chrome);
    expect(values.length).toBeGreaterThanOrEqual(15);
    for (const v of values) {
      expect(typeof v).toBe("string");
      expect(v).toBe(v.trim());
      expect(v).not.toMatch(/\s{2,}/);
      expect(v).not.toMatch(/(^|\s|:)hidden(\s|$)/);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it("is a leaf module that both the shell and the placeholder import", () => {
    expect(src("./chrome-classes.ts")).not.toMatch(/^\s*import\b/m);
    for (const file of ["./editor-shell.tsx", "./header.tsx", "./toolbar.tsx", "./outline.tsx", "./status-bar.tsx"]) {
      expect(src(file), `${file} imports its chrome box from chrome-classes`).toMatch(/from "\.\/chrome-classes"/);
    }
    expect(src("../../app/d/[id]/editor-client.tsx")).toMatch(/from "@\/components\/editor\/chrome-classes"/);
  });
});
