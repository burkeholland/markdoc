import { devices, type Browser, type Locator, type Page, type Request } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createDocument, devLogin, openDocument, uniqueLogin, waitForEditor, waitForHydration } from "./helpers";

/**
 * Commit to GitHub, Sync with GitHub and the GitHub connection dialog, driven the way a person drives
 * them: `page.mouse`, `page.keyboard` and `page.touchscreen` only. No `locator.click()` on a control under
 * test, no `fireEvent`, no script click (issue #2215; the dialogs' hand-rolled event checks are gone, #2222).
 *
 * Linked documents need the in-memory GitHub of the e2e server (GITHUB_MOCK=1). A production build has no
 * fake GitHub, so those tests skip there by asking the server; the phone sheets, the Outline drawer and
 * the dialogs of an unlinked document need no GitHub and run on a production build too (PROD_BASE_URL).
 */

const BASE = "# Dialogs\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
const REMOTE_EDIT = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");
const LOCAL_EDIT = `${BASE}\nA new local line.\n`;
const REPO = { owner: "mock", repo: "scratch", branch: "main" };
type SyncState = "in-sync" | "local-ahead" | "remote-ahead" | "diverged";
type How = "mouse" | "keyboard";
let files = 0;

const PHONE = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } };

async function signInWith(browser: Browser, name: string, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await devLogin(page, uniqueLogin(name));
  await waitForHydration(page);
  return { context, page };
}

/** Is the server's fake GitHub there? It is on the e2e dev server; a production build answers 404. */
async function hasFakeGitHub(page: Page) {
  const probe = await page.request.get(`/api/github/mock?owner=${REPO.owner}&repo=${REPO.repo}&path=probe.md`);
  return probe.status() === 200;
}

async function setRemote(page: Page, path: string, content: string, size?: number) {
  const res = await page.request.post("/api/github/mock", { data: { kind: "repo", ...REPO, path, content, ...(size === undefined ? {} : { size }) } });
  expect(res.ok()).toBeTruthy();
}
const remoteText = async (page: Page, path: string) => {
  const res = await page.request.get(`/api/github/mock?owner=${REPO.owner}&repo=${REPO.repo}&branch=${REPO.branch}&path=${encodeURIComponent(path)}`);
  return ((await res.json()) as { content: string | null }).content;
};
const documentText = async (page: Page, id: string) => ((await (await page.request.get(`/api/documents/${id}/content`)).json()) as { content: string }).content;

/** A document linked to a file of the fake repository, brought to `state` through the API before any page opens it. */
async function linkedDocument(page: Page, state: SyncState = "in-sync", more = "") {
  const base = BASE + more;
  const id = await createDocument(page, base);
  const path = `docs/dialogs-${Date.now()}-${++files}.md`;
  await setRemote(page, path, base);
  const link = await page.request.post(`/api/documents/${id}/link`, { data: { storage: "repo", ...REPO, path } });
  expect(link.ok()).toBeTruthy();
  if (state === "diverged" || state === "remote-ahead") await setRemote(page, path, REMOTE_EDIT + more);
  if (state === "diverged" || state === "local-ahead") {
    const put = await page.request.put(`/api/documents/${id}/content`, { data: { content: LOCAL_EDIT + more } });
    expect(put.ok()).toBeTruthy();
  }
  return { id, path };
}

const status = (page: Page) => page.getByTestId("publish-status");

/** Open a document on a phone or a desktop and wait until its header knows the sync state. */
async function openEditor(page: Page, id: string, state?: SyncState) {
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    // A phone shows one pane at a time, so `openDocument` (both panes visible) does not apply.
    await page.goto(`/d/${id}`);
    await waitForEditor(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  } else {
    await openDocument(page, id);
  }
  // The phone header has no status chip; the editor still polls, and the document itself says "linked".
  if (state && (page.viewportSize()?.width ?? 1440) >= 768) await expect(status(page)).toHaveAttribute("data-status", state, { timeout: 65_000 });
}

/** The box of a control once it has stopped moving: a menu or a dialog that has just opened is still fading in. */
async function settledBox(target: Locator) {
  await expect(target).toBeVisible();
  let last = "";
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await target.boundingBox());
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [40] },
    )
    .toBe(true);
  return JSON.parse(last) as { x: number; y: number; width: number; height: number };
}
async function pointOn(target: Locator, fx = 0.5, fy = 0.5) {
  const box = await settledBox(target);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}
/** One real mouse click (press and release at one point, click count 1). */
async function mouseClick(page: Page, target: Locator, fx = 0.5, fy = 0.5) {
  const { x, y } = await pointOn(target, fx, fy);
  await page.mouse.click(x, y);
}
async function tap(page: Page, target: Locator, fx = 0.5, fy = 0.5) {
  const { x, y } = await pointOn(target, fx, fy);
  await page.touchscreen.tap(x, y);
}

/** What has focus: a test id, an accessible label, or the tag; "body" when nothing has. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    if (el.classList.contains("cm-content")) return "code pane";
    if (el.classList.contains("ProseMirror")) return "rich pane";
    return el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase();
  });
/** Is focus inside the open dialog? */
const focusInDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));

/** POST requests of the page whose path matches, in order, as "path?query body". Read `.length` to count them. */
function posts(page: Page, path: RegExp) {
  const seen: string[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && path.test(url.pathname)) seen.push(`${url.pathname}${url.search} ${request.postData() ?? ""}`);
  });
  return seen;
}
const PUBLISH = /\/api\/documents\/[^/]+\/publish$/;
const PULL = /\/api\/documents\/[^/]+\/pull$/;
const PUBLISH_OR_PULL = /\/api\/documents\/[^/]+\/(publish|pull)$/;
/** For `page.route`: the same paths, whatever the query (`?merge=1`, `?force=1`). */
const onPath = (path: RegExp) => (url: URL) => path.test(url.pathname);

/** Arrow down in an open menu until `entry` has focus. */
async function arrowTo(page: Page, entry: Locator) {
  for (let i = 0; i < 20 && !(await entry.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  await expect(entry).toBeFocused();
}
/** Open the Publish menu from its arrow and pick an entry, with the mouse or with the keyboard only. */
async function pickFromPublishMenu(page: Page, name: RegExp, how: How) {
  const trigger = page.getByTestId("publish-menu");
  const entry = page.getByRole("menuitem", { name });
  if (how === "mouse") {
    await mouseClick(page, trigger);
    await mouseClick(page, entry);
    return;
  }
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await arrowTo(page, entry);
  await page.keyboard.press("Enter");
}
/** The phone's More menu: by touch, or with the keyboard only. */
async function pickFromMoreMenu(page: Page, entry: Locator, how: "touch" | "keyboard") {
  const trigger = page.getByTestId("more-menu");
  if (how === "touch") {
    await tap(page, trigger);
    await tap(page, entry);
    return;
  }
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await arrowTo(page, entry);
  await page.keyboard.press("Enter");
}

const COMMIT = /Commit to GitHub/;
const SYNC = /^Sync/;
const CHANGE = /Change connection/;
const commitDialog = (page: Page) => page.getByRole("dialog", { name: "Commit to GitHub" });
const syncDialog = (page: Page) => page.getByRole("dialog", { name: "Sync with GitHub" });
const connectionDialog = (page: Page) => page.getByRole("dialog", { name: "GitHub connection" });
const messageField = (page: Page) => page.getByRole("dialog").getByTestId("commit-message");
const commitButton = (page: Page) => page.getByTestId("commit-submit");
const cancelButton = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Cancel" });
const closeButton = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Close" });
/** The Publish button or its arrow: either is "the control that opened the dialog's menu". */
const PUBLISH_CONTROLS = ["publish-menu", "publish-button"];

/** A point of the page beside the dialog card: left of it when there is room, above it on a phone. */
async function pointBeside(dialog: Locator) {
  const box = await settledBox(dialog);
  return box.x >= 80 ? { x: box.x / 2, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y / 2 };
}

type Closer = "Escape" | "the X button" | "a click outside" | "Cancel";
async function closeWith(page: Page, dialog: Locator, closer: Closer, touch = false) {
  if (closer === "Escape") {
    await page.keyboard.press("Escape");
  } else if (closer === "a click outside") {
    const { x, y } = await pointBeside(dialog);
    if (touch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  } else {
    const control = closer === "Cancel" ? cancelButton(page) : closeButton(page);
    if (touch) await tap(page, control);
    else await mouseClick(page, control);
  }
}

/**
 * The editor also reports every publish and pull failure in a toast. Toasts stack upwards from the bottom of
 * the page, above an open dialog, and a click on one is a click outside the dialog. A person does not fail
 * five times in four seconds; a test does, so it lets each toast go before the next gesture.
 */
async function toastsGone(page: Page) {
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 20_000 });
}

/** Nothing floats above the page: no dialog, no menu. */
async function expectNothingOpen(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** Hold a key the way a keyboard does: one keydown, then repeats every 33 ms, then the release. */
async function holdKey(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Time is the subject here: this is the keyboard's repeat rate.
    await page.waitForTimeout(33);
    await page.keyboard.down(key);
  }
  await page.keyboard.up(key);
}

/** A pointer gesture at one point, as the browser reports it: every click of a multi-click carries its count. */
type Gesture = { name: string; run: (page: Page, x: number, y: number) => Promise<void> };
const multiClick = (page: Page, x: number, y: number, clicks: number, gap: number) =>
  (async () => {
    await page.mouse.move(x, y);
    for (let count = 1; count <= clicks; count++) {
      if (count > 1 && gap > 0) await page.waitForTimeout(gap); // Time is the subject: the gap inside one gesture.
      await page.mouse.down({ clickCount: count });
      await page.mouse.up({ clickCount: count });
    }
  })();
const GESTURES: Gesture[] = [
  { name: "a double-click", run: (page, x, y) => multiClick(page, x, y, 2, 0) },
  { name: "a double-click 120 ms apart", run: (page, x, y) => multiClick(page, x, y, 2, 120) },
  { name: "a double-click 400 ms apart", run: (page, x, y) => multiClick(page, x, y, 2, 400) },
  { name: "a triple click", run: (page, x, y) => multiClick(page, x, y, 3, 60) },
];
const SPOTS = [0.1, 0.5, 0.9];

test.describe("Commit, Sync and GitHub connection: closing and focus", () => {
  for (const how of ["mouse", "keyboard"] as const) {
    test(`opened from the Publish menu by ${how}: Escape, the X, a click outside and Cancel each close; focus is back on the Publish control and Share opens on the first click`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { page } = await signInWith(browser, `dialogs-close-${how}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const { id } = await linkedDocument(page);
      await openEditor(page, id, "in-sync");
      const publishes = posts(page, PUBLISH_OR_PULL);

      const cases: { name: RegExp; dialog: Locator; closers: Closer[] }[] = [
        // Change connection first: it is the first dialog of this page load, opened while its code is still loading.
        { name: CHANGE, dialog: connectionDialog(page), closers: ["Escape", "the X button", "a click outside"] },
        { name: COMMIT, dialog: commitDialog(page), closers: ["Escape", "the X button", "a click outside", "Cancel"] },
        { name: SYNC, dialog: syncDialog(page), closers: ["Escape", "the X button", "a click outside"] },
      ];
      for (const { name, dialog, closers } of cases) {
        for (const closer of closers) {
          await test.step(`${name.source}: ${closer}`, async () => {
            await pickFromPublishMenu(page, name, how);
            await expect(dialog).toBeVisible();
            await expect.poll(() => focusInDialog(page)).toBe(true);
            await closeWith(page, dialog, closer);
            await expect(dialog).toHaveCount(0);
            await expect.poll(() => focusOf(page)).toMatch(new RegExp(`^(${PUBLISH_CONTROLS.join("|")})$`));
            // The page is usable at once: one real click on Share opens Share.
            await mouseClick(page, page.getByTestId("share-button"));
            const share = page.getByRole("dialog", { name: /^Share / });
            await expect(share).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(share).toHaveCount(0);
          });
        }
      }
      expect(publishes).toEqual([]);
    });
  }

  for (const how of ["touch", "keyboard"] as const) {
    test(`phone, Commit opened from More by ${how}: Escape, the X, a tap outside and Cancel each close and focus is back on More`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page } = await signInWith(browser, `dialogs-phone-${how}`, PHONE);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const { id } = await linkedDocument(page);
      await openEditor(page, id);
      const publishes = posts(page, PUBLISH_OR_PULL);
      for (const closer of ["Escape", "the X button", "a click outside", "Cancel"] as const) {
        await test.step(closer, async () => {
          await pickFromMoreMenu(page, page.getByTestId("menu-publish"), how);
          await expect(commitDialog(page)).toBeVisible();
          await expect(messageField(page)).toBeFocused();
          await closeWith(page, commitDialog(page), closer, true);
          await expect(commitDialog(page)).toHaveCount(0);
          await expect.poll(() => focusOf(page)).toBe("more-menu");
        });
      }
      expect(publishes).toEqual([]);
    });
  }
});

test.describe("Commit dialog: the message field and the request", () => {
  test("typing: fast, in the middle, Backspace in the middle, select-all, paste and IME leave exactly what was typed, and Enter sends it once", async ({ browser }) => {
    const { context, page } = await signInWith(browser, "dialogs-commit-typing");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id, path } = await linkedDocument(page, "local-ahead");
    await openEditor(page, id, "local-ahead");
    const publishes = posts(page, PUBLISH);
    await pickFromPublishMenu(page, COMMIT, "mouse");
    const field = messageField(page);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(`Update ${path}`);
    const caret = () => field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);

    await page.keyboard.press("Control+A");
    await page.keyboard.type("Alpha beta gamma");
    await expect(field).toHaveValue("Alpha beta gamma");

    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("XYZ");
    await expect(field).toHaveValue("AlphaXYZ beta gamma");
    expect(await caret()).toEqual([8, 8]);

    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(field).toHaveValue("AlphaX beta gamma");
    expect(await caret()).toEqual([6, 6]);

    await page.keyboard.press("End");
    await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
    await page.keyboard.press("Control+V");
    await expect(field).toHaveValue("AlphaX beta gamma pasted");

    // An IME composition: three composing updates, then the committed text.
    const cdp = await context.newCDPSession(page);
    for (const text of ["に", "にほ", "にほん"]) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send("Input.insertText", { text: "日本" });
    await expect(field).toHaveValue("AlphaX beta gamma pasted日本");
    await expect(field).toBeFocused();

    // Type and press Enter in one go: the request carries what the field shows.
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Ship it");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Published" })).toBeVisible();
    await expect(commitDialog(page)).toHaveCount(0);
    expect(publishes).toHaveLength(1);
    expect(JSON.parse(publishes[0].slice(publishes[0].indexOf(" ") + 1))).toEqual({ message: "Ship it" });
    expect(await remoteText(page, path)).toBe(LOCAL_EDIT);
    await expect(status(page)).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
    await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
  });

  test("the Commit button by mouse, by Enter and by Space, and Enter in the field, each send one request; a blank message is allowed and the form never submits natively", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-commit-submit");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page, "local-ahead");
    await openEditor(page, id, "local-ahead");
    const url = page.url();
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    const publishes = posts(page, PUBLISH);
    const ways: { name: string; blank?: boolean; press: () => Promise<void> }[] = [
      { name: "a mouse click on Commit", press: () => mouseClick(page, commitButton(page)) },
      {
        name: "Enter on Commit",
        press: async () => {
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await expect(commitButton(page)).toBeFocused();
          await page.keyboard.press("Enter");
        },
      },
      {
        name: "Space on Commit",
        press: async () => {
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          await expect(commitButton(page)).toBeFocused();
          await page.keyboard.press("Space");
        },
      },
      { name: "Enter in the field", press: () => page.keyboard.press("Enter") },
      { name: "a blank message and Enter in the field", blank: true, press: () => page.keyboard.press("Enter") },
      { name: "a blank message and a mouse click on Commit", blank: true, press: () => mouseClick(page, commitButton(page)) },
    ];
    for (const [index, way] of ways.entries()) {
      await test.step(way.name, async () => {
        await pickFromPublishMenu(page, COMMIT, "mouse");
        await expect(messageField(page)).toBeFocused();
        if (way.blank) {
          await page.keyboard.press("Control+A");
          await page.keyboard.press("Backspace");
          await expect(messageField(page)).toHaveValue("");
        }
        await way.press();
        await expect(page.getByRole("button", { name: "Published" })).toBeVisible();
        await expect(commitDialog(page)).toHaveCount(0);
        expect(publishes).toHaveLength(index + 1);
        if (way.blank) expect(JSON.parse(publishes[index].slice(publishes[index].indexOf(" ") + 1))).toEqual({ message: "" });
        await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
      });
    }
    expect(page.url()).toBe(url);
    expect(navigations).toBe(0);
  });

  for (const viewport of ["1440 px", "390 px"] as const) {
    test(`${viewport}: a double-click, slow double-clicks and a triple click on Commit, at 10, 50 and 90 percent of it, are one commit and press nothing else`, async ({ browser }) => {
      test.setTimeout(300_000);
      const phone = viewport === "390 px";
      const { page } = await signInWith(browser, `dialogs-commit-gestures-${phone ? "phone" : "desktop"}`, phone ? PHONE : {});
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const { id } = await linkedDocument(page);
      await openEditor(page, id, "in-sync");
      const before = await documentText(page, id);
      const publishes = posts(page, PUBLISH);
      let expected = 0;
      const open = () => (phone ? pickFromMoreMenu(page, page.getByTestId("menu-publish"), "touch") : pickFromPublishMenu(page, COMMIT, "mouse"));
      const gestures: Gesture[] = phone
        ? [
            ...GESTURES,
            { name: "a double tap", run: async (p, x, y) => (await p.touchscreen.tap(x, y), await p.touchscreen.tap(x, y)) },
            { name: "two taps 120 ms apart", run: async (p, x, y) => (await p.touchscreen.tap(x, y), await p.waitForTimeout(120), await p.touchscreen.tap(x, y)) },
            { name: "two taps 400 ms apart", run: async (p, x, y) => (await p.touchscreen.tap(x, y), await p.waitForTimeout(400), await p.touchscreen.tap(x, y)) },
          ]
        : GESTURES;
      for (const gesture of gestures) {
        for (const spot of SPOTS) {
          await test.step(`${gesture.name} at ${spot * 100} percent`, async () => {
            await open();
            await expect(messageField(page)).toBeFocused();
            const { x, y } = await pointOn(commitButton(page), spot, 0.5);
            await gesture.run(page, x, y);
            expected++;
            await expect(commitDialog(page)).toHaveCount(0);
            expect(publishes).toHaveLength(expected);
            await expectNothingOpen(page);
            await expect.poll(() => focusOf(page)).toMatch(phone ? /^more-menu$/ : /^publish-(menu|button)$/);
          });
        }
      }
      expect(await documentText(page, id)).toBe(before);
    });
  }

  test("a commit that fails at once: the rest of a double-click is not a second commit, Cancel and Commit do not move, the error is shown and a retry sends one more", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-commit-failure");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page, "local-ahead");
    await openEditor(page, id, "local-ahead");
    const publishes = posts(page, PUBLISH);
    const long = "GitHub refused this commit. ".repeat(12).trim();
    let fail = true;
    await page.route(onPath(PUBLISH), (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: long }) }) : route.continue()));

    await pickFromPublishMenu(page, COMMIT, "mouse");
    await expect(messageField(page)).toBeFocused();
    const commitBefore = await settledBox(commitButton(page));
    const cancelBefore = await settledBox(cancelButton(page));
    for (const [index, gesture] of GESTURES.entries()) {
      await test.step(gesture.name, async () => {
        await toastsGone(page);
        const { x, y } = await pointOn(commitButton(page));
        await gesture.run(page, x, y);
        const alert = commitDialog(page).getByRole("alert");
        await expect(alert).toHaveText(long);
        // The editor reports the failure as well, so it is seen even when the dialog is already closed.
        await expect(page.getByTestId("toast").filter({ hasText: "GitHub refused this commit." })).toBeVisible();
        await expect(commitButton(page)).not.toHaveAttribute("aria-disabled", "true");
        expect(publishes).toHaveLength(index + 1);
        // The long error line took its place below the buttons: they are where they were.
        expect(await settledBox(commitButton(page))).toEqual(commitBefore);
        expect(await settledBox(cancelButton(page))).toEqual(cancelBefore);
        await expect(commitDialog(page)).toBeVisible();
        expect(await focusInDialog(page)).toBe(true);
      });
    }
    await toastsGone(page);
    fail = false;
    await mouseClick(page, commitButton(page));
    await expect(page.getByRole("button", { name: "Published" })).toBeVisible();
    await expect(commitDialog(page).getByRole("alert")).toHaveCount(0);
    await expect(commitDialog(page)).toHaveCount(0);
    expect(publishes).toHaveLength(GESTURES.length + 1);
  });

  test("while the request runs: Commit is off but keeps focus, another press does nothing, Tab stays in the dialog, and closing does not lose the result", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-commit-inflight");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id, path } = await linkedDocument(page, "local-ahead");
    await openEditor(page, id, "local-ahead");
    const publishes = posts(page, PUBLISH);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(onPath(PUBLISH), async (route) => {
      await held;
      await route.continue();
    });

    await pickFromPublishMenu(page, COMMIT, "mouse");
    await expect(messageField(page)).toBeFocused();
    await mouseClick(page, commitButton(page));
    await expect(commitButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(commitButton(page)).toBeFocused();
    // More presses while it runs: by mouse, by Enter, by Space. Nothing more is sent.
    await mouseClick(page, commitButton(page));
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(commitButton(page)).toBeFocused();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await focusInDialog(page)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusInDialog(page)).toBe(true);
    }
    expect(publishes).toHaveLength(1);

    // Closing while it runs is allowed. The Publish controls stay off until the request is over, so a second one cannot start.
    await page.keyboard.press("Escape");
    await expect(commitDialog(page)).toHaveCount(0);
    await expect(page.getByTestId("publish-menu")).toBeDisabled();
    await expect(page.getByTestId("publish-button")).toBeDisabled();
    release();
    await expect(page.getByTestId("toast").filter({ hasText: "Committed to GitHub." })).toBeVisible();
    await expect(page.getByTestId("publish-menu")).toBeEnabled();
    expect(publishes).toHaveLength(1);
    expect(await remoteText(page, path)).toBe(LOCAL_EDIT);
    await expectNothingOpen(page);
  });

  test("a held Enter (repeats every 33 ms for 2 seconds) on Commit, in the field, on Cancel and on the X: at most the one commit of the first press, none from Cancel or the X", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-commit-held");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page);
    await openEditor(page, id, "in-sync");
    const before = await documentText(page, id);
    const publishes = posts(page, PUBLISH_OR_PULL);
    const starts: { name: string; requests: number; focus: () => Promise<void> }[] = [
      { name: "the message field", requests: 1, focus: async () => expect(messageField(page)).toBeFocused() },
      { name: "Commit", requests: 1, focus: () => commitButton(page).focus() },
      { name: "Cancel", requests: 0, focus: () => cancelButton(page).focus() },
      { name: "the X", requests: 0, focus: () => closeButton(page).focus() },
    ];
    let expected = 0;
    for (const start of starts) {
      await test.step(start.name, async () => {
        await pickFromPublishMenu(page, COMMIT, "mouse");
        await expect(messageField(page)).toBeFocused();
        await start.focus();
        await holdKey(page, "Enter", 2_000);
        expected += start.requests;
        // Whatever the repeats did to the page after the dialog was gone, they sent nothing.
        await expect.poll(() => publishes.length).toBe(expected);
        if (start.name !== "the X") {
          // In this dialog's own controls the press acts on release, so no repeat outlives the dialog.
          await expect(commitDialog(page)).toHaveCount(0);
          await expectNothingOpen(page);
          await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
        } else {
          // The X belongs to every dialog (ui/dialog.tsx): its repeats may reopen the menu. Close what is left.
          for (let i = 0; i < 3 && (await page.getByRole("dialog").or(page.getByRole("menu")).count()) > 0; i++) await page.keyboard.press("Escape");
          await expectNothingOpen(page);
        }
        expect(publishes).toHaveLength(expected);
      });
    }
    expect(await documentText(page, id)).toBe(before);
  });

  test("Cancel: a double-click, slow double-clicks and a triple click close the dialog once and reach nothing under it", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-commit-cancel");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page);
    await openEditor(page, id, "in-sync");
    const before = await documentText(page, id);
    const publishes = posts(page, PUBLISH_OR_PULL);
    for (const gesture of GESTURES) {
      for (const spot of SPOTS) {
        await test.step(`${gesture.name} at ${spot * 100} percent`, async () => {
          await pickFromPublishMenu(page, COMMIT, "mouse");
          await expect(messageField(page)).toBeFocused();
          const { x, y } = await pointOn(cancelButton(page), spot, 0.5);
          await gesture.run(page, x, y);
          await expect(commitDialog(page)).toHaveCount(0);
          await expectNothingOpen(page);
          // The editor is under Cancel: a click that reached it would have taken focus.
          await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
          expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
        });
      }
    }
    expect(publishes).toEqual([]);
    expect(await documentText(page, id)).toBe(before);
  });

  test("arrow keys, Home and End move between Cancel and Commit; Tab and Shift+Tab stay inside and change nothing", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-commit-keys");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page);
    await openEditor(page, id, "in-sync");
    const publishes = posts(page, PUBLISH_OR_PULL);
    await pickFromPublishMenu(page, COMMIT, "keyboard");
    await expect(messageField(page)).toBeFocused();
    const value = await messageField(page).inputValue();
    await cancelButton(page).focus();
    for (const [key, target] of [
      ["ArrowRight", "commit-submit"],
      ["ArrowRight", "commit-submit"],
      ["ArrowLeft", "Cancel"],
      ["ArrowLeft", "Cancel"],
      ["End", "commit-submit"],
      ["Home", "Cancel"],
      ["ArrowDown", "commit-submit"],
      ["ArrowUp", "Cancel"],
    ] as const) {
      await page.keyboard.press(key);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.textContent?.trim())).toBe(target);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(i < 5 ? "Tab" : "Shift+Tab");
      expect(await focusInDialog(page)).toBe(true);
      seen.add(await focusOf(page));
    }
    expect([...seen].sort()).toEqual(["Close", "button", "commit-message", "commit-submit"]);
    await expect(commitDialog(page)).toBeVisible();
    await expect(messageField(page)).toHaveValue(value);
    expect(publishes).toEqual([]);
  });
});

test.describe("Sync dialog: every control", () => {
  const controls = [
    { name: "Merge", testId: "sync-merge", request: /\/pull\?merge=1 /, done: "Merged" },
    { name: "Keep mine", testId: "sync-keep-mine", request: /\/publish\?force=1 /, done: "Published your version" },
    { name: "Take GitHub", testId: "sync-take-remote", request: /\/pull\?force=1 /, done: "Replaced with GitHub's copy" },
  ] as const;

  for (const control of controls) {
    test(`${control.name} by mouse, by Enter and by Space each act once, show the result, close, and give focus back`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page } = await signInWith(browser, `dialogs-sync-${control.testId}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const way of ["mouse", "Enter", "Space"] as const) {
        await test.step(way, async () => {
          const { id, path } = await linkedDocument(page, "diverged");
          await openEditor(page, id, "diverged");
          const requests = posts(page, PUBLISH_OR_PULL);
          await pickFromPublishMenu(page, SYNC, way === "mouse" ? "mouse" : "keyboard");
          const button = page.getByTestId(control.testId);
          await expect(syncDialog(page)).toBeVisible();
          if (control.testId === "sync-keep-mine") {
            // Type the message and press the choice in one go: the request carries what the field shows.
            await mouseClick(page, messageField(page));
            await page.keyboard.press("Control+A");
            await page.keyboard.type("Mine wins");
          }
          if (way === "mouse") await mouseClick(page, button);
          else {
            await button.focus();
            await page.keyboard.press(way);
          }
          await expect(page.getByTestId("sync-done")).toContainText(control.done);
          await expect(syncDialog(page)).toHaveCount(0);
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatch(control.request);
          if (control.testId === "sync-keep-mine") {
            expect(JSON.parse(requests[0].slice(requests[0].indexOf(" ") + 1))).toEqual({ message: "Mine wins" });
            expect(await remoteText(page, path)).toBe(LOCAL_EDIT);
          }
          if (control.testId === "sync-take-remote") await expect.poll(() => documentText(page, id)).toBe(REMOTE_EDIT);
          if (control.testId === "sync-merge") await expect.poll(() => documentText(page, id)).toContain("edited on GitHub");
          await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
          await expectNothingOpen(page);
        });
      }
    });
  }

  test("Compare by mouse, by Enter and by Space opens the comparison once and closes the dialog; the rest of a double-click reaches nothing under it", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-sync-compare");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    // A long document, so that the comparison has text where the Compare button was.
    const { id } = await linkedDocument(page, "diverged", `\n${"Plain words to select, line after line of them, as far as the page goes.\n".repeat(80)}`);
    await openEditor(page, id, "diverged");
    const requests = posts(page, PUBLISH_OR_PULL);
    let compares = 0;
    page.on("request", (request) => {
      if (/\/sync\?.*content=1/.test(request.url())) compares++;
    });
    const ways: { name: string; press: (button: Locator) => Promise<void> }[] = [
      { name: "a mouse click", press: (button) => mouseClick(page, button) },
      { name: "Enter", press: async (button) => (await button.focus(), await page.keyboard.press("Enter")) },
      { name: "Space", press: async (button) => (await button.focus(), await page.keyboard.press("Space")) },
      ...GESTURES.map((gesture) => ({
        name: gesture.name,
        press: async (button: Locator) => {
          const { x, y } = await pointOn(button);
          await gesture.run(page, x, y);
        },
      })),
    ];
    for (const [index, way] of ways.entries()) {
      await test.step(way.name, async () => {
        await pickFromPublishMenu(page, SYNC, "mouse");
        await expect(syncDialog(page)).toBeVisible();
        await way.press(page.getByTestId("sync-compare"));
        await expect(page.getByTestId("sync-compare-bar")).toBeVisible();
        await expect(syncDialog(page)).toHaveCount(0);
        await expect.poll(() => compares).toBe(index + 1);
        await expectNothingOpen(page);
        // The comparison is still there: the rest of the gesture did not press its Back control or anything
        // else, and it selected no word of the text that is now under the pointer.
        await expect(page.getByTestId("version-diff")).toBeVisible();
        expect(await page.evaluate(() => String(getSelection()))).toBe("");
        await mouseClick(page, page.getByTestId("sync-compare-close"));
        await expect(page.getByTestId("sync-compare-bar")).toHaveCount(0);
      });
    }
    expect(requests).toEqual([]);
  });

  test("an action that fails at once: the rest of a double-click starts nothing, no choice moves, and the next press is on the choice it was aimed at", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-sync-failure");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page, "diverged");
    await openEditor(page, id, "diverged");
    const requests = posts(page, PUBLISH_OR_PULL);
    const long = "GitHub refused this request. ".repeat(12).trim();
    await page.route(onPath(PUBLISH_OR_PULL), (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: long }) }));
    await pickFromPublishMenu(page, SYNC, "mouse");
    await expect(syncDialog(page)).toBeVisible();
    const boxes = async () => Promise.all(controls.map((control) => settledBox(page.getByTestId(control.testId))));
    const before = await boxes();
    let expected = 0;
    for (const control of controls) {
      for (const gesture of GESTURES) {
        await test.step(`${control.name}: ${gesture.name}`, async () => {
          await toastsGone(page);
          const { x, y } = await pointOn(page.getByTestId(control.testId));
          await gesture.run(page, x, y);
          expected++;
          await expect(syncDialog(page).getByRole("alert")).toHaveText(long);
          await expect(page.getByTestId(control.testId)).not.toHaveAttribute("aria-disabled", "true");
          expect(requests).toHaveLength(expected);
          expect(requests[expected - 1]).toMatch(control.request);
          expect(await boxes()).toEqual(before);
          expect(await focusInDialog(page)).toBe(true);
        });
      }
    }
    await expect(syncDialog(page)).toBeVisible();
  });

  test("while an action runs: the choices are off but keep focus, other presses do nothing, Tab stays inside, and closing does not lose the result", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-sync-inflight");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page, "diverged");
    await openEditor(page, id, "diverged");
    const requests = posts(page, PUBLISH_OR_PULL);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(onPath(PULL), async (route) => {
      await held;
      await route.continue();
    });
    await pickFromPublishMenu(page, SYNC, "mouse");
    await expect(syncDialog(page)).toBeVisible();
    await mouseClick(page, page.getByTestId("sync-merge"));
    for (const testId of ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"]) await expect(page.getByTestId(testId)).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("sync-merge")).toBeFocused();
    for (const testId of ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"]) await mouseClick(page, page.getByTestId(testId));
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await focusInDialog(page)).toBe(true);
    }
    expect(requests).toHaveLength(1);
    await expect(syncDialog(page)).toBeVisible();
    await expect(page.getByTestId("sync-compare-bar")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(syncDialog(page)).toHaveCount(0);
    await expect(page.getByTestId("publish-menu")).toBeDisabled();
    release();
    await expect(page.getByTestId("toast").filter({ hasText: /Merged GitHub/ })).toBeVisible();
    await expect.poll(() => documentText(page, id)).toContain("edited on GitHub");
    expect(requests).toHaveLength(1);
    await expectNothingOpen(page);
  });

  test("a held Enter (repeats every 33 ms for 2 seconds) on each choice is one action", async ({ browser }) => {
    test.setTimeout(240_000);
    const { page } = await signInWith(browser, "dialogs-sync-held");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const control of controls) {
      await test.step(control.name, async () => {
        const { id } = await linkedDocument(page, "diverged");
        await openEditor(page, id, "diverged");
        const requests = posts(page, PUBLISH_OR_PULL);
        await pickFromPublishMenu(page, SYNC, "mouse");
        await expect(syncDialog(page)).toBeVisible();
        await page.getByTestId(control.testId).focus();
        await holdKey(page, "Enter", 2_000);
        await expect(page.getByTestId("sync-done")).toContainText(control.done);
        await expect(syncDialog(page)).toHaveCount(0);
        await expectNothingOpen(page);
        expect(requests).toHaveLength(1);
        await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
      });
    }
  });

  test("the message field takes typing in the middle, paste and IME; status polls change nothing; arrow keys move between the choices; Tab stays inside", async ({ browser }) => {
    const { context, page } = await signInWith(browser, "dialogs-sync-typing");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id } = await linkedDocument(page, "diverged");
    await openEditor(page, id, "diverged");
    const requests = posts(page, PUBLISH_OR_PULL);
    let polls = 0;
    page.on("response", (response) => {
      if (/\/api\/documents\/[^/]+\/sync$/.test(new URL(response.url()).pathname)) polls++;
    });
    await pickFromPublishMenu(page, SYNC, "keyboard");
    await expect(syncDialog(page)).toBeVisible();
    await expect(page.getByTestId("sync-merge")).toBeFocused();

    for (const [key, target] of [
      ["ArrowDown", "sync-keep-mine"],
      ["ArrowRight", "sync-take-remote"],
      ["End", "sync-compare"],
      ["ArrowDown", "sync-compare"],
      ["ArrowUp", "sync-take-remote"],
      ["ArrowLeft", "sync-keep-mine"],
      ["Home", "sync-merge"],
      ["ArrowUp", "sync-merge"],
    ] as const) {
      await page.keyboard.press(key);
      expect(await focusOf(page)).toBe(target);
    }

    const field = messageField(page);
    await mouseClick(page, field);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Alpha beta gamma");
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.type("XYZ");
    await expect(field).toHaveValue("AlphaXYZ beta gamma");
    await page.keyboard.press("Backspace");
    await expect(field).toHaveValue("AlphaXY beta gamma");
    const caret = () => field.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
    expect(await caret()).toEqual([7, 7]);

    // Two status polls land while the caret is in the middle of the field.
    const pollsBefore = polls;
    await expect.poll(() => polls, { timeout: 30_000 }).toBeGreaterThanOrEqual(pollsBefore + 2);
    await expect(field).toHaveValue("AlphaXY beta gamma");
    expect(await caret()).toEqual([7, 7]);
    await expect(field).toBeFocused();
    await expect(syncDialog(page)).toBeVisible();
    await page.keyboard.type("Z");
    await expect(field).toHaveValue("AlphaXYZ beta gamma");

    await page.keyboard.press("End");
    await page.evaluate(() => navigator.clipboard.writeText(" pasted"));
    await page.keyboard.press("Control+V");
    const cdp = await context.newCDPSession(page);
    for (const text of ["に", "にほ", "にほん"]) await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send("Input.insertText", { text: "日本" });
    await expect(field).toHaveValue("AlphaXYZ beta gamma pasted日本");

    // Enter in the field is not an action here, and the focus trap still holds after the polls.
    await page.keyboard.press("Enter");
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i < 6 ? "Tab" : "Shift+Tab");
      expect(await focusInDialog(page)).toBe(true);
      seen.add(await focusOf(page));
    }
    expect([...seen].sort()).toEqual(["Close", "commit-message", "sync-compare", "sync-keep-mine", "sync-merge", "sync-take-remote"]);
    await expect(field).toHaveValue("AlphaXYZ beta gamma pasted日本");
    await expect(syncDialog(page)).toBeVisible();
    expect(requests).toEqual([]);
  });

  test("the GitHub file grows past the limit under the open dialog: Merge, Take and Compare go, Keep mine still force-publishes once", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-sync-unreadable");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const { id, path } = await linkedDocument(page, "diverged");
    await openEditor(page, id, "diverged");
    const requests = posts(page, PUBLISH_OR_PULL);
    await pickFromPublishMenu(page, SYNC, "mouse");
    await expect(page.getByTestId("sync-dialog")).toHaveAttribute("data-status", "diverged");
    await mouseClick(page, messageField(page));
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Typed before the poll");
    await setRemote(page, path, "", 3_801_362);
    await expect(page.getByTestId("sync-dialog")).toHaveAttribute("data-status", "remote-unreadable", { timeout: 30_000 });
    await expect(page.getByTestId("sync-merge")).toHaveCount(0);
    await expect(page.getByTestId("sync-take-remote")).toHaveCount(0);
    await expect(page.getByTestId("sync-compare")).toHaveCount(0);
    await expect(messageField(page)).toHaveValue("Typed before the poll");
    await expect(messageField(page)).toBeFocused();
    await mouseClick(page, page.getByTestId("sync-keep-mine"));
    await expect(page.getByTestId("sync-done")).toContainText("Published your version");
    await expect(syncDialog(page)).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/\/publish\?force=1 /);
    expect(JSON.parse(requests[0].slice(requests[0].indexOf(" ") + 1))).toEqual({ message: "Typed before the poll" });
    expect(await remoteText(page, path)).toBe(LOCAL_EDIT);
  });
});

test.describe("dialogs of an unlinked document (no GitHub needed)", () => {
  for (const how of ["mouse", "keyboard"] as const) {
    test(`Share link and Connect to GitHub opened from the Publish menu by ${how} close on Escape, the X and a click outside, and focus is back on the Publish control`, async ({ browser }) => {
      const { page } = await signInWith(browser, `dialogs-unlinked-${how}`);
      const id = await createDocument(page, BASE);
      await openEditor(page, id);
      const cases = [
        { name: /Share link/, dialog: page.getByRole("dialog", { name: /^Share / }) },
        { name: /Gist or repository/, dialog: page.getByRole("dialog", { name: "Connect to GitHub" }) },
      ];
      for (const { name, dialog } of cases) {
        // Without a GitHub OAuth app (a local production build) the GitHub entry is off; Share link always works.
        await mouseClick(page, page.getByTestId("publish-menu"));
        const off = (await page.getByRole("menuitem", { name }).getAttribute("data-disabled")) !== null;
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        if (off) {
          test.info().annotations.push({ type: "skipped-part", description: `${name.source}: the entry is disabled on this server` });
          continue;
        }
        for (const closer of ["Escape", "the X button", "a click outside"] as const) {
          await test.step(`${name.source}: ${closer}`, async () => {
            await pickFromPublishMenu(page, name, how);
            await expect(dialog).toBeVisible();
            await expect.poll(() => focusInDialog(page)).toBe(true);
            await closeWith(page, dialog, closer);
            await expect(dialog).toHaveCount(0);
            await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
          });
        }
      }
    });
  }
});

test.describe("phone (390 x 844): sheets and the Outline drawer give focus back", () => {
  test("Version history and Activity (from More) and the Outline drawer close on Escape and on a tap outside, and focus returns to the control that opened them", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "dialogs-phone-sheets", PHONE);
    const id = await createDocument(page, "# Phone\n\n## One\n\nText.\n\n## Two\n\nMore text.\n");
    await openEditor(page, id);
    const surfaces = [
      {
        name: "Version history",
        open: () => pickFromMoreMenu(page, page.getByTestId("menu-history"), "touch"),
        surface: page.locator('[data-testid="sheet"][data-panel="versions"]'),
        backdrop: page.getByTestId("sheet-backdrop"),
        opener: "more-menu",
      },
      {
        name: "Activity",
        open: () => pickFromMoreMenu(page, page.getByTestId("menu-activity"), "touch"),
        surface: page.locator('[data-testid="sheet"][data-panel="activity"]'),
        backdrop: page.getByTestId("sheet-backdrop"),
        opener: "more-menu",
      },
      {
        name: "Outline",
        open: () => tap(page, page.getByTestId("outline-button")),
        surface: page.getByTestId("outline-drawer"),
        backdrop: page.getByTestId("outline-drawer-backdrop"),
        opener: "outline-button",
      },
    ];
    for (const { name, open, surface, opener } of surfaces) {
      for (const closer of ["Escape", "a tap outside"] as const) {
        await test.step(`${name}: ${closer}`, async () => {
          await open();
          await expect(surface).toBeVisible();
          await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
          if (closer === "Escape") await page.keyboard.press("Escape");
          else {
            // Well away from the sheet's edge: Chrome moves a touch that lands within a few pixels of a target onto it.
            const box = await settledBox(surface);
            const viewport = page.viewportSize()!;
            const point = box.y >= 32 ? { x: viewport.width / 2, y: box.y / 2 } : { x: (box.x + box.width + viewport.width) / 2, y: viewport.height / 2 };
            await page.touchscreen.tap(point.x, point.y);
          }
          await expect(surface).toHaveCount(0);
          await expect.poll(() => focusOf(page)).toBe(opener);
          await expect(page.getByTestId(opener)).toBeVisible();
        });
      }
    }
  });

  test("a sheet whose opener is gone, a sheet switched from inside, and the Comments sheet: focus never ends on the page body", async ({ browser }) => {
    const { page } = await signInWith(browser, "dialogs-phone-edges", PHONE);
    const id = await createDocument(page, "# Phone\n\n## One\n\nText.\n\n## Two\n\nMore text.\n");
    await openEditor(page, id);
    const sheet = (panel: string) => page.locator(`[data-testid="sheet"][data-panel="${panel}"]`);
    /** Run a command from the palette, which is gone by the time the command has opened its panel. */
    const fromPalette = async (query: string) => {
      await page.keyboard.press("Control+K");
      await expect(page.getByTestId("palette-input")).toBeFocused();
      await page.keyboard.type(query);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("command-palette")).toHaveCount(0);
    };

    await test.step("Version history, then Activity through the palette, then Escape: More", async () => {
      await pickFromMoreMenu(page, page.getByTestId("menu-history"), "touch");
      await expect(sheet("versions")).toBeVisible();
      await fromPalette("Activity");
      await expect(sheet("activity")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sheet")).toHaveCount(0);
      await expect.poll(() => focusOf(page)).toBe("more-menu");
    });

    await test.step("Version history and the Outline opened from the palette, then Escape: the editor the palette came from", async () => {
      const editor = page.locator(".md-rich:visible, .cm-content:visible").first();
      for (const [query, surface] of [
        ["Version history", sheet("versions")],
        ["outline", page.getByTestId("outline-drawer")],
      ] as const) {
        await tap(page, editor, 0.5, 0.9);
        await expect.poll(() => focusOf(page)).toMatch(/^(rich|code) pane$/);
        await fromPalette(query);
        await expect(surface).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(surface).toHaveCount(0);
        await expect.poll(() => focusOf(page)).toMatch(/^(rich|code) pane$/);
      }
      // Switched from inside: the first opener (the editor) still gets focus back, not the ⋮ button.
      await fromPalette("Version history");
      await expect(sheet("versions")).toBeVisible();
      await fromPalette("Activity");
      await expect(sheet("activity")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sheet")).toHaveCount(0);
      await expect.poll(() => focusOf(page)).toMatch(/^(rich|code) pane$/);
    });

    await test.step("nothing had focus when the Outline opened: the More button gets it", async () => {
      await page.reload();
      await waitForEditor(page);
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
      expect(await focusOf(page)).toBe("body");
      await fromPalette("outline");
      await expect(page.getByTestId("outline-drawer")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("outline-drawer")).toHaveCount(0);
      await expect.poll(() => focusOf(page)).toBe("more-menu");
    });

    await test.step("the Comments sheet still leaves focus in the editor, by Escape and by a tap outside", async () => {
      for (const closer of ["Escape", "a tap outside"] as const) {
        await tap(page, page.getByTestId("comments-toggle"));
        await expect(sheet("comments")).toBeVisible();
        await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
        if (closer === "Escape") await page.keyboard.press("Escape");
        else await page.touchscreen.tap(page.viewportSize()!.width / 2, (await settledBox(sheet("comments"))).y / 2);
        await expect(page.getByTestId("sheet")).toHaveCount(0);
        await expect.poll(() => focusOf(page)).toMatch(/^(rich|code) pane$/);
      }
    });
  });
});
