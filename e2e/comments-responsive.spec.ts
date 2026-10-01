import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "../src/editor/collab/session";
import { PHONE_MAX, TABLET_MAX } from "../src/lib/viewport";
import { createDocument, selectTextInRich, signIn, uniqueLogin, waitForEditor } from "./helpers";

type EditorWindow = Window & { __markdocSession?: CollabSession; __markdocRichView?: EditorView };
const TYPED = "abcdefghijklmnopqrst";
const QUOTE = "Commented words stay editable";
const CONTENT = "# Responsive comments\n\n" +
  Array.from({ length: 35 }, (_, i) => i === 15 ? `${QUOTE} while reading and writing.` : `Paragraph ${i + 1} has plain text for scrolling and selecting.`).join("\n\n") + "\n";
const SCROLLER = '[data-testid="rich-column"] .overflow-y-auto';

async function openEditor(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
}

async function previewOnly(page: Page, width: number) {
  if (width < PHONE_MAX) return;
  await page.getByTestId("layout-menu").click();
  await page.getByRole("menuitemradio", { name: /Preview only/ }).click();
  await expect(page.getByTestId("code-column")).toBeHidden();
}

async function reading(page: Page) {
  return page.evaluate((selector) => {
    const runtime: EditorWindow = window;
    const { __markdocRichView: view, __markdocSession: session } = runtime;
    if (!view || !session) throw new Error("The editor is not ready");
    const { anchor, head } = view.state.selection;
    return {
      text: session.ytext.toString(),
      anchor,
      head,
      from: session.binding.getSourceMap().pmToSrc(view.state.selection.from),
      to: session.binding.getSourceMap().pmToSrc(view.state.selection.to),
      focused: view.hasFocus(),
      scrollTop: document.querySelector<HTMLElement>(selector)!.scrollTop,
    };
  }, SCROLLER);
}

async function noOverlay(page: Page) {
  await expect(page.getByTestId("sheet")).toHaveCount(0);
  await expect(page.getByTestId("panel-overlay")).toHaveCount(0);
  await expect(page.getByTestId("comments-panel")).toHaveCount(0);
}

async function checkPanel(page: Page, width: number, thread: string) {
  const panelKind = width < PHONE_MAX ? "sheet" : width < TABLET_MAX ? "panel-overlay" : "side-panel";
  await expect(page.getByTestId(panelKind)).toBeVisible();
  const card = page.getByTestId("comment-thread");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-thread-id", thread);
  await expect(card).toHaveClass(/border-accent/);
  const close = page.getByRole("button", { name: "Close comments" });
  await expect(close).toBeVisible();
  await close.evaluate((element) => Promise.all(element.closest('[role="dialog"]')?.getAnimations().map((animation) => animation.finished) ?? []));
  const box = (await close.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}

for (const width of [390, 520, 768, 1024, 1280]) {
  test(`comment editing and explicit open/close at ${width} CSS px`, async ({ browser }) => {
    const { page, context } = await signIn(browser, uniqueLogin(`comments-${width}`));
    try {
      await page.setViewportSize({ width, height: 844 });
      const id = await createDocument(page, CONTENT, "Synthetic responsive comments");
      const response = await page.request.post(`/api/documents/${id}/comments`, { data: { action: "add", quote: QUOTE, body: "One intended thread" } });
      expect(response.ok()).toBe(true);
      const thread = ((await response.json()) as { id: string }).id;
      await openEditor(page, id);
      const breakpoint = width < PHONE_MAX ? "phone" : width < TABLET_MAX ? "tablet" : "desktop";
      await expect(page.getByTestId("editor-shell")).toHaveAttribute("data-breakpoint", breakpoint);
      await expect(page.getByTestId("code-column")).toBeVisible({ visible: width >= PHONE_MAX });
      await expect(page.getByTestId("rich-column")).toBeVisible();
      console.log(`[comments-responsive] ${width}px: ${breakpoint}, default ${width < PHONE_MAX ? "rich" : "split"}`);
      await previewOnly(page, width);

      const mark = page.locator(`.md-rich [data-highlight-id="${thread}"]`).first();
      await mark.click();
      // A highlight click activates its thread after a 750 ms window (highlights.ts); typing sooner cancels it.
      await expect.poll(() => page.evaluate(() => (window as EditorWindow).__markdocSession?.activeCommentId ?? null)).toBe(thread);
      if (width < TABLET_MAX) await noOverlay(page);
      else await checkPanel(page, width, thread);
      const before = await reading(page);
      expect(before.focused).toBe(true);
      expect(before.anchor).toBe(before.head);
      await page.keyboard.type(TYPED);
      await expect.poll(async () => (await reading(page)).text).toBe(before.text.slice(0, before.from) + TYPED + before.text.slice(before.to));
      if (width >= TABLET_MAX) await page.getByRole("button", { name: "Close comments" }).click();

      // Mouse text selection, double-click and a native context menu never request a narrow panel.
      await mark.scrollIntoViewIfNeeded();
      const point = await mark.evaluate((element) => {
        const rect = element.getClientRects()[0];
        return { x: rect.left + 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 20, point.y, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => {
        const selection = await reading(page);
        return selection.anchor !== selection.head;
      }).toBe(true);
      if (width < TABLET_MAX) await noOverlay(page);
      await mark.dblclick();
      if (width < TABLET_MAX) await noOverlay(page);
      await mark.click({ button: "right" });
      if (width < TABLET_MAX) await noOverlay(page);
      await page.keyboard.press("Escape");
      if (width >= TABLET_MAX && await page.getByTestId("comments-panel").count()) {
        await page.getByRole("button", { name: "Close comments" }).click();
      }
      await selectTextInRich(page, TYPED);
      const selected = await reading(page);
      await page.getByTestId("comments-toggle").click();
      await checkPanel(page, width, thread);
      const close = page.getByRole("button", { name: "Close comments" });
      await close.focus();
      await page.keyboard.press("Enter");
      await noOverlay(page);
      const after = await reading(page);
      expect(after.text).toBe(selected.text);
      expect(after.anchor).toBe(selected.anchor);
      expect(after.head).toBe(selected.head);
      if (width < TABLET_MAX) {
        expect(after.focused).toBe(true);
        expect(Math.abs(after.scrollTop - selected.scrollTop)).toBeLessThanOrEqual(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
}

test("automatic desktop panels close on narrowing; explicit panels remain and restore editing", async ({ browser }) => {
  const { page, context } = await signIn(browser, uniqueLogin("comments-resize"));
  try {
    await page.setViewportSize({ width: 1280, height: 844 });
    const id = await createDocument(page, CONTENT, "Synthetic comment resize");
    const response = await page.request.post(`/api/documents/${id}/comments`, { data: { action: "add", quote: QUOTE, body: "One intended thread" } });
    expect(response.ok()).toBe(true);
    const thread = ((await response.json()) as { id: string }).id;
    await openEditor(page, id);
    await previewOnly(page, 1280);
    const mark = page.locator(`.md-rich [data-highlight-id="${thread}"]`).first();
    for (const width of [390, 520, 768]) {
      await page.setViewportSize({ width: 1280, height: 844 });
      await mark.click();
      await checkPanel(page, 1280, thread);
      await page.setViewportSize({ width, height: 844 });
      await noOverlay(page);
      await expect.poll(async () => (await reading(page)).focused).toBe(true);
      await page.setViewportSize({ width: 1280, height: 844 });
      await noOverlay(page);
      await page.getByTestId("comments-toggle").focus();
      await page.keyboard.press("Enter");
      await checkPanel(page, 1280, thread);
      await page.setViewportSize({ width, height: 844 });
      await checkPanel(page, width, thread);
      await page.getByRole("button", { name: "Close comments" }).click();
      await expect.poll(async () => (await reading(page)).focused).toBe(true);
    }
  } finally {
    await context.close();
  }
});
