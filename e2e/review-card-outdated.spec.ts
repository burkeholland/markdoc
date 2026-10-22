import { mcpURL } from "./mcp-url";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { signIn, createDocument, openDocument, selectTextInRich, ensureCommentsOpen, codeText, mintToken, setTheme, type MintedToken, type User } from "./helpers";

/**
 * Issue #2327 (reported by Burke): a review card whose suggestions are all outdated showed a greyed
 * "Accept all (0 of 4)" and "Reject all", did not say why, and could only be cleared by rejecting.
 *
 * What makes a comment suggestion outdated, as these tests fix it:
 *  - a pending tracked suggestion changes words inside the quote: outdated while it is pending, applicable
 *    again when it is rejected, outdated for good when it is accepted;
 *  - a person edits the quoted text: outdated until the text reads as before again (Undo).
 * A quote that sits inside a pending tracked insertion is NOT outdated (see the last test).
 */
const DRAFT = "First point of the draft is strong.\n\nSecond point of the draft is weak.\n\nThird point of the draft is long.\n\nFourth point of the draft is fine.";
const SOURCE = `# Plan\n\n${DRAFT}\n`;
/** Token names are @mention names, unique per user: a name of this file's own keeps it clear of the other alice specs. */
const AGENT = "Copilot Stale";
const SHOTS = process.env.REVIEW_SHOTS;

const FOUR = [
  { quote: "is strong", body: "Sharper.\n\n```suggestion\nis very strong\n```" },
  { quote: "is weak", body: "Kinder.\n\n```suggestion\nis thin\n```" },
  { quote: "is long", body: "Shorter.\n\n```suggestion\nruns long\n```" },
  { quote: "is fine", body: "Better.\n\n```suggestion\nis good\n```" },
];
const REWORDS = [
  { find: "strong", replace: "solid" },
  { find: "weak", replace: "frail" },
  { find: "long", replace: "lengthy" },
  { find: "fine", replace: "okay" },
];
const PENDING_NOTE = "None of the 4 suggestions can be applied: a pending suggestion changes the text they quote. They apply again if it is rejected.";
const CHANGED_NOTE = "None of the 4 suggestions can be applied: the text they quote has changed.";

/** JSON-RPC over the MCP server, the way an agent calls the HTTP server. */
async function mcp<T>(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const post = () =>
    page.request.post(mcpURL(), {
      headers: { Authorization: ["Bearer", token].join(" "), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
  // The dev server occasionally drops a keep-alive socket while recompiling (read ECONNRESET); retry once.
  const res = await post().catch(async (err: unknown) => {
    if (!/ECONNRESET|ECONNREFUSED|socket hang up/.test(String(err))) throw err;
    await page.waitForTimeout(500);
    return post();
  });
  expect(res.ok(), `${name} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const text = await res.text();
  const line = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5) : text;
  const body = JSON.parse(line) as { result: { structuredContent?: T; content: { text: string }[]; isError?: boolean } };
  expect(body.result.isError, body.result.content?.[0]?.text).toBeFalsy();
  return (body.result.structuredContent ?? JSON.parse(body.result.content[0].text)) as T;
}

interface LiveThread {
  quote: string;
  resolved: boolean;
  decision: string | null;
}

/** The review's threads as the live session holds them: nothing a card does may decide a suggestion behind the person's back. */
const liveThreads = (page: Page) =>
  page.evaluate(() => {
    type Thread = { quote: string; resolved: boolean; suggestionState?: string | null };
    const session = (window as unknown as { __markdocSession: { comments: { list(): Thread[] } } }).__markdocSession;
    return session.comments.list().map((t): { quote: string; resolved: boolean; decision: string | null } => ({ quote: t.quote, resolved: t.resolved, decision: t.suggestionState ?? null }));
  }) as Promise<LiveThread[]>;

/** The side panel is user-resizable (280 to 720 px); the tests need exact widths without dragging. */
async function setPanelWidth(page: Page, width: number) {
  await page.addStyleTag({ content: `[data-testid=side-panel], [data-testid=comments-panel] { width: ${width}px !important; }` });
  await expect.poll(async () => Math.round((await page.getByTestId("comments-panel").boundingBox())!.width), { message: `panel width ${width}` }).toBe(width);
}

/** Screenshots of the panel for the pull request, only when REVIEW_SHOTS names a folder. */
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: (await page.getByTestId("comments-panel").boundingBox())! });
}

const boxOf = (locator: Locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });

test.describe("review card when suggestions cannot be applied (#2327)", () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  let alice: User;
  let minted: MintedToken | undefined;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    minted = await mintToken(alice.page, AGENT, { expiresInDays: 1 });
  });

  test.afterAll(async () => {
    await minted?.revoke();
    await alice.context.close();
  });

  const tool = <T,>(name: string, args: Record<string, unknown>) => mcp<T>(alice.page, minted!.token, name, args);

  async function reviewedDocument(source = SOURCE, comments = FOUR): Promise<string> {
    const page = alice.page;
    const docId = await createDocument(page, source, "Plan");
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await tool("markdoc_review", { id: docId, verdict: "comment", summary: "Four small things.", comments });
    await expect(page.getByTestId("review-card")).toHaveCount(1);
    return docId;
  }

  /** Decide every tracked suggestion on the Suggestions tab, then return to Open. */
  async function decideTracked(page: Page, decision: "accept" | "reject") {
    await page.getByTestId("comments-tab-suggestions").click();
    const tracked = page.getByTestId("suggestion-card");
    for (let left = await tracked.count(); left > 0; left--) {
      await tracked.first().getByTestId(decision === "accept" ? "suggestion-accept" : "suggestion-reject").click();
      await expect(tracked).toHaveCount(left - 1);
    }
    await page.getByTestId("comments-tab-open").click();
  }

  test("a pending tracked suggestion changes the quoted text: the card says so, links to Suggestions, and Accept all returns when it is rejected", async () => {
    const page = alice.page;
    const docId = await reviewedDocument();
    const card = page.getByTestId("review-card");
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-note")).toHaveCount(0);

    await tool("markdoc_suggest", { id: docId, edits: REWORDS });
    // What Burke saw here was a greyed "Accept all (0 of 4)" and "Reject all", with no reason.
    await expect(card.getByTestId("review-note").locator("span")).toHaveText(PENDING_NOTE);
    await expect(card.getByTestId("review-accept-all")).toHaveCount(0);
    await expect(card).not.toContainText("0 of 4");
    const resolve = card.getByTestId("review-resolve-all");
    const reject = card.getByTestId("review-reject-all");
    const link = card.getByTestId("review-open-suggestions");
    await expect(resolve).toBeEnabled();
    await expect(reject).toBeEnabled();
    // Names are the visible words; the sentence is the description of both decisions.
    await expect(resolve).toHaveAccessibleName("Resolve all");
    await expect(link).toHaveAccessibleName("Open Suggestions");
    await expect(resolve).toHaveAccessibleDescription(PENDING_NOTE);
    await expect(reject).toHaveAccessibleDescription(PENDING_NOTE);

    // Keyboard order: the new link, then the controls that were there before, in their old order.
    await link.focus();
    await page.keyboard.press("Tab");
    await expect(card.getByTestId("review-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(resolve).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(reject).toBeFocused();

    // The link shows the Suggestions tab, where the pending suggestions are; it decides nothing.
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("suggestion-card")).toHaveCount(4);
    expect((await liveThreads(page)).map((t) => [t.resolved, t.decision])).toEqual(Array(4).fill([false, null]));

    // Rejecting the pending suggestions gives the quotes back: all four can be applied again.
    await decideTracked(page, "reject");
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-accept-all")).toHaveText("Accept all");
    await expect(card.getByTestId("review-note")).toHaveCount(0);
    await expect(card.getByTestId("review-resolve-all")).toHaveCount(0);
    await card.getByTestId("review-accept-all").click();
    await expect.poll(() => codeText(page)).toContain("First point of the draft is very strong.");
    await expect(page.getByTestId("toast").filter({ hasText: `Accepted 4 suggestions from ${AGENT}` })).toBeVisible();
  });

  test("the pending suggestion is accepted: the text has changed for good; Resolve all clears the review without deciding a suggestion", async () => {
    const page = alice.page;
    const docId = await reviewedDocument();
    const card = page.getByTestId("review-card");
    await tool("markdoc_suggest", { id: docId, edits: REWORDS });
    await expect(card.getByTestId("review-note").locator("span")).toHaveText(PENDING_NOTE);
    await decideTracked(page, "accept");
    await expect.poll(() => codeText(page)).toContain("Fourth point of the draft is okay.");
    await expect(card.getByTestId("review-note").locator("span")).toHaveText(CHANGED_NOTE);
    await expect(card.getByTestId("review-open-suggestions")).toHaveCount(0);
    await expect(card.getByTestId("review-accept-all")).toHaveCount(0);
    await expect(card.getByTestId("review-reject-all")).toBeEnabled();
    await shot(page, "changed-open");
    const before = await codeText(page);

    await card.getByTestId("review-resolve-all").click();
    await expect(page.getByTestId("toast").filter({ hasText: `Resolved 4 comments from ${AGENT}` })).toBeVisible();
    // The review leaves Open and nothing is left to nag about on Suggestions.
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("comments-tab-open")).toHaveText("Open");
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText("Suggestions");
    // Nothing was applied and nothing was rejected.
    expect(await codeText(page)).toBe(before);
    expect((await liveThreads(page)).map((t) => [t.resolved, t.decision])).toEqual(Array(4).fill([true, null]));

    // Under Resolved the card says what state they are in; each thread keeps its Outdated badge and its own Reject.
    await page.getByTestId("comments-tab-resolved").click();
    const resolvedCard = page.getByTestId("review-card");
    await expect(resolvedCard.getByTestId("review-counts")).toHaveText("4 comments · 4 suggestions · 4 outdated, not decided");
    await expect(resolvedCard.getByTestId("review-actions")).toHaveCount(0);
    await expect(resolvedCard.getByTestId("review-note")).toHaveCount(0);
    const threads = page.getByTestId("comment-thread");
    await expect(threads).toHaveCount(4);
    await expect(page.locator('[data-testid="comment-thread"][data-suggestion="outdated"]')).toHaveCount(4);
    await expect(threads.first().getByTestId("suggestion-outdated")).toBeVisible();
    await expect(threads.first().getByTestId("suggestion-reject-comment")).toBeEnabled();
    await shot(page, "changed-resolved");

    // Reopening a comment brings its suggestion back as it was: the card returns to Open for that one.
    await threads.first().getByTestId("comment-resolve").click();
    await page.getByTestId("comments-tab-open").click();
    await expect(card.getByTestId("review-note").locator("span")).toHaveText("The suggestion cannot be applied: the text it quotes has changed.");
    await expect(card.getByTestId("review-resolve-all")).toBeEnabled();
    await expect(card.getByTestId("review-reject-all")).toBeEnabled();
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*1$/);
  });

  test("a person edits the quoted text, resolves the review, then undoes the edit: the suggestions can be applied again and the card returns to Open", async () => {
    const page = alice.page;
    await reviewedDocument(SOURCE, FOUR.slice(0, 2));
    const card = page.getByTestId("review-card");
    const original = await codeText(page);
    await selectTextInRich(page, "strong");
    await page.keyboard.type("x");
    await expect(card.getByTestId("review-note").locator("span")).toHaveText("1 of 2 suggestions can be applied; 1 quotes text that has changed.");
    // Something can still be applied: the buttons are the ones from before, and the accessible name carries the count.
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-accept-all")).toHaveAccessibleName(/Accept all suggestions \(1 of 2/);
    await expect(card.getByTestId("review-resolve-all")).toHaveCount(0);
    await shot(page, "partial-open");
    await selectTextInRich(page, "weak");
    await page.keyboard.type("y");
    await expect(card.getByTestId("review-note").locator("span")).toHaveText("None of the 2 suggestions can be applied: the text they quote has changed.");

    await card.getByTestId("review-resolve-all").click();
    await expect(page.getByTestId("review-card")).toHaveCount(0);
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText("Suggestions");

    // Undo both edits: the quoted text reads as before, so the two suggestions ask for a decision again.
    await page.locator(".md-rich").click();
    for (let i = 0; i < 12 && (await codeText(page)) !== original; i++) await page.keyboard.press("ControlOrMeta+z");
    expect(await codeText(page)).toBe(original);
    await page.getByTestId("comments-tab-open").click();
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-accept-all")).toHaveText("Accept all");
    await expect(card.getByTestId("review-note")).toHaveCount(0);
    await expect(page.getByTestId("comments-tab-suggestions")).toHaveText(/Suggestions\s*2$/);
    expect((await liveThreads(page)).map((t) => t.decision)).toEqual([null, null]);
  });

  test("the sentence, the link and both buttons fit at 280, 360 and 720 px in light and dark; no axe violation in the panel", async () => {
    const page = alice.page;
    const docId = await reviewedDocument();
    await tool("markdoc_suggest", { id: docId, edits: REWORDS });
    try {
      for (const theme of ["light", "dark"] as const) {
        await setTheme(page, theme);
        await ensureCommentsOpen(page);
        await page.getByTestId("comments-tab-open").click();
        const card = page.getByTestId("review-card");
        await expect(card.getByTestId("review-note").locator("span")).toHaveText(PENDING_NOTE);
        for (const width of [280, 360, 720]) {
          await setPanelWidth(page, width);
          const where = `${theme} ${width}px`;
          const cardBox = await boxOf(card);
          expect(cardBox.scrollWidth, `${where}: the card scrolls sideways`).toBeLessThanOrEqual(cardBox.clientWidth);
          const resolve = await boxOf(card.getByTestId("review-resolve-all"));
          const reject = await boxOf(card.getByTestId("review-reject-all"));
          const link = await boxOf(card.getByTestId("review-open-suggestions"));
          for (const [name, box] of [["Resolve all", resolve], ["Reject all", reject], ["Open Suggestions", link]] as const) {
            expect(box.scrollWidth, `${where}: "${name}" is clipped`).toBeLessThanOrEqual(box.clientWidth + 1);
            expect(box.scrollHeight, `${where}: "${name}" wraps`).toBeLessThanOrEqual(box.clientHeight + 1);
            expect(box.left, `${where}: "${name}" leaves the card on the left`).toBeGreaterThanOrEqual(cardBox.left);
            expect(box.right, `${where}: "${name}" leaves the card on the right`).toBeLessThanOrEqual(cardBox.right);
          }
          // One row of btn-sm for the two decisions, the link on a line of the sentence above them.
          expect(resolve.height, `${where}: Resolve all height`).toBeLessThanOrEqual(34);
          expect(Math.abs(resolve.top - reject.top), `${where}: Resolve all and Reject all share a row`).toBeLessThanOrEqual(1);
          expect(link.height, `${where}: Open Suggestions is one line`).toBeLessThanOrEqual(20);
          expect(link.bottom, `${where}: the link sits above the buttons`).toBeLessThanOrEqual(resolve.top);
          await shot(page, `pending-${theme}-${width}`);
        }
        const axe = await new AxeBuilder({ page }).include('[data-testid="comments-panel"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${theme}: axe`).toEqual([]);
      }
    } finally {
      await setTheme(page, "light");
    }
  });

  test("a quote inside a pending tracked insertion is not outdated: Accept all is offered before and after the insertion is accepted", async () => {
    const page = alice.page;
    const docId = await createDocument(page, "# Plan\n\nIntro stays here.\n\nDraft goes here.\n\nThe end is near.\n", "Plan");
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    await tool("markdoc_suggest", { id: docId, edits: [{ find: "Draft goes here.", replace: DRAFT }] });
    await tool("markdoc_review", { id: docId, verdict: "comment", summary: "On the draft.", comments: FOUR });
    await page.getByTestId("comments-tab-open").click();
    const card = page.getByTestId("review-card");
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-accept-all")).toHaveText("Accept all");
    await expect(card.getByTestId("review-note")).toHaveCount(0);
    await decideTracked(page, "accept");
    await expect(card.getByTestId("review-accept-all")).toBeEnabled();
    await expect(card.getByTestId("review-note")).toHaveCount(0);
    await card.getByTestId("review-accept-all").click();
    await expect.poll(() => codeText(page)).toContain("Fourth point of the draft is good.");
  });
});
