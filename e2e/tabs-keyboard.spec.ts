import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { PHONE_MAX } from "../src/lib/viewport";
import { createDocument, ensureCommentsOpen, expectCommentsTab, expectThemeOption, openDocument, openPhoneComments, signIn } from "./helpers";

/**
 * Real mouse clicks and real key presses on the two radio-like controls whose handlers used to sit behind
 * event "proof" checks (#2198): the comments panel tabs and the Settings theme picker. jsdom stayed green
 * while real browsers ignored them, so these run in Chromium against a dev server and a production build.
 */
const scrollOf = (page: Page) => page.evaluate(() => [window.scrollX, window.scrollY]);

test.describe("comments panel tabs", () => {
  test("clicks select a tab and the arrow, Home and End keys move and wrap", async ({ browser }) => {
    const user = await signIn(browser, "tabs-keys");
    const { page } = user;
    const id = await createDocument(page, "# Tabs\n\nSome text to comment on.\n", "Tabs");
    await openDocument(page, id);
    await ensureCommentsOpen(page);
    await expectCommentsTab(page, "open");

    for (const tab of ["resolved", "suggestions", "open"] as const) {
      await page.getByTestId(`comments-tab-${tab}`).click();
      await expectCommentsTab(page, tab, { focused: true });
    }

    const scroll = await scrollOf(page);
    await page.getByTestId("comments-tab-open").focus();
    const steps = [
      ["ArrowRight", "resolved"],
      ["ArrowRight", "suggestions"],
      ["ArrowRight", "open"],
      ["ArrowLeft", "suggestions"],
      ["ArrowLeft", "resolved"],
      ["End", "suggestions"],
      ["Home", "open"],
    ] as const;
    for (const [key, tab] of steps) {
      await page.keyboard.press(key);
      await expectCommentsTab(page, tab, { focused: true });
    }
    expect(await scrollOf(page)).toEqual(scroll);

    // The roving tab stop: Tab leaves the tablist instead of visiting the other tabs.
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).not.toHaveAttribute("role", "tab");
    await user.context.close();
  });

  for (const width of [390, 768, 1280]) {
    test(`the close button closes the panel at ${width} CSS px`, async ({ browser }) => {
      const user = await signIn(browser, `tabs-close-${width}`);
      const { page } = user;
      await page.setViewportSize({ width, height: 844 });
      const id = await createDocument(page, "# Close\n\nText.\n", "Close");
      if (width < PHONE_MAX) await openPhoneComments(page, id);
      else {
        await openDocument(page, id);
        await ensureCommentsOpen(page);
      }
      await page.getByTestId("comments-tab-resolved").click();
      await expectCommentsTab(page, "resolved", { focused: true });

      await page.getByRole("button", { name: "Close comments" }).click();

      await expect(page.getByTestId("comments-panel")).toHaveCount(0);
      await user.context.close();
    });
  }
});

test.describe("Settings theme picker", () => {
  test("the arrow, Home and End keys check, focus and save the next theme", async ({ browser }) => {
    const user = await signIn(browser, "picker-keys");
    const { page } = user;
    await page.goto("/settings");
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    await page.getByTestId("theme-option-system").focus();
    const scroll = await scrollOf(page);

    const steps = [
      ["ArrowLeft", "dark"],
      ["ArrowRight", "system"],
      ["ArrowDown", "light"],
      ["ArrowUp", "system"],
      ["ArrowRight", "light"],
      ["ArrowLeft", "system"],
      ["End", "dark"],
      ["Home", "system"],
    ] as const;
    for (const [key, preference] of steps) {
      await page.keyboard.press(key);
      await expectThemeOption(page, preference);
    }
    expect(await scrollOf(page)).toEqual(scroll);
    await user.context.close();
  });
});
