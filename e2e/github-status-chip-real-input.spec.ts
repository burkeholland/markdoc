import { type Browser, type Locator, type Page, type Request } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createDocument, devLogin, openDocument, uniqueLogin, waitForEditor, waitForHydration } from "./helpers";

/**
 * The status chip of a document linked to GitHub ("Up to date", "Publish", "Pull", "Both changed",
 * "GitHub file too large"), driven the way a person drives it: `page.mouse`, `page.keyboard` and
 * `page.touchscreen` only. No `locator.click()` on the chip, no `fireEvent`, no script click (issue #2275;
 * the chip's hand-rolled event checks are gone, #2222).
 *
 * The chip stands where the Publish button is on a document that is not linked. One press does what the
 * status calls for: Commit to GitHub (a repository file) or one publish request (a gist), one pull request,
 * or the Sync dialog. Requests are counted on the network.
 *
 * Linked documents need the in-memory GitHub of the e2e server (GITHUB_MOCK=1). A production build has no
 * fake GitHub, so every test here skips there by asking the server.
 */

const BASE = "# Chip\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";
const REMOTE_EDIT = BASE.replace("Third paragraph.", "Third paragraph, edited on GitHub.");
const LOCAL_EDIT = `${BASE}\nA new local line.\n`;
const REPO = { owner: "mock", repo: "scratch", branch: "main" };
const OVERSIZED = 3_801_362;
type SyncState = "in-sync" | "local-ahead" | "remote-ahead" | "diverged" | "remote-unreadable";
type Kind = "repo" | "gist";
type Input = "mouse" | "Enter" | "Space" | "touch";
const KEYS_AND_MOUSE: Input[] = ["mouse", "Enter", "Space"];
let files = 0;

interface Linked {
  id: string;
  kind: Kind;
  /** The file in the fake repository, or the file of the fake gist. */
  path: string;
  gistId?: string;
}

async function signInWith(browser: Browser, name: string, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
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

/** Plays "someone else committed": the file on the fake GitHub gets new text, or a size past the 2 MB bound. */
async function setRemote(page: Page, doc: Linked, content: string, size?: number) {
  const data = doc.kind === "gist"
    ? { kind: "gist", gistId: doc.gistId, filename: doc.path, content }
    : { kind: "repo", ...REPO, path: doc.path, content, ...(size === undefined ? {} : { size }) };
  const res = await page.request.post("/api/github/mock", { data });
  expect(res.ok()).toBeTruthy();
}
const remoteText = async (page: Page, doc: Linked) => {
  const query = doc.kind === "gist"
    ? `gistId=${doc.gistId}&filename=${encodeURIComponent(doc.path)}`
    : `owner=${REPO.owner}&repo=${REPO.repo}&branch=${REPO.branch}&path=${encodeURIComponent(doc.path)}`;
  return ((await (await page.request.get(`/api/github/mock?${query}`)).json()) as { content: string | null }).content;
};
/** The gist's revision on the fake GitHub: every write gives a new one. */
const gistRevision = async (page: Page, doc: Linked) =>
  ((await (await page.request.get(`/api/github/mock?gistId=${doc.gistId}&filename=${encodeURIComponent(doc.path)}`)).json()) as { revision: string | null }).revision;
const documentText = async (page: Page, id: string) => ((await (await page.request.get(`/api/documents/${id}/content`)).json()) as { content: string }).content;
const setLocal = async (page: Page, id: string, content: string) => {
  const put = await page.request.put(`/api/documents/${id}/content`, { data: { content } });
  expect(put.ok()).toBeTruthy();
};

/** A document linked to a file of the fake repository or to a fake gist, brought to `state` through the API before any page opens it. */
async function linkedDocument(page: Page, state: SyncState = "in-sync", kind: Kind = "repo"): Promise<Linked> {
  const id = await createDocument(page, BASE);
  const n = `${Date.now()}-${++files}`;
  const doc: Linked = kind === "gist" ? { id, kind, path: `chip-${n}.md`, gistId: `chip${n.replace("-", "")}` } : { id, kind, path: `docs/chip-${n}.md` };
  await setRemote(page, doc, BASE);
  const link = await page.request.post(`/api/documents/${id}/link`, {
    data: kind === "gist" ? { storage: "gist", gistId: doc.gistId, filename: doc.path } : { storage: "repo", ...REPO, path: doc.path },
  });
  expect(link.ok()).toBeTruthy();
  if (state === "diverged" || state === "remote-ahead") await setRemote(page, doc, REMOTE_EDIT);
  if (state === "remote-unreadable") await setRemote(page, doc, "", OVERSIZED);
  if (state === "diverged" || state === "local-ahead") await setLocal(page, id, LOCAL_EDIT);
  return doc;
}

const chip = (page: Page) => page.getByTestId("publish-button");
const arrow = (page: Page) => page.getByTestId("publish-menu");
const status = (page: Page) => page.getByTestId("publish-status");
const expectStatus = (page: Page, state: SyncState) => expect(status(page)).toHaveAttribute("data-status", state, { timeout: 65_000 });

/** Open a document and wait until its header shows the chip in `state`. */
async function openEditor(page: Page, id: string, state: SyncState) {
  await openDocument(page, id);
  await expectStatus(page, state);
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

/** The box that keeps the chip's place for the rest of a pointer gesture (press-once.tsx). */
const placeHold = (page: Page) => page.getByTestId("place-hold");

/**
 * One press on the chip. The keyboard rows put focus on the chip first, as Tab would, and then use the real key.
 * A pointer press is a new press, not the rest of the gesture before it: it comes once the place hold of that
 * gesture has gone (600 ms after an acting click at the latest).
 */
async function press(page: Page, how: Input) {
  if (how === "mouse" || how === "touch") await expect(placeHold(page)).toHaveCount(0);
  if (how === "mouse") return mouseClick(page, chip(page));
  if (how === "touch") return tap(page, chip(page));
  if (!(await chip(page).evaluate((el) => el === document.activeElement))) await chip(page).focus();
  await page.keyboard.press(how);
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
const expectFocusOnChip = (page: Page) => expect.poll(() => focusOf(page)).toBe("publish-button");

const PUBLISH_OR_PULL = /\/api\/documents\/[^/]+\/(publish|pull)$/;
const SYNC_STATUS = /\/api\/documents\/[^/]+\/sync$/;
/** For `page.route`: the same paths, whatever the query (`?merge=1`, `?force=1`, `?fresh=1`). */
const onPath = (path: RegExp) => (url: URL) => path.test(url.pathname);
/** The publish and pull requests of the page, in order, as "/pull", "/publish", "/pull?merge=1". Read `.length` to count them. */
function requestsOf(page: Page) {
  const seen: string[] = [];
  const pending = new Set<Request>();
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || !PUBLISH_OR_PULL.test(url.pathname)) return;
    seen.push(`${url.pathname.replace(/^.*\//, "/")}${url.search}`);
    pending.add(request);
  });
  page.on("requestfinished", (request) => pending.delete(request));
  page.on("requestfailed", (request) => pending.delete(request));
  /** Every counted request has been answered: nothing is cut off when the test closes its page. */
  const settled = () => expect.poll(() => pending.size, { timeout: 20_000 }).toBe(0);
  return { seen, settled };
}

/** Holds every publish and pull request of the page until the returned function is called. */
async function holdRequests(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(onPath(PUBLISH_OR_PULL), async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

/** From now on the page hears nothing new about the sync status: its polls are left unanswered. */
async function freezeStatus(page: Page) {
  await page.route(onPath(SYNC_STATUS), () => undefined);
}

const commitDialog = (page: Page) => page.getByRole("dialog", { name: "Commit to GitHub" });
const syncDialog = (page: Page) => page.getByRole("dialog", { name: "Sync with GitHub" });
const closeButton = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Close" });
const cancelButton = (page: Page) => page.getByRole("dialog").getByRole("button", { name: "Cancel" });
const SYNC_CHOICES = ["sync-merge", "sync-keep-mine", "sync-take-remote", "sync-compare"];

type Closer = "Escape" | "the X button" | "a click outside" | "Cancel";
async function closeWith(page: Page, dialog: Locator, closer: Closer, touch = false) {
  if (closer === "Escape") {
    await page.keyboard.press("Escape");
  } else if (closer === "a click outside") {
    // Left of the card, level with its middle: the page behind the dialog.
    const box = await settledBox(dialog);
    const point = { x: box.x / 2, y: box.y + box.height / 2 };
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
  } else {
    const control = closer === "Cancel" ? cancelButton(page) : closeButton(page);
    if (touch) await tap(page, control);
    else await mouseClick(page, control);
  }
  await expect(dialog).toHaveCount(0);
}

/** Nothing floats above the page: no dialog, no menu. */
async function expectNothingOpen(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
}

/** Only a menu floats above the page. */
async function expectNothingOpenBut(page: Page, role: "menu") {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole(role)).toHaveCount(1);
}

/** The editor reports a finished publish or pull in a toast; a test lets it go before the next pointer gesture. */
async function toastsGone(page: Page) {
  await expect(page.getByTestId("toast")).toHaveCount(0, { timeout: 20_000 });
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
async function multiClick(page: Page, x: number, y: number, clicks: number, gap: number) {
  await page.mouse.move(x, y);
  for (let count = 1; count <= clicks; count++) {
    if (count > 1 && gap > 0) await page.waitForTimeout(gap); // Time is the subject: the gap inside one gesture.
    await page.mouse.down({ clickCount: count });
    await page.mouse.up({ clickCount: count });
  }
}
type Gesture = { name: string; run: (page: Page, x: number, y: number) => Promise<void> };
const GESTURES: Gesture[] = [
  { name: "a double-click", run: (page, x, y) => multiClick(page, x, y, 2, 0) },
  { name: "a double-click 120 ms apart", run: (page, x, y) => multiClick(page, x, y, 2, 120) },
  { name: "a double-click 400 ms apart", run: (page, x, y) => multiClick(page, x, y, 2, 400) },
  { name: "a triple click", run: (page, x, y) => multiClick(page, x, y, 3, 60) },
];
const SPOTS = [0.1, 0.5, 0.9];
const VIEWPORTS = [
  { name: "1440 px", size: { width: 1440, height: 1000 } },
  // The narrowest window that shows the chip; below 768 px the header keeps only More.
  { name: "768 px", size: { width: 768, height: 900 } },
];

const LABELS: Record<SyncState, { label: string; title: string }> = {
  "in-sync": { label: "Up to date", title: "Up to date" },
  "local-ahead": { label: "Publish", title: "Unpublished changes" },
  "remote-ahead": { label: "Pull", title: "GitHub has changes" },
  diverged: { label: "Both changed", title: "Both changed" },
  "remote-unreadable": { label: "GitHub file too large", title: "GitHub file too large" },
};

/** The chip says what the status is: its text is its accessible name, and the longer wording is its title. */
async function expectChipSays(page: Page, state: SyncState) {
  await expectStatus(page, state);
  await expect(chip(page)).toHaveText(LABELS[state].label);
  await expect(chip(page)).toHaveAttribute("title", LABELS[state].title);
  await expect(chip(page)).toHaveAccessibleName(LABELS[state].label);
  await expect(chip(page)).toHaveAttribute("type", "button");
}

test.describe("status chip: one press does what the status calls for", () => {
  const OPENS: { kind: Kind; state: SyncState; opens: "Commit" | "Sync" }[] = [
    { kind: "repo", state: "in-sync", opens: "Commit" },
    { kind: "repo", state: "local-ahead", opens: "Commit" },
    { kind: "repo", state: "diverged", opens: "Sync" },
    { kind: "repo", state: "remote-unreadable", opens: "Sync" },
    { kind: "gist", state: "diverged", opens: "Sync" },
  ];
  for (const { kind, state, opens } of OPENS) {
    test(`${kind}, "${LABELS[state].label}": mouse, Enter and Space each open ${opens} on the first press, twice in a row, and Escape gives focus back to the chip`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-opens-${state}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, state, kind);
      await openEditor(page, doc.id, state);
      await expectChipSays(page, state);
      const requests = requestsOf(page);
      const dialog = opens === "Commit" ? commitDialog(page) : syncDialog(page);
      for (const how of [...KEYS_AND_MOUSE, ...KEYS_AND_MOUSE]) {
        await test.step(how, async () => {
          await press(page, how);
          await expect(dialog).toBeVisible();
          if (opens === "Sync") {
            // Sync the user asked for is live at once; an unreadable GitHub file leaves only Keep mine.
            await expect(page.getByTestId(state === "remote-unreadable" ? "sync-keep-mine" : "sync-merge")).toBeFocused();
            await expect(page.getByTestId("sync-keep-mine")).not.toHaveAttribute("aria-disabled", "true");
            await expect(page.getByTestId("sync-merge")).toHaveCount(state === "remote-unreadable" ? 0 : 1);
          } else {
            await expect(page.getByRole("dialog").getByTestId("commit-message")).toBeFocused();
          }
          await closeWith(page, dialog, "Escape");
          await expectFocusOnChip(page);
        });
      }
      expect(requests.seen).toEqual([]);
    });
  }

  const SENDS: { kind: Kind; state: SyncState; sends: string; inputs: Input[] }[] = [
    { kind: "repo", state: "remote-ahead", sends: "/pull", inputs: KEYS_AND_MOUSE },
    { kind: "gist", state: "local-ahead", sends: "/publish", inputs: KEYS_AND_MOUSE },
    { kind: "gist", state: "remote-ahead", sends: "/pull", inputs: ["mouse"] },
    // A gist that is up to date: the press still asks, and the server answers that there is nothing to do.
    { kind: "gist", state: "in-sync", sends: "/publish", inputs: ["mouse"] },
  ];
  for (const { kind, state, sends, inputs } of SENDS) {
    test(`${kind}, "${LABELS[state].label}": one press sends exactly one ${sends} request, opens nothing, and focus stays on the chip (${inputs.join(", ")})`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-sends-${kind}-${state}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const how of inputs) {
        await test.step(how, async () => {
          const doc = await linkedDocument(page, state, kind);
          await openEditor(page, doc.id, state);
          await expectChipSays(page, state);
          const requests = requestsOf(page);
          await press(page, how);
          await expect.poll(() => requests.seen).toEqual([sends]);
          await requests.settled();
          await expectStatus(page, "in-sync");
          await expect(chip(page)).toHaveText("Up to date");
          await expect(chip(page)).not.toHaveAttribute("aria-disabled", "true");
          await expectNothingOpen(page);
          await expectFocusOnChip(page);
          expect(requests.seen).toEqual([sends]);
          if (sends === "/pull") expect(await documentText(page, doc.id)).toBe(REMOTE_EDIT);
          else expect(await remoteText(page, doc)).toBe(state === "in-sync" ? BASE : LOCAL_EDIT);
        });
      }
    });
  }

  test("touch: a tap opens Commit and Sync, again after each was closed, and a tap on Pull and on a gist's Publish sends one request", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-touch", { hasTouch: true });
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const { state, dialog } of [
      { state: "local-ahead", dialog: commitDialog(page) },
      { state: "diverged", dialog: syncDialog(page) },
    ] as const) {
      await test.step(`"${LABELS[state].label}"`, async () => {
        const doc = await linkedDocument(page, state);
        await openEditor(page, doc.id, state);
        const requests = requestsOf(page);
        // Escape comes last. The browser counts taps itself: a tap on the chip sooner than its double-tap time
        // after the tap before it, with only a key in between, is the second tap of a double tap (click count
        // 2), and the chip does not take that for a press. A tap on the X or beside the card starts a new count.
        for (const closer of ["the X button", "a click outside", "Escape"] as const) {
          await test.step(`a tap, then ${closer}`, async () => {
            await press(page, "touch");
            await expect(dialog).toBeVisible();
            await closeWith(page, dialog, closer, true);
            await expectFocusOnChip(page);
          });
        }
        await test.step("a tap after Escape, once the double-tap time is over", async () => {
          await page.waitForTimeout(700); // Time is the subject: longer than the browser's double-tap time.
          await press(page, "touch");
          await expect(dialog).toBeVisible();
          await closeWith(page, dialog, "the X button", true);
          await expectFocusOnChip(page);
        });
        expect(requests.seen).toEqual([]);
      });
    }
    for (const { kind, state, sends } of [
      { kind: "repo", state: "remote-ahead", sends: "/pull" },
      { kind: "gist", state: "local-ahead", sends: "/publish" },
    ] as const) {
      await test.step(`${kind}, "${LABELS[state].label}"`, async () => {
        const doc = await linkedDocument(page, state, kind);
        await openEditor(page, doc.id, state);
        const requests = requestsOf(page);
        await press(page, "touch");
        await expect.poll(() => requests.seen).toEqual([sends]);
        await requests.settled();
        await expectStatus(page, "in-sync");
        await expectNothingOpen(page);
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual([sends]);
      });
    }
  });

  test("a phone (390 x 844) has no chip", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-phone", { viewport: { width: 390, height: 844 }, hasTouch: true });
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const doc = await linkedDocument(page, "diverged");
    // The editor still asks for the status; when the answer is in, the header has no chip and no arrow to show it.
    const answered = page.waitForResponse((response) => SYNC_STATUS.test(new URL(response.url()).pathname) && response.ok(), { timeout: 65_000 });
    await page.goto(`/d/${doc.id}`);
    await waitForEditor(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await answered;
    await expect(page.getByTestId("more-menu")).toBeVisible();
    await expect(chip(page)).toBeHidden();
    await expect(arrow(page)).toBeHidden();
    await expect(status(page)).toBeHidden();
  });
});

test.describe("status chip: after the dialog it opened was closed, the next press acts", () => {
  test("Commit: closed by Escape, the X, a click outside and Cancel, the chip opens it again on the first press by mouse, Enter and Space; also after a commit and after the Publish menu was used", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-again-commit");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const doc = await linkedDocument(page, "local-ahead");
    await openEditor(page, doc.id, "local-ahead");
    const requests = requestsOf(page);
    const dialog = commitDialog(page);
    for (const how of KEYS_AND_MOUSE) {
      await press(page, how);
      await expect(dialog).toBeVisible();
      for (const closer of ["Escape", "the X button", "a click outside", "Cancel"] as const) {
        await test.step(`${closer}, then ${how}`, async () => {
          await closeWith(page, dialog, closer);
          await expectFocusOnChip(page);
          await press(page, how);
          await expect(dialog).toBeVisible();
        });
      }
      await closeWith(page, dialog, "Escape");
    }
    expect(requests.seen).toEqual([]);

    await test.step("the Commit dialog opened from the Publish menu and closed: the chip opens it on the first press, and again", async () => {
      await mouseClick(page, arrow(page));
      await mouseClick(page, page.getByRole("menuitem", { name: /Commit to GitHub/ }));
      await expect(dialog).toBeVisible();
      await closeWith(page, dialog, "Escape");
      for (const how of KEYS_AND_MOUSE) {
        await press(page, how);
        await expect(dialog).toBeVisible();
        await closeWith(page, dialog, "Escape");
        await expectFocusOnChip(page);
      }
      expect(requests.seen).toEqual([]);
    });

    await test.step("after a commit the chip says Up to date and opens Commit again on the first press", async () => {
      await press(page, "mouse");
      await mouseClick(page, page.getByTestId("commit-submit"));
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      await requests.settled();
      await expectStatus(page, "in-sync");
      await expectFocusOnChip(page);
      for (const how of KEYS_AND_MOUSE) {
        await toastsGone(page);
        await press(page, how);
        await expect(dialog).toBeVisible();
        await closeWith(page, dialog, "Escape");
      }
      expect(requests.seen).toEqual(["/publish"]);
      expect(await remoteText(page, doc)).toBe(LOCAL_EDIT);
    });
  });

  test("Sync: closed by Escape, the X and a click outside, the chip opens it again on the first press by mouse, Enter and Space; also after Keep mine and after the Publish menu was used", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-again-sync");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const doc = await linkedDocument(page, "diverged");
    await openEditor(page, doc.id, "diverged");
    const requests = requestsOf(page);
    const dialog = syncDialog(page);
    for (const how of KEYS_AND_MOUSE) {
      await press(page, how);
      await expect(dialog).toBeVisible();
      for (const closer of ["Escape", "the X button", "a click outside"] as const) {
        await test.step(`${closer}, then ${how}`, async () => {
          await closeWith(page, dialog, closer);
          await expectFocusOnChip(page);
          await press(page, how);
          await expect(dialog).toBeVisible();
          await expect(page.getByTestId("sync-merge")).toBeFocused();
        });
      }
      await closeWith(page, dialog, "Escape");
    }
    expect(requests.seen).toEqual([]);

    await test.step("the Sync dialog opened from the Publish menu and closed: the chip opens it on the first press, and again", async () => {
      await mouseClick(page, arrow(page));
      await mouseClick(page, page.getByTestId("menu-sync"));
      await expect(dialog).toBeVisible();
      await closeWith(page, dialog, "Escape");
      for (const how of KEYS_AND_MOUSE) {
        await press(page, how);
        await expect(dialog).toBeVisible();
        await closeWith(page, dialog, "Escape");
        await expectFocusOnChip(page);
      }
      expect(requests.seen).toEqual([]);
    });

    await test.step("after Keep mine the chip says Up to date and opens Commit on the first press", async () => {
      await press(page, "mouse");
      await mouseClick(page, page.getByTestId("sync-keep-mine"));
      await expect(page.getByTestId("sync-done")).toContainText("Published");
      await expect(dialog).toHaveCount(0, { timeout: 15_000 });
      await requests.settled();
      await expectStatus(page, "in-sync");
      await expectFocusOnChip(page);
      await toastsGone(page);
      await press(page, "mouse");
      await expect(commitDialog(page)).toBeVisible();
      await closeWith(page, commitDialog(page), "Escape");
      expect(requests.seen).toEqual(["/publish?force=1"]);
      expect(await remoteText(page, doc)).toBe(LOCAL_EDIT);
    });
  });
});

test.describe("status chip: a press right after the status changed in the open page acts on the first try", () => {
  for (const how of KEYS_AND_MOUSE) {
    test(`${how}: a poll turns Up to date into Pull, the press pulls once; the pull turns it into Up to date, the press opens Commit`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-change-pull-${how}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, "in-sync");
      await openEditor(page, doc.id, "in-sync");
      const requests = requestsOf(page);
      // Keyboard: focus rests on the chip while its label changes under it. Mouse: the pointer rests on it.
      if (how === "mouse") await page.mouse.move(...(Object.values(await pointOn(chip(page))) as [number, number]));
      else await chip(page).focus();
      await setRemote(page, doc, REMOTE_EDIT);
      await expectChipSays(page, "remote-ahead");
      await press(page, how);
      await expect.poll(() => requests.seen).toEqual(["/pull"]);
      await expectChipSays(page, "in-sync");
      await expectFocusOnChip(page);
      await press(page, how);
      await expect(commitDialog(page)).toBeVisible();
      await closeWith(page, commitDialog(page), "Escape");
      await expectFocusOnChip(page);
      await requests.settled();
      expect(requests.seen).toEqual(["/pull"]);
      expect(await documentText(page, doc.id)).toBe(REMOTE_EDIT);
    });
  }

  for (const how of ["mouse", "Enter"] as const) {
    test(`${how}: own typing turns Up to date into Publish and the press opens Commit; a poll turns Publish into Both changed and the press opens Sync; a file that grows too large still opens Sync`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page } = await signInWith(browser, `chip-change-sync-${how}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, "in-sync");
      await openEditor(page, doc.id, "in-sync");
      const requests = requestsOf(page);

      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nTyped here.");
      await expectChipSays(page, "local-ahead");
      await press(page, how);
      await expect(commitDialog(page)).toBeVisible();
      await closeWith(page, commitDialog(page), "Escape");
      await expectFocusOnChip(page);

      await setRemote(page, doc, REMOTE_EDIT);
      await expectChipSays(page, "diverged");
      await press(page, how);
      await expect(syncDialog(page)).toBeVisible();
      await expect(page.getByTestId("sync-merge")).toBeFocused();
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);

      await setRemote(page, doc, "", OVERSIZED);
      await expectChipSays(page, "remote-unreadable");
      await press(page, how);
      await expect(syncDialog(page)).toBeVisible();
      await expect(page.getByTestId("sync-keep-mine")).toBeFocused();
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);
      expect(requests.seen).toEqual([]);
    });
  }

  test("touch: a poll turns Up to date into Pull and one tap pulls once; a poll turns Publish into Both changed and one tap opens Sync", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-change-touch", { hasTouch: true });
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const pulled = await linkedDocument(page, "in-sync");
    await openEditor(page, pulled.id, "in-sync");
    const requests = requestsOf(page);
    await setRemote(page, pulled, REMOTE_EDIT);
    await expectChipSays(page, "remote-ahead");
    await press(page, "touch");
    await expect.poll(() => requests.seen).toEqual(["/pull"]);
    await requests.settled();
    await expectChipSays(page, "in-sync");

    const both = await linkedDocument(page, "local-ahead");
    await openEditor(page, both.id, "local-ahead");
    await setRemote(page, both, REMOTE_EDIT);
    await expectChipSays(page, "diverged");
    await press(page, "touch");
    await expect(syncDialog(page)).toBeVisible();
    await closeWith(page, syncDialog(page), "Escape");
    expect(requests.seen).toEqual(["/pull"]);
  });
});

test.describe("status chip: one press is one action", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}: a double-click, slow double-clicks and a triple click on "Publish" and on "Both changed", at 10, 50 and 90 percent of the chip, open the dialog once, it stays open and nothing else is pressed`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { page } = await signInWith(browser, "chip-gestures-dialog", { viewport: viewport.size });
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const { state, dialog, focus } of [
        { state: "local-ahead", dialog: commitDialog(page), focus: "commit-message" },
        { state: "diverged", dialog: syncDialog(page), focus: "sync-merge" },
      ] as const) {
        const doc = await linkedDocument(page, state);
        await openEditor(page, doc.id, state);
        const requests = requestsOf(page);
        for (const gesture of GESTURES) {
          for (const spot of SPOTS) {
            await test.step(`"${LABELS[state].label}": ${gesture.name} at ${spot * 100} percent`, async () => {
              await expect(placeHold(page)).toHaveCount(0);
              const { x, y } = await pointOn(chip(page), spot);
              await gesture.run(page, x, y);
              // Every click of the gesture has been delivered. The dialog the first one opened is still there:
              // the others did not land on the page behind it (a click there closes a dialog), nor on the arrow.
              await expect(dialog).toBeVisible();
              await expect.poll(() => focusOf(page)).toBe(focus);
              await expect(page.getByRole("dialog")).toHaveCount(1);
              await expect(page.getByRole("menu")).toHaveCount(0);
              await closeWith(page, dialog, "Escape");
              await expectFocusOnChip(page);
            });
          }
        }
        expect(requests.seen).toEqual([]);
        expect(await documentText(page, doc.id)).toBe(LOCAL_EDIT);
      }
    });

    test(`${viewport.name}: a double-click, slow double-clicks and a triple click on "Pull", at 10, 50 and 90 percent of the chip, are one pull and press nothing else`, async ({ browser }) => {
      test.setTimeout(240_000);
      const { page } = await signInWith(browser, "chip-gestures-pull", { viewport: viewport.size });
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, "remote-ahead");
      await openEditor(page, doc.id, "remote-ahead");
      const requests = requestsOf(page);
      let round = 0;
      for (const gesture of GESTURES) {
        for (const spot of SPOTS) {
          await test.step(`${gesture.name} at ${spot * 100} percent`, async () => {
            // A new gesture: the place the gesture before it held is free again.
            await expect(placeHold(page)).toHaveCount(0);
            const { x, y } = await pointOn(chip(page), spot);
            await gesture.run(page, x, y);
            await expect.poll(() => requests.seen.length).toBe(++round);
            await requests.settled();
            // The pull has turned the chip into "Up to date", wider than "Pull", under the same pointer.
            await expectChipSays(page, "in-sync");
            await expectNothingOpen(page);
            await expectFocusOnChip(page);
            expect(requests.seen).toEqual(Array.from({ length: round }, () => "/pull"));
            // The next round: GitHub moves again and the chip says Pull again.
            await setRemote(page, doc, `${REMOTE_EDIT}\nRound ${round}.\n`);
            await expectChipSays(page, "remote-ahead");
          });
        }
      }
    });
  }

  test("two clicks 700 ms apart are two presses: on Both changed the second is a click outside the dialog and closes it, on Pull the second meets Up to date and opens Commit; a slow double-click (click count 2) is still one press", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-two-presses");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");

    await test.step("Both changed", async () => {
      const doc = await linkedDocument(page, "diverged");
      await openEditor(page, doc.id, "diverged");
      const requests = requestsOf(page);
      const { x, y } = await pointOn(chip(page));
      await page.mouse.click(x, y);
      await expect(syncDialog(page)).toBeVisible();
      await expect(placeHold(page)).toHaveCount(0); // Its time is over: the next click is a new press.
      await page.mouse.click(x, y);
      await expect(syncDialog(page)).toHaveCount(0);
      await expectFocusOnChip(page);
      expect(requests.seen).toEqual([]);
    });

    await test.step("Pull, then Up to date", async () => {
      const doc = await linkedDocument(page, "remote-ahead");
      await openEditor(page, doc.id, "remote-ahead");
      const requests = requestsOf(page);
      const { x, y } = await pointOn(chip(page));
      await page.mouse.click(x, y);
      await expect.poll(() => requests.seen).toEqual(["/pull"]);
      await requests.settled();
      await expectChipSays(page, "in-sync");
      await expect(placeHold(page)).toHaveCount(0);
      // A system set to a long double-click time still counts this click as the second of a double-click.
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await page.mouse.down({ clickCount: 3 });
      await page.mouse.up({ clickCount: 3 });
      await expectFocusOnChip(page);
      await expectNothingOpen(page);
      // A new press does what the chip says now.
      await page.mouse.click(x, y);
      await expect(commitDialog(page)).toBeVisible();
      await closeWith(page, commitDialog(page), "Escape");
      expect(requests.seen).toEqual(["/pull"]);
    });
  });

  test("touch: a double tap on Pull is one pull, and a double tap on Both changed opens Sync once and it stays open, at 10, 50 and 90 percent", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-double-tap", { hasTouch: true });
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    // The browser counts taps itself: a double tap starts a new count only once its double-tap time has passed
    // since the tap before it, and the chip's place is free again by then too.
    const newGesture = async () => {
      await page.waitForTimeout(700); // Time is the subject: longer than the double-tap time.
      await expect(placeHold(page)).toHaveCount(0);
    };
    const doubleTap = async (x: number, y: number) => {
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(120); // Time is the subject: the gap inside a double tap.
      await page.touchscreen.tap(x, y);
    };

    const both = await linkedDocument(page, "diverged");
    await openEditor(page, both.id, "diverged");
    const requests = requestsOf(page);
    for (const spot of SPOTS) {
      await newGesture();
      const { x, y } = await pointOn(chip(page), spot);
      await doubleTap(x, y);
      await expect(syncDialog(page)).toBeVisible();
      await expect.poll(() => focusOf(page)).toBe("sync-merge");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);
    }
    expect(requests.seen).toEqual([]);

    const pulled = await linkedDocument(page, "remote-ahead");
    await openEditor(page, pulled.id, "remote-ahead");
    const pulls = requestsOf(page);
    let round = 0;
    for (const spot of SPOTS) {
      await newGesture();
      const { x, y } = await pointOn(chip(page), spot);
      await doubleTap(x, y);
      await expect.poll(() => pulls.seen.length).toBe(++round);
      await pulls.settled();
      await expectChipSays(page, "in-sync");
      await expectNothingOpen(page);
      expect(pulls.seen).toEqual(Array.from({ length: round }, () => "/pull"));
      await setRemote(page, pulled, `${REMOTE_EDIT}\nRound ${round}.\n`);
      await expectChipSays(page, "remote-ahead");
    }
  });

  test("a held Enter and a held Space (repeats every 33 ms for 1.5 seconds) are one press: one pull, one gist publish, one Commit dialog with its message untouched, one Sync dialog with no choice run", async ({ browser }) => {
    test.setTimeout(240_000);
    const { page } = await signInWith(browser, "chip-held-keys");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const key of ["Enter", "Space"] as const) {
      await test.step(`${key} on Pull`, async () => {
        const doc = await linkedDocument(page, "remote-ahead");
        await openEditor(page, doc.id, "remote-ahead");
        const requests = requestsOf(page);
        await chip(page).focus();
        await holdKey(page, key, 1500);
        await expect.poll(() => requests.seen).toEqual(["/pull"]);
        await requests.settled();
        await expectChipSays(page, "in-sync");
        await expectNothingOpen(page);
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual(["/pull"]);
        expect(await documentText(page, doc.id)).toBe(REMOTE_EDIT);
      });
      await test.step(`${key} on a gist's Publish`, async () => {
        const doc = await linkedDocument(page, "local-ahead", "gist");
        await openEditor(page, doc.id, "local-ahead");
        const requests = requestsOf(page);
        await chip(page).focus();
        await holdKey(page, key, 1500);
        await expect.poll(() => requests.seen).toEqual(["/publish"]);
        await requests.settled();
        await expectChipSays(page, "in-sync");
        await expectNothingOpen(page);
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual(["/publish"]);
      });
      await test.step(`${key} on Publish`, async () => {
        const doc = await linkedDocument(page, "local-ahead");
        await openEditor(page, doc.id, "local-ahead");
        const requests = requestsOf(page);
        await chip(page).focus();
        await holdKey(page, key, 1500);
        await expect(commitDialog(page)).toBeVisible();
        const field = page.getByRole("dialog").getByTestId("commit-message");
        await expect(field).toBeFocused();
        await expect(field).toHaveValue(`Update ${doc.path}`);
        await closeWith(page, commitDialog(page), "Escape");
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual([]);
        expect(await documentText(page, doc.id)).toBe(LOCAL_EDIT);
      });
      await test.step(`${key} on Both changed`, async () => {
        const doc = await linkedDocument(page, "diverged");
        await openEditor(page, doc.id, "diverged");
        const requests = requestsOf(page);
        await chip(page).focus();
        await holdKey(page, key, 1500);
        await expect(syncDialog(page)).toBeVisible();
        await expect(page.getByTestId("sync-merge")).toBeFocused();
        await expect(page.getByTestId("sync-done")).toHaveCount(0);
        await closeWith(page, syncDialog(page), "Escape");
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual([]);
        expect(await documentText(page, doc.id)).toBe(LOCAL_EDIT);
        expect(await remoteText(page, doc)).toBe(REMOTE_EDIT);
      });
    }

    await test.step("an Enter held on the dialog's X closes the dialog; its repeats arrive on the chip and open nothing", async () => {
      const doc = await linkedDocument(page, "diverged");
      await openEditor(page, doc.id, "diverged");
      const requests = requestsOf(page);
      await press(page, "mouse");
      await expect(syncDialog(page)).toBeVisible();
      await closeButton(page).focus();
      await holdKey(page, "Enter", 1500);
      await expectNothingOpen(page);
      await expectFocusOnChip(page);
      expect(requests.seen).toEqual([]);
      // The key is up: the next Enter is a new press.
      await page.keyboard.press("Enter");
      await expect(syncDialog(page)).toBeVisible();
      await closeWith(page, syncDialog(page), "Escape");
    });
  });
});

test.describe("status chip: while a publish or a pull runs", () => {
  for (const { kind, state, sends } of [
    { kind: "repo", state: "remote-ahead", sends: "/pull" },
    { kind: "gist", state: "local-ahead", sends: "/publish" },
  ] as const) {
    test(`${kind}, "${LABELS[state].label}": the chip is off but keeps focus, more presses by mouse, Enter and Space send nothing, and it is on again when the request has ended`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-running-${kind}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const how of KEYS_AND_MOUSE) {
        await test.step(how, async () => {
          const doc = await linkedDocument(page, state, kind);
          await openEditor(page, doc.id, state);
          const requests = requestsOf(page);
          const release = await holdRequests(page);
          await press(page, how);
          await expect.poll(() => requests.seen).toEqual([sends]);
          // Off for a screen reader and for a press, but still a place focus can stay: never `disabled`.
          await expect(chip(page)).toHaveAttribute("aria-disabled", "true");
          await expect(chip(page)).toHaveJSProperty("disabled", false);
          await expect(chip(page).locator(".animate-spin")).toHaveCount(1);
          await expect(chip(page)).toHaveText(LABELS[state].label);
          await expectFocusOnChip(page);
          // The place hold of the first press is gone: these presses land on the chip itself, and it is off.
          await expect(placeHold(page)).toHaveCount(0);
          const { x, y } = await pointOn(chip(page));
          await page.mouse.click(x, y);
          await page.keyboard.press("Enter");
          await page.keyboard.press("Space");
          await expect(placeHold(page)).toHaveCount(0);
          await multiClick(page, x, y, 2, 120);
          await expectFocusOnChip(page);
          await expectNothingOpen(page);
          expect(requests.seen).toEqual([sends]);
          release();
          await requests.settled();
          await expectChipSays(page, "in-sync");
          await expect(chip(page)).not.toHaveAttribute("aria-disabled", "true");
          await expect(chip(page).locator(".animate-spin")).toHaveCount(0);
          await expectFocusOnChip(page);
          await expectNothingOpen(page);
          expect(requests.seen).toEqual([sends]);
          await page.unrouteAll({ behavior: "ignoreErrors" });
        });
      }
    });
  }

  test("a dialog the chip opened is closed while its request runs: focus is back on the chip, a press on the chip opens nothing and sends nothing, and the chip works again afterwards", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-running-dialog");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");

    for (const closer of ["Escape", "the X button", "a click outside"] as const) {
      await test.step(`Commit, closed by ${closer}`, async () => {
        const doc = await linkedDocument(page, "local-ahead");
        await openEditor(page, doc.id, "local-ahead");
        const requests = requestsOf(page);
        const release = await holdRequests(page);
        await press(page, "mouse");
        await expect(commitDialog(page)).toBeVisible();
        await mouseClick(page, page.getByTestId("commit-submit"));
        await expect.poll(() => requests.seen).toEqual(["/publish"]);
        await expect(chip(page)).toHaveAttribute("aria-disabled", "true");
        await closeWith(page, commitDialog(page), closer);
        await expectFocusOnChip(page);
        for (const how of KEYS_AND_MOUSE) await press(page, how);
        await expectNothingOpen(page);
        await expectFocusOnChip(page);
        release();
        await requests.settled();
        await expectChipSays(page, "in-sync");
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual(["/publish"]);
        await toastsGone(page);
        await press(page, "mouse");
        await expect(commitDialog(page)).toBeVisible();
        await closeWith(page, commitDialog(page), "Escape");
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }

    await test.step("Sync, Merge pressed, closed by Escape", async () => {
      const doc = await linkedDocument(page, "diverged");
      await openEditor(page, doc.id, "diverged");
      const requests = requestsOf(page);
      const release = await holdRequests(page);
      await press(page, "Enter");
      await expect(syncDialog(page)).toBeVisible();
      await mouseClick(page, page.getByTestId("sync-merge"));
      await expect.poll(() => requests.seen).toEqual(["/pull?merge=1"]);
      await expect(chip(page)).toHaveAttribute("aria-disabled", "true");
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);
      // The chip still says Both changed. While the merge runs it opens no second Sync dialog.
      for (const how of KEYS_AND_MOUSE) await press(page, how);
      await expectNothingOpen(page);
      release();
      await requests.settled();
      await expectChipSays(page, "local-ahead");
      await expectFocusOnChip(page);
      expect(requests.seen).toEqual(["/pull?merge=1"]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });
  });
});

test.describe("status chip: what changes without the user asking", () => {
  /** Sync has opened on its own: its choices are off and focus is on its body, not on a choice. */
  const expectUnprompted = async (page: Page) => {
    await expect(syncDialog(page)).toBeVisible();
    for (const testId of SYNC_CHOICES) await expect(page.getByTestId(testId)).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => focusOf(page)).toBe("sync-dialog");
  };

  for (const how of KEYS_AND_MOUSE) {
    test(`${how}: the chip still says Pull after the document was edited: the press sends the pull it shows, GitHub's answer opens Sync with its choices off, and more presses run nothing`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-stale-pull-${how}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, "remote-ahead");
      await openEditor(page, doc.id, "remote-ahead");
      const requests = requestsOf(page);
      // The page learns nothing new from here on: the chip keeps saying Pull while the document changes.
      await freezeStatus(page);
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type("\nTyped after the last status.");
      await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
      const local = await documentText(page, doc.id);
      expect(local).toContain("Typed after the last status.");
      await expectChipSays(page, "remote-ahead");

      const { x, y } = await pointOn(chip(page));
      if (how === "mouse") await multiClick(page, x, y, 2, 120);
      else await press(page, how);
      await expect.poll(() => requests.seen).toEqual(["/pull"]);
      await requests.settled();
      await expectUnprompted(page);
      // What a hand that is still on the key or on the mouse does next.
      if (how === "mouse") {
        // The rest of the double-click fell on the place the chip had, not on the page behind the dialog.
        await expect(syncDialog(page)).toBeVisible();
      } else {
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        await holdKey(page, "Enter", 500);
        await expectUnprompted(page);
      }
      expect(requests.seen).toEqual(["/pull"]);
      expect(await documentText(page, doc.id)).toBe(local);
      expect(await remoteText(page, doc)).toBe(REMOTE_EDIT);
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);
      // The answer has brought the status with it: the chip says Both changed now and opens Sync when asked.
      await expectChipSays(page, "diverged");
      await press(page, how);
      await expect(syncDialog(page)).toBeVisible();
      await expect(page.getByTestId("sync-merge")).toBeFocused();
      await closeWith(page, syncDialog(page), "Escape");
      expect(requests.seen).toEqual(["/pull"]);
    });
  }

  // A gist's chip acts at once, with no Commit dialog in between. GitHub must refuse what is stale there too.
  const STALE_GIST: { shown: SyncState; changed: "the gist on GitHub" | "the document"; sends: string; then: SyncState }[] = [
    { shown: "local-ahead", changed: "the gist on GitHub", sends: "/publish", then: "diverged" },
    { shown: "in-sync", changed: "the gist on GitHub", sends: "/publish", then: "remote-ahead" },
    { shown: "remote-ahead", changed: "the document", sends: "/pull", then: "diverged" },
  ];
  for (const { shown, changed, sends, then } of STALE_GIST) {
    test(`a gist's chip still says ${LABELS[shown].label} after ${changed} changed: the press sends the one ${sends} it shows, GitHub refuses it, Sync opens with its choices off, and neither side is overwritten (mouse, Enter)`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-stale-gist-${shown}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const how of ["mouse", "Enter"] as const) {
        await test.step(how, async () => {
          const doc = await linkedDocument(page, shown, "gist");
          await openEditor(page, doc.id, shown);
          const requests = requestsOf(page);
          const refused = page.waitForResponse((response) => PUBLISH_OR_PULL.test(new URL(response.url()).pathname) && response.request().method() === "POST");
          await freezeStatus(page);
          if (changed === "the document") {
            await page.locator(".cm-content").click();
            await page.keyboard.press("Control+End");
            await page.keyboard.type("\nTyped after the last status.");
            await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
            await expect.poll(() => documentText(page, doc.id)).toContain("Typed after the last status.");
          } else {
            await setRemote(page, doc, `${REMOTE_EDIT}\nChanged after the last status.\n`);
          }
          const local = await documentText(page, doc.id);
          const remote = await remoteText(page, doc);
          const revision = await gistRevision(page, doc);
          await expectChipSays(page, shown);

          await press(page, how);
          expect((await refused).status()).toBe(409);
          await requests.settled();
          await expectUnprompted(page);
          await page.keyboard.press("Enter");
          await page.keyboard.press("Space");
          await expectUnprompted(page);
          expect(requests.seen).toEqual([sends]);
          expect(await documentText(page, doc.id)).toBe(local);
          expect(await remoteText(page, doc)).toBe(remote);
          expect(await gistRevision(page, doc)).toBe(revision);
          await closeWith(page, syncDialog(page), "Escape");
          await expectFocusOnChip(page);
          await expectChipSays(page, then);
          await page.unrouteAll({ behavior: "ignoreErrors" });
        });
      }
    });
  }

  test("a poll changes the label under a resting pointer and under resting focus: the press does what the chip says at that moment, never what it said before", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-label-under-pointer");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const how of ["mouse", "Enter"] as const) {
      await test.step(`${how}: a gist's Publish becomes Both changed: Sync opens, nothing is published`, async () => {
        const doc = await linkedDocument(page, "local-ahead", "gist");
        await openEditor(page, doc.id, "local-ahead");
        const requests = requestsOf(page);
        const { x, y } = await pointOn(chip(page), 0.9);
        if (how === "mouse") await page.mouse.move(x, y);
        else await chip(page).focus();
        await setRemote(page, doc, REMOTE_EDIT);
        await expectChipSays(page, "diverged");
        if (how === "mouse") await page.mouse.click(x, y);
        else await page.keyboard.press("Enter");
        await expect(syncDialog(page)).toBeVisible();
        await expect(page.getByTestId("sync-merge")).toBeFocused();
        await closeWith(page, syncDialog(page), "Escape");
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual([]);
        expect(await remoteText(page, doc)).toBe(REMOTE_EDIT);
      });
      await test.step(`${how}: a gist's Up to date becomes Pull: one pull, no publish`, async () => {
        const doc = await linkedDocument(page, "in-sync", "gist");
        await openEditor(page, doc.id, "in-sync");
        const requests = requestsOf(page);
        const { x, y } = await pointOn(chip(page), 0.9);
        if (how === "mouse") await page.mouse.move(x, y);
        else await chip(page).focus();
        await setRemote(page, doc, REMOTE_EDIT);
        await expectChipSays(page, "remote-ahead");
        if (how === "mouse") await page.mouse.click(x, y);
        else await page.keyboard.press("Enter");
        await expect.poll(() => requests.seen).toEqual(["/pull"]);
        await requests.settled();
        await expectChipSays(page, "in-sync");
        await expectFocusOnChip(page);
        expect(requests.seen).toEqual(["/pull"]);
        expect(await documentText(page, doc.id)).toBe(REMOTE_EDIT);
      });
    }
  });

  // The plain Publish button opens the Publish menu. The chip that takes its place pulls or publishes. So focus
  // that rested on the button goes to the arrow beside the chip, which opens the same menu.
  for (const { kind, state } of [
    { kind: "repo", state: "remote-ahead" },
    { kind: "gist", state: "local-ahead" },
  ] as const) {
    test(`${kind}, "${LABELS[state].label}": focus on the Publish button when the chip takes its place goes to the arrow, Enter and Space there each open the Publish menu on the first press, and nothing is pulled or published`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-arrives-${kind}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      for (const key of ["Enter", "Space"] as const) {
        await test.step(key, async () => {
          const doc = await linkedDocument(page, state, kind);
          const requests = requestsOf(page);
          // The first status is held back: the header shows the plain Publish button for now.
          let release!: () => void;
          const gate = new Promise<void>((resolve) => (release = resolve));
          await page.route(onPath(SYNC_STATUS), async (route) => {
            await gate;
            await route.continue();
          });
          await openDocument(page, doc.id);
          await expect(chip(page)).toHaveText("Publish");
          await expect(status(page)).toHaveCount(0);
          await chip(page).focus();
          await expectFocusOnChip(page);

          release();
          await expectChipSays(page, state);
          await expect.poll(() => focusOf(page)).toBe("publish-menu");

          // The key the user had ready for Publish opens the Publish menu, on the first press.
          await page.keyboard.press(key);
          const menu = page.getByRole("menu");
          await expect(menu).toBeVisible();
          await expect(menu.getByRole("menuitem", { name: kind === "gist" ? "Update gist" : /Commit to GitHub/ })).toBeVisible();
          await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true);
          await page.keyboard.press("Escape");
          await expect(menu).toHaveCount(0);
          await expect.poll(() => focusOf(page)).toBe("publish-menu");
          expect(requests.seen).toEqual([]);
          expect(await remoteText(page, doc)).toBe(state === "remote-ahead" ? REMOTE_EDIT : BASE);
          expect(await documentText(page, doc.id)).toBe(state === "remote-ahead" ? BASE : LOCAL_EDIT);

          // The chip itself acts on its first press, when it is the chip the user presses.
          await press(page, key);
          await expect.poll(() => requests.seen).toEqual([state === "remote-ahead" ? "/pull" : "/publish"]);
          await requests.settled();
          await expectChipSays(page, "in-sync");
          await expectFocusOnChip(page);
          await page.unrouteAll({ behavior: "ignoreErrors" });
        });
      }
    });
  }

  test("a click on the Publish button before the first status opens the Publish menu and sends nothing", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-arrives-click");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const doc = await linkedDocument(page, "remote-ahead");
    const requests = requestsOf(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(onPath(SYNC_STATUS), async (route) => {
      await gate;
      await route.continue();
    });
    await openDocument(page, doc.id);
    await expect(chip(page)).toHaveText("Publish");
    await mouseClick(page, chip(page));
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(requests.seen).toEqual([]);
    release();
    await expectChipSays(page, "remote-ahead");
    expect(requests.seen).toEqual([]);
  });
  for (const how of ["mouse", "keyboard"] as const) {
    test(`the Publish menu, opened by ${how}, is open when the first status arrives: the chip takes the button's place under it, the menu keeps focus and still works, and nothing is pressed`, async ({ browser }) => {
      const { page } = await signInWith(browser, `chip-arrives-menu-${how}`);
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const doc = await linkedDocument(page, "diverged");
      const requests = requestsOf(page);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route(onPath(SYNC_STATUS), async (route) => {
        await gate;
        await route.continue();
      });
      await openDocument(page, doc.id);
      await expect(chip(page)).toHaveText("Publish");
      if (how === "mouse") await mouseClick(page, chip(page));
      else {
        await chip(page).focus();
        await page.keyboard.press("Enter");
      }
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const focusInMenu = () => page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'));
      await expect.poll(focusInMenu).toBe(true);

      release();
      // An open menu hides the rest of the page from assistive technology, so the chip is read by its text here.
      await expectStatus(page, "diverged");
      await expect(chip(page)).toHaveText("Both changed");
      await expect(menu).toBeVisible();
      await expect.poll(focusInMenu).toBe(true);
      await expectNothingOpenBut(page, "menu");
      expect(requests.seen).toEqual([]);

      // The menu still works: Sync opens from it, live, and closes back to the arrow.
      const entry = page.getByTestId("menu-sync");
      if (how === "mouse") await mouseClick(page, entry);
      else {
        for (let i = 0; i < 20 && !(await entry.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
        await expect(entry).toBeFocused();
        await page.keyboard.press("Enter");
      }
      await expect(syncDialog(page)).toBeVisible();
      await expect(page.getByTestId("sync-merge")).toBeFocused();
      await closeWith(page, syncDialog(page), "Escape");
      await expect.poll(() => focusOf(page)).toBe("publish-menu");
      // And the chip, which arrived under the open menu, acts on its first press.
      await press(page, how === "mouse" ? "mouse" : "Enter");
      await expect(syncDialog(page)).toBeVisible();
      await closeWith(page, syncDialog(page), "Escape");
      await expectFocusOnChip(page);
      expect(requests.seen).toEqual([]);
    });
  }

  test("a key or the mouse button goes down on the Publish button and comes up after a gist's chip has taken its place: the Publish menu is open, nothing is pressed and nothing is published", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-arrives-held");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const how of ["Space", "Enter", "mouse"] as const) {
      await test.step(how, async () => {
        // A gist that has unpublished changes: its chip would publish at once.
        const doc = await linkedDocument(page, "local-ahead", "gist");
        const requests = requestsOf(page);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route(onPath(SYNC_STATUS), async (route) => {
          await gate;
          await route.continue();
        });
        await openDocument(page, doc.id);
        await expect(chip(page)).toHaveText("Publish");
        await expect(status(page)).toHaveCount(0);
        if (how === "mouse") {
          const { x, y } = await pointOn(chip(page));
          await page.mouse.move(x, y);
          await page.mouse.down();
        } else {
          await chip(page).focus();
          await page.keyboard.down(how);
        }
        // The Publish button opens its menu when the key or the button goes down.
        await expect(page.getByRole("menu")).toBeVisible();
        release();
        await expectStatus(page, "local-ahead");
        if (how === "mouse") await page.mouse.up();
        else await page.keyboard.up(how);
        await expect(page.getByRole("menu")).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="menu"]'))).toBe(true);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect.poll(() => focusOf(page)).toMatch(/^publish-(menu|button)$/);
        await expectChipSays(page, "local-ahead");
        expect(requests.seen).toEqual([]);
        expect(await remoteText(page, doc)).toBe(BASE);
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  });

  test("focus in the editor, in the title and on the page stays where it is when the chip takes the Publish button's place", async ({ browser }) => {
    const { page } = await signInWith(browser, "chip-arrives-focus");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    for (const where of ["code pane", "title", "body"] as const) {
      await test.step(where, async () => {
        const doc = await linkedDocument(page, "local-ahead");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        await page.route(onPath(SYNC_STATUS), async (route) => {
          await gate;
          await route.continue();
        });
        await openDocument(page, doc.id);
        await expect(chip(page)).toHaveText("Publish");
        await expect(status(page)).toHaveCount(0);
        if (where === "code pane") await page.locator(".cm-content").click();
        else if (where === "title") await page.getByTestId("title").click();
        else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const before = await focusOf(page);
        expect(before).not.toBe("publish-button");
        release();
        await expectChipSays(page, "local-ahead");
        expect(await focusOf(page)).toBe(before);
        await page.unrouteAll({ behavior: "ignoreErrors" });
      });
    }
  });
});

test.describe("status chip: its place is kept for the rest of a pointer gesture, and only then", () => {
  test("the box covers the chip's rectangle and nothing else; a press on it leaves the dialog open and does not make the box stay longer; a press anywhere else, focus back on the chip, a key press and a new status never leave one behind", async ({ browser }) => {
    test.setTimeout(180_000);
    const { page } = await signInWith(browser, "chip-hold");
    test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
    const doc = await linkedDocument(page, "diverged");
    await openEditor(page, doc.id, "diverged");
    const requests = requestsOf(page);
    const dialog = syncDialog(page);
    const box = (target: Locator) => target.evaluate((el) => {
      const { left, top, width, height } = el.getBoundingClientRect();
      return [left, top, width, height].map(Math.round);
    });

    await test.step("a mouse click that acts: the box is the chip's rectangle, the arrow beside it is free", async () => {
      const chipBox = await box(chip(page));
      const { x, y } = await pointOn(chip(page));
      const arrowPoint = await pointOn(arrow(page));
      await page.mouse.click(x, y);
      // One read, at once, before the dialog is waited for: the box leaves 600 ms after the click, and a busy
      // machine can take longer than that to show the dialog.
      const held = await page.evaluate(
        ([px, py]) => ({
          boxes: [...document.querySelectorAll('[data-testid="place-hold"]')].map((el) => {
            const { left, top, width, height } = el.getBoundingClientRect();
            return [left, top, width, height].map(Math.round);
          }),
          atArrow: document.elementFromPoint(px, py)?.getAttribute("data-testid") ?? null,
        }),
        [arrowPoint.x, arrowPoint.y],
      );
      expect(held.boxes).toEqual([chipBox]);
      expect(held.atArrow).not.toBe("place-hold");
      await expect(dialog).toBeVisible();
    });

    await test.step("presses on the box do not close the dialog, start nothing, and the box still leaves on time", async () => {
      // Time is the subject: the box leaves 600 ms after the click that armed it, whatever lands on it meanwhile.
      const { x, y } = await pointOn(chip(page));
      await closeWith(page, dialog, "Escape");
      // Focus comes back to the chip one task after the dialog has left, and takes the first click's box with it.
      await expectFocusOnChip(page);
      await expect(placeHold(page)).toHaveCount(0);
      await page.mouse.click(x, y);
      const armed = Date.now();
      // The presses come at once, before the dialog is waited for: they have to land while the box is there, and a
      // busy machine can take longer than the box's 600 ms to show the dialog.
      for (const count of [2, 3, 1]) {
        await page.waitForTimeout(60);
        await page.mouse.down({ clickCount: count });
        await page.mouse.up({ clickCount: count });
      }
      await expect(placeHold(page)).toHaveCount(0);
      const gone = Date.now() - armed;
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("sync-merge")).toBeFocused();
      expect(gone).toBeLessThan(2_000);
      expect(gone).toBeGreaterThanOrEqual(500);
      // Its time is over: the same spot is the page behind the dialog again, and a click there closes the dialog.
      await page.mouse.click(x, y);
      await expect(dialog).toHaveCount(0);
      await expectFocusOnChip(page);
    });

    await test.step("a press anywhere else takes the box away at once", async () => {
      await press(page, "mouse");
      // Before the dialog is waited for, as above.
      await expect(placeHold(page)).toHaveCount(1);
      await expect(dialog).toBeVisible();
      await mouseClick(page, dialog.getByRole("heading", { name: "Sync with GitHub" }));
      await expect(placeHold(page)).toHaveCount(0);
      await expect(dialog).toBeVisible();
    });

    await test.step("focus back on the chip takes the box away at once: a click right after Escape is a press", async () => {
      await closeWith(page, dialog, "Escape");
      const { x, y } = await pointOn(chip(page));
      for (let round = 0; round < 3; round++) {
        // The click comes as soon as focus is back, with no wait for the box to go: a box that had stayed would
        // take this click, and the dialog would not open.
        await page.mouse.click(x, y);
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expectFocusOnChip(page);
      }
      await expect(placeHold(page)).toHaveCount(0);
    });

    await test.step("a key press, a status change and a press on a chip that is off leave no box", async () => {
      await press(page, "Enter");
      await expect(dialog).toBeVisible();
      await expect(placeHold(page)).toHaveCount(0);
      await closeWith(page, dialog, "Escape");
      await press(page, "Space");
      await expect(dialog).toBeVisible();
      await expect(placeHold(page)).toHaveCount(0);
      await closeWith(page, dialog, "Escape");
      await setRemote(page, doc, "", OVERSIZED);
      await expectChipSays(page, "remote-unreadable");
      await expect(placeHold(page)).toHaveCount(0);
    });
    expect(requests.seen).toEqual([]);
  });

  for (const how of ["mouse", "touch"] as const) {
    test(`${how}: after a pull, the arrow is free at once and opens its menu; a second press on the chip 300 ms later and 7 px away is not a press, and one 700 ms later is: a repository opens Commit, a gist asks GitHub once more and the gist is not written`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { page } = await signInWith(browser, `chip-second-press-${how}`, how === "touch" ? { hasTouch: true } : {});
      test.skip(!(await hasFakeGitHub(page)), "needs the fake GitHub of the e2e server");
      const hit = (x: number, y: number) => (how === "mouse" ? page.mouse.click(x, y) : page.touchscreen.tap(x, y));

      await test.step("the arrow, right after a pull changed the chip's width", async () => {
        const doc = await linkedDocument(page, "remote-ahead");
        await openEditor(page, doc.id, "remote-ahead");
        const requests = requestsOf(page);
        const arrowBox = await arrow(page).boundingBox();
        const { x, y } = await pointOn(chip(page));
        await hit(x, y);
        await expect.poll(() => requests.seen).toEqual(["/pull"]);
        await expectChipSays(page, "in-sync");
        // The chip is wider now. It grew to the left: the arrow has not moved and nothing lies over it.
        expect(await arrow(page).boundingBox()).toEqual(arrowBox);
        const a = await pointOn(arrow(page));
        await hit(a.x, a.y);
        await expect(page.getByRole("menu")).toBeVisible();
        await expect(placeHold(page)).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
        await requests.settled();
        expect(requests.seen).toEqual(["/pull"]);
      });

      for (const { kind, first, state } of [
        { kind: "repo", first: "/pull", state: "remote-ahead" },
        { kind: "gist", first: "/pull", state: "remote-ahead" },
        { kind: "gist", first: "/publish", state: "local-ahead" },
      ] as const) {
        await test.step(`${kind}, "${LABELS[state].label}"`, async () => {
          const doc = await linkedDocument(page, state, kind);
          await openEditor(page, doc.id, state);
          const requests = requestsOf(page);
          const { x, y } = await pointOn(chip(page));
          await hit(x, y);
          // Time is the subject: a second press well inside the 600 ms the chip's place is kept, 7 px away
          // (too far for the browser to count it as the second click of a double-click).
          await page.waitForTimeout(300);
          await hit(x + 7, y);
          await expect.poll(() => requests.seen).toEqual([first]);
          await requests.settled();
          await expectChipSays(page, "in-sync");
          await expectNothingOpen(page);
          await expectFocusOnChip(page);
          expect(requests.seen).toEqual([first]);
          const revision = kind === "gist" ? await gistRevision(page, doc) : null;
          const remote = await remoteText(page, doc);

          // A new press, once the place hold is gone: it does what the chip says now, "Up to date". The browser
          // counts taps itself, so a tap waits until it can no longer be the third of a triple tap.
          if (how === "touch") await page.waitForTimeout(700); // Time is the subject: the double-tap time.
          await press(page, how);
          if (kind === "repo") {
            await expect(commitDialog(page)).toBeVisible();
            await closeWith(page, commitDialog(page), "Escape");
            expect(requests.seen).toEqual([first]);
          } else {
            await expect.poll(() => requests.seen).toEqual([first, "/publish"]);
            await requests.settled();
            await expectNothingOpen(page);
            // GitHub had this text already: the request wrote nothing.
            expect(await gistRevision(page, doc)).toBe(revision);
          }
          expect(await remoteText(page, doc)).toBe(remote);
          await expectFocusOnChip(page);
        });
      }
    });
  }
});