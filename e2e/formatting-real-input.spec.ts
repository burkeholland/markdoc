import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { clickCell, codeText, createDocument, expectTableShape, shareWith, signIn, uniqueLogin, waitForEditor } from "./helpers";

/**
 * Real input on the formatting toolbar, the selection bubble and the table menu (#2227, batch B1 of #2222).
 *
 * Every step is a native Playwright action: mouse clicks and drags, key presses (held ones too) and touch
 * taps. No React props, no handler calls and no dev-only hooks (`__markdocRichView`, `selectTextInRich`,
 * `clickEdgeOf`), so the file runs unchanged against a production build (`PROD_BASE_URL`).
 *
 * Three kinds of case:
 * - Input the old event-check gates dropped: a second click on the same table button, a held arrow in the
 *   bubble, Home after a held arrow, a touch tap, a click with a remote edit between its press and release.
 * - One press is one action, and nothing else gets the rest of it: a held Enter or Space, and the second
 *   click of a double-click on a control that the first click closed, hid or moved.
 * - The box that keeps a removed control's place is there for that and for nothing else: what a click lands
 *   on shortly after a button that leaves its control in place, and 600 ms after one that removes it.
 *
 * The only fixed waits are gaps that are the subject of the test: between two clicks or taps, and the
 * second after which the Text style menu forgets a typed letter.
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

/** No heading (so no outline row), and a table with enough rows and columns to delete some. */
const TABLE_DOC = [
  "Intro text.",
  "",
  "Target paragraph.",
  "",
  "After text.",
  "",
  "| a | b | c | d |",
  "| --- | --- | --- | --- |",
  "| 1 | 2 | 3 | 4 |",
  "| 5 | 6 | 7 | 8 |",
  "| 9 | 10 | 11 | 12 |",
  "",
].join("\n");

/**
 * The line above the table when the test is about what a stray click under the table menu would hit. At
 * 1440 px it is one line that runs under every button of the menu, so a click that got through would put
 * the caret in the middle of it; the delete itself leaves the caret at its end.
 */
const UNDER_MENU = "After text that runs on under every button of the table menu.";

/** Rows of text down the pane, so one of them has its bubble over a given spot of the Link dialog. */
const LINK_ROWS = Array.from({ length: 22 }, (_, i) => `Row ${String(i + 1).padStart(2, "0")} of the link test.`);
const LINK_DOC = ["Intro text.", "", "Target paragraph.", "", ...LINK_ROWS.flatMap((row) => [row, ""])].join("\n");

/** The two widths every pointer case runs at. A phone shows one pane, so it gets the preview. */
const SIZES: { name: string; layout: Layout; options: BrowserContextOptions }[] = [
  { name: "1440 px", layout: "split", options: {} },
  { name: "390 px", layout: "rich", options: { viewport: { width: 390, height: 844 } } },
];
/** Where on a control the pointer goes, as a fraction of its width. */
const SPOTS = [0.1, 0.5, 0.9];

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
async function newDocument(browser: Browser, share: Partial<Record<"editor" | "commenter" | "viewer", true>> = {}, content = DOC) {
  const context = await browser.newContext({ storageState: users.owner.state });
  const page = await context.newPage();
  const id = await createDocument(page, content, "Real input");
  for (const role of Object.keys(share) as ("editor" | "commenter" | "viewer")[]) await shareWith(page, id, users[role].login, role);
  await context.close();
  return id;
}

const toolbar = (page: Page) => page.getByTestId("toolbar");
const toolButton = (page: Page, name: string) => toolbar(page).getByRole("button", { name, exact: true });
const bubble = (page: Page) => page.getByTestId("selection-bubble");
const bubbleButton = (page: Page, name: string) => bubble(page).getByRole("button", { name, exact: true });
const headingMenu = (page: Page) => page.getByTestId("heading-menu");
/** A Text style item. The current one carries a check mark in its name, so the name is matched at its end. */
const menuItem = (page: Page, name: string) => page.getByRole("menuitemradio", { name: new RegExp(`${name}$`) });
const composer = (page: Page) => page.getByTestId("pending-comment").getByTestId("comment-composer");
/** The box that keeps the place of a control a click has just removed (press-once.tsx). */
const placeHold = (page: Page) => page.getByTestId("place-hold");
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");
const targetBlock = (page: Page) => page.locator(".md-rich").locator("p, h1, h2, h3, h4, h5, h6", { hasText: "paragraph." }).first();
const richHeadingWithTarget = (page: Page) => page.locator(".md-rich").locator("h1, h2, h3, h4, h5, h6", { hasText: "paragraph." });

/** Two animation frames: the bubble and the table menu place or hide themselves in one. */
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
const expectFocus = (page: Page, place: string, message: string) => expect.poll(() => focusPlace(page), { message }).toBe(place);

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
 * first, so the drag never starts on an existing selection (that would drag the text instead) and never
 * under the table menu (a document that ends with a table opens with the caret in it). The parking click
 * goes to the far right of that line: the bubble of a selection in the next line floats over its text.
 * Waits for the DOM selection and, unless `expectBubble` is false, for the selection bubble: the bubble
 * shows only once the editor state holds the selection.
 */
async function dragSelect(page: Page, text: string, { expectBubble = true } = {}) {
  await expect(page.locator(".md-rich")).toContainText(text);
  const park = await textBox(page, "Intro text.");
  const pane = (await page.locator(".md-rich").boundingBox())!;
  await page.mouse.click(pane.x + pane.width - 4, park.y);
  await expect(bubble(page)).toHaveCount(0);
  await expect(page.getByTestId("table-menu")).toHaveCount(0);
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

/**
 * Press real Tab (or Shift+Tab) until focus is inside `surface`, the way a keyboard user gets there.
 * The Markdown pane keeps Tab for indenting; Esc first is its escape hatch (as in a11y.spec.ts).
 */
async function tabInto(page: Page, surface: Locator, key: "Tab" | "Shift+Tab", max = 40) {
  const inside = () => surface.evaluate((element) => element.contains(document.activeElement));
  for (let i = 0; i < max; i++) {
    if (await inside()) return;
    if (await page.evaluate(() => Boolean(document.activeElement?.closest(".cm-content")))) await page.keyboard.press("Escape");
    await page.keyboard.press(key);
  }
  expect(await inside(), `${key} reaches the control within ${max} presses`).toBe(true);
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

/**
 * The ways one aim at a control turns into more than one click. `counted` is how many of them the browser
 * reports as a first click (`detail` 1): a double-click and a triple click are one, two separate clicks two.
 */
interface Gesture {
  name: string;
  counted: number;
  run: (page: Page, x: number, y: number) => Promise<void>;
}
const twoClicks = (gap: number): Gesture => ({
  name: gap ? `two clicks ${gap} ms apart` : "two clicks at once",
  counted: 2,
  async run(page, x, y) {
    await page.mouse.click(x, y);
    // The gap is the subject: the second click lands after the first one's re-render and frame.
    if (gap) await page.waitForTimeout(gap);
    await page.mouse.click(x, y);
  },
});
const MOUSE_GESTURES: Gesture[] = [
  { name: "a double-click", counted: 1, run: (page, x, y) => page.mouse.dblclick(x, y) },
  twoClicks(0),
  twoClicks(120),
  twoClicks(400),
  { name: "a triple click", counted: 1, run: (page, x, y) => page.mouse.click(x, y, { clickCount: 3 }) },
];
const DOUBLE_TAP: Gesture = {
  name: "a double tap",
  counted: 1,
  async run(page, x, y) {
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
  },
};
/** `count` taps on one spot, `gap` ms apart (0: as fast as they can be sent). */
const taps = (count: 2 | 3, gap: number): Gesture => ({
  name: `${count === 2 ? "a double" : "a triple"} tap${gap ? `, ${gap} ms apart` : " with no gap"}`,
  counted: 1,
  async run(page, x, y) {
    for (let i = 0; i < count; i++) {
      // The gap is the subject.
      if (i && gap) await page.waitForTimeout(gap);
      await page.touchscreen.tap(x, y);
    }
  },
});
/**
 * A click and a second one `gap` ms later that the browser counts as the second of a double-click
 * (`detail` 2), as a real mouse does for two clicks on one spot within 500 ms.
 */
const doubleClick = (gap: number): Gesture => ({
  name: gap ? `a double-click with ${gap} ms between its clicks` : "a double-click with no gap",
  counted: 1,
  async run(page, x, y) {
    await page.mouse.click(x, y);
    // The gap is the subject.
    if (gap) await page.waitForTimeout(gap);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
  },
});

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

/** The whole document, as Markdown, is `DOC` with the "Target paragraph." line replaced by `line`. */
const expectDocument = (page: Page, line: string, step: string) =>
  expect.poll(() => codeText(page), { message: step }).toBe(DOC.replace("Target paragraph.", line));

/** The text of every block in the preview, in order: what a stray key or click would change. */
const blockTexts = (page: Page) =>
  page.locator(".md-rich").evaluate((root) => Array.from(root.children, (block) => `${block.tagName}:${block.textContent}`));

/** Where the caret is: the block it is in and its offset, or where focus went instead. */
const caretPlace = (page: Page) =>
  page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const block = (node instanceof Element ? node : node?.parentElement)?.closest(".md-rich > *");
    if (!document.activeElement?.closest(".md-rich") || !selection || !block) return `focus on ${document.activeElement?.tagName}`;
    return `${block.textContent} @${selection.anchorOffset} ${selection.isCollapsed ? "caret" : "range"}`;
  });

/** One pointer press: when it came (ms, the page's clock) and what it landed on. */
interface Press {
  at: number;
  on: string;
}

/**
 * Start a fresh record of what every pointer press lands on. The page gets one listener that only looks:
 * it sends no input and changes nothing. "box" is the place-holding box of press-once.tsx.
 */
async function watchPresses(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as { __presses?: { at: number; on: string }[] };
    if (state.__presses) {
      state.__presses.length = 0;
      return;
    }
    const seen: { at: number; on: string }[] = (state.__presses = []);
    const places = [
      ["[data-testid=place-hold]", "box"],
      ["[data-testid=selection-bubble]", "bubble"],
      ["[data-testid=table-menu]", "table menu"],
      ["[role=menu]", "menu"],
      ["[role=dialog]", "dialog"],
      [".md-rich", "preview"],
    ];
    window.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const place = places.find(([selector]) => target?.closest(selector));
        seen.push({ at: event.timeStamp, on: place ? place[1] : (target?.getAttribute("data-testid") ?? target?.tagName.toLowerCase() ?? "nothing") });
      },
      true,
    );
  });
}
const presses = (page: Page): Promise<Press[]> =>
  page.evaluate(() => (window as unknown as { __presses: { at: number; on: string }[] }).__presses.map((press) => ({ ...press })));

/** The part two boxes share, or null when it is under 12 px either way: too little to aim a click at. */
function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - left >= 12 && bottom - top >= 12 ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
}

test.describe("formatting toolbar: real input", () => {
  for (const layout of ["split", "rich", "code"] as const) {
    test(`${layout}: Tab reaches the toolbar; arrows, a held arrow, Home and End move focus`, async ({ browser }) => {
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, layout);

      // Real Tab from page load reaches the toolbar's single tab stop, its first enabled button. Roving
      // focus then skips Undo and Redo, which are off on a fresh document.
      await tabInto(page, toolbar(page), "Tab");
      await expect(headingMenu(page), "Tab lands on the first enabled button").toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(toolButton(page, "Bold"), "ArrowRight moves one button").toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(toolButton(page, "Italic"), "ArrowRight moves one button").toBeFocused();
      await holdKey(page, "ArrowRight", 3);
      await expect(page.getByTestId("tb-code"), "a held ArrowRight moves once per repeat").toBeFocused();
      await page.keyboard.press("Home");
      await expect(headingMenu(page), "Home, right after a held arrow").toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByTestId("tb-comment"), "ArrowLeft wraps to the last button").toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(toolButton(page, "Horizontal rule"), "ArrowLeft skips Redo and Undo, which are off").toBeFocused();
      await page.keyboard.press("Home");
      await page.keyboard.press("End");
      await expect(page.getByTestId("tb-comment"), "End").toBeFocused();
      await page.keyboard.press("ArrowRight");
      await expect(headingMenu(page), "ArrowRight wraps to the first button").toBeFocused();
      await context.close();
    });

    test(`${layout}: click, Enter and Space act once on the selection, and Comment opens the composer`, async ({ browser }) => {
      test.setTimeout(180_000);
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, layout);

      // Mouse click, right after the selection changed. The selection survives the click, so a second click undoes it.
      await selectTarget(page, layout);
      await toolButton(page, "Bold").click();
      await expectTarget(page, layout, "strong", `${layout}: click Bold`);
      if (layout !== "code") {
        expect(await selectedText(page), "the selection is kept after a toolbar click").toBe("Target");
        await expect(bubble(page), "the bubble stays over the kept selection").toBeVisible();
        await expectFocus(page, "preview", "focus after a toolbar click");
      }
      await toolButton(page, "Bold").click();
      await expectTarget(page, layout, "plain", `${layout}: click Bold again`);

      // Keyboard: Enter, then Space, on a focused button. In the preview-only layout a keyboard user gets
      // back to the toolbar with Shift+Tab from the selection (no Markdown pane in between); the toolbar
      // keeps its last-used button as the tab stop. A preview action hands focus back to the editor.
      await selectTarget(page, layout);
      if (layout === "rich") {
        await tabInto(page, toolbar(page), "Shift+Tab", 15);
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect(toolButton(page, "Italic")).toBeFocused();
        await page.keyboard.press("Enter");
      } else {
        await pressOn(page, toolButton(page, "Italic"), "Enter");
      }
      await expectTarget(page, layout, "em", `${layout}: Enter on Italic`);
      if (layout !== "code") await expectFocus(page, "preview", `${layout}: focus after Enter on Italic`);
      if (layout === "rich") {
        await tabInto(page, toolbar(page), "Shift+Tab", 15);
        await expect(toolButton(page, "Italic"), "Shift+Tab comes back to the last-used button").toBeFocused();
        await page.keyboard.press(" ");
      } else {
        await pressOn(page, toolButton(page, "Italic"), " ");
      }
      await expectTarget(page, layout, "plain", `${layout}: Space on Italic`);
      if (layout !== "code") await expectFocus(page, "preview", `${layout}: focus after Space on Italic`);
      expect(await focusPlace(page), "focus is never left on the page").not.toBe("body");

      // Comment opens the composer on the selection.
      await selectTarget(page, layout);
      await page.getByTestId("tb-comment").click();
      await expect(composer(page), `${layout}: Comment`).toBeFocused();
      await context.close();
    });
  }

  test("Bold then Italic back to back; Undo and Redo take one step each", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // The second click lands on the re-render the first one caused.
    await dragSelect(page, "Target");
    await toolButton(page, "Bold").click();
    await toolButton(page, "Italic").click();
    await expectTarget(page, "split", "both", "Bold then Italic");

    await expect(page.getByTestId("tb-undo")).toBeEnabled();
    await page.getByTestId("tb-undo").click();
    await expectTarget(page, "split", "strong", "Undo takes back Italic");
    await page.getByTestId("tb-undo").click();
    await expectTarget(page, "split", "plain", "Undo again takes back Bold");
    await expect(page.getByTestId("tb-redo")).toBeEnabled();
    await page.getByTestId("tb-redo").click();
    await expectTarget(page, "split", "strong", "Redo");
    await expectFocus(page, "preview", "focus after Redo");
    await context.close();
  });

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
    await expectFocus(page, "preview", "the caret goes back to the editor");
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
    await expectFocus(page, "preview", "Escape hands focus to the editor");
    await expect(page.locator(".md-rich h2"), "Escape picks nothing").toHaveText("Target paragraph.");

    // Space opens on the first item too; Enter picks it.
    await pressOn(page, headingMenu(page), " ");
    await expect(menuItem(page, "Paragraph"), "Space opens on the first item").toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(richHeadingWithTarget(page), "Paragraph").toHaveCount(0);
    await expectFocus(page, "preview", "a keyboard pick hands focus to the editor");

    // ArrowDown opens on the first item; ArrowUp opens on the last one. Space picks too.
    await pressOn(page, headingMenu(page), "ArrowDown");
    await expect(menuItem(page, "Paragraph"), "ArrowDown opens on the first item").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await pressOn(page, headingMenu(page), "ArrowUp");
    await expect(menuItem(page, "Heading 6"), "ArrowUp opens on the last item").toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menuItem(page, "Heading 5")).toBeFocused();
    await page.keyboard.press(" ");
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

  test("Tab, Shift+Tab and a click on Bold while the Text style menu is open pick nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    await dragSelect(page, "Target");
    await pressOn(page, headingMenu(page), "Enter");
    await expect(menuItem(page, "Paragraph")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menuItem(page, "Heading 1")).toBeFocused();
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      await expect(menu, `${key} leaves the menu open`).toBeVisible();
      expect(await focusPlace(page), `${key} keeps focus in the menu`).not.toBe("body");
    }
    // A click on another control closes the menu and does nothing else: the menu is modal.
    const bold = await pointOn(page.getByTestId("tb-bold"));
    await page.mouse.click(bold.x, bold.y);
    await expect(menu).toHaveCount(0);
    await expectFocus(page, "preview", "an outside click hands focus to the editor");
    await expectDocument(page, "Target paragraph.", "nothing was picked and nothing was formatted");
    expect(await selectedText(page)).toBe("Target");

    // The next click on Bold is an ordinary one.
    await toolButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "first click after the menu closed");
    await context.close();
  });

  test("a pointer that rests where an item will open does not take the keyboard's pick", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    // Learn where Heading 3 opens, close the menu, and leave the pointer there.
    await dragSelect(page, "Target");
    await headingMenu(page).click();
    const spot = await pointOn(menuItem(page, "Heading 3"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.mouse.move(spot.x, spot.y);

    await pressOn(page, headingMenu(page), "Enter");
    await expect(menuItem(page, "Paragraph"), "the first item has the highlight, not the one under the pointer").toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menuItem(page, "Heading 1")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.locator(".md-rich h1", { hasText: "paragraph." }), "the keyboard's item is picked").toHaveCount(1);
    await context.close();
  });

  test("with the menu opened by the pointer, a space typed after a letter stays in the menu's search", async ({ browser }) => {
    test.skip(Boolean(process.env.PROD_BASE_URL), "production builds drop Radix's typeahead buffer, see issue 2257");
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    // The pointer opens the menu with focus on the menu, not on an item: the letter is typed there.
    await dragSelect(page, "Target");
    await headingMenu(page).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("h");
    await expect(menuItem(page, "Heading 1"), "the letter finds the first match").toBeFocused();
    await page.keyboard.press(" ");
    await frames(page);
    await expect(menu, "the space is part of the name being typed").toBeVisible();
    await expectDocument(page, "Target paragraph.", "the space picks nothing");

    // The search forgets what was typed after a second: the gap is the subject. Space then picks.
    await page.waitForTimeout(1_100);
    await page.keyboard.press(" ");
    await expect(menu).toHaveCount(0);
    await expectDocument(page, "# Target paragraph.", "Space, a second after the last letter");
    await context.close();
  });

  test("a click made before the page has finished loading does no harm, and the next one works", async ({ browser }) => {
    const id = await newDocument(browser);
    const context = await browser.newContext({ storageState: users.owner.state });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // `commit` returns before the load event: the click goes in as soon as the button exists.
    await page.goto(`/d/${id}`, { waitUntil: "commit" });
    await page.getByTestId("tb-bold").click();

    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".md-rich")).toContainText("Target paragraph.");
    await dragSelect(page, "Target");
    await toolButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "Bold after the early click");
    await expect.poll(() => codeText(page), { message: "the early click changed nothing else" }).toBe(DOC.replace("Target paragraph.", "**Target** paragraph."));
    expect(errors, "no page error").toEqual([]);
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
    await expect(placeHold(page)).toHaveCount(0);

    await clickCell(page, 1, 0);
    await page.getByTestId("table-row-after").tap();
    await expectTableShape(page, 3, 2);
    await context.close();
  });
});

test.describe("one press is one action: held keys", () => {
  test("a held Enter or Space on a toolbar button formats once and types nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await dragSelect(page, "Target");
    await toolButton(page, "Bold").focus();
    await holdKey(page, "Enter", 6);
    await expectDocument(page, "**Target** paragraph.", "a held Enter on Bold");
    await expectFocus(page, "preview", "focus after the held Enter");
    expect(await selectedText(page), "the selection is still there, not replaced by new lines").toBe("Target");

    await toolButton(page, "Italic").focus();
    await holdKey(page, " ", 6);
    await expect.poll(() => targetLine(page), { message: "a held Space on Italic" }).toMatch(CODE_TARGET.both);
    expect(await selectedText(page)).toBe("Target");
    expect((await codeText(page)).split("\n").length, "no line was added").toBe(DOC.split("\n").length);
    await context.close();
  });

  test("a held Enter on a toolbar button formats the Markdown pane once", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "code");

    await selectInCode(page, "Target");
    await toolButton(page, "Bold").focus();
    await holdKey(page, "Enter", 6);
    await expectDocument(page, "**Target** paragraph.", "a held Enter on Bold, Markdown pane");
    expect(await focusPlace(page)).not.toBe("body");
    await context.close();
  });

  test("Enter released on another button, or after focus left, does nothing; Ctrl+Enter and Alt+Enter do nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await dragSelect(page, "Target");
    // Down on Bold, an arrow moves focus to Italic, released there.
    await toolButton(page, "Bold").focus();
    await page.keyboard.down("Enter");
    await page.keyboard.press("ArrowRight");
    await expect(toolButton(page, "Italic")).toBeFocused();
    await page.keyboard.up("Enter");
    // Down on Italic, Tab takes focus out of the toolbar, released there.
    await page.keyboard.down("Enter");
    await page.keyboard.press("Tab");
    await expect.poll(() => toolbar(page).evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await page.keyboard.up("Enter");
    for (const chord of ["Control+Enter", "Alt+Enter"]) await pressOn(page, toolButton(page, "Bold"), chord);
    await frames(page);
    await expectDocument(page, "Target paragraph.", "none of these presses formats anything");

    // Shift+Enter is an ordinary press.
    await pressOn(page, toolButton(page, "Bold"), "Shift+Enter");
    await expectDocument(page, "**Target** paragraph.", "Shift+Enter on Bold");
    await context.close();
  });

  test("a held Enter or Space on the Text style trigger opens the menu and picks nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    for (const key of ["Enter", " "]) {
      const name = key === " " ? "Space" : key;
      await dragSelect(page, "Target");
      await headingMenu(page).focus();
      await holdKey(page, key, 6);
      await expect(menu, `a held ${name} leaves the menu open`).toBeVisible();
      await expect(menuItem(page, "Paragraph"), `a held ${name} opens on the first item`).toBeFocused();
      await expectDocument(page, "Target paragraph.", `a held ${name} picks nothing and types nothing`);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      expect(await selectedText(page), "the selection is kept").toBe("Target");
    }
    await context.close();
  });

  test("a held Enter or Space on a Text style item picks it once and types nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const menu = page.getByRole("menu");

    for (const [key, item, line] of [
      ["Enter", "Heading 2", "## Target paragraph."],
      [" ", "Heading 3", "### Target paragraph."],
    ] as const) {
      const name = key === " " ? "Space" : key;
      await dragSelect(page, "Target");
      await pressOn(page, headingMenu(page), "Enter");
      await expect(menuItem(page, "Paragraph")).toBeFocused();
      // Radix moves focus a moment after the key: wait for each step before the next key.
      for (let level = 1; level <= Number(item.at(-1)); level++) {
        await page.keyboard.press("ArrowDown");
        await expect(menuItem(page, `Heading ${level}`)).toBeFocused();
      }
      await holdKey(page, key, 6);
      await expect(menu).toHaveCount(0);
      await expectDocument(page, line, `a held ${name} on ${item}`);
      await expectFocus(page, "preview", `focus after a held ${name} on ${item}`);
      expect(await selectedText(page), "the selection is still there, not typed over").toBe("Target");
    }
    await context.close();
  });

  test("a held Enter or Space on a bubble button formats once and types nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await dragSelect(page, "Target");
    await bubbleButton(page, "Bold").focus();
    await holdKey(page, "Enter", 6);
    await expectDocument(page, "**Target** paragraph.", "a held Enter on the bubble's Bold");
    await expectFocus(page, "preview", "focus after the held Enter");
    expect(await selectedText(page)).toBe("Target");

    await expect(bubble(page)).toBeVisible();
    await bubbleButton(page, "Italic").focus();
    await holdKey(page, " ", 6);
    await expect.poll(() => targetLine(page), { message: "a held Space on the bubble's Italic" }).toMatch(CODE_TARGET.both);
    expect((await codeText(page)).split("\n").length, "no line was added").toBe(DOC.split("\n").length);
    await context.close();
  });

  test("a held Enter, Space or Delete on the table menu's Delete row deletes at most one row", async ({ browser }) => {
    const id = await newDocument(browser, {}, TABLE_DOC);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 4, 4);

    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete-row").focus();
    await holdKey(page, "Delete", 6);
    await frames(page);
    await expectTableShape(page, 4, 4);
    await expect(page.getByTestId("table-delete-row"), "Delete is not a key of the menu").toBeFocused();

    await holdKey(page, "Enter", 6);
    await expectTableShape(page, 3, 4);
    await expectFocus(page, "preview", "focus after the held Enter");

    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete-row").focus();
    await holdKey(page, " ", 6);
    await expectTableShape(page, 2, 4);
    await expect.poll(() => codeText(page), { message: "the repeats typed nothing" }).toBe(
      ["Intro text.", "", "Target paragraph.", "", "After text.", "", "| a   | b   | c   | d   |", "| --- | --- | --- | --- |", "| 9   | 10  | 11  | 12  |", ""].join("\n"),
    );
    await context.close();
  });
});

test.describe("one press is one action: the rest of a double-click", () => {
  for (const size of SIZES) {
    test(`${size.name}: a Text style item is picked once and nothing under the closed menu is pressed`, async ({ browser }) => {
      test.setTimeout(240_000);
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);
      const menu = page.getByRole("menu");

      for (const spot of SPOTS) {
        for (const gesture of MOUSE_GESTURES) {
          const step = `${gesture.name} at ${spot * 100}% of Heading 2`;
          await dragSelect(page, "Target");
          const before = await blockTexts(page);
          await headingMenu(page).click();
          const point = await pointOn(menuItem(page, "Heading 2"), spot);
          await gesture.run(page, point.x, point.y);

          await expect(menu, step).toHaveCount(0);
          await expect(page.locator(".md-rich h2", { hasText: "paragraph." }), `${step}: picked`).toHaveCount(1);
          // At 1440 px the Outline row of the new heading appears under the pointer; at 390 px the text does.
          await expectFocus(page, "preview", `${step}: focus stays in the editor`);
          expect(await selectedText(page), `${step}: the selection is kept`).toBe("Target");
          expect(await blockTexts(page), `${step}: nothing else changed`).toEqual(before.map((block) => block.replace("P:Target", "H2:Target")));
          await expect(placeHold(page), `${step}: the place is given back`).toHaveCount(0);

          // Back to a paragraph, from the keyboard.
          await pressOn(page, headingMenu(page), "Enter");
          await expect(menuItem(page, "Paragraph")).toBeFocused();
          await page.keyboard.press("Enter");
          await expect(richHeadingWithTarget(page)).toHaveCount(0);
        }
      }
      await context.close();
    });

    test(`${size.name}: a double tap picks a Text style item once and presses nothing under the closed menu`, async ({ browser }) => {
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, size.layout, { ...size.options, hasTouch: true });

      for (const spot of SPOTS) {
        const step = `a double tap at ${spot * 100}% of Heading 2`;
        await dragSelect(page, "Target");
        await headingMenu(page).tap();
        const point = await pointOn(menuItem(page, "Heading 2"), spot);
        await DOUBLE_TAP.run(page, point.x, point.y);
        await expect(page.getByRole("menu"), step).toHaveCount(0);
        await expect(page.locator(".md-rich h2", { hasText: "paragraph." }), `${step}: picked`).toHaveCount(1);
        await expectFocus(page, "preview", `${step}: focus stays in the editor`);
        expect(await selectedText(page), `${step}: the selection is kept`).toBe("Target");
        await expect(placeHold(page)).toHaveCount(0);

        await pressOn(page, headingMenu(page), "Enter");
        await expect(menuItem(page, "Paragraph")).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(richHeadingWithTarget(page)).toHaveCount(0);
      }
      await context.close();
    });

    test(`${size.name}: the bubble's Comment opens one composer and the click after it does not take its focus`, async ({ browser }) => {
      test.setTimeout(240_000);
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);

      for (const spot of SPOTS) {
        for (const gesture of MOUSE_GESTURES) {
          const step = `${gesture.name} at ${spot * 100}% of Comment`;
          await dragSelect(page, "Target");
          const point = await pointOn(bubbleButton(page, "Comment"), spot);
          await gesture.run(page, point.x, point.y);

          await expect(composer(page), `${step}: the composer keeps focus`).toBeFocused();
          await expect(page.getByTestId("pending-comment"), `${step}: one composer`).toHaveCount(1);
          await expect(page.getByTestId("comment-quote"), `${step}: on the selected text`).toHaveText("Target");
          await expect(placeHold(page), `${step}: the place is given back`).toHaveCount(0);
          await expect(composer(page), `${step}: the composer still has focus`).toBeFocused();

          await page.keyboard.press("Escape");
          await expect(page.getByTestId("pending-comment")).toHaveCount(0);
        }
      }
      await context.close();
    });

    test(`${size.name}: Delete table removes the table once and the click after it does not move the caret`, async ({ browser }) => {
      test.setTimeout(240_000);
      const id = await newDocument(browser, {}, TABLE_DOC.replace("After text.", UNDER_MENU));
      const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);
      const restore = async () => {
        await page.keyboard.press("Control+z");
        await expect(page.locator(".md-rich table")).toHaveCount(1);
      };

      // One plain click: where the delete itself leaves the caret.
      await clickCell(page, 1, 0);
      await page.getByTestId("table-delete").click();
      await expect(page.locator(".md-rich table")).toHaveCount(0);
      await expect(placeHold(page)).toHaveCount(0);
      const expected = await caretPlace(page);
      expect(expected, "a delete leaves a caret in the preview").toMatch(/caret$/);
      await restore();

      for (const spot of SPOTS) {
        for (const gesture of MOUSE_GESTURES) {
          const step = `${gesture.name} at ${spot * 100}% of Delete table`;
          await clickCell(page, 1, 0);
          const point = await pointOn(page.getByTestId("table-delete"), spot);
          await watchPresses(page);
          await gesture.run(page, point.x, point.y);
          await expect(page.locator(".md-rich table"), step).toHaveCount(0);
          await expect(placeHold(page), `${step}: the place is given back`).toHaveCount(0);
          // The menu is there for one more frame after its table; then the box has its place.
          const stray = (await presses(page)).map((press) => press.on).filter((on) => on !== "table menu" && on !== "box");
          expect(stray, `${step}: every press lands on the menu or on the box that keeps its place`).toEqual([]);
          expect(await caretPlace(page), `${step}: the caret is where the delete left it`).toBe(expected);
          expect(await blockTexts(page), `${step}: nothing else changed`).toEqual(["P:Intro text.", "P:Target paragraph.", `P:${UNDER_MENU}`]);
          await restore();
        }
      }
      await context.close();
    });
  }

  test("a double tap on Delete table or on the bubble's Comment does one thing", async ({ browser }) => {
    const id = await newDocument(browser, {}, TABLE_DOC);
    const { page, context } = await openAs(browser, "owner", id, "split", { hasTouch: true });

    for (const spot of SPOTS) {
      await dragSelect(page, "Target");
      const point = await pointOn(bubbleButton(page, "Comment"), spot);
      await DOUBLE_TAP.run(page, point.x, point.y);
      await expect(composer(page), `double tap at ${spot * 100}% of Comment`).toBeFocused();
      await expect(placeHold(page)).toHaveCount(0);
      await expect(composer(page), "the composer still has focus").toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("pending-comment")).toHaveCount(0);
    }

    await clickCell(page, 1, 0);
    const point = await pointOn(page.getByTestId("table-delete"), 0.9);
    await DOUBLE_TAP.run(page, point.x, point.y);
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await expect(placeHold(page)).toHaveCount(0);
    await expectFocus(page, "preview", "focus after the double tap");
    expect(await blockTexts(page)).toEqual(["P:Intro text.", "P:Target paragraph.", "P:After text."]);
    await context.close();
  });

  /** Delete row and Delete column under each gesture: how many it deletes, that the menu stays, and where focus is. */
  async function deleteUnder(browser: Browser, size: (typeof SIZES)[number], gestures: Gesture[], spots: number[]) {
    const id = await newDocument(browser, {}, TABLE_DOC);
    const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);
    // Read from the preview: at 390 px there is no Markdown pane to count lines in.
    const shape = () =>
      page.locator(".md-rich table tr").evaluateAll((rows) => `${rows.length}x${rows[0]?.querySelectorAll("td,th").length ?? 0}`);
    await expect.poll(shape).toBe("4x4");

    for (const [testId, removes] of [
      ["table-delete-row", "row"],
      ["table-delete-col", "column"],
    ] as const) {
      for (const spot of spots) {
        for (const gesture of gestures) {
          const step = `${gesture.name} at ${spot * 100}% of Delete ${removes}`;
          await clickCell(page, 1, 0);
          const button = page.getByTestId(testId);
          await button.scrollIntoViewIfNeeded();
          const point = await pointOn(button, spot);
          await gesture.run(page, point.x, point.y);
          const left = 4 - gesture.counted;
          await expect.poll(shape, { message: step }).toBe(removes === "row" ? `${left}x4` : `4x${left}`);
          await expect(page.getByTestId("table-menu"), `${step}: the menu stays`).toBeVisible();
          await expect(placeHold(page), `${step}: the table is still there, so nothing keeps the menu's place`).toHaveCount(0);
          await expectFocus(page, "preview", `${step}: focus stays in the editor`);
          for (let i = 0; i < gesture.counted; i++) await page.keyboard.press("Control+z");
          await expect.poll(shape, { message: `${step}: undone` }).toBe("4x4");
        }
      }
    }
    await context.close();
  }

  for (const size of SIZES) {
    // The gestures of MOUSE_GESTURES named "two clicks" report click count 1 for each click, whatever the
    // gap: they pin the rule itself (only a click the browser counts as part of a multi-click is ignored).
    test(`${size.name}: Delete row and Delete column delete one per double-click, and one per separate click`, async ({ browser }) => {
      test.setTimeout(240_000);
      await deleteUnder(browser, size, MOUSE_GESTURES, SPOTS);
    });

    // What a real mouse sends: within 500 ms on one spot the second click carries click count 2, later it
    // is a new first click.
    test(`${size.name}: Delete row and Delete column with the click counts a mouse sends: one deleted up to 400 ms apart, two from 550 ms`, async ({ browser }) => {
      test.setTimeout(240_000);
      await deleteUnder(browser, size, [doubleClick(0), doubleClick(120), doubleClick(400), twoClicks(550), twoClicks(700)], [0.5]);
    });
  }

  test("a double tap on Delete row deletes one row", async ({ browser }) => {
    const id = await newDocument(browser, {}, TABLE_DOC);
    const { page, context } = await openAs(browser, "owner", id, "split", { hasTouch: true });
    await expectTableShape(page, 4, 4);
    await clickCell(page, 1, 0);
    const point = await pointOn(page.getByTestId("table-delete-row"), 0.9);
    await DOUBLE_TAP.run(page, point.x, point.y);
    await expectTableShape(page, 3, 4);
    await context.close();
  });

  test("buttons that stay put act on every click: Row below, Column right, and the toolbar's and the bubble's Bold", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, {}, TABLE_DOC);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 4, 4);

    // The second click on the same table button, however soon or late it comes.
    let rows = 4;
    for (const gesture of MOUSE_GESTURES) {
      await clickCell(page, 1, 0);
      const point = await pointOn(page.getByTestId("table-row-after"), 0.5);
      await gesture.run(page, point.x, point.y);
      rows += gesture.name === "a triple click" ? 3 : 2;
      await expectTableShape(page, rows, 4);
      await expectFocus(page, "preview", `${gesture.name} on Row below: focus stays in the editor`);
    }
    await clickCell(page, 1, 0);
    const column = await pointOn(page.getByTestId("table-col-after"), 0.5);
    await twoClicks(400).run(page, column.x, column.y);
    await expectTableShape(page, rows, 6);

    // A double-click on a format button is two clicks on that button, never one on its neighbour.
    for (const spot of [0.1, 0.9]) {
      for (const [name, button] of [
        ["the toolbar's Bold", () => toolButton(page, "Bold")],
        ["the bubble's Bold", () => bubbleButton(page, "Bold")],
        ["the bubble's Inline code", () => bubbleButton(page, "Inline code")],
      ] as const) {
        const step = `${name} at ${spot * 100}%`;
        await dragSelect(page, "Target");
        const point = await pointOn(button(), spot);
        await page.mouse.dblclick(point.x, point.y);
        await expect(targetBlock(page).locator("strong, em, s, del, code"), `a double-click on ${step} leaves the text plain`).toHaveCount(0);
        expect(await selectedText(page), `${step}: the selection is kept`).toBe("Target");
        await expectFocus(page, "preview", `${step}: focus stays in the editor`);
      }
    }
    await dragSelect(page, "Target");
    const bold = await pointOn(bubbleButton(page, "Bold"), 0.9);
    await page.mouse.click(bold.x, bold.y, { clickCount: 3 });
    await expect(targetBlock(page).locator("strong")).toHaveText("Target");
    await expect(targetBlock(page).locator("em, s, del, code"), "a triple click on Bold is Bold only").toHaveCount(0);

    // None of the four add buttons moves the menu, so a second click is on the same button.
    const menuPlace = async () => {
      const box = (await page.getByTestId("table-menu").boundingBox())!;
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width)];
    };
    for (const testId of ["table-row-before", "table-row-after", "table-col-before", "table-col-after"]) {
      await clickCell(page, 1, 0);
      const before = await menuPlace();
      const size = await page.locator(".md-rich table td, .md-rich table th").count();
      await page.getByTestId(testId).click();
      await expect.poll(() => page.locator(".md-rich table td, .md-rich table th").count(), { message: testId }).toBeGreaterThan(size);
      await frames(page);
      expect(await menuPlace(), `${testId} leaves the menu where it was`).toEqual(before);
    }
    await context.close();
  });

  test("Delete column on the last column removes the table once and the click after it does not move the caret", async ({ browser }) => {
    test.setTimeout(180_000);
    const oneColumn = ["Intro text.", "", "Target paragraph.", "", UNDER_MENU, "", "| a |", "| --- |", "| 1 |", ""].join("\n");
    const id = await newDocument(browser, {}, oneColumn);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const restore = async () => {
      await page.keyboard.press("Control+z");
      await expect(page.locator(".md-rich table")).toHaveCount(1);
    };

    // The table has one column: deleting it removes the table, and the menu with it.
    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete-col").click();
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await expect(placeHold(page)).toHaveCount(0);
    const expected = await caretPlace(page);
    expect(expected, "the delete leaves a caret in the preview").toMatch(/caret$/);
    await restore();

    for (const spot of SPOTS) {
      for (const gesture of MOUSE_GESTURES) {
        const step = `${gesture.name} at ${spot * 100}% of Delete column`;
        await clickCell(page, 1, 0);
        const point = await pointOn(page.getByTestId("table-delete-col"), spot);
        await watchPresses(page);
        await gesture.run(page, point.x, point.y);
        await expect(page.locator(".md-rich table"), step).toHaveCount(0);
        await expect(placeHold(page), `${step}: the place is given back`).toHaveCount(0);
        const stray = (await presses(page)).map((press) => press.on).filter((on) => on !== "table menu" && on !== "box");
        expect(stray, `${step}: every press lands on the menu or on the box that keeps its place`).toEqual([]);
        expect(await caretPlace(page), `${step}: the caret is where the delete left it`).toBe(expected);
        expect(await blockTexts(page), `${step}: nothing else changed`).toEqual(["P:Intro text.", "P:Target paragraph.", `P:${UNDER_MENU}`]);
        await restore();
      }
    }
    await context.close();
  });

  for (const size of SIZES) {
    // After the delete the caret is in the neighbouring table, so the menu does not go away: it moves to
    // that table. When that is the table after, it has moved up to where the deleted one was, and the
    // same button is under the pointer again. When it is the table before, the menu has moved up to it,
    // and what is under the pointer is a cell of that table: the rest of the gesture can put the caret
    // there, and that is all it can do.
    test(`${size.name}: with another table next to it, a double-click or a double tap on a delete that removes the table removes one table`, async ({ browser }) => {
      test.setTimeout(300_000);
      const table = (head: string, cell: string) => [head, head.replace(/[^|\s]+/g, "---"), cell, ""];
      const two = [...table("| a | b |", "| 1 | 2 |"), ...table("| c | d |", "| 3 | 4 |")];
      const cases = [
        { name: "Delete table, the first of two tables", doc: two, caretIn: 0, testId: "table-delete", left: "c", menuStays: true },
        { name: "Delete table, the last of two tables", doc: two, caretIn: 1, testId: "table-delete", left: "a", menuStays: false },
        { name: "Delete column, a one-column table before another table", doc: [...table("| a |", "| 1 |"), ...table("| c | d |", "| 3 | 4 |")], caretIn: 0, testId: "table-delete-col", left: "c", menuStays: true },
      ];
      const gestures = [doubleClick(0), doubleClick(120), doubleClick(400), taps(2, 0)];

      for (const { name, doc, caretIn, testId, left, menuStays } of cases) {
        const id = await newDocument(browser, {}, ["Intro text.", "", "Target paragraph.", "", "After text.", "", ...doc].join("\n"));
        const { page, context } = await openAs(browser, "owner", id, size.layout, { ...size.options, hasTouch: true });
        const tables = page.locator(".md-rich table");
        await expect(tables).toHaveCount(2);
        // Without the mark the editor draws for a caret between two blocks: a press beside a table puts one there.
        const blocks = async () => (await blockTexts(page)).filter((block) => block !== "DIV:");
        const before = await blocks();

        for (const spot of SPOTS) {
          for (const gesture of gestures) {
            const step = `${name}: ${gesture.name} at ${spot * 100}%`;
            await tables.nth(caretIn).locator("td").first().click();
            const button = page.getByTestId(testId);
            await expect(button).toBeVisible();
            await button.scrollIntoViewIfNeeded();
            const point = await pointOn(button, spot);
            await watchPresses(page);
            await gesture.run(page, point.x, point.y);

            await expect(tables, step).not.toHaveCount(2);
            await frames(page);
            await expect(tables, `${step}: one table is left`).toHaveCount(1);
            await expect(tables.locator("th").first(), `${step}: the other table`).toHaveText(left);
            const stray = (await presses(page)).map((press) => press.on).filter((on) => on !== "table menu" && on !== "box");
            if (menuStays) expect(stray, `${step}: every press lands on the menu`).toEqual([]);
            await expectFocus(page, "preview", `${step}: focus stays in the editor`);
            expect(await blocks(), `${step}: nothing but the one table has changed`).toEqual(before.filter((_, index) => index !== 3 + caretIn));

            await page.keyboard.press("Control+z");
            await expect(tables, `${step}: undone`).toHaveCount(2);
            expect(await blocks(), `${step}: undone`).toEqual(before);
          }
        }
        await context.close();
      }
    });
  }

  test("Undo and Redo keep their place when the heading level comes and goes; a double-click on Undo undoes twice", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const undo = page.getByTestId("tb-undo");
    const redo = page.getByTestId("tb-redo");

    const plain = await undo.boundingBox();
    await dragSelect(page, "Target");
    await toolButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "Bold");
    await headingMenu(page).click();
    await menuItem(page, "Heading 2").click();
    await expect(page.locator(".md-rich h2", { hasText: "paragraph." })).toHaveCount(1);
    await expect(headingMenu(page)).toContainText("2");
    await expect(placeHold(page)).toHaveCount(0);
    expect((await undo.boundingBox())!.x, "the level in the Text style button moves no other button").toBe(plain!.x);

    // The first undo takes the level away. With the toolbar moving, the right edge of Undo became Redo.
    const right = await pointOn(undo, 0.9);
    await page.mouse.dblclick(right.x, right.y);
    await expect(richHeadingWithTarget(page), "the first click undoes the heading").toHaveCount(0);
    await expectTarget(page, "split", "plain", "the second click undoes Bold");
    await expectFocus(page, "preview", "focus after the double-click on Undo");

    const left = await pointOn(redo, 0.1);
    await page.mouse.dblclick(left.x, left.y);
    await expect(page.locator(".md-rich h2", { hasText: "paragraph." }), "a double-click on Redo redoes twice").toHaveCount(1);
    await expectTarget(page, "split", "strong", "Redo twice");
    await context.close();
  });

  test("a double-click on the last Undo keeps focus and the selection in the editor", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    const undo = page.getByTestId("tb-undo");

    for (const spot of SPOTS) {
      await dragSelect(page, "Target");
      await toolButton(page, "Bold").click();
      await expectTarget(page, "split", "strong", "Bold");
      await expect(undo).toBeEnabled();
      // The first click undoes the only step, which switches Undo off under the pointer.
      const point = await pointOn(undo, spot);
      await page.mouse.dblclick(point.x, point.y);
      await expectTarget(page, "split", "plain", "Undo");
      await expect(undo).toBeDisabled();
      await expectFocus(page, "preview", `double-click at ${spot * 100}% of the last Undo`);
      expect(await selectedText(page), "the selection is the one Undo put back, and nothing else").toBe("Target");
    }
    // The switched-off Undo does nothing on a further click, and Redo works.
    await undo.click({ force: true });
    await page.getByTestId("tb-redo").click();
    await expectTarget(page, "split", "strong", "Redo after the last Undo");
    await context.close();
  });
});

/**
 * The box is for the rest of the gesture that removed a control, and for nothing else: only a click
 * whose own action takes the control away puts it up, and it is gone 600 ms after that click.
 */
test.describe("the box that keeps a removed control's place", () => {
  test("the bubble's Comment with the Comments panel closed: the rest of a double tap, a triple tap or a double-click lands on nothing", async ({ browser }) => {
    test.setTimeout(300_000);
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split", { hasTouch: true });
    const panel = page.getByTestId("comments-panel");
    const gestures: { gesture: Gesture; count: number }[] = [
      { gesture: taps(2, 0), count: 2 },
      { gesture: taps(3, 0), count: 3 },
      { gesture: taps(2, 120), count: 2 },
      { gesture: taps(2, 250), count: 2 },
      { gesture: doubleClick(0), count: 2 },
      { gesture: doubleClick(120), count: 2 },
      { gesture: doubleClick(250), count: 2 },
    ];

    for (const spot of SPOTS) {
      for (const { gesture, count } of gestures) {
        const step = `${gesture.name} at ${spot * 100}% of Comment`;
        // The panel coming in makes the preview narrower, and the text moves under the pointer.
        await expect(panel, `${step}: the pass starts with the Comments panel closed`).toHaveCount(0);
        await dragSelect(page, "Target");
        const point = await pointOn(bubbleButton(page, "Comment"), spot);
        await watchPresses(page);
        await gesture.run(page, point.x, point.y);

        await expect(composer(page), `${step}: the composer has focus`).toBeFocused();
        await expect(page.getByTestId("pending-comment"), `${step}: one composer`).toHaveCount(1);
        await expect(page.getByTestId("comment-quote"), `${step}: on the selected text`).toHaveText("Target");
        expect((await presses(page)).map((press) => press.on), `${step}: the first press is on the bubble, the rest on the box in its place`).toEqual([
          "bubble",
          ...Array.from({ length: count - 1 }, () => "box"),
        ]);
        await expect(bubble(page), `${step}: the bubble does not come back`).toHaveCount(0);
        await expect(placeHold(page), `${step}: the place is given back`).toHaveCount(0);
        await expect(composer(page), `${step}: the composer still has focus`).toBeFocused();
        await expectDocument(page, "Target paragraph.", `${step}: nothing was typed or formatted`);

        // Cancelling puts the caret at the end of the selection the comment was for: it was still "Target".
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("pending-comment")).toHaveCount(0);
        await expect.poll(() => caretPlace(page), { message: `${step}: the selection was not moved` }).toBe("Target paragraph. @6 caret");
        await page.getByRole("button", { name: "Close comments" }).click();
      }
    }
    await context.close();
  });

  for (const size of SIZES) {
    test(`${size.name}: a click on the Link dialog 150 ms after the bubble's Link reaches the dialog`, async ({ browser }) => {
      const id = await newDocument(browser, {}, LINK_DOC);
      const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);
      const dialog = page.getByRole("dialog");
      const textField = page.getByTestId("link-text");

      // Where the dialog puts its Text field, and where the bubble sits relative to the text it is for.
      await dragSelect(page, "Target");
      const lift = (await bubble(page).boundingBox())!.y - (await textBox(page, "Target")).y;
      await bubbleButton(page, "Link").click();
      await expect(page.getByTestId("link-url"), "the dialog opens on its URL field").toBeFocused();
      let field = (await textField.boundingBox())!;
      await expect
        .poll(
          async () => {
            const now = (await textField.boundingBox())!;
            const still = now.x === field.x && now.y === field.y;
            field = now;
            return still;
          },
          { message: "the dialog has settled" },
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);

      // The row whose bubble is over that field.
      let row = "";
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of LINK_ROWS) {
        const name = candidate.slice(0, 6);
        const off = Math.abs((await textBox(page, name)).y + lift - field.y);
        if (off < best) [row, best] = [name, off];
      }
      await dragSelect(page, row);
      const spot = overlap((await bubble(page).boundingBox())!, field);
      expect(spot, `the bubble over "${row}" covers part of the dialog's Text field`).not.toBeNull();

      const link = await pointOn(bubbleButton(page, "Link"));
      await watchPresses(page);
      await page.mouse.click(link.x, link.y);
      // The gap is the subject: the bubble is gone, and nothing may be in the way of the dialog.
      await page.waitForTimeout(150);
      await page.mouse.click(spot!.x, spot!.y);
      await expect(textField, "the click reaches the Text field").toBeFocused();
      expect((await presses(page)).map((press) => press.on)).toEqual(["bubble", "dialog"]);
      await expect(placeHold(page), "Link never keeps the bubble's place").toHaveCount(0);
      await page.keyboard.type("!");
      await expect(textField).toHaveValue(/!/);
      await context.close();
    });

    test(`${size.name}: the bubble's Bold, an arrow key, and a click on the text where the bubble was`, async ({ browser }) => {
      const id = await newDocument(browser);
      const { page, context } = await openAs(browser, "owner", id, size.layout, size.options);

      // The bubble of a selection in "Target paragraph." floats over the line above it.
      await dragSelect(page, "Target");
      const box = (await bubble(page).boundingBox())!;
      const intro = await textBox(page, "Intro");
      const spot = overlap(box, { x: intro.left, y: intro.y - 6, width: intro.right - intro.left, height: 12 });
      expect(spot, 'the bubble covers "Intro"').not.toBeNull();

      const bold = await pointOn(bubbleButton(page, "Bold"));
      await watchPresses(page);
      await page.mouse.click(bold.x, bold.y);
      await page.keyboard.press("ArrowRight");
      // The gap is the subject: the arrow has collapsed the selection and the bubble is gone.
      await page.waitForTimeout(150);
      await page.mouse.click(spot!.x, spot!.y);

      await expect.poll(() => caretPlace(page), { message: "the click puts the caret in the text" }).toMatch(/^Intro text\. @\d+ caret$/);
      expect((await presses(page)).map((press) => press.on)).toEqual(["bubble", "preview"]);
      await expectTarget(page, size.layout, "strong", "Bold was applied once");
      await context.close();
    });
  }

  test("the table menu's Row below, Escape, and a click on the text where the menu was", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

    await clickCell(page, 1, 0);
    const menu = page.getByTestId("table-menu");
    const after = await textBox(page, "After");
    const spot = overlap((await menu.boundingBox())!, { x: after.left, y: after.y - 6, width: after.right - after.left, height: 12 });
    expect(spot, 'the table menu covers "After"').not.toBeNull();

    const rowBelow = await pointOn(page.getByTestId("table-row-after"));
    await watchPresses(page);
    await page.mouse.click(rowBelow.x, rowBelow.y);
    await expectTableShape(page, 3, 2);
    await page.keyboard.press("Escape");
    // The gap is the subject: Escape has hidden the menu.
    await page.waitForTimeout(150);
    await page.mouse.click(spot!.x, spot!.y);

    await expect.poll(() => caretPlace(page), { message: "the click puts the caret in the text" }).toMatch(/^After text\. @\d+ caret$/);
    expect((await presses(page)).map((press) => press.on)).toEqual(["table menu", "preview"]);
    await expectTableShape(page, 3, 2);
    await context.close();
  });

  test("the box is gone 600 ms after the click that put it up, also when a click landed on it in between", async ({ browser }) => {
    const id = await newDocument(browser, {}, TABLE_DOC.replace("After text.", UNDER_MENU));
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 4, 4);

    // Delete table takes the menu away; the long line above the table is under its place.
    for (let attempt = 1; ; attempt++) {
      await clickCell(page, 1, 0);
      const point = await pointOn(page.getByTestId("table-delete"));
      await watchPresses(page);
      await page.mouse.click(point.x, point.y);
      const clicked = Date.now();
      // The gaps are the subject: 400 ms after the first click, and 650 ms after it.
      await page.waitForTimeout(400);
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(Math.max(0, 650 - (Date.now() - clicked)));
      await page.mouse.click(point.x, point.y);

      const seen = await presses(page);
      const [, second, third] = seen.map((press) => press.at - seen[0].at);
      // A machine too busy to place the clicks proves nothing either way: the second has to come well
      // inside the 600 ms, and the third well before a box that started again at the second would have gone.
      if ((second >= 550 || third >= second + 550) && attempt < 3) {
        await page.keyboard.press("Control+z");
        await expect(page.locator(".md-rich table")).toHaveCount(1);
        continue;
      }
      expect(second, "the second click came inside the 600 ms").toBeLessThan(600);
      expect(third, "the third click came after them").toBeGreaterThanOrEqual(600);
      expect(third, "the third click came before 600 ms after the second").toBeLessThan(second + 600);
      expect(seen.map((press) => press.on), "the second click lands on the box, the third on the text under it").toEqual(["table menu", "box", "preview"]);
      break;
    }
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    // The delete leaves the caret at the end of that line; the third click put it inside the line.
    const caret = await caretPlace(page);
    expect(caret).toMatch(new RegExp(`^${UNDER_MENU.replace(".", "\\.")} @\\d+ caret$`));
    expect(Number(/@(\d+)/.exec(caret)![1]), "the caret is where the third click was").toBeLessThan(UNDER_MENU.length);
    await context.close();
  });

  test("390 px: typing goes to the composer after the bubble's Comment while the box may still be over the sheet", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "rich", { viewport: { width: 390, height: 844 } });

    await dragSelect(page, "Target");
    const comment = await pointOn(bubbleButton(page, "Comment"));
    await page.mouse.click(comment.x, comment.y);
    await expect(composer(page)).toBeFocused();
    // The box may still be over part of the sheet: the keyboard is not its business.
    await page.keyboard.type("A note");
    await expect(composer(page)).toHaveValue("A note");
    await expect(placeHold(page)).toHaveCount(0);
    await context.close();
  });

  test("a click on the text after the box has gone takes focus from the composer and changes nothing else", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await dragSelect(page, "Target");
    const comment = await pointOn(bubbleButton(page, "Comment"));
    await page.mouse.click(comment.x, comment.y);
    await expect(composer(page)).toBeFocused();
    await page.keyboard.type("A note");
    await expect(placeHold(page)).toHaveCount(0);
    // The same spot, once the box has gone: it is a click on the document now, as if made on purpose.
    await watchPresses(page);
    await page.mouse.click(comment.x, comment.y);
    await expectFocus(page, "preview", "the click takes focus to the text");
    expect((await presses(page)).map((press) => press.on)).toEqual(["preview"]);
    await expect(page.getByTestId("pending-comment"), "the composer stays open").toHaveCount(1);
    await expect(composer(page), "and keeps what was typed").toHaveValue("A note");
    await expectDocument(page, "Target paragraph.", "nothing was typed or formatted in the document");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await context.close();
  });
});

test.describe("selection bubble: real input", () => {
  test("a click on Bold formats the selection and keeps it; a second click undoes it", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // Right after the selection appeared.
    await dragSelect(page, "Target");
    await bubbleButton(page, "Bold").click();
    await expectTarget(page, "split", "strong", "bubble Bold click");
    expect(await selectedText(page), "the selection is kept after a bubble click").toBe("Target");
    await expectFocus(page, "preview", "focus after a bubble click");
    await bubbleButton(page, "Bold").click();
    await expectTarget(page, "split", "plain", "bubble Bold click again");
    await context.close();
  });

  test("held arrows, Home, End and wrapping move focus; Enter and Space act once and hand focus back", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // The bubble's layer sits at the end of the page and hides when the editor loses focus, so Tab from
    // the editor does not reach it; this case starts on a focused button (the same on main).
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
    await expectFocus(page, "preview", "focus after Enter on bubble Bold");
    await expect(bubble(page)).toBeVisible();
    await pressOn(page, bubbleButton(page, "Italic"), " ");
    await expectTarget(page, "split", "both", "Space on bubble Italic");
    await expectFocus(page, "preview", "focus after Space on bubble Italic");
    await context.close();
  });

  test("Link opens the dialog; Escape hides the bubble and the next selection's first click works", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await dragSelect(page, "After");
    await bubbleButton(page, "Link").click();
    await page.getByTestId("link-url").fill("example.com/docs");
    await page.getByTestId("link-submit").click();
    await expect(page.locator(".md-rich a", { hasText: "After" })).toHaveAttribute("href", "https://example.com/docs");

    // Escape collapses the selection and hides the bubble.
    await dragSelect(page, "Intro");
    await page.keyboard.press("Escape");
    await expect(bubble(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? null)).toBe(true);
    await expectFocus(page, "preview", "focus after Escape");
    await dragSelect(page, "Intro");
    await bubbleButton(page, "Strikethrough").click();
    await expect(page.locator(".md-rich p", { hasText: "Intro" }).locator("s, del")).toHaveText("Intro");
    await context.close();
  });

  test("Tab and Shift+Tab from a bubble button go back to the selection and format nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // The bubble's layer is the last thing in the page, so there is nothing after it to Tab to.
    for (const key of ["Tab", "Shift+Tab"]) {
      await dragSelect(page, "Target");
      await bubbleButton(page, "Italic").focus();
      await expect(bubbleButton(page, "Italic")).toBeFocused();
      await page.keyboard.press(key);
      await expectFocus(page, "preview", `${key} goes back to the editor`);
      expect(await selectedText(page), `${key} keeps the selection`).toBe("Target");
      await expect(bubble(page), `${key} keeps the bubble`).toBeVisible();
      await expectDocument(page, "Target paragraph.", `${key} formats nothing`);
    }
    await context.close();
  });
});

test.describe("table menu: real input", () => {
  /** The delimiter row of the table: it carries the column alignment. */
  const delimiter = async (page: Page) => (await codeText(page)).split("\n").find((line) => /^\|\s*:?-+/.test(line)) ?? "";

  test("every row and column action by click, on the table the caret is in; Delete table", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

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
      await expectFocus(page, "preview", `focus after ${testId}`);
    }

    await clickCell(page, 1, 0);
    await page.getByTestId("table-delete").click();
    await expect(page.locator(".md-rich table")).toHaveCount(0);
    await expectFocus(page, "preview", "focus after Delete table");
    await context.close();
  });

  test("alignment: three clicks in a row on the same column", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // Each click lands on the re-render the one before it caused.
    await clickCell(page, 1, 1);
    await page.getByTestId("table-align-center").click();
    await expect.poll(() => delimiter(page), { message: "center" }).toMatch(/^\|[^|]*\|\s*:-+:\s*\|/);
    await expect(page.getByTestId("table-align-center")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("table-align-right").click();
    await expect.poll(() => delimiter(page), { message: "right" }).toMatch(/^\|[^|]*\|\s*-+:\s*\|/);
    await page.getByTestId("table-align-right").click();
    await expect.poll(() => delimiter(page), { message: "right again clears it" }).toMatch(/^\|[^|]*\|\s*-+\s*\|/);
    await expectFocus(page, "preview", "focus after the alignment clicks");
    await context.close();
  });

  test("alignment acts on the column the caret is in when the click lands", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    await clickCell(page, 1, 1);
    await page.getByTestId("table-align-center").click();
    await expect.poll(() => delimiter(page)).toMatch(/^\|\s*-+\s*\|\s*:-+:\s*\|/);
    // The caret moves from the first column, which is not aligned, to the centred one with a key, and
    // the click follows at once: Align center clears the centred column.
    await clickCell(page, 1, 0);
    await page.keyboard.press("Tab");
    await page.getByTestId("table-align-center").click();
    await expect.poll(() => delimiter(page), { message: "Align center on the centred column clears it" }).toMatch(/^\|\s*-+\s*\|\s*-+\s*\|/);
    await context.close();
  });

  test("Shift+Tab from the first cell reaches the menu; held arrows, Home, End and wrapping; Enter and Space", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

    // A keyboard user reaches the menu with Shift+Tab from the first cell (from any other cell Shift+Tab
    // moves to the previous cell). The menu sits just before the editor, so focus lands on its last
    // button. Each action hands focus back to the editor.
    const menu = page.getByTestId("table-menu");
    await clickCell(page, 0, 0);
    await tabInto(page, menu, "Shift+Tab", 3);
    await expect(page.getByTestId("table-delete"), "Shift+Tab from the first cell lands on the last button").toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.getByTestId("table-row-before"), "Home").toBeFocused();
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
    await expectTableShape(page, 3, 2);
    await expectFocus(page, "preview", "focus after Enter on Row below");
    await clickCell(page, 0, 0);
    await tabInto(page, menu, "Shift+Tab", 3);
    await page.keyboard.press("Home");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("table-col-after")).toBeFocused();
    await page.keyboard.press(" ");
    await expectTableShape(page, 3, 3);
    await expectFocus(page, "preview", "focus after Space on Column right");
    await context.close();
  });

  test("Tab and Shift+Tab in the menu move focus and run nothing", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

    await clickCell(page, 0, 0);
    await tabInto(page, page.getByTestId("table-menu"), "Shift+Tab", 3);
    await expect(page.getByTestId("table-delete")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("table-align-right"), "Shift+Tab moves to the button before").toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("table-delete"), "Tab moves to the button after").toBeFocused();
    await page.keyboard.press("Tab");
    await expectFocus(page, "preview", "Tab from the last button goes on to the editor");
    await expectTableShape(page, 2, 2);
    expect(await codeText(page), "nothing ran").toBe(DOC);
    await context.close();
  });

  test("Escape hides the menu; the first click after it comes back acts on the current table", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");
    await expectTableShape(page, 2, 2);

    await clickCell(page, 1, 0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    await expectFocus(page, "preview", "focus after Escape");
    await clickCell(page, 1, 1);
    await page.getByTestId("table-row-after").click();
    await expectTableShape(page, 3, 2);
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
    let title = "Title";
    const remoteEdit = async (suffix: string) => {
      await bob.page.locator(".cm-content").click();
      await bob.page.keyboard.press("Control+Home");
      await bob.page.keyboard.press("End");
      await bob.page.keyboard.type(suffix);
      title += suffix;
      await expect(alice.page.locator(".md-rich h1")).toContainText(title);
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

  test("a remote edit between the press and the release of a click: the action applies to the selection as it is now", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, { editor: true });
    const alice = await openAs(browser, "owner", id, "split");
    const bob = await openAs(browser, "editor", id, "split");

    let title = "Title";
    const remoteEdit = async (suffix: string) => {
      await bob.page.locator(".cm-content").click();
      await bob.page.keyboard.press("Control+Home");
      await bob.page.keyboard.press("End");
      await bob.page.keyboard.type(suffix);
      title += suffix;
      await expect(alice.page.locator(".md-rich h1")).toContainText(title);
    };
    /** Press on `control`, let Bob's edit arrive and re-render the page, then release. */
    const clickAround = async (control: Locator, suffix: string) => {
      const point = await pointOn(control);
      await alice.page.mouse.move(point.x, point.y);
      await alice.page.mouse.down();
      await remoteEdit(suffix);
      await alice.page.mouse.up();
    };

    await dragSelect(alice.page, "Target");
    await clickAround(toolButton(alice.page, "Bold"), " one");
    await expectTarget(alice.page, "split", "strong", "toolbar Bold around a remote edit");

    await dragSelect(alice.page, "After");
    await clickAround(bubbleButton(alice.page, "Italic"), " two");
    await expect(alice.page.locator(".md-rich p", { hasText: "After" }).locator("em")).toHaveText("After");

    await clickCell(alice.page, 1, 0);
    await clickAround(alice.page.getByTestId("table-row-after"), " three");
    await expectTableShape(alice.page, 3, 2);
    await expect.poll(() => codeText(alice.page), { message: "only those three edits and Bob's typing" }).toBe(
      ["# Title one two three", "", "Intro text.", "", "**Target** paragraph.", "", "*After* text.", "", "| a   | b   |", "| --- | --- |", "| 1   | 2   |", "|     |     |", ""].join("\n"),
    );

    await alice.context.close();
    await bob.context.close();
  });

  test("a selection made with keys and a click right behind it", async ({ browser }) => {
    const id = await newDocument(browser);
    const { page, context } = await openAs(browser, "owner", id, "split");

    // The click comes right behind the last key: the button acts on the selection the keys made. How many
    // of the keys count is the editor's business (it settles its own selection for a moment after the
    // click that placed the caret), so the selection is read, not assumed.
    await caretAtTargetEnd(page);
    for (let i = 0; i < "paragraph.".length; i++) await page.keyboard.press("Shift+ArrowLeft");
    const made = await selectedText(page);
    await toolButton(page, "Bold").click();
    expect(made, "the keys selected the end of the line").toMatch(/^\S+\.$/);
    await expect(targetBlock(page).locator("strong"), "toolbar Bold on the selection the keys made").toHaveText(made);
    expect(await selectedText(page), "the selection is kept").toBe(made);

    // Keys only, no click before them: Home, then the first word.
    await page.keyboard.press("Home");
    for (let i = 0; i < "Target".length; i++) await page.keyboard.press("Shift+ArrowRight");
    await bubbleButton(page, "Italic").click();
    await expect(targetBlock(page).locator("em"), "bubble Italic on the selection the keys made").toHaveText("Target");
    await expect(targetBlock(page).locator("strong")).toHaveText(made);
    await context.close();
  });
});

test.describe("permissions with real input", () => {
  test("viewer: every toolbar button is disabled, no Comment button, no bubble, no table menu", async ({ browser }) => {
    const id = await newDocument(browser, { viewer: true });
    const { page, context } = await openAs(browser, "viewer", id, "split");

    const buttons = toolbar(page).getByRole("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(10);
    for (let i = 0; i < count; i++) await expect(buttons.nth(i)).toBeDisabled();
    await expect(page.getByTestId("tb-comment")).toHaveCount(0);

    await dragSelect(page, "Target", { expectBubble: false });
    await frames(page);
    await expect(bubble(page)).toHaveCount(0);
    await page.locator(".md-rich table tr").nth(1).locator("td").first().click();
    await frames(page);
    await expect(page.getByTestId("table-menu")).toHaveCount(0);
    // A click on a disabled button changes nothing.
    await page.getByTestId("tb-bold").click({ force: true });
    expect(await codeText(page)).toBe(DOC);
    await context.close();
  });

  test("commenter: format buttons disabled; the bubble's Comment and the toolbar's Comment open the composer", async ({ browser }) => {
    test.setTimeout(180_000);
    const id = await newDocument(browser, { commenter: true });
    const { page, context } = await openAs(browser, "commenter", id, "split");

    for (const name of ["Bold", "Italic", "Strikethrough", "Link", "Inline code", "Bulleted list", "Horizontal rule", "Undo", "Redo"]) {
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
