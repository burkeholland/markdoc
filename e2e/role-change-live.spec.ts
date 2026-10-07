import { test, expect } from "./fixtures";
import type { Browser, Page, WebSocketRoute } from "@playwright/test";
import { codeText, createDocument, openDocument, signIn, uniqueLogin, waitForEditor, type User } from "./helpers";

/**
 * Issue #2269: an owner changes someone's access while that person has the document open.
 *
 * The server tells the affected connection. The open page does not switch roles in place: lowered or
 * removed, both panes go read-only at once and a dialog that only its button leaves says what happened;
 * raised, a quiet bar offers the reload. Nothing typed after the change may reach the owner's document
 * or look saved, and no key or click that was meant for the editor may press the dialog's button.
 *
 * Two real browser contexts, real keys. The owner acts through the API, as the Share dialog does. The e2e
 * server pauses every access change for `COLLAB_ACCESS_CHANGE_TEST_DELAY_MS` (40 ms, playwright.config.ts);
 * against an already running server (PROD_BASE_URL) the value comes from the environment.
 */
const DELAY_MS = Number(process.env.COLLAB_ACCESS_CHANGE_TEST_DELAY_MS ?? (process.env.PROD_BASE_URL ? 0 : 40));
const BURST = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4).slice(0, 120);
const CONTENT = "# Role change\n\nStart here.\n\nAlpha word.\n\nBeta word.\n";

const TITLE = "Your access changed";
const LOWERED = (role: "Viewer" | "Commenter" | "Editor") => `The owner changed your access to this document to ${role}. Reload to continue.`;
const REMOVED = "You no longer have access to this document.";
const UNSAVED = "Changes you made in the last moments were not saved.";
const CAN_EDIT = "You can now edit this document.";
const CAN_COMMENT = "You can now comment on this document.";

type RowRole = "editor" | "commenter" | "viewer";
type Link = "private" | "view" | "comment" | "edit";

const collaborators = (id: string) => `/api/documents/${id}/collaborators`;
const liveText = async (owner: Page, id: string) => ((await (await owner.request.get(`/api/documents/${id}/content`)).json()) as { content: string }).content;
const saved = (page: Page) => expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");
const dialog = (page: Page) => page.getByTestId("access-changed-dialog");
const action = (page: Page) => page.getByTestId("access-changed-action");
const raisedNotice = (page: Page) => page.getByTestId("access-raised-notice");

interface Scene {
  owner: User;
  person: User;
  id: string;
  /** A marker of its own per test, so a text can never be found by accident. */
  tag: string;
}

async function scene(browser: Browser, { link = "private", row = "editor", prepare }: { link?: Link; row?: RowRole | null; prepare?: (person: User) => Promise<void> } = {}): Promise<Scene> {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
  const owner = await signIn(browser, uniqueLogin("role-owner"));
  const person = await signIn(browser, uniqueLogin("role-person"));
  const id = await createDocument(owner.page, CONTENT);
  if (link !== "private") expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: link } })).ok()).toBeTruthy();
  if (row) expect((await owner.page.request.post(collaborators(id), { data: { login: person.login, role: row } })).ok()).toBeTruthy();
  await prepare?.(person);
  await openDocument(owner.page, id);
  await openDocument(person.page, id);
  await markLoad(person.page);
  return { owner, person, id, tag };
}

const setRole = async (s: Scene, role: RowRole, login = s.person.login) =>
  expect((await s.owner.page.request.post(collaborators(s.id), { data: { login, role, change: true } })).status(), `set ${role}`).toBe(200);
const removeRow = async (s: Scene) => expect((await s.owner.page.request.delete(collaborators(s.id), { data: { login: s.person.login } })).status(), "remove").toBe(200);
const setLink = async (s: Scene, link: Link) => expect((await s.owner.page.request.patch(`/api/documents/${s.id}`, { data: { linkAccess: link } })).status(), `link ${link}`).toBe(200);

/** This load of the page is marked; a reload or a navigation loses the mark. */
const markLoad = (page: Page) => page.evaluate(() => void ((window as unknown as { __roleChangeLoad?: boolean }).__roleChangeLoad = true));
const sameLoad = (page: Page) =>
  page.evaluate(() => (window as unknown as { __roleChangeLoad?: boolean }).__roleChangeLoad === true).catch(() => false);

/** The owner types a marker; once it is stored, the server has handled everything that was sent before it. */
async function ownerMarker({ owner, id, tag }: Scene, name = "OWNER"): Promise<string> {
  const marker = `${name}${tag}`;
  await owner.page.locator(".cm-content").click();
  await owner.page.keyboard.press("Control+Home");
  await owner.page.keyboard.press("End");
  await owner.page.keyboard.type(` ${marker}`);
  await expect.poll(() => liveText(owner.page, id)).toContain(marker);
  await saved(owner.page);
  return marker;
}

/** The blocking dialog as the person meets it: the words, one button with focus on it, both panes read-only. */
async function expectBlocked(page: Page, text: string, { button = "Reload", unsaved }: { button?: string; unsaved?: boolean } = {}) {
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("role", "dialog");
  await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
  await expect(dialog(page)).toHaveAccessibleName(TITLE);
  await expect(dialog(page)).toHaveAccessibleDescription(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  await expect(dialog(page).getByRole("heading", { name: TITLE })).toBeVisible();
  await expect(page.getByTestId("access-changed-text")).toHaveText(text);
  await expect(dialog(page).getByRole("button")).toHaveCount(1);
  await expect(action(page)).toHaveText(button);
  await expect(action(page)).toBeFocused();
  if (unsaved !== undefined) await expect(page.getByTestId("access-changed-unsaved")).toHaveCount(unsaved ? 1 : 0);
  if (unsaved) await expect(page.getByTestId("access-changed-unsaved")).toHaveText(UNSAVED);
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".md-rich")).toHaveAttribute("contenteditable", "false");
}

/** A press that is meant for the button: after the page has been quiet, one click. */
async function pressAction(page: Page) {
  await expect(action(page)).toHaveAttribute("data-armed", "true");
  await action(page).click();
}

/** Reload through the button and wait for the page the server renders now. */
async function reloadThroughAction(page: Page) {
  await pressAction(page);
  await expect.poll(() => sameLoad(page), "the page loads again").toBe(false);
  await waitForEditor(page);
  await saved(page);
}

/** Type `text` key by key and remember when each key was sent. */
async function typeKeys(page: Page, text: string, stamps: number[]) {
  for (const key of text) {
    stamps.push(Date.now());
    await page.keyboard.type(key);
  }
}

/** The person types `text` at the end of the document; once a quarter of it is typed, `change` runs alongside. */
async function typeThrough(person: Page, text: string, change: () => Promise<unknown>) {
  const stamps: number[] = [];
  await person.locator(".cm-content").click();
  await person.keyboard.press("Control+End");
  await person.keyboard.press("Enter");
  const typing = typeKeys(person, text, stamps);
  await expect.poll(() => stamps.length, { intervals: [5] }).toBeGreaterThanOrEqual(Math.floor(text.length / 4));
  const sent = Date.now();
  await change();
  const answered = Date.now();
  await typing;
  // The pause had real width, and keys were sent while the change ran: otherwise this proves nothing.
  expect(answered - sent, "the access change took at least the configured delay").toBeGreaterThanOrEqual(DELAY_MS);
  const during = stamps.filter((at) => at >= sent && at <= answered).length;
  expect(during, "keys sent while the access change ran").toBeGreaterThanOrEqual(DELAY_MS >= 40 ? 2 : 1);
  expect(stamps.at(-1)!, "the person was still typing when the change had ended").toBeGreaterThan(answered);
  return { stamps, sent, answered };
}

/** How many leading characters of `typed` are in `text`. */
function prefixIn(text: string, typed: string): number {
  for (let n = typed.length; n > 0; n -= 1) if (text.includes(typed.slice(0, n))) return n;
  return 0;
}

/**
 * The owner's document holds what was typed before the change and nothing that was sent after it was
 * answered; the person's own copy stopped growing when the notice came.
 */
async function expectNothingAfterTheChange(s: Scene, burst: string, { stamps, sent, answered }: { stamps: number[]; sent: number; answered: number }) {
  await ownerMarker(s);
  const text = await liveText(s.owner.page, s.id);
  const accepted = prefixIn(text, burst);
  const longBefore = stamps.filter((at) => at < sent - 250).length;
  expect(longBefore).toBeGreaterThan(0);
  expect(accepted, "keys typed well before the change are kept").toBeGreaterThanOrEqual(longBefore);
  const sentAfter = stamps.findIndex((at) => at > answered);
  expect(sentAfter).toBeGreaterThan(0);
  expect(accepted, "no key sent after the change was answered is in the owner's document").toBeLessThanOrEqual(sentAfter);
  expect(prefixIn(await codeText(s.owner.page), burst), "the owner's page shows the same").toBe(accepted);
  return accepted;
}

test.describe("a person's access changes while the document is open (#2269)", () => {
  for (const lowered of [
    { to: "viewer", name: "Viewer", mode: "Viewing" },
    { to: "commenter", name: "Commenter", mode: "Viewing" },
  ] as const) {
    test(`editor to ${lowered.to} while typing: the dialog says so, the panes stop taking input, nothing typed afterwards reaches the owner, and Reload shows the server's document and "Saved"`, async ({ browser }) => {
      const s = await scene(browser);
      const burst = `${s.tag}${BURST}`;
      const typed = await typeThrough(s.person.page, burst, () => setRole(s, lowered.to));

      // Keys were waiting on the server when the change ended: they were refused, and the person is told.
      await expectBlocked(s.person.page, LOWERED(lowered.name), { unsaved: true });
      // Still the page that was open: the keys of the burst that came after the dialog pressed nothing.
      expect(await sameLoad(s.person.page)).toBe(true);

      // Nothing typed from here on enters even the person's own copy: not by key, not after a click on the editor.
      const frozen = await codeText(s.person.page);
      const later = `later${s.tag}typedafterwards`;
      await s.person.page.keyboard.type(later);
      const box = (await s.person.page.locator(".cm-content").boundingBox())!;
      await s.person.page.mouse.click(box.x + 40, box.y + 20);
      await s.person.page.keyboard.type(later);
      expect(await codeText(s.person.page)).toBe(frozen);
      expect(prefixIn(frozen, burst), "the person's copy stopped before the end of the burst").toBeLessThan(burst.length);
      await expect(action(s.person.page)).toBeFocused();

      const accepted = await expectNothingAfterTheChange(s, burst, typed);
      expect(await liveText(s.owner.page, s.id)).not.toContain(later);

      await reloadThroughAction(s.person.page);
      await expect(dialog(s.person.page)).toHaveCount(0);
      await expect(s.person.page.getByTestId("mode-switcher")).toContainText(lowered.mode);
      await expect(s.person.page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
      // The server's document, not what this browser had kept: the refused keys are gone.
      await expect.poll(() => codeText(s.person.page)).toBe(await liveText(s.owner.page, s.id));
      expect(prefixIn(await codeText(s.person.page), burst)).toBe(accepted);
      await saved(s.person.page);
    });
  }

  test("commenter to viewer with a comment being written: the dialog comes, says the unsent work is lost, and the reloaded page is a Viewer's", async ({ browser }) => {
    const s = await scene(browser, { row: "commenter" });
    const { page } = s.person;
    await page.locator(".md-rich p", { hasText: "Beta word." }).dblclick();
    await page.getByTestId("tb-comment").click();
    const composer = page.getByTestId("comment-composer").first();
    await expect(composer).toBeFocused();
    await page.keyboard.type(`A draft ${s.tag}`);
    await expect(composer).toHaveValue(`A draft ${s.tag}`);

    await setRole(s, "viewer");
    await expectBlocked(page, LOWERED("Viewer"), { unsaved: true });
    // The composer cannot be reached any more: Enter does not send the draft.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeVisible();
    expect((await (await s.owner.page.request.get(`/api/documents/${s.id}/comments`)).text()).includes(s.tag)).toBe(false);

    await reloadThroughAction(page);
    await expect(page.getByTestId("tb-comment")).toHaveCount(0);
    await expect(page.getByTestId("comment-composer")).toHaveCount(0);
  });

  test("removed: the dialog comes at once, its button leads to the documents, and nothing of the document is kept on the device", async ({ browser }) => {
    const s = await scene(browser);
    const burst = `${s.tag}${BURST}`;
    const typed = await typeThrough(s.person.page, burst, () => removeRow(s));

    await expectBlocked(s.person.page, REMOVED, { button: "Go to your documents", unsaved: true });
    // No second message about a connection problem next to it.
    await expect(s.person.page.getByText("Could not connect to the collaboration server")).toHaveCount(0);
    expect(await sameLoad(s.person.page)).toBe(true);
    const accepted = await expectNothingAfterTheChange(s, burst, typed);

    await pressAction(s.person.page);
    await s.person.page.waitForURL((url) => url.pathname === "/");

    // Given the document back, the person gets the server's text: the refused keys were not kept anywhere.
    expect((await s.owner.page.request.post(collaborators(s.id), { data: { login: s.person.login, role: "editor" } })).ok()).toBeTruthy();
    await openDocument(s.person.page, s.id);
    await expect.poll(() => codeText(s.person.page)).toBe(await liveText(s.owner.page, s.id));
    expect(prefixIn(await codeText(s.person.page), burst)).toBe(accepted);
    await saved(s.person.page);
    await saved(s.owner.page);
    expect(prefixIn(await liveText(s.owner.page, s.id), burst)).toBe(accepted);
  });

  for (const raised of [
    { from: "viewer", to: "editor", text: CAN_EDIT },
    { from: "commenter", to: "editor", text: CAN_EDIT },
    { from: "viewer", to: "commenter", text: CAN_COMMENT },
  ] as const) {
    test(`${raised.from} to ${raised.to}: a quiet notice with Reload, no dialog, focus stays where it was, and the reloaded page has the new role`, async ({ browser }) => {
      const s = await scene(browser, { row: raised.from });
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await expect(page.locator(".cm-content")).toBeFocused();

      await setRole(s, raised.to);
      await expect(raisedNotice(page)).toBeVisible();
      await expect(raisedNotice(page)).toHaveAttribute("role", "status");
      await expect(page.getByTestId("access-changed-text")).toHaveText(raised.text);
      await expect(action(page)).toHaveText("Reload");
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.locator(".cm-content"), "focus is not taken").toBeFocused();
      // Nothing is blocked: the page works as before.
      await page.keyboard.press("Control+f");
      await expect(page.getByTestId("find-bar")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(await sameLoad(page)).toBe(true);

      await reloadThroughAction(page);
      await expect(raisedNotice(page)).toHaveCount(0);
      if (raised.to === "editor") {
        await expect(page.getByTestId("mode-switcher")).toContainText("Editing");
        const text = `raised${s.tag}canedit`;
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.type(text);
        await expect.poll(() => liveText(s.owner.page, s.id)).toContain(text);
        await saved(page);
      } else {
        await expect(page.getByTestId("tb-comment")).toBeEnabled();
      }
    });
  }

  test.describe("the link's access", () => {
    test("edit to view for a person who is in through the link: the dialog, and nothing typed afterwards reaches the owner", async ({ browser }) => {
      const s = await scene(browser, { link: "edit", row: null });
      const burst = `${s.tag}${BURST}`;
      const typed = await typeThrough(s.person.page, burst, () => setLink(s, "view"));
      await expectBlocked(s.person.page, LOWERED("Viewer"), { unsaved: true });
      const accepted = await expectNothingAfterTheChange(s, burst, typed);

      await reloadThroughAction(s.person.page);
      await expect(s.person.page.getByTestId("mode-switcher")).toContainText("Viewing");
      await expect.poll(() => codeText(s.person.page)).toBe(await liveText(s.owner.page, s.id));
      expect(prefixIn(await codeText(s.person.page), burst)).toBe(accepted);
      await saved(s.person.page);
    });

    test("edit to off for a person who is in through the link: the same dialog as a removal", async ({ browser }) => {
      const s = await scene(browser, { link: "edit", row: null });
      await s.person.page.locator(".cm-content").click();
      await setLink(s, "private");
      await expectBlocked(s.person.page, REMOVED, { button: "Go to your documents", unsaved: false });
      await pressAction(s.person.page);
      await s.person.page.waitForURL((url) => url.pathname === "/");
    });

    test("a person who is also an explicit collaborator hears nothing when the link changes, and keeps editing", async ({ browser }) => {
      const s = await scene(browser, { link: "edit", row: "editor" });
      await setLink(s, "private");
      const text = `still${s.tag}editing`;
      await s.person.page.locator(".cm-content").click();
      await s.person.page.keyboard.press("Control+End");
      await s.person.page.keyboard.type(text);
      await expect.poll(() => liveText(s.owner.page, s.id)).toContain(text);
      await saved(s.person.page);
      await expect(dialog(s.person.page)).toHaveCount(0);
      await expect(raisedNotice(s.person.page)).toHaveCount(0);
    });
  });

  test.describe("who is told", () => {
    test("the owner and another collaborator see nothing; both tabs of the person see the dialog", async ({ browser }) => {
      const s = await scene(browser);
      const other = await signIn(browser, uniqueLogin("role-other"));
      expect((await s.owner.page.request.post(collaborators(s.id), { data: { login: other.login, role: "editor" } })).ok()).toBeTruthy();
      await openDocument(other.page, s.id);
      const secondTab = await s.person.context.newPage();
      await openDocument(secondTab, s.id);

      await setRole(s, "viewer");
      await expectBlocked(secondTab, LOWERED("Viewer"), { unsaved: false });
      await s.person.page.bringToFront();
      await expectBlocked(s.person.page, LOWERED("Viewer"), { unsaved: false });

      // The bystander types and the owner sees it: everything sent before that has been handled.
      const text = `bystander${s.tag}`;
      await other.page.locator(".cm-content").click();
      await other.page.keyboard.press("Control+End");
      await other.page.keyboard.type(text);
      await expect.poll(() => codeText(s.owner.page)).toContain(text);
      for (const page of [other.page, s.owner.page]) {
        await expect(dialog(page)).toHaveCount(0);
        await expect(raisedNotice(page)).toHaveCount(0);
      }
    });
  });

  test.describe("two changes in a row", () => {
    test("editor to viewer and back to editor: the dialog stays, names the role the server holds now, and the reloaded page edits", async ({ browser }) => {
      const s = await scene(browser);
      await s.person.page.locator(".cm-content").click();
      await setRole(s, "viewer");
      await setRole(s, "editor");
      await expectBlocked(s.person.page, LOWERED("Editor"), { unsaved: false });
      expect(await sameLoad(s.person.page)).toBe(true);

      await reloadThroughAction(s.person.page);
      await expect(s.person.page.getByTestId("mode-switcher")).toContainText("Editing");
      const text = `again${s.tag}editor`;
      await s.person.page.locator(".cm-content").click();
      await s.person.page.keyboard.press("Control+End");
      await s.person.page.keyboard.type(text);
      await expect.poll(() => liveText(s.owner.page, s.id)).toContain(text);
      await saved(s.person.page);
    });

    test("lowered and then removed: the dialog changes to the removal and its button to the documents", async ({ browser }) => {
      const s = await scene(browser);
      await s.person.page.locator(".cm-content").click();
      await setRole(s, "commenter");
      await expectBlocked(s.person.page, LOWERED("Commenter"), { unsaved: false });
      await removeRow(s);
      await expectBlocked(s.person.page, REMOVED, { button: "Go to your documents", unsaved: false });
      await pressAction(s.person.page);
      await s.person.page.waitForURL((url) => url.pathname === "/");
    });

    test("viewer to editor and back to viewer: the notice goes away again and nothing was blocked", async ({ browser }) => {
      const s = await scene(browser, { row: "viewer" });
      await setRole(s, "editor");
      await expect(raisedNotice(s.person.page)).toBeVisible();
      await setRole(s, "viewer");
      await expect(raisedNotice(s.person.page)).toHaveCount(0);
      await expect(dialog(s.person.page)).toHaveCount(0);
      expect(await sameLoad(s.person.page)).toBe(true);
    });
  });

  test.describe("the change happens while the person has no connection", () => {
    /** The person's collaboration socket can be cut and kept from coming back, as a lost network does. */
    async function cuttable(person: User) {
      const state = { blocked: false, routes: [] as WebSocketRoute[], opened: 0 };
      await person.page.routeWebSocket(/\/collab/, (ws) => {
        if (state.blocked) {
          void ws.close({ code: 1006, reason: "offline (e2e)" });
          return;
        }
        state.opened += 1;
        state.routes.push(ws);
        ws.connectToServer();
      });
      return {
        state,
        cut: async () => {
          state.blocked = true;
          for (const ws of state.routes.splice(0)) await ws.close({ code: 1006, reason: "offline (e2e)" }).catch(() => undefined);
          await person.context.setOffline(true);
          await expect(person.page.getByTestId("save-state")).toHaveAttribute("data-state", /offline|reconnecting/);
        },
        restore: async () => {
          state.blocked = false;
          await person.context.setOffline(false);
        },
      };
    }

    test("lowered while offline, with text typed offline: on reconnect the dialog says so and that the text was not saved; Reload shows the server's document", async ({ browser }) => {
      let net!: Awaited<ReturnType<typeof cuttable>>;
      const s = await scene(browser, { prepare: async (person) => void (net = await cuttable(person)) });
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await net.cut();
      await setRole(s, "viewer");
      const offline = `offline${s.tag}typedwithoutaconnection`;
      await page.keyboard.type(offline);
      await expect.poll(() => codeText(page)).toContain(offline);
      await expect(dialog(page)).toHaveCount(0);

      await net.restore();
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: true });
      await ownerMarker(s);
      expect(await liveText(s.owner.page, s.id)).not.toContain(offline);

      await reloadThroughAction(page);
      await expect(page.getByTestId("mode-switcher")).toContainText("Viewing");
      await expect.poll(() => codeText(page)).toBe(await liveText(s.owner.page, s.id));
      expect(await codeText(page)).not.toContain(offline);
      await saved(page);
    });

    test("removed while offline: on reconnect the removal dialog, not a connection error", async ({ browser }) => {
      let net!: Awaited<ReturnType<typeof cuttable>>;
      const s = await scene(browser, { prepare: async (person) => void (net = await cuttable(person)) });
      await s.person.page.locator(".cm-content").click();
      await net.cut();
      await removeRow(s);
      await net.restore();
      await expectBlocked(s.person.page, REMOVED, { button: "Go to your documents", unsaved: false });
      await expect(s.person.page.getByText("Could not connect to the collaboration server")).toHaveCount(0);
    });

    test("raised while offline: on reconnect the quiet notice", async ({ browser }) => {
      let net!: Awaited<ReturnType<typeof cuttable>>;
      const s = await scene(browser, { row: "viewer", prepare: async (person) => void (net = await cuttable(person)) });
      await net.cut();
      await setRole(s, "editor");
      await net.restore();
      await expect(raisedNotice(s.person.page)).toBeVisible();
      await expect(s.person.page.getByTestId("access-changed-text")).toHaveText(CAN_EDIT);
      await expect(dialog(s.person.page)).toHaveCount(0);
    });

    test("a connection that only drops and comes back, with no change of access, shows nothing and goes on saving", async ({ browser }) => {
      let net!: Awaited<ReturnType<typeof cuttable>>;
      const s = await scene(browser, { prepare: async (person) => void (net = await cuttable(person)) });
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      await net.cut();
      const text = `dropped${s.tag}andback`;
      await page.keyboard.type(text);
      await net.restore();
      await expect.poll(() => net.state.opened, "a second socket").toBeGreaterThanOrEqual(2);
      await expect.poll(() => liveText(s.owner.page, s.id)).toContain(text);
      await saved(page);
      await expect(dialog(page)).toHaveCount(0);
      await expect(raisedNotice(page)).toHaveCount(0);
      await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
    });

    test("a change between the page's token and its connection: the page is told as the connection opens", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      // The next load of the page: its token is fetched (the server answers Editor) and held back.
      let fetched!: () => void;
      const tokenFetched = new Promise<void>((resolve) => (fetched = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/documents/*/collab-token", async (route) => {
        // A request of the runner itself to the dev server is reset now and then (known noise): once more then.
        const response = await route.fetch().catch(() => route.fetch());
        fetched();
        await released;
        await route.fulfill({ response });
      });
      await page.goto(`/d/${s.id}`);
      await waitForEditor(page);
      await tokenFetched;
      await setRole(s, "viewer");
      release();
      await expectBlocked(page, LOWERED("Viewer"));
    });
  });

  test.describe("input that was under way when the dialog arrived never presses its button", () => {
    /**
     * `each` runs over and over, across the change and for `more` rounds after the dialog is on screen.
     * `onDialog` runs once the dialog is visible (to aim the pointer at the button, for instance).
     */
    async function across(s: Scene, each: () => Promise<void>, change: () => Promise<void>, { more = 25, onDialog }: { more?: number; onDialog?: () => Promise<void> } = {}) {
      const { page } = s.person;
      let stop = false;
      let rounds = 0;
      let failed: unknown;
      const loop = (async () => {
        while (!stop) {
          await each();
          rounds += 1;
        }
      })().catch((error) => (failed = error));
      await expect.poll(() => rounds, { intervals: [10] }).toBeGreaterThanOrEqual(5);
      await change();
      await expect(dialog(page)).toBeVisible();
      await onDialog?.();
      const seen = rounds;
      await expect.poll(() => rounds, { intervals: [20] }).toBeGreaterThanOrEqual(seen + more);
      stop = true;
      await loop;
      expect(failed, "the input loop").toBeUndefined();
    }

    /** The dialog is still there on the same page load, and now that the input has stopped a meant press works. */
    async function expectUnpressedThenPress(s: Scene, text: string, press: (page: Page) => Promise<void>, left: (page: Page) => Promise<boolean> = async (page) => !(await sameLoad(page))) {
      const { page } = s.person;
      expect(await sameLoad(page), "nothing reloaded the page").toBe(true);
      expect(new URL(page.url()).pathname).toBe(`/d/${s.id}`);
      await expect(page.getByTestId("access-changed-text")).toHaveText(text);
      await expect(action(page)).toBeFocused();
      await expect(action(page)).toHaveAttribute("data-armed", "true");
      await press(page);
      await expect.poll(() => left(page), "a press that is meant works").toBe(true);
    }

    test("fast typing with Enter and Space in it (a key every 30 ms)", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+End");
      const keys = ["a", "Enter", "b", " ", "c", "Enter", " ", "d"];
      let at = 0;
      await across(
        s,
        async () => {
          await page.keyboard.press(keys[at++ % keys.length]);
          await page.waitForTimeout(30);
        },
        () => setRole(s, "viewer"),
      );
      await expectUnpressedThenPress(s, LOWERED("Viewer"), async (p) => {
        await p.keyboard.press("Enter");
      });
    });

    for (const key of ["Enter", " "] as const) {
      test(`a held ${key === " " ? "Space" : key}: its repeats and its release press nothing, and the page is not reloaded in a loop`, async ({ browser }) => {
        const s = await scene(browser);
        const { page } = s.person;
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.down(key);
        await across(
          s,
          async () => {
            // A key that is already down: the browser sends a repeat.
            await page.keyboard.down(key);
            await page.waitForTimeout(30);
          },
          () => setRole(s, "viewer"),
        );
        await page.keyboard.up(key);
        await expectUnpressedThenPress(s, LOWERED("Viewer"), async (p) => {
          await p.keyboard.press(key);
        });
        await waitForEditor(page);
        await expect(dialog(page)).toHaveCount(0);
      });
    }

    test("clicks that keep coming where the button appears (every 120 ms, as the rest of a double-click does)", async ({ browser }) => {
      const s = await scene(browser, { row: "editor" });
      const { page } = s.person;
      const editor = (await page.locator(".cm-content").boundingBox())!;
      const point = { x: editor.x + 60, y: editor.y + 30 };
      await across(
        s,
        async () => {
          await page.mouse.click(point.x, point.y);
          await page.waitForTimeout(120);
        },
        () => removeRow(s),
        {
          more: 8,
          onDialog: async () => {
            const box = (await action(page).boundingBox())!;
            point.x = box.x + box.width / 2;
            point.y = box.y + box.height / 2;
          },
        },
      );
      // Leaving for the documents is a navigation inside the app, not a load of the page.
      await expectUnpressedThenPress(s, REMOVED, (p) => action(p).click(), async (p) => new URL(p.url()).pathname === "/");
    });

    test("a drag that began in the editor and ends on the button", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      const editor = (await page.locator(".cm-content").boundingBox())!;
      await page.mouse.move(editor.x + 20, editor.y + 20);
      await page.mouse.down();
      await page.mouse.move(editor.x + 120, editor.y + 40, { steps: 4 });
      await setRole(s, "viewer");
      await expect(dialog(page)).toBeVisible();
      const box = (await action(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expectUnpressedThenPress(s, LOWERED("Viewer"), async (p) => {
        await action(p).click();
      });
    });
  });

  test.describe("other things that were open when the dialog arrived", () => {
    /** The dialog's button has focus and is the topmost thing where it is drawn; the rest of the page is inert. */
    async function expectOnTop(page: Page) {
      await expect(action(page)).toBeFocused();
      const top = await action(page).evaluate((button) => {
        const box = button.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === button;
      });
      expect(top, "the dialog's button is on top").toBe(true);
      const reachable = await dialog(page).evaluate((content) =>
        Array.from(document.body.children)
          .filter((element) => !element.contains(content) && !element.hasAttribute("data-access-changed-backdrop") && !element.hasAttribute("inert"))
          .filter((element) => (element as HTMLElement).getBoundingClientRect().width > 0)
          .map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}[${element.getAttribute("role") ?? ""}]`),
      );
      expect(reachable, "everything else on the page is inert").toEqual([]);
      // Tab has nowhere else to go.
      await page.keyboard.press("Tab");
      await expect(action(page)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(action(page)).toBeFocused();
    }

    test("the find bar with Replace: Replace all cannot be used any more", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+h");
      await page.getByTestId("find-input").fill("Start");
      await page.getByTestId("replace-input").fill(`REPL${s.tag}`);
      const replaceAll = (await page.getByTestId("replace-all").boundingBox())!;

      await setRole(s, "viewer");
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: false });
      await expectOnTop(page);
      await page.mouse.click(replaceAll.x + replaceAll.width / 2, replaceAll.y + replaceAll.height / 2);
      await page.keyboard.press("Enter");
      expect(await codeText(page)).not.toContain(`REPL${s.tag}`);
      await expect(page.getByTestId("find-replace-row")).toHaveCount(0);
      await ownerMarker(s);
      expect(await liveText(s.owner.page, s.id)).not.toContain(`REPL${s.tag}`);
    });

    test("the command palette: the dialog is on top and has the keyboard", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await page.keyboard.press("Control+Shift+p");
      await expect(page.getByTestId("palette-input")).toBeFocused();
      await page.keyboard.type("bold");

      await setRole(s, "viewer");
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: false });
      await expectOnTop(page);
      await page.keyboard.type("x");
      await expect(page.getByTestId("palette-input")).not.toBeFocused();
      await expect(page.getByTestId("palette-input")).toHaveValue("bold");
      await expectOnTop(page);
    });

    test("the header's menu: it stays drawn under the backdrop, and its items can no longer be used", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.getByTestId("more-menu").click();
      await expect(page.getByRole("menu")).toBeVisible();
      const item = (await page.getByRole("menuitem", { name: "All documents" }).boundingBox())!;

      await setRole(s, "viewer");
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: false });
      await expectOnTop(page);
      await page.mouse.click(item.x + item.width / 2, item.y + item.height / 2);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await expect(action(page)).toBeFocused();
      expect(await sameLoad(page)).toBe(true);
      expect(new URL(page.url()).pathname).toBe(`/d/${s.id}`);
      // Out of reach for assistive technology too.
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    test("the page's own shortcuts open nothing over the dialog", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.locator(".cm-content").click();
      await setRole(s, "viewer");
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: false });
      for (const chord of ["Control+Shift+p", "Control+k", "Control+/", "Control+f", "Control+h", "Control+Alt+m", "Control+s"]) await page.keyboard.press(chord);
      await expectOnTop(page);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      for (const id of ["palette-input", "find-bar", "comment-composer", "toast"]) await expect(page.getByTestId(id), id).toHaveCount(0);
      expect(await sameLoad(page)).toBe(true);
    });

    test("the Share dialog: the access dialog is on top of it", async ({ browser }) => {
      const s = await scene(browser);
      const { page } = s.person;
      await page.getByTestId("share-button").click();
      await expect(page.getByRole("dialog")).toBeVisible();
      const close = (await page.getByRole("dialog").getByRole("button", { name: "Close" }).boundingBox())!;

      await setRole(s, "viewer");
      await expectBlocked(page, LOWERED("Viewer"), { unsaved: false });
      await expectOnTop(page);
      // The Share dialog is still drawn under the backdrop; a press where its Close button is does nothing to it.
      await page.mouse.click(close.x + close.width / 2, close.y + close.height / 2);
      await expect(page.locator('[role="dialog"]')).toHaveCount(2);
      await expect(action(page)).toBeFocused();
    });
  });
});
