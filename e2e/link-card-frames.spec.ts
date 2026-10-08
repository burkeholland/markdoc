import AxeBuilder from "@axe-core/playwright";
import { devices, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { codeText, createDocument, mintToken, openDocument, setTheme, shareWith, signIn, uniqueLogin, type MintedToken } from "./helpers";
import { CARD_FRAME_SOURCES, expectOnlyCardFrames, frameAttempts, frameElements, standInForOtherSites, TWEET, TWEET_FRAME, VIDEO, VIDEO_FRAME } from "./link-card-helpers";

/**
 * The frames of link cards (#2317): in the editor, on the published page and inside the Copilot canvas.
 *
 * No test here touches the network. A frame is answered by a local stand-in page (see
 * e2e/link-card-helpers.ts) that tries what a frame must not be able to do and writes down how each
 * attempt ended. Every other request that leaves the app is refused and written down, and each test ends
 * by checking that nothing was written down.
 */
const DOC = `# Cards\n\nIntro\n\n${TWEET}\n\nBetween\n\n${VIDEO}\n\nOutro\n`;
const extensionModule = "../extensions/markdoc/extension-core.mjs";

const cards = (page: Page) => page.locator('.md-rich [data-testid="link-card"]');
const readerCards = (page: Page) => page.locator(".reader-body figure.md-link-card");

/** Twenty-one different videos: one more than a page loads by itself. */
const videoId = (n: number) => `video${String(n).padStart(5, "0")}x`;
const MANY = Array.from({ length: 21 }, (_, n) => `https://youtu.be/${videoId(n)}`);
const MANY_DOC = `# Many\n\n${MANY.join("\n\n")}\n`;
const manyFrame = (n: number) => `https://www.youtube-nocookie.com/embed/${videoId(n)}`;

/** What a document's author can write to try to get a frame, a script or a forged card onto the page. */
const HOSTILE = [
  `<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>`,
  `<iframe src="https://evil.example/frame" sandbox="allow-scripts allow-same-origin allow-top-navigation"></iframe>`,
  `<script src="https://platform.twitter.com/widgets.js"></script>`,
  `<figure class="md-link-card" data-link-card="https://x.com/jack/status/21" data-provider="x"><div class="md-link-card-frame" data-kind="post"></div></figure>`,
  `<p data-link-card="https://x.com/jack/status/22">forged mark</p>`,
  `<div data-link-card="https://evil.example/x" class="md-link-card"><div class="md-link-card-frame"><iframe src="https://evil.example/inner"></iframe></div></div>`,
  `<blockquote class="twitter-tweet"><a href="https://twitter.com/jack/status/23">a tweet's embed code</a></blockquote>`,
  `<object data="https://evil.example/o"></object><embed src="https://evil.example/e">`,
].join("\n\n");

/** The page scrolls in steps so that every lazy frame comes near the viewport once. */
async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const scroller = document.scrollingElement!;
    for (let y = 0; y <= scroller.scrollHeight; y += 600) {
      scroller.scrollTop = y;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function scan(page: Page, include: string, state: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const violations = [...results.violations, ...(await new AxeBuilder({ page }).include(include).withRules(["target-size"]).analyze()).violations];
  const lines = violations.map((v) => `  ${v.id} [${v.impact ?? "n/a"}] ${v.help}\n${v.nodes.slice(0, 5).map((n) => `      ${n.target.join(" ")}`).join("\n")}`);
  expect(violations, `${state}\n${lines.join("\n")}`).toHaveLength(0);
  // The scan did look at the frames: each has a name.
  const titled = results.passes.find((rule) => rule.id === "frame-title")?.nodes.length ?? 0;
  expect(titled, `${state}: axe saw the frames`).toBeGreaterThan(0);
}

test.describe("link card frames (#2317)", () => {
  test("a card in the editor loads its frame after a moment, with its limits; the frame cannot touch the page; edits elsewhere do not reload it", async ({ browser, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const owner = await signIn(browser, uniqueLogin("frames-owner"));
    const sites = await standInForOtherSites(owner.context, baseURL!);
    const collaborator = await signIn(browser, uniqueLogin("frames-collab"));
    const collaboratorSites = await standInForOtherSites(collaborator.context, baseURL!);
    const { page } = owner;
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const id = await createDocument(page, DOC, "Frames");
    await shareWith(page, id, collaborator.login, "editor");
    await openDocument(page, id);

    // Each card has its frame: the address built from the id alone, the limits, a name.
    await expect(cards(page)).toHaveCount(2);
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
    const frames = await frameElements(page, ".md-rich");
    expect(frames.map((frame) => frame.title)).toEqual(["Post on X: x.com/jack/status/20", "YouTube video: youtube.com/watch?v=dQw4w9WgXcQ"]);
    // A post has a tall box, a player a 16 by 9 box, and the frame fills it.
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".md-rich .md-link-card-frame"), (box) => {
        const rect = box.getBoundingClientRect();
        const frame = box.querySelector("iframe")!.getBoundingClientRect();
        return { kind: box.getAttribute("data-kind"), width: rect.width, height: rect.height, frameWidth: frame.width, frameHeight: frame.height };
      }),
    );
    expect(boxes.map((box) => box.kind)).toEqual(["post", "video"]);
    expect(boxes[0].height).toBeCloseTo(480, 0);
    expect(boxes[1].width / boxes[1].height).toBeCloseTo(16 / 9, 1);
    for (const box of boxes) {
      expect(box.frameWidth).toBeCloseTo(box.width, 0);
      expect(box.frameHeight).toBeCloseTo(box.height, 0);
    }

    // The stand-in page tried to read the page, to move it, to open a dialog and to talk to it.
    const tried = await frameAttempts(page, '.md-rich iframe[src^="https://platform.twitter.com/"]');
    expect(tried).toMatchObject({ readTop: "blocked", readParentDocument: "blocked", moveTop: "blocked", origin: "https://platform.twitter.com" });
    // The frame is told which site it is on and nothing about the document.
    await expect(page.frameLocator('.md-rich iframe[src^="https://www.youtube-nocookie.com/"]').locator("#referrer")).toHaveText(`referrer: ${origin}/`);
    expect(new URL(page.url()).pathname).toBe(`/d/${id}`);
    expect(dialogs).toEqual([]);
    // The message it sent changed nothing: the document and the cards are as they were.
    expect(await codeText(page)).toBe(DOC);
    await expect(cards(page)).toHaveCount(2);

    // Typing next to a card, here or by someone else, does not load the frame again or replace it.
    await page.evaluate(() => {
      for (const frame of document.querySelectorAll(".md-rich iframe")) (frame as HTMLIFrameElement & { kept?: boolean }).kept = true;
    });
    const asked = sites.frames.length;
    expect(sites.frames).toEqual([TWEET_FRAME, VIDEO_FRAME]);
    await page.locator(".md-rich p", { hasText: "Between" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" the two cards", { delay: 5 });
    await openDocument(collaborator.page, id);
    await collaborator.page.locator(".md-rich p", { hasText: "Intro" }).click();
    await collaborator.page.keyboard.press("End");
    await collaborator.page.keyboard.type(" from someone else", { delay: 5 });
    await expect.poll(() => codeText(page)).toBe(DOC.replace("Between", "Between the two cards").replace("Intro", "Intro from someone else"));
    // A new first block moves both cards down in the document: still the same frames.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("Before everything\n\n", { delay: 5 });
    await expect(page.locator(".md-rich p", { hasText: "Before everything" })).toBeVisible();
    // Longer than the wait before a frame is made.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll(".md-rich iframe"), (frame) => (frame as HTMLIFrameElement & { kept?: boolean }).kept === true))).toEqual([true, true]);
    expect(sites.frames.length).toBe(asked);

    // Another video in the same place: the old frame goes, and the new one is asked for once.
    const before = await codeText(page);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(`\n\nhttps://youtu.be/aaaaaaaaaa`, { delay: 5 });
    // Ten characters are not a video: a link, and nothing is asked of anyone.
    await expect(cards(page)).toHaveCount(2);
    await page.keyboard.type("b");
    await expect(cards(page)).toHaveCount(3);
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME, "https://www.youtube-nocookie.com/embed/aaaaaaaaaab"]);
    expect(sites.frames).toEqual([TWEET_FRAME, VIDEO_FRAME, "https://www.youtube-nocookie.com/embed/aaaaaaaaaab"]);
    expect(await codeText(page)).toBe(`${before}\n\nhttps://youtu.be/aaaaaaaaaab`);

    // Show as text takes the frame away with the card.
    await cards(page).first().getByRole("button", { name: "Show as text: Post on X" }).click();
    await expect(cards(page)).toHaveCount(2);
    await expectOnlyCardFrames(page, [VIDEO_FRAME, "https://www.youtube-nocookie.com/embed/aaaaaaaaaab"]);

    expect(sites.refused).toEqual([]);
    expect(collaboratorSites.refused).toEqual([]);
  });

  test("a link that is still being typed loads nothing: one frame, once the link has stopped changing", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("frames-typing"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, "Intro\n", "Typing");
    await openDocument(page, id);

    // A post's number grows as it is typed, and each longer number is a card for another post.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\nhttps://x.com/jack/status/1234567890", { delay: 40 });
    await expect(cards(page)).toHaveCount(1);
    await expectOnlyCardFrames(page, ["https://platform.twitter.com/embed/Tweet.html?id=1234567890&dnt=true"]);
    expect(sites.frames).toEqual(["https://platform.twitter.com/embed/Tweet.html?id=1234567890&dnt=true"]);
    expect(sites.refused).toEqual([]);
  });

  test("the published page shows the cards with their frames, and raw HTML in the document makes none", async ({ browser, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const user = await signIn(browser, uniqueLogin("frames-reader"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const id = await createDocument(page, `${DOC}\n${HOSTILE}\n\nSee ${TWEET} in a sentence.\n\n- ${VIDEO}\n\n<${VIDEO}>\n`, "Published");

    const response = await page.goto(`/p/${id}`);
    expect(response?.headers()["content-security-policy"]).toBe(`frame-ancestors 'none'; ${CARD_FRAME_SOURCES}`);
    // What the server sent has the two cards as Markdoc's own markup, and no frame and no script from elsewhere.
    // (Read as a document in which no script runs, so this is the HTML alone.)
    const sent = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const elsewhere = (value: string | null) => !!value && /^(https?:)?\/\//i.test(value) && new URL(value, location.href).origin !== location.origin;
      return {
        frames: doc.querySelectorAll("iframe, frame, object, embed").length,
        scripts: Array.from(doc.scripts, (script) => script.getAttribute("src")).filter(elsewhere),
        cards: Array.from(doc.querySelectorAll("figure.md-link-card"), (card) => ({
          link: card.getAttribute("data-link-card"),
          provider: card.getAttribute("data-provider"),
          href: card.querySelector("a")?.getAttribute("href"),
          box: card.querySelector(".md-link-card-frame")?.childNodes.length,
        })),
        marks: doc.querySelectorAll("[data-link-card]").length,
      };
    }, await response!.text());
    expect(sent).toEqual({
      frames: 0,
      scripts: [],
      cards: [
        { link: TWEET, provider: "x", href: TWEET, box: 0 },
        { link: VIDEO, provider: "youtube", href: VIDEO, box: 0 },
      ],
      marks: 2,
    });

    await expect(readerCards(page)).toHaveCount(2);
    await expect(readerCards(page).nth(0)).toHaveAccessibleName("Post on X: x.com/jack/status/20");
    await expect(readerCards(page).nth(1)).toHaveAccessibleName("YouTube video: youtube.com/watch?v=dQw4w9WgXcQ");
    await expect(readerCards(page).nth(0).getByRole("link")).toHaveAttribute("href", TWEET);
    await expect(readerCards(page).nth(0).getByRole("link")).toHaveAttribute("rel", /noopener/);
    // Nobody edits a published page.
    await expect(page.getByRole("button", { name: /Show as text/ })).toHaveCount(0);
    // Only the two real cards have a frame: not the forged card, not the forged mark, not the raw frames.
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
    expect(await page.locator("[data-link-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-link-card")))).toEqual([TWEET, VIDEO]);
    // A link in a sentence, in a list or in angle brackets is a link.
    await expect(page.locator(`.reader-body p a[href="${TWEET}"]`)).toHaveCount(1);
    await expect(page.locator(`.reader-body li a[href="${VIDEO}"]`)).toHaveCount(1);
    await expect(page.locator(`.reader-body p > a[href="${VIDEO}"]`)).toHaveCount(1);

    const tried = await frameAttempts(page, '.reader-body iframe[src^="https://www.youtube-nocookie.com/"]');
    expect(tried).toMatchObject({ readTop: "blocked", readParentDocument: "blocked", origin: "https://www.youtube-nocookie.com" });
    await expect(page.frameLocator('.reader-body iframe[src^="https://platform.twitter.com/"]').locator("#referrer")).toHaveText(`referrer: ${origin}/`);
    expect(new URL(page.url()).pathname).toBe(`/p/${id}`);
    expect(dialogs).toEqual([]);

    // The editor shows the same two cards for the same document.
    await openDocument(page, id);
    await expect(cards(page)).toHaveCount(2);
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);

    expect(sites.refused).toEqual([]);
    expect(new Set(sites.frames)).toEqual(new Set([TWEET_FRAME, VIDEO_FRAME]));
  });

  test("a page loads twenty frames by itself and only near the viewport; the next card has a Load button", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("frames-many"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, MANY_DOC, "Many");

    // The published page.
    await page.goto(`/p/${id}`);
    await expect(readerCards(page)).toHaveCount(21);
    await expect(page.locator(".reader-body iframe")).toHaveCount(20);
    const load = page.locator('.reader-body [data-testid="link-card-load"]');
    await expect(load).toHaveCount(1);
    await expect(readerCards(page).nth(20).getByRole("button", { name: `Load video: youtu.be/${videoId(20)}` })).toBeVisible();
    // At the top of a long page the browser has asked for the first frames only.
    await expect.poll(() => sites.frames.length).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    expect(sites.frames.length).toBeLessThan(20);
    expect(sites.frames).toContain(manyFrame(0));
    expect(sites.frames).not.toContain(manyFrame(19));
    await scrollThrough(page);
    await expect.poll(() => sites.frames.length).toBe(20);
    expect(new Set(sites.frames)).toEqual(new Set(MANY.slice(0, 20).map((_, n) => manyFrame(n))));
    // The button is reached with the keyboard and loads its frame; nothing else is asked for.
    await load.focus();
    await page.keyboard.press("Enter");
    await expect(load).toHaveCount(0);
    await expect(page.locator(".reader-body iframe")).toHaveCount(21);
    await expect.poll(() => sites.frames.length).toBe(21);
    expect(sites.frames[20]).toBe(manyFrame(20));

    // The editor: the same limit, and a card that goes away gives its place to the one that waits.
    sites.frames.length = 0;
    await openDocument(page, id);
    await expect(cards(page)).toHaveCount(21);
    await expect(page.locator(".md-rich iframe")).toHaveCount(20);
    const editorLoad = page.locator('.md-rich [data-testid="link-card-load"]');
    await expect(editorLoad).toHaveCount(1);
    await expect(cards(page).nth(20).getByRole("button", { name: `Load video: youtu.be/${videoId(20)}` })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(sites.frames.length).toBeLessThan(20);
    // Tab from "Show as text" reaches the Load button; Escape returns to the editor with the card selected.
    await cards(page).nth(20).getByRole("button", { name: "Show as text: YouTube video" }).focus();
    await page.keyboard.press("Tab");
    await expect(editorLoad).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".md-rich")).toBeFocused();
    await expect(cards(page).nth(20)).toHaveClass(/ProseMirror-selectednode/);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(editorLoad).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editorLoad).toHaveCount(0);
    await expect(page.locator(".md-rich iframe")).toHaveCount(21);
    expect(await codeText(page)).toBe(MANY_DOC);

    expect(sites.refused).toEqual([]);
  });

  test("the browser refuses a frame to any other site on a document page, and every frame on other pages", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("frames-policy"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, DOC, "Policy");

    /** Put a frame in the page as a script in the page could, and say what the browser did with it. */
    const tryFrame = (src: string) =>
      page.evaluate(
        (address) =>
          new Promise<{ blocked: string | null; directive: string | null }>((resolve) => {
            const done = (blocked: string | null, directive: string | null) => resolve({ blocked, directive });
            document.addEventListener("securitypolicyviolation", (event) => done(event.blockedURI, event.effectiveDirective), { once: true });
            const frame = document.createElement("iframe");
            frame.src = address;
            frame.addEventListener("load", () => setTimeout(() => done(null, null), 500));
            document.body.appendChild(frame);
          }),
        src,
      );

    await openDocument(page, id);
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
    for (const address of [
      "https://evil.example/frame",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com.evil.example/embed/dQw4w9WgXcQ",
      "http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://twitter.com/jack/status/20",
      "data:text/html,<p>inline</p>",
    ]) {
      const result = await tryFrame(address);
      expect(result.directive, address).toBe("frame-src");
    }
    for (const path of ["/", "/settings"]) {
      const response = await page.goto(path);
      expect(response?.headers()["content-security-policy"], path).toBe("frame-ancestors 'none'; frame-src 'none'");
      expect((await tryFrame(VIDEO_FRAME)).directive, path).toBe("frame-src");
      expect((await tryFrame(`${new URL(baseURL!).origin}/login`)).directive, `${path}: the app itself`).toBe("frame-src");
    }
    // None of the refused frames was asked for.
    expect(sites.refused).toEqual([]);
    expect(new Set(sites.frames)).toEqual(new Set([TWEET_FRAME, VIDEO_FRAME]));
  });

  test("inside the Copilot canvas the editor's cards load their frames", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("frames-canvas"));
    const canvasContext = await browser.newContext();
    interface TestCanvas {
      open(context: { instanceId: string; input: { id: string } }): Promise<{ url: string }>;
      onClose(context: { instanceId: string }): Promise<void>;
    }
    let canvas: TestCanvas | undefined;
    let minted: MintedToken | undefined;
    try {
      const { startMarkdocExtension } = await import(extensionModule);
      const documentId = await createDocument(owner.page, DOC, "Canvas cards");
      minted = await mintToken(owner.page, "Copilot app", { scope: "full", documentIds: [documentId] });
      await startMarkdocExtension({
        createCanvas: (options: TestCanvas) => {
          canvas = options;
          return options;
        },
        joinSession: async () => ({ send: async () => "message-id", log: async () => {}, on: () => () => {} }),
        environment: { ...process.env, MARKDOC_URL: new URL(baseURL!).origin, MARKDOC_TOKEN: minted.token },
      });
      const opened = await canvas!.open({ instanceId: "e2e-canvas-cards", input: { id: documentId } });
      const canvasOrigin = new URL(opened.url).origin;
      const sites = await standInForOtherSites(canvasContext, baseURL!, [canvasOrigin]);

      const page = await canvasContext.newPage();
      const policies: string[] = [];
      page.on("response", (response) => {
        if (new URL(response.url()).pathname === `/d/${documentId}`) policies.push(response.headers()["content-security-policy"] ?? "");
      });
      await page.goto(opened.url);
      const editor = page.frameLocator("iframe");
      await expect(editor.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      await expect(editor.locator('.md-rich [data-testid="link-card"]')).toHaveCount(2);
      // The canvas frames the editor, and the editor frames the two cards: three levels.
      await expect(editor.locator(".md-rich iframe")).toHaveCount(2);
      const inner = editor.frameLocator('.md-rich iframe[src^="https://www.youtube-nocookie.com/"]');
      await expect(inner.locator("#address")).toHaveText(VIDEO_FRAME);
      const tried = JSON.parse((await inner.locator("#tried").textContent()) ?? "{}") as Record<string, string>;
      expect(tried).toMatchObject({ readTop: "blocked", readParentDocument: "blocked", origin: "https://www.youtube-nocookie.com" });
      await expect(editor.frameLocator('.md-rich iframe[src^="https://platform.twitter.com/"]').locator("#address")).toHaveText(TWEET_FRAME);
      // The canvas is still the canvas: the frame did not move the top page.
      expect(page.url()).toBe(opened.url);
      // The embedded editor's policy: framed by the canvas only, frames the card hosts only.
      expect(policies.length).toBeGreaterThan(0);
      for (const policy of policies) expect(policy).toBe(`frame-ancestors ${canvasOrigin}; ${CARD_FRAME_SOURCES}`);
      expect(new Set(sites.frames)).toEqual(new Set([TWEET_FRAME, VIDEO_FRAME]));
      expect(sites.refused).toEqual([]);
    } finally {
      await canvas?.onClose({ instanceId: "e2e-canvas-cards" });
      await minted?.revoke();
      await canvasContext.close();
      await owner.context.close();
    }
  });

  test("accessibility: axe on the editor and the published page with loaded frames, light and dark; a phone; nothing moves when a frame arrives", async ({ browser, baseURL }) => {
    const user = await signIn(browser, uniqueLogin("frames-a11y"));
    const sites = await standInForOtherSites(user.context, baseURL!);
    const { page } = user;
    const id = await createDocument(page, DOC, "Accessible");

    for (const theme of ["light", "dark"] as const) {
      await page.goto(`/p/${id}`);
      await setTheme(page, theme);
      await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
      await scan(page, ".md-link-card", `published page, ${theme}`);
      await openDocument(page, id);
      await setTheme(page, theme);
      await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
      await scan(page, ".md-link-card", `editor, ${theme}`);
    }

    // The card is the same height before its frame is there and after: the text under it does not move.
    await page.goto(`/p/${id}`);
    await expectOnlyCardFrames(page, [TWEET_FRAME, VIDEO_FRAME]);
    const withFrames = await readerCards(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    const withoutFrames = await page.evaluate(() => {
      for (const frame of document.querySelectorAll(".reader-body iframe")) frame.remove();
      return Array.from(document.querySelectorAll(".reader-body figure.md-link-card"), (el) => Math.round(el.getBoundingClientRect().height));
    });
    expect(withoutFrames).toEqual(withFrames);
    // The card does not animate: there is nothing to turn off for reduced motion.
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll(".md-link-card, .md-link-card *"), (el) => {
          const style = getComputedStyle(el);
          return style.animationName !== "none" || parseFloat(style.transitionDuration) > 0;
        }).some(Boolean),
      ),
    ).toBe(false);

    // A phone: the card and its frame fit the screen, on both pages.
    const phone = await browser.newContext({ ...devices["iPhone 13"], storageState: await user.context.storageState() });
    const phoneSites = await standInForOtherSites(phone, baseURL!);
    const small = await phone.newPage();
    await small.goto(`/p/${id}`);
    await expect(small.locator(".reader-body iframe")).toHaveCount(2);
    const fit = await small.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      rights: Array.from(document.querySelectorAll(".md-link-card, .md-link-card iframe"), (el) => Math.round(el.getBoundingClientRect().right)),
    }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
    for (const right of fit.rights) expect(right).toBeLessThanOrEqual(fit.viewport);
    await phone.close();

    expect(sites.refused).toEqual([]);
    expect(phoneSites.refused).toEqual([]);
  });
});
