import { inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, setTheme } from "./helpers";

/**
 * #2325: a selection in the Markdown pane must be SEEN, not merely exist. CodeMirror's drawSelection()
 * paints `.cm-selectionBackground` rectangles in a layer behind the lines, so anything opaque on a line
 * (the active-line tint did this) hides the selection while every DOM check still passes. These tests
 * therefore read the painted pixels of a strip of the line from a screenshot.
 */

type Rgb = [number, number, number];

/** The most frequent colour of a PNG as Playwright writes it (8-bit RGB or RGBA, not interlaced): the background of a strip of text. */
function dominantColor(png: Buffer): Rgb {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || (chunk[9] !== 2 && chunk[9] !== 6) || chunk[12] !== 0) throw new Error(`unexpected PNG format: depth ${chunk[8]}, colour type ${chunk[9]}, interlace ${chunk[12]}`);
      channels = chunk[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") data.push(chunk);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (value + predicted) & 255;
    }
  }
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += channels) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return [best >> 16, (best >> 8) & 255, best & 255];
}

/** Largest difference in one colour channel (0 to 255) between two painted colours. */
const channelDistance = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * A highlight a person sees at once. The active-line tint is 10 away from the surface in both themes (that is
 * what the bug painted over a selection), the selection is about 50 away from the surface and from the tint.
 */
const CLEARLY = 30;

const LINES = Array.from({ length: 30 }, (_, i) => (i === 0 ? "# Selection fixture" : i % 5 === 0 ? "" : `Line ${i + 1} holds enough words to select them.`));
/** 0-based indexes of two neighbouring, non-empty source lines. */
const FIRST = 7;
const SECOND = 8;

const codeLine = (page: Page, index: number) => page.locator(".cm-content .cm-line").nth(index);

/** The painted background of the first 200 px of a source line. */
async function paintedLine(page: Page, index: number): Promise<Rgb> {
  const box = await codeLine(page, index).boundingBox();
  if (!box) throw new Error(`source line ${index + 1} is not on screen`);
  const png = await page.screenshot({ clip: { x: Math.round(box.x) + 4, y: Math.round(box.y) + 3, width: 200, height: Math.round(box.height) - 6 }, animations: "disabled" });
  return dominantColor(png);
}

/** Puts the caret on line 2 with nothing selected, away from the lines under test. */
async function parkCaret(page: Page) {
  await codeLine(page, 1).click({ position: { x: 6, y: 8 } });
  await expect(codeLine(page, 1)).toHaveClass(/cm-activeLine/);
}

/** Waits until the strip of `index` is painted clearly unlike every colour in `unlike`, and returns its colour. */
async function expectHighlighted(page: Page, index: number, unlike: Record<string, Rgb>, what: string): Promise<Rgb> {
  let painted: Rgb = [0, 0, 0];
  await expect
    .poll(
      async () => {
        painted = await paintedLine(page, index);
        return Math.min(...Object.values(unlike).map((colour) => channelDistance(painted, colour)));
      },
      { message: `${what}: painted colour of line ${index + 1} against ${JSON.stringify(unlike)}`, timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(CLEARLY);
  return painted;
}

test.describe("Markdown pane: a selection is visible", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: selected text is painted on the caret's line and on the other lines`, async ({ browser }) => {
      const user = await signIn(browser, `code-selection-${theme}`);
      const { page } = user;
      const id = await createDocument(page, `${LINES.join("\n")}\n`, "Selection fixture");
      await openDocument(page, id);
      await setTheme(page, theme);
      await expect(codeLine(page, SECOND)).toBeVisible();

      // Unselected states: the bare surface, and the active-line tint a caret gives its line.
      await parkCaret(page);
      const surface = await paintedLine(page, FIRST);
      expect(await paintedLine(page, SECOND), "two unselected lines are painted alike").toEqual(surface);
      await codeLine(page, FIRST).click({ position: { x: 6, y: 8 } });
      await expect(codeLine(page, FIRST)).toHaveClass(/cm-activeLine/);
      let tint: Rgb = surface;
      await expect.poll(async () => channelDistance((tint = await paintedLine(page, FIRST)), surface), { message: "the caret's line carries the active-line tint" }).toBeGreaterThan(0);
      const unselected = { surface, tint };

      // 1. A selection inside one line: all of it is on the caret's line (this painted nothing before the fix).
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await expect(codeLine(page, FIRST)).toHaveClass(/cm-activeLine/);
      await expect(page.locator(".cm-selectionBackground")).toHaveCount(1);
      const oneLine = await expectHighlighted(page, FIRST, unselected, "selection inside the caret's line (Shift+End)");

      // Letting go of the selection brings the tint back exactly as it was.
      await page.keyboard.press("Home");
      await expect.poll(() => paintedLine(page, FIRST), { message: "the active-line tint returns when nothing is selected" }).toEqual(tint);

      // 2. Two lines: the first is selected and not the caret's line, the second is the caret's line.
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+End");
      await expect(codeLine(page, SECOND)).toHaveClass(/cm-activeLine/);
      await expect(codeLine(page, FIRST)).not.toHaveClass(/cm-activeLine/);
      const notActive = await expectHighlighted(page, FIRST, unselected, "selected line that is not the caret's line");
      const active = await expectHighlighted(page, SECOND, unselected, "selected line that is the caret's line");
      expect(channelDistance(oneLine, notActive), "a selection looks the same on one line as on two").toBeLessThan(CLEARLY);
      expect(channelDistance(active, notActive), "the caret's line is highlighted like the other selected lines").toBeLessThan(CLEARLY);

      // 3. The same with a real pointer: a drag inside one line.
      await parkCaret(page);
      await expect.poll(() => paintedLine(page, FIRST), { message: "nothing is selected after the caret moved away" }).toEqual(surface);
      const box = (await codeLine(page, FIRST).boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 4, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, y, { steps: 6 });
      await page.mouse.move(box.x + 260, y, { steps: 6 });
      await page.mouse.up();
      await expect(codeLine(page, FIRST)).toHaveClass(/cm-activeLine/);
      await expectHighlighted(page, FIRST, unselected, "selection dragged inside one line");

      await user.context.close();
    });
  }
});
