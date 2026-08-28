import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "./theme-contrast.test";

/**
 * Token matrix for the one look ("Ink & teal", tasks #398 → #416): the `:root` (light) and
 * `[data-theme="dark"]` blocks in globals.css must define the same semantic colours and the same knobs
 * the components read unconditionally, and every AA pair below must hold on every surface text renders
 * on — the header chrome and the preview paper included, not just the page surface. axe re-checks the
 * same pairs live with color-contrast on in e2e/a11y.spec.ts ("axe: contrast").
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

const light = tokens(block(":root"));
const darkOverrides = tokens(block('[data-theme="dark"]'));
// The dark block only overrides; anything it leaves alone resolves from :root, exactly as the cascade does.
const palettes = { light, dark: { ...light, ...darkOverrides } };

const SEMANTIC = ["ink", "ink-2", "ink-3", "ink-4", "line", "line-2", "surface", "surface-2", "surface-3", "accent", "accent-hover", "accent-soft", "success", "warning", "danger", "on-accent", "inverse"];
const KNOBS = ["font-display", "paper", "chrome", "radius-control", "selection"];
/** Knobs that are colours and therefore need a dark value too. */
const COLOUR_KNOBS = ["paper", "chrome", "selection"];
// Syntax colours axe sees as small text: CodeMirror on the editor surface / active line, highlight.js inside `pre` (surface-2).
const MULTI_SURFACE_SYNTAX = ["cm-number", "cm-variable", "hljs-number", "hljs-literal"];
const RICH_TYPESCRIPT_SYNTAX = ["hljs-comment", "hljs-keyword", "hljs-string-2", "hljs-number", "hljs-literal", "hljs-title-2"];
const RICH_TYPESCRIPT_GROUPS = ["hljs-keyword", "hljs-string-2", "hljs-number", "hljs-comment", "hljs-title-2"];
const CODE_SURFACES = ["p-surface", "p-surface-2", "p-paper", "p-chrome", "cm-active-line"];

describe("tokens", () => {
  it("there is exactly one palette: no option blocks, no second display face", () => {
    expect(css).not.toMatch(/^\[data-[\w-]+="[ab]"\]/m);
    expect(css).not.toMatch(/inter-tight/);
    expect(css.match(/\n:root \{/g)).toHaveLength(1);
    expect(css.match(/\n\[data-theme="dark"\] \{/g)).toHaveLength(1);
  });

  it(":root defines every semantic colour token and every knob; dark overrides the colours", () => {
    for (const t of [...SEMANTIC, ...KNOBS]) expect(light[`p-${t}`], `:root --p-${t}`).toBeTruthy();
    for (const t of [...SEMANTIC, ...COLOUR_KNOBS]) expect(darkOverrides[`p-${t}`], `dark --p-${t}`).toBeTruthy();
    for (const t of ["font-display", "radius-control"]) expect(darkOverrides[`p-${t}`], `dark must not redefine --p-${t}`).toBeUndefined();
  });

  it("the display face is Fraunces from next/font with a system serif fallback, declared in layout.tsx", () => {
    const layout = readFileSync(path.resolve(__dirname, "layout.tsx"), "utf8");
    expect(light["p-font-display"]).toMatch(/^var\(--font-fraunces\),.*serif$/);
    expect(layout).toMatch(/Fraunces\(\{[^}]*variable: "--font-fraunces"[^}]*display: "swap"/);
    expect(layout).not.toMatch(/Inter_Tight|BRAND_BOOT_SCRIPT|@\/lib\/brand/);
    expect(layout).toContain('localStorage.removeItem("markdoc:brand")');
  });

  for (const [name, p] of Object.entries(palettes)) {
    describe(`${name} palette`, () => {
      const hex = (t: string) => {
        const v = p[t];
        if (!/^#[0-9a-f]{6}$/i.test(v ?? "")) throw new Error(`${name}: ${t} is not a hex colour: ${v}`);
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
          for (const fg of ["p-ink-3", "p-ink-4", "cm-muted", "cm-faint"]) expect(contrast(hex(fg), hex(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
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
      it("faint text stays dimmer than secondary text, in the UI and in the code pane", () => {
        expect(contrast(hex("p-ink-4"), hex("p-surface"))).toBeLessThan(contrast(hex("p-ink-3"), hex("p-surface")));
        expect(contrast(hex("cm-faint"), hex("p-surface"))).toBeLessThan(contrast(hex("cm-muted"), hex("p-surface")));
      });
      // The editor's axe scan (color-contrast on) is the live gate for these; the numbers are checked here
      // so a palette edit cannot quietly reintroduce the 3.6:1 orange (#ea580c).
      it("syntax number/literal colours are AA (≥ 4.5) on every surface code renders on", () => {
        for (const bg of CODE_SURFACES) {
          for (const fg of MULTI_SURFACE_SYNTAX) expect(contrast(hex(fg), hex(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("rich-pane TypeScript syntax colours are AA (≥ 4.5) on the code-block surface", () => {
        for (const fg of RICH_TYPESCRIPT_SYNTAX) {
          expect(contrast(hex(fg), hex("p-surface-2")), `${fg} on p-surface-2`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("rich-pane TypeScript token groups retain distinct colours", () => {
        expect(new Set(RICH_TYPESCRIPT_GROUPS.map(hex))).toHaveProperty("size", RICH_TYPESCRIPT_GROUPS.length);
      });
    });
  }
});
