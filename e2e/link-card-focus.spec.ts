import AxeBuilder from "@axe-core/playwright";
import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, devLogin, focusCodeEnd, focusRichEnd, openDocument, setTheme, shareWith, signIn, uniqueLogin } from "./helpers";
import { TWEET, TWEET_FRAME, VIDEO, VIDEO_FRAME } from "./link-card-helpers";
import { frameCounts, keyboardPlace, openByDashboardClick, standInWithKeyboard, takeFocusOnce } from "./link-card-focus-helpers";

/**
 * The focus guard of link cards (#2338). A provider's embed page can take the keyboard by its own script.
 * These tests put a stand-in page into the frame that does exactly that (e2e/link-card-focus-helpers.ts),
 * and a quiet one that behaves like a real player. No test touches the network.
 */
const DOC = `# Guard\n\nFirst paragraph\n\n${TWEET}\n\nBetween\n\n${VIDEO}\n\nLast paragraph\n`;
const TURNED_OFF = "This card kept taking the keyboard away from your document, so it was turned off.";

const cards = (page: Page) => page.locator('.md-rich [data-testid="link-card"]');
const frame = (page: Page, url: string, scope = ".md-rich") => page.locator(`${scope} iframe[src="${url}"]`);
const notice = (page: Page) => page.locator('.md-rich [data-testid="link-card-off"]');
const status = (page: Page) => page.locator("[data-card-focus-status]");
const ringed = (page: Page, scope = ".md-rich") => page.locator(`${scope} .md-link-card-frame[data-has-keyboard] iframe`);
const coverFor = (page: Page, url: string, scope = ".md-rich") => page.locator(`${scope} .md-link-card-frame:has(iframe[src="${url}"]) [data-card-cover]`);
/** The frame's stand-in has run its script (it shows its counts). */
const frameReady = (page: Page, url: string, scope = ".md-rich") => expect(page.frameLocator(`${scope} iframe[src="${url}"]`).locator("#counts")).toContainText("keys", { timeout: 30_000 });
const letters = (text: string, wanted: string) => Array.from(text).filter((character) => wanted.includes(character)).join("");
/** A person on a device with a touch screen (emulated: Chromium sends touch events, there is no real finger). */
async function signInWithTouch(browser: Browser, login: string) {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await devLogin(page, login);
  await page.waitForLoadState("networkidle");
  return { context, page, login };
}
/** Where the page is scrolled to and where the caret is: a tap in a player must change neither. */
const scrollAndCaret = (page: Page) =>
  page.evaluate(() => {
    const selection = getSelection();
    return {
      scrolled: [`window ${Math.round(scrollY)}`, ...Array.from(document.querySelectorAll("*")).filter((element) => element.scrollTop > 0).map((element) => `${element.tagName}.${element.className} ${Math.round(element.scrollTop)}`)],
      caret: selection ? `${selection.anchorNode?.textContent ?? ""} @${selection.anchorOffset}-${selection.focusOffset}` : "none",
    };
  });

test.describe("link cards: the keyboard stays with the person (#2338)", () => {
  test("a frame that takes the keyboard by itself does not keep it: typing arrives in the document in both panes, the frame is turned off after three tries, and it can be loaded again", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard"));
    // The post's frame takes the keyboard five times a second. The video's frame is quiet.
    const sites = await standInWithKeyboard(context, baseURL!, (url) => (url === TWEET_FRAME ? 200 : 0));
    const id = await createDocument(page, DOC, "Guard");
    // The way people mostly open a document: from the dashboard, with no page load.
    await openByDashboardClick(page, id);
    await expect(cards(page)).toHaveCount(2);
    await frameReady(page, TWEET_FRAME);
    await frameReady(page, VIDEO_FRAME);

    // The person types at the end of the preview, 60 ms between keys, while the frame keeps trying.
    await focusRichEnd(page);
    const typed = "abcdefghijklmnopqrstuvwxyz0123";
    await page.keyboard.type(typed, { delay: 60 });
    // Three tries, then the frame is gone and its card says why.
    await expect(notice(page)).toHaveCount(1);
    await expect(notice(page)).toContainText(TURNED_OFF);
    await expect(frame(page, TWEET_FRAME)).toHaveCount(0);
    // Said once for a screen reader, in the page's polite live region.
    await expect(status(page)).toHaveAttribute("aria-live", "polite");
    await expect(status(page)).toHaveText(TURNED_OFF);
    // The keyboard is where the person was, and what was typed is in the document, in order.
    expect(await keyboardPlace(page)).toBe("preview");
    const inDocument = letters((await codeText(page)).split("Last paragraph")[1] ?? "", typed);
    const inFrame = sites.keys.join("");
    expect(typed.startsWith(inDocument) || inDocument.length > 0, `in the document: ${inDocument}`).toBe(true);
    expect(inDocument.length + inFrame.length, `document "${inDocument}", frame "${inFrame}"`).toBe(typed.length);
    // The frame had three tries. Each can catch only the keys typed before the page has answered.
    expect(inFrame.length, `keys that reached the frame: "${inFrame}"`).toBeLessThanOrEqual(3);
    // The quiet frame beside it was left alone.
    await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);
    expect((await frameCounts(page, ".md-rich", VIDEO_FRAME)).keys).toBe(0);
    // With the frame gone, every key arrives.
    await page.keyboard.type("MORE", { delay: 60 });
    expect(await codeText(page)).toContain("MORE");
    expect(sites.keys.join("")).toBe(inFrame);

    // "Load it again" brings the frame back, with three new tries. This time the person is in the Markdown pane.
    const before = sites.frames.filter((url) => url === TWEET_FRAME).length;
    await focusCodeEnd(page);
    await notice(page).getByRole("button", { name: "Load it again" }).click();
    await expect(frame(page, TWEET_FRAME)).toHaveCount(1);
    await expect(notice(page)).toHaveCount(0);
    await frameReady(page, TWEET_FRAME);
    expect(sites.frames.filter((url) => url === TWEET_FRAME)).toHaveLength(before + 1);
    await focusCodeEnd(page);
    const caught = sites.keys.length;
    const second = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await page.keyboard.type(second, { delay: 60 });
    await expect(notice(page)).toHaveCount(1);
    expect(await keyboardPlace(page)).toBe("markdown");
    const secondInDocument = letters((await codeText(page)).split("MORE")[1] ?? "", second);
    const secondInFrame = sites.keys.slice(caught).join("");
    expect(secondInDocument.length + secondInFrame.length, `document "${secondInDocument}", frame "${secondInFrame}"`).toBe(second.length);
    expect(secondInFrame.length, `keys that reached the frame: "${secondInFrame}"`).toBeLessThanOrEqual(3);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("a quiet frame: the first pointer press activates the exact frame, the second reaches it, and Tab enters directly", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard-quiet"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Quiet");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const play = page.frameLocator(`.md-rich iframe[src="${VIDEO_FRAME}"]`).locator("#play");
    const inFrame = () => frameCounts(page, ".md-rich", VIDEO_FRAME);

    // The first mouse press is consumed by the parent-owned cover. It gives this frame the keyboard but
    // does not click the provider. The second press reaches the provider.
    await focusRichEnd(page);
    await page.keyboard.type("one");
    await coverFor(page, VIDEO_FRAME).click();
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    expect(await inFrame()).toMatchObject({ clicks: 0, text: "" });
    await play.click();
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    // The card shows where the keyboard is.
    await expect(ringed(page)).toHaveCount(1);
    await expect(ringed(page)).toHaveAttribute("src", VIDEO_FRAME);
    const outline = await page.locator(".md-rich .md-link-card-frame[data-has-keyboard]").evaluate((box) => getComputedStyle(box).outlineStyle + " " + getComputedStyle(box).outlineWidth);
    expect(outline).toBe("solid 2px");
    // Keys go to the frame now, as the person wants (a player's own shortcuts), and stay there.
    await page.keyboard.type("kkk", { delay: 60 });
    expect(await inFrame()).toMatchObject({ clicks: 1, text: "kkk" });
    expect(await keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    expect(await codeText(page)).not.toContain("kkk");
    await expect(notice(page)).toHaveCount(0);

    // A click back into the document: the ring goes, typing arrives.
    await focusRichEnd(page);
    await expect(ringed(page)).toHaveCount(0);
    await page.keyboard.type("two");
    expect(await codeText(page)).toContain("onetwo");

    // Returning to the document restores the cover. The first press is again the security activation cost.
    await expect(coverFor(page, VIDEO_FRAME)).toHaveCount(1);
    await coverFor(page, VIDEO_FRAME).click();
    expect((await inFrame()).clicks).toBe(1);
    await play.click();
    await expect.poll(async () => (await inFrame()).clicks).toBe(2);
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);

    // Tab reaches the parent-owned cover at the frame's exact place and enters it immediately.
    await focusRichEnd(page);
    await page.locator('.md-rich [data-provider="youtube"] [data-testid="link-card-as-text"]').focus();
    await page.keyboard.press("Tab");
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(ringed(page)).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(await keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(notice(page)).toHaveCount(0);

    // Shift+Tab from the next parent-owned control enters the same exact frame.
    await focusRichEnd(page);
    await page.evaluate(() => {
      const box = document.querySelector('.md-rich [data-provider="youtube"] .md-link-card-frame')!;
      const after = document.createElement("button");
      after.type = "button";
      after.dataset.testid = "after-video-frame";
      after.textContent = "After video";
      box.append(after);
    });
    await page.getByTestId("after-video-frame").focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("hostile no-click focus is rejected before and after quiet time; mouse and pen require the frame's cover", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard-cover"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Cover");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const inFrame = () => frameCounts(page, ".md-rich", VIDEO_FRAME);

    await focusRichEnd(page);
    const box = (await frame(page, VIDEO_FRAME).boundingBox())!;
    // Hover and pointer movement never remove the cover or authorize the provider, even after one second.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 12, { steps: 4 });
    await expect(coverFor(page, VIDEO_FRAME)).toHaveCount(1);
    await page.keyboard.type("a");
    await page.waitForTimeout(1200);
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(async () => (await inFrame()).grabs).toBe(1);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.keyboard.type("b");
    expect(await codeText(page)).toContain("Last paragraphab");
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height - 16, { steps: 2 });
    await expect(coverFor(page, VIDEO_FRAME)).toHaveCount(1);
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");

    // A mouse press on the exact cover is consumed and authorizes only this frame.
    await coverFor(page, VIDEO_FRAME).click();
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(coverFor(page, VIDEO_FRAME)).toHaveCount(0);
    await expect(ringed(page)).toHaveCount(1);
    expect((await inFrame()).clicks).toBe(0);
    await focusRichEnd(page);

    // Pen follows the same explicit rule and cannot borrow the earlier mouse activation.
    await coverFor(page, VIDEO_FRAME).dispatchEvent("pointerdown", { pointerType: "pen", bubbles: true, cancelable: true });
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    expect((await inFrame()).clicks).toBe(0);
    await expect(notice(page)).toHaveCount(0);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("the caret is back where it was, in both panes, while someone else edits the same paragraph", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("guard-owner"));
    const sites = await standInWithKeyboard(owner.context, baseURL!);
    const other = await signIn(browser, uniqueLogin("guard-other"));
    const otherSites = await standInWithKeyboard(other.context, baseURL!);
    const { page } = owner;
    const id = await createDocument(page, `# Caret\n\n${TWEET}\n\nalpha omega`, "Caret");
    await shareWith(page, id, other.login, "editor");
    await openDocument(page, id);
    await openDocument(other.page, id);
    await frameReady(page, TWEET_FRAME);

    // The preview: the owner's caret is in the middle of the paragraph.
    await focusRichEnd(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("1");
    await expect.poll(() => codeText(other.page)).toContain("alpha1 omega");
    // The other person types at the start of that paragraph, and keeps typing while the frame takes the keyboard.
    await other.page.locator(".md-rich p", { hasText: "omega" }).click({ position: { x: 2, y: 8 } });
    await other.page.keyboard.press("Home");
    const theirs = other.page.keyboard.type("ZYXWVUTS", { delay: 40 });
    await takeFocusOnce(page, ".md-rich", TWEET_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.keyboard.type("2", { delay: 60 });
    await theirs;
    await expect.poll(() => codeText(page)).toContain("ZYXWVUTSalpha12 omega");
    await expect.poll(() => codeText(other.page)).toContain("ZYXWVUTSalpha12 omega");

    // The Markdown pane, the same way.
    await focusCodeEnd(page);
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("3");
    await expect.poll(() => codeText(other.page)).toContain("alpha123 omega");
    const more = other.page.keyboard.type("RQPO", { delay: 40 });
    await takeFocusOnce(page, ".md-rich", TWEET_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("markdown");
    await page.keyboard.type("4", { delay: 60 });
    await more;
    await expect.poll(() => codeText(page)).toContain("alpha1234 omega");
    await expect.poll(() => codeText(other.page)).toContain("alpha1234 omega");
    // Two tries by now: the frame is still there, and it got no key.
    await expect(frame(page, TWEET_FRAME)).toHaveCount(1);
    expect(await frameCounts(page, ".md-rich", TWEET_FRAME)).toMatchObject({ grabs: 2, keys: 0 });
    expect(sites.refused).toEqual([]);
    expect(otherSites.refused).toEqual([]);
    await owner.context.close();
    await other.context.close();
  });

  test("touch uses the same frame-specific cover: the first tap activates, the second reaches the provider, and no-click focus is rejected", async ({ browser, baseURL }) => {
    const { page, context } = await signInWithTouch(browser, uniqueLogin("guard-touch"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Touch");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const play = page.frameLocator(`.md-rich iframe[src="${VIDEO_FRAME}"]`).locator("#play");
    const inFrame = () => frameCounts(page, ".md-rich", VIDEO_FRAME);
    await play.scrollIntoViewIfNeeded();
    await page.locator(".md-rich p", { hasText: "Last paragraph" }).tap();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("abc", { delay: 60 });
    const before = await scrollAndCaret(page);
    const entry = (await coverFor(page, VIDEO_FRAME).boundingBox())!;
    await page.touchscreen.tap(entry.x + entry.width / 2, entry.y + entry.height / 2);
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    expect(await scrollAndCaret(page)).toEqual(before);
    expect(await inFrame()).toMatchObject({ clicks: 0, keys: 0 });

    const playBox = (await play.boundingBox())!;
    await page.touchscreen.tap(playBox.x + playBox.width / 2, playBox.y + playBox.height / 2);
    await expect.poll(async () => (await inFrame()).clicks).toBe(1);
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);

    // Returning to the document restores the touch cover. Elapsed time does not create a mouse-style fallback.
    await page.locator(".md-rich p", { hasText: "Last paragraph" }).tap();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("d");
    await page.waitForTimeout(1300);
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.keyboard.type("XYZ", { delay: 60 });
    expect(await codeText(page)).toContain("Last paragraphabcdXYZ");
    expect(await inFrame()).toMatchObject({ clicks: 1, keys: 0 });
    await expect(notice(page)).toHaveCount(0);
    expect(sites.keys).toEqual([]);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("a finger: a frame that takes the keyboard never keeps it, also when nobody types, and is turned off as soon as the person types", async ({ browser, baseURL }) => {
    const { page, context } = await signInWithTouch(browser, uniqueLogin("guard-touch-grab"));
    const sites = await standInWithKeyboard(context, baseURL!, (url) => (url === TWEET_FRAME ? 200 : 0));
    const id = await createDocument(page, DOC, "Touch and a frame that grabs");
    await openDocument(page, id);
    await frameReady(page, TWEET_FRAME);
    // The caret goes into the document with a finger and no key is pressed: a key would start the second in which a grab counts.
    await page.locator(".md-rich p", { hasText: "Last paragraph" }).tap();
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    const textBefore = await codeText(page);
    // Nobody types for two seconds. The frame tries five times a second; each time the keyboard comes back.
    const grabsBefore = (await frameCounts(page, ".md-rich", TWEET_FRAME)).grabs;
    let withFrame = 0;
    for (let look = 0; look < 20; look++) {
      await page.waitForTimeout(100);
      if ((await keyboardPlace(page)).startsWith("frame")) withFrame++;
    }
    const idle = await frameCounts(page, ".md-rich", TWEET_FRAME);
    expect(idle.grabs - grabsBefore).toBeGreaterThanOrEqual(5);
    // A look can fall between a grab and the answer one task later; it must not stay there.
    expect(withFrame, "looks that found the keyboard in the frame, of 20").toBeLessThanOrEqual(2);
    // None of those counted: the card is still there.
    await expect(notice(page)).toHaveCount(0);
    await expect(frame(page, TWEET_FRAME)).toHaveCount(1);

    // The person types: now each grab counts, and the third turns the frame off.
    const typed = "abcdefghijklmnopqrstuvwxyz0123";
    await page.keyboard.type(typed, { delay: 60 });
    await expect(notice(page)).toHaveCount(1);
    await expect(frame(page, TWEET_FRAME)).toHaveCount(0);
    expect(await keyboardPlace(page)).toBe("preview");
    const inDocument = (await codeText(page)).length - textBefore.length;
    const inFrame = sites.keys.join("");
    expect(inDocument + inFrame.length, `${inDocument} in the document, frame "${inFrame}"`).toBe(typed.length);
    expect(inFrame.length, `keys that reached the frame: "${inFrame}"`).toBeLessThanOrEqual(3);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("a hybrid device never treats hover as touch or mouse consent; each pointer kind must press the cover", async ({ browser, baseURL }) => {
    const { page, context } = await signInWithTouch(browser, uniqueLogin("guard-hybrid"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Finger and mouse");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const last = page.locator(".md-rich p", { hasText: "Last paragraph" });
    await frame(page, VIDEO_FRAME).scrollIntoViewIfNeeded();
    const frameBox = (await frame(page, VIDEO_FRAME).boundingBox())!;

    await last.tap();
    await page.keyboard.type("a");
    await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height - 12, { steps: 4 });
    await page.waitForTimeout(1200);
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");

    await coverFor(page, VIDEO_FRAME).click();
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(ringed(page)).toHaveCount(1);

    await last.tap();
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    const entry = (await coverFor(page, VIDEO_FRAME).boundingBox())!;
    await page.touchscreen.tap(entry.x + entry.width / 2, entry.y + entry.height / 2);
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(notice(page)).toHaveCount(0);
    expect((await frameCounts(page, ".md-rich", VIDEO_FRAME)).keys).toBe(0);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("a finger: a card that comes after the tap (tap, type, paste a link) is under the finger's rule from its first moment", async ({ browser, baseURL }) => {
    const { page, context } = await signInWithTouch(browser, uniqueLogin("guard-touch-first"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, "# Guard\n\nFirst paragraph\n", "The card comes later");
    await openDocument(page, id);
    await expect(cards(page)).toHaveCount(0);
    // The only press the page ever sees in this test: a finger puts the caret into the document. No card is there yet.
    await page.locator(".md-rich p", { hasText: "First paragraph" }).tap();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.evaluate((value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      document.querySelector(".md-rich")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, VIDEO);
    await expect(cards(page)).toHaveCount(1);
    await frameReady(page, VIDEO_FRAME);
    await page.keyboard.type("abc", { delay: 60 });
    // Four provider-initiated moves after the touch and quiet period are rejected but do not count.
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.waitForTimeout(1300);
      await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
      await expect.poll(() => keyboardPlace(page), { message: `attempt ${attempt}` }).toBe("preview");
      await expect(notice(page)).toHaveCount(0);
    }
    await page.keyboard.type("XYZ", { delay: 60 });
    expect(await codeText(page)).toContain("abcXYZ");
    expect(await frameCounts(page, ".md-rich", VIDEO_FRAME)).toMatchObject({ grabs: 4, clicks: 0, keys: 0 });
    expect(sites.keys).toEqual([]);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("three in a row, or ten in a minute: a frame that takes the keyboard now and then, never twice in a row, is turned off at the tenth time; loaded again it starts from nothing", async ({ browser, baseURL }) => {
    const { page, context } = await signInWithTouch(browser, uniqueLogin("guard-ten"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Ten in a minute");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const last = page.locator(".md-rich p", { hasText: "Last paragraph" });
    const grabs = async () => (await frameCounts(page, ".md-rich", VIDEO_FRAME)).grabs;
    await last.tap();
    await page.keyboard.press("Control+End");
    const started = Date.now();
    for (let n = 1; n <= 10; n++) {
      // Nine are not enough.
      await expect(notice(page)).toHaveCount(0);
      await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);
      // A key, and the frame takes the keyboard a moment later: that move counts.
      await page.keyboard.type("a");
      await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
      if (n === 10) break;
      await expect.poll(grabs).toBe(2 * n - 1);
      await expect.poll(() => keyboardPlace(page)).toBe("preview");
      // More than a second after the key it takes the keyboard again: given back, not counted, and "in a row" starts again.
      await page.waitForTimeout(1100);
      await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
      await expect.poll(grabs).toBe(2 * n);
      await expect.poll(() => keyboardPlace(page)).toBe("preview");
    }
    // The tenth move that counted, inside one minute: the same words and the same button as for three in a row.
    await expect(notice(page)).toHaveCount(1);
    await expect(notice(page)).toContainText(TURNED_OFF);
    await expect(status(page)).toHaveText(TURNED_OFF);
    expect(Date.now() - started, "all ten inside one minute").toBeLessThan(60_000);
    expect(await keyboardPlace(page)).toBe("preview");
    expect(await codeText(page)).toContain("Last paragraphaaaaaaaaaa");
    expect(sites.keys).toEqual([]);

    // Loaded again, the frame starts from nothing: one more such move does not turn it off.
    await notice(page).getByRole("button", { name: "Load it again" }).tap();
    await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);
    await frameReady(page, VIDEO_FRAME);
    await last.tap();
    await page.keyboard.type("b");
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(grabs).toBe(1);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.waitForTimeout(300);
    await expect(notice(page)).toHaveCount(0);
    await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("hostile no-click focus is rejected on the published page and in a viewer's editor", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("guard-pub"));
    const sites = await standInWithKeyboard(owner.context, baseURL!);
    const viewer = await signIn(browser, uniqueLogin("guard-viewer"));
    const viewerSites = await standInWithKeyboard(viewer.context, baseURL!);
    const { page } = owner;
    const id = await createDocument(page, DOC, "Published");
    await shareWith(page, id, viewer.login, "viewer");

    // Pointer presence and a quiet period are not consent, even where the page has no editor.
    await page.goto(`/p/${id}`);
    await frameReady(page, TWEET_FRAME, ".reader-body");
    const publishedFrame = (await frame(page, TWEET_FRAME, ".reader-body").boundingBox())!;
    await page.mouse.move(publishedFrame.x + publishedFrame.width / 2, publishedFrame.y + publishedFrame.height / 2);
    await page.waitForTimeout(1200);
    await takeFocusOnce(page, ".reader-body", TWEET_FRAME);
    await expect.poll(async () => (await keyboardPlace(page)).startsWith("frame")).toBe(false);
    await expect(ringed(page, ".reader-body")).toHaveCount(0);
    await expect(coverFor(page, TWEET_FRAME, ".reader-body")).toHaveCount(1);
    await expect(page.locator('.reader-body [data-testid="link-card-off"]')).toHaveCount(0);
    await expect(frame(page, TWEET_FRAME, ".reader-body")).toHaveCount(1);
    expect(sites.frames.filter((url) => url === TWEET_FRAME)).toHaveLength(1);

    // A viewer's read-only editor follows the same rule.
    await openDocument(viewer.page, id);
    await expect(viewer.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    await frameReady(viewer.page, TWEET_FRAME);
    await viewer.page.locator(".md-rich p", { hasText: "First paragraph" }).click();
    await takeFocusOnce(viewer.page, ".md-rich", TWEET_FRAME);
    await expect.poll(async () => (await keyboardPlace(viewer.page)).startsWith("frame")).toBe(false);
    await expect(ringed(viewer.page)).toHaveCount(0);
    await expect(coverFor(viewer.page, TWEET_FRAME)).toHaveCount(1);
    await expect(notice(viewer.page)).toHaveCount(0);
    await expect(frame(viewer.page, TWEET_FRAME)).toHaveCount(1);
    expect(sites.refused).toEqual([]);
    expect(viewerSites.refused).toEqual([]);
    await owner.context.close();
    await viewer.context.close();
  });

  test("accessibility: the card that was turned off, light and dark; its button by keyboard", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard-axe"));
    const sites = await standInWithKeyboard(context, baseURL!, (url) => (url === TWEET_FRAME ? 150 : 0));
    const id = await createDocument(page, DOC, "Turned off");
    for (const theme of ["light", "dark"] as const) {
      await openDocument(page, id);
      await setTheme(page, theme);
      await frameReady(page, TWEET_FRAME);
      await focusRichEnd(page);
      await expect(notice(page)).toHaveCount(1, { timeout: 15_000 });
      // The iframe is intentionally removed from direct Tab order because the adjacent parent-owned
      // button is its accessible keyboard proxy and immediately focuses it after a verified Tab.
      const results = await new AxeBuilder({ page }).disableRules(["frame-focusable-content"]).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const size = await new AxeBuilder({ page }).include(".md-link-card").withRules(["target-size"]).analyze();
      const violations = [...results.violations, ...size.violations];
      expect(violations, `${theme}\n${violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`).join("\n")}`).toHaveLength(0);
    }

    // By keyboard: from the card's link, Tab to "Show as text", Tab to "Load it again"; Enter loads the frame.
    const card = page.locator('.md-rich [data-provider="x"]');
    await card.locator(".md-link-card-link").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const again = page.getByRole("button", { name: "Load it again" });
    await expect(again).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(frame(page, TWEET_FRAME)).toHaveCount(1);
    await expect(notice(page)).toHaveCount(0);
    expect(sites.refused).toEqual([]);
    await context.close();
  });
});
