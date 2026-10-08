import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, focusCodeEnd, focusRichEnd, openDocument, setTheme, shareWith, signIn, uniqueLogin } from "./helpers";
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
const cover = (page: Page) => page.locator(".md-rich [data-card-cover]");
/** The frame's stand-in has run its script (it shows its counts). */
const frameReady = (page: Page, url: string, scope = ".md-rich") => expect(page.frameLocator(`${scope} iframe[src="${url}"]`).locator("#counts")).toContainText("keys", { timeout: 30_000 });
const letters = (text: string, wanted: string) => Array.from(text).filter((character) => wanted.includes(character)).join("");

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

  test("a quiet frame: a click goes in and the card shows the ring; a click back returns; a click right after typing plays but the keyboard stays; Tab goes in", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard-quiet"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Quiet");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const play = page.frameLocator(`.md-rich iframe[src="${VIDEO_FRAME}"]`).locator("#play");
    const inFrame = () => frameCounts(page, ".md-rich", VIDEO_FRAME);

    // The person types, stops for more than a second, and presses the player's button.
    await focusRichEnd(page);
    await page.keyboard.type("one");
    await page.waitForTimeout(1200);
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

    // A click on the player less than a second after a key: the click lands, the keyboard stays in the document.
    await play.click();
    await expect.poll(async () => (await inFrame()).clicks).toBe(2);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.keyboard.type("three");
    expect(await codeText(page)).toContain("onetwothree");
    expect((await inFrame()).text).toBe("kkk");
    await expect(ringed(page)).toHaveCount(0);
    // That was one try, not three: the frame is still there.
    await expect(frame(page, VIDEO_FRAME)).toHaveCount(1);

    // Tab: the link, "Show as text", then the frame itself. A move by Tab is the person's own.
    await page.locator('.md-rich [data-provider="youtube"] [data-testid="link-card-as-text"]').focus();
    await page.keyboard.press("Tab");
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(ringed(page)).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(await keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(notice(page)).toHaveCount(0);
    expect(sites.refused).toEqual([]);
    await context.close();
  });

  test("the pointer rests on a frame while the person types: a cover lies over it until the pointer moves; a press on the cover goes into the frame", async ({ browser, baseURL }) => {
    const { page, context } = await signIn(browser, uniqueLogin("guard-cover"));
    const sites = await standInWithKeyboard(context, baseURL!);
    const id = await createDocument(page, DOC, "Cover");
    await openDocument(page, id);
    await frameReady(page, VIDEO_FRAME);
    const inFrame = () => frameCounts(page, ".md-rich", VIDEO_FRAME);

    await focusRichEnd(page);
    const box = (await frame(page, VIDEO_FRAME).boundingBox())!;
    // The pointer comes to rest on the frame (no click). The page saw it arrive and sees nothing more.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 12, { steps: 4 });
    await expect(cover(page)).toHaveCount(0);
    await page.keyboard.type("a");
    // Now the page cannot tell a later press on the frame from the frame's own script: the cover goes on.
    await expect(cover(page)).toHaveCount(1);
    expect(await cover(page).evaluate((element) => element.parentElement?.querySelector("iframe")?.getAttribute("src"))).toBe(VIDEO_FRAME);
    // While it is on, a grab by the frame's script is taken back, pointer or no pointer.
    await takeFocusOnce(page, ".md-rich", VIDEO_FRAME);
    await expect.poll(async () => (await inFrame()).grabs).toBe(1);
    await expect.poll(() => keyboardPlace(page)).toBe("preview");
    await page.keyboard.type("b");
    expect(await codeText(page)).toContain("Last paragraphab");
    // The next movement of the pointer takes the cover away.
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height - 16, { steps: 2 });
    await expect(cover(page)).toHaveCount(0);

    // Typing again brings it back; a press on it is the person's own move into the frame, and is not passed on.
    await page.keyboard.type("c");
    await expect(cover(page)).toHaveCount(1);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${VIDEO_FRAME}`);
    await expect(cover(page)).toHaveCount(0);
    await expect(ringed(page)).toHaveCount(1);
    expect((await inFrame()).clicks).toBe(0);
    await page.keyboard.type("k");
    expect((await inFrame()).text).toBe("k");
    // The pointer leaves: nothing is left over the frame.
    await page.mouse.move(box.x + box.width + 200, box.y + box.height + 40);
    await expect(cover(page)).toHaveCount(0);
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

  test("where nothing is typed, a frame is left alone: the published page and a viewer's editor", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("guard-pub"));
    const sites = await standInWithKeyboard(owner.context, baseURL!, (url) => (url === TWEET_FRAME ? 200 : 0));
    const viewer = await signIn(browser, uniqueLogin("guard-viewer"));
    const viewerSites = await standInWithKeyboard(viewer.context, baseURL!, (url) => (url === TWEET_FRAME ? 200 : 0));
    const { page } = owner;
    const id = await createDocument(page, DOC, "Published");
    await shareWith(page, id, viewer.login, "viewer");

    // The published page has no place to type in. The frame takes the keyboard and may keep it; the card shows it.
    await page.goto(`/p/${id}`);
    await frameReady(page, TWEET_FRAME, ".reader-body");
    await expect.poll(() => keyboardPlace(page)).toBe(`frame ${TWEET_FRAME}`);
    await expect(ringed(page, ".reader-body")).toHaveCount(1);
    await page.waitForTimeout(1500);
    await expect(page.locator('.reader-body [data-testid="link-card-off"]')).toHaveCount(0);
    await expect(frame(page, TWEET_FRAME, ".reader-body")).toHaveCount(1);
    expect(sites.frames.filter((url) => url === TWEET_FRAME)).toHaveLength(1);

    // A viewer's editor: the preview cannot be typed in.
    await openDocument(viewer.page, id);
    await expect(viewer.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
    await frameReady(viewer.page, TWEET_FRAME);
    await viewer.page.locator(".md-rich p", { hasText: "First paragraph" }).click();
    await expect.poll(() => keyboardPlace(viewer.page)).toBe(`frame ${TWEET_FRAME}`);
    await viewer.page.waitForTimeout(1500);
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
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
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
