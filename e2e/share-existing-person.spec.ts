import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, uniqueLogin, focusCodeEnd, codeText } from "./helpers";

/**
 * Share dialog · adding someone who already has access (issue #2252). All input is real (keyboard and mouse).
 * The rule itself lives on the server (src/app/api/documents/collaborators.test.ts covers every row of it);
 * here an owner meets it in the dialog: the person keeps their role, the reason is shown under the field, and
 * the role select in the list is still the way to change a role.
 */
type Role = "editor" | "commenter" | "viewer";
type Sent = { body: { login: string; role: Role; change?: unknown }; status: number | null };

const collaborators = (id: string) => `/api/documents/${id}/collaborators`;
/** A 1 px image for made-up accounts, so no avatar is fetched from anywhere. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

async function openShare(page: Page) {
  await page.getByTestId("share-button").click();
  const dialog = page.getByRole("dialog", { name: /share/i });
  await expect(dialog).toBeVisible();
  const input = page.getByTestId("share-login");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("collaborator-list-loading")).toHaveCount(0);
  return { dialog, input, add: page.getByTestId("share-add"), problem: page.getByTestId("share-add-error") };
}

/** Every POST the page sends to the collaborators route: its body as sent, and the status once it is answered. */
function watchAdds(page: Page, id: string) {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith(collaborators(id))) return;
    const entry: Sent = { body: request.postDataJSON() as Sent["body"], status: null };
    sent.push(entry);
    void request
      .response()
      .then((response) => {
        entry.status = response?.status() ?? null;
      })
      .catch(() => {}); // the page closed first: the status stays null and "answered" says so
  });
  return {
    sent,
    /** Resolves once `count` requests have been sent and every one of them has an answer. */
    answered: (count: number) =>
      expect.poll(() => (sent.length === count && sent.every((entry) => entry.status !== null) ? count : `${sent.length} sent, ${sent.filter((e) => e.status !== null).length} answered`)).toBe(count),
  };
}

/** Holds every add or role change the page sends until `release()`, so "while it runs" can be looked at. */
async function holdAdds(page: Page, id: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${collaborators(id)}`, async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  return { release };
}

const roleOf = async (page: Page, id: string, login: string) => {
  const body = (await (await page.request.get(collaborators(id))).json()) as { collaborators: { login: string; role: Role }[] };
  return body.collaborators.find((c) => c.login === login)?.role ?? null;
};
const shareAdds = async (page: Page, id: string) => {
  const body = (await (await page.request.get(`/api/documents/${id}/activity?limit=200`)).json()) as { items: { action: string }[] };
  return body.items.filter((item) => item.action === "share.add").length;
};
/** The dialog is idle again: no add is running. Requests a press would have started are already counted by then. */
const idle = (add: Locator) => expect(add).not.toHaveAttribute("aria-busy", "true");
/** Where keyboard focus is: a test id, an accessible label, "dialog", or "body" when it was lost. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? (el.getAttribute("role") === "dialog" ? "dialog" : el.tagName.toLowerCase());
  });
/** Presses Tab until `target` has focus (at most `max` times): the way a keyboard user reaches a control. */
async function tabTo(page: Page, target: Locator, max = 8) {
  for (let presses = 0; presses < max; presses += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}
const refusedText = (login: string, role: string) => `@${login} already has access as ${role}. Change the role in the list below.`;

test.describe("share dialog · adding someone who already has access", () => {
  for (const by of ["Enter", "a click on Add"] as const) {
    test(`a Viewer re-added with the role at Editor stays a Viewer (${by}); the list's role select still changes the role with one request`, async ({ browser }) => {
      const owner = await signIn(browser, uniqueLogin("sx-owner"));
      const { page } = owner;
      const viewer = uniqueLogin("sx-viewer");
      const id = await createDocument(page, "# Existing person\n\nShare me.\n", "Existing person");
      expect((await page.request.post(collaborators(id), { data: { login: viewer, role: "viewer" } })).status()).toBe(202);
      // GitHub suggests eight other accounts that start with whatever is typed, so a list is open right
      // where the dialog puts its answer when the handle is submitted.
      await page.route(/\/api\/github\/users(\?|$)/, async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q") ?? "";
        const users = Array.from({ length: 8 }, (_, i) => ({ login: `${q}${i}`, name: null, avatarUrl: PIXEL }));
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users, limited: false }) });
      });
      await openDocument(page, id);
      const { input, add, problem } = await openShare(page);
      const adds = watchAdds(page, id);
      const row = page.getByLabel(`Role for ${viewer}`);
      await expect(row).toHaveValue("viewer");
      await expect(page.getByTestId("share-role")).toHaveValue("editor"); // the default that made this a silent promotion

      await page.keyboard.type(viewer);
      await expect(page.getByTestId("share-login-option")).toHaveCount(8);
      if (by === "Enter") {
        await page.keyboard.press("Enter");
      } else {
        const box = (await add.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }

      // One request, an add (no change flag), refused; the reason is under the field in the approved words.
      await adds.answered(1);
      expect(adds.sent).toEqual([{ body: { login: viewer, role: "editor" }, status: 409 }]);
      await expect(problem).toHaveText(refusedText(viewer, "Viewer"));
      await expect(problem).toHaveAttribute("role", "alert");
      // The suggestions are out of its way: the message is what is at its own place on screen.
      await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
      expect(await problem.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top !== null && el.contains(top);
      }), "the message is not covered by anything").toBe(true);
      await expect(page.getByTestId("toast")).toHaveCount(0);

      // Nothing changed, the typed handle is still there, and focus did not go anywhere.
      await expect(input).toHaveValue(viewer);
      await idle(add);
      expect(await focusOf(page)).toBe(by === "Enter" ? "share-login" : "share-add");
      await expect(add).toBeEnabled();
      await expect(row).toHaveValue("viewer");
      expect(await roleOf(page, id, viewer)).toBe("viewer");
      expect(await shareAdds(page, id)).toBe(1);

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["color-contrast"]).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

      // The way the message points to: the person's own role select, reached and used with the keyboard.
      await tabTo(page, row);
      await page.keyboard.press("e"); // type-ahead on a closed select picks "Editor"
      await adds.answered(2);
      expect(adds.sent[1]).toEqual({ body: { login: viewer, role: "editor", change: true }, status: 202 });
      await expect(row).toHaveValue("editor");
      await expect(row).toBeFocused();
      await expect(row).not.toHaveAttribute("aria-disabled", "true");
      expect(await roleOf(page, id, viewer)).toBe("editor");
      expect(await shareAdds(page, id)).toBe(2);
      // The sentence follows the row it points to.
      await expect(problem).toHaveText(refusedText(viewer, "Editor"));
      expect(adds.sent).toHaveLength(2);
    });
  }

  test("`@` plus 39 characters is addable; `@` plus 40 keeps Add disabled, and the server refuses it like 40 characters", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-at-owner"));
    const { page } = owner;
    const id = await createDocument(page, "# At sign\n", "At sign");
    await openDocument(page, id);
    const { input, add, problem } = await openShare(page);
    const adds = watchAdds(page, id);
    const thirtyNine = `${"a".repeat(30)}${Date.now().toString(36)}`.padEnd(39, "z").slice(0, 39);

    await page.keyboard.type(`@${thirtyNine}`);
    await expect(input).toHaveValue(`@${thirtyNine}`);
    await expect(add).toBeEnabled();
    await page.keyboard.press("Enter");
    await adds.answered(1);
    expect(adds.sent).toEqual([{ body: { login: `@${thirtyNine}`, role: "editor" }, status: 202 }]);
    await expect(page.getByTestId("collaborator-row").filter({ hasText: `@${thirtyNine}` })).toHaveCount(1);
    await expect(problem).toHaveCount(0);
    await expect(input).toHaveValue("");
    expect(await roleOf(page, id, thirtyNine)).toBe("editor");

    await page.keyboard.type(`@${"b".repeat(40)}`);
    await expect(add).toBeDisabled();
    await page.keyboard.press("Enter");
    await idle(add);
    expect(adds.sent).toHaveLength(1);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);

    // The server agrees with the button, with one message for both spellings.
    const messages: string[][] = [];
    for (const login of ["b".repeat(40), `@${"b".repeat(40)}`]) {
      const res = await page.request.post(collaborators(id), { data: { login, role: "viewer" } });
      expect(res.status()).toBe(400);
      messages.push(((await res.json()) as { issues: { message: string }[] }).issues.map((issue) => issue.message));
    }
    expect(messages[1]).toEqual(messages[0]);
  });

  test("one press is one request: a held Enter, Enter then a click on Add, and presses after a refusal change nothing", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-press-owner"));
    const { page } = owner;
    const viewer = uniqueLogin("sx-press-viewer");
    const id = await createDocument(page, "# One press\n", "One press");
    expect((await page.request.post(collaborators(id), { data: { login: viewer, role: "viewer" } })).status()).toBe(202);
    await openDocument(page, id);
    const { input, add, problem } = await openShare(page);
    const adds = watchAdds(page, id);
    await page.keyboard.type(viewer);

    // Enter held down: the first keydown submits; the browser's repeats (a keydown with repeat set) do not,
    // although each refusal leaves the handle in place and the form free again.
    await page.keyboard.down("Enter");
    await adds.answered(1);
    await expect(problem).toHaveText(refusedText(viewer, "Viewer"));
    await idle(add);
    for (let repeat = 0; repeat < 12; repeat += 1) await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await idle(add);
    expect(adds.sent, "POSTs after Enter was held through 12 repeats").toHaveLength(1);

    // Enter, then a click on Add while that request is still running: the click starts nothing.
    const held = await holdAdds(page, id);
    await page.keyboard.press("Enter");
    await expect(add).toHaveAttribute("aria-busy", "true");
    const box = (await add.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    expect(adds.sent, "POSTs while the second add was held").toHaveLength(2);
    held.release();
    await adds.answered(2);
    await idle(add);

    // Each later press is its own request, and each is refused the same way.
    await input.click();
    await page.keyboard.press("Enter");
    await adds.answered(3);
    expect(adds.sent.map((entry) => [entry.body, entry.status])).toEqual(Array.from({ length: 3 }, () => [{ login: viewer, role: "editor" }, 409]));
    await expect(problem).toHaveText(refusedText(viewer, "Viewer"));
    await expect(input).toHaveValue(viewer);
    expect(await roleOf(page, id, viewer)).toBe("viewer");
    expect(await shareAdds(page, id)).toBe(1);
  });

  test("a fast double click on Add for a new person sends one request, and focus ends in the field", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-dbl-owner"));
    const { page } = owner;
    const person = uniqueLogin("sx-dbl-new");
    const id = await createDocument(page, "# Double click\n", "Double click");
    await openDocument(page, id);
    const { input, add } = await openShare(page);
    const adds = watchAdds(page, id);
    const held = await holdAdds(page, id);

    await page.keyboard.type(person);
    const box = (await add.boundingBox())!;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

    // While the add runs: one request, and Add still holds the focus the click gave it.
    await expect(add).toHaveAttribute("aria-busy", "true");
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    expect(adds.sent).toHaveLength(1);
    held.release();

    await adds.answered(1);
    await expect(page.getByTestId("collaborator-row").filter({ hasText: `@${person}` })).toHaveCount(1);
    await expect(input).toHaveValue("");
    // Add is disabled again (the field is empty); the focus it held went to the field, not to the page.
    await expect(add).toBeDisabled();
    await expect(input).toBeFocused();
    expect(adds.sent).toEqual([{ body: { login: person, role: "editor" }, status: 202 }]);
  });

  test("the request carries the role the select showed, and the handle that was picked, when keys arrive in one roll", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-roll-owner"));
    const { page } = owner;
    const person = uniqueLogin("sx-roll-new");
    const id = await createDocument(page, "# One roll\n", "One roll");
    expect((await page.request.get("/api/github/users?q=octoc", { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, add } = await openShare(page);
    const adds = watchAdds(page, id);

    // Type a handle, go to the role select, pick Viewer, come back and press Enter: one key after the other
    // with nothing awaited in between but the key itself (no wait for the select, the focus or a render).
    await page.keyboard.type(person);
    for (const key of ["Tab", "v", "Shift+Tab", "Enter"]) await page.keyboard.press(key);
    await adds.answered(1);
    expect(adds.sent).toEqual([{ body: { login: person, role: "viewer" }, status: 202 }]);
    await expect(page.getByLabel(`Role for ${person}`)).toHaveValue("viewer");
    await expect(input).toHaveValue("");

    // Pick a suggestion and press Enter at once: the pick moves focus to the role select, where Enter adds
    // nobody. Nothing is ever sent for the letters that were typed.
    await expect(input).toBeFocused();
    await page.keyboard.type("octoc");
    await expect(page.getByTestId("share-login-option")).toHaveCount(1);
    for (const key of ["ArrowDown", "Enter", "Enter"]) await page.keyboard.press(key);
    await expect(input).toHaveValue("octocat");
    await expect(page.getByTestId("share-role")).toBeFocused();
    await idle(add);
    expect(adds.sent).toHaveLength(1);
    await tabTo(page, add);
    await page.keyboard.press("Enter");
    await adds.answered(2);
    expect(adds.sent[1]).toEqual({ body: { login: "octocat", role: "viewer" }, status: 202 });
  });

  test("removed in another tab after the refusal: the next try adds them; a reopened dialog shows no old message", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-tab-owner"));
    const { page } = owner;
    const viewer = uniqueLogin("sx-tab-viewer");
    const id = await createDocument(page, "# Other tab\n", "Other tab");
    expect((await page.request.post(collaborators(id), { data: { login: viewer, role: "viewer" } })).status()).toBe(202);
    await openDocument(page, id);
    const { input, problem } = await openShare(page);
    const adds = watchAdds(page, id);

    await page.keyboard.type(viewer);
    await page.keyboard.press("Enter");
    await expect(problem).toHaveText(refusedText(viewer, "Viewer"));

    // The same owner, somewhere else, removes the person. This dialog does not know.
    expect((await page.request.delete(collaborators(id), { data: { login: viewer } })).status()).toBe(200);
    await page.keyboard.press("Enter");
    await adds.answered(2);
    expect(adds.sent.map((entry) => entry.status)).toEqual([409, 202]);
    expect(adds.sent[1].body).toEqual({ login: viewer, role: "editor" });
    await expect(problem).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page.getByLabel(`Role for ${viewer}`)).toHaveValue("editor");
    expect(await roleOf(page, id, viewer)).toBe("editor");

    // Refused again (now an Editor, the select at Viewer), then the dialog is closed and opened again.
    await page.getByTestId("share-role").selectOption("viewer");
    await input.click();
    await page.keyboard.type(viewer);
    await page.keyboard.press("Enter");
    await expect(problem).toHaveText(refusedText(viewer, "Editor"));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /share/i })).toHaveCount(0);
    const reopened = await openShare(page);
    await expect(reopened.problem).toHaveCount(0);
    await expect(page.getByLabel(`Role for ${viewer}`)).toHaveValue("editor");
    expect(await roleOf(page, id, viewer)).toBe("editor");
  });

  test("focus is never lost: a role change and Remove in the list keep it inside the dialog (keyboard)", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-focus-owner"));
    const { page } = owner;
    const id = await createDocument(page, "# Focus\n", "Focus");
    for (const login of ["sx-focus-one", "sx-focus-two"]) {
      expect((await page.request.post(collaborators(id), { data: { login, role: "viewer" } })).status()).toBeLessThan(300);
    }
    await openDocument(page, id);
    const { dialog } = await openShare(page);
    const adds = watchAdds(page, id);
    const held = await holdAdds(page, id);
    const select = page.getByLabel("Role for sx-focus-two");

    await tabTo(page, select, 12);
    await page.keyboard.press("c");
    // While the change runs the select is marked busy, not disabled, and keeps the focus.
    await expect(select).toHaveAttribute("aria-disabled", "true");
    await expect(select).toBeFocused();
    held.release();
    await adds.answered(1);
    expect(adds.sent).toEqual([{ body: { login: "sx-focus-two", role: "commenter", change: true }, status: 202 }]);
    await expect(select).toHaveValue("commenter");
    await expect(select).not.toHaveAttribute("aria-disabled", "true");
    await expect(select).toBeFocused();

    const remove = page.getByLabel("Remove sx-focus-two");
    await tabTo(page, remove, 2);
    const removed = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(collaborators(id)));
    await page.keyboard.press("Enter");
    expect((await removed).status()).toBe(200);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    // The button is gone with its row: focus is still inside the dialog, never on the page behind it.
    expect(await focusOf(page)).not.toBe("body");
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  });

  test("an Editor re-added as a Viewer by mistake stays an Editor and keeps typing into the open document", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("sx-live-owner"));
    const editor = await signIn(browser, uniqueLogin("sx-live-editor"));
    const id = await createDocument(owner.page, "# Live\n\nStart.\n", "Live");
    expect((await owner.page.request.post(collaborators(id), { data: { login: editor.login, role: "editor" } })).status()).toBe(200);
    await openDocument(editor.page, id);
    await openDocument(owner.page, id);
    const { problem } = await openShare(owner.page);
    const adds = watchAdds(owner.page, id);

    await owner.page.getByTestId("share-role").selectOption("viewer");
    await owner.page.getByTestId("share-login").click();
    await owner.page.keyboard.type(editor.login);
    await owner.page.keyboard.press("Enter");
    await adds.answered(1);
    expect(adds.sent).toEqual([{ body: { login: editor.login, role: "viewer" }, status: 409 }]);
    await expect(problem).toHaveText(refusedText(editor.login, "Editor"));
    expect(await roleOf(owner.page, id, editor.login)).toBe("editor");

    // The editor's open session was not touched: what they type now still reaches the owner.
    await focusCodeEnd(editor.page);
    await editor.page.keyboard.type("Still an editor.");
    await expect.poll(() => codeText(owner.page)).toContain("Still an editor.");
    await expect.poll(() => codeText(editor.page)).toContain("Still an editor.");
  });
});
