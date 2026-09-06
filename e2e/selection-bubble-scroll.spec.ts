import { expect, test } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { createDocument, devLogin, selectTextInRich, uniqueLogin, waitForEditor } from "./helpers";

const SELECTED_TEXT = "The selected passage is deliberately long enough to wrap across lines on narrow and zoomed viewports.";
const DOC = Array.from({ length: 70 }, (_, index) =>
  index === 35 ? SELECTED_TEXT : `Filler paragraph ${index + 1} keeps the rich pane tall enough to scroll in every viewport.`,
).join("\n\n");
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 393, height: 852 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;
const RICH_SCROLLER = '[data-testid="rich-column"] .overflow-y-auto';

type StoredSession = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface Geometry {
  bubble: Rect | null;
  bounds: Rect;
  selection: Rect | null;
  outsidePixels: number;
  horizontalOverflow: number;
  toolbar: { clientWidth: number; scrollWidth: number; scrollLeft: number } | null;
}

async function openRichDocument(page: Page, id: string) {
  await page.addInitScript(() => {
    if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem("markdoc:layout", "rich");
  });
  await page.goto(`/d/${id}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".md-rich")).toContainText(SELECTED_TEXT);
}

async function setPageScale(page: Page, scale: number) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: scale });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBeCloseTo(scale, 1);
  await session.detach();
}

async function nextFrames(page: Page, count = 2) {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        const step = (remaining: number) => {
          if (remaining <= 0) resolve();
          else requestAnimationFrame(() => step(remaining - 1));
        };
        step(frames);
      }),
    count,
  );
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((richScrollerSelector) => {
    const toRect = (value: DOMRect): Rect => ({
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    });
    const style = getComputedStyle(document.documentElement);
    const inset = (name: string) => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : 0;
    };
    const root = document.documentElement;
    const host = document.querySelector<HTMLElement>(richScrollerSelector)!.getBoundingClientRect();
    const visual = window.visualViewport;
    const visualLeft = visual?.offsetLeft ?? 0;
    const visualTop = visual?.offsetTop ?? 0;
    const visualRight = visualLeft + (visual?.width ?? root.clientWidth);
    const visualBottom = visualTop + (visual?.height ?? root.clientHeight);
    const left = Math.max(host.left, 0, visualLeft + inset("--safe-area-inset-left"));
    const top = Math.max(host.top, 0, visualTop + inset("--safe-area-inset-top"));
    const right = Math.min(host.right, root.clientWidth, visualRight - inset("--safe-area-inset-right"));
    const bottom = Math.min(host.bottom, root.clientHeight, visualBottom - inset("--safe-area-inset-bottom"));
    const bounds = { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    const bubbleElement = document.querySelector<HTMLElement>("[data-testid=selection-bubble]");
    const bubble = bubbleElement ? toRect(bubbleElement.getBoundingClientRect()) : null;
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    const selection = range && !range.collapsed ? toRect(range.getBoundingClientRect()) : null;
    const outsidePixels = bubble
      ? Math.max(0, bounds.left + 8 - bubble.left, bubble.right - (bounds.right - 8), bounds.top + 8 - bubble.top, bubble.bottom - (bounds.bottom - 8))
      : 0;
    const scrolling = document.scrollingElement!;
    const toolbar = bubbleElement?.querySelector<HTMLElement>('[role="toolbar"]');
    return {
      bubble,
      bounds,
      selection,
      outsidePixels,
      horizontalOverflow: Math.max(0, scrolling.scrollWidth - root.clientWidth),
      toolbar: toolbar ? { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth, scrollLeft: toolbar.scrollLeft } : null,
    };
  }, RICH_SCROLLER);
}

async function expectVisibleGeometry(page: Page, label: string) {
  await expect(page.getByTestId("selection-bubble"), `${label}: toolbar is visible`).toBeVisible();
  for (let frame = 0; frame < 3; frame++) {
    await nextFrames(page, 1);
    const sample = await geometry(page);
    expect(sample.bubble, `${label}: frame ${frame} has a toolbar rectangle`).not.toBeNull();
    expect(sample.bounds.width, `${label}: visible pane width`).toBeGreaterThan(0);
    expect(sample.bounds.height, `${label}: visible pane height`).toBeGreaterThan(0);
    expect(sample.outsidePixels, `${label}: frame ${frame} border/shadow wrapper outside visible pane`).toBeLessThanOrEqual(0.51);
    expect(sample.horizontalOverflow, `${label}: frame ${frame} horizontal page overflow`).toBe(0);
    expect(sample.bubble!.width, `${label}: clamped width`).toBeCloseTo(Math.min(232, sample.bounds.width - 16), 0);
  }
}

async function expectHiddenGeometry(page: Page, label: string) {
  await nextFrames(page, 3);
  await expect(page.getByTestId("selection-bubble"), `${label}: toolbar leaves the DOM`).toHaveCount(0);
  expect((await geometry(page)).outsidePixels, `${label}: hidden-selection intersection pixels`).toBe(0);
}

async function expectEveryActionReachable(page: Page, label: string) {
  const bubble = page.getByTestId("selection-bubble");
  const toolbar = bubble.getByRole("toolbar");
  const buttons = bubble.getByRole("button");
  await expect(buttons).toHaveCount(6);
  for (let index = 0; index < 6; index++) {
    const button = buttons.nth(index);
    await button.evaluate((element) => {
      element.focus();
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    const [buttonBox, bubbleBox] = await Promise.all([button.boundingBox(), bubble.boundingBox()]);
    expect(buttonBox, `${label}: action ${index + 1} has a box`).not.toBeNull();
    expect(buttonBox!.width, `${label}: action ${index + 1} width`).toBeGreaterThanOrEqual(24);
    expect(buttonBox!.height, `${label}: action ${index + 1} height`).toBeGreaterThanOrEqual(24);
    expect(buttonBox!.x, `${label}: action ${index + 1} left edge`).toBeGreaterThanOrEqual(bubbleBox!.x - 0.51);
    expect(buttonBox!.x + buttonBox!.width, `${label}: action ${index + 1} right edge`).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 0.51);
  }
  const scroll = await toolbar.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollLeft: element.scrollLeft,
  }));
  expect(scroll.scrollWidth, `${label}: toolbar content remains available`).toBeGreaterThanOrEqual(scroll.clientWidth);
  if (scroll.scrollWidth > scroll.clientWidth) expect(scroll.scrollLeft, `${label}: focusing the last action reveals overflow`).toBeGreaterThan(0);
}

async function restoreSelection(page: Page) {
  const target = page.locator(".md-rich p").filter({ hasText: SELECTED_TEXT });
  await target.scrollIntoViewIfNeeded();
  await selectTextInRich(page, SELECTED_TEXT);
  await expectVisibleGeometry(page, "restored selection");
}

test.describe("selection toolbar scroll geometry", () => {
  test.describe.configure({ mode: "serial" });
  let documentId: string;
  let storedSession: StoredSession;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("selection-scroll"));
    documentId = await createDocument(page, DOC, "Selection scroll geometry");
    storedSession = await context.storageState();
    await context.close();
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.width}x${viewport.height}: 100%/200% zoom and motion preferences`, async ({ browser }) => {
      test.setTimeout(180_000);
      for (const scale of [1, 2]) {
        for (const reducedMotion of ["no-preference", "reduce"] as const) {
          const label = `${viewport.width}x${viewport.height} scale ${scale} motion ${reducedMotion}`;
          await test.step(label, async () => {
            const context = await browser.newContext({
              storageState: storedSession,
              viewport,
              reducedMotion,
              hasTouch: viewport.width <= 393,
            });
            const page = await context.newPage();
            await openRichDocument(page, documentId);
            await setPageScale(page, scale);
            await restoreSelection(page);
            await expectVisibleGeometry(page, label);
            await expectEveryActionReachable(page, label);
            const measured = await geometry(page);
            console.log(
              `[selection-bubble] ${label}: bounds ${measured.bounds.width.toFixed(1)}x${measured.bounds.height.toFixed(1)}, ` +
                `bubble ${measured.bubble!.width.toFixed(1)}x${measured.bubble!.height.toFixed(1)}, outside ${measured.outsidePixels.toFixed(1)} px, ` +
                `page overflow ${measured.horizontalOverflow}px, toolbar ${measured.toolbar!.clientWidth}/${measured.toolbar!.scrollWidth}px`,
            );
            await context.close();
          });
        }
      }
    });
  }

  test("scroll sources, selection edges, viewport changes, safe areas and transforms", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ storageState: storedSession, viewport: { width: 1440, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await openRichDocument(page, documentId);
    const scroller = page.locator(RICH_SCROLLER);

    await restoreSelection(page);
    await scroller.evaluate((element) => {
      const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const host = element.getBoundingClientRect();
      element.scrollTop += range.top - host.top + range.height / 2;
    });
    await expectVisibleGeometry(page, "partly visible selection");
    await scroller.evaluate((element) => {
      element.scrollTop += 30;
    });
    await expectHiddenGeometry(page, "selection above pane");

    await scroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expectHiddenGeometry(page, "selection below pane");
    await restoreSelection(page);
    await page.locator(".md-rich p").filter({ hasText: SELECTED_TEXT }).click();
    await expectHiddenGeometry(page, "cleared selection");

    await restoreSelection(page);
    const wheelBefore = await scroller.evaluate((element) => element.scrollTop);
    const host = (await scroller.boundingBox())!;
    await page.mouse.move(host.x + host.width / 2, host.y + host.height / 2);
    await page.mouse.wheel(0, 2_000);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(wheelBefore);
    await expectHiddenGeometry(page, "wheel scroll");

    await restoreSelection(page);
    const keyboardBefore = await scroller.evaluate((element) => element.scrollTop);
    await page.keyboard.press("PageDown");
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(keyboardBefore);
    await expectHiddenGeometry(page, "keyboard scroll");

    await restoreSelection(page);
    const touchBefore = await scroller.evaluate((element) => element.scrollTop);
    const touchHost = (await scroller.boundingBox())!;
    const cdp = await context.newCDPSession(page);
    const touchX = Math.round(touchHost.x + touchHost.width - 20);
    const touchY = Math.round(touchHost.y + touchHost.height * 0.75);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY }] });
    for (let offset = 50; offset <= 500; offset += 50) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: touchX, y: touchY - offset }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(touchBefore);
    await expectHiddenGeometry(page, "touch-style scroll");
    await cdp.detach();

    await page.evaluate((richScrollerSelector) => {
      const column = document.querySelector<HTMLElement>("[data-testid=rich-column]")!;
      const richScroller = document.querySelector<HTMLElement>(richScrollerSelector)!;
      column.style.overflowY = "auto";
      column.style.paddingTop = "80px";
      richScroller.style.flex = "0 0 auto";
      richScroller.style.height = `${column.clientHeight}px`;
    }, RICH_SCROLLER);
    await restoreSelection(page);
    const beforeAncestor = (await geometry(page)).bubble!;
    await page.getByTestId("rich-column").evaluate((column) => {
      column.scrollTop = 24;
    });
    await expect.poll(() => page.getByTestId("rich-column").evaluate((column) => column.scrollTop)).toBe(24);
    await expectVisibleGeometry(page, "captured ancestor scroll");
    expect((await geometry(page)).bubble!.top).toBeLessThan(beforeAncestor.top - 12);

    await page.reload();
    await waitForEditor(page);
    await page.evaluate(() => {
      document.body.style.height = "2200px";
      const shell = document.querySelector<HTMLElement>("[data-testid=editor-shell]")!;
      shell.style.position = "absolute";
      shell.style.top = "600px";
      shell.style.width = "100%";
      window.scrollTo(0, 600);
    });
    await restoreSelection(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectHiddenGeometry(page, "outer window scroll");
    await page.evaluate(() => window.scrollTo(0, 600));
    await expectVisibleGeometry(page, "outer window scroll restore");

    await page.setViewportSize({ width: 1024, height: 700 });
    await expectVisibleGeometry(page, "window resize");
    await setPageScale(page, 2);
    await restoreSelection(page);
    await expectVisibleGeometry(page, "visual viewport resize");

    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.setProperty("--safe-area-inset-top", "12px");
      root.style.setProperty("--safe-area-inset-right", "24px");
      root.style.setProperty("--safe-area-inset-bottom", "16px");
      root.style.setProperty("--safe-area-inset-left", "20px");
      window.dispatchEvent(new Event("resize"));
    });
    await expectVisibleGeometry(page, "safe-area bounds");

    const beforeTransform = (await geometry(page)).bubble!;
    await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>("[data-testid=rich-column]")!;
      column.style.transformOrigin = "top left";
      column.style.transform = "translate(32px, 24px) scale(0.85)";
      column.dispatchEvent(new Event("scroll"));
    });
    await expectVisibleGeometry(page, "translated and scaled pane");
    const afterTransform = (await geometry(page)).bubble!;
    expect(Math.abs(afterTransform.left - beforeTransform.left) + Math.abs(afterTransform.top - beforeTransform.top)).toBeGreaterThan(10);

    await setPageScale(page, 1);
    await page.evaluate(() => {
      const root = document.documentElement;
      for (const edge of ["top", "right", "bottom", "left"]) root.style.removeProperty(`--safe-area-inset-${edge}`);
      document.body.removeAttribute("style");
      const shell = document.querySelector<HTMLElement>("[data-testid=editor-shell]")!;
      shell.removeAttribute("style");
      document.querySelector<HTMLElement>("[data-testid=rich-column]")!.removeAttribute("style");
      window.scrollTo(0, 0);
    });
    await restoreSelection(page);
    await page.getByTestId("selection-bubble").getByRole("button", { name: "Bold" }).click();
    await expect(page.locator(".md-rich strong")).toContainText(SELECTED_TEXT);
    await context.close();
  });
});
