import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "@playwright/test";
import { createDocument, shareWith, signIn, uniqueLogin, waitForEditor } from "./helpers";

/**
 * A comment started while a collaborator types before the selection (#2258).
 *
 * Two real browser contexts on one document. Bob types (or deletes) steadily with real keys; Alice selects
 * a word with a real drag or real keys and starts a comment with a real click, tap or shortcut. The
 * pending comment must quote and highlight the text Alice selected, however many of Bob's keys land
 * between her selection, her click, the composer opening, her typing and her posting, and the posted
 * comment must sit on that text for both of them, in the stored thread and after a reload.
 *
 * No React props, no handler calls and no dev-only hooks, so the file runs unchanged against a production
 * build (`PROD_BASE_URL`). The only timers are the subject of the test: Bob's typing rhythm and the gap
 * between two clicks. Everything else waits for something the page shows.
 */

type Layout = "split" | "rich";
type StoredSession = Awaited<ReturnType<BrowserContext["storageState"]>>;

const DOC = ["# Title", "", "Intro.", "", "Lead words. Target paragraph.", "", "After text.", ""].join("\n");
/** A paragraph above the selection with something to delete. */
const FILLED = "Intro. " + Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, "0")}`).join(" ");
const DOC_TO_DELETE_FROM = DOC.replace("Intro.", FILLED);

const users: Record<"owner" | "editor" | "commenter", { login: string; state: StoredSession }> = {} as never;

test.beforeAll(async ({ browser }, workerInfo) => {
  for (const role of ["owner", "editor", "commenter"] as const) {
    const signedIn = await signIn(browser, uniqueLogin(`anchor-${role}-${workerInfo.workerIndex}`));
    users[role] = { login: signedIn.login, state: await signedIn.context.storageState() };
    await signedIn.context.close();
  }
});

/** Open `/d/<id>` as `role` in a fresh context, with the layout stored before the editor reads it. */
async function openAs(browser: Browser, role: keyof typeof users, id: string, layout: Layout = "split", options: BrowserContextOptions = {}) {
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
  // A commenter cannot edit, so there is nothing of hers to save: the text arriving is her "ready".
  if (role !== "commenter") await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  await expect(page.locator(".md-rich")).toContainText("Target paragraph.");
  if (layout === "split") await expect(page.locator(".cm-content")).toContainText("Target paragraph.");
  return { context, page };
}

/** A new document owned by Alice and shared with Bob as an editor and with Carol as a commenter. */
async function newDocument(browser: Browser, content = DOC) {
  const context = await browser.newContext({ storageState: users.owner.state });
  const page = await context.newPage();
  const id = await createDocument(page, content, "Comment anchor");
  await shareWith(page, id, users.editor.login, "editor");
  await shareWith(page, id, users.commenter.login, "commenter");
  await context.close();
  return id;
}

const bubble = (page: Page) => page.getByTestId("selection-bubble");
const bubbleComment = (page: Page) => bubble(page).getByRole("button", { name: "Comment", exact: true });
const pending = (page: Page) => page.getByTestId("pending-comment");
const composer = (page: Page) => pending(page).getByTestId("comment-composer");
const panel = (page: Page) => page.getByTestId("comments-panel");
const placeHold = (page: Page) => page.getByTestId("place-hold");
const selectedText = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? "");

/** Client-coordinate box of the first rendered occurrence of `text` under `root` (DOM only). */
async function textBox(page: Page, root: string, text: string) {
  return page.locator(root).evaluate((element, needle) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".md-remote-caret, .cm-ySelectionCaret, .cm-ySelectionInfo")) continue;
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
}

/** The text of the first block in the preview that matches `selector`, without remote caret labels. */
const blockText = (page: Page, selector: string) =>
  page
    .locator(".md-rich")
    .locator(selector)
    .first()
    .evaluate((block) => {
      const clone = block.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".md-remote-caret").forEach((n) => n.remove());
      return clone.textContent ?? "";
    });

/** A point on `control`, in the middle of it. */
async function pointOn(control: Locator) {
  const box = await control.boundingBox();
  expect(box, "the control is on screen").not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/**
 * Select `text` in the preview with a real mouse drag. Bob may be typing above it, and a line of his
 * that wraps moves the word between the aim and the drag: the drag is then made again. The caret is
 * parked at the far right of the "After text." line first, so a drag never starts on a selection (that
 * would drag the text instead).
 */
async function dragSelect(page: Page, text: string) {
  await expect(page.locator(".md-rich")).toContainText(text);
  let made = "";
  for (let attempt = 0; attempt < 10 && made !== text; attempt++) {
    const park = await textBox(page, ".md-rich", "After text.");
    const pane = (await page.locator(".md-rich").boundingBox())!;
    if (!park) continue;
    await page.mouse.click(pane.x + pane.width - 4, park.y);
    const box = await textBox(page, ".md-rich", text);
    if (!box) continue;
    await page.mouse.move(box.left + 1, box.y);
    await page.mouse.down();
    await page.mouse.move((box.left + box.right) / 2, box.y, { steps: 2 });
    await page.mouse.move(box.right - 1, box.y, { steps: 2 });
    await page.mouse.up();
    made = await selectedText(page);
  }
  expect(made, `the drag selects "${text}"`).toBe(text);
  await expect(bubble(page), "the bubble shows once the editor holds the selection").toBeVisible();
}

/**
 * Select the word `text` in the Markdown pane with a real double-click (CodeMirror selects the word
 * itself, without the space after it, on every platform). Made again when the word moved under the pointer.
 */
async function selectInCode(page: Page, text: string) {
  await expect(page.locator(".cm-content")).toContainText(text);
  let made = "";
  for (let attempt = 0; attempt < 10 && made !== text; attempt++) {
    const box = await textBox(page, ".cm-content", text);
    if (!box) continue;
    await page.mouse.dblclick((box.left + box.right) / 2, box.y);
    made = await selectedText(page);
  }
  expect(made, `the double-click selects "${text}"`).toBe(text);
}

/** Put the caret at the end of the line that holds `text`, in the preview, with a real click and End. */
async function caretAtEndOf(page: Page, text: string) {
  const box = await textBox(page, ".md-rich", text);
  expect(box, `"${text}" is rendered`).not.toBeNull();
  await page.mouse.click(box!.right - 1, box!.y);
  await page.keyboard.press("End");
}

/** Put the caret right after `text` (the start of its line), in the preview, with a real click and keys. */
async function caretAfterLineStart(page: Page, text: string) {
  const box = await textBox(page, ".md-rich", text);
  expect(box, `"${text}" is rendered`).not.toBeNull();
  await page.mouse.click(box!.left + 2, box!.y);
  await page.keyboard.press("Home");
  for (let i = 0; i < text.length; i++) await page.keyboard.press("ArrowRight");
}

/**
 * One real key every `everyMs` ms on `page`, on a fixed schedule, until stopped or `max` keys are out.
 * The rhythm is the subject: this is the collaborator who keeps typing. `Backspace` deletes instead.
 *
 * After its first `HELD_AFTER` keys the typing holds until `release()`: a line of Bob's that wraps
 * moves the bubble, and Alice has to aim at it. Her press goes out right behind `release()`, so his
 * keys land between her selection and her press, while her press is handled, and from then on.
 */
const HELD_AFTER = 3;
function typeSteadily(page: Page, everyMs: number, { key, max = 400 }: { key?: "Backspace"; max?: number } = {}) {
  let stopped = false;
  let sent = 0;
  let started = Date.now();
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = (async () => {
    while (!stopped && sent < max) {
      await page.keyboard.press(key ?? (sent % 5 === 4 ? "Space" : "abcdefghijklmnopqrstuvwxyz"[sent % 26])).catch(() => undefined);
      sent++;
      if (sent === HELD_AFTER) {
        await released;
        started = Date.now() - sent * everyMs;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, started + sent * everyMs - Date.now())));
    }
  })();
  return {
    /** Let the typing go on after its first keys. */
    release,
    /** Stop now; resolves with how many keys went out. */
    async stop() {
      stopped = true;
      release();
      await done;
      return sent;
    },
    /** Resolves once all `max` keys are out. */
    finished: done,
  };
}

/** Bob takes back what he typed, with his own Ctrl+Z, so the next try starts from the same text. */
async function takeBack(page: Page, selector: string, original: string) {
  for (let i = 0; i < 80 && (await blockText(page, selector)) !== original; i++) await page.keyboard.press("Control+z");
  await expect.poll(() => blockText(page, selector), { message: "Bob's Ctrl+Z takes his typing back" }).toBe(original);
}

/** How long the block `selector` is on `page` now: the mark `arrived` counts from. */
const lengthOf = async (page: Page, selector: string) => (await blockText(page, selector)).length;

/**
 * Wait until `count` more characters (fewer, for a delete) have arrived in the block `selector` on `page`,
 * counted from now, or from the length `since` that was read before Bob started.
 */
async function arrived(page: Page, selector: string, count: number, since?: number) {
  const before = since ?? (await lengthOf(page, selector));
  await expect
    .poll(async () => Math.abs((await blockText(page, selector)).length - before), { message: `${count} more of Bob's keys arrive`, intervals: [20, 40, 80] })
    .toBeGreaterThanOrEqual(count);
}

/** What the page shows of the pending comment, read in one go: no waiting, no retry. */
const shown = (page: Page) =>
  page.evaluate(() => {
    const strip = (element: Element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".md-remote-caret, .cm-ySelectionCaret, .cm-ySelectionInfo").forEach((n) => n.remove());
      return clone.textContent ?? "";
    };
    const drawn = (root: string) => Array.from(document.querySelectorAll(`${root} [data-highlight-id="pending"]`), strip).join("");
    // A phone shows one pane: the Markdown pane is then not on screen.
    const markdownPane = document.querySelector(".cm-content");
    return {
      quote: document.querySelector('[data-testid="pending-comment"] [data-testid="comment-quote"]')?.textContent ?? null,
      preview: drawn(".md-rich"),
      markdown: markdownPane && markdownPane.getClientRects().length ? drawn(".cm-content") : null,
      composers: document.querySelectorAll('[data-testid="pending-comment"]').length,
    };
  });
const onText = (text: string, markdownPane = true) => ({ quote: text, preview: text, markdown: markdownPane ? text : null, composers: 1 });

/** What the page shows of the one posted comment: its card's quote and the text its highlight is on. */
const posted = (page: Page) =>
  page.evaluate(() => {
    const strip = (element: Element) => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".md-remote-caret, .cm-ySelectionCaret, .cm-ySelectionInfo").forEach((n) => n.remove());
      return clone.textContent ?? "";
    };
    const drawn = (root: string) => Array.from(document.querySelectorAll(`${root} [data-highlight-kind="comment"]:not([data-highlight-id="pending"])`), strip).join("");
    return {
      card: document.querySelector('[data-testid="comment-thread"] [data-testid="comment-quote"]')?.textContent ?? null,
      preview: drawn(".md-rich"),
      markdown: drawn(".cm-content"),
    };
  });

interface StoredThread {
  id: string;
  body: string;
  quote: string;
  currentText: string | null;
}
/** The threads as the server holds them. */
async function storedThreads(page: Page, id: string) {
  const response = await page.request.get(`/api/documents/${id}/comments`);
  expect(response.ok(), "GET comments").toBeTruthy();
  return ((await response.json()) as { comments: StoredThread[] }).comments;
}

/** Close the Comments panel when it is open: it comes in again with the next comment and moves the text. */
async function closePanel(page: Page) {
  if (await panel(page).count()) await page.getByRole("button", { name: "Close comments" }).click();
  await expect(panel(page)).toHaveCount(0);
}

/** Cancel the pending comment from its composer with a real Escape. */
async function cancelPending(page: Page) {
  if (!(await composer(page).evaluate((element) => element === document.activeElement))) await composer(page).click();
  await page.keyboard.press("Escape");
  await expect(pending(page)).toHaveCount(0);
}

type Start = "bubble" | "tap" | "toolbar" | "shortcut" | "palette";
/** Start a comment on the current selection the way a person would. Bob's held typing goes on as the press goes out. */
async function startComment(page: Page, how: Start, typing?: { release: () => void }) {
  if (how === "bubble" || how === "tap") {
    const point = await pointOn(bubbleComment(page));
    typing?.release();
    if (how === "bubble") await page.mouse.click(point.x, point.y);
    else await page.touchscreen.tap(point.x, point.y);
  } else if (how === "toolbar") {
    const point = await pointOn(page.getByTestId("tb-comment"));
    typing?.release();
    await page.mouse.click(point.x, point.y);
  } else if (how === "shortcut") {
    typing?.release();
    await page.keyboard.press("Control+Alt+m");
  } else {
    typing?.release();
    // Two things about the palette that are not this spec's subject, and that only a robot's speed shows.
    // 1. When the palette hands focus back, the browser puts a caret at the start of the document, and
    //    ProseMirror puts the selection back only when the person's last press in the editor is more than
    //    300 ms old. Nobody opens the palette, types seven letters and picks an item that fast; this
    //    robot does, and the comment would then be about the whole document. So it waits that long.
    await page.waitForTimeout(350);
    await page.keyboard.press("Control+Shift+p");
    await page.getByTestId("palette-input").waitFor();
    await page.keyboard.type("Comment");
    // 2. The palette does not take every press while a collaborator's keys arrive: now and then it stays
    //    open, focus still in its input (on main as well). A person presses again, and so does this.
    for (let press = 0; press < 3; press++) {
      const point = await pointOn(page.getByTestId("palette-item-block:comment"));
      await page.mouse.click(point.x, point.y);
      const taken = await page.getByTestId("palette-input").waitFor({ state: "detached", timeout: 1_500 }).then(
        () => true,
        () => false,
      );
      if (taken) break;
    }
  }
  await expect(pending(page), `${how}: the composer opens`).toBeVisible();
}

test.describe("a comment started while a collaborator types before the selection", () => {
  test("the pending comment quotes and highlights the selected text, 20 of 20, with the collaborator typing at the end of the title", async ({ browser }) => {
    test.setTimeout(420_000);
    const id = await newDocument(browser);
    const alice = await openAs(browser, "owner", id);
    const bob = await openAs(browser, "editor", id);
    const wrong: string[] = [];

    for (let n = 0; n < 20; n++) {
      const everyMs = n % 2 ? 100 : 30;
      const step = `try ${n + 1}, one key per ${everyMs} ms`;
      await closePanel(alice.page);
      await dragSelect(alice.page, "Target");
      await caretAtEndOf(bob.page, "Title");
      const mark = await lengthOf(alice.page, "h1");
      const typing = typeSteadily(bob.page, everyMs);
      try {
        // Keys of Bob's land between the selection and the click, and between the click and the composer.
        await arrived(alice.page, "h1", 2, mark);
        await startComment(alice.page, "bubble", typing);
        const first = await shown(alice.page);
        await expect(composer(alice.page), `${step}: the composer has focus`).toBeFocused();
        // And they keep landing while the composer is open.
        await arrived(alice.page, "h1", 20);
        const later = await shown(alice.page);
        for (const [when, seen] of [["as the composer opens", first], ["20 keys later", later]] as const) {
          if (JSON.stringify(seen) !== JSON.stringify(onText("Target"))) wrong.push(`${step}, ${when}: ${JSON.stringify(seen)}`);
        }
        await cancelPending(alice.page);
      } finally {
        await typing.stop();
      }
      await takeBack(bob.page, "h1", "Title");
    }
    expect(wrong, "every try quotes and highlights the selected text in both panes").toEqual([]);
    await alice.context.close();
    await bob.context.close();
  });

  test("the posted comment sits on the selected text for both people, in the stored thread, after a reload and in a fresh context", async ({ browser }) => {
    test.setTimeout(240_000);
    const id = await newDocument(browser);
    const alice = await openAs(browser, "owner", id);
    const bob = await openAs(browser, "editor", id);

    await dragSelect(alice.page, "Target");
    await caretAtEndOf(bob.page, "Intro.");
    const mark = await lengthOf(alice.page, "p");
    const typing = typeSteadily(bob.page, 30, { max: 600 });
    try {
      await arrived(alice.page, "p", 2, mark);
      await startComment(alice.page, "bubble", typing);
      await expect(composer(alice.page)).toBeFocused();
      // Alice writes her comment with real keys while Bob keeps typing, and posts it.
      await alice.page.keyboard.type("About the target");
      await arrived(alice.page, "p", 10);
      expect(await shown(alice.page), "right before posting").toEqual(onText("Target"));
      await alice.page.keyboard.press("Control+Enter");
      await expect(pending(alice.page)).toHaveCount(0);
      await expect(alice.page.getByTestId("comment-thread")).toHaveCount(1);

      // Bob is still typing: the posted comment stays on the text for both of them.
      await arrived(alice.page, "p", 10);
      expect(await posted(alice.page), "Alice, while Bob still types").toEqual({ card: "Target", preview: "Target", markdown: "Target" });
      await expect(bob.page.locator('.md-rich [data-highlight-kind="comment"]')).toHaveText("Target");
      expect(await posted(bob.page), "Bob, while he still types").toMatchObject({ preview: "Target", markdown: "Target" });
    } finally {
      await typing.stop();
    }

    // The thread as the server holds it.
    await expect
      .poll(async () => (await storedThreads(alice.page, id)).map(({ body, quote, currentText }) => ({ body, quote, currentText })), { message: "the stored thread" })
      .toEqual([{ body: "About the target", quote: "Target", currentText: "Target" }]);

    // After a reload, and for someone who opens the document for the first time.
    await expect(bob.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(alice.page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await alice.page.reload();
    await waitForEditor(alice.page);
    await expect(alice.page.locator('.md-rich [data-highlight-kind="comment"]'), "after a reload").toHaveText("Target");
    await expect(alice.page.locator('.cm-content [data-highlight-kind="comment"]'), "after a reload, Markdown pane").toHaveText("Target");
    const fresh = await openAs(browser, "editor", id);
    await expect(fresh.page.locator('.md-rich [data-highlight-kind="comment"]'), "in a fresh context").toHaveText("Target");
    await fresh.page.locator('.md-rich [data-highlight-kind="comment"]').click();
    await expect(fresh.page.getByTestId("comment-thread").getByTestId("comment-quote"), "the card in a fresh context").toHaveText("Target");

    await fresh.context.close();
    await alice.context.close();
    await bob.context.close();
  });

  for (const pane of ["preview", "Markdown pane"] as const) {
    test(`${pane}: the toolbar's Comment, the shortcut and the command palette, with the collaborator typing in the same paragraph`, async ({ browser }) => {
      test.setTimeout(240_000);
      const id = await newDocument(browser);
      const alice = await openAs(browser, "owner", id);
      const bob = await openAs(browser, "editor", id);
      const paragraph = "p:has-text('paragraph.')";

      for (const how of ["toolbar", "shortcut", "palette"] as const) {
        // Alice selects first; then Bob types right before her selection, in the same line.
        await closePanel(alice.page);
        if (pane === "preview") await dragSelect(alice.page, "Target");
        else await selectInCode(alice.page, "Target");
        await caretAfterLineStart(bob.page, "Lead");
        const mark = await lengthOf(alice.page, paragraph);
        // Long enough for the slowest way in: the palette step waits 350 ms and may press up to three times,
        // and 15 of Bob's keys must still arrive after the composer has focus.
        const typing = typeSteadily(bob.page, 30, { max: 400 });
        try {
          await arrived(alice.page, paragraph, 2, mark);
          await startComment(alice.page, how, typing);
          const first = await shown(alice.page);
          await expect(composer(alice.page), `${how}: the composer has focus`).toBeFocused();
          await arrived(alice.page, paragraph, 15);
          expect([first, await shown(alice.page)], `${how}: as the composer opens, and 15 keys later`).toEqual([onText("Target"), onText("Target")]);
          await cancelPending(alice.page);
        } finally {
          await typing.stop();
        }
        await takeBack(bob.page, paragraph, "Lead words. Target paragraph.");
      }
      await alice.context.close();
      await bob.context.close();
    });
  }

  test("a tap on the bubble's Comment, and the collaborator deleting text above the selection", async ({ browser }) => {
    test.setTimeout(240_000);
    const id = await newDocument(browser, DOC_TO_DELETE_FROM);
    const alice = await openAs(browser, "owner", id, "split", { hasTouch: true });
    const bob = await openAs(browser, "editor", id);

    await dragSelect(alice.page, "Target");
    await caretAtEndOf(bob.page, "w29");
    const mark = await lengthOf(alice.page, "p");
    const deleting = typeSteadily(bob.page, 30, { key: "Backspace", max: FILLED.length - "Intro. ".length });
    try {
      await arrived(alice.page, "p", 2, mark);
      await startComment(alice.page, "tap", deleting);
      const first = await shown(alice.page);
      await expect(composer(alice.page)).toBeFocused();
      await arrived(alice.page, "p", 20);
      expect([first, await shown(alice.page)], "as the composer opens, and 20 deleted characters later").toEqual([onText("Target"), onText("Target")]);
      await alice.page.keyboard.type("Still the target");
      await alice.page.keyboard.press("Control+Enter");
      await expect(pending(alice.page)).toHaveCount(0);
    } finally {
      await deleting.stop();
    }
    await expect
      .poll(async () => (await storedThreads(alice.page, id)).map(({ quote, currentText }) => ({ quote, currentText })), { message: "the stored thread" })
      .toEqual([{ quote: "Target", currentText: "Target" }]);
    expect(await posted(alice.page)).toEqual({ card: "Target", preview: "Target", markdown: "Target" });
    await expect(bob.page.locator('.md-rich [data-highlight-kind="comment"]')).toHaveText("Target");
    await alice.context.close();
    await bob.context.close();
  });

  test("a commenter, whose comment is posted through the API, gets it on the text she selected too", async ({ browser }) => {
    test.setTimeout(240_000);
    const id = await newDocument(browser);
    const carol = await openAs(browser, "commenter", id);
    const bob = await openAs(browser, "editor", id);
    const wrong: string[] = [];

    for (let n = 0; n < 6; n++) {
      const everyMs = n % 2 ? 100 : 30;
      const body = `Carol's comment ${n + 1}`;
      await closePanel(carol.page);
      await dragSelect(carol.page, "Target");
      await caretAtEndOf(bob.page, "Title");
      const mark = await lengthOf(carol.page, "h1");
      const typing = typeSteadily(bob.page, everyMs);
      try {
        await arrived(carol.page, "h1", 2, mark);
        await startComment(carol.page, "bubble", typing);
        await expect(composer(carol.page)).toBeFocused();
        await carol.page.keyboard.type(body);
        const before = await shown(carol.page);
        // Bob's keys are on their way to the server while her post is.
        await carol.page.keyboard.press("Control+Enter");
        await expect(pending(carol.page)).toHaveCount(0);
        let stored: StoredThread | undefined;
        await expect.poll(async () => Boolean((stored = (await storedThreads(carol.page, id)).find((thread) => thread.body === body))), { message: "the thread is stored" }).toBe(true);
        await expect(carol.page.locator(`.md-rich [data-highlight-id="${stored!.id}"]`).first()).toBeVisible();
        await expect(bob.page.locator(`.md-rich [data-highlight-id="${stored!.id}"]`).first()).toBeVisible();
        await arrived(carol.page, "h1", 5);
        const drawn = async (page: Page) => (await page.locator(`.md-rich [data-highlight-id="${stored!.id}"]`).allTextContents()).join("");
        const seen = { before, quote: stored!.quote, currentText: stored!.currentText, carol: await drawn(carol.page), bob: await drawn(bob.page) };
        if (JSON.stringify(seen) !== JSON.stringify({ before: onText("Target"), quote: "Target", currentText: "Target", carol: "Target", bob: "Target" })) {
          wrong.push(`try ${n + 1}, one key per ${everyMs} ms: ${JSON.stringify(seen)}`);
        }
        // The next try starts without a thread on the word (clean-up through the API, not part of the test).
        expect((await carol.page.request.post(`/api/documents/${id}/comments`, { data: { action: "delete", threadId: stored!.id } })).ok()).toBeTruthy();
        await expect(carol.page.locator(`.md-rich [data-highlight-id="${stored!.id}"]`)).toHaveCount(0);
      } finally {
        await typing.stop();
      }
      await takeBack(bob.page, "h1", "Title");
    }
    expect(wrong, "every post is stored and drawn on the selected text").toEqual([]);
    await carol.context.close();
    await bob.context.close();
  });

  test("Undo by the person who comments takes back only her own typing: the collaborator's text stays and the comment stays on its text", async ({ browser }) => {
    test.setTimeout(240_000);
    const id = await newDocument(browser);
    const alice = await openAs(browser, "owner", id);
    const bob = await openAs(browser, "editor", id);
    const undo = alice.page.getByTestId("toolbar").getByRole("button", { name: "Undo", exact: true });

    // Alice types something of her own first, so her Undo has something to take back.
    await caretAtEndOf(alice.page, "After text.");
    await alice.page.keyboard.type(" Mine");
    await expect(bob.page.locator(".md-rich")).toContainText("After text. Mine");

    await dragSelect(alice.page, "Target");
    await caretAtEndOf(bob.page, "Title");
    const mark = await lengthOf(alice.page, "h1");
    const typing = typeSteadily(bob.page, 30, { max: 300 });
    let title = "";
    try {
      await arrived(alice.page, "h1", 2, mark);
      await startComment(alice.page, "bubble", typing);
      await arrived(alice.page, "h1", 5);

      // Undo with the comment pending: her " Mine" goes, Bob's title stays and grows, the quote stays.
      const before = (await blockText(alice.page, "h1")).length;
      await undo.click();
      await expect(alice.page.locator(".md-rich")).not.toContainText("Mine");
      expect((await blockText(alice.page, "h1")).length, "Bob's typing is not undone").toBeGreaterThanOrEqual(before);
      await arrived(alice.page, "h1", 5);
      expect(await shown(alice.page), "after Undo, with the comment pending").toEqual(onText("Target"));

      await composer(alice.page).click();
      await alice.page.keyboard.type("Posted after an undo");
      await alice.page.keyboard.press("Control+Enter");
      await expect(pending(alice.page)).toHaveCount(0);
    } finally {
      await typing.stop();
    }
    await expect.poll(async () => (title = await blockText(bob.page, "h1")) === (await blockText(alice.page, "h1")), { message: "both have all of Bob's title" }).toBe(true);
    expect(title.length, "Bob typed in the title").toBeGreaterThan("Title".length + 10);

    // Redo and Undo after posting: the comment stays on its text and Bob's title is untouched.
    await alice.page.getByTestId("toolbar").getByRole("button", { name: "Redo", exact: true }).click();
    await expect(alice.page.locator(".md-rich")).toContainText("After text. Mine");
    await undo.click();
    await expect(alice.page.locator(".md-rich")).not.toContainText("Mine");
    expect(await blockText(alice.page, "h1"), "Bob's title after Alice's Redo and Undo").toBe(title);
    expect(await posted(alice.page)).toEqual({ card: "Target", preview: "Target", markdown: "Target" });
    await expect(bob.page.locator('.md-rich [data-highlight-kind="comment"]')).toHaveText("Target");
    await expect.poll(async () => (await storedThreads(alice.page, id)).map(({ quote, currentText }) => ({ quote, currentText }))).toEqual([{ quote: "Target", currentText: "Target" }]);
    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("the collaborator edits the selected text itself while the composer is open", () => {
  /** Alice has the composer open on "Target"; Bob is ready to edit the word. */
  async function opened(browser: Browser) {
    const id = await newDocument(browser);
    const alice = await openAs(browser, "owner", id);
    const bob = await openAs(browser, "editor", id);
    await dragSelect(alice.page, "Target");
    await startComment(alice.page, "bubble");
    await expect(composer(alice.page)).toBeFocused();
    expect(await shown(alice.page)).toEqual(onText("Target"));
    return { id, alice, bob };
  }
  /**
   * Bob's caret right after the first `prefix` in the preview, with a real click. (Alice's selection is
   * drawn for Bob as a mark of its own, so the word is a text node by itself on his side.)
   */
  async function caretAfter(page: Page, prefix: string) {
    const box = await textBox(page, ".md-rich", prefix);
    expect(box, `"${prefix}" is rendered`).not.toBeNull();
    await page.mouse.click(box!.right, box!.y);
  }
  const paragraph = "p:has-text('agraph.')";
  const post = async (page: Page, body: string) => {
    await page.keyboard.type(body);
    await page.keyboard.press("Control+Enter");
    await expect(pending(page)).toHaveCount(0);
  };
  const stored = async (page: Page, id: string) => (await storedThreads(page, id)).map(({ quote, currentText }) => ({ quote, currentText }));

  test("typed into: the quote and the highlight grow with it, and that text is what is posted", async ({ browser }) => {
    const { id, alice, bob } = await opened(browser);
    await caretAfter(bob.page, "Tar");
    await bob.page.keyboard.type("XY");
    await expect.poll(() => blockText(alice.page, paragraph)).toBe("Lead words. TarXYget paragraph.");
    await expect(pending(alice.page).getByTestId("comment-quote")).toHaveText("TarXYget");
    expect(await shown(alice.page)).toEqual(onText("TarXYget"));
    await expect(composer(alice.page), "the composer keeps focus").toBeFocused();
    await post(alice.page, "Grown");
    await expect.poll(() => stored(alice.page, id)).toEqual([{ quote: "TarXYget", currentText: "TarXYget" }]);
    expect(await posted(alice.page)).toEqual({ card: "TarXYget", preview: "TarXYget", markdown: "TarXYget" });
    await alice.context.close();
    await bob.context.close();
  });

  test("partly deleted: the quote and the highlight keep what is left, and that text is what is posted", async ({ browser }) => {
    const { id, alice, bob } = await opened(browser);
    // Bob deletes across the start of the word: "s. Ta" goes.
    await caretAfter(bob.page, "Ta");
    for (let i = 0; i < 5; i++) await bob.page.keyboard.press("Backspace");
    await expect.poll(() => blockText(alice.page, paragraph)).toBe("Lead wordrget paragraph.");
    await expect(pending(alice.page).getByTestId("comment-quote")).toHaveText("rget");
    expect(await shown(alice.page)).toEqual(onText("rget"));
    await post(alice.page, "Shrunk");
    await expect.poll(() => stored(alice.page, id)).toEqual([{ quote: "rget", currentText: "rget" }]);
    expect(await posted(alice.page)).toEqual({ card: "rget", preview: "rget", markdown: "rget" });
    await alice.context.close();
    await bob.context.close();
  });

  test("wholly deleted: the composer stays, with no quote and no highlight, and the comment is posted without a quote", async ({ browser }) => {
    const { id, alice, bob } = await opened(browser);
    // Bob selects the sentence around the word (a click, then Shift and a click) and deletes it.
    await caretAfter(bob.page, "Lead");
    const end = await textBox(bob.page, ".md-rich", " par");
    expect(end, '" par" is rendered').not.toBeNull();
    await bob.page.keyboard.down("Shift");
    await bob.page.mouse.click(end!.right, end!.y);
    await bob.page.keyboard.up("Shift");
    await bob.page.keyboard.press("Backspace");
    await expect.poll(() => blockText(alice.page, paragraph)).toBe("Leadagraph.");
    await expect(pending(alice.page).getByTestId("comment-quote"), "the placeholder the composer always had for an empty range").toHaveText("Selected text");
    expect(await shown(alice.page)).toMatchObject({ preview: "", markdown: "", composers: 1 });
    await expect(composer(alice.page), "the composer keeps focus and what was typed").toBeFocused();
    await post(alice.page, "The text is gone");
    await expect.poll(() => stored(alice.page, id)).toEqual([{ quote: "", currentText: "" }]);
    await expect(alice.page.getByTestId("comment-thread")).toHaveCount(1);
    await expect(alice.page.getByTestId("comment-thread").getByTestId("comment-quote")).toHaveCount(0);
    await alice.context.close();
    await bob.context.close();
  });
});

/** Start a fresh record of what every pointer press lands on. The page gets one listener that only looks. */
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
      ["[data-testid=comments-panel]", "Comments panel"],
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
/** Every pointer press since the record was started: when it came (ms, the page's clock) and what it landed on. */
const presses = (page: Page): Promise<{ at: number; on: string }[]> =>
  page.evaluate(() => (window as unknown as { __presses: { at: number; on: string }[] }).__presses.map((press) => ({ ...press })));
/**
 * The box that keeps the bubble's place lives 600 ms from the first press (press-once.tsx). A second
 * press that the page gets later than that is not the rest of the gesture any more: on a machine too
 * busy to deliver two clicks 400 ms apart in time, the try is made again instead of judged.
 */
const BOX_LIFE_MS = 600;

interface Gesture {
  name: string;
  touch?: true;
  run: (page: Page, x: number, y: number) => Promise<void>;
}
const twoClicks = (gap: number): Gesture => ({
  name: `two clicks ${gap} ms apart`,
  async run(page, x, y) {
    const first = Date.now();
    await page.mouse.click(x, y);
    // The gap is the subject. It is counted from when the first click went out, as a hand's is: the
    // call above only returns once the page has handled that click, and the panel opens in that time.
    await page.waitForTimeout(Math.max(0, gap - (Date.now() - first)));
    await page.mouse.click(x, y);
  },
});
const GESTURES: Gesture[] = [
  { name: "a double-click", run: (page, x, y) => page.mouse.dblclick(x, y) },
  twoClicks(120),
  twoClicks(400),
  {
    name: "a double tap",
    touch: true,
    async run(page, x, y) {
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
    },
  },
];

test.describe("the rest of a double-click or a double tap on the bubble's Comment", () => {
  for (const size of [
    { name: "1440 px", layout: "split" as const, options: {} },
    { name: "390 px", layout: "rich" as const, options: { viewport: { width: 390, height: 844 } } },
  ]) {
    for (const typingOn of [true, false]) {
      test(`${size.name}, the collaborator ${typingOn ? "typing above the selection" : "idle"}: one composer, it keeps focus, and nothing else is pressed`, async ({ browser }) => {
        test.setTimeout(300_000);
        const id = await newDocument(browser);
        const alice = await openAs(browser, "owner", id, size.layout, { ...size.options, hasTouch: true });
        const bob = await openAs(browser, "editor", id);
        await watchPresses(alice.page);
        let judged = 0;

        for (const gesture of GESTURES) {
          for (let n = 0, late = 0; n < 2; ) {
            const step = `${gesture.name}, try ${n + 1}`;
            // The panel coming in makes the preview narrower, and the text moves under the pointer.
            await closePanel(alice.page);
            await dragSelect(alice.page, "Target");
            await caretAtEndOf(bob.page, "Intro.");
            // Bob types a short run that stays on one line. One key per 100 ms: on the dev server a faster
            // collaborator keeps the page too busy to get two clicks 400 ms apart inside the box's 600 ms.
            const mark = await lengthOf(alice.page, "p");
            const typing = typingOn ? typeSteadily(bob.page, 100, { max: 14 }) : null;
            let gap = 0;
            try {
              if (typing) await arrived(alice.page, "p", 2, mark);
              const point = await pointOn(bubbleComment(alice.page));
              await watchPresses(alice.page);
              typing?.release();
              await gesture.run(alice.page, point.x, point.y);
              const pressed = await presses(alice.page);
              expect(pressed, `${step}: the page got two presses`).toHaveLength(2);
              gap = pressed[1].at - pressed[0].at;

              if (gap < BOX_LIFE_MS - 50) {
                await expect(composer(alice.page), `${step}: the composer has focus`).toBeFocused();
                if (typing) {
                  // All of Bob's run has landed, most of it after the first press.
                  await typing.finished;
                  await expect.poll(() => blockText(alice.page, "p"), { message: `${step}: Bob's run arrives` }).toBe(await blockText(bob.page, "p"));
                }
                expect(await shown(alice.page), `${step}: one composer, on the selected text`).toEqual(onText("Target", size.layout === "split"));
                expect(pressed.map((press) => press.on), `${step}: the first press is on the bubble, the next on the box in its place`).toEqual(["bubble", "box"]);
                await expect(bubble(alice.page), `${step}: the bubble does not come back`).toHaveCount(0);
                await expect(placeHold(alice.page), `${step}: the place is given back`).toHaveCount(0);
                await expect(composer(alice.page), `${step}: the composer still has focus`).toBeFocused();
              }
            } finally {
              await typing?.stop();
            }
            if (await pending(alice.page).count()) await cancelPending(alice.page);
            if (typing) await takeBack(bob.page, "p", "Intro.");
            if (gap < BOX_LIFE_MS - 50) {
              judged++;
              n++;
            } else if (++late === 3) {
              // Not a pass and not a failure: this machine did not deliver the gesture. It is written down.
              test.info().annotations.push({ type: "not judged", description: `${step}: the page got the second press ${Math.round(gap)} ms after the first, three times` });
              late = 0;
              n++;
            }
          }
        }
        // The double-click, the double tap and the clicks 120 ms apart always arrive in time.
        expect(judged, "tries that were judged, of 8").toBeGreaterThanOrEqual(6);
        await alice.context.close();
        await bob.context.close();
      });
    }
  }
});
