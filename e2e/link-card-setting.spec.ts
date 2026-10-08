import AxeBuilder from "@axe-core/playwright";
import { devices, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, openDocument, reloadHydrated, setTheme, shareWith, signIn, uniqueLogin, waitForHydration } from "./helpers";
import { expectFrameLoaded, expectOnlyCardFrames, openFromDashboard, pasteInRich, standInForOtherSites, TWEET, TWEET_FRAME, VIDEO, VIDEO_FRAME } from "./link-card-helpers";

/**
 * Link cards (#2317): the setting on the Settings page, and Insert → "Video or post from a link".
 *
 * No test here touches the network (see e2e/link-card-helpers.ts): a card's frame is answered by a local
 * stand-in page, and every other request that leaves the app is refused and written down.
 */
const KEY = "markdoc:linkCards";
const cards = (page: Page) => page.locator('.md-rich [data-testid="link-card"]');
const toggle = (page: Page) => page.getByRole("switch", { name: "Turn links to known sites into cards" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Video or post from a link" });
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

/** The Settings page, once React answers: a key or a click before that is dropped. */
async function openSettings(page: Page) {
  await page.goto("/settings");
  await waitForHydration(page);
}

/** Put the caret on a new empty line at the end of the preview. */
async function newLineAtEnd(page: Page) {
  await page.locator(".md-rich > *").last().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
}

async function scan(page: Page, include: string, state: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = [...results.violations, ...(await new AxeBuilder({ page }).include(include).withRules(["target-size"]).analyze()).violations];
  const lines = violations.map((v) => `  ${v.id} [${v.impact ?? "n/a"}] ${v.help}\n${v.nodes.slice(0, 5).map((n) => `      ${n.target.join(" ")}`).join("\n")}`);
  expect(violations, `${state}\n${lines.join("\n")}`).toHaveLength(0);
}

test.describe("link cards: the setting and Insert (#2317)", () => {
  test("the switch is on by default, is kept by this browser, and decides what a pasted or typed link becomes", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-setting"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro", "Setting");

    // On by default, and nothing is stored until the person chooses.
    await openSettings(page);
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    expect(await stored(page)).toBeNull();
    await expect(page.getByTestId("link-cards-description")).toHaveText(
      "A link to YouTube or X that you paste or type on its own line becomes a card that shows the video or post. Off: it stays a link. Cards already in a document stay, and Insert can still add one. The choice is saved in this browser.",
    );
    // The row sits right under Theme.
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="theme-row"], [data-testid="link-cards-row"]'), (row) => row.getAttribute("data-testid")));
    expect(order).toEqual(["theme-row", "link-cards-row"]);

    // On: a pasted link is a card, and so is a typed one when Enter leaves its line.
    await openDocument(page, id);
    await newLineAtEnd(page);
    await pasteInRich(page, TWEET);
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${TWEET}`);
    await page.keyboard.type(VIDEO, { delay: 2 });
    await expect(cards(page)).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(() => codeText(page)).toContain(`${TWEET}\n\n${VIDEO}`);
    // The caret is on the new line: typing goes on under the card.
    await page.keyboard.type("After");
    await expect.poll(() => codeText(page)).toContain(`${VIDEO}\n\nAfter`);
    // Undo the word, then the card: the link is text again, in angle brackets. Redo brings both back.
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain(`<${VIDEO}>`);
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+Shift+z");
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${TWEET}\n\n${VIDEO}\n\nAfter`);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    // Off, with the keyboard, and kept across a reload.
    await openSettings(page);
    await toggle(page).focus();
    await page.keyboard.press("Space");
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    expect(await stored(page)).toBe("off");
    await reloadHydrated(page);
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");

    // Off: the cards that are in the document stay cards; a new pasted or typed link stays a link.
    await openDocument(page, id);
    await expect(cards(page)).toHaveCount(2);
    await newLineAtEnd(page);
    await pasteInRich(page, "https://x.com/jack/status/21");
    await expect.poll(() => codeText(page)).toContain("<https://x.com/jack/status/21>");
    await page.keyboard.press("Enter");
    await page.keyboard.type("https://youtu.be/dQw4w9WgXcQ", { delay: 2 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("End");
    await expect.poll(() => codeText(page)).toContain("<https://youtu.be/dQw4w9WgXcQ>\n\nEnd");
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('.md-rich p a[href="https://x.com/jack/status/21"]')).toBeVisible();

    // On again with a click.
    await openSettings(page);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    expect(await stored(page)).toBe("on");

    expect(sites.refused).toEqual([]);
  });

  test("Insert: the toolbar and the palette open the dialog; a good link becomes a card, also with the setting off and from the Markdown pane", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-insert"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    await page.evaluate((key) => localStorage.setItem(key, "off"), KEY);
    const id = await createDocument(page, "Intro", "Insert");
    await openDocument(page, id);

    // The toolbar button, next to Image. On an empty line the card takes that line.
    const button = page.getByTestId("tb-card");
    await expect(button).toHaveAccessibleName("Video or post from a link");
    await newLineAtEnd(page);
    await button.click();
    await expect(dialog(page)).toBeVisible();
    const field = dialog(page).getByRole("textbox", { name: "Link" });
    await expect(field).toBeFocused();
    await expect.poll(() => codeText(page)).toBe("Intro");

    // A link that is not on the list is refused in words, and the dialog stays.
    await page.keyboard.type("https://x.com.evil.example/jack/status/20");
    await page.keyboard.press("Enter");
    await expect(dialog(page).getByRole("alert")).toHaveText("Markdoc cannot show this link as a card. Use the link to one video or post on YouTube or X, starting with https://.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(cards(page)).toHaveCount(0);

    await field.fill(VIDEO);
    await expect(dialog(page).getByRole("alert")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toHaveCount(0);
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${VIDEO}`);
    // Focus is back in the editor, under the card.
    await expect(page.locator(".md-rich")).toBeFocused();
    await page.keyboard.type("Under the video");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${VIDEO}\n\nUnder the video`);

    // With the caret in a paragraph that has text, the card goes under it.
    await button.click();
    await dialog(page).getByRole("textbox", { name: "Link" }).fill(TWEET);
    await dialog(page).getByRole("button", { name: "Insert" }).click();
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${VIDEO}\n\nUnder the video\n\n${TWEET}`);
    // One undo takes that card away and nothing else.
    await page.keyboard.press("Control+z");
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain("Under the video");
    await page.keyboard.press("Control+Shift+z");
    await expect(cards(page)).toHaveCount(2);

    // The palette; Escape and Cancel insert nothing.
    await page.keyboard.press("Control+Shift+P");
    await page.getByTestId("palette-input").fill("Video or post");
    await page.getByTestId("palette-item-block:card").click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("textbox", { name: "Link" }).fill("https://youtu.be/dQw4w9WgXcQ");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await button.click();
    await dialog(page).getByRole("textbox", { name: "Link" }).fill("https://youtu.be/dQw4w9WgXcQ");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(cards(page)).toHaveCount(2);

    // From the Markdown pane the link is written on a line of its own, which is the card.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await button.click();
    await dialog(page).getByRole("textbox", { name: "Link" }).fill("https://youtu.be/dQw4w9WgXcQ");
    await page.keyboard.press("Enter");
    await expect(cards(page)).toHaveCount(3);
    await expect.poll(() => codeText(page)).toContain("https://youtu.be/dQw4w9WgXcQ\n\nIntro");

    await expectOnlyCardFrames(page, ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", VIDEO_FRAME, TWEET_FRAME]);
    expect(sites.refused).toEqual([]);
  });

  test("reached by a click from the dashboard (no page load): a pasted card and an inserted card both load their frames", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-from-dashboard"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, `Intro\n\n${VIDEO}\n\nOutro`, "From the dashboard");

    await openFromDashboard(page, id);
    // The card that was in the document shows its frame, and the frame's page really loaded.
    await expect(cards(page)).toHaveCount(1);
    await expectFrameLoaded(page, ".md-rich", VIDEO_FRAME);

    // A card pasted here (the setting is on) loads its frame too.
    await newLineAtEnd(page);
    await pasteInRich(page, TWEET);
    await expect(cards(page)).toHaveCount(2);
    await expectFrameLoaded(page, ".md-rich", TWEET_FRAME);

    // And one added with Insert.
    await page.getByTestId("tb-card").click();
    await dialog(page).getByRole("textbox", { name: "Link" }).fill("https://youtu.be/jNQXAC9IVRw");
    await page.keyboard.press("Enter");
    await expect(cards(page)).toHaveCount(3);
    await expectFrameLoaded(page, ".md-rich", "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw");

    // The browser refused no frame on this page.
    expect(sites.refused).toEqual([]);
    expect(new Set(sites.frames)).toEqual(new Set([VIDEO_FRAME, TWEET_FRAME, "https://www.youtube-nocookie.com/embed/jNQXAC9IVRw"]));
  });

  // Picking the item (Enter or a click) is not in this test. On the dev server the pick of a slash item does not
  // work in e2e today, with or without this change (`e2e/slash.spec.ts` has 4 failures on main for it). What the
  // pick does is tested with the real menu component in `slash-menu.test.tsx` (the item hands off to the dialog,
  // once) and with the real editor in `prosemirror/link-cards.test.ts` (the card takes the empty line).
  test("the slash menu offers it: /video, /youtube, /tweet, /post and /embed find it, and /link still offers Link first", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-slash"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro", "Slash");
    await openDocument(page, id);

    await newLineAtEnd(page);
    await page.keyboard.type("/video");
    const item = page.getByTestId("slash-item-card");
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("aria-selected", "true");
    await expect(item).toContainText("Video or post from a link");
    await expect(item).toContainText("Paste a link and it becomes a card");
    // Other words people would try.
    for (const word of ["youtube", "tweet", "post", "embed"]) {
      for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace");
      await page.keyboard.type(`/${word}`);
      await expect(item, word).toBeVisible();
    }
    // "/link" still offers Link first.
    for (let i = 0; i < 12; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("/link");
    await expect(page.getByTestId("slash-item-link")).toHaveAttribute("aria-selected", "true");
    await expect(item).toBeVisible();
    for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("/video");
    await expect(item).toHaveAttribute("aria-selected", "true");
    // In a table cell a card cannot stand, so the menu does not offer it there (unit: slash-items.test.ts).
    await expect(cards(page)).toHaveCount(0);
    expect(sites.refused).toEqual([]);
  });

  test("someone who cannot edit is not offered Insert", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("cards-insert-owner"));
    const viewer = await signIn(browser, uniqueLogin("cards-insert-viewer"));
    const sites = await standInForOtherSites(viewer.context, baseURL!);
    const id = await createDocument(owner.page, `Intro\n\n${VIDEO}\n`, "Insert roles");
    await shareWith(owner.page, id, viewer.login, "viewer");
    await openDocument(viewer.page, id);
    await expect(cards(viewer.page)).toHaveCount(1);
    await expect(viewer.page.getByTestId("tb-card")).toBeDisabled();
    await viewer.page.keyboard.press("Control+Shift+P");
    await viewer.page.getByTestId("palette-input").fill("Video or post");
    await expect(viewer.page.getByTestId("palette-item-block:card")).toHaveCount(0);
    expect(sites.refused).toEqual([]);
  });

  test("accessibility: axe on Settings and on the open dialog, light and dark; the switch at phone width", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-setting-a11y"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro", "Accessible insert");

    for (const theme of ["light", "dark"] as const) {
      await openSettings(page);
      await setTheme(page, theme);
      await expect(toggle(page)).toBeVisible();
      await scan(page, '[data-testid="link-cards-row"]', `Settings, ${theme}, on`);
      await toggle(page).click();
      await scan(page, '[data-testid="link-cards-row"]', `Settings, ${theme}, off`);
      await toggle(page).click();

      await openDocument(page, id);
      await page.getByTestId("tb-card").click();
      await expect(dialog(page)).toBeVisible();
      await scan(page, '[role="dialog"]', `dialog, ${theme}`);
      await page.keyboard.press("Enter");
      await expect(dialog(page).getByRole("alert")).toHaveText("Paste a link first.");
      await scan(page, '[role="dialog"]', `dialog with its message, ${theme}`);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    }

    // A phone: the switch on Settings is fully on screen and the page does not scroll sideways.
    const phone = await browser.newContext({ ...devices["iPhone 13"], storageState: await user.context.storageState() });
    const phoneSites = await standInForOtherSites(phone, baseURL!);
    const small = await phone.newPage();
    await openSettings(small);
    const box = await toggle(small).boundingBox();
    const width = await small.evaluate(() => document.documentElement.clientWidth);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await small.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await phone.close();

    expect(sites.refused).toEqual([]);
    expect(phoneSites.refused).toEqual([]);
  });
});
