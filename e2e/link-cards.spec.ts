import AxeBuilder from "@axe-core/playwright";
import { devices, type BrowserContext, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, cssPx, devLogin, openDocument, reloadHydrated, setTheme, shareWith, signIn, uniqueLogin, waitForEditor } from "./helpers";

/**
 * Link cards in the editor (#2317, pull request 1: the form, the node and a static card; no frame yet).
 *
 * No test here touches the network: every request that does not go to the app is refused in the browser
 * and written down, and each test ends by checking that nothing was written down.
 */
const TWEET = "https://x.com/jack/status/20";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const DOC = `# Cards\n\nIntro\n\n${TWEET}\n\nBetween\n\n${VIDEO}\n\nOutro\n`;

const cards = (page: Page) => page.locator('.md-rich [data-testid="link-card"]');
const asText = (page: Page) => page.locator('.md-rich [data-testid="link-card-as-text"]');

/** A 1x1 PNG: what the test answers for a person's avatar, which the app has always loaded from GitHub. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * Refuse and record every request that leaves the app. Returns the list; it must stay empty. The one
 * request the app makes to another site without this change, the avatar image, is answered here.
 */
async function refuseOtherSites(context: BrowserContext, baseURL: string): Promise<string[]> {
  const origin = new URL(baseURL).origin;
  const refused: string[] = [];
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin,
    (route) => {
      const url = route.request().url();
      if (url.startsWith("https://avatars.githubusercontent.com/")) return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      refused.push(url);
      return route.abort("blockedbyclient");
    },
  );
  return refused;
}
/** What the page holds that could load or run something from another site. */
const foreignThings = (page: Page) =>
  page.evaluate(() => {
    const here = location.origin;
    const foreign = (value: string | null) => !!value && /^(https?:)?\/\//i.test(value) && new URL(value, location.href).origin !== here;
    return {
      frames: document.querySelectorAll("iframe, frame, object, embed").length,
      foreignScripts: Array.from(document.scripts, (script) => script.getAttribute("src")).filter(foreign),
      foreignSources: Array.from(document.querySelectorAll(".md-rich [src], .md-rich [srcset], .md-rich [data], .md-rich link[href]"), (el) => el.outerHTML.slice(0, 120)),
      windowFrames: window.frames.length,
    };
  });

async function pasteInRich(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document.querySelector(".md-rich")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function scanCards(page: Page, state: string) {
  // The whole page with the 2.1 A and AA rules, colour contrast included, then WCAG 2.2 target size on the cards.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = [...results.violations, ...(await new AxeBuilder({ page }).include(".md-link-card").withRules(["target-size"]).analyze()).violations];
  const lines = violations.map((v) => `  ${v.id} [${v.impact ?? "n/a"}] ${v.help}\n${v.nodes.slice(0, 5).map((n) => `      ${n.target.join(" ")}`).join("\n")}`);
  expect(violations, `${state}\n${lines.join("\n")}`).toHaveLength(0);
  // The scan did look at the cards.
  const seen = results.passes.flatMap((rule) => rule.nodes.map((node) => node.target.join(" ")));
  expect(seen.some((target) => target.includes("md-link-card")), `${state}: axe saw the cards`).toBe(true);
}

test.describe("link cards in the editor (#2317)", () => {
  test("a known link alone on its line is a card; Show as text turns it back, for a collaborator too, through undo and a reload", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("cards-owner"));
    const ownerRefused = await refuseOtherSites(owner.context, baseURL!);
    const collaborator = await signIn(browser, uniqueLogin("cards-collab"));
    const collaboratorRefused = await refuseOtherSites(collaborator.context, baseURL!);
    const id = await createDocument(owner.page, DOC, "Cards");
    await shareWith(owner.page, id, collaborator.login, "editor");
    await openDocument(owner.page, id);
    await openDocument(collaborator.page, id);

    for (const page of [owner.page, collaborator.page]) {
      await expect(cards(page)).toHaveCount(2);
      await expect(cards(page).nth(0)).toHaveAccessibleName("Post on X: x.com/jack/status/20");
      await expect(cards(page).nth(1)).toHaveAccessibleName("YouTube video: youtube.com/watch?v=dQw4w9WgXcQ");
      await expect(cards(page).nth(0).getByRole("link")).toHaveAttribute("href", TWEET);
      await expect(cards(page).nth(0).getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
      await expect(cards(page).nth(0).getByRole("button", { name: "Show as text: Post on X" })).toBeVisible();
      await expect(cards(page).nth(1).getByRole("button", { name: "Show as text: YouTube video" })).toBeVisible();
    }
    // The Markdown pane keeps the text: the bare links.
    expect(await codeText(owner.page)).toBe(DOC);
    await expect(owner.page.locator(".cm-content")).toContainText(TWEET);

    await asText(owner.page).first().click();
    const asTextDoc = DOC.replace(TWEET, `<${TWEET}>`);
    await expect.poll(() => codeText(owner.page)).toBe(asTextDoc);
    for (const page of [owner.page, collaborator.page]) {
      await expect(cards(page)).toHaveCount(1);
      await expect(cards(page).first()).toHaveAccessibleName(/^YouTube video/);
      await expect(page.locator(`.md-rich p a[href="${TWEET}"]`)).toHaveText(TWEET);
    }
    await expect.poll(() => codeText(collaborator.page)).toBe(asTextDoc);
    // Focus is back in the editor, at the end of the link.
    await expect(owner.page.locator(".md-rich")).toBeFocused();

    // One undo brings the card back and nothing else; redo turns it to text again.
    await owner.page.keyboard.press("Control+z");
    await expect.poll(() => codeText(owner.page)).toBe(DOC);
    await expect(cards(owner.page)).toHaveCount(2);
    await expect(cards(collaborator.page)).toHaveCount(2);
    await owner.page.keyboard.press("Control+Shift+z");
    await expect.poll(() => codeText(owner.page)).toBe(asTextDoc);
    await expect(cards(collaborator.page)).toHaveCount(1);

    // The collaborator turns the other card; the owner sees it.
    await asText(collaborator.page).first().click();
    const bothText = asTextDoc.replace(VIDEO, `<${VIDEO}>`);
    await expect.poll(() => codeText(owner.page)).toBe(bothText);
    await expect(cards(owner.page)).toHaveCount(0);
    await collaborator.page.keyboard.press("Control+z");
    await expect.poll(() => codeText(owner.page)).toBe(asTextDoc);

    // A reload shows the same thing: the choice is in the document.
    await expect(owner.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
    await reloadHydrated(owner.page);
    await expect(owner.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(cards(owner.page)).toHaveCount(1);
    await expect(cards(owner.page).first()).toHaveAccessibleName(/^YouTube video/);
    await expect(owner.page.locator(`.md-rich p a[href="${TWEET}"]`)).toHaveText(TWEET);
    expect(await codeText(owner.page)).toBe(asTextDoc);

    // Nothing from another site is in either page, and nothing was asked of another site.
    for (const page of [owner.page, collaborator.page]) {
      expect(await foreignThings(page)).toEqual({ frames: 0, foreignScripts: [], foreignSources: [], windowFrames: 0 });
    }
    // The published page is not part of this step: there the link is still an ordinary link, and nothing else.
    await owner.page.goto(`/p/${id}`);
    await expect(owner.page.locator(`.reader-body a[href="${VIDEO}"]`)).toHaveText(VIDEO);
    await expect(owner.page.locator(".reader-body figure, .reader-body iframe, .reader-body [data-link-card]")).toHaveCount(0);
    expect(await foreignThings(owner.page)).toEqual({ frames: 0, foreignScripts: [], foreignSources: [], windowFrames: 0 });
    expect(ownerRefused).toEqual([]);
    expect(collaboratorRefused).toEqual([]);
  });

  test("typing the link in the Markdown pane, or its brackets, switches the preview between card and link", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-typing"));
    const refused = await refuseOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro\n", "Typing");
    await openDocument(page, id);

    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\n${VIDEO}`, { delay: 5 });
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${VIDEO}`);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toHaveAccessibleName("YouTube video: youtube.com/watch?v=dQw4w9WgXcQ");

    // A word after it on the same line: a sentence, not a card.
    await page.keyboard.type(" now");
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(`.md-rich p a[href="${VIDEO}"]`)).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
    await expect(cards(page)).toHaveCount(1);

    // Angle brackets around it: text.
    await page.keyboard.type(">");
    await page.keyboard.press("Home");
    await page.keyboard.type("<");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n<${VIDEO}>`);
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(`.md-rich p a[href="${VIDEO}"]`)).toHaveText(VIDEO);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${VIDEO}`);
    await expect(cards(page)).toHaveCount(1);

    expect(await foreignThings(page)).toEqual({ frames: 0, foreignScripts: [], foreignSources: [], windowFrames: 0 });
    expect(refused).toEqual([]);
  });

  test("a known link pasted on an empty line becomes a card; one undo leaves the link, another the empty line", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-paste"));
    const refused = await refuseOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro", "Paste");
    await openDocument(page, id);

    await page.locator(".md-rich p", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await pasteInRich(page, TWEET);
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${TWEET}`);
    await expect(cards(page)).toHaveCount(1);
    // The caret is on a new line under the card: typing goes on there.
    await page.keyboard.type("After");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${TWEET}\n\nAfter`);
    await expect(cards(page)).toHaveCount(1);

    await page.keyboard.press("Control+z");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n${TWEET}`);
    await page.keyboard.press("Control+z");
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n<${TWEET}>`);
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(`.md-rich p a[href="${TWEET}"]`)).toHaveText(TWEET);
    await page.keyboard.press("Control+z");
    await expect.poll(() => codeText(page)).toBe("Intro");

    // In a sentence the same link is pasted as text.
    await page.locator(".md-rich p", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" see ");
    await pasteInRich(page, TWEET);
    await expect.poll(() => codeText(page)).toContain(`Intro see `);
    await expect(cards(page)).toHaveCount(0);
    // A link to a site that is not on the list stays a link on its own line.
    await page.keyboard.press("Enter");
    await pasteInRich(page, "https://x.com.evil.example/jack/status/20");
    await expect.poll(() => codeText(page)).toContain("x.com.evil.example");
    await expect(cards(page)).toHaveCount(0);

    expect(await foreignThings(page)).toEqual({ frames: 0, foreignScripts: [], foreignSources: [], windowFrames: 0 });
    expect(refused).toEqual([]);
  });

  test("keyboard: the arrow keys select the card, Tab goes into it, Escape comes back, Enter on the button turns it to text", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-keys"));
    const refused = await refuseOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, DOC, "Keys");
    await openDocument(page, id);
    const card = cards(page).first();

    await page.locator(".md-rich p", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await expect(card).toHaveClass(/ProseMirror-selectednode/);
    // The selected card shows a ring.
    expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");

    await page.keyboard.press("Tab");
    await expect(card.getByRole("link")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Show as text: Post on X" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".md-rich")).toBeFocused();
    await expect(card).toHaveClass(/ProseMirror-selectednode/);
    // Selecting a card and walking through it changes nothing in the document.
    expect(await codeText(page)).toBe(DOC);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

    // Down again leaves the card for the next paragraph, up comes back to it.
    await page.keyboard.press("ArrowDown");
    await expect(card).not.toHaveClass(/ProseMirror-selectednode/);
    await page.keyboard.press("ArrowUp");
    await expect(card).toHaveClass(/ProseMirror-selectednode/);

    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect.poll(() => codeText(page)).toBe(DOC.replace(TWEET, `<${TWEET}>`));
    await expect(cards(page)).toHaveCount(1);
    await expect(page.locator(".md-rich")).toBeFocused();

    // The same from the command palette, and back.
    await page.keyboard.press("Control+Shift+P");
    await page.getByTestId("palette-input").fill("Show link as card");
    await page.getByTestId("palette-item-card:as-card").click();
    await expect.poll(() => codeText(page)).toBe(DOC);
    await expect(cards(page)).toHaveCount(2);
    await expect(cards(page).first()).toHaveClass(/ProseMirror-selectednode/);
    await page.keyboard.press("Control+Shift+P");
    await page.getByTestId("palette-input").fill("Show card as text");
    await expect(page.getByTestId("palette-item-card:as-card")).toHaveCount(0);
    await page.getByTestId("palette-item-card:as-text").click();
    await expect.poll(() => codeText(page)).toBe(DOC.replace(TWEET, `<${TWEET}>`));

    expect(refused).toEqual([]);
  });

  test("a viewer and a commenter see the card and its link, and no Show as text", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("cards-share"));
    const viewer = await signIn(browser, uniqueLogin("cards-viewer"));
    const commenter = await signIn(browser, uniqueLogin("cards-commenter"));
    const refused = [await refuseOtherSites(viewer.context, baseURL!), await refuseOtherSites(commenter.context, baseURL!)];
    const id = await createDocument(owner.page, DOC, "Roles");
    await shareWith(owner.page, id, viewer.login, "viewer");
    await shareWith(owner.page, id, commenter.login, "commenter");

    for (const person of [viewer, commenter]) {
      await openDocument(person.page, id);
      await expect(cards(person.page)).toHaveCount(2);
      await expect(person.page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
      await expect(asText(person.page)).toHaveCount(2);
      for (const button of await asText(person.page).all()) await expect(button).toBeHidden();
      await expect(person.page.getByRole("button", { name: /Show as text/ })).toHaveCount(0);
      const link = cards(person.page).first().getByRole("link");
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", TWEET);
      // The link is an ordinary tab stop for someone who cannot edit.
      await link.focus();
      await expect(link).toBeFocused();
      await person.page.keyboard.press("Tab");
      await expect(cards(person.page).nth(1).getByRole("link")).toBeFocused();
      // The palette offers neither card command.
      await person.page.keyboard.press("Control+Shift+P");
      await person.page.getByTestId("palette-input").fill("card");
      await expect(person.page.locator('[data-testid^="palette-item-card:"]')).toHaveCount(0);
      await person.page.keyboard.press("Escape");
    }
    expect(refused.flat()).toEqual([]);
  });

  test("a comment made on a selected card marks the card; Show as text while suggesting is a suggestion", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-review"));
    const refused = await refuseOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, DOC, "Review");
    await openDocument(page, id);
    const card = cards(page).first();

    // A click on the card (not on its link or button) selects it; the selection bubble stays away.
    await card.locator(".md-link-card-label").click();
    await expect(card).toHaveClass(/ProseMirror-selectednode/);
    await expect(page.getByTestId("selection-bubble")).toHaveCount(0);
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("pending-comment").getByTestId("comment-composer");
    await composer.fill("Is this the right post?");
    await page.getByTestId("pending-comment").getByTestId("comment-submit").click();
    await expect(page.getByTestId("comment-thread")).toHaveCount(1);
    await expect(card).toHaveAttribute("data-card-highlight", "comment");
    await expect(cards(page).nth(1)).not.toHaveAttribute("data-card-highlight", /.*/);
    // The comment is on the link's characters: the Markdown pane underlines exactly the link.
    await expect.poll(() => page.locator(".cm-content .md-comment").allTextContents().then((parts) => parts.join(""))).toBe(TWEET);
    expect(await codeText(page)).toBe(DOC);

    // Suggesting: the text gets the brackets as a suggestion, the preview shows the link.
    await page.getByTestId("mode-switcher").click();
    await page.getByRole("menuitemradio", { name: /Suggesting/ }).click();
    await expect(page.getByTestId("mode-switcher")).toContainText("Suggesting");
    await asText(page).nth(1).click();
    await expect.poll(() => codeText(page)).toBe(DOC.replace(VIDEO, `<${VIDEO}>`));
    await expect(cards(page)).toHaveCount(1);
    await expect.poll(() => page.locator(".cm-content .md-suggest-insert").allTextContents().then((parts) => parts.join(""))).toBe("<>");
    // Rejecting it brings the card back.
    await page.evaluate(() => (window as unknown as { __markdocSession: { reviewSuggestion(action: string): number } }).__markdocSession.reviewSuggestion("rejectAll"));
    await expect.poll(() => codeText(page)).toBe(DOC);
    await expect(cards(page)).toHaveCount(2);

    expect(refused).toEqual([]);
  });

  test("accessibility: axe on a page with cards in light and dark, one selected and one focused", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("cards-a11y"));
    const refused = await refuseOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, DOC, "Accessible cards");
    await openDocument(page, id);

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await waitForEditor(page);
      await expect(cards(page)).toHaveCount(2);
      await scanCards(page, `${theme}: two cards`);
      await cards(page).first().locator(".md-link-card-label").click();
      await expect(cards(page).first()).toHaveClass(/ProseMirror-selectednode/);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(asText(page).first()).toBeFocused();
      // The focused button shows the app's focus ring.
      expect(await asText(page).first().evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      await scanCards(page, `${theme}: Show as text focused`);
      // Never an animation or a transition on the card: nothing to reduce for reduced motion.
      expect(await cards(page).first().evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).transitionDuration])).toEqual(["none", "0s"]);
    }
    expect(refused).toEqual([]);
  });

  test("phone width: the card fits the column and Show as text is a finger-sized target", async ({ browser, baseURL }) => {
    const phone = devices["iPhone 13"];
    const context = await browser.newContext({ viewport: phone.viewport, deviceScaleFactor: phone.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: phone.userAgent });
    const refused = await refuseOtherSites(context, baseURL!);
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("cards-phone"));
    const long = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=12&t=42s";
    const id = await createDocument(page, `Intro\n\n${TWEET}\n\n${long}\n`, "Phone");
    await page.goto(`/d/${id}`);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(cards(page)).toHaveCount(2);

    const pane = (await page.locator(".md-rich").boundingBox())!;
    for (const card of await cards(page).all()) {
      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(pane.x);
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
      expect(box.x + box.width).toBeLessThanOrEqual(phone.viewport.width);
      const button = (await card.getByRole("button").boundingBox())!;
      expect(cssPx(button.height)).toBeGreaterThanOrEqual(40);
      expect(cssPx(button.width)).toBeGreaterThanOrEqual(40);
      expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
      // The long link is cut with an ellipsis inside the card, not pushed out of it.
      const link = (await card.getByRole("link").boundingBox())!;
      expect(link.x + link.width).toBeLessThanOrEqual(box.x + box.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await asText(page).first().tap();
    await expect.poll(() => codeText(page)).toBe(`Intro\n\n<${TWEET}>\n\n${long}\n`);
    await expect(cards(page)).toHaveCount(1);
    expect(refused).toEqual([]);
  });
});
