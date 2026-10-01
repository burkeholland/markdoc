import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, codeText, focusRichEnd, shareWith, budgetMs, reloadHydrated } from "./helpers";

const SAMPLE = `# Pets

The cat sat on the mat. The cat ran.

Another cat came by later.
`;

/** Whole-word, case-matching "cat" appears exactly twice; the other five are near misses. */
const CASES = `Cat, cat and category; Category, concat, cat.
`;

async function openFromCodePane(page: import("@playwright/test").Page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("find-bar")).toBeVisible();
  await expect(page.getByTestId("find-input")).toBeFocused();
}

/** Reload the open document and wait until the editor is live again (same gates as openDocument). */
async function reloadEditor(page: import("@playwright/test").Page) {
  await reloadHydrated(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".md-rich")).toBeVisible();
}

const storedReplaceChoice = (page: import("@playwright/test").Page) => page.evaluate(() => localStorage.getItem("markdoc:find-replace"));

test.describe("find & replace", () => {
  test("Mod-F opens the bar and a query highlights matches in both panes", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await openFromCodePane(page);
    // CodeMirror's own search panel must not open.
    await expect(page.locator(".cm-panel.cm-search")).toHaveCount(0);

    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.locator(".cm-content .md-find")).toHaveCount(3);
    await expect(page.locator(".md-rich .md-find")).toHaveCount(3);
    await expect(page.locator(".cm-content .md-find-active")).toHaveCount(1);
    await expect(page.locator(".md-rich .md-find-active")).toHaveCount(1);
    await expect(page.locator(".md-rich .md-find-active")).toHaveText("cat");

    // Options narrow the result set.
    await page.getByTestId("find-match-case").click();
    await page.getByTestId("find-input").fill("Cat");
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await page.getByTestId("find-match-case").click();
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await user.context.close();
  });

  test("Enter cycles through matches and wraps around", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.keyboard.press("Shift+Enter");
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await page.getByTestId("find-prev").click();
    await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
    await page.getByTestId("find-next").click();
    await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
    await expect(page.locator(".md-rich .md-find-active")).toHaveCount(1);
    await expect(page.locator(".cm-content .md-find-active")).toHaveText("cat");
    await user.context.close();
  });

  test("F3 and Shift+F3 step from the find bar and from the editor", async ({ browser }) => {
    const user = await signIn(browser, "f3-keys");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    const input = page.getByTestId("find-input");
    const count = page.getByTestId("find-count");
    await page.keyboard.type("cat");
    await expect(count).toHaveText("1 of 3");

    await page.keyboard.press("F3");
    await expect(count).toHaveText("2 of 3");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+F3");
    await expect(count).toHaveText("1 of 3");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+F3");
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("F3");
    await expect(count).toHaveText("1 of 3");

    // From an option toggle in the bar.
    await page.getByTestId("find-match-case").focus();
    await page.keyboard.press("F3");
    await expect(count).toHaveText("2 of 3");
    await expect(page.getByTestId("find-match-case")).toBeFocused();
    await expect(page.getByTestId("find-match-case")).toHaveAttribute("aria-pressed", "false");

    // From the editor while the bar stays open: the match moves, focus stays in the editor.
    await page.locator(".cm-content").click();
    await expect(page.getByTestId("find-bar")).toBeVisible();
    const before = (await count.textContent()) ?? "";
    await page.keyboard.press("F3");
    await expect(count).not.toHaveText(before);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Shift+F3");
    await expect(count).toHaveText(before);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await codeText(page)).toBe(SAMPLE);
    await user.context.close();
  });

  test("real typing, inserted text, paste and keyboard-driven buttons all reach the bar", async ({ browser }) => {
    const user = await signIn(browser, "find-real-input");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;
    const input = page.getByTestId("find-input");
    const count = page.getByTestId("find-count");

    // Text committed without key events (the closest automation gets to an IME commit).
    await openFromCodePane(page);
    await page.keyboard.insertText("cat");
    await expect(input).toHaveValue("cat");
    await expect(count).toHaveText("1 of 3");

    // Clearing and typing key by key.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("");
    await page.keyboard.type("mat");
    await expect(count).toHaveText("1 of 1");

    // Escape returns focus to the editor with the match selected; copy it for the paste below.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("mat");
    await page.keyboard.press("Control+c");

    // The first keys after reopening are honoured.
    await page.keyboard.press("Control+f");
    await expect(input).toBeFocused();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("");
    await page.keyboard.press("Control+v");
    await expect(input).toHaveValue("mat");
    await expect(count).toHaveText("1 of 1");

    await input.fill("cat");
    await expect(count).toHaveText("1 of 3");

    // Enter and Space activate the step buttons; arrows move between the first-row actions.
    await page.getByTestId("find-next").focus();
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("Space");
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("find-prev")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 3");

    // The Replace toggle hides and reshows the row from the keyboard, then focus lands in it.
    await page.keyboard.press("End");
    await expect(page.getByTestId("find-close")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    const toggle = page.getByTestId("find-toggle-replace");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("replace-input")).toBeFocused();

    // Enter in the replace input replaces the active (second) match.
    await page.keyboard.type("dog");
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toContain("The cat sat on the mat. The dog ran.");
    await expect(count).toHaveText("2 of 2");

    // Tab to Replace all and activate it with the keyboard.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("replace-one")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("replace-all")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(count).toHaveText("0 of 0");

    // Escape from a button closes the bar too (Replace all is disabled now, so use the toggle).
    await toggle.focus();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    await user.context.close();
  });

  test("Replace and Replace all rewrite the source", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    // Mod-H opens with the replace row visible.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+h");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(page.getByTestId("find-replace-row")).toBeVisible();
    await page.getByTestId("find-input").fill("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");

    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("replace-one").click();
    await expect.poll(() => codeText(page)).toContain("The dog sat on the mat. The cat ran.");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 2");

    await page.getByTestId("replace-all").click();
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await expect(page.locator(".cm-content .md-find")).toHaveCount(0);
    await expect(page.locator(".md-rich p").first()).toContainText("The dog sat on the mat. The dog ran.");
    await user.context.close();
  });

  test("Escape closes the bar and selects the active match in the last active pane", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("mat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content .md-find")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("mat");

    // Selecting text in the preview and pressing Mod-F seeds the query with it.
    await page.locator(".md-rich p").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-input")).toHaveValue("later");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 1");
    await page.getByTestId("find-close").click();
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await user.context.close();
  });

  test("editors get the replace row by default; hiding it sticks until Mod-H asks for it again", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    const row = page.getByTestId("find-replace-row");
    const toggle = page.getByTestId("find-toggle-replace");
    // The row arrives with the bar, well inside the 300 ms budget.
    await expect(row).toBeVisible({ timeout: budgetMs(300) });
    await expect(page.getByTestId("replace-input")).toBeVisible();
    await expect(page.getByTestId("replace-all")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-controls", "find-replace-row");
    await expect(row).toHaveId("find-replace-row");
    await expect(toggle).toHaveText("Hide replace");

    // Hiding the row is remembered.
    await toggle.click();
    await expect(row).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveText("Replace");
    expect(await storedReplaceChoice(page)).toBe("hidden");

    await reloadEditor(page);
    await openFromCodePane(page);
    await expect(toggle).toBeVisible();
    await expect(row).toHaveCount(0);

    // Mod-H always shows the row and forgets the hidden choice...
    await page.keyboard.press("Control+h");
    await expect(row).toBeVisible();
    await expect(page.getByTestId("find-input")).toBeFocused();
    expect(await storedReplaceChoice(page)).toBeNull();

    // ...so Mod-F shows it again after the next reload.
    await reloadEditor(page);
    await openFromCodePane(page);
    await expect(row).toBeVisible({ timeout: budgetMs(300) });
    await user.context.close();
  });

  test("Replace from the rich pane updates both panes", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Control+f");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(page.getByTestId("find-input")).toBeFocused();
    await expect(page.getByTestId("find-replace-row")).toBeVisible();
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.locator(".md-rich .md-find")).toHaveCount(3);

    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("replace-one").click();
    await expect(page.locator(".md-rich p").first()).toContainText("The dog sat on the mat. The cat ran.");
    await expect.poll(() => codeText(page)).toContain("The dog sat on the mat. The cat ran.");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 2");

    await page.getByTestId("replace-all").click();
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(page.locator(".md-rich .md-find")).toHaveCount(0);
    await expect(page.locator(".md-rich p").last()).toContainText("Another dog came by later.");
    await user.context.close();
  });

  test("one Undo takes back a Replace all", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("replace-all").click();
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");

    // Three replacements, one undo step: a single Mod-Z in the code pane restores the source exactly.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => codeText(page)).toBe(SAMPLE);
    await expect(page.locator(".md-rich p").first()).toContainText("The cat sat on the mat. The cat ran.");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await user.context.close();
  });

  test("Replace all honours Match case and Whole word", async ({ browser }) => {
    const user = await signIn(browser, "solo");
    const id = await createDocument(user.page, CASES);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 6");
    await page.getByTestId("find-match-case").click();
    await expect(page.getByTestId("find-count")).toHaveText("1 of 4");
    await page.getByTestId("find-whole-word").click();
    await expect(page.getByTestId("find-count")).toHaveText("1 of 2");

    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("replace-all").click();
    await expect.poll(() => codeText(page)).toBe("Cat, dog and category; Category, concat, dog.\n");
    await expect(page.getByTestId("find-count")).toHaveText("0 of 0");
    await user.context.close();
  });

  test("viewers get find without any replace controls", async ({ browser }) => {
    const owner = await signIn(browser, "find-owner");
    const viewer = await signIn(browser, "find-viewer");
    const id = await createDocument(owner.page, SAMPLE);
    await shareWith(owner.page, id, "find-viewer", "viewer");
    await openDocument(viewer.page, id);
    const { page } = viewer;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(page.getByTestId("find-toggle-replace")).toHaveCount(0);
    // Mod-H does not conjure one up either.
    await page.keyboard.press("Control+h");
    await expect(page.getByTestId("find-input")).toBeFocused();
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(page.getByTestId("find-toggle-replace")).toHaveCount(0);
    expect(await codeText(page)).toBe(SAMPLE);
    await viewer.context.close();
    await owner.context.close();
  });
});
