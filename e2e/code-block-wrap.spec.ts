import AxeBuilder from "@axe-core/playwright";
import { devices, type Locator, type Page } from "@playwright/test";
import type { EditorView } from "prosemirror-view";
import type { CollabSession } from "../src/editor/collab/session";
import { PREVIEW_CODE_WRAP_STORAGE_KEY } from "../src/lib/preview-code-wrap";
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
  await expect(page.locator(".md-rich .md-code-lang-input").first()).toBeVisible();
  await expect(page.locator(".md-rich .md-code-wrap")).toHaveCount(0);
}

async function toggleWrap(page: Page, phone = false) {
  const setting = page.getByRole("switch", { name: "Wrap code blocks" });
  if (phone) await setting.tap();
  else await setting.click();
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
  test(`top-level Wrap switch wraps all blocks and stays reachable at ${width}px`, async ({ browser }, testInfo) => {
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
    const column = page.getByTestId("rich-column");
    const blocks = page.locator(".md-rich pre.md-code-block");
    const first = blocks.nth(0);
    const firstCode = first.locator(":scope > code");
    const language = first.getByRole("textbox", { name: "Code block language" });
    const setting = page.getByRole("switch", { name: "Wrap code blocks" });
    await expect(setting).toHaveCount(1);
    await expect(setting).toHaveAttribute("aria-checked", "false");
    if (phone) {
      expect((await setting.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(column).toHaveAttribute("data-wrap-code", "false");
    await expect(first).toHaveAttribute("data-language", "markdown");
    await expect(page.locator(".md-rich ol li pre")).toHaveCount(1);
    await expect(firstCode).toHaveText(code);
    await expect.poll(async () => (await metrics(firstCode)).scrollWidth > (await metrics(firstCode)).width).toBe(true);
    await expect.poll(() => blocks.nth(1).locator('[class*="hljs-"]').count()).toBeGreaterThan(0);
    const before = await metrics(firstCode);
    const languageBox = (await language.boundingBox())!;
    const beforeScroll = await state(page);
    for (const fraction of [0, 0.5, 1]) {
      const scrolled = await first.evaluate((element, fraction) => {
        element.scrollLeft = fraction * (element.scrollWidth - element.clientWidth);
        return { scrollLeft: element.scrollLeft, codeX: element.querySelector("code")!.getBoundingClientRect().x };
      }, fraction);
      if (fraction > 0) expect(scrolled.scrollLeft).toBeGreaterThan(0);
      const frame = (await first.boundingBox())!;
      const current = (await language.boundingBox())!;
      expect(Math.abs(current.x - languageBox.x)).toBeLessThan(1);
      expect(current.y).toBe(languageBox.y);
      expect(current.x).toBeGreaterThanOrEqual(frame.x);
      expect(current.x + current.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(await language.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
      })).toBe(true);
      if (fraction > 0) expect(scrolled.codeX).toBeLessThan(frame.x);
      expect(await state(page)).toEqual(beforeScroll);
    }
    await first.evaluate((element) => { element.scrollLeft = 0; });
    const original = await state(page);
    await toggleWrap(page, phone);
    await expect(column).toHaveAttribute("data-wrap-code", "true");
    for (const block of await blocks.all()) {
      const wrapped = await metrics(block.locator(":scope > code"));
      expect(wrapped.whiteSpace).toBe("pre-wrap");
      expect(wrapped.overflowWrap).toBe("anywhere");
      expect(wrapped.scrollWidth).toBeLessThanOrEqual(wrapped.width + 1);
    }
    expect((await metrics(firstCode)).height).toBeGreaterThan(before.height);
    expect(await firstCode.textContent()).toBe(code);
    expect(await state(page)).toEqual(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await first.screenshot({ path: testInfo.outputPath(`code-wrap-${width}-after.png`), scale: "css" });
    const accessibility = await new AxeBuilder({ page })
      .include(".md-rich pre.md-code-block")
      .include('[data-testid="preview-toolbar"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    const trigger = page.getByRole("button", { name: "Preview font" });
    await setting.focus();
    await expect(setting).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Space");
    await expect(column).toHaveAttribute("data-wrap-code", "false");
    await expect(setting).toHaveAttribute("aria-checked", "false");
    await expect(setting).toBeFocused();
    await expect(page.getByTestId("preview-menu")).toHaveCount(0);
    expect((await metrics(firstCode)).height).toBe(before.height);
    expect((await metrics(firstCode)).scrollWidth).toBeGreaterThan(before.width);
    await page.keyboard.press("Enter");
    await expect(column).toHaveAttribute("data-wrap-code", "true");

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

    await toggleWrap(page, phone);
    await first.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await language.focus();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("text");
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("data-language", "text");
    await expect(page.locator(".md-rich")).toBeFocused();
    await expect.poll(() => codeText(page)).toBe(source.replace("```markdown", "```text"));
    expect(await firstCode.textContent()).toBe(code);
    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => codeText(page)).toBe(source);
    await expect(language).toHaveValue("markdown");

    await toggleWrap(page, phone);
    await page.reload();
    await waitForEditor(page);
    await expect(column).toHaveAttribute("data-wrap-code", "true");
    expect(await page.evaluate((key) => localStorage.getItem(key), PREVIEW_CODE_WRAP_STORAGE_KEY)).toBe("on");
    const longSource = `${source}\n${Array.from({ length: 25 }, (_, i) => `## ${i === 12 ? "Review target" : `Section ${i + 1}`}\n\n${prose}\n\n\`\`\`markdown\n${prose}\n\`\`\`\n`).join("\n")}`;
    const otherId = await createDocument(page, longSource, "Long preview");
    await openPreview(page, otherId);
    await expect(column).toHaveAttribute("data-wrap-code", "true");
    await expect(blocks).toHaveCount(27);
    const scroll = column.locator(":scope > .scrollbar-thin");
    const toolbar = page.getByTestId("preview-toolbar");
    const toolbarBox = (await toolbar.boundingBox())!;
    const switchBox = (await setting.boundingBox())!;
    for (const fraction of [0, 0.5, 1]) {
      await scroll.evaluate((element, fraction) => { element.scrollTop = fraction * (element.scrollHeight - element.clientHeight); }, fraction);
      expect((await toolbar.boundingBox())!.y).toBe(toolbarBox.y);
      for (const control of [setting, trigger]) {
        expect(await control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })).toBe(true);
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect((await setting.boundingBox())!.y).toBe(switchBox.y);
      await toggleWrap(page, phone);
      await expect(setting).toHaveAttribute("aria-checked", "false");
      await expect(column).toHaveAttribute("data-wrap-code", "false");
      await toggleWrap(page, phone);
      await expect(setting).toHaveAttribute("aria-checked", "true");
      await expect(column).toHaveAttribute("data-wrap-code", "true");
      await trigger.click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Wrap code blocks" })).toHaveCount(0);
      const menuBox = (await page.getByTestId("preview-menu").boundingBox())!;
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(phone ? 851 : 1000);
      const menuAccessibility = await new AxeBuilder({ page }).include('[data-testid="preview-menu"]').analyze();
      expect(menuAccessibility.violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    }
    if (phone) await page.getByTestId("outline-button").click();
    await page.getByRole("navigation", { name: "Document outline" }).getByRole("button", { name: "Review target", exact: true }).click();
    const heading = page.locator(".md-rich h2", { hasText: "Review target" });
    await expect(heading).toBeInViewport();
    await heading.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const headingBox = (await heading.boundingBox())!;
    expect(headingBox.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
    expect((await scroll.boundingBox())!.y).toBeGreaterThanOrEqual(toolbarBox.y + toolbarBox.height);
    expect(await codeText(page)).toBe(longSource);
    await page.screenshot({ path: testInfo.outputPath(`wrap-switch-${width}-scrolled.png`), scale: "css", animations: "disabled" });
    await context.close();
  });
}

test("wrapping is browser-local for viewers and preserves selection, edits, undo, reader and exports", async ({ browser }) => {
  const owner = await signIn(browser, uniqueLogin("wrap-owner"));
  const viewer = await signIn(browser, uniqueLogin("wrap-viewer"));
  const id = await createDocument(owner.page, source);
  await shareWith(owner.page, id, viewer.login, "viewer");
  await Promise.all([openPreview(owner.page, id), openPreview(viewer.page, id)]);
  const exportBefore = await owner.page.request.get(`/api/documents/${id}/export?format=html`);
  expect(exportBefore.ok()).toBe(true);
  const htmlBefore = await exportBefore.text();
  await expect(viewer.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
  await toggleWrap(viewer.page);
  await expect(viewer.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "true");
  await expect(owner.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "false");
  await selectTextInRich(owner.page, "these spaces.");
  const selected = await state(owner.page);
  await toggleWrap(owner.page);
  expect(await state(owner.page)).toEqual(selected);
  await owner.page.locator(".md-rich").focus();
  await owner.page.keyboard.type("edited spaces.");
  await expect.poll(() => codeText(owner.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await expect.poll(() => codeText(viewer.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await expect(owner.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "true");
  await expect(viewer.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "true");
  await owner.page.keyboard.press(`${mod}+z`);
  await expect.poll(() => codeText(owner.page)).toBe(source);
  await expect.poll(() => codeText(viewer.page)).toBe(source);
  const exportAfter = await owner.page.request.get(`/api/documents/${id}/export?format=html`);
  expect(exportAfter.ok()).toBe(true);
  expect(await exportAfter.text()).toBe(htmlBefore);
  const reader = await owner.context.newPage();
  await reader.goto(`/p/${id}`);
  await expect(reader.locator(".reader-body pre").first()).toHaveCSS("white-space", "pre");
  await reader.close();

  const sameBrowser = await owner.context.newPage();
  await openPreview(sameBrowser, id);
  await expect(sameBrowser.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "true");
  await toggleWrap(sameBrowser);
  await expect(owner.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "false");
  await expect(viewer.page.getByTestId("rich-column")).toHaveAttribute("data-wrap-code", "true");
  await sameBrowser.close();
  await owner.page.locator(".md-rich").focus();
  await owner.page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(() => codeText(viewer.page)).toBe(source.replace("these spaces.", "edited spaces."));
  await owner.context.close();
  await viewer.context.close();
});
