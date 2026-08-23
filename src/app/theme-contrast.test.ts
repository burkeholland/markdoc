import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG AA guard for both palettes in globals.css: body text on the page surface, secondary text on
 * the surface, and text on filled accent controls. Parses the CSS rather than importing it so the
 * numbers match what ships.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

type Palette = Record<string, string>;

function palette(body: string): Palette {
  const out: Palette = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = palette(block("@theme inline"));
const dark = palette(block('\n[data-theme="dark"] {'));

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const TOKENS = ["color-ink", "color-ink-2", "color-ink-3", "color-ink-4", "color-line", "color-line-2", "color-surface", "color-surface-2", "color-surface-3", "color-accent", "color-accent-hover", "color-accent-soft", "color-success", "color-warning", "color-danger", "color-on-accent", "color-inverse"];

describe("theme contrast", () => {
  it("the dark block overrides every semantic colour token and sets color-scheme", () => {
    for (const token of TOKENS) {
      expect(light[token], token).toBeTruthy();
      expect(dark[token], token).toBeTruthy();
    }
    expect(block('\n[data-theme="dark"] {')).toMatch(/color-scheme:\s*dark/);
  });

  it("contrast formula matches the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  for (const [name, p] of [["light", light], ["dark", dark]] as const) {
    describe(`${name} palette`, () => {
      it("body text on the surface is AAA (≥ 7)", () => {
        expect(contrast(p["color-ink"], p["color-surface"])).toBeGreaterThanOrEqual(7);
        expect(contrast(p["color-ink"], p["color-surface-2"])).toBeGreaterThanOrEqual(7);
        expect(contrast(p["color-ink-2"], p["color-surface"])).toBeGreaterThanOrEqual(7);
      });
      it("secondary text on the surface is AA (≥ 4.5)", () => {
        expect(contrast(p["color-ink-3"], p["color-surface"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p["color-ink-3"], p["color-surface-2"])).toBeGreaterThanOrEqual(4.5);
      });
      it("text on filled accent and danger controls is AA (≥ 4.5)", () => {
        expect(contrast(p["color-on-accent"], p["color-accent"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p["color-on-accent"], p["color-danger"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", p["color-inverse"])).toBeGreaterThanOrEqual(4.5);
      });
      it("accent and danger read as text on the surface (≥ 4.5); success/warning as icons and large text (≥ 3)", () => {
        for (const token of ["color-accent", "color-danger"]) {
          expect(contrast(p[token], p["color-surface"]), token).toBeGreaterThanOrEqual(4.5);
        }
        for (const token of ["color-success", "color-warning"]) {
          expect(contrast(p[token], p["color-surface"]), token).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});
