import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { devices, type Locator, type Page } from "@playwright/test";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "../src/editor/collab/session";
import { test, expect } from "./fixtures";
import { codeText, createDocument, devLogin, selectTextInRich, shareWith, signIn, uniqueLogin, waitForEditor } from "./helpers";

const prose = "Review the proposed change and its results. Keep the original whitespace and indentation while reading this long Markdown prompt without scrolling to the right.";
const token = `https://example.com/${"long-unbroken-token".repeat(12)}`;
const code = `${prose}\n\n  Keep  these spaces.\n${token}`;
const source = `# Preview code wrapping\n\n4. In the **prompt** field, paste:\n\n   \`\`\`markdown\n${code.split("\n").map((line) => `   ${line}`).join("\n")}\n   \`\`\`\n\n\`\`\`js\nconst message = "${prose}";\n\`\`\`\n\nEditable paragraph.\n`;
const mod = process.platform === "darwin" ? "Meta" : "Control";

interface TestWindow extends Window {
  __markdocSession: CollabSession;
  __markdocRichView: EditorView;
}

async function openPreview(page: Page, id: string) {
  await page.goto(`/d/${id}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
  await expect(page.locator(".md-rich .md-code-wrap")).toHaveCount(2);
}

const metrics = (codeBlock: Locator) => codeBlock.evaluate((element) => ({
  width: element.clientWidth,
  scrollWidth: element.scrollWidth,
  height: element.getBoundingClientRect().height,
  whiteSpace: getComputedStyle(element).whiteSpace,
  overflowWrap: getComputedStyle(element).overflowWrap,
}));

async function state(page: Page) {
  return page.evaluate(() => {
    const { __markdocSession: session, __markdocRichView: view } = window as unknown as TestWindow;
    return {
      source: session.ytext.toString(),
      metadata: session.meta.toJSON(),
      undo: session.undoManager.undoStack.length,
      redo: session.undoManager.redoStack.length,
      selection: view.state.selection.toJSON(),
    };
  });
}

for (const width of [1440, 360, 393]) {
  test(`preview wraps individual blocks without changing content at ${width}px`, async ({ browser }, testInfo) => {
    const phone = width < 600;
    const context = await browser.newContext({
      ...(phone ? devices["iPhone 13"] : {}),
      viewport: { width, height: phone ? 851 : 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await devLogin(page, uniqueLogin(`code-wrap-${width}`));
    const id = await createDocument(page, source, "Preview code wrapping");
    await openPreview(page, id);
    const blocks = page.locator(".md-rich pre.md-code-block");
    const first = blocks.nth(0);
    const firstCode = first.locator(":scope > code");
    const language = first.getByRole("textbox", { name: "Code block language" });
    const firstWrap = first.getByRole("button", { name: "Wrap code block" });
    const secondWrap = blocks.nth(1).getByRole("button", { name: "Wrap code block" });
    await expect(first).toHaveAttribute("data-language", "markdown");
    await expect(page.locator(".md-rich ol li pre")).toHaveCount(1);
    await expect(firstWrap).toHaveAttribute("aria-pressed", "false");
    await expect(firstCode).toHaveText(code);
    await expect.poll(async () => (await metrics(firstCode)).scrollWidth > (await metrics(firstCode)).width).toBe(true);
    await expect.poll(() => blocks.nth(1).locator('[class*="hljs-"]').count()).toBeGreaterThan(0);
    const before = await metrics(firstCode);
    const languageBox = (await language.boundingBox())!;
    const buttonBox = (await firstWrap.boundingBox())!;
    if (phone) {
      expect(buttonBox.width).toBeGreaterThanOrEqual(44);
      expect(buttonBox.height).toBeGreaterThanOrEqual(44);
    }

    const beforeScroll = await state(page);
    for (const fraction of [0, 0.5, 1]) {
      const scrolled = await first.evaluate((element, fraction) => {
        element.scrollLeft = fraction * (element.scrollWidth - element.clientWidth);
        const code = element.querySelector("code")!;
        return { scrollLeft: element.scrollLeft, codeX: code.getBoundingClientRect().x };
      }, fraction);
      if (fraction > 0) expect(scrolled.scrollLeft).toBeGreaterThan(0);
      const frame = (await first.boundingBox())!;
      for (const [control, initial] of [[language, languageBox], [firstWrap, buttonBox]] as const) {
        const current = (await control.boundingBox())!;
        expect(Math.abs(current.x - initial.x), `control x at scroll fraction ${fraction}`).toBeLessThan(1);
        expect(current.y, `control y at scroll fraction ${fraction}`).toBe(initial.y);
        expect(current.x).toBeGreaterThanOrEqual(frame.x);
        expect(current.x + current.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
        })).toBe(true);
      }
      if (fraction > 0) expect(scrolled.codeX).toBeLessThan(frame.x);
      expect(await state(page)).toEqual(beforeScroll);
    }
    await first.evaluate((element) => { element.scrollLeft = 0; });
    if (process.env.SHOT_DIR) {
      await first.screenshot({ path: path.join(process.env.SHOT_DIR, `code-wrap-${width}-before.png`), scale: "css" });
    }
    const original = await state(page);
    if (phone) await firstWrap.tap();
    else await firstWrap.click();
    await expect(firstWrap).toHaveAttribute("aria-pressed", "true");
    await expect(secondWrap).toHaveAttribute("aria-pressed", "false");
    const wrapped = await metrics(firstCode);
    expect(wrapped.whiteSpace).toBe("pre-wrap");
    expect(wrapped.overflowWrap).toBe("anywhere");
    expect(wrapped.scrollWidth).toBeLessThanOrEqual(wrapped.width + 1);
    expect(wrapped.height).toBeGreaterThan(before.height);
    expect(await firstCode.textContent()).toBe(code);
    expect(await state(page)).toEqual(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await first.screenshot({ path: testInfo.outputPath(`code-wrap-${width}-after.png`), scale: "css" });
    if (process.env.SHOT_DIR) {
      await first.screenshot({ path: path.join(process.env.SHOT_DIR, `code-wrap-${width}-after.png`), scale: "css" });
    }
    const accessibility = await new AxeBuilder({ page })
      .include(".md-rich pre.md-code-block")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    await secondWrap.focus();
    await page.keyboard.press("Space");
    await expect(secondWrap).toHaveAttribute("aria-pressed", "true");
    await expect(firstWrap).toHaveAttribute("aria-pressed", "true");
    expect(await blocks.nth(1).locator('[class*="hljs-"]').count()).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(secondWrap).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator(".md-rich")).toBeFocused();
    if (phone) await firstWrap.tap();
    else await firstWrap.click();
    await expect(firstWrap).toHaveAttribute("aria-pressed", "false");
    expect((await metrics(firstCode)).height).toBe(before.height);
    expect((await metrics(firstCode)).scrollWidth).toBeGreaterThan(before.width);
    expect(await codeText(page)).toBe(source);

    await firstWrap.click();
    await firstCode.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (element.closest(".md-rich") as HTMLElement).focus();
    });
    await expect.poll(() => page.evaluate(() => {
      const view = (window as unknown as TestWindow).__markdocRichView;
      return view.state.doc.textBetween(view.state.selection.from, view.state.selection.to);
    })).toBe(code);
    const copied = await page.locator(".md-rich").evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
      return { text: clipboardData.getData("text/plain"), html: clipboardData.getData("text/html") };
    });
    expect(copied.text).toBe(code);
    expect(copied.html).not.toContain("md-code-controls");
    expect(copied.html).not.toContain("<button");
    const exported = await page.request.get(`/api/documents/${id}/export?format=md`);
    expect(exported.ok()).toBe(true);
    expect(await exported.text()).toBe(source);

    await firstWrap.click();
    await first.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await language.focus();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("text");
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("data-language", "text");
    await expect(page.locator(".md-rich")).toBeFocused();
    await expect.poll(() => codeText(page)).toBe(source.replace("```markdown", "```text"));
    expect(await firstCode.textContent()).toBe(code);
    await expect(firstWrap).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => codeText(page)).toBe(source);
    await expect(language).toHaveValue("markdown");
    await context.close();
  });
}

test("wrapping is local for viewers and preserves selection, edits and collaborative undo", async ({ browser }) => {
  const owner = await signIn(browser, uniqueLogin("wrap-owner"));
  const viewer = await signIn(browser, uniqueLogin("wrap-viewer"));
  const id = await createDocument(owner.page, source);
  await shareWith(owner.page, id, viewer.login, "viewer");
  await Promise.all([openPreview(owner.page, id), openPreview(viewer.page, id)]);
  const ownerWrap = owner.page.getByRole("button", { name: "Wrap code block" }).first();
  const viewerWrap = viewer.page.getByRole("button", { name: "Wrap code block" }).first();
  await expect(viewer.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
  await viewerWrap.click();
  await expect(viewerWrap).toHaveAttribute("aria-pressed", "true");
  await expect(ownerWrap).toHaveAttribute("aria-pressed", "false");
  await selectTextInRich(owner.page, "these spaces.");
  const selected = await state(owner.page);
  await ownerWrap.click();
  expect(await state(owner.page)).toEqual(selected);
  expect(await owner.page.evaluate(() => document.getSelection()?.toString())).toBe("these spaces.");
  await owner.page.keyboard.type("edited spaces.");
  await expect.poll(() => codeText(owner.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await expect.poll(() => codeText(viewer.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await expect(ownerWrap).toHaveAttribute("aria-pressed", "true");
  await expect(viewerWrap).toHaveAttribute("aria-pressed", "true");
  await owner.page.keyboard.press(`${mod}+z`);
  await expect.poll(() => codeText(owner.page)).toBe(source);
  await expect.poll(() => codeText(viewer.page)).toBe(source);
  await expect(ownerWrap).toHaveAttribute("aria-pressed", "true");
  await owner.page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => codeText(viewer.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await owner.context.close();
  await viewer.context.close();
});
