import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, codeText, tableLines, clickCell, expectTableShape } from "./helpers";

const isMac = process.platform === "darwin";
const mod = isMac ? "Meta" : "Control";

test.describe("table editing", () => {
  test("table menu edits rows, columns and alignment and the Markdown follows", async ({ browser }) => {
    const user = await signIn(browser, "tabler");
    const { page } = user;
    const id = await createDocument(page, "# Tables\n\nIntro paragraph.\n");
    await openDocument(page, id);

    // Insert a 2x2 table from the toolbar (1 header row + 1 body row).
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.getByTestId("tb-table").click();
    await page.getByTestId("table-grid").getByRole("button", { name: "2 by 2" }).click();
    await expect(page.locator(".md-rich table")).toBeVisible();
    await expect.poll(() => codeText(page)).toContain("| Column 1 | Column 2 |");
    await expectTableShape(page, 2, 2);

    // The menu shows once the caret is inside the table.
    await clickCell(page, 1, 0);
    const menu = page.getByTestId("table-menu");
    await expect(menu).toBeVisible();
    // Anchored above the table, not at the caret.
    const menuBox = (await menu.boundingBox())!;
    const tableBox = (await page.locator(".md-rich table").boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(tableBox.y + 1);

    const before = await tableLines(page);
    expect(before).toHaveLength(3);

    await page.getByTestId("table-row-after").click();
    await expect.poll(async () => (await tableLines(page)).length).toBe(4);
    await expectTableShape(page, 3, 2);
    const afterRow = await tableLines(page);
    expect(afterRow[3]).toMatch(/^\|\s+\|\s+\|$/);

    // Alignment applies to the caret's column (still column 0 of the body row).
    await clickCell(page, 1, 0);
    await page.getByTestId("table-align-center").click();
    await expect.poll(async () => (await tableLines(page))[1]).toContain(":-");
    expect((await tableLines(page))[1]).toMatch(/^\| :-+: \| -+ \|$/);
    await expect(page.getByTestId("table-align-center")).toHaveAttribute("aria-pressed", "true");

    // Keyboard: Mod-Alt-Right adds a column after the current one.
    await clickCell(page, 1, 0);
    await page.keyboard.press(`${mod}+Alt+ArrowRight`);
    await expect(page.locator(".md-rich th")).toHaveCount(3);
    await expectTableShape(page, 3, 3);
    await expect.poll(async () => (await tableLines(page))[0]).toMatch(/^\| Column 1 \|\s+\| Column 2 \|$/);
    expect((await tableLines(page))[1].split("|")).toHaveLength(5);

    // Mod-Alt-Down adds a row below.
    await clickCell(page, 1, 0);
    await page.keyboard.press(`${mod}+Alt+ArrowDown`);
    await expect.poll(async () => (await tableLines(page)).length).toBe(5);
    await expectTableShape(page, 4, 3);

    // Enter in the last cell appends a row.
    await clickCell(page, 3, 2);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await tableLines(page)).length).toBe(6);
    await expectTableShape(page, 5, 3);
    // Enter moves the caret into the new row, but do not rely on that: focus its first cell explicitly.
    await clickCell(page, 4, 0);
    await page.keyboard.type("tail");
    await expect.poll(async () => (await tableLines(page))[5]).toContain("tail");

    // Delete row / column via the menu (the caret is still in the new last row).
    await clickCell(page, 4, 0);
    await page.getByTestId("table-delete-row").click();
    await expect.poll(async () => (await tableLines(page)).length).toBe(5);
    await expectTableShape(page, 4, 3);
    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete-col").click();
    await expect(page.locator(".md-rich th")).toHaveCount(2);
    await expectTableShape(page, 4, 2);

    // Delete row on the header row is refused.
    await clickCell(page, 0, 0);
    await page.keyboard.press(`${mod}+Alt+Backspace`);
    await expect.poll(async () => (await tableLines(page)).length).toBe(5);
    await expectTableShape(page, 4, 2);

    // Delete table removes it entirely.
    await clickCell(page, 0, 0);
    await page.getByTestId("table-delete").click();
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await expect(menu).toHaveCount(0);
    await expect.poll(() => codeText(page)).not.toContain("|");
    await expect.poll(() => codeText(page)).toContain("Intro paragraph.");

    await user.context.close();
  });

  test("Backspace in an all-empty table removes it", async ({ browser }) => {
    const user = await signIn(browser, "tabler");
    const { page } = user;
    const id = await createDocument(page, "Before\n\n|  |  |\n| --- | --- |\n|  |  |\n\nAfter\n");
    await openDocument(page, id);
    await page.locator(".md-rich td").first().click();
    await expect(page.getByTestId("table-menu")).toBeVisible();
    await page.keyboard.press("Backspace");
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await expect.poll(() => codeText(page)).toBe("Before\n\nAfter\n");
    await user.context.close();
  });

  test("the table menu is hidden in viewing mode", async ({ browser }) => {
    const user = await signIn(browser, "tabler");
    const { page } = user;
    const id = await createDocument(page, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    await openDocument(page, id);
    await page.locator(".md-rich td").first().click();
    await expect(page.getByTestId("table-menu")).toBeVisible();

    await page.getByTestId("preview-mode-toggle").click();
    await expect(page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    await page.locator(".md-rich td").first().click();
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    await user.context.close();
  });
});
