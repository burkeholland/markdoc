import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { clickCell, codeText, createDocument, expectTableShape, shareWith, signIn, uniqueLogin, waitForEditor } from "./helpers";

/**
 * Real input on the formatting toolbar, the selection bubble and the table menu (#2227, batch B1 of #2222).
 *
 * Every step is a native Playwright action: mouse clicks and drags, key presses (held ones too) and touch
 * taps. No React props, no handler calls and no dev-only hooks (`__markdocRichView`, `selectTextInRich`,
 * `clickEdgeOf`), so the file runs unchanged against a production build (`PROD_BASE_URL`). Keyboard cases
 * put focus on a starting control with `locator.focus()` and press real keys from there.
 *
 * The cases follow the moments the old event-check gates could freeze on: right after a selection change,
 * right after a re-render (two actions back to back), right after a remote edit, and the first activation
 * after the Text style menu or the table menu closes.
 */

type Layout = "split" | "rich" | "code";
type StoredSession = Awaited<ReturnType<BrowserContext["storageState"]>>;

const DOC = [
  "# Title",
  "",
  "Intro text.",
  "",
  "Target paragraph.",
  "",
  "After text.",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
].join("\n");

const users: Record<"owner" | "editor" | "commenter" | "viewer", { login: string; state: StoredSession }> = {} as never;

test.beforeAll(async ({ browser }, workerInfo) => {
  for (const role of ["owner", "editor", "commenter", "viewer"] as const) {
    const signedIn = await signIn(browser, uniqueLogin(`fmt-${role}-${workerInfo.workerIndex}`));
    users[role] = { login: signedIn.login, state: await signedIn.context.storageState() };
    await signedIn.context.close();
  }
});

/** Open `/d/<id>` as `role` in a fresh context, with the layout stored before the editor reads it. */
async function openAs(
  browser: Browser,
  role: keyof typeof users,
  id: string,
  layout: Layout = "split",
  options: BrowserContextOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ storageState: users[role].state, ...options });
  const page = await context.newPage();
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("markdoc:layout", value);
    } catch {
      // about:blank has no storage.
    }
  }, layout);
  await page.goto(`/d/${id}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  if (layout !== "code") await expect(page.locator(".md-rich")).toContainText("Target paragraph.");
  if (layout !== "rich") await expect(page.locator(".cm-content")).toContainText("Target paragraph.");
  return { context, page };
}

/** A new document owned by `owner`, shared with the other test users. */
async function newDocument(browser: Browser, share: Partial<Record<"editor" | "commenter" | "viewer", true>> = {}) {
  const context = await browser.newContext({ storageState: users.owner.state });
  const page = await context.newPage();
  const id = await createDocument(page, DOC, "Real input");
  for (const role of Object.keys(share) as ("editor" | "commenter" | "viewer")[]) await shareWith(page, id, users[role].login, role);
  await context.close();
  return id;
}

const toolbar = (page: Page) => page.getByTestId("toolbar");
const toolButton = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });
const bubble = (page: Page) => page.getByTestId("selection-bubble");
const bubbleButton = (page: Page, name: string) => bubble(page).getByRole("button", { name, exact: true });
const headingMenu = (page: Page) => page.getByTestId("heading-menu");
const menuItem = (page: Page, name: string) => page.getByRole("menuitemradio", { name, exact: true });
const composer = (page: Page) => page.getByTestId("pending-comment").getByTestId("comment-composer");
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");
const targetBlock = (page: Page) => page.locator(".md-rich").locator("p, h1, h2, h3, h4, h5, h6", { hasText: "paragraph." }).first();
const richHeadingWithTarget = (page: Page) => page.locator(".md-rich").locator("h1, h2, h3, h4, h5, h6", { hasText: "paragraph." });

/** Client-coordinate box of the first rendered occurrence of `text` in the rich pane (DOM only). */
async function textBox(page: Page, text: string) {
  const box = await page.locator(".md-rich").evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".md-remote-caret")) continue;
      const index = node.textContent!.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    }
    return null;
  }, text);
  expect(box, `"${text}" is rendered in the rich pane`).not.toBeNull();
  return box!;
}

/**
 * Select `text` in the rich pane with a real mouse drag. The caret is parked at the end of "Intro text."
 * first, so the drag never starts on an existing selection (that would drag the text instead).
 * Waits for the DOM selection and, unless `bubble` is false, for the selection bubble: the bubble shows
 * only once the editor state holds the selection, which is the moment the old gates re-validated on.
 */
async function dragSelect(page: Page, text: string, { expectBubble = true } = {}) {
  await expect(page.locator(".md-rich")).toContainText(text);
  const park = await textBox(page, "Intro text.");
  await page.mouse.click(park.right - 1, park.y);
  const box = await textBox(page, text);
  await page.mouse.move(box.left + 1, box.y);
  await page.mouse.down();
  await page.mouse.move((box.left + box.right) / 2, box.y, { steps: 3 });
  await page.mouse.move(box.right - 1, box.y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => selectedText(page), { message: `the drag selects "${text}"` }).toBe(text);
  if (expectBubble) await expect(bubble(page)).toBeVisible();
}

/** Select `text` in the code pane with real keys (CodeMirror handles them itself, synchronously). */
async function selectInCode(page: Page, text: string) {
  const line = page.locator(".cm-line", { hasText: text }).first();
  const content = (await line.textContent()) ?? "";
  const index = content.indexOf(text);
  expect(index, `"${text}" is on a code line`).toBeGreaterThanOrEqual(0);
  await line.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < text.length; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => selectedText(page), { message: `the keys select "${text}"` }).toBe(text);
}

/** Select "Target" in the pane on screen (the preview when both are). */
const selectTarget = (page: Page, layout: Layout) => (layout === "code" ? selectInCode(page, "Target") : dragSelect(page, "Target"));

/** Caret at the end of "Target paragraph." with a real click, in the rich pane. */
async function caretAtTargetEnd(page: Page) {
  const box = await textBox(page, "paragraph.");
  await page.mouse.click(box.right - 1, box.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = window.getSelection();
        const block = selection?.anchorNode?.parentElement?.closest(".md-rich p, .md-rich h1, .md-rich h2, .md-rich h3, .md-rich h4, .md-rich h5, .md-rich h6");
        return Boolean(selection?.isCollapsed && block?.textContent?.includes("paragraph."));
      }),
    )
    .toBe(true);
}

/** Focus `control` (the starting point a Tab would reach) and press a real key on it. */
async function pressOn(page: Page, control: Locator, key: string) {
  await control.focus();
  await expect(control).toBeFocused();
  await page.keyboard.press(key);
}

/** Hold `key` down for `count` keydowns (the repeats carry `repeat: true`), then release it. */
async function holdKey(page: Page, key: string, count: number) {
  for (let i = 0; i < count; i++) await page.keyboard.down(key);
  await page.keyboard.up(key);
}

type Marks = "plain" | "strong" | "em" | "both";
const CODE_TARGET: Record<Marks, RegExp> = {
  plain: /^Target paragraph\.$/,
  strong: /^\*\*Target\*\* paragraph\.$/,
  em: /^([*_])Target\1 paragraph\.$/,
  both: /^(\*\*\*Target\*\*\*|\*\*([*_])Target\2\*\*|([*_])\*\*Target\*\*\3) paragraph\.$/,
};
const targetLine = async (page: Page) => (await codeText(page)).split("\n").find((line) => line.includes("paragraph.")) ?? "";

/** The marks on "Target", read from the pane on screen: rendered elements in the preview, Markdown in the code pane. */
async function expectTarget(page: Page, layout: Layout, marks: Marks, step: string) {
  if (layout === "code") {
    await expect.poll(() => targetLine(page), { message: step }).toMatch(CODE_TARGET[marks]);
    return;
  }
  const block = targetBlock(page);
  const strong = marks === "strong" || marks === "both";
  const em = marks === "em" || marks === "both";
  await expect(block.locator("strong"), `${step}: bold`).toHaveCount(strong ? 1 : 0);
  await expect(block.locator("em"), `${step}: italic`).toHaveCount(em ? 1 : 0);
  if (strong) await expect(block.locator("strong")).toHaveText("Target");
  if (em) await expect(block.locator("em")).toHaveText("Target");
}

test.describe("formatting toolbar: real input", () => {
  for (const layout of ["split", "rich", "code"] as const) {
    test(`${layout}: click, Enter, Space, held arrows and Home/End act once on the selection`, async ({ browser }) => {
      test.setTimeout(180_000);
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, layout);

      // Roving focus on a fresh document (Undo and Redo are disabled, so they are skipped).
      await pressOn(page, toolButton(page, "Bold"), "ArrowRight");
      await expect(toolButton(page, "Italic"), "ArrowRight moves one button").toBeFocused();
      await holdKey(page, "ArrowRight", 3);
      await expect(page.getByTestId("tb-code"), "a held ArrowRight moves once per repeat").toBeFocused();
      await page.keyboard.press("Home");
      await expect(headingMenu(page), "Home").toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByTestId("tb-comment"), "ArrowLeft wraps to the last button").toBeFocused();
      await page.keyboard.press("Home");
      await page.keyboard.press("End");
      await expect(page.getByTestId("tb-comment"), "End").toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(headingMenu(page), "ArrowRight wraps to the first button").toBeFocused();

      // Mouse click, right after the selection changed. The selection survives the click, so a second click undoes it.
      await selectTarget(page, layout);
      await toolButton(page, "Bold").click();
      await expectTarget(page, layout, "strong", `${layout}: click Bold`);
      if (layout !== "code") {
        expect(await selectedText(page), "the selection is kept after a toolbar click").toBe("Target");
        await expect(bubble(page), "the bubble stays over the kept selection").toBeVisible();
      }
      await toolButton(page, "Bold").click();
      await expectTarget(page, layout, "plain", `${layout}: click Bold again`);

      // Keyboard: Enter, then Space, on a focused button.
      await selectTarget(page, layout);
      await pressOn(page, toolButton(page, "Italic"), "Enter");
      await expectTarget(page, layout, "em", `${layout}: Enter on Italic`);
      await pressOn(page, toolButton(page, "Italic"), " ");
      await expectTarget(page, layout, "plain", `${layout}: Space on Italic`);

      // Two actions back to back: the second click lands on the re-render the first one caused.
      await selectTarget(page, layout);
      await toolButton(page, "Bold").click();
      await toolButton(page, "Italic").click();
      await expectTarget(page, layout, "both", `${layout}: Bold then Italic`);

      // Undo and Redo buttons.
      await page.waitForTimeout(450); // Y.UndoManager merges edits closer than 400 ms.
      await expect(page.getByTestId("tb-undo")).toBeEnabled();
      await page.getByTestId("tb-undo").click();
      await expectTarget(page, layout, "plain", `${layout}: Undo`);
      await expect(page.getByTestId("tb-redo")).toBeEnabled();
      await page.getByTestId("tb-redo").click();
      await expectTarget(page, layout, "both", `${layout}: Redo`);

      // Comment opens the composer on the selection.
      await selectTarget(page, layout);
      await page.getByTestId("tb-comment").click();
      await expect(composer(page), `${layout}: Comment`).toBeFocused();
      await context.close();
    });
  }

  test("Text style menu: click, Enter, Space, ArrowDown, ArrowUp, Escape, and the first click after it closes", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    // Click to open, click to pick; focus goes back to the editor.
    await caretAtTargetEnd(page);
    await headingMenu(page).click();
    await expect(menu).toBeVisible();
    await menuItem(page, "Heading 2").click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".md-rich h2")).toHaveText("Target paragraph.");
    await expect(page.locator(".md-rich"), "the caret goes back to the editor").toBeFocused();
    await expect(headingMenu(page), "the trigger shows the level").toContainText("2");

    // Enter opens on the first item; keys stay in the open menu; Escape closes and returns focus to the editor.
    await pressOn(page, headingMenu(page), "Enter");
    await expect(menuItem(page, "Paragraph"), "Enter opens on the first item").toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menuItem(page, "Heading 1"), "ArrowDown moves inside the open menu").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(menuItem(page, "Heading 1"), "ArrowRight does not move toolbar focus out of the menu").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".md-rich"), "Escape hands focus to the editor").toBeFocused();
    await expect(page.locator(".md-rich h2"), "Escape picks nothing").toHaveText("Target paragraph.");

    // Space opens on the first item too; Enter picks it.
    await pressOn(page, headingMenu(page), " ");
    await expect(menuItem(page, "Paragraph"), "Space opens on the first item").toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(richHeadingWithTarget(page), "Paragraph").toHaveCount(0);

    // ArrowDown opens on the first item; ArrowUp opens on the last one.
    await pressOn(page, headingMenu(page), "ArrowDown");
    await expect(menuItem(page, "Paragraph"), "ArrowDown opens on the first item").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await pressOn(page, headingMenu(page), "ArrowUp");
    await expect(menuItem(page, "Heading 6"), "ArrowUp opens on the last item").toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menuItem(page, "Heading 5")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".md-rich h5")).toHaveText("Target paragraph.");

    // The first toolbar click after Escape closes the menu works, on the selection kept through the menu.
    await dragSelect(page, "Target");
    await headingMenu(page).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await toolButton(page, "Bold").click();
    await expect(page.locator(".md-rich h5 strong"), "first click after Escape").toHaveText("Target");

    // …and the first click after a pick works too.
    await dragSelect(page, "paragraph");
    await headingMenu(page).click();
    await menuItem(page, "Heading 3").click();
    await expect(menu).toHaveCount(0);
    await toolButton(page, "Italic").click();
    await expect(page.locator(".md-rich h3 em"), "first click after a pick").toHaveText("paragraph");
    await context.close();
  });

  test("touch taps on the toolbar, the Text style menu, the bubble and the table menu", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split", { hasTouch: true });

    await dragSelect(page, "Target");
    await toolButton(page, "Bold").tap();
    await expectTarget(page, "split", "strong", "tap toolbar Bold");
    await expect(bubble(page)).toBeVisible();
    await bubbleButton(page, "Italic").tap();
    await expectTarget(page, "split", "both", "tap bubble Italic");

    await headingMenu(page).tap();
    await expect(page.getByRole("menu")).toBeVisible();
    await menuItem(page, "Heading 3").tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".md-rich h3")).toContainText("Target paragraph.");

    await clickCell(page, 1, 0);
    await page.getByTestId("table-row-after").tap();
    await expectTableShape(page, 3, 2);
    await context.close();
  });
});

test.describe("selection bubble: real input", () => {
  test("click, Enter, Space, held arrows, Home/End, Link and Escape", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // Click, right after the selection appeared; the selection survives, so a second click undoes it.
    await dragSelect(page, "Target");
    await bubbleButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "bubble Bold click");
    expect(await selectedText(page), "the selection is kept after a bubble click").toBe("Target");
    await bubbleButton(page, "Bold").click();
    await expectTarget(page, "split", "plain", "bubble Bold click again");

    // Keyboard: held arrows, Home/End and wrapping, then Enter and Space.
    await dragSelect(page, "Target");
    await bubbleButton(page, "Bold").focus();
    await expect(bubbleButton(page, "Bold")).toBeFocused();
    await holdKey(page, "ArrowRight", 3);
    await expect(bubbleButton(page, "Inline code"), "a held ArrowRight moves once per repeat").toBeFocused();
    await page.keyboard.press("End");
    await expect(bubbleButton(page, "Comment"), "End").toBeFocused();
    await page.keyboard.press("Home");
    await expect(bubbleButton(page, "Bold"), "Home").toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(bubbleButton(page, "Comment"), "ArrowLeft wraps").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(bubbleButton(page, "Bold"), "ArrowRight wraps").toBeFocused();
    await page.keyboard.press("Enter");
    await expectTarget(page, "split", "strong", "Enter on bubble Bold");
    await expect(bubble(page)).toBeVisible();
    await pressOn(page, bubbleButton(page, "Italic"), " ");
    await expectTarget(page, "split", "both", "Space on bubble Italic");

    // Link.
    await dragSelect(page, "After");
    await bubbleButton(page, "Link").click();
    await page.getByTestId("link-url").fill("example.com/docs");
    await page.getByTestId("link-submit").click();
    await expect(page.locator(".md-rich a", { hasText: "After" })).toHaveAttribute("href", "https://example.com/docs");

    // Escape collapses the selection and hides the bubble; the next selection's first click works.
    await dragSelect(page, "Intro");
    await page.keyboard.press("Escape");
    await expect(bubble(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? null)).toBe(true);
    await dragSelect(page, "Intro");
    await bubbleButton(page, "Strikethrough").click();
    await expect(page.locator(".md-rich p", { hasText: "Intro" }).locator("s, del")).toHaveText("Intro");
    await context.close();
  });
});

test.describe("table menu: real input", () => {
  test("row, column and alignment clicks, keys, Escape and the first click after it hides", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

    // Every structural action, by click, on the table the caret is in.
    const steps: [string, number, number][] = [
      ["table-row-after", 3, 2],
      ["table-col-after", 3, 3],
      ["table-row-before", 4, 3],
      ["table-col-before", 4, 4],
      ["table-delete-row", 3, 4],
      ["table-delete-col", 3, 3],
    ];
    for (const [testId, rows, cols] of steps) {
      await clickCell(page, 1, 0);
      await page.getByTestId(testId).click();
      await expectTableShape(page, rows, cols);
    }

    // Alignment, twice in a row on the same column (the second click lands on the first one's re-render).
    const delimiter = async () => (await codeText(page)).split("\n").find((line) => /^\|\s*:?-+/.test(line)) ?? "";
    await clickCell(page, 1, 1);
    await page.getByTestId("table-align-center").click();
    await expect.poll(delimiter, { message: "center" }).toMatch(/^\|[^|]*\|\s*:-+:\s*\|/);
    await expect(page.getByTestId("table-align-center")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("table-align-right").click();
    await expect.poll(delimiter, { message: "right" }).toMatch(/^\|[^|]*\|\s*-+:\s*\|/);
    await page.getByTestId("table-align-right").click();
    await expect.poll(delimiter, { message: "right again clears it" }).toMatch(/^\|[^|]*\|\s*-+\s*\|/);

    // Keyboard: held arrows, Home/End and wrapping, then Enter and Space.
    await clickCell(page, 1, 0);
    await page.getByTestId("table-row-before").focus();
    await expect(page.getByTestId("table-row-before")).toBeFocused();
    await holdKey(page, "ArrowRight", 3);
    await expect(page.getByTestId("table-col-after"), "a held ArrowRight moves once per repeat").toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByTestId("table-delete"), "End").toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("table-row-before"), "Home").toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("table-delete"), "ArrowLeft wraps").toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("table-row-after")).toBeFocused();
    await page.keyboard.press("Enter");
    await expectTableShape(page, 4, 3);
    await clickCell(page, 1, 0);
    await pressOn(page, page.getByTestId("table-col-after"), " ");
    await expectTableShape(page, 4, 4);

    // Escape hides the menu; the first click after it comes back acts on the current table.
    await clickCell(page, 1, 0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    await clickCell(page, 1, 1);
    await page.getByTestId("table-row-after").click();
    await expectTableShape(page, 5, 4);

    // Delete table.
    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete").click();
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await context.close();
  });
});

test.describe("right after a remote edit", () => {
  test("toolbar, bubble and table menu clicks land on the mapped selection", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, { editor: true });
    const alice = await openAs(browser, "owner", id, "split");
    const bob = await openAs(browser, "editor", id, "split");

    /** Bob types at the end of the title line (before Alice's selection), and Alice sees it arrive. */
    const remoteEdit = async (suffix: string) => {
      await bob.page.locator(".cm-content").click();
      await bob.page.keyboard.press("Control+Home");
      await bob.page.keyboard.press("End");
      await bob.page.keyboard.type(suffix);
      await expect(alice.page.locator(".md-rich h1")).toContainText(`Title${suffix}`);
    };

    await dragSelect(alice.page, "Target");
    await remoteEdit(" one");
    await toolButton(alice.page, "Bold").click();
    await expectTarget(alice.page, "split", "strong", "toolbar Bold right after a remote edit");

    await dragSelect(alice.page, "After");
    await remoteEdit(" two");
    await bubbleButton(alice.page, "Italic").click();
    await expect(alice.page.locator(".md-rich p", { hasText: "After" }).locator("em")).toHaveText("After");

    await clickCell(alice.page, 1, 0);
    await remoteEdit(" three");
    await alice.page.getByTestId("table-row-after").click();
    await expectTableShape(alice.page, 3, 2);
    await expect.poll(() => codeText(bob.page), { message: "Bob gets Alice's edits" }).toMatch(/\*\*Target\*\* paragraph\./);

    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("permissions with real input", () => {
  test("viewer: every toolbar button is disabled, no Comment button, no bubble, no table menu", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, { viewer: true });
    const { page, context } = await openAs(browser, "viewer", id, "split");

    const buttons = toolbar(page).getByRole("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(10);
    for (let i = 0; i < count; i++) await expect(buttons.nth(i)).toBeDisabled();
    await expect(page.getByTestId("tb-comment")).toHaveCount(0);

    await dragSelect(page, "Target", { expectBubble: false });
    await page.waitForTimeout(500);
    await expect(bubble(page)).toHaveCount(0);
    await tableCellClick(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    expect(await codeText(page)).not.toMatch(/\*\*Target/);
    await context.close();
  });

  test("commenter: format buttons disabled; the bubble's Comment and the toolbar's Comment open the composer", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, { commenter: true });
    const { page, context } = await openAs(browser, "commenter", id, "split");

    for (const name of ["Bold", "Italic", "Strikethrough", "Link", "Inline code", "Bulleted list", "Horizontal rule"]) {
      await expect(toolButton(page, name), name).toBeDisabled();
    }
    await expect(headingMenu(page)).toBeDisabled();
    await expect(page.getByTestId("tb-comment")).toBeEnabled();

    // Bubble Comment by click.
    await dragSelect(page, "Target");
    await expect(bubbleButton(page, "Bold")).toBeDisabled();
    await bubbleButton(page, "Comment").click();
    await expect(composer(page), "bubble Comment click").toBeFocused();
    await page.keyboard.type("From the bubble");
    await page.getByTestId("pending-comment").getByTestId("comment-submit").click();
    await expect(page.getByTestId("comment-thread").filter({ hasText: "From the bubble" })).toBeVisible();

    // Bubble Comment by keyboard: it is the bubble's only enabled button, so it holds the tab stop.
    await dragSelect(page, "After");
    await pressOn(page, bubbleButton(page, "Comment"), "Enter");
    await expect(composer(page), "Enter on bubble Comment").toBeFocused();
    await page.keyboard.type("From the keyboard");
    await page.getByTestId("pending-comment").getByTestId("comment-submit").click();
    await expect(page.getByTestId("comment-thread").filter({ hasText: "From the keyboard" })).toBeVisible();

    // Toolbar Comment by click.
    await dragSelect(page, "Intro");
    await page.getByTestId("tb-comment").click();
    await expect(composer(page), "toolbar Comment click").toBeFocused();
    expect(await codeText(page), "commenting must not format the text").not.toMatch(/\*\*|~~|`Target/);
    await context.close();
  });

  test("owner in Viewing mode cannot format; back in Editing the first click works", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await page.getByTestId("mode-switcher").click();
    await page.getByRole("menuitemradio", { name: /^Viewing/ }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toolButton(page, "Bold")).toBeDisabled();
    await expect(headingMenu(page)).toBeDisabled();

    await page.getByTestId("mode-switcher").click();
    await page.getByRole("menuitemradio", { name: /^Editing/ }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(toolButton(page, "Bold")).toBeEnabled();
    await dragSelect(page, "Target");
    await toolButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "Bold after switching back to Editing");
    await context.close();
  });
});

/** A plain click in table cell (1, 0) for a user who gets no table menu (clickCell waits for the menu). */
async function tableCellClick(page: Page) {
  await page.locator(".md-rich table tr").nth(1).locator("td").first().click();
}
