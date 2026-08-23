import { test, expect } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, focusRichEnd, selectTextInRich, type User } from "./helpers";

const mod = process.platform === "darwin" ? "Meta" : "Control";

// 2 heading words + 15 + 6 = 23 prose words; the fenced block is not counted.
const CONTENT = [
  "# Stats Title",
  "",
  "The quick brown fox jumps over the lazy dog. Then it sleeps for a while!",
  "",
  "Another short paragraph follows the first one.",
  "",
  "```js",
  "const notCounted = 'words inside code fences are excluded';",
  "```",
  "",
].join("\n");

test.describe("document statistics and writing goal", () => {
  let alice: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "stats-alice");
    docId = await createDocument(alice.page, CONTENT, "Stats Title");
    await openDocument(alice.page, docId);
  });

  test.afterAll(async () => {
    await alice.context.close();
  });

  test("status bar shows the prose word count and selection counts", async () => {
    const { page } = alice;
    await expect(page.getByTestId("word-count")).toHaveText("23 words");

    await selectTextInRich(page, "Another short paragraph");
    await expect(page.getByTestId("selection-count")).toContainText("3 of 23 selected");

    // Collapse the selection: the suffix disappears.
    await focusRichEnd(page);
    await expect(page.getByTestId("selection-count")).toHaveCount(0);
  });

  test("Mod-Shift-C opens the popover with the statistics table", async () => {
    const { page } = alice;
    await focusRichEnd(page);
    await page.keyboard.press(`${mod}+Shift+C`);
    const popover = page.getByTestId("stats-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator("tr[data-stat=sentences] td").last()).toHaveText("3");
    await expect(popover.locator("tr[data-stat=paragraphs] td").last()).toHaveText("2");
    await expect(popover.locator("tr[data-stat=headings] td").last()).toHaveText("1");
    await expect(popover.locator("tr[data-stat=readingMinutes] td").last()).toHaveText("1 min");
    await expect(popover.locator("tr[data-stat=characters] td").last()).not.toHaveText("0");
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });

  test("a word goal shows a progress ring that fills and turns to success; a collaborator sees it", async ({ browser }) => {
    const { page } = alice;
    await page.getByTestId("stats-button").click();
    const popover = page.getByTestId("stats-popover");
    await expect(popover).toBeVisible();
    await popover.getByTestId("goal-value").fill("50");
    await popover.getByTestId("goal-set").click();
    await expect(popover.getByTestId("goal-summary")).toContainText("At least 50 words · 23 / 50 words");
    await page.keyboard.press("Escape");

    const ring = page.getByTestId("stats-button").getByTestId("goal-ring");
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute("data-state", "progress");
    await expect(page.getByTestId("stats-button")).toHaveAttribute("title", "23 / 50 words");

    // A second user on the same document sees the shared goal.
    const bob = await signIn(browser, "stats-bob");
    await shareWith(page, docId, "stats-bob", "viewer");
    await openDocument(bob.page, docId);
    await expect(bob.page.getByTestId("stats-button").getByTestId("goal-ring")).toHaveAttribute("data-state", "progress");
    await bob.page.getByTestId("stats-button").click();
    await expect(bob.page.getByTestId("goal-summary")).toContainText("At least 50 words");
    // Viewers cannot change it.
    await expect(bob.page.getByTestId("goal-set")).toHaveCount(0);
    await bob.page.keyboard.press("Escape");

    // Type past the goal: the ring fills and switches to the success state for both.
    await focusRichEnd(page);
    await page.keyboard.type(" " + Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "));
    await expect(ring).toHaveAttribute("data-state", "reached", { timeout: 10_000 });
    await expect(page.getByTestId("word-count")).toHaveText("53 words");
    await expect(bob.page.getByTestId("stats-button").getByTestId("goal-ring")).toHaveAttribute("data-state", "reached", { timeout: 10_000 });

    // Clearing removes the ring everywhere.
    await page.getByTestId("stats-button").click();
    await popover.getByTestId("goal-clear").click();
    await page.keyboard.press("Escape");
    await expect(ring).toHaveCount(0);
    await expect(bob.page.getByTestId("stats-button").getByTestId("goal-ring")).toHaveCount(0);
    await bob.context.close();
  });

  test("the reader page shows the reading time next to the byline", async () => {
    const { page } = alice;
    await page.goto(`/p/${docId}`);
    await expect(page.getByTestId("reader-reading-time")).toHaveText("1 min read");
  });

  test("the content API returns stats", async () => {
    const res = await alice.page.request.get(`/api/documents/${docId}/content`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { stats: { words: number; headings: number; readingMinutes: number } };
    expect(body.stats.headings).toBe(1);
    expect(body.stats.words).toBeGreaterThanOrEqual(23);
    expect(body.stats.readingMinutes).toBe(1);
  });
});
