import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "./theme-contrast.test";

/**
 * Brand candidates (task #398): `[data-brand="a"]` and `[data-brand="b"]` must each override the same
 * set of tokens, in light and in dark, so flipping the switch never leaves a colour from the other
 * look (or from the default) showing through. The same AA pairs theme-contrast.test.ts checks for the
 * default palette are checked for every brand × theme here; axe re-checks them live in e2e/a11y.spec.ts.
 */

const css = readFileSync(path.resolve(__dirname, "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const blocks = {
  "a light": tokens(block('[data-brand="a"]')),
  "a dark": tokens(block('[data-brand="a"][data-theme="dark"]')),
  "b light": tokens(block('[data-brand="b"]')),
  "b dark": tokens(block('[data-brand="b"][data-theme="dark"]')),
};

const SEMANTIC = ["ink", "ink-2", "ink-3", "ink-4", "line", "line-2", "surface", "surface-2", "surface-3", "accent", "accent-hover", "accent-soft", "success", "warning", "danger", "on-accent", "inverse"];
const BRAND_KNOBS = ["font-display", "paper", "chrome", "radius-control", "selection"];

describe("brand tokens", () => {
  it("the four brand blocks define exactly the same token set", () => {
    const names = Object.values(blocks).map((b) => Object.keys(b).sort());
    for (const list of names.slice(1)) expect(list).toEqual(names[0]);
  });

  it("every semantic colour token and every brand knob is overridden in each block", () => {
    for (const [name, b] of Object.entries(blocks)) {
      for (const t of [...SEMANTIC, ...BRAND_KNOBS]) expect(b[`p-${t}`], `${name}: --p-${t}`).toBeTruthy();
    }
  });

  it("the unbranded defaults for the brand knobs exist, so components can use them unconditionally", () => {
    for (const t of BRAND_KNOBS) expect(css, `:root --p-${t}`).toMatch(new RegExp(`--p-${t}:`));
    expect(css).toContain("--p-font-display: var(--font-sans);");
    expect(css).toContain("--p-paper: var(--p-surface);");
  });

  it("the display faces come from next/font variables declared in layout.tsx", () => {
    const layout = readFileSync(path.resolve(__dirname, "layout.tsx"), "utf8");
    expect(blocks["a light"]["p-font-display"]).toContain("var(--font-fraunces)");
    expect(blocks["b light"]["p-font-display"]).toContain("var(--font-inter-tight)");
    expect(layout).toMatch(/Fraunces\(\{[^}]*variable: "--font-fraunces"[^}]*display: "swap"[^}]*preload: false/);
    expect(layout).toMatch(/Inter_Tight\(\{[^}]*variable: "--font-inter-tight"[^}]*display: "swap"[^}]*preload: false/);
  });

  for (const [name, p] of Object.entries(blocks)) {
    describe(`${name} palette`, () => {
      const hex = (t: string) => {
        const v = p[t];
        if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${t} is not a hex colour: ${v}`);
        return v;
      };
      it("body text on the surface, surface-2 and the preview paper is AAA (≥ 7)", () => {
        for (const bg of ["p-surface", "p-surface-2", "p-paper"]) {
          expect(contrast(hex("p-ink"), hex(bg)), `ink on ${bg}`).toBeGreaterThanOrEqual(7);
          expect(contrast(hex("p-ink-2"), hex(bg)), `ink-2 on ${bg}`).toBeGreaterThanOrEqual(7);
        }
      });
      it("secondary and faint text are AA (≥ 4.5) on every surface, including the header chrome", () => {
        for (const bg of ["p-surface", "p-surface-2", "p-surface-3", "p-paper", "p-chrome"]) {
          for (const fg of ["p-ink-3", "p-ink-4", "cm-faint"]) expect(contrast(hex(fg), hex(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("accent, success, warning and danger read as small text (≥ 4.5) on the surface, paper and chrome", () => {
        for (const bg of ["p-surface", "p-surface-2", "p-paper", "p-chrome"]) {
          for (const fg of ["p-accent", "p-success", "p-warning", "p-danger"]) expect(contrast(hex(fg), hex(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("text on filled accent/danger controls and on the inverse surface is AA (≥ 4.5)", () => {
        expect(contrast(hex("p-on-accent"), hex("p-accent"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hex("p-on-accent"), hex("p-danger"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", hex("p-inverse"))).toBeGreaterThanOrEqual(4.5);
      });
      it("faint text stays dimmer than secondary text", () => {
        expect(contrast(hex("p-ink-4"), hex("p-surface"))).toBeLessThan(contrast(hex("p-ink-3"), hex("p-surface")));
      });
    });
  }
});
