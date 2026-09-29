import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, clickEdgeOf, selectTextInRich } from "./helpers";

/**
 * Every toolbar button in every layout (Burke: "the horizontal rule button doesn't appear to insert
 * anything in preview mode — check that all buttons work in all modes"). The layout is switched through
 * the View options menu exactly as a person does it, so a menu that stays open (and leaves the page inert
 * behind its modal layer) fails here too. Each action must land in the pane on screen.
 */

type Layout = "split" | "rich" | "code";

const DOC = ["# Title", "", "Intro text.", "", "Target paragraph.", "", "After text.", ""].join("\n");
const LAYOUT_LABEL: Record<Layout, RegExp> = { split: /Code and preview/, rich: /Preview only/, code: /Code only/ };

const toolbar = (page: Page) => page.getByTestId("toolbar");
const toolButton = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });
/** Y.UndoManager merges edits closer than 400 ms; keep each action its own step. */
const settle = (page: Page) => page.waitForTimeout(450);

async function chooseLayout(page: Page, layout: Layout) {
  await page.getByTestId("layout-menu").click();
  await page.getByRole("menuitemradio", { name: LAYOUT_LABEL[layout] }).click();
  await expect(page.getByRole("menu"), "picking a layout closes View options").toHaveCount(0);
  await expect(page.getByTestId("rich-column")).toBeVisible({ visible: layout !== "code" });
  await expect(page.getByTestId("code-column")).toBeVisible({ visible: layout !== "rich" });
}

const targetLine = (page: Page) => page.locator(".cm-line", { hasText: "Target paragraph." });

/** Caret at the end of the target paragraph, in the pane on screen (the preview when both are). */
async function caretInTarget(page: Page, layout: Layout) {
  if (layout === "code") {
    await targetLine(page).click();
    await page.keyboard.press("End");
  } else {
    await clickEdgeOf(page, "p:nth-of-type(2)", "end");
  }
  await settle(page);
}

/** Select the word "Target" in the pane on screen. */
async function selectTarget(page: Page, layout: Layout) {
  if (layout === "code") {
    await targetLine(page).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    for (let i = 0; i < " paragraph.".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  } else {
    await selectTextInRich(page, "Target");
  }
  await settle(page);
}

/** Undo with the toolbar button until the document is back to DOC. */
async function undoToStart(page: Page) {
  for (let i = 0; i < 6 && (await codeText(page)) !== DOC; i++) {
    await expect(page.getByTestId("tb-undo")).toBeEnabled();
    await page.getByTestId("tb-undo").click();
    await page.waitForTimeout(150);
  }
  await expect.poll(() => codeText(page), { message: "toolbar undo restores the document" }).toBe(DOC);
}

interface Check {
  name: string;
  select: "caret" | "word";
  apply: (page: Page) => Promise<void>;
  expect: RegExp;
}

const CHECKS: Check[] = [
  { name: "Heading 2", select: "caret", expect: /^## Target paragraph\.$/m, apply: async (page) => {
    await page.getByTestId("heading-menu").click();
    await page.getByRole("menuitemradio", { name: "Heading 2" }).click();
  } },
  { name: "Bold", select: "word", expect: /\*\*Target\*\* paragraph\./, apply: (page) => toolButton(page, "Bold").click() },
  { name: "Italic", select: "word", expect: /([*_])Target\1 paragraph\./, apply: (page) => toolButton(page, "Italic").click() },
  { name: "Strikethrough", select: "word", expect: /~~Target~~ paragraph\./, apply: (page) => toolButton(page, "Strikethrough").click() },
  { name: "Inline code", select: "word", expect: /`Target` paragraph\./, apply: (page) => toolButton(page, "Inline code").click() },
  { name: "Code block", select: "caret", expect: /```/, apply: (page) => toolButton(page, "Code block").click() },
  { name: "Bulleted list", select: "caret", expect: /^- Target paragraph\.$/m, apply: (page) => toolButton(page, "Bulleted list").click() },
  { name: "Numbered list", select: "caret", expect: /^1\. Target paragraph\.$/m, apply: (page) => toolButton(page, "Numbered list").click() },
  { name: "Task list", select: "caret", expect: /^- \[ \] Target paragraph\.$/m, apply: (page) => toolButton(page, "Task list").click() },
  { name: "Quote", select: "caret", expect: /^> Target paragraph\.$/m, apply: (page) => toolButton(page, "Quote").click() },
  { name: "Horizontal rule", select: "caret", expect: /Target paragraph\.\n+---\n/, apply: (page) => toolButton(page, "Horizontal rule").click() },
  { name: "Link", select: "word", expect: /\[Target\]\(https:\/\/example\.com\/docs\) paragraph\./, apply: async (page) => {
    await page.getByTestId("tb-link").click();
    await page.getByTestId("link-url").fill("example.com/docs");
    await page.getByTestId("link-submit").click();
  } },
  { name: "Image", select: "caret", expect: /!\[A picture\]\(https:\/\/example\.com\/pic\.png\)/, apply: async (page) => {
    await page.getByTestId("tb-image").click();
    await page.getByTestId("image-url").fill("https://example.com/pic.png");
    await page.getByTestId("image-alt").fill("A picture");
    await page.getByTestId("image-submit").click();
  } },
  { name: "Table", select: "caret", expect: /\| Column 1 \| Column 2 \| Column 3 \|/, apply: async (page) => {
    await page.getByTestId("tb-table").click();
    await page.getByTestId("table-grid").getByRole("button", { name: "2 by 3" }).click();
  } },
];

test.describe("toolbar in every layout", () => {
  for (const layout of ["split", "rich", "code"] as const) {
    test(`${layout}: every toolbar button edits the pane on screen`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { page, context } = await signIn(browser, `toolbar-${layout}`);
      const id = await createDocument(page, DOC);
      await openDocument(page, id);
      // Focus the other pane first, so a hidden pane that last had focus cannot take the edits.
      if (layout === "rich") await targetLine(page).click();
      if (layout === "code") await clickEdgeOf(page, "p:nth-of-type(2)", "end");
      if (layout !== "split") await chooseLayout(page, layout);

      for (const check of CHECKS) {
        const step = `${layout}: ${check.name}`;
        if (check.select === "word") await selectTarget(page, layout);
        else await caretInTarget(page, layout);
        await check.apply(page);
        await expect.poll(() => codeText(page), { message: step }).toMatch(check.expect);
        if (check.name === "Horizontal rule" && layout !== "code") {
          await expect(page.locator(".md-rich > hr"), `${step}: the rule is in the preview`).toHaveCount(1);
          await expect(page.locator(".md-rich > hr"), `${step}: the rule is visible`).toHaveCSS("border-top-color", "rgb(148, 142, 136)");
        }
        await settle(page);
        await undoToStart(page);
      }

      // Redo brings the last undone edit back.
      await caretInTarget(page, layout);
      await toolButton(page, "Horizontal rule").click();
      await expect.poll(() => codeText(page)).toMatch(/\n---\n/);
      await settle(page);
      await page.getByTestId("tb-undo").click();
      await expect.poll(() => codeText(page)).toBe(DOC);
      await page.getByTestId("tb-redo").click();
      await expect.poll(() => codeText(page), { message: `${layout}: redo` }).toMatch(/\n---\n/);

      // Comment opens the composer on the selected text.
      await settle(page);
      await undoToStart(page);
      await selectTarget(page, layout);
      await page.getByTestId("tb-comment").click();
      await expect(page.getByTestId("pending-comment").getByTestId("comment-composer"), `${layout}: comment`).toBeFocused();
      await context.close();
    });
  }
});

test.describe("View options menu", () => {
  test("closes after a pick, on Escape and on an outside click", async ({ browser }) => {
    const { page, context } = await signIn(browser, "view-options-close");
    const id = await createDocument(page, DOC);
    await openDocument(page, id);
    const trigger = page.getByTestId("layout-menu");

    await chooseLayout(page, "rich");
    await chooseLayout(page, "code");
    await chooseLayout(page, "split");

    await trigger.click();
    await page.getByRole("menuitemcheckbox", { name: /Wrap long lines/ }).click();
    await expect(page.getByRole("menu"), "toggling an option closes the menu").toHaveCount(0);

    await trigger.click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu"), "Escape closes the menu").toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    await trigger.click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    const box = await page.locator(".md-rich").boundingBox();
    await page.mouse.click(box!.x + 40, box!.y + box!.height - 20);
    await expect(page.getByRole("menu"), "an outside click closes the menu").toHaveCount(0);

    // The page is interactive again: the toolbar edits the preview.
    await clickEdgeOf(page, "p:nth-of-type(2)", "end");
    await toolButton(page, "Horizontal rule").click();
    await expect.poll(() => codeText(page)).toMatch(/Target paragraph\.\n\n---\n/);
    await context.close();
  });
});
