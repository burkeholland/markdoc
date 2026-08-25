import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, focusRichEnd, focusCodeEnd } from "./helpers";

/**
 * Client-side parse guard (#115 follow-up): Markdown that micromark parses in quadratic time
 * (40k `[` + `a` + 40k `]` in one paragraph) must never freeze the tab. Pasted or imported it
 * becomes a fenced code block with a toast; already in the document (written by another client
 * or the API) the rich pane shows a placeholder while the code pane keeps the text.
 */
const SOUP = "[".repeat(40_000) + "a" + "]".repeat(40_000);

declare global {
  interface Window {
    __longTasks?: number[];
  }
}

/** Records every long task (> 50 ms) from now on in `window.__longTasks`. */
async function observeLongTasks(page: Page) {
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks!.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  });
}

async function longestTask(page: Page): Promise<number> {
  // Give the observer a frame to deliver the last entries.
  await page.waitForTimeout(200);
  return page.evaluate(() => Math.max(0, ...(window.__longTasks ?? [])));
}

async function paste(page: Page, selector: string, text: string) {
  await page.evaluate(
    ({ selector, text }) => {
      const root = document.querySelector(selector) as HTMLElement | null;
      if (!root) throw new Error(`${selector} not found`);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { selector, text },
  );
}

/** Type one character into the focused pane and measure how long the code pane takes to show it. */
async function typingEcho(page: Page, marker: string): Promise<number> {
  const started = Date.now();
  await page.keyboard.type(marker);
  await expect.poll(() => codeText(page), { timeout: 5_000 }).toContain(marker);
  return Date.now() - started;
}

test.describe("pathological Markdown never freezes the tab", () => {
  test("pasting bracket soup into the rich pane inserts a code block and toasts", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Intro paragraph.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await observeLongTasks(page);
    await paste(page, ".ProseMirror", SOUP);

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("40,000 unbalanced brackets");
    await expect(toast).toContainText("inserted as a code block");

    const text = await codeText(page);
    expect(text).toContain("```\n" + SOUP + "\n```");
    expect(text.startsWith("Intro paragraph.")).toBe(true);
    await expect(page.locator(".md-rich pre code")).toHaveCount(1);
    expect(await longestTask(page)).toBeLessThan(1_000);

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    expect(await typingEcho(page, "Q")).toBeLessThan(2_000);
    await user.context.close();
  });

  test("pasting bracket soup into the code pane inserts a code block and toasts", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, "Intro paragraph.\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusCodeEnd(page);
    await observeLongTasks(page);
    await paste(page, ".cm-content", SOUP);

    const toast = page.getByTestId("toast");
    await expect(toast).toBeVisible({ timeout: 5_000 });
    await expect(toast).toContainText("40,000 unbalanced brackets");

    await expect.poll(() => codeText(page)).toContain("```\n" + SOUP + "\n```");
    await expect(page.locator(".md-rich pre code")).toHaveCount(1);
    expect(await longestTask(page)).toBeLessThan(1_000);

    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    expect(await typingEcho(page, "Q")).toBeLessThan(2_000);
    await user.context.close();
  });

  test("a document seeded with bracket soup opens interactive, with a placeholder in the rich pane", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, `# Title\n\nBefore.\n\n${SOUP}\n\nAfter.\n`);
    const { page } = user;
    await page.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__longTasks!.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    });

    const started = Date.now();
    await openDocument(page, id);
    const placeholder = page.getByTestId("unrenderable-block");
    await expect(placeholder).toBeVisible({ timeout: 10_000 });
    await expect(placeholder).toHaveText("This section cannot be rendered");
    // Page load includes Next's dev compile; the budget is generous but the placeholder must be up.
    expect(Date.now() - started).toBeLessThan(30_000);

    await expect(page.locator(".md-rich h1")).toHaveText("Title");
    await expect(page.locator(".md-rich p").last()).toHaveText("After.");
    // The code pane has the real text, and typing in it still echoes promptly.
    expect(await codeText(page)).toContain(SOUP);
    await focusCodeEnd(page);
    await page.keyboard.press("Enter");
    expect(await typingEcho(page, "Z")).toBeLessThan(2_000);

    const tasks = await page.evaluate(() => (window.__longTasks ?? []).filter((d) => d > 1_000));
    expect(tasks, `long tasks > 1 s: ${tasks.join(", ")}`).toEqual([]);

    // The status bar stats stay linear (#476): the word count is up.
    await expect(page.getByTestId("word-count")).toContainText("words");
    await user.context.close();
  });
});
