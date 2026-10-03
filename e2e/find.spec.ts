import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { signIn, devLogin, createDocument, openDocument, waitForEditor, codeText, focusRichEnd, shareWith, budgetMs, reloadHydrated } from "./helpers";

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

const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");

/** Two animation frames: long enough for a re-render, and for the browser to move focus off a control that went away. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Where keyboard focus is, in words. Focus must never be left on the page itself ("body"). */
const focusPlace = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return "body";
    if (active.closest(".md-rich")) return "preview";
    if (active.closest(".cm-content")) return "markdown";
    return active.getAttribute("data-testid") ?? active.getAttribute("aria-label") ?? active.tagName.toLowerCase();
  });
const expectFocus = (page: Page, place: string, message?: string) => expect.poll(() => focusPlace(page), { message }).toBe(place);

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

    // From the editor while the bar stays open: one press is one step, and focus stays in the editor.
    await page.locator(".cm-content").click();
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("F3");
    await frames(page);
    await expect(count).toHaveText("3 of 3");
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Shift+F3");
    await frames(page);
    await expect(count).toHaveText("2 of 3");
    await expect(page.locator(".cm-content")).toBeFocused();

    // From the rich pane too.
    await page.locator(".md-rich p").first().click();
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("F3");
    await frames(page);
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("Shift+F3");
    await frames(page);
    await expect(count).toHaveText("2 of 3");
    await expect(page.locator(".md-rich")).toBeFocused();
    expect(await codeText(page)).toBe(SAMPLE);

    // In another input (the document title in the header) F3 is not the bar's.
    await page.getByTestId("title").click();
    await expect(page.getByTestId("title-input")).toBeFocused();
    await page.keyboard.press("F3");
    await page.keyboard.press("Shift+F3");
    await frames(page);
    await expect(count).toHaveText("2 of 3");
    await expect(page.getByTestId("title-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("title-input")).toHaveCount(0);

    // With a dialog open, F3 belongs to the dialog and the match does not move.
    await page.locator(".md-rich p").first().click();
    await page.keyboard.press("Control+Shift+P");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("F3");
    await page.keyboard.press("F3");
    await frames(page);
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);

    // After the bar is closed F3 does nothing: no bar, no search state, the document as it was.
    await page.getByTestId("find-input").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await page.keyboard.press("F3");
    await page.keyboard.press("Shift+F3");
    await frames(page);
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content .md-find")).toHaveCount(0);
    expect(await selectedText(page)).toBe("cat");
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
    /** Focus is on a control or in the editor, never dropped on the page. */
    const focusKept = async (step: string) => {
      await frames(page);
      expect(await focusPlace(page), step).not.toBe("body");
    };

    // Text committed without key events.
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
    expect(await selectedText(page)).toBe("mat");
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

    // The search starts from the caret, which Escape left on "mat": the next "cat" is the second one.
    await input.fill("cat");
    await expect(count).toHaveText("2 of 3");

    // The Replace toggle by mouse: hiding keeps focus in the find input, showing moves it to the replace input.
    const toggle = page.getByTestId("find-toggle-replace");
    await toggle.click();
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(input).toBeFocused();
    await toggle.click();
    await expect(page.getByTestId("replace-input")).toBeFocused();
    // Hiding the row while focus is inside it hands focus to the find input.
    await toggle.click();
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(input).toBeFocused();
    await toggle.click();
    await expect(page.getByTestId("replace-input")).toBeFocused();

    // Next and Previous by mouse keep focus where it was.
    await page.getByTestId("find-next").click();
    await expect(count).toHaveText("3 of 3");
    await page.getByTestId("find-prev").click();
    await expect(count).toHaveText("2 of 3");
    await expect(page.getByTestId("replace-input")).toBeFocused();

    // Enter and Space activate the step buttons; arrows move between the first-row actions.
    await page.getByTestId("find-next").focus();
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("Space");
    await expect(count).toHaveText("1 of 3");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("find-prev")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("3 of 3");
    await page.keyboard.press("Space");
    await expect(count).toHaveText("2 of 3");
    await page.keyboard.press("Space");
    await expect(count).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("3 of 3");

    // The Replace toggle hides and reshows the row from the keyboard, then focus lands in it.
    await page.keyboard.press("End");
    await expect(page.getByTestId("find-close")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("replace-input")).toBeFocused();

    // Enter in the replace input replaces the active (third) match; Shift+Enter there steps back.
    await page.keyboard.type("dog");
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toContain("Another dog came by later.");
    await expect(count).toHaveText("1 of 2");
    await page.keyboard.press("Shift+Enter");
    await expect(count).toHaveText("2 of 2");
    await focusKept("after Enter in the replace input");

    // Tab to Replace and Replace all; Space and Enter activate them, and they keep focus when they switch off.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("replace-one")).toBeFocused();
    await page.keyboard.press("Space");
    await expect.poll(() => codeText(page)).toContain("The cat sat on the mat. The dog ran.");
    await expect(count).toHaveText("1 of 1");
    await expect(page.getByTestId("replace-one")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("replace-all")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await expect(count).toHaveText("0 of 0");
    await expect(page.getByTestId("replace-all")).toHaveAttribute("aria-disabled", "true");
    await focusKept("after Replace all emptied the match list");
    await expect(page.getByTestId("replace-all")).toBeFocused();

    // Escape from a button closes the bar too.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();

    // Mod-H opens with the row and reopens onto the find input; the close button works by keyboard and by mouse.
    await page.keyboard.press("Control+h");
    await expect(input).toBeFocused();
    await expect(page.getByTestId("find-replace-row")).toBeVisible();
    await page.getByTestId("replace-input").click();
    await page.keyboard.press("Control+h");
    await expect(input).toBeFocused();
    await page.keyboard.press("Control+f");
    await expect(input).toBeFocused();
    await page.keyboard.type("dog");
    await expect(input).toHaveValue("dog");
    await expect(count).toHaveText(/^\d of 3$/);
    await page.getByTestId("find-close").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Control+f");
    await expect(input).toBeFocused();
    await page.getByTestId("find-close").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Control+f");
    await expect(input).toBeFocused();
    await page.getByTestId("find-close").click();
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await codeText(page)).toBe(SAMPLE.replace(/cat/g, "dog"));
    await user.context.close();
  });

  // The one input the old event-check gate dropped on main (#2228).
  test("Escape in the replace input closes the bar after the row was hidden and brought back with Mod-H", async ({ browser }) => {
    const user = await signIn(browser, "find-escape-replace");
    const id = await createDocument(user.page, SAMPLE);
    await openDocument(user.page, id);
    const { page } = user;

    await openFromCodePane(page);
    await page.keyboard.type("cat");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await page.getByTestId("find-toggle-replace").click();
    await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
    await page.keyboard.press("Control+h");
    await expect(page.getByTestId("find-replace-row")).toBeVisible();
    await page.getByTestId("replace-input").click();
    await expect(page.getByTestId("replace-input")).toBeFocused();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expect(page.locator(".cm-content")).toBeFocused();
    expect(await selectedText(page)).toBe("cat");
    expect(await codeText(page)).toBe(SAMPLE);
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

/**
 * Real input on the find bar (#2228, batch B2 of #2222). Every step is a native Playwright action: key
 * presses (held ones too), mouse clicks, touch taps, and IME composition through the browser's own input
 * method interface. No React props, no handler calls and no dev-only hooks, so the block runs unchanged
 * against a production build (`PROD_BASE_URL`).
 *
 * The only fixed waits are gaps that are the subject of the test: between two clicks, and the 700 ms after
 * which the box that keeps the close button's place must be gone.
 */

type Layout = "split" | "rich";
interface Size {
  name: string;
  layout: Layout;
  options: BrowserContextOptions;
}
/** The two widths every pointer case runs at. A phone shows one pane, so it gets the preview. */
const SIZES: Size[] = [
  { name: "1440 px", layout: "split", options: {} },
  { name: "390 px", layout: "rich", options: { viewport: { width: 390, height: 844 } } },
];
/** Where on a control the pointer goes, as a fraction of its width. */
const SPOTS = [0.1, 0.5, 0.9];

const PETS = ["The cat sat on the mat. The cat ran.", "Another cat came by later."];
const markdown = (lines: string[]) => `${lines.join("\n\n")}\n`;

/** Sign in and open a new document of plain paragraphs at `size`, with the layout stored before the editor reads it. */
async function openSized(
  browser: Browser,
  login: string,
  lines: string[],
  size: Size = SIZES[0],
  options: BrowserContextOptions = {},
): Promise<{ context: BrowserContext; page: Page; id: string }> {
  const context = await browser.newContext({ ...size.options, ...options });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("markdoc:layout", value);
    } catch {
      // about:blank has no storage.
    }
  }, size.layout);
  await devLogin(page, login);
  const id = await createDocument(page, markdown(lines));
  await page.goto(`/d/${id}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".md-rich")).toContainText(lines[0]);
  if (size.layout === "split") await expect(page.locator(".cm-content")).toContainText(lines[0]);
  return { context, page, id };
}

/** The document's paragraphs, read from the pane on screen: Markdown in the split layout, the preview on a phone. */
const paragraphs = (page: Page, layout: Layout) =>
  layout === "split"
    ? codeText(page).then((text) => text.replace(/\n+$/, "").split("\n\n"))
    : page.locator(".md-rich").evaluate((root) => Array.from(root.children, (block) => block.textContent ?? "").filter(Boolean));
const expectParagraphs = (page: Page, layout: Layout, lines: string[], message?: string) =>
  expect.poll(() => paragraphs(page, layout), { message }).toEqual(lines);

const editorPlace = (layout: Layout) => (layout === "split" ? "markdown" : "preview");

/** Put the caret at the start of the document in the pane on screen and open the bar with a real key. */
async function openBar(page: Page, layout: Layout, key = "Control+f") {
  if (layout === "split") await page.locator(".cm-content").click();
  else await page.locator(".md-rich p").first().click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press(key);
  await expect(page.getByTestId("find-input")).toBeFocused();
}

/** Hold `key` down for `count` keydowns (the repeats carry `repeat: true`), then release it. */
async function holdKey(page: Page, key: string, count: number) {
  for (let i = 0; i < count; i++) await page.keyboard.down(key);
  await page.keyboard.up(key);
}

/** A point on `control`, `fraction` of the way across it. */
async function pointOn(control: Locator, fraction = 0.5) {
  const box = await control.boundingBox();
  expect(box, "the control is on screen").not.toBeNull();
  return { x: box!.x + box!.width * fraction, y: box!.y + box!.height / 2 };
}

/** The ways one aim at a control turns into more than one press. `presses` is how many reach the control when it stays put. */
interface Gesture {
  name: string;
  presses: number;
  run: (page: Page, x: number, y: number) => Promise<void>;
}
const twoClicks = (gap: number): Gesture => ({
  name: gap ? `two clicks ${gap} ms apart` : "two clicks at once",
  presses: 2,
  async run(page, x, y) {
    await page.mouse.click(x, y);
    // The gap is the subject: the second click lands after the first one's re-render and frame.
    if (gap) await page.waitForTimeout(gap);
    await page.mouse.click(x, y);
  },
});
const GESTURES: Gesture[] = [
  { name: "a double-click", presses: 2, run: (page, x, y) => page.mouse.dblclick(x, y) },
  twoClicks(0),
  twoClicks(120),
  twoClicks(400),
  { name: "a triple click", presses: 3, run: (page, x, y) => page.mouse.click(x, y, { clickCount: 3 }) },
  {
    name: "a double tap",
    presses: 2,
    async run(page, x, y) {
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
    },
  },
];

/** The box that keeps the place of a control a click has just removed (press-once.tsx). */
const placeHold = (page: Page) => page.getByTestId("place-hold");
/** The button that moves up under the pointer when the bar closes: one press of it makes the document view-only. */
const modeToggle = (page: Page) => page.getByTestId("preview-mode-toggle");

test.describe("find & replace: real input", () => {
  test("the first Mod-F of a page takes the keys typed right after it, before the page has finished loading", async ({ browser }) => {
    const user = await signIn(browser, "find-first-use");
    const { page } = user;
    const input = page.getByTestId("find-input");
    for (const { pane, key } of [
      { pane: ".cm-content", key: "Control+f" },
      { pane: ".ProseMirror.md-rich", key: "Control+f" },
      { pane: ".cm-content", key: "Control+h" },
    ]) {
      const step = `${key} from ${pane}`;
      const id = await createDocument(page, SAMPLE);
      // A fresh page load each time: nothing of the bar is in memory yet.
      await page.goto(`/d/${id}`, { waitUntil: "commit" });
      await page.locator(pane).click();
      await page.keyboard.press(key);
      await page.keyboard.type("cat");

      await expect(input, step).toHaveValue("cat");
      await expect(input, step).toBeFocused();
      await expect(page.getByTestId("find-count"), step).toHaveText(/^\d of 3$/);
      await expect(page.getByTestId("save-state"), step).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect.poll(() => codeText(page), { message: `${step}: nothing was typed into the document` }).toBe(SAMPLE);
      await expect(page.locator(".md-rich")).toContainText("The cat sat on the mat. The cat ran.");
    }
    await user.context.close();
  });

  test("the find and replace fields show exactly what was typed, pasted or deleted, wherever the caret is", async ({ browser }) => {
    const { page, context } = await openSized(browser, "find-typing", PETS);
    const input = page.getByTestId("find-input");
    const count = page.getByTestId("find-count");
    /** The counter and the highlights belong to the text in the field. */
    const expectSearch = async (value: string, total: number, step: string) => {
      await expect(input, step).toHaveValue(value);
      await expect(count, step).toHaveText(new RegExp(`^${total ? "\\d+" : "0"} of ${total}$`));
      await expect(page.locator(".cm-content .md-find"), step).toHaveCount(total);
      await expect(page.locator(".md-rich .md-find"), step).toHaveCount(total);
      if (total) await expect(page.locator(".cm-content .md-find-active"), step).toHaveText(new RegExp(`^${value}$`, "i"));
    };

    await openBar(page, "split");
    await page.keyboard.type("cat");
    await expectSearch("cat", 3, "typed at the end");

    // In the middle: the caret stays where the user is typing.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("xy");
    await expectSearch("caxyt", 0, "typed in the middle");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expectSearch("cat", 3, "Backspace in the middle");
    await page.keyboard.type("s");
    await expectSearch("cast", 0, "typed after Backspace in the middle");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    await expectSearch("ca", 4, "Delete in the middle");
    await page.keyboard.press("Home");
    await page.keyboard.type("lo");
    await page.keyboard.press("End");
    await page.keyboard.type("te");
    await expectSearch("locate", 0, "typed at the start, then at the end");

    // Select all, then type: fast, with no wait between the keys.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Another cat came by later.");
    await expect(input).toHaveValue("Another cat came by later.");
    await expect(count).toHaveText("1 of 1");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("mat");
    await expectSearch("mat", 1, "select all, then type");

    // Copy from the field and paste in the middle of it.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+v");
    await expectSearch("mamatt", 0, "pasted in the middle");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+v");
    await expectSearch("mat", 1, "pasted over everything");

    // The replace field, the same way.
    const replace = page.getByTestId("replace-input");
    await replace.click();
    await page.keyboard.type("dog");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("xy");
    await expect(replace).toHaveValue("doxyg");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("n");
    await expect(replace).toHaveValue("dong");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("rug");
    await expect(replace).toHaveValue("rug");
    await page.keyboard.press("Home");
    await page.keyboard.press("Control+v");
    await expect(replace).toHaveValue("matrug");
    await expectSearch("mat", 1, "typing in the replace field leaves the search alone");

    // A query set from outside the field shows up: Mod-F with the bar open keeps the query and selects it,
    // and Mod-F with text selected in the editor replaces it.
    await page.keyboard.press("Control+f");
    await expect(input).toBeFocused();
    await expectSearch("mat", 1, "Mod-F with the bar open");
    await page.keyboard.type("cat");
    await expectSearch("cat", 3, "typed over the selected query");
    await page.keyboard.press("Escape");
    await expect(page.locator(".cm-content")).toBeFocused();
    await page.keyboard.press("Control+f");
    await expectSearch("cat", 3, "reopened on the selected match");
    await page.keyboard.type("ran");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+f");
    await expectSearch("ran", 1, "reopened with other text selected");
    await expectParagraphs(page, "split", PETS);
    await context.close();
  });

  test("IME composition in both fields: the text arrives whole, and Enter and Escape belong to the IME while it composes", async ({ browser }) => {
    const { page, context } = await openSized(browser, "find-ime", PETS);
    const input = page.getByTestId("find-input");
    const count = page.getByTestId("find-count");
    const replace = page.getByTestId("replace-input");
    // The browser's input method interface: the composition events a real IME sends, with no key events.
    const ime = await context.newCDPSession(page);
    const compose = (text: string) => ime.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    const commit = (text: string) => ime.send("Input.insertText", { text });

    await openBar(page, "split");
    await compose("c");
    await compose("ca");
    await expect(input).toHaveValue("ca");
    await expect(count).toHaveText("1 of 4");
    // Enter picks a candidate and Escape cancels one in a real IME: neither is a command for the bar.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await frames(page);
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(input).toHaveValue("ca");
    await expect(count).toHaveText("1 of 4");
    await commit("cat");
    await expect(input).toHaveValue("cat");
    await expect(count).toHaveText("1 of 3");
    await page.keyboard.press("Enter");
    await expect(count).toHaveText("2 of 3");

    // In the middle of the text.
    await page.keyboard.press("ArrowLeft");
    await compose("x");
    await compose("xy");
    await expect(input).toHaveValue("caxyt");
    await commit("xy");
    await expect(input).toHaveValue("caxyt");
    await expect(count).toHaveText("0 of 0");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("cat");
    await expect(count).toHaveText("1 of 3");

    // The replace field: Enter while composing replaces nothing.
    await replace.click();
    await compose("d");
    await compose("do");
    await expect(replace).toHaveValue("do");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await frames(page);
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expectParagraphs(page, "split", PETS);
    await commit("dog");
    await expect(replace).toHaveValue("dog");
    await page.keyboard.press("ArrowLeft");
    await compose("n");
    await commit("n");
    await expect(replace).toHaveValue("dong");
    await page.keyboard.press("Enter");
    await expectParagraphs(page, "split", ["The dong sat on the mat. The cat ran.", PETS[1]]);
    await expect(count).toHaveText("1 of 2");
    await context.close();
  });

  for (const size of SIZES) {
    test(`a double-click, two quick clicks or a double tap on Close close the bar and press nothing else (${size.name})`, async ({ browser }) => {
      test.slow();
      const { page, context } = await openSized(browser, "find-close-twice", PETS, size, { hasTouch: true });
      const { layout } = size;
      const bar = page.getByTestId("find-bar");
      const close = page.getByTestId("find-close");
      const reopen = async () => {
        await page.keyboard.press("Control+f");
        await expect(page.getByTestId("find-input")).toBeFocused();
        await page.getByTestId("find-input").fill("cat");
        await expect(page.getByTestId("find-count")).toHaveText(/^\d of 3$/);
      };
      const expectEditing = (step: string) => expect(modeToggle(page), `${step}: the view-only button was not pressed`).toHaveAttribute("aria-label", "View only");

      await openBar(page, layout);
      await page.getByTestId("find-input").fill("cat");
      for (const spot of SPOTS) {
        for (const gesture of GESTURES) {
          const step = `${gesture.name} at ${spot * 100}% of Close`;
          if (!(await bar.count())) await reopen();
          const { x, y } = await pointOn(close, spot);

          await gesture.run(page, x, y);

          await expect(bar, step).toHaveCount(0);
          await frames(page);
          await expectEditing(step);
          await expectFocus(page, editorPlace(layout), step);
          expect(await selectedText(page), `${step}: the match is selected`).toBe("cat");
          await expectParagraphs(page, layout, PETS, step);
        }
      }

      // The box takes no keys and no focus: typing right after the click goes into the editor, over the match.
      await reopen();
      let point = await pointOn(close);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.type("Z");
      await expect.poll(async () => (await paragraphs(page, layout)).join("\n").replace("Z", "cat"), { message: "typed over the selected match" }).toBe(PETS.join("\n"));
      expect((await paragraphs(page, layout)).join("\n")).toContain("Z");
      await page.keyboard.press("Control+z");
      await expectParagraphs(page, layout, PETS, "undo of the typed letter");

      // The box is gone 700 ms after the click that closed the bar: the button under it works again.
      await openBar(page, layout);
      await page.getByTestId("find-input").fill("cat");
      point = await pointOn(close);
      await page.mouse.click(point.x, point.y);
      await expect(placeHold(page)).toHaveCount(1);
      // The time is the subject.
      await page.waitForTimeout(700);
      await expect(placeHold(page)).toHaveCount(0);
      await page.mouse.click(point.x, point.y);
      await expect(modeToggle(page)).toHaveAttribute("aria-label", "Switch to editing");
      await page.mouse.click(point.x, point.y);
      await expectEditing("back to editing");

      // Only a pointer click on Close puts the box up: not Escape, and not Space or Enter on the button.
      for (const way of ["Escape", "Space", "Enter"]) {
        const step = `closed with ${way}`;
        await openBar(page, layout);
        point = await pointOn(close);
        if (way !== "Escape") await close.focus();
        await page.keyboard.press(way);
        await page.mouse.click(point.x, point.y);
        await expect(bar, step).toHaveCount(0);
        await expect(placeHold(page), step).toHaveCount(0);
        await expect(modeToggle(page), step).toHaveAttribute("aria-label", "Switch to editing");
        await page.mouse.click(point.x, point.y);
        await expectEditing(step);
      }
      await expectParagraphs(page, layout, PETS);
      await context.close();
    });

    test(`the rest of a double-click on Replace, Replace all and the Replace toggle stays on that button (${size.name})`, async ({ browser }) => {
      test.slow();
      const cases = SPOTS.flatMap((spot) => GESTURES.map((gesture) => ({ spot, gesture })));
      const solos = cases.map((_, i) => `solo${String(i).padStart(2, "0")}`);
      const trios = cases.map((_, i) => `trio${String(i).padStart(2, "0")}`);
      const lines = [solos.join(" "), ...[0, 6, 12].map((from) => trios.slice(from, from + 6).map((word) => `${word} ${word} ${word}`).join(" "))];
      const { page, context } = await openSized(browser, "find-replace-twice", lines, size, { hasTouch: true });
      const { layout } = size;
      const input = page.getByTestId("find-input");
      const count = page.getByTestId("find-count");
      const row = page.getByTestId("find-replace-row");
      let expected = lines;
      const replaced = (from: string, to: string) => (expected = expected.map((line) => line.replaceAll(from, to)));

      await openBar(page, layout);
      await expect(row).toBeVisible();

      // Replace on the last match: the button switches off under the pointer and keeps the rest of the gesture.
      for (const [i, { spot, gesture }] of cases.entries()) {
        const step = `${gesture.name} at ${spot * 100}% of Replace`;
        await input.fill(solos[i]);
        await expect(count, step).toHaveText("1 of 1");
        await page.getByTestId("replace-input").fill(`ONE${i}`);
        const { x, y } = await pointOn(page.getByTestId("replace-one"), spot);

        await gesture.run(page, x, y);

        await expect(count, step).toHaveText("0 of 0");
        await expect(page.getByTestId("replace-one"), step).toHaveAttribute("aria-disabled", "true");
        await frames(page);
        await expectFocus(page, "replace-one", step);
        await expectParagraphs(page, layout, replaced(solos[i], `ONE${i}`), step);
        await expect(row, step).toBeVisible();
      }

      // Replace all: one call for every match, then the same.
      for (const [i, { spot, gesture }] of cases.entries()) {
        const step = `${gesture.name} at ${spot * 100}% of Replace all`;
        await input.fill(trios[i]);
        await expect(count, step).toHaveText(/^\d of 3$/);
        await page.getByTestId("replace-input").fill(`ALL${i}`);
        const { x, y } = await pointOn(page.getByTestId("replace-all"), spot);

        await gesture.run(page, x, y);

        await expect(count, step).toHaveText("0 of 0");
        await frames(page);
        await expectFocus(page, "replace-all", step);
        await expectParagraphs(page, layout, replaced(trios[i], `ALL${i}`), step);
        await expect(row, step).toBeVisible();
      }

      // The Replace toggle: every press toggles the row, wherever on the button it lands (the label changes
      // between "Hide replace" and "Replace", the button does not shrink away from the pointer).
      const toggle = page.getByTestId("find-toggle-replace");
      for (const { spot, gesture } of cases) {
        const step = `${gesture.name} at ${spot * 100}% of the Replace toggle`;
        await input.click();
        await expect(row, step).toBeVisible();
        const { x, y } = await pointOn(toggle, spot);

        await gesture.run(page, x, y);

        const shown = gesture.presses % 2 === 0;
        await expect(row, step).toHaveCount(shown ? 1 : 0);
        await expect(toggle, step).toHaveAttribute("aria-expanded", String(shown));
        await frames(page);
        await expectFocus(page, shown ? "replace-input" : "find-input", step);
        await expect(page.getByTestId("find-bar"), step).toBeVisible();
        if (!shown) await toggle.click();
      }
      await expect(toggle).toHaveAccessibleName("Hide replace");
      await toggle.click();
      await expect(toggle).toHaveAccessibleName("Replace");
      await toggle.click();
      await expectParagraphs(page, layout, expected, "the toggle changed nothing in the document");

      // A press on the bar itself (the gap between two buttons, the counter) does nothing and keeps focus.
      await input.click();
      const next = await page.getByTestId("find-next").boundingBox();
      await page.mouse.click(next!.x - 3, next!.y + next!.height / 2);
      await page.mouse.dblclick(next!.x - 3, next!.y + next!.height / 2);
      const counter = await pointOn(count);
      await page.mouse.click(counter.x, counter.y);
      await frames(page);
      await expectFocus(page, "find-input", "a press on the bar's background");
      await expect(row).toBeVisible();
      await context.close();
    });

    test(`Next and Previous stay under the pointer when the counter gains or loses digits (${size.name})`, async ({ browser }) => {
      const { page, context } = await openSized(browser, "find-many", [Array.from({ length: 1200 }, () => "ab").join(" ")], size);
      const count = page.getByTestId("find-count");
      const toggle = page.getByTestId("find-toggle-replace");

      await openBar(page, size.layout);
      await page.keyboard.type("ab");
      await expect(count).toHaveText("1 of 1200");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");

      // "1 of 1200" grows to "1200 of 1200" under the first click of a double-click on Previous.
      let point = await pointOn(page.getByTestId("find-prev"), 0.1);
      await page.mouse.dblclick(point.x, point.y);
      await expect(count).toHaveText("1199 of 1200");
      await page.getByTestId("find-next").click();
      await expect(count).toHaveText("1200 of 1200");

      // "1200 of 1200" shrinks to "1 of 1200" under the first click of a double-click on Next.
      point = await pointOn(page.getByTestId("find-next"), 0.9);
      await page.mouse.dblclick(point.x, point.y);
      await expect(count).toHaveText("2 of 1200");
      await frames(page);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByTestId("find-replace-row")).toBeVisible();
      await expectFocus(page, "find-input");
      await context.close();
    });
  }

  test("a held key acts once where once is the point: Replace, Replace all and Close; stepping repeats", async ({ browser }) => {
    const cats = (dogs: number, word = "dog") => [[...Array<string>(dogs).fill(word), ...Array<string>(8 - dogs).fill("cat")].join(" ")];
    const { page, context } = await openSized(browser, "find-held", cats(0));
    const count = page.getByTestId("find-count");
    const replace = page.getByTestId("replace-input");

    await openBar(page, "split");
    await page.keyboard.type("cat");
    await expect(count).toHaveText("1 of 8");

    // Stepping repeats while the key is held: Enter and F3 in the find field.
    await holdKey(page, "Enter", 3);
    await expect(count).toHaveText("4 of 8");
    await holdKey(page, "F3", 3);
    await expect(count).toHaveText("7 of 8");
    await page.keyboard.down("Shift");
    await holdKey(page, "F3", 6);
    await page.keyboard.up("Shift");
    await expect(count).toHaveText("1 of 8");

    // Enter held in the replace field replaces one match; two presses replace two.
    await replace.click();
    await page.keyboard.type("dog");
    await holdKey(page, "Enter", 5);
    await expectParagraphs(page, "split", cats(1), "Enter held in the replace field");
    await expect(count).toHaveText("1 of 7");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expectParagraphs(page, "split", cats(3), "two more Enter presses");
    await expect(count).toHaveText("1 of 5");

    // Enter held on Replace replaces one match, when the key is released; Space too.
    const one = page.getByTestId("replace-one");
    await one.focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await frames(page);
    await expectParagraphs(page, "split", cats(3), "Enter still down on Replace");
    await page.keyboard.up("Enter");
    await expectParagraphs(page, "split", cats(4), "Enter released on Replace");
    await holdKey(page, "Space", 5);
    await expectParagraphs(page, "split", cats(5), "Space held on Replace");
    await expect(one).toBeFocused();
    // Two clicks on purpose are two replacements.
    await one.dblclick();
    await expectParagraphs(page, "split", cats(7), "a double-click on Replace with matches left");
    await expect(count).toHaveText("1 of 1");

    // Enter held on Replace all replaces every match once, when the key is released, and the button keeps focus.
    await page.getByTestId("find-input").fill("dog");
    await expect(count).toHaveText(/^\d of 7$/);
    await replace.fill("emu");
    await page.getByTestId("replace-all").focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await frames(page);
    await expectParagraphs(page, "split", cats(7), "Enter still down on Replace all");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await expectParagraphs(page, "split", cats(7, "emu"), "Enter released on Replace all");
    await expect(count).toHaveText("0 of 0");
    await frames(page);
    await expectFocus(page, "replace-all");
    await page.getByTestId("find-input").fill("emu");
    await expect(count).toHaveText(/^\d of 7$/);

    // Enter held on Close closes the bar when the key is released: no repeat reaches the editor, where it
    // would type new lines over the selected match.
    await page.getByTestId("find-close").focus();
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await frames(page);
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await page.keyboard.up("Enter");
    await expect(page.getByTestId("find-bar")).toHaveCount(0);
    await expectFocus(page, "markdown");
    expect(await selectedText(page)).toBe("emu");
    await expectParagraphs(page, "split", cats(7, "emu"), "Enter held on Close");
    await context.close();
  });

  test("a command typed in one roll acts on the text in the field, and a remote edit never leaves a stale match to replace", async ({ browser }) => {
    const start = ["can cat cab", "cat"];
    const { page, context, id } = await openSized(browser, "find-roll-owner", start);
    const input = page.getByTestId("find-input");
    const count = page.getByTestId("find-count");
    const replace = page.getByTestId("replace-input");

    await openBar(page, "split");
    await replace.fill("dog");
    await input.click();
    await page.keyboard.type("ca");
    await expect(count).toHaveText("1 of 4");

    // One more letter and Enter with no wait: the step is among the matches of "cat".
    await page.keyboard.type("t");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("cat");
    await expect(count).toHaveText("2 of 2");

    // One more letter and a click on Replace with no wait: the match of the new query is replaced, not the
    // text at the place the old query's match had.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("ca");
    await expect(count).toHaveText(/^\d of 4$/);
    const button = await pointOn(page.getByTestId("replace-one"));
    await page.keyboard.type("b");
    await page.mouse.click(button.x, button.y);
    await expectParagraphs(page, "split", ["can cat dog", "cat"], "a letter, then Replace");
    await expect(count).toHaveText("0 of 0");

    // A new replacement and Enter with no wait: the new text is what goes in.
    await input.fill("cab");
    await input.fill("can");
    await expect(count).toHaveText("1 of 1");
    await replace.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("emu");
    await page.keyboard.press("Enter");
    await expectParagraphs(page, "split", ["emu cat dog", "cat"], "a new replacement, then Enter");

    // A second person shifts every match; the owner replaces as soon as the edit is on screen.
    const other = await signIn(browser, "find-roll-editor");
    await shareWith(page, id, "find-roll-editor", "editor");
    await openDocument(other.page, id);
    await input.fill("dog");
    await expect(count).toHaveText("1 of 1");
    await replace.click();
    await other.page.locator(".cm-content").click();
    await other.page.keyboard.press("Control+Home");
    await other.page.keyboard.type("zz ");
    await expect.poll(() => codeText(page), { message: "the remote insert is on screen" }).toContain("zz emu");
    await page.keyboard.press("Enter");
    await expectParagraphs(page, "split", ["zz emu cat emu", "cat"], "Replace right after a remote insert");
    await expect(count).toHaveText("0 of 0");

    // The second person removes every match; the owner's Replace and Replace all then replace nothing.
    await input.fill("cat");
    await expect(count).toHaveText(/^\d of 2$/);
    await replace.click();
    await other.page.keyboard.press("Control+a");
    await other.page.keyboard.type("gone");
    await expect.poll(() => codeText(page), { message: "the remote delete is on screen" }).toMatch(/^gone\n*$/);
    await page.keyboard.press("Enter");
    // A real click on the switched-off button (a locator click would wait for it to be enabled).
    const all = await pointOn(page.getByTestId("replace-all"));
    await page.mouse.click(all.x, all.y);
    await frames(page);
    await expectParagraphs(page, "split", ["gone"], "Replace after a remote delete of every match");
    await expect.poll(() => paragraphs(other.page, "split")).toEqual(["gone"]);
    await expect(count).toHaveText("0 of 0");
    await other.context.close();
    await context.close();
  });

  test("Tab, Shift+Tab and a click elsewhere move focus normally while the bar is open and change nothing", async ({ browser }) => {
    const { page, context } = await openSized(browser, "find-tab", PETS);
    const count = page.getByTestId("find-count");
    const order = ["find-input", "find-match-case", "find-whole-word", "find-regex", "find-prev", "find-next", "find-toggle-replace", "find-close", "replace-input", "replace-one", "replace-all"];

    await openBar(page, "split");
    await page.keyboard.type("cat");
    await expect(count).toHaveText("1 of 3");
    await page.getByTestId("replace-input").fill("dog");
    await page.getByTestId("find-input").click();

    for (const testId of order.slice(1)) {
      await page.keyboard.press("Tab");
      await expectFocus(page, testId, `Tab to ${testId}`);
    }
    // One more Tab leaves the bar; Shift+Tab comes back and walks the same controls in reverse.
    await page.keyboard.press("Tab");
    await frames(page);
    expect(order).not.toContain(await focusPlace(page));
    expect(await focusPlace(page)).not.toBe("body");
    await page.keyboard.press("Shift+Tab");
    for (const testId of [...order].reverse()) {
      await expectFocus(page, testId, `Shift+Tab to ${testId}`);
      await page.keyboard.press("Shift+Tab");
    }
    await frames(page);
    expect(order).not.toContain(await focusPlace(page));
    expect(await focusPlace(page)).not.toBe("body");

    // A click on another control takes focus there; the bar stays as it was.
    await page.getByTestId("title").click();
    await expect(page.getByTestId("title-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.locator(".md-rich p").last().click();
    await expectFocus(page, "preview");
    await page.locator(".cm-content").click();
    await expectFocus(page, "markdown");
    await expect(page.getByTestId("find-bar")).toBeVisible();
    await expect(page.getByTestId("find-input")).toHaveValue("cat");
    await expect(page.getByTestId("replace-input")).toHaveValue("dog");
    await expect(count).toHaveText("1 of 3");
    await expectParagraphs(page, "split", PETS);

    // With nothing to step to, Previous, Next, Replace and Replace all stay in the Tab order, switched off.
    await page.getByTestId("find-input").fill("zebra");
    await expect(count).toHaveText("0 of 0");
    for (const testId of order.slice(1)) {
      await page.keyboard.press("Tab");
      await expectFocus(page, testId, `Tab to ${testId} with no match`);
      if (["find-prev", "find-next", "replace-one", "replace-all"].includes(testId)) {
        await expect(page.getByTestId(testId)).toHaveAttribute("aria-disabled", "true");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        await expectFocus(page, testId, `${testId} keeps focus when pressed with no match`);
      }
    }
    await expectParagraphs(page, "split", PETS);
    await context.close();
  });

  test("a commenter, and an editor who switches to viewing, can find but cannot reach Replace", async ({ browser }) => {
    const { page, context, id } = await openSized(browser, "find-mode-owner", PETS);
    const count = page.getByTestId("find-count");
    const replaceControls = ["find-toggle-replace", "find-replace-row", "replace-input", "replace-one", "replace-all"];
    const expectNoReplace = async (target: Page, step: string) => {
      for (const testId of replaceControls) await expect(target.getByTestId(testId), `${step}: ${testId}`).toHaveCount(0);
    };
    /** Every command the bar has, from the find field and from the editor: all of them only search. */
    const tryEverything = async (target: Page, step: string) => {
      const counter = target.getByTestId("find-count");
      await target.getByTestId("find-input").click();
      for (const key of ["Enter", "Shift+Enter", "F3", "Shift+F3", "Control+h", "Enter"]) await target.keyboard.press(key);
      await expect(target.getByTestId("find-input"), step).toBeFocused();
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        await target.keyboard.press("Tab");
        seen.push(await focusPlace(target));
      }
      expect(seen.filter((place) => replaceControls.includes(place)), `${step}: Tab reached ${seen.join(", ")}`).toEqual([]);
      await target.locator(".cm-content").click();
      await target.keyboard.press("F3");
      await target.keyboard.press("Control+h");
      await expect(counter, step).toHaveText(/^\d of 3$/);
      await expectNoReplace(target, step);
    };

    // The owner fills the replace row, then switches to viewing with the bar open.
    await openBar(page, "split");
    await page.keyboard.type("cat");
    await expect(count).toHaveText("1 of 3");
    await page.getByTestId("replace-input").click();
    await page.keyboard.type("dog");
    await modeToggle(page).click();
    await expect(modeToggle(page)).toHaveAttribute("aria-label", "Switch to editing");
    await expectNoReplace(page, "viewing");
    await frames(page);
    expect(await focusPlace(page)).not.toBe("body");
    await tryEverything(page, "viewing");
    await expectParagraphs(page, "split", PETS, "nothing was replaced while viewing");

    // Back to editing: the row and what was typed in it are there again, and Replace works.
    await modeToggle(page).click();
    await expect(modeToggle(page)).toHaveAttribute("aria-label", "View only");
    await expect(page.getByTestId("replace-input")).toHaveValue("dog");
    await page.getByTestId("find-input").fill("mat");
    await expect(count).toHaveText("1 of 1");
    await page.getByTestId("replace-one").click();
    await expectParagraphs(page, "split", ["The cat sat on the dog. The cat ran.", PETS[1]]);
    await page.getByTestId("find-input").fill("cat");
    await expect(count).toHaveText(/^\d of 3$/);

    // A commenter gets the same bar without any replace control.
    const commenter = await signIn(browser, "find-mode-commenter");
    await shareWith(page, id, "find-mode-commenter", "commenter");
    await openDocument(commenter.page, id);
    await openFromCodePane(commenter.page);
    await commenter.page.keyboard.type("cat");
    await expect(commenter.page.getByTestId("find-count")).toHaveText("1 of 3");
    await expectNoReplace(commenter.page, "commenter");
    await tryEverything(commenter.page, "commenter");
    await commenter.page.getByTestId("find-input").click();
    await commenter.page.keyboard.press("Escape");
    await expect(commenter.page.getByTestId("find-bar")).toHaveCount(0);
    await expectParagraphs(commenter.page, "split", ["The cat sat on the dog. The cat ran.", PETS[1]]);
    await commenter.context.close();
    await context.close();
  });
});
