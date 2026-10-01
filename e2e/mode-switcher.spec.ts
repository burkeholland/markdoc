import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { codeText, createDocument, focusRichEnd, openDocument, signIn } from "./helpers";

/**
 * #2224 reported that picking Suggesting with a real click, or Enter or Space on the focused menu row,
 * was dropped and left the menu open. That did not reproduce on main 264f1827 (dev or production), so
 * these tests guard the plain Radix menu that replaced the hand-rolled gate against that regression.
 */

const CONTENT = "# Mode switcher\n\nA paragraph.\n";
type Input = "click" | "Enter" | "Space";
type ModeName = "Editing" | "Suggesting";

async function pickMode(page: Page, name: ModeName, input: Input) {
  const trigger = page.getByTestId("mode-switcher");
  const row = page.getByRole("menuitemradio", { name: new RegExp(name) });

  if (input === "click") {
    const triggerBox = await trigger.boundingBox();
    if (!triggerBox) throw new Error("Mode switcher has no box");
    await page.mouse.click(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
    await expect(page.getByRole("menu")).toBeVisible();
    const box = await row.boundingBox();
    if (!box) throw new Error(`${name} row has no box`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /Editing/ })).toBeFocused();
    if (name === "Suggesting") await page.keyboard.press("ArrowDown");
    await expect(row).toBeFocused();
    await page.keyboard.press(input);
  }

  await expect(trigger).toContainText(name);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-state", "closed");
  if (input !== "click") await expect(trigger).toBeFocused();
}

for (const input of ["click", "Enter", "Space"] as const) {
  test(`${input} on Suggesting switches the mode, closes the menu, and turns typing into a suggestion`, async ({ browser }) => {
    const alice = await signIn(browser, "alice");
    try {
      const docId = await createDocument(alice.page, CONTENT, `Mode switcher: ${input}`);
      await openDocument(alice.page, docId);
      await expect(alice.page.getByTestId("mode-switcher")).toContainText("Editing");

      await pickMode(alice.page, "Suggesting", input);
      const suggested = ` suggested-${input.toLowerCase()}`;
      await focusRichEnd(alice.page);
      await alice.page.keyboard.type(suggested);
      await expect(alice.page.locator(".md-rich .md-suggest-insert", { hasText: suggested.trim() })).toHaveCount(1);

      await pickMode(alice.page, "Editing", input);
      // Type at the start of the heading, away from the suggestion, so the text cannot join it.
      const direct = `direct-${input.toLowerCase()} `;
      await alice.page.locator(".md-rich h1").click();
      await alice.page.keyboard.press("Control+Home");
      await alice.page.keyboard.type(direct);
      await expect.poll(() => codeText(alice.page)).toContain(`# ${direct}Mode switcher`);
      await expect(alice.page.locator(".md-rich .md-suggest-insert", { hasText: direct.trim() })).toHaveCount(0);
    } finally {
      await alice.context.close();
    }
  });
}

test("ArrowUp on the closed trigger opens the menu, focuses Editing, and does not scroll the page", async ({ browser }) => {
  const alice = await signIn(browser, "alice");
  try {
    const docId = await createDocument(alice.page, CONTENT, "Mode switcher: ArrowUp");
    await openDocument(alice.page, docId);
    const page = alice.page;
    const trigger = page.getByTestId("mode-switcher");
    await expect(trigger).toContainText("Editing");
    await page.evaluate(() => {
      const record = window as unknown as { __arrowUpPrevented?: boolean[] };
      record.__arrowUpPrevented = [];
      document.addEventListener("keydown", (event) => {
        if (event.key === "ArrowUp") record.__arrowUpPrevented!.push(event.defaultPrevented);
      });
    });

    await trigger.focus();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("ArrowUp");

    await expect(page.getByRole("menu")).toBeVisible();
    await expect(trigger).toHaveAttribute("data-state", "open");
    await expect(page.getByRole("menuitemradio", { name: /Editing/ })).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await page.evaluate(() => (window as unknown as { __arrowUpPrevented: boolean[] }).__arrowUpPrevented)).toEqual([true]);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Editing");
  } finally {
    await alice.context.close();
  }
});
