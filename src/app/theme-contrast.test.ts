import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "./theme-contrast.helpers";

/**
 * WCAG AA guard for both palettes in globals.css: body text on the page surface, secondary text on
 * the surface, and text on filled accent controls. Parses the CSS rather than importing it so the
 * numbers match what ships. The `contrast` formula lives in theme-contrast.helpers.ts
 * (tokens-contrast.test.ts shares it).
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

const light = palette(block("\n:root {"));
const dark = palette(block('\n[data-theme="dark"] {'));

const TOKENS = ["ink", "ink-2", "ink-3", "ink-4", "line", "line-2", "surface", "surface-2", "surface-3", "accent", "accent-hover", "accent-soft", "success", "warning", "danger", "on-accent", "inverse"];

describe("theme contrast", () => {
  it("the dark block overrides every semantic colour token and sets color-scheme", () => {
    const theme = block("@theme inline");
    for (const token of TOKENS) {
      expect(light[`p-${token}`], token).toBeTruthy();
      expect(dark[`p-${token}`], token).toBeTruthy();
      // Utilities must go through var() (not an inlined literal) so they re-resolve under [data-theme].
      expect(theme).toContain(`--color-${token}: var(--p-${token});`);
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
        expect(contrast(p["p-ink"], p["p-surface"])).toBeGreaterThanOrEqual(7);
        expect(contrast(p["p-ink"], p["p-surface-2"])).toBeGreaterThanOrEqual(7);
        expect(contrast(p["p-ink-2"], p["p-surface"])).toBeGreaterThanOrEqual(7);
      });
      it("secondary text on the surface is AA (≥ 4.5)", () => {
        expect(contrast(p["p-ink-3"], p["p-surface"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p["p-ink-3"], p["p-surface-2"])).toBeGreaterThanOrEqual(4.5);
      });
      it("text on filled accent and danger controls is AA (≥ 4.5)", () => {
        expect(contrast(p["p-on-accent"], p["p-accent"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p["p-on-accent"], p["p-danger"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", p["p-inverse"])).toBeGreaterThanOrEqual(4.5);
      });
      it("accent and danger read as text on the surface (≥ 4.5); success/warning as icons and large text (≥ 3)", () => {
        for (const token of ["p-accent", "p-danger"]) {
          expect(contrast(p[token], p["p-surface"]), token).toBeGreaterThanOrEqual(4.5);
        }
        for (const token of ["p-success", "p-warning"]) {
          expect(contrast(p[token], p["p-surface"]), token).toBeGreaterThanOrEqual(3);
        }
      });
      it("faint text stays dimmer than secondary text", () => {
        const bodyOnSurface = (t: string) => contrast(p[t], p["p-surface"]);
        expect(bodyOnSurface("p-ink-4")).toBeLessThan(bodyOnSurface("p-ink-3"));
        expect(bodyOnSurface("cm-faint")).toBeLessThan(bodyOnSurface("cm-muted"));
      });
    });
  }

  // axe's color-contrast rule runs on the dark dashboard and editor (e2e/a11y.spec.ts): timestamps,
  // line numbers and Markdown punctuation use ink-4 / cm-faint at small sizes, so they need AA there.
  describe("dark faint text", () => {
    it("ink-4 and cm-faint are AA (≥ 4.5) on the surface and surface-2", () => {
      for (const token of ["p-ink-4", "cm-faint"]) {
        expect(contrast(dark[token], dark["p-surface"]), token).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark[token], dark["p-surface-2"]), token).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
