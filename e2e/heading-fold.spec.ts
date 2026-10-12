import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { createDocument, openDocument, signIn, uniqueLogin } from "./helpers";

/**
 * Heading folds in the rich editor (#2378), driven by real mouse clicks on the chevron the stylesheet draws
 * in the left padding. The unit tests cover the fold rules; only a browser can say that the click lands on
 * the heading's ::before and that the page does not move.
 */

const DOC = [
  "# Project Atlas",
  "Atlas moves our notes into one workspace.",
  "## Goals",
  "Three things have to be true.",
  "### Primary",
  "Every document opens in under a second.",
  "### Secondary",
  "Import the old notes folder.",
  "## Timeline",
  "Work runs in two phases.",
  "### Phase one",
  "Bring in the existing files.",
  "# Appendix",
  "Glossary and open questions.",
  "## Nothing under this",
].join("\n\n") + "\n";

const rich = (page: Page) => page.locator(".md-rich");
const paragraph = (page: Page, text: string) => rich(page).locator("> p", { hasText: text });

/** Where the chevron of the heading with this text is on screen (centre of its ::before). */
async function chevronPoint(page: Page, heading: string): Promise<{ x: number; y: number }> {
  return page.evaluate((text) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(".md-rich > h1, .md-rich > h2, .md-rich > h3")).find(
      (h) => h.firstChild?.textContent === text,
    );
    if (!el) throw new Error(`no heading ${text}`);
    el.scrollIntoView({ block: "center" });
    const box = el.getBoundingClientRect();
    const before = getComputedStyle(el, "::before");
    return { x: box.left - parseFloat(before.width) / 2, y: box.top + parseFloat(before.top) + parseFloat(before.height) / 2 };
  }, heading);
}

async function clickChevron(page: Page, heading: string, options: { alt?: boolean } = {}) {
  const { x, y } = await chevronPoint(page, heading);
  if (options.alt) await page.keyboard.down("Alt");
  try {
    await page.mouse.click(x, y);
  } finally {
    if (options.alt) await page.keyboard.up("Alt");
  }
}

async function open(browser: Parameters<typeof signIn>[0], name: string) {
  const user = await signIn(browser, uniqueLogin(name));
  const id = await createDocument(user.page, DOC, "Fold test");
  await openDocument(user.page, id);
  return { ...user, id };
}

test("a click on the gutter chevron folds a section and the tag unfolds it", async ({ browser }) => {
  const { page } = await open(browser, "fold-click");
  await expect(paragraph(page, "Three things")).toBeVisible();

  await clickChevron(page, "Goals");
  await expect(paragraph(page, "Three things")).toBeHidden();
  await expect(rich(page).locator("> h3", { hasText: "Primary" })).toBeHidden();
  await expect(paragraph(page, "Work runs")).toBeVisible();
  const tag = rich(page).getByRole("button", { name: /Unfold section, 5 blocks hidden/ });
  await expect(tag).toBeVisible();

  await tag.click();
  await expect(paragraph(page, "Three things")).toBeVisible();
  await expect(tag).toHaveCount(0);

  // The fold is a view setting: the Markdown source still has every line.
  await expect(page.locator(".cm-content")).toContainText("Three things have to be true.");
});

test("folding an h1 folds the h2s under it, and a fold inside survives opening the h1", async ({ browser }) => {
  const { page } = await open(browser, "fold-nested");

  await clickChevron(page, "Timeline");
  await expect(paragraph(page, "Work runs")).toBeHidden();
  await clickChevron(page, "Project Atlas");
  await expect(paragraph(page, "Atlas moves")).toBeHidden();
  await expect(rich(page).locator("> h2", { hasText: "Goals" })).toBeHidden();
  await expect(rich(page).locator("> h1", { hasText: "Appendix" })).toBeVisible();

  await clickChevron(page, "Project Atlas");
  await expect(paragraph(page, "Atlas moves")).toBeVisible();
  await expect(paragraph(page, "Three things")).toBeVisible();
  await expect(paragraph(page, "Work runs")).toBeHidden();
});

test("alt-click folds and unfolds everything nested under a heading", async ({ browser }) => {
  const { page } = await open(browser, "fold-alt");

  await clickChevron(page, "Project Atlas", { alt: true });
  await expect(paragraph(page, "Atlas moves")).toBeHidden();
  await clickChevron(page, "Project Atlas");
  await expect(paragraph(page, "Atlas moves")).toBeVisible();
  // Goals and Timeline were folded by the alt-click, so they are still folded here.
  await expect(paragraph(page, "Three things")).toBeHidden();
  await expect(paragraph(page, "Work runs")).toBeHidden();

  // Alt-click on the folded heading again opens the whole subtree.
  await clickChevron(page, "Project Atlas");
  await expect(paragraph(page, "Atlas moves")).toBeHidden();
  await clickChevron(page, "Project Atlas", { alt: true });
  await expect(paragraph(page, "Three things")).toBeVisible();
  await expect(paragraph(page, "Every document opens")).toBeVisible();
  await expect(paragraph(page, "Work runs")).toBeVisible();
});

test("folding leaves the heading where it was and does not edit the document", async ({ browser }) => {
  const { page } = await open(browser, "fold-stays");
  const heading = rich(page).locator("> h2", { hasText: "Timeline" });
  await heading.scrollIntoViewIfNeeded();
  const before = (await heading.boundingBox())!;

  await clickChevron(page, "Timeline");
  await expect(paragraph(page, "Work runs")).toBeHidden();
  const after = (await heading.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
});

test("a heading with nothing under it has no chevron, and a caret moves out of a section that folds", async ({ browser }) => {
  const { page } = await open(browser, "fold-caret");

  const empty = rich(page).locator("> h2", { hasText: "Nothing under this" });
  const content = await empty.evaluate((el) => getComputedStyle(el, "::before").content);
  expect(content).toBe("none");

  await paragraph(page, "Three things").click();
  await page.keyboard.press("End");
  await clickChevron(page, "Goals");
  await expect(paragraph(page, "Three things")).toBeHidden();
  await page.keyboard.type("!");
  await expect(rich(page).locator("> h2", { hasText: "Goals!" })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("## Goals!");
});
