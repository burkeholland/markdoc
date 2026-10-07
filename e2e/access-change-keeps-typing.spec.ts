import { test, expect } from "./fixtures";
import type { Browser, Page } from "@playwright/test";
import { codeText, createDocument, openDocument, signIn, uniqueLogin, type User } from "./helpers";

/**
 * Issue #2281: an owner changes someone's access while that person is typing.
 *
 * The server pauses the person's live connection while the database change runs. A person who may still edit
 * afterwards must lose nothing and keep saving with no reload; a person whose edit access really ends must
 * get nothing accepted after the change. The in-process test database answers so fast that the pause has no
 * width, so the e2e server runs every access change with `COLLAB_ACCESS_CHANGE_TEST_DELAY_MS` (40 ms, set in
 * playwright.config.ts), about what a database on another machine costs. Against an already running server
 * (PROD_BASE_URL) the value comes from the environment and may be 0, for a run on a real PostgreSQL.
 *
 * The person types with real keys in a second browser; the owner acts through the API, as the Share dialog does.
 */
const DELAY_MS = Number(process.env.COLLAB_ACCESS_CHANGE_TEST_DELAY_MS ?? (process.env.PROD_BASE_URL ? 0 : 40));
const BURST = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4).slice(0, 120);

interface Change {
  /** Just before the request left, and just after its answer arrived. */
  sent: number;
  answered: number;
  status: number;
}

/** Type `text` key by key and remember when each key was sent. */
async function typeKeys(page: Page, text: string, stamps: number[]) {
  for (const key of text) {
    stamps.push(Date.now());
    await page.keyboard.type(key);
  }
}

/** The person types `text` at the end of the document; once a quarter of it is typed, `change` runs alongside. */
async function typeThrough(person: Page, text: string, change: () => Promise<number>) {
  const stamps: number[] = [];
  await person.locator(".cm-content").click();
  await person.keyboard.press("Control+End");
  await person.keyboard.press("Enter");
  const typing = typeKeys(person, text, stamps);
  await expect.poll(() => stamps.length, { intervals: [5] }).toBeGreaterThanOrEqual(Math.floor(text.length / 4));
  const sent = Date.now();
  const status = await change();
  const answered = Date.now();
  await typing;
  const result: Change = { sent, answered, status };
  expect(status, "the access change").toBe(200);
  // The pause had real width, and keys were sent while the change ran: otherwise this proves nothing.
  expect(answered - sent, "the access change took at least the configured delay").toBeGreaterThanOrEqual(DELAY_MS);
  const during = stamps.filter((at) => at >= sent && at <= answered).length;
  expect(during, "keys sent while the access change ran").toBeGreaterThanOrEqual(DELAY_MS >= 40 ? 2 : 1);
  expect(stamps.at(-1)!, "the person was still typing when the change had ended").toBeGreaterThan(answered);
  return { stamps, change: result };
}

/** How many leading characters of `typed` are in `text`. */
function prefixIn(text: string, typed: string): number {
  for (let n = typed.length; n > 0; n -= 1) if (text.includes(typed.slice(0, n))) return n;
  return 0;
}

const collaborators = (id: string) => `/api/documents/${id}/collaborators`;
const liveText = async (owner: Page, id: string) => ((await (await owner.request.get(`/api/documents/${id}/content`)).json()) as { content: string }).content;
const saved = (page: Page) => expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

interface Scene {
  owner: User;
  person: User;
  id: string;
  /** A marker of its own per test, so a text can never be found by accident. */
  tag: string;
}

async function scene(browser: Browser, { link, row }: { link: "edit" | "private"; row: "editor" | null }): Promise<Scene> {
  const tag = Date.now().toString(36).toUpperCase();
  const owner = await signIn(browser, uniqueLogin("pause-owner"));
  const person = await signIn(browser, uniqueLogin("pause-person"));
  const id = await createDocument(owner.page, "# Access change\n\nStart.\n");
  if (link === "edit") expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "edit" } })).ok()).toBeTruthy();
  if (row) expect((await owner.page.request.post(collaborators(id), { data: { login: person.login, role: row } })).ok()).toBeTruthy();
  await openDocument(owner.page, id);
  await openDocument(person.page, id);
  return { owner, person, id, tag };
}

/** The owner types a marker; once it is saved and on the person's page, the server has handled everything sent before it. */
async function ownerMarker({ owner, person, id, tag }: Scene): Promise<string> {
  const marker = `OWNER${tag}`;
  await owner.page.locator(".cm-content").click();
  await owner.page.keyboard.press("Control+Home");
  await owner.page.keyboard.press("End");
  await owner.page.keyboard.type(` ${marker}`);
  await expect.poll(() => liveText(owner.page, id)).toContain(marker);
  await expect.poll(() => codeText(person.page)).toContain(marker);
  await saved(owner.page);
  return marker;
}

test.describe("an access change while the person types (#2281)", () => {
  test("their row is removed while the link gives edit: every key is in the owner's document and the stored one, and the page keeps saving with no reload", async ({ browser }) => {
    const s = await scene(browser, { link: "edit", row: "editor" });
    const burst = `${s.tag}${BURST}`;
    await typeThrough(s.person.page, burst, async () => (await s.owner.page.request.delete(collaborators(s.id), { data: { login: s.person.login } })).status());

    // Typed before, during and after the pause: all of it, on every side, with no reload.
    await expect.poll(() => liveText(s.owner.page, s.id)).toContain(burst);
    await expect.poll(() => codeText(s.owner.page)).toContain(burst);
    expect(await codeText(s.person.page)).toContain(burst);
    await saved(s.person.page);

    // And saving goes on.
    const later = `later${s.tag}typedafterwards`;
    await s.person.page.keyboard.press("Enter");
    await s.person.page.keyboard.type(later);
    await expect.poll(() => codeText(s.owner.page)).toContain(later);
    await saved(s.person.page);
    await saved(s.owner.page);

    // The stored document, as a browser that never had this document gets it.
    const fresh = await signIn(browser, s.owner.login);
    await openDocument(fresh.page, s.id);
    const stored = await codeText(fresh.page);
    expect(stored).toContain(burst);
    expect(stored).toContain(later);
    expect(stored).toBe(await codeText(s.person.page));
  });

  test("typing through the pause and closing the tab at once: a browser that never had the document shows all of it", async ({ browser }) => {
    const s = await scene(browser, { link: "edit", row: "editor" });
    const burst = `${s.tag}${BURST}`;
    await typeThrough(s.person.page, burst, async () => (await s.owner.page.request.delete(collaborators(s.id), { data: { login: s.person.login } })).status());
    // No wait for "Saved", no look at the server: the tab is gone the moment the last key is typed.
    await s.person.page.close();

    await expect.poll(() => liveText(s.owner.page, s.id)).toContain(burst);
    await expect.poll(() => codeText(s.owner.page)).toContain(burst);
    await saved(s.owner.page);
    const fresh = await signIn(browser, s.person.login);
    await openDocument(fresh.page, s.id);
    expect(await codeText(fresh.page)).toContain(burst);
  });

  for (const control of [
    { name: "lowered to Viewer while the link gives edit (the collaborator row wins over the link)", link: "edit", lower: true },
    { name: "removed while the link is private", link: "private", lower: false },
  ] as const) {
    test(`${control.name}: nothing typed after the change is accepted, what was typed before it is kept`, async ({ browser }) => {
      const s = await scene(browser, { link: control.link, row: "editor" });
      const burst = `${s.tag}${BURST}`;
      const { stamps, change } = await typeThrough(s.person.page, burst, async () =>
        control.lower
          ? (await s.owner.page.request.post(collaborators(s.id), { data: { login: s.person.login, role: "viewer", change: true } })).status()
          : (await s.owner.page.request.delete(collaborators(s.id), { data: { login: s.person.login } })).status(),
      );
      const later = `later${s.tag}typedafterwards`;
      await s.person.page.keyboard.press("Enter");
      await s.person.page.keyboard.type(later);

      // The owner's marker is saved after everything the person sent: the document is settled now.
      await expect.poll(() => liveText(s.owner.page, s.id)).toContain(s.tag);
      const marker = `OWNER${s.tag}`;
      await s.owner.page.locator(".cm-content").click();
      await s.owner.page.keyboard.press("Control+Home");
      await s.owner.page.keyboard.press("End");
      await s.owner.page.keyboard.type(` ${marker}`);
      await expect.poll(() => liveText(s.owner.page, s.id)).toContain(marker);
      await saved(s.owner.page);

      const text = await liveText(s.owner.page, s.id);
      const accepted = prefixIn(text, burst);
      // Kept: every key that was sent a quarter of a second or more before the change began.
      const longBefore = stamps.filter((at) => at < change.sent - 250).length;
      expect(longBefore).toBeGreaterThan(0);
      expect(accepted, "keys typed well before the change are kept").toBeGreaterThanOrEqual(longBefore);
      // Not accepted: any key sent after the change was answered, and nothing typed later.
      const sentAfter = stamps.findIndex((at) => at > change.answered);
      expect(sentAfter).toBeGreaterThan(0);
      expect(accepted, "no key sent after the change was answered is in the document").toBeLessThanOrEqual(sentAfter);
      expect(text).not.toContain(later);
      expect(await codeText(s.owner.page)).not.toContain(later);
      expect(prefixIn(await codeText(s.owner.page), burst)).toBe(accepted);

      // The stored document says the same to a browser that never had it.
      const fresh = await signIn(browser, s.owner.login);
      await openDocument(fresh.page, s.id);
      const stored = await codeText(fresh.page);
      expect(prefixIn(stored, burst)).toBe(accepted);
      expect(stored).not.toContain(later);
      expect(stored).toContain(marker);
    });
  }

  test("lowered to Viewer while typing and given edit back: nothing is accepted meanwhile, then the keys their page had taken arrive, and after a reload their page ends at Saved", async ({ browser }) => {
    const s = await scene(browser, { link: "edit", row: null });
    const burst = `${s.tag}${BURST}`;
    // A plain add as Viewer: the row wins over the link, so the person is a real Viewer now.
    const { stamps, change } = await typeThrough(s.person.page, burst, async () =>
      (await s.owner.page.request.post(collaborators(s.id), { data: { login: s.person.login, role: "viewer" } })).status(),
    );

    // The page is told that it was lowered and takes no more keys (#2269). What it took before that is in
    // its own copy; the keys that waited on the server while the change ran were refused.
    await expect(s.person.page.getByTestId("access-changed-dialog")).toBeVisible();
    const taken = prefixIn(await codeText(s.person.page), burst);
    const marker = await ownerMarker(s);
    const accepted = prefixIn(await liveText(s.owner.page, s.id), burst);
    expect(prefixIn(await codeText(s.owner.page), burst)).toBe(accepted);
    expect(accepted, "no key sent after the change was answered is in the document").toBeLessThanOrEqual(stamps.findIndex((at) => at > change.answered));
    expect(taken - accepted, "keys the page had taken that the server refused while the person was a Viewer").toBeGreaterThan(0);

    // Edit comes back (the row is removed, the link gives edit): the refused keys arrive with no reload.
    expect((await s.owner.page.request.delete(collaborators(s.id), { data: { login: s.person.login } })).status()).toBe(200);
    await expect.poll(async () => prefixIn(await liveText(s.owner.page, s.id), burst)).toBe(taken);
    await expect.poll(async () => prefixIn(await codeText(s.owner.page), burst)).toBe(taken);
    await saved(s.person.page);

    // The page stays blocked until it is loaded again. Then the person edits, and saving goes on.
    const reload = s.person.page.getByTestId("access-changed-action");
    await expect(reload).toHaveAttribute("data-armed", "true");
    await Promise.all([s.person.page.waitForEvent("load"), reload.click()]);
    await expect(s.person.page.getByTestId("access-changed-dialog")).toHaveCount(0);
    await saved(s.person.page);
    const after = `after${s.tag}editisback`;
    await s.person.page.locator(".cm-content").click();
    await s.person.page.keyboard.press("Control+End");
    await s.person.page.keyboard.press("Enter");
    await s.person.page.keyboard.type(after);
    await expect.poll(() => codeText(s.owner.page)).toContain(after);
    await saved(s.person.page);
    await saved(s.owner.page);
    expect(await codeText(s.owner.page)).toBe(await codeText(s.person.page));

    const fresh = await signIn(browser, s.owner.login);
    await openDocument(fresh.page, s.id);
    const stored = await codeText(fresh.page);
    expect(stored).toBe(await codeText(s.person.page));
    for (const part of [burst.slice(0, taken), after, marker]) expect(stored).toContain(part);
  });
});
