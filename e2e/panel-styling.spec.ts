import { test, expect, type Locator, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, ensureCommentsOpen, selectTextInRich, mintToken, type MintedToken, type User } from "./helpers";

/**
 * Comments panel polish (task #994, Burke): no coloured left bars anywhere in the UI, Accept all / Reject all
 * on one line each at every panel width, decided reviews leave the Open tab, and no text bleeds out of a card.
 * Every assertion is a measured number; the measurements are printed so the task report can quote them.
 */

const SOURCE = "# Panel polish\n\nOur product is very unique.\n\nWe launched recently and sales are good.\n\nThe end is near.\n\nA closing line for good measure.\n";
const WIDTHS = [280, 340, 720] as const;

const LONG_CODE = "permissions.disableBypassPermissions.overridable.enterprise.managed.settings";
const LONG_BODY = `Ours has one line, \`${LONG_CODE}\` set to disable`;

interface ButtonMetrics {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /** Distinct text rows (from the glyph rectangles of every text node); 1 = single line. */
  textRows: number;
  /** How far the text's glyph boxes reach past the button's border box (0 = nothing bleeds). */
  bleedLeft: number;
  bleedRight: number;
}

const measureButton = (button: Locator): Promise<ButtonMetrics> =>
  button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // innerText inserts "\n" between flex items even when they sit on one row, so wrapping is measured from the
    // text glyph rectangles instead: one row of rects = one line.
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    const rows = new Set<number>();
    for (const rect of rects) {
      const centre = rect.top + rect.height / 2;
      if (![...rows].some((row) => Math.abs(row - centre) < rect.height / 2)) rows.add(centre);
    }
    return {
      label: (el as HTMLElement).innerText.replace(/\s*\n\s*/g, " ").trim(),
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      textRows: rows.size,
      bleedLeft: rects.length ? Math.max(0, r.left - Math.min(...rects.map((rect) => rect.left))) : 0,
      bleedRight: rects.length ? Math.max(0, Math.max(...rects.map((rect) => rect.right)) - r.right) : 0,
    };
  });

/** One line of text at btn-sm (32 px), nothing clipped inside the button, no wrapped label, no glyph outside the box. */
function expectSingleLine(m: ButtonMetrics, where: string) {
  expect(m.height, `${where}: "${m.label}" height ${m.height}`).toBeLessThanOrEqual(34);
  expect(m.scrollWidth, `${where}: "${m.label}" scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`).toBeLessThanOrEqual(m.clientWidth + 1);
  expect(m.scrollHeight, `${where}: "${m.label}" scrollHeight ${m.scrollHeight} > clientHeight ${m.clientHeight}`).toBeLessThanOrEqual(m.clientHeight + 1);
  expect(m.textRows, `${where}: "${m.label}" is on ${m.textRows} rows`).toBe(1);
  expect(m.bleedLeft + m.bleedRight, `${where}: "${m.label}" bleeds ${m.bleedLeft}/${m.bleedRight} px past the button`).toBeLessThanOrEqual(0.5);
}

const overflowOf = (locator: Locator) =>
  locator.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, right: el.getBoundingClientRect().right, left: el.getBoundingClientRect().left }));

const styleOf = (locator: Locator, props: string[]) =>
  locator.evaluate((el, names) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
  }, props);

/**
 * The side panel is user-resizable (280–720 px, task #978); the tests need exact widths without dragging, so the
 * wrapper's inline width and the aside are forced through a stylesheet.
 */
async function setPanelWidth(page: Page, width: number) {
  await page.addStyleTag({ content: `[data-testid=side-panel], [data-testid=comments-panel] { width: ${width}px !important; }` });
  await expect.poll(async () => Math.round((await page.getByTestId("comments-panel").boundingBox())!.width), { message: `panel width ${width}` }).toBe(width);
}

/** Posts an agent review over REST (the same route the MCP server uses). */
async function postReview(page: Page, token: string, docId: string, review: { summary: string; verdict: "approve" | "request_changes" | "comment"; comments: { quote: string; body: string }[] }) {
  const res = await page.request.post(`/api/documents/${docId}/reviews`, {
    headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json" },
    data: review,
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { review: { id: string; threadIds: string[] } }).review;
}

const suggestion = (prose: string, proposed: string) => `${prose}\n\n\`\`\`suggestion\n${proposed}\n\`\`\``;

async function commentsOf(page: Page, docId: string) {
  const res = await page.request.get(`/api/documents/${docId}/comments`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { comments: { id: string; resolved: boolean; suggestion: { state: string } | null }[] }).comments;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((t) => localStorage.setItem("markdoc:theme", t), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

/** Pills fade in (transition-colors, 150 ms); measure the settled colour, not a mid-transition alpha. */
async function settledBackground(locator: Locator): Promise<string> {
  const read = () => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  let previous = await read();
  for (let i = 0; i < 20; i++) {
    await locator.page().waitForTimeout(100);
    const next = await read();
    if (next === previous) return next;
    previous = next;
  }
  return previous;
}

test.describe("comments panel polish: no left bars, one-line buttons, decided reviews leave Open, no overflow", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  let alice: User;
  let token: string;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    // Token names double as @mention names and must be unique per user. The toasts only check the "Copilot" prefix,
    // so a random suffix keeps this file clear of the other alice specs even in a parallel worker; afterAll revokes it.
    minted = await mintToken(alice.page, `Copilot ${Math.random().toString(36).slice(2, 8)}`, { expiresInDays: 1 });
    token = minted.token;
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
  });

  async function freshDocument(): Promise<string> {
    const docId = await createDocument(alice.page, SOURCE, "Panel polish");
    await openDocument(alice.page, docId);
    await ensureCommentsOpen(alice.page);
    return docId;
  }

  test("review card: even 1 px border, no coloured left edge; Accept all / Reject all on one line each at 280, 340 and 720 px; quote is a pill", async ({}, testInfo) => {
    const docId = await freshDocument();
    const page = alice.page;
    await postReview(page, token, docId, {
      summary: "Three small things.",
      verdict: "request_changes",
      comments: [
        { quote: "very unique", body: suggestion("Redundant.", "unique") },
        { quote: "sales are good", body: suggestion("Stronger.", "sales are strong") },
        { quote: "The end is near.", body: suggestion("Softer close.", "That is all for now.") },
      ],
    });
    const card = page.getByTestId("review-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("review-counts")).toContainText("3 comments · 3 suggestions");

    // 1. Even border all round: the left edge is exactly the right edge.
    const border = await styleOf(card, ["border-left-width", "border-right-width", "border-left-color", "border-right-color", "border-top-width"]);
    console.log(`[994] review-card border: ${JSON.stringify(border)}`);
    expect(border["border-left-width"]).toBe("1px");
    expect(border["border-right-width"]).toBe("1px");
    expect(border["border-left-width"]).toBe(border["border-right-width"]);
    expect(border["border-left-color"]).toBe(border["border-right-color"]);

    // 3. The quoted text above a comment is a pill, not a bar.
    const quote = page.getByTestId("comment-quote").first();
    await expect(quote).toBeVisible();
    const quoteStyle = await styleOf(quote, ["border-left-width", "border-right-width", "background-color", "border-radius"]);
    console.log(`[994] comment-quote: ${JSON.stringify(quoteStyle)}`);
    expect(quoteStyle["border-left-width"]).toBe("0px");
    expect(quoteStyle["background-color"]).not.toBe("rgba(0, 0, 0, 0)");

    // 2. Accept all / Reject all: one text line each, side by side, equal width, at every panel width.
    const accept = card.getByTestId("review-accept-all");
    const reject = card.getByTestId("review-reject-all");
    await expect(accept).toBeEnabled();
    for (const width of WIDTHS) {
      await setPanelWidth(page, width);
      const a = await measureButton(accept);
      const r = await measureButton(reject);
      console.log(`[994] ${width}px accept: ${JSON.stringify(a)}`);
      console.log(`[994] ${width}px reject: ${JSON.stringify(r)}`);
      expectSingleLine(a, `${width}px`);
      expectSingleLine(r, `${width}px`);
      expect(a.label).toBe("Accept all");
      expect(r.label).toBe("Reject all");
      expect(Math.abs(a.y - r.y), `${width}px: same row`).toBeLessThanOrEqual(1);
      expect(Math.abs(a.width - r.width), `${width}px: equal width`).toBeLessThanOrEqual(1);
      expect(r.x, `${width}px: reject right of accept`).toBeGreaterThan(a.x + a.width);
      // The card itself never grows past the panel.
      const cardBox = await overflowOf(card);
      expect(cardBox.scrollWidth, `${width}px: card scrollWidth`).toBeLessThanOrEqual(cardBox.clientWidth + 1);

      // Per-thread rows inside the expanded review and the suggestion-box buttons: single-line labels too.
      if (width === WIDTHS[0]) {
        await card.getByTestId("review-toggle").click();
        await expect(card.getByTestId("review-thread-link")).toHaveCount(3);
        for (const link of await card.getByTestId("review-thread-link").all()) {
          // The link is a flex row (icon, truncated quote, badge); innerText puts a newline between flex items, so
          // only the overflow check is meaningful here. The quote span is `truncate`, so it never wraps.
          const m = await measureButton(link);
          expect(m.scrollWidth, `${width}px: review-thread-link overflows`).toBeLessThanOrEqual(m.clientWidth + 1);
          expect(m.height, `${width}px: review-thread-link is one row`).toBeLessThanOrEqual(28);
        }
        await card.getByTestId("review-toggle").click();
        const boxes = page.getByTestId("suggestion-box");
        await expect(boxes).toHaveCount(3);
        for (const id of ["suggestion-accept-comment", "suggestion-reject-comment"]) {
          const m = await measureButton(boxes.first().getByTestId(id));
          console.log(`[994] ${width}px ${id}: ${JSON.stringify(m)}`);
          expectSingleLine(m, `${width}px ${id}`);
        }
      }
      if (width === 340) {
        await page.screenshot({ path: testInfo.outputPath("review-card-340-light.png"), clip: (await page.getByTestId("comments-panel").boundingBox())! });
      }
    }
  });

  test("Accept all with an outdated suggestion keeps a one-line label at every width; the tooltip carries the count", async () => {
    const docId = await freshDocument();
    const page = alice.page;
    await postReview(page, token, docId, {
      summary: "One will be outdated.",
      verdict: "comment",
      comments: [
        { quote: "very unique", body: suggestion("Redundant.", "unique") },
        { quote: "sales are good", body: suggestion("Stronger.", "sales are strong") },
        { quote: "The end is near.", body: suggestion("Softer close.", "That is all for now.") },
      ],
    });
    const card = page.getByTestId("review-card").first();
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    // Editing the quoted text of one suggestion makes it outdated: Accept all then reads "(2 of 3)".
    await selectTextInRich(page, "sales are good");
    await page.keyboard.type("sales are fine");
    await expect(card.getByTestId("review-accept-all")).toHaveAttribute("title", /2 of 3/);
    for (const width of WIDTHS) {
      await setPanelWidth(page, width);
      const a = await measureButton(card.getByTestId("review-accept-all"));
      const r = await measureButton(card.getByTestId("review-reject-all"));
      console.log(`[994] outdated ${width}px accept: ${JSON.stringify(a)}`);
      expectSingleLine(a, `outdated ${width}px`);
      expectSingleLine(r, `outdated ${width}px`);
      expect(a.label.startsWith("Accept all"), a.label).toBeTruthy();
      expect(Math.abs(a.y - r.y), `${width}px: same row`).toBeLessThanOrEqual(1);
    }
    // At the widest the count is shown inline; the accessible name always carries it.
    expect(await measureButton(card.getByTestId("review-accept-all"))).toMatchObject({ label: "Accept all (2 of 3)" });
    await expect(card.getByTestId("review-accept-all")).toHaveAccessibleName(/Accept all suggestions \(2 of 3/);
  });

  test("decided reviews leave Open: Accept all resolves; Reject all + Resolve all clears; an already resolved review lists under Resolved only", async () => {
    const docId = await freshDocument();
    const page = alice.page;
    const openCards = () => page.getByTestId("review-cards").getByTestId("review-card");
    const openTab = page.getByTestId("comments-tab-open");
    const resolvedTab = page.getByTestId("comments-tab-resolved");

    // Review A: three pending suggestions. Open shows it, Resolved does not.
    const a = await postReview(page, token, docId, {
      summary: "Reject these.",
      verdict: "request_changes",
      comments: [
        { quote: "very unique", body: suggestion("Redundant.", "unique") },
        { quote: "sales are good", body: suggestion("Stronger.", "sales are strong") },
        { quote: "The end is near.", body: suggestion("Softer close.", "That is all for now.") },
      ],
    });
    expect(a.threadIds).toHaveLength(3);
    await expect(openCards()).toHaveCount(1);
    await resolvedTab.click();
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("comment-thread")).toHaveCount(0);
    await openTab.click();
    await expect(openCards()).toHaveCount(1);

    // Reject all: the suggestions are decided but the threads stay open, so the card stays and offers Resolve all.
    const cardA = page.locator(`[data-testid="review-card"][data-review-id="${a.id}"]`);
    await cardA.getByTestId("review-reject-all").click();
    await expect(page.getByTestId("toast").filter({ hasText: "Rejected 3 suggestions from Copilot" })).toBeVisible();
    await expect(cardA.getByTestId("review-resolve-all")).toBeVisible();
    await expect(cardA.getByTestId("review-accept-all")).toHaveCount(0);
    await expect(cardA.getByTestId("review-counts")).toContainText("all decided");
    await expect(openCards()).toHaveCount(1);
    const decided = await commentsOf(page, docId);
    expect(decided.filter((c) => a.threadIds.includes(c.id)).map((c) => [c.suggestion?.state, c.resolved])).toEqual([
      ["rejected", false],
      ["rejected", false],
      ["rejected", false],
    ]);

    const t0 = Date.now();
    await cardA.getByTestId("review-resolve-all").click();
    await expect(openCards()).toHaveCount(0, { timeout: 1000 });
    const resolveMs = Date.now() - t0;
    console.log(`[994] Resolve all → card left Open in ${resolveMs} ms`);
    expect(resolveMs).toBeLessThanOrEqual(1000);
    const afterResolve = await commentsOf(page, docId);
    expect(afterResolve.filter((c) => a.threadIds.includes(c.id)).every((c) => c.resolved)).toBe(true);
    await resolvedTab.click();
    await expect(page.locator(`[data-testid="review-card"][data-review-id="${a.id}"]`)).toHaveCount(1);
    await expect(page.getByTestId("comment-thread")).toHaveCount(3);
    await expect(page.getByTestId("comment-resolved-state")).toHaveCount(3);
    await expect(page.getByTestId("review-accept-all")).toHaveCount(0);
    await expect(page.getByTestId("review-reject-all")).toHaveCount(0);
    await expect(page.getByTestId("review-resolve-all")).toHaveCount(0);
    await expect(page.getByTestId("review-threads")).toHaveCount(0); // collapsed by default
    await openTab.click();

    // Review B: Accept all applies the suggestions and (by design) resolves their threads, so the card leaves Open at once.
    const b = await postReview(page, token, docId, {
      summary: "Accept these.",
      verdict: "approve",
      comments: [{ quote: "We launched recently", body: suggestion("Precise.", "We launched in March") }, { quote: "A closing line", body: suggestion("Shorter.", "A closing note") }],
    });
    const cardB = page.locator(`[data-testid="review-card"][data-review-id="${b.id}"]`);
    await expect(cardB).toBeVisible();
    await expect(openCards()).toHaveCount(1);
    const t1 = Date.now();
    await cardB.getByTestId("review-accept-all").click();
    await expect(openCards()).toHaveCount(0, { timeout: 1000 });
    console.log(`[994] Accept all → card left Open in ${Date.now() - t1} ms`);
    await expect(page.getByTestId("toast").filter({ hasText: "Accepted 2 suggestions from Copilot" })).toBeVisible();
    const afterAccept = await commentsOf(page, docId);
    expect(afterAccept.filter((c) => b.threadIds.includes(c.id)).map((c) => [c.suggestion?.state, c.resolved])).toEqual([
      ["accepted", true],
      ["accepted", true],
    ]);

    // Review C: plain comments resolved before the page loads render in Resolved only. Review D: threads deleted → Resolved.
    const c = await postReview(page, token, docId, { summary: "Already handled.", verdict: "comment", comments: [{ quote: "# Panel polish", body: "Title works." }] });
    for (const threadId of c.threadIds) {
      const res = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "resolve", threadId, resolved: true } });
      expect(res.ok()).toBeTruthy();
    }
    const d = await postReview(page, token, docId, { summary: "Comments removed.", verdict: "comment", comments: [{ quote: "good measure", body: "Will be deleted." }] });
    for (const threadId of d.threadIds) {
      const res = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "delete", threadId } });
      expect(res.ok()).toBeTruthy();
    }
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await openTab.click();
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await resolvedTab.click();
    await expect(page.getByTestId("review-card")).toHaveCount(4);
    const order = await page.getByTestId("review-card").evaluateAll((cards) => cards.map((el) => el.getAttribute("data-review-id")));
    expect(order.slice().sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    await openTab.click();
  });

  test("a plain-comment review offers Resolve all (nothing to accept), and the tab counts still count threads", async () => {
    const docId = await freshDocument();
    const page = alice.page;
    await postReview(page, token, docId, {
      summary: "No suggestions here.",
      verdict: "comment",
      comments: [{ quote: "very unique", body: "Hmm." }, { quote: "The end is near.", body: "Ok." }],
    });
    const card = page.getByTestId("review-card").first();
    await expect(card.getByTestId("review-resolve-all")).toBeVisible();
    await expect(card.getByTestId("review-accept-all")).toHaveCount(0);
    await expect(page.getByTestId("comments-tab-open")).toContainText("Open2");
    await card.getByTestId("review-resolve-all").click();
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("comments-tab-open")).toHaveText("Open");
    await expect(page.getByTestId("comments-tab-resolved")).toContainText("Resolved2");
  });

  test("a 70-character inline code span wraps inside its card at 340 and 280 px; the panel never scrolls sideways", async ({}, testInfo) => {
    await freshDocument();
    const page = alice.page;
    await selectTextInRich(page, "sales are good");
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer");
    await expect(composer).toBeFocused();
    await composer.fill(LONG_BODY);
    await page.keyboard.press("ControlOrMeta+Enter");
    const thread = page.getByTestId("comment-thread").filter({ hasText: "Ours has one line" }).first();
    await expect(thread).toBeVisible();
    const code = thread.locator(".comment-code");
    await expect(code).toHaveText(LONG_CODE);
    const panel = page.locator("#comments-tabpanel");

    for (const width of [340, 280] as const) {
      await setPanelWidth(page, width);
      const cardBox = await overflowOf(thread);
      const panelBox = await overflowOf(panel);
      const codeBox = await overflowOf(code);
      const codeRects = await code.evaluate((el) => el.getClientRects().length);
      console.log(`[994] ${width}px card: ${JSON.stringify(cardBox)} panel: ${JSON.stringify(panelBox)} code: ${JSON.stringify(codeBox)} codeLines: ${codeRects}`);
      expect(cardBox.scrollWidth, `${width}px: card scrollWidth`).toBeLessThanOrEqual(cardBox.clientWidth + 1);
      expect(panelBox.scrollWidth, `${width}px: tab panel scrollWidth`).toBeLessThanOrEqual(panelBox.clientWidth + 1);
      expect(codeBox.right, `${width}px: code span right edge`).toBeLessThanOrEqual(cardBox.right);
      expect(codeRects, `${width}px: the code span wraps onto more than one line`).toBeGreaterThan(1);
      if (width === 340) {
        await page.screenshot({ path: testInfo.outputPath("thread-quote-340-light.png"), clip: (await page.getByTestId("comments-panel").boundingBox())! });
        await setTheme(page, "dark");
        await ensureCommentsOpen(page);
        await setPanelWidth(page, width);
        await expect(thread).toBeVisible();
        const darkQuote = await styleOf(page.getByTestId("comment-quote").first(), ["border-left-width", "background-color"]);
        console.log(`[994] dark comment-quote: ${JSON.stringify(darkQuote)}`);
        expect(darkQuote["border-left-width"]).toBe("0px");
        await page.screenshot({ path: testInfo.outputPath("thread-quote-340-dark.png"), clip: (await page.getByTestId("comments-panel").boundingBox())! });
        await setTheme(page, "light");
        await ensureCommentsOpen(page);
      }
    }
  });

  test("dark theme: the review card has the same even border and one-line buttons at 340 px", async ({}, testInfo) => {
    const docId = await freshDocument();
    const page = alice.page;
    await postReview(page, token, docId, {
      summary: "Dark check.",
      verdict: "request_changes",
      comments: [
        { quote: "very unique", body: suggestion("Redundant.", "unique") },
        { quote: "sales are good", body: suggestion("Stronger.", "sales are strong") },
        { quote: "The end is near.", body: suggestion("Softer close.", "That is all for now.") },
      ],
    });
    await setTheme(page, "dark");
    await ensureCommentsOpen(page);
    await setPanelWidth(page, 340);
    const card = page.getByTestId("review-card").first();
    await expect(card).toBeVisible();
    const border = await styleOf(card, ["border-left-width", "border-right-width", "border-left-color", "border-right-color"]);
    console.log(`[994] dark review-card border: ${JSON.stringify(border)}`);
    expect(border["border-left-width"]).toBe("1px");
    expect(border["border-left-color"]).toBe(border["border-right-color"]);
    const a = await measureButton(card.getByTestId("review-accept-all"));
    const r = await measureButton(card.getByTestId("review-reject-all"));
    expectSingleLine(a, "dark 340px");
    expectSingleLine(r, "dark 340px");
    await page.screenshot({ path: testInfo.outputPath("review-card-340-dark.png"), clip: (await page.getByTestId("comments-panel").boundingBox())! });
    await setTheme(page, "light");
  });
});

test.describe("reader: the current heading in On this page is a filled pill, not a bar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const READER = [
    "# Reader pill",
    "",
    "Intro paragraph.",
    "",
    "## First section",
    "",
    ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the first section, long enough to scroll.\n`),
    "## Second section",
    "",
    ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the second section, long enough to scroll.\n`),
    "### A subsection",
    "",
    ...Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1} of the subsection.\n`),
    "## Third section",
    "",
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of the third section, long enough that the heading can sit at the top.\n`),
    "",
  ].join("\n");

  test("scrolling to the third heading: its entry has no left border and a filled background; the others are transparent", async ({ browser }, testInfo) => {
    const owner = await signIn(browser, "reader-pill-owner");
    const page = owner.page;
    const id = await createDocument(page, READER, "Reader pill");
    const res = await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } });
    expect(res.ok()).toBeTruthy();
    await page.goto(`/p/${id}`);
    await expect(page.getByTestId("reader-title")).toHaveText("Reader pill");
    const entries = page.getByTestId("reader-toc-entry");
    await expect(entries).toHaveCount(4);

    // The list itself carries no left border either.
    const list = page.locator("#reader-toc-list");
    const listStyle = await styleOf(list, ["border-left-width"]);
    console.log(`[994] reader-toc-list: ${JSON.stringify(listStyle)}`);
    expect(listStyle["border-left-width"]).toBe("0px");

    await page.evaluate(() => document.getElementById("third-section")!.scrollIntoView({ block: "start" }));
    const activeEntry = page.locator('[data-testid="reader-toc-entry"][aria-current="location"]');
    await expect(activeEntry).toHaveText("Third section");
    await settledBackground(activeEntry);
    const measured = await entries.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return { text: el.textContent?.trim(), current: el.getAttribute("aria-current"), borderLeft: cs.borderLeftWidth, background: cs.backgroundColor, radius: cs.borderRadius, paddingLeft: cs.paddingLeft };
      }),
    );
    console.log(`[994] reader toc entries: ${JSON.stringify(measured)}`);
    const active = measured.find((m) => m.current === "location")!;
    expect(active.borderLeft).toBe("0px");
    expect(active.background).not.toBe("rgba(0, 0, 0, 0)");
    for (const m of measured.filter((entry) => entry.current !== "location")) {
      expect(m.borderLeft, `${m.text} border`).toBe("0px");
      expect(m.background, `${m.text} background`).toBe("rgba(0, 0, 0, 0)");
    }
    // Hierarchy is still readable: the h3 entry is indented under its h2.
    const h2 = measured.find((m) => m.text === "Second section")!;
    const h3 = measured.find((m) => m.text === "A subsection")!;
    expect(parseFloat(h3.paddingLeft)).toBeGreaterThan(parseFloat(h2.paddingLeft));

    await page.screenshot({ path: testInfo.outputPath("reader-toc-light.png"), clip: (await page.getByTestId("reader-aside").boundingBox())! });
    await page.evaluate(() => localStorage.setItem("markdoc:theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.evaluate(() => document.getElementById("third-section")!.scrollIntoView({ block: "start" }));
    await expect(activeEntry).toHaveText("Third section");
    await settledBackground(activeEntry);
    const dark = await styleOf(activeEntry, ["border-left-width", "background-color"]);
    console.log(`[994] dark active toc entry: ${JSON.stringify(dark)}`);
    expect(dark["border-left-width"]).toBe("0px");
    expect(dark["background-color"]).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: testInfo.outputPath("reader-toc-dark.png"), clip: (await page.getByTestId("reader-aside").boundingBox())! });
    await owner.context.close();
  });
});
