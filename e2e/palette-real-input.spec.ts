import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument } from "./helpers";

// #2233: real typing, paste, keys and clicks in the command palette must never be dropped.

const mod = process.platform === "darwin" ? "Meta" : "Control";
const palette = (page: Page) => page.getByTestId("command-palette");
const input = (page: Page) => page.getByTestId("palette-input");
const options = (page: Page) => palette(page).getByRole("option");

async function paste(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press(`${mod}+v`);
}

test.describe("command palette real input", () => {
  test("top level: typing, paste, arrows, Home/End, Enter and click all take effect", async ({ browser }) => {
    const user = await signIn(browser, "palette-real-input");
    const { page } = user;
    await user.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const id = await createDocument(page, "# First\n\nText.\n\n## Second\n");
    await openDocument(page, id);
    await page.locator(".md-rich p").first().click();

    await page.keyboard.press(`${mod}+Shift+P`);
    await expect(input(page)).toBeFocused();
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(options(page).last()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");

    await page.keyboard.type("head");
    await expect(input(page)).toHaveValue("head");
    await expect(options(page).first()).toHaveAttribute("data-testid", "palette-item-block:heading1");

    await input(page).fill("");
    await paste(page, "zzzzqqq");
    await expect(input(page)).toHaveValue("zzzzqqq");
    await expect(page.getByTestId("palette-empty")).toBeVisible();
    await input(page).fill("");

    await page.keyboard.type("go to head");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-back")).toBeVisible();
    await page.getByRole("option", { name: /Second/ }).click();
    await expect(palette(page)).toHaveCount(0);
    await user.context.close();
  });

  test("template child list: click, typing, paste, Back, Backspace, Retry and Enter", async ({ browser }) => {
    const user = await signIn(browser, "palette-real-input-dash");
    const { page } = user;
    await user.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    let failures = 1;
    await page.route("**/api/templates", (route) => {
      if (failures-- > 0) return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Templates unavailable"}' });
      return route.fallback();
    });

    await page.locator("body").click();
    await page.keyboard.press(`${mod}+k`);
    await expect(input(page)).toBeFocused();

    await page.getByTestId("palette-item-dash:template").hover();
    await expect(page.getByTestId("palette-item-dash:template")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("palette-item-dash:template").click();
    await expect(palette(page).getByRole("alert")).toBeVisible();
    await palette(page).getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("palette-item-template:meeting-notes")).toBeVisible();
    await expect(page.getByTestId("palette-back")).toBeVisible();

    await page.getByTestId("palette-back").click();
    await expect(page.getByTestId("palette-item-dash:template")).toBeVisible();
    await expect(input(page)).toBeFocused();

    await page.keyboard.type("template");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("palette-item-template:meeting-notes")).toBeVisible();
    await expect(input(page)).toHaveValue("");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("palette-back")).toHaveCount(0);

    await page.getByTestId("palette-item-dash:template").click();
    await expect(page.getByTestId("palette-item-template:meeting-notes")).toBeVisible();
    await paste(page, "meet");
    await expect(input(page)).toHaveValue("meet");
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await expect(options(page).first()).toHaveAttribute("data-testid", "palette-item-template:meeting-notes");
    await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/d\/[^/]+$/);
    await expect(page.getByTestId("title")).toHaveText("Meeting notes", { timeout: 30_000 });
    await user.context.close();
  });
});
