import { test, expect, type Browser, type Locator, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createDocument, ensureCommentsOpen, openDocument, selectTextInRich } from "./helpers";

/**
 * Task #984 (Burke): the comment composer follows its content — three lines at rest, growing to min(320 px, 40 vh)
 * and scrolling past that — an edit spans the full width of its card instead of the avatar-indented column, nothing
 * is rendered under the box (the shortcut legend moved into the Save / send button's tooltip) and Esc cancels an
 * edit. The measured heights and widths are printed (`[984] …`) for the task report; `SHOT_DIR=<dir>` also saves
 * screenshots of the 14-line edit at the default 340 px panel width.
 */

const VIEWPORT = { width: 1280, height: 800 };
const DOC = "# Composer\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.\n";
const REST_HEIGHT = 64;
const MAX_HEIGHT = 320;
const lines = (n: number) => Array.from({ length: n }, (_, i) => "line " + (i + 1)).join("\n");

async function signInAt(browser: Browser, login: string) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByTestId("dev-login").fill(login);
  await page.getByTestId("dev-login-submit").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForLoadState("networkidle");
  return { context, page };
}

/** Post a root comment through the API and return its card once the panel shows it. */
async function addThread(page: Page, docId: string, quote: string, body: string): Promise<Locator> {
  const res = await page.request.post(`/api/documents/${docId}/comments`, { data: { action: "add", quote, body } });
  expect(res.ok()).toBeTruthy();
  const { id } = (await res.json()) as { id: string };
  const thread = page.locator(`[data-testid="comment-thread"][data-thread-id="${id}"]`);
  await expect(thread).toBeVisible();
  return thread;
}

/** ⋯ → Edit on a card or reply; resolves to the focused edit textarea. */
async function openEdit(page: Page, scope: Locator, menuName: "Comment actions" | "Reply actions"): Promise<Locator> {
  await scope.getByRole("button", { name: menuName }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const textarea = scope.getByTestId("comment-composer");
  await expect(textarea).toBeVisible();
  // The closing menu hands focus back to its trigger first; the composer takes it a frame later (comments-rich.spec.ts clicks too).
  await textarea.click();
  await expect(textarea).toBeFocused();
  return textarea;
}

const metrics = (textarea: Locator) =>
  textarea.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    offsetHeight: (el as HTMLElement).offsetHeight,
    width: el.getBoundingClientRect().width,
    left: el.getBoundingClientRect().left,
  }));

const cardMetrics = (card: Locator) => card.evaluate((el) => ({ clientWidth: el.clientWidth, width: el.getBoundingClientRect().width, left: el.getBoundingClientRect().left }));

/** §4.6: the textarea's only following sibling inside the composer is the button row; no legend or hint text anywhere. */
async function expectNothingUnderTheBox(page: Page, textarea: Locator) {
  await expect(textarea).toBeFocused();
  const composer = textarea.locator("..");
  await expect(composer.locator("textarea + *").getByTestId("comment-submit")).toBeVisible();
  await expect(composer.locator("textarea ~ *")).toHaveCount(1);
  await expect(page.getByText("Shift+Enter newline")).toHaveCount(0);
  await expect(page.getByTestId("comment-format-hint")).toHaveCount(0);
}

/** Hover the Save / send button and return the tooltip bubble once it shows. */
async function hoverShortcuts(page: Page, composerScope: Locator): Promise<Locator> {
  await composerScope.getByTestId("comment-submit").hover();
  const tip = page.getByTestId("composer-shortcuts");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Shift+Enter newline");
  return tip;
}

/** Move the pointer off the button and wait for the tooltip to go, so its text never leaks into later counts. */
async function dismissTooltip(page: Page) {
  await page.mouse.move(5, 5);
  await expect(page.getByTestId("composer-shortcuts")).toHaveCount(0);
}

test.describe("comment composer: auto-grow, full-width editing, shortcuts in the tooltip", () => {
  let page: Page;
  let close: () => Promise<void>;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    const alice = await signInAt(browser, "alice");
    page = alice.page;
    close = () => alice.context.close();
    docId = await createDocument(page, DOC, "Composer");
    await openDocument(page, docId);
    await ensureCommentsOpen(page);
    // The default panel width: the widths below are measured against a 340 px panel.
    expect((await page.getByTestId("comments-panel").boundingBox())!.width).toBe(340);
  });

  test.afterAll(async () => {
    await close();
  });

  test("editing a 14-line comment opens at full height, across the card, with nothing under the box; Esc cancels", async () => {
    const body = lines(14);
    const thread = await addThread(page, docId, "First paragraph", body);
    const textarea = await openEdit(page, thread, "Comment actions");
    await expect(textarea).toHaveValue(body);

    const m = await metrics(textarea);
    const card = await cardMetrics(thread);
    console.log(
      `[984] §4.1 edit 14 lines: textarea clientHeight=${m.clientHeight} scrollHeight=${m.scrollHeight} offsetHeight=${m.offsetHeight} ` +
        `| §4.3 textarea width=${m.width.toFixed(1)} card clientWidth=${card.clientWidth} ratio=${(m.width / card.clientWidth).toFixed(3)} indent=${(m.left - card.left).toFixed(1)}px`,
    );
    expect(m.clientHeight).toBeGreaterThanOrEqual(200);
    expect(m.scrollHeight - m.clientHeight).toBeLessThanOrEqual(2);
    expect(m.offsetHeight).toBeLessThanOrEqual(MAX_HEIGHT);
    expect(m.width).toBeGreaterThanOrEqual(0.9 * card.clientWidth);
    // Not in the avatar column: the box starts at the card's padding edge (12 px padding + 1 px border).
    expect(m.left - card.left).toBeLessThanOrEqual(14);

    await expectNothingUnderTheBox(page, textarea);
    if (process.env.SHOT_DIR) {
      mkdirSync(process.env.SHOT_DIR, { recursive: true });
      await page.getByTestId("comments-panel").screenshot({ path: `${process.env.SHOT_DIR}/composer-edit-14-lines.png` });
    }

    const tip = await hoverShortcuts(page, thread);
    await expect(tip).toContainText("Enter saves");
    await expect(tip).toContainText("Esc cancels");
    await expect(tip).toContainText(/(Ctrl|⌘)\+B bold/);
    await expect(thread.getByTestId("comment-submit")).toHaveAttribute("aria-description", /Esc cancels/);
    if (process.env.SHOT_DIR) await page.getByTestId("comments-panel").screenshot({ path: `${process.env.SHOT_DIR}/composer-edit-14-lines-tooltip.png` });
    await dismissTooltip(page);

    // §4.5 Esc cancels: the typed change is dropped, the original body stays, nothing is written.
    const writes: string[] = [];
    const onRequest = (req: Request) => {
      if (req.method() !== "GET" && /\/api\/documents\/[^/]+\/comments/.test(req.url())) writes.push(`${req.method()} ${req.url()}`);
    };
    page.on("request", onRequest);
    await textarea.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" EDITED");
    await expect(textarea).toHaveValue(body + " EDITED");
    await page.keyboard.press("Escape");
    await expect(thread.getByTestId("comment-composer")).toHaveCount(0);
    await expect(thread.getByTestId("comment-body")).toContainText("line 14");
    await expect(thread.getByTestId("comment-body")).not.toContainText("EDITED");
    await expect(thread.getByTestId("comment-edited")).toHaveCount(0);
    await page.waitForTimeout(500);
    page.off("request", onRequest);
    expect(writes).toEqual([]);
    const res = await page.request.get(`/api/documents/${docId}/comments`);
    const { comments } = (await res.json()) as { comments: { body: string; quote: string }[] };
    expect(comments.find((c) => c.quote === "First paragraph")?.body).toBe(body);
  });

  test("a 40-line comment stops growing at the cap and scrolls inside", async () => {
    const body = lines(40);
    const thread = await addThread(page, docId, "Second paragraph", body);
    const textarea = await openEdit(page, thread, "Comment actions");
    await expect(textarea).toHaveValue(body);

    const m = await metrics(textarea);
    const cap = Math.min(MAX_HEIGHT, VIEWPORT.height * 0.4);
    console.log(`[984] §4.2 edit 40 lines: textarea clientHeight=${m.clientHeight} scrollHeight=${m.scrollHeight} offsetHeight=${m.offsetHeight} cap=${cap}`);
    expect(m.clientHeight).toBeLessThanOrEqual(322);
    expect(m.offsetHeight).toBeLessThanOrEqual(cap);
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
    await expectNothingUnderTheBox(page, textarea);

    await page.keyboard.press("Escape");
    await expect(thread.getByTestId("comment-composer")).toHaveCount(0);
    await expect(thread.getByTestId("comment-body")).toContainText("line 40");
  });

  test("a new comment grows line by line while typing and shrinks back to three lines", async () => {
    const threadsBefore = await page.getByTestId("comment-thread").count();
    await selectTextInRich(page, "Third paragraph");
    await page.getByTestId("tb-comment").click();
    const pending = page.getByTestId("pending-comment");
    const textarea = pending.getByTestId("comment-composer");
    await expect(textarea).toBeFocused();

    const before = await metrics(textarea);
    expect(before.offsetHeight).toBe(REST_HEIGHT);
    for (let i = 1; i <= 6; i++) {
      if (i > 1) await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`line ${i}`);
    }
    await expect(textarea).toHaveValue(lines(6));
    const after = await metrics(textarea);
    console.log(`[984] §4.4 new comment: clientHeight before=${before.clientHeight} (offsetHeight ${before.offsetHeight}) after 6 lines=${after.clientHeight} (offsetHeight ${after.offsetHeight}, scrollHeight ${after.scrollHeight})`);
    expect(after.clientHeight).toBeGreaterThan(before.clientHeight);
    expect(after.scrollHeight - after.clientHeight).toBeLessThanOrEqual(2);

    await expectNothingUnderTheBox(page, textarea);
    const tip = await hoverShortcuts(page, pending);
    await expect(tip).toContainText("Enter sends");
    await expect(tip).not.toContainText("Esc cancels");
    await dismissTooltip(page);

    await textarea.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    await expect(textarea).toHaveValue("");
    await expect.poll(() => textarea.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(REST_HEIGHT);
    const shrunk = await metrics(textarea);
    console.log(`[984] §4.4 new comment after deleting: clientHeight=${shrunk.clientHeight} offsetHeight=${shrunk.offsetHeight}`);

    // Esc drops the pending comment (existing behaviour); no thread was created.
    await page.keyboard.press("Escape");
    await expect(pending).toHaveCount(0);
    await expect(page.getByTestId("comment-thread")).toHaveCount(threadsBefore);
  });

  test("a reply composer has nothing under the box, and editing a reply spans the card too", async () => {
    const thread = await addThread(page, docId, "Fourth paragraph", "Root of the reply test.");
    await thread.locator('button[data-testid="comment-reply"]').click();
    const textarea = thread.getByTestId("comment-composer");
    await expect(textarea).toBeFocused();
    await page.keyboard.type("A reply.");
    await expectNothingUnderTheBox(page, textarea);
    const tip = await hoverShortcuts(page, thread);
    await expect(tip).toContainText("Enter sends");
    await dismissTooltip(page);
    await textarea.focus();
    await page.keyboard.press("Enter");

    const reply = thread.locator('[data-testid="comment-reply"][data-reply-id]');
    await expect(reply).toHaveCount(1);
    await expect(reply.getByTestId("comment-body")).toHaveText("A reply.");
    const edit = await openEdit(page, reply, "Reply actions");
    await expect(edit).toHaveValue("A reply.");
    const m = await metrics(edit);
    const card = await cardMetrics(thread);
    const replyBox = await cardMetrics(reply);
    console.log(`[984] §4.3 edit reply: textarea width=${m.width.toFixed(1)} card clientWidth=${card.clientWidth} ratio=${(m.width / card.clientWidth).toFixed(3)} indent from reply=${(m.left - replyBox.left).toFixed(1)}px`);
    expect(m.width).toBeGreaterThanOrEqual(0.9 * card.clientWidth);
    expect(m.left - replyBox.left).toBeLessThanOrEqual(1);
    await expectNothingUnderTheBox(page, edit);
    const editTip = await hoverShortcuts(page, reply);
    await expect(editTip).toContainText("Esc cancels");
    await dismissTooltip(page);

    await edit.focus();
    await page.keyboard.type(" EDITED");
    await page.keyboard.press("Escape");
    await expect(reply.getByTestId("comment-composer")).toHaveCount(0);
    await expect(reply.getByTestId("comment-body")).toHaveText("A reply.");
    await expect(reply.getByTestId("comment-edited")).toHaveCount(0);
  });
});
