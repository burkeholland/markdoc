import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { clickCell, createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";

/**
 * The table menu is clamped to the rich pane's *client* box, never its border box (task #1573, measured by
 * #1556): with `host.width` the right-clamped menu ended 8 px from the border box, i.e. under the pane's
 * vertical scrollbar, and the pane grew a spurious horizontal bar (`scrollWidth` 392 > `clientWidth` 390 at
 * the 1024 px split layout). Playwright hides scrollbars by default, which is exactly what made the bug
 * invisible to the suite, so this file draws the classic bars (#1556 §1: 15 px, 10 px on `scrollbar-thin`).
 */
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const COLUMNS = 12;
const header = `| ${Array.from({ length: COLUMNS }, (_, i) => `C${i + 1}`).join(" | ")} |`;
const delimiter = `| ${Array.from({ length: COLUMNS }, () => "---").join(" | ")} |`;
const body = `| ${Array.from({ length: COLUMNS }, (_, i) => String(i + 1)).join(" | ")} |`;
// Enough text below the table for the pane to scroll vertically at 640 and 720 px: the bug needs the bar.
const FILLER = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} keeps the preview pane taller than the window so its vertical scrollbar is drawn.`);
const DOCUMENT = `# Table menu clamp\n\n${header}\n${delimiter}\n${body}\n\n${FILLER.join("\n\n")}\n`;

const SCROLLER = '[data-testid="rich-column"] > div.scrollbar-thin';

interface Reading {
  menuLeft: number;
  menuRight: number;
  menuWidth: number;
  tableLeft: number;
  paneLeft: number;
  /** Border-box width of the pane scroller (what `host.width` measured). */
  paneWidth: number;
  clientWidth: number;
  scrollWidth: number;
  /** Space the vertical scrollbar takes: border box minus client box. */
  barWidth: number;
  innerWidth: number;
}

function read(page: Page): Promise<Reading> {
  return page.evaluate((scrollerSel) => {
    const scroller = document.querySelector<HTMLElement>(scrollerSel);
    const menu = document.querySelector<HTMLElement>('[data-testid="table-menu"]');
    const table = document.querySelector<HTMLElement>(".md-rich table");
    if (!scroller || !menu || !table) throw new Error(`missing ${!scroller ? "scroller" : !menu ? "table-menu" : "table"}`);
    const m = menu.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return {
      menuLeft: m.left,
      menuRight: m.right,
      menuWidth: m.width,
      tableLeft: table.getBoundingClientRect().left,
      paneLeft: s.left,
      paneWidth: s.width,
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      barWidth: s.width - scroller.clientWidth,
      innerWidth: window.innerWidth,
    };
  }, SCROLLER);
}

/** The menu is positioned from a requestAnimationFrame; read until two consecutive frames agree. */
async function settledReading(page: Page): Promise<Reading> {
  let previous = await read(page);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const next = await read(page);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  return previous;
}

const fmt = (r: Reading) =>
  `pane left=${r.paneLeft.toFixed(1)} width=${r.paneWidth.toFixed(1)} clientWidth=${r.clientWidth} bar=${r.barWidth.toFixed(1)} scrollWidth=${r.scrollWidth}; ` +
  `menu left=${r.menuLeft.toFixed(1)} right=${r.menuRight.toFixed(1)} width=${r.menuWidth.toFixed(1)}; table left=${r.tableLeft.toFixed(1)}; innerWidth=${r.innerWidth}`;

async function openTableDocument(page: Page, login: string): Promise<Reading> {
  await devLogin(page, uniqueLogin(login));
  const id = await createDocument(page, DOCUMENT, "Table menu clamp");
  await openDocument(page, id);
  // Split layout with the outline rail: both are the defaults at >= 1024 px (no stored layout in a fresh context).
  await expect(page.getByTestId("code-column")).toBeVisible();
  await expect(page.getByTestId("rich-column")).toBeVisible();
  await clickCell(page, 1, 0);
  return settledReading(page);
}

test.describe("table menu clamp at the 1024 px split layout with classic scrollbars", () => {
  test.use({ viewport: { width: 1024, height: 640 } });

  test("the menu ends inside the pane's client box and the pane has no horizontal overflow", async ({ page }) => {
    const r = await openTableDocument(page, "table-clamp-1024");
    console.log(`[1573] 1024×640: ${fmt(r)}`);

    // Premise: the classic vertical bar is drawn and takes width, so client box < border box.
    expect.soft(r.barWidth, "the pane's vertical scrollbar takes layout width (classic scrollbars)").toBeGreaterThanOrEqual(1);
    // The menu is right-clamped here (a 372 px menu in a ~400 px pane); the assertions below are about that edge.
    expect.soft(r.menuLeft - r.tableLeft, "the menu is clamped away from the table's left edge").toBeLessThan(-0.5);

    // (a) 8 px inside the *client* box — the border box includes the scrollbar.
    const allowedRight = r.paneLeft + r.clientWidth - 8;
    expect
      .soft(r.menuRight, `menu right ${r.menuRight.toFixed(1)} must be <= pane left + clientWidth - 8 = ${allowedRight.toFixed(1)}`)
      .toBeLessThanOrEqual(allowedRight + 0.5);
    // (b) nothing pokes out sideways: no horizontal scrollbar on the pane.
    expect.soft(r.scrollWidth, `pane scrollWidth ${r.scrollWidth} must be <= clientWidth ${r.clientWidth}`).toBeLessThanOrEqual(r.clientWidth);
  });
});

test.describe("table menu at 1280 × 720 where it is not clamped", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("the menu is fully visible and still inside the pane's client box", async ({ page }) => {
    const r = await openTableDocument(page, "table-clamp-1280");
    console.log(`[1573] 1280×720: ${fmt(r)}`);

    expect.soft(r.barWidth, "the pane's vertical scrollbar takes layout width (classic scrollbars)").toBeGreaterThanOrEqual(1);
    expect.soft(r.menuRight, `menu right ${r.menuRight.toFixed(1)} must be <= viewport width ${r.innerWidth}`).toBeLessThanOrEqual(r.innerWidth);
    const allowedRight = r.paneLeft + r.clientWidth - 8;
    expect
      .soft(r.menuRight, `menu right ${r.menuRight.toFixed(1)} must be <= pane left + clientWidth - 8 = ${allowedRight.toFixed(1)}`)
      .toBeLessThanOrEqual(allowedRight + 0.5);
    expect.soft(r.scrollWidth, `pane scrollWidth ${r.scrollWidth} must be <= clientWidth ${r.clientWidth}`).toBeLessThanOrEqual(r.clientWidth);
  });
});
