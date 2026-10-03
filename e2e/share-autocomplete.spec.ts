import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, budgetMs, mintToken, devLogin } from "./helpers";

/**
 * Share dialog · GitHub handle autocomplete (task #920). GitHub is the in-memory fake (GITHUB_MOCK=1),
 * whose user search knows `octocat`, `octodog`, … `monalisa`, `hubot`, so the suite runs offline.
 * `GET /api/github/users` itself is covered by src/app/api/github/users/route.test.ts; here we check
 * the route from a browser session and the combobox as the owner uses it.
 */
const USERS = "/api/github/users";

async function openShare(page: Page) {
  // Below the `md` breakpoint the header hides the direct Share button (header.tsx: `max-md:hidden`)
  // and folds it into the overflow menu instead (see e2e/phone-overlays.spec.ts).
  const button = page.getByTestId("share-button");
  if (await button.isVisible()) {
    await button.click();
  } else {
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-share").click();
  }
  const dialog = page.getByRole("dialog", { name: /share/i });
  await expect(dialog).toBeVisible();
  const input = page.getByTestId("share-login");
  await expect(input).toBeFocused();
  return { dialog, input, list: page.getByTestId("share-login-suggestions"), options: page.getByTestId("share-login-option") };
}

/** Requests the page made to `path` (optionally only with `method`) since the counter was armed, as their query strings. */
function countRequests(page: Page, path: string, method = "GET") {
  const seen: string[] = [];
  const onRequest = (r: { url(): string; method(): string }) => {
    if (r.method() === method && r.url().includes(path)) seen.push(new URL(r.url()).search);
  };
  page.on("request", onRequest);
  return { seen, stop: () => page.off("request", onRequest) };
}

/** POST bodies sent to `/api/documents/:id/collaborators` since the counter was armed — the `login` a request
 * actually carries (an add or a role change reusing the same route), not just that one happened. */
function countCollaboratorPosts(page: Page, documentId: string) {
  const seen: { login: string; role: string }[] = [];
  const path = `/api/documents/${documentId}/collaborators`;
  const onRequest = (r: { url(): string; method(): string; postDataJSON(): unknown }) => {
    if (r.method() === "POST" && r.url().includes(path)) {
      const body = r.postDataJSON() as { login: string; role: string };
      seen.push({ login: body.login, role: body.role });
    }
  };
  page.on("request", onRequest);
  return { seen, stop: () => page.off("request", onRequest) };
}

/** The suggestion option, if any, whose vertical center falls inside `target`'s box — i.e. the option a floating list sits on top of. */
async function findOptionOverlapping(options: Locator, target: Locator) {
  const targetBox = (await target.boundingBox())!;
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const option = options.nth(i);
    const box = (await option.boundingBox())!;
    const mid = box.y + box.height / 2;
    if (mid >= targetBox.y && mid <= targetBox.y + targetBox.height) return { option, box, index: i };
  }
  return null;
}

test.describe("share dialog · GitHub handle autocomplete", () => {
  test("GET /api/github/users: ≤ 8 users for a prefix within budget; 400 for one character or a non-login; 401 anonymous; 403 for a token", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-api-owner");
    const { page } = owner;
    // Next dev compiles the route on its first request: take that hit before timing anything.
    expect((await page.request.get(`${USERS}?q=oc`, { timeout: 120_000 })).status()).toBe(200);

    const t0 = Date.now();
    const res = await page.request.get(`${USERS}?q=oc`);
    const elapsed = Date.now() - t0;
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, max-age=60");
    const body = (await res.json()) as { users: { login: string; name: string | null; avatarUrl: string }[]; limited: boolean };
    expect(body.limited).toBe(false);
    expect(body.users.length).toBeGreaterThan(0);
    expect(body.users.length).toBeLessThanOrEqual(8);
    expect(body.users.map((u) => u.login)).toContain("octocat");
    for (const u of body.users) expect(u.login.toLowerCase().startsWith("oc")).toBe(true);
    console.log(`[autocomplete] GET ${USERS}?q=oc → ${body.users.length} users in ${elapsed} ms`);
    expect(elapsed).toBeLessThanOrEqual(budgetMs(1500));

    expect((await page.request.get(`${USERS}?q=a`)).status()).toBe(400);
    expect((await page.request.get(`${USERS}?q=bad!`)).status()).toBe(400);
    expect((await page.request.get(USERS)).status()).toBe(400);

    const anon = await browser.newContext();
    expect((await anon.request.get(`${USERS}?q=oc`)).status()).toBe(401);
    await anon.close();

    // A full-access API token is still not a browser session: 403, and the message says so.
    const minted = await mintToken(page, "autocomplete probe", { scope: "full" });
    const asToken = await page.request.get(`${USERS}?q=oc`, { headers: { Authorization: ["Bearer", minted.token].join(" ") } });
    expect(asToken.status()).toBe(403);
    expect(((await asToken.json()) as { error: string }).error).toContain("browser session");
    await minted.revoke();
    await owner.context.close();
  });

  test("typing shows up to 8 accounts after one debounced request; ↓ + Enter fills the box without adding; Add still adds", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Autocomplete\n\nShare me.\n", "Autocomplete");
    // Warm the route so the first timed keystrokes do not pay Turbopack's compile.
    expect((await page.request.get(`${USERS}?q=oc`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { dialog, input, list, options } = await openShare(page);

    await expect(input).toHaveAttribute("role", "combobox");
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(list).toHaveCount(0);

    // A 4-keystroke burst at 50 ms is one settled query: at most 2 requests, the list within 600 ms.
    const burst = countRequests(page, USERS);
    await page.keyboard.type("octo", { delay: 50 });
    const typedAt = Date.now();
    await expect(list).toBeVisible({ timeout: budgetMs(600) });
    const shownAfter = Date.now() - typedAt;
    await expect(options.first()).toBeVisible();
    const shown = await options.count();
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThanOrEqual(8);
    await expect(list).toHaveAttribute("role", "listbox");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    expect(await input.getAttribute("aria-controls")).toBe(await list.getAttribute("id"));
    for (const option of await options.all()) {
      await expect(option).toHaveAttribute("role", "option");
      await expect(option).toHaveAttribute("aria-selected", "false");
      const login = await option.getAttribute("data-login");
      expect(login?.startsWith("octo")).toBe(true);
      await expect(option).toContainText(`@${login}`);
      // 20 px avatar in front of the handle.
      const avatar = option.locator(".avatar");
      await expect(avatar).toBeVisible();
      expect((await avatar.boundingBox())?.width).toBeCloseTo(20, 0);
    }
    // At most one request per settled query, none below two characters ("o").
    expect(burst.seen.length, `requests for "octo": ${burst.seen.join(" ")}`).toBeLessThanOrEqual(2);
    expect(burst.seen.every((q) => q.startsWith("?q=oc"))).toBe(true);
    burst.stop();
    console.log(`[autocomplete] "octo": ${burst.seen.length} request(s) ${burst.seen.join(" ")}, ${shown} options, list ${shownAfter} ms after the last key`);

    if (process.env.SHOT_DIR) await dialog.screenshot({ path: `${process.env.SHOT_DIR}/share-autocomplete-listbox.png` });

    // Axe with the listbox open (same tag set and exclusions as e2e/a11y.spec.ts).
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["color-contrast"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);

    // A 5th character narrows the list within 600 ms with one more request.
    const fifth = countRequests(page, USERS);
    await page.keyboard.type("c");
    const fifthAt = Date.now();
    await expect(options).toHaveCount(1, { timeout: budgetMs(600) });
    const narrowedAfter = Date.now() - fifthAt;
    await expect(options.first()).toHaveAttribute("data-login", "octocat");
    await expect(options.first()).toContainText("@octocat");
    expect(fifth.seen.length).toBeLessThanOrEqual(1);
    fifth.stop();
    console.log(`[autocomplete] "octoc": ${fifth.seen.length} request(s), narrowed ${narrowedAfter} ms after the key`);

    // ↓ activates the first option (announced through aria-activedescendant), Enter fills the box —
    // and nothing is added until Add is pressed.
    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.keyboard.press("ArrowDown");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    expect(await input.getAttribute("aria-activedescendant")).toBe(await options.first().getAttribute("id"));
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("octocat");
    await expect(list).toHaveCount(0);
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("share-role")).toBeFocused();
    expect(adds.seen).toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(0);
    expect((await (await page.request.get(`/api/documents/${id}/collaborators`)).json()).collaborators).toEqual([]);

    // The owner picks a role and presses Add, as before.
    await page.getByTestId("share-role").selectOption("commenter");
    await page.getByTestId("share-add").click();
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByTestId("collaborator-row")).toContainText("@octocat");
    await expect(input).toHaveValue("");
    adds.stop();
    expect(adds.seen).toHaveLength(1);

    // Someone already listed is not suggested again; the owner never is.
    await input.click();
    await page.keyboard.type("octo");
    await expect(list).toBeVisible();
    await expect(options.first()).toBeVisible();
    const logins = await options.evaluateAll((els) => els.map((el) => el.getAttribute("data-login")));
    expect(logins).not.toContain("octocat");
    expect(logins).not.toContain("autocomplete-owner");
    expect(logins.length).toBeGreaterThanOrEqual(1);

    // A click picks too.
    await options.first().click();
    await expect(input).toHaveValue(logins[0]!);
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);

    // Escape closes the list first and the dialog only on the next press.
    await input.click();
    await input.fill("");
    await page.keyboard.type("hub");
    await expect(list).toBeVisible();
    await expect(options.first()).toHaveAttribute("data-login", "hubot");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue("hub");
    // ↓ brings the same list back without another request.
    const reopen = countRequests(page, USERS);
    await page.keyboard.press("ArrowDown");
    await expect(list).toBeVisible();
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    reopen.stop();
    expect(reopen.seen).toHaveLength(0);
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await owner.context.close();
  });

  test("adding by exact handle keeps working when nothing matches (no list, no error)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-plain-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Plain\n", "Plain");
    await openDocument(page, id);
    const { input, list } = await openShare(page);
    await page.keyboard.type("zz-nobody");
    // Long enough for the debounce and the (empty) answer.
    await page.waitForTimeout(budgetMs(700));
    await expect(list).toHaveCount(0);
    await expect(input).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("dialog", { name: /share/i }).locator(".text-danger")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("collaborator-row")).toContainText("@zz-nobody");
    await owner.context.close();
  });

  test("a held Enter after picking a suggestion does not add the collaborator — nor does a later, released Enter: the role select has no Enter handling at all, same as main", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-held-enter-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Held Enter\n", "Held Enter");
    expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await page.keyboard.type("octop"); // exactly three matches: octopus, octopod, octoprint
    await expect(options).toHaveCount(3);
    await page.keyboard.press("ArrowDown");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    // A real held key: one keydown picks, and — without ever releasing the key — a second keydown
    // follows, just like a physical key's auto-repeat. The pick moves focus to the role select, so
    // this second keydown is the one that would implicitly submit if the select did not block it.
    await page.keyboard.down("Enter");
    await expect(input).toHaveValue("octopus");
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(0);

    // The select has no onKeyDown at all - a plain, fully released Enter afterwards adds nobody either;
    // only the Add button submits.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(budgetMs(300));
    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(0);

    adds.stop();
    await owner.context.close();
  });


  test("a fast real double click on a suggestion fills exactly that login and reaches nothing underneath (narrow width)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-dblclick-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Double Click\n", "Double Click");
    expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
    // A collaborator already on the document, so a click-through has somewhere real to land: the
    // role select or Add right below the list, or this row's own role select and Remove further down.
    expect((await page.request.post(`/api/documents/${id}/collaborators`, { data: { login: "preexisting", role: "viewer" } })).status()).toBeLessThan(300);
    await openDocument(page, id);
    await page.setViewportSize({ width: 390, height: 844 });
    const { input, options } = await openShare(page);

    await page.keyboard.type("octop"); // three matches
    await expect(options).toHaveCount(3);
    const middle = options.nth(1);
    const login = await middle.getAttribute("data-login");
    const box = (await middle.boundingBox())!;

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByLabel("Role for preexisting")).toHaveValue("viewer");
    adds.stop();
    await owner.context.close();
  });

  test("a real touch double tap on a suggestion behaves the same as a double click (wide width, eight suggestions, last option)", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await devLogin(page, "autocomplete-dbltap-owner");
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Double Tap\n", "Double Tap");
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    expect((await page.request.post(`/api/documents/${id}/collaborators`, { data: { login: "preexisting", role: "viewer" } })).status()).toBeLessThan(300);
    await openDocument(page, id);
    await page.setViewportSize({ width: 1280, height: 900 });
    const { input, options } = await openShare(page);

    await page.keyboard.type("octo"); // nine matches, capped at eight
    await expect(options).toHaveCount(8);
    const last = options.last();
    const login = await last.getAttribute("data-login");
    const box = (await last.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByLabel("Role for preexisting")).toHaveValue("viewer");
    adds.stop();
    await context.close();
  });

  test("a fast real double click on the lone suggestion fills it and reaches nothing underneath (one row, narrow width)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-dblclick-single-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Double Click Single\n", "Double Click Single");
    expect((await page.request.get(`${USERS}?q=octoc`, { timeout: 120_000 })).status()).toBe(200);
    expect((await page.request.post(`/api/documents/${id}/collaborators`, { data: { login: "preexisting", role: "viewer" } })).status()).toBeLessThan(300);
    await openDocument(page, id);
    await page.setViewportSize({ width: 390, height: 844 });
    const { input, options } = await openShare(page);

    await page.keyboard.type("octoc"); // exactly one match: octocat — the list is one row tall
    await expect(options).toHaveCount(1);
    const only = options.first();
    const login = await only.getAttribute("data-login");
    const box = (await only.boundingBox())!;

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByLabel("Role for preexisting")).toHaveValue("viewer");
    adds.stop();
    await owner.context.close();
  });

  test("a real touch double tap on the lone suggestion behaves the same as a double click (one row, narrow width)", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await devLogin(page, "autocomplete-dbltap-single-owner");
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Double Tap Single\n", "Double Tap Single");
    expect((await page.request.get(`${USERS}?q=octoc`, { timeout: 120_000 })).status()).toBe(200);
    expect((await page.request.post(`/api/documents/${id}/collaborators`, { data: { login: "preexisting", role: "viewer" } })).status()).toBeLessThan(300);
    await openDocument(page, id);
    await page.setViewportSize({ width: 390, height: 844 });
    const { input, options } = await openShare(page);

    await page.keyboard.type("octoc"); // exactly one match: octocat — the list is one row tall
    await expect(options).toHaveCount(1);
    const only = options.first();
    const login = await only.getAttribute("data-login");
    const box = (await only.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByLabel("Role for preexisting")).toHaveValue("viewer");
    adds.stop();
    await context.close();
  });

  test("a fast real triple tap does not let the third tap reach the Link access select underneath (wide width, zero collaborators)", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await devLogin(page, "autocomplete-tripletap-wide-owner");
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Triple Tap Wide\n", "Triple Tap Wide");
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    await page.setViewportSize({ width: 1280, height: 800 });
    const { input, options } = await openShare(page);
    const linkAccess = page.getByTestId("link-access");
    const linkAccessValueBefore = await linkAccess.inputValue();

    await page.keyboard.type("octo"); // nine matches, capped at eight — tall enough to reach the Link access select below
    await expect(options).toHaveCount(8);
    const hit = await findOptionOverlapping(options, linkAccess);
    expect(hit, "no suggestion sits over the Link access select at this viewport — adjust the query or viewport").not.toBeNull();
    const { box } = hit!;
    const login = await hit!.option.getAttribute("data-login");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const patches = countRequests(page, `/api/documents/${id}`, "PATCH");
    // Real taps, 150 ms apart, with no pause — same point each time. Tap 1 picks and closes the list;
    // tap 2 should land on the click-shield left in the option's place; tap 3 must still find the shield
    // there too, not the Link access select it is standing in for.
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(patches.seen, "PATCH /api/documents/:id requests").toHaveLength(0);
    await expect(linkAccess).toHaveValue(linkAccessValueBefore);
    patches.stop();
    await context.close();
  });

  test("a fast real triple tap does not let the third tap reach a collaborator's role select underneath (narrow width, three collaborators)", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    await devLogin(page, "autocomplete-tripletap-narrow-owner");
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Triple Tap Narrow\n", "Triple Tap Narrow");
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    for (const collaboratorLogin of ["collab-a", "collab-b", "collab-c"]) {
      expect((await page.request.post(`/api/documents/${id}/collaborators`, { data: { login: collaboratorLogin, role: "viewer" } })).status()).toBeLessThan(300);
    }
    await openDocument(page, id);
    await page.setViewportSize({ width: 390, height: 844 });
    const { input, options } = await openShare(page);
    const targetRole = page.getByLabel("Role for collab-c");
    const targetRoleValueBefore = await targetRole.inputValue();

    await page.keyboard.type("octo"); // nine matches, capped at eight
    await expect(options).toHaveCount(8);
    const hit = await findOptionOverlapping(options, targetRole);
    expect(hit, "no suggestion sits over collab-c's role select at this viewport — adjust the query or viewport").not.toBeNull();
    const { box } = hit!;
    const login = await hit!.option.getAttribute("data-login");
    // 90% across the option's own width, not its center: at this width the role select sits further
    // right under the row than the option's midpoint does.
    const x = box.x + box.width * 0.9;
    const y = box.y + box.height / 2;

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    const removes = countRequests(page, `/api/documents/${id}/collaborators`, "DELETE");
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);

    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.waitForTimeout(budgetMs(300));

    expect(adds.seen, "POST /collaborators requests (a role change reuses this route)").toHaveLength(0);
    expect(removes.seen, "DELETE /collaborators requests").toHaveLength(0);
    await expect(page.getByTestId("collaborator-row")).toHaveCount(3);
    await expect(targetRole).toHaveValue(targetRoleValueBefore);
    adds.stop();
    removes.stop();
    await context.close();
  });

  test("Add accepts exactly what the server accepts: a 1-character login, a leading @, a trailing hyphen; rejects 40 characters and embedded spaces", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-validate-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Validate\n", "Validate");
    await openDocument(page, id);
    const { input } = await openShare(page);
    const add = page.getByTestId("share-add");

    // 1 character: too short to search suggestions for (SUGGEST_MIN_CHARS is 2), but the server's own
    // minimum is 1 — a real, addable GitHub login shape.
    await page.keyboard.type("x");
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId("collaborator-row").filter({ hasText: "@x" })).toHaveCount(1);

    await input.fill("");
    await page.keyboard.type("@y"); // leading @
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId("collaborator-row").filter({ hasText: "@y" })).toHaveCount(1);

    await input.fill("");
    await page.keyboard.type("octo-"); // trailing hyphen: the server's regex allows it
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId("collaborator-row").filter({ hasText: "@octo-" })).toHaveCount(1);

    await input.fill("");
    await page.keyboard.type("a".repeat(40)); // over the server's 39-character max
    await expect(add).toBeDisabled();

    await input.fill("");
    await page.keyboard.type("bad name"); // embedded space: not a login shape
    await expect(add).toBeDisabled();

    await owner.context.close();
  });

  test("typing past a highlighted suggestion with no pause before Enter adds exactly the typed handle, never the stale suggestion", async ({ browser }) => {
    // The reported repro: type "octop" (3 matches), ArrowDown highlights "octopus", then "x" and "Enter" land
    // back-to-back with no wait - a keydown can reach handleKeyDown before the effect that (asynchronously)
    // would otherwise clear the stale active option/list for the new query "octopx" has run. 6x CPU throttling
    // (Chromium via CDP) widens that window the same way slowing the real machine down did in the report.
    const context = await browser.newContext();
    const page = await context.newPage();
    await devLogin(page, "autocomplete-race-owner");
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Race\n", "Race");
    expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { options } = await openShare(page);

    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    try {
      const adds = countCollaboratorPosts(page, id);

      await page.keyboard.type("octop"); // octopus, octopi, octoprint
      await expect(options).toHaveCount(3, { timeout: budgetMs(2000) });
      await page.keyboard.press("ArrowDown"); // highlights octopus

      // Fire the two keydowns back-to-back with no round trip between them (not even an await), so there is no
      // gap in which a passive effect could flush between "x" changing the query and "Enter" being handled.
      await Promise.all([page.keyboard.press("x"), page.keyboard.press("Enter")]);
      await page.keyboard.press("Enter"); // the report's second Enter, in case the first only closed a stale list

      // Wait for whatever Enter triggered (a pick plus a role-select Enter, pre-fix; or the typed handle's own
      // submit, post-fix) to actually reach the collaborators route, then inspect the login it carried - a POST
      // is the stable thing to check here, since the field itself resets to "" moments after a successful add.
      await expect.poll(() => adds.seen.length, { timeout: budgetMs(5000) }).toBeGreaterThan(0);
      expect(adds.seen.map((a) => a.login), "POST /collaborators logins").not.toContain("octopus");
      expect(adds.seen.map((a) => a.login), "POST /collaborators logins").toContain("octopx");

      adds.stop();
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    await context.close();
  });

  test("Enter with the suggestion list open and no option highlighted adds exactly the typed handle (no arrow pressed first)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-enter-no-active-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Enter No Active\n", "Enter No Active");
    await openDocument(page, id);
    const { options } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    await page.keyboard.type("octo"); // octocat, octodog, … — several matches, none highlighted
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.press("Enter"); // no ArrowDown/ArrowUp/Home/End pressed — nothing is active

    await expect.poll(() => adds.seen.length, { timeout: budgetMs(2000) }).toBe(1);
    expect(adds.seen[0]!.login).toBe("octo");
    adds.stop();
    await owner.context.close();
  });

  test("a slower answer for a longer query never leaves the shorter query's list on screen, and Enter cannot pick from it", async ({ browser }) => {
    // The GitHub mock only knows fixed logins (octocat, octodog, …), not arbitrary prefixes, so this uses
    // page.route to fully control both the content and the timing of two specific queries: "ab" answers at
    // once, "abc" is held back 2 s - the same "a slower response for an older/newer query" shape the issue's
    // review asked for, just forced deterministically instead of relying on real network jitter.
    const owner = await signIn(browser, "autocomplete-stale-route-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Stale Route\n", "Stale Route");
    await openDocument(page, id);

    await page.route(/\/api\/github\/users(\?|$)/, async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") ?? "";
      if (q === "ab") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            users: [
              { login: "abby", name: null, avatarUrl: "" },
              { login: "abel", name: null, avatarUrl: "" },
            ],
            limited: false,
          }),
        });
        return;
      }
      if (q === "abc") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ users: [{ login: "abcdef", name: null, avatarUrl: "" }], limited: false }),
        });
        return;
      }
      await route.continue();
    });

    const { options, list } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    await page.keyboard.type("ab");
    await expect(options).toHaveCount(2, { timeout: budgetMs(2000) }); // abby, abel
    await page.keyboard.press("ArrowDown"); // highlights abby

    await page.keyboard.type("c"); // "abc" - its own answer is 2 s away; "ab"'s list must not linger
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId("share-login-loading")).toBeVisible();

    await page.keyboard.press("ArrowDown"); // nothing to move among while "abc" is still loading
    // No option is active (the list was empty while "abc" was still loading), so Enter submits the typed
    // handle as-is and Add clears the field on success — asserting the field's post-submit value here would
    // race that clear (it only reads "abc" if checked before the POST resolves). Assert on the POST's own
    // login payload instead: it is the one thing that cannot be racy.
    await page.keyboard.press("Enter");

    await expect.poll(() => adds.seen.length, { message: "POST /collaborators count" }).toBeGreaterThan(0);
    expect(adds.seen.map((a) => a.login), "POST /collaborators logins").toEqual(["abc"]); // not "abby" or "abel" — the stale ("ab") list is never picked

    adds.stop();
    await owner.context.close();
  });

  /** Routes `/api/github/users`: the first lookup fails at once; every later call (a manual retry) is
  /** Routes `/api/github/users`: the first lookup fails at once; every later call (a manual retry) is
   * held until the test calls `release()` — not a fixed sleep, so the test can assert "still pending"
   * state deterministically before letting it resolve — then answers with `secondAnswer` (another
   * failure, or a real result). */
  async function mockFailThenRetry(page: Page, secondAnswer: "fail" | { login: string }) {
    let call = 0;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    await page.route(/\/api\/github\/users(\?|$)/, async (route) => {
      call += 1;
      if (call === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
        return;
      }
      await secondGate;
      if (secondAnswer === "fail") {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ users: [{ login: secondAnswer.login, name: null, avatarUrl: "" }], limited: false }),
        });
      }
    });
    return { release: () => releaseSecond() };
  }

  test("keyboard Retry: focus stays on the button through a pending retry and a second failure, and a repeated Enter sends no extra request", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-retry-kbd-fail-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Retry KBD Fail\n", "Retry KBD Fail");
    const retry = await mockFailThenRetry(page, "fail");
    await openDocument(page, id);
    const { input } = await openShare(page);
    const lookups = countRequests(page, USERS);

    // fill(), not keyboard.type(): a single committed value fires exactly one debounced lookup for the
    // full handle. Typed keystroke-by-keystroke, a gap of more than 250 ms between two of them can let an
    // incomplete prefix fire its own lookup first — a real test-timing hazard, not a product bug (the
    // product itself never sends a duplicate request while retrying) — which used to inflate this test's
    // request count and make it flaky.
    await input.fill("retrykbdfail");
    await expect(page.getByTestId("share-login-error")).toBeVisible({ timeout: budgetMs(2000) });
    const retryButton = page.getByRole("button", { name: "Retry" });
    await page.keyboard.press("Tab");
    await expect(retryButton).toBeFocused();

    await page.keyboard.press("Enter"); // starts the manual retry (2nd request), held until release()
    const retrying = page.getByRole("button", { name: "Retrying…" });
    await expect(retrying).toBeFocused(); // never drops to <body> just because the button re-renders
    await page.keyboard.press("Enter"); // must not start a 3rd request while one is already in flight
    await expect.poll(() => lookups.seen.length, { message: "GET /api/github/users requests while the retry is pending" }).toBe(2);

    // The held retry lands as a second failure; focus is still on Retry, never <body>.
    retry.release();
    await expect(retryButton).toBeFocused({ timeout: budgetMs(2000) });
    expect(lookups.seen.length, "GET /api/github/users requests after the second failure").toBe(2);

    lookups.stop();
    await owner.context.close();
  });

  test("keyboard Retry: a successful retry moves focus to the handle field with suggestions shown", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-retry-kbd-ok-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Retry KBD OK\n", "Retry KBD OK");
    const retry = await mockFailThenRetry(page, { login: "retrykbdok" });
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await input.fill("retrykbdok");
    await expect(page.getByTestId("share-login-error")).toBeVisible({ timeout: budgetMs(2000) });
    const retryButton = page.getByRole("button", { name: "Retry" });
    await page.keyboard.press("Tab");
    await expect(retryButton).toBeFocused();
    await page.keyboard.press("Enter");
    retry.release();

    await expect(input).toBeFocused({ timeout: budgetMs(2000) });
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-login", "retrykbdok");

    await owner.context.close();
  });

  test("mouse Retry: focus stays on the button through a pending retry and a second failure, and a repeated click sends no extra request", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-retry-mouse-fail-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Retry Mouse Fail\n", "Retry Mouse Fail");
    const retry = await mockFailThenRetry(page, "fail");
    await openDocument(page, id);
    const { input } = await openShare(page);
    const lookups = countRequests(page, USERS);

    await input.fill("retrymousefail");
    await expect(page.getByTestId("share-login-error")).toBeVisible({ timeout: budgetMs(2000) });
    const retryButton = page.getByRole("button", { name: "Retry" });
    await retryButton.click(); // starts the manual retry (2nd request), held until release()

    const retrying = page.getByRole("button", { name: "Retrying…" });
    await expect(retrying).toBeFocused();
    // aria-disabled (not disabled) keeps it focusable, but Playwright's own actionability check
    // auto-waits for aria-disabled to clear before a plain click — that would wait out the whole
    // retry and silently turn this into a third, legitimate click. force: true skips that wait so
    // this actually exercises handleRetry's own in-flight guard, same as the keyboard test's second Enter.
    await retrying.click({ force: true });
    await expect.poll(() => lookups.seen.length, { message: "GET /api/github/users requests while the retry is pending" }).toBe(2);

    retry.release();
    await expect(retryButton).toBeFocused({ timeout: budgetMs(2000) });
    expect(lookups.seen.length, "GET /api/github/users requests after the second failure").toBe(2);

    lookups.stop();
    await owner.context.close();
  });

  test("mouse Retry: a successful retry moves focus to the handle field with suggestions shown", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-retry-mouse-ok-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Retry Mouse OK\n", "Retry Mouse OK");
    const retry = await mockFailThenRetry(page, { login: "retrymouseok" });
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await input.fill("retrymouseok");
    await expect(page.getByTestId("share-login-error")).toBeVisible({ timeout: budgetMs(2000) });
    await page.getByRole("button", { name: "Retry" }).click();
    retry.release();

    await expect(input).toBeFocused({ timeout: budgetMs(2000) });
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveAttribute("data-login", "retrymouseok");

    await owner.context.close();
  });

  test("a resting mouse pointer over where a suggestion is about to render never steals Enter — real Chromium fires a synthetic mouseover/pointerover there with no mousemove, and only genuine pointer movement may activate an option", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-resting-pointer-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Resting Pointer\n", "Resting Pointer");
    await openDocument(page, id);
    const { input, options } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    // Learn where the first suggestion will land, then clear the box and park the pointer there before
    // anything renders — so the next keystroke's option reappears under an already-resting pointer, the
    // exact scenario that used to steal Enter (measured: mouseover/pointerover fire there with no mousemove).
    await page.keyboard.type("octo");
    await expect(options.first()).toBeVisible();
    const box = (await options.first().boundingBox())!;
    await input.fill("");
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(budgetMs(150));

    await page.keyboard.type("octo"); // octocat reappears right under the resting pointer; the pointer never moves
    await expect(options.first()).toBeVisible();
    await expect(input).not.toHaveAttribute("aria-activedescendant"); // nothing is active: no real movement occurred
    await expect(options.first()).toHaveAttribute("aria-selected", "false");

    await page.keyboard.press("Enter");
    await expect.poll(() => adds.seen.length).toBe(1);
    expect(adds.seen.map((a) => a.login)).toEqual(["octo"]); // the typed text, never the option under the pointer

    adds.stop();
    await owner.context.close();
  });

  test("real mouse movement onto a suggestion still activates it for Enter to pick (the fix narrows what activates an option, it does not remove hover)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-real-pointer-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Real Pointer\n", "Real Pointer");
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await page.keyboard.type("octo");
    const target = options.nth(1);
    await expect(target).toBeVisible();
    const box = (await target.boundingBox())!;
    // Genuine movement: start away from the option, then move onto it.
    await page.mouse.move(box.x - 60, box.y - 60);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(target).toHaveAttribute("aria-selected", "true");
    const login = await target.getAttribute("data-login");

    await page.keyboard.press("Enter");
    await expect(input).toHaveValue(login!);
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);

    await owner.context.close();
  });

  test("retyping a fully cached prefix never makes the suggestion list disappear for even one frame, and sends no new request", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-cache-flicker-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Cache Flicker\n", "Cache Flicker");
    await openDocument(page, id);
    const { input } = await openShare(page);

    // Prime the cache for "oc", "oct" and "octo" individually: each keystroke waits out its own debounce and
    // answer before the next, so every one of those three queries gets its own settled cache entry.
    for (const next of ["oc", "t", "o"]) {
      await page.keyboard.type(next);
      await expect(page.getByTestId("share-login-suggestions")).toBeVisible();
      await page.waitForTimeout(budgetMs(400));
    }
    await expect(input).toHaveValue("octo");

    // Clip back to the already-cached "oct" (no debounce wait needed: a cache hit answers immediately).
    await input.fill("oct");
    await expect(page.getByTestId("share-login-suggestions")).toBeVisible();
    const lookups = countRequests(page, USERS);

    // Start a requestAnimationFrame poll running in the page *before* the keystroke that retypes "octo", a
    // fully cached query. The original bug: cache-hit detection lived only in a useEffect, one render behind
    // the query change, so the listbox unmounted for a frame before the effect's own state update remounted it.
    await page.evaluate(() => {
      (window as unknown as { __suggFrames: boolean[] }).__suggFrames = [];
      let n = 0;
      const tick = () => {
        (window as unknown as { __suggFrames: boolean[] }).__suggFrames.push(!!document.querySelector('[data-testid="share-login-suggestions"]'));
        n += 1;
        if (n < 40) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press("o"); // back to "octo" — every candidate for it is already in the cache
    await page.waitForTimeout(budgetMs(700)); // outlasts the 40-frame poll (~640 ms at 60 Hz)

    const frames = await page.evaluate(() => (window as unknown as { __suggFrames: boolean[] }).__suggFrames);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(Boolean), "the suggestion list must never disappear for even one polled frame on a cache-hit keystroke").toBe(true);

    lookups.stop();
    expect(lookups.seen, "a cache hit must not fire a new network request").toHaveLength(0);

    await owner.context.close();
  });

  // Blurring the handle field used to close the suggestion list synchronously (setOpen(false) unmounting the
  // <ul> in the very same tick). Whatever caused the blur — Tab's native focus-move, or a click somewhere
  // else that's still resolving — can read "where does focus go next" from the DOM as it stood an instant
  // earlier; unmounting the listbox before that move finishes sent focus to the dialog's own focus-trap
  // container instead of the role select, Add, or whatever was actually clicked. handleBlur now defers the
  // close by a macrotask so focus settles first (see its comment in collaborator-login-input.tsx).
  test.describe("the suggestion list closing never steals focus to the dialog container", () => {
    test("Tab with the list open and no option highlighted moves focus through role select, then Add, and Shift+Tab moves back — the list closes, nothing is picked, the typed text stays", async ({ browser }) => {
      const owner = await signIn(browser, "autocomplete-tab-nolist-owner");
      const { page } = owner;
      const id = await createDocument(page, "# Tab No Active\n", "Tab No Active");
      expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
      await openDocument(page, id);
      const { input } = await openShare(page);

      const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
      await page.keyboard.type("octop"); // three matches (octocat, octodog, octofox)
      await expect(page.getByTestId("share-login-suggestions")).toBeVisible();

      await page.keyboard.press("Tab");
      await expect(page.getByTestId("share-role")).toBeFocused();
      await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
      await expect(input).toHaveValue("octop");

      await page.keyboard.press("Tab");
      await expect(page.getByTestId("share-add")).toBeFocused();

      await page.keyboard.press("Shift+Tab");
      await expect(page.getByTestId("share-role")).toBeFocused();

      await page.keyboard.press("Shift+Tab");
      await expect(input).toBeFocused();

      expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
      await expect(page.getByTestId("collaborator-row")).toHaveCount(0);
      await owner.context.close();
    });

    test("Tab with an option highlighted by ArrowDown picks nothing — the typed text stays, not the highlighted login", async ({
      browser,
    }) => {
      const owner = await signIn(browser, "autocomplete-tab-active-owner");
      const { page } = owner;
      const id = await createDocument(page, "# Tab Active Option\n", "Tab Active Option");
      expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
      await openDocument(page, id);
      const { input, options } = await openShare(page);

      const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
      await page.keyboard.type("octop");
      await expect(options.first()).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(options.first()).toHaveAttribute("aria-selected", "true");

      await page.keyboard.press("Tab");
      await expect(page.getByTestId("share-role")).toBeFocused();
      await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
      // Tab must not act like Enter: the active option is never picked just because it was highlighted.
      await expect(input).toHaveValue("octop");

      expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
      await expect(page.getByTestId("collaborator-row")).toHaveCount(0);
      await owner.context.close();
    });

    test("Shift+Tab from the field with the list open reaches the same place Shift+Tab reaches with the list closed (the dialog's Close button), not the dialog container", async ({
      browser,
    }) => {
      const owner = await signIn(browser, "autocomplete-shifttab-owner");
      const { page } = owner;
      const id = await createDocument(page, "# Shift Tab\n", "Shift Tab");
      expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
      await openDocument(page, id);
      const { input } = await openShare(page);
      const closeButton = page.getByRole("button", { name: "Close" });

      await page.keyboard.type("octop");
      await expect(page.getByTestId("share-login-suggestions")).toBeVisible();

      await page.keyboard.press("Shift+Tab");
      await expect(closeButton).toBeFocused();
      await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
      await expect(input).toHaveValue("octop");
      await expect(page.getByTestId("collaborator-row")).toHaveCount(0);
      await owner.context.close();
    });

    test("a mouse click on the role select while the list is open lands focus on the role select, not the dialog container, and changing the role adds nobody", async ({
      browser,
    }) => {
      const owner = await signIn(browser, "autocomplete-click-role-owner");
      const { page } = owner;
      const id = await createDocument(page, "# Click Role\n", "Click Role");
      expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
      await openDocument(page, id);
      const { input } = await openShare(page);
      const roleSelect = page.getByTestId("share-role");
      const roleBefore = await roleSelect.inputValue();

      const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
      await page.keyboard.type("octop");
      await expect(page.getByTestId("share-login-suggestions")).toBeVisible();

      // The click itself is the regression check: before the fix, handleBlur's synchronous
      // setOpen(false) raced this click's own focus-move and focus landed on the dialog's
      // focus-trap container instead of the select.
      await roleSelect.click();
      await expect(roleSelect).toBeFocused();
      await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
      await roleSelect.selectOption("commenter");
      await expect(roleSelect).toBeFocused();
      await expect(roleSelect).toHaveValue("commenter");
      expect(roleBefore).not.toBe("commenter");
      await expect(input).toHaveValue("octop");

      expect(adds.seen, "POST /collaborators requests").toHaveLength(0);
      await expect(page.getByTestId("collaborator-row")).toHaveCount(0);
      await owner.context.close();
    });
  });

  test("scenario A - shrinking back to an already-cached shorter query with an option active elsewhere: Enter adds exactly the typed handle, never a stale option (#2244 review)", async ({ browser }) => {
    // "octo" (8 matches) and "octop" (octopus, octopod, octoprint) are both fetched and cached by typing and
    // waiting for each in turn. ArrowDown then highlights "octop"'s first option ("octopus"). Backspace back to
    // "octo" and Enter land in the same tick (Promise.all, no round trip between them): "octo" is already
    // cached, so the list for "octo" renders on this very keystroke's render, before the effect that would
    // otherwise clear the stale active index for the new query has run. Pre-fix, that stale index (0, still
    // in-bounds for "octo"'s own list) reads as if it were set for "octo" and Enter picks "octocat" instead of
    // submitting "octo". Post-fix, nothing is active for "octo" and Enter falls through to the form's default
    // submit, adding "octo" directly.
    const owner = await signIn(browser, "autocomplete-shrink-cached-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Shrink Cached\n", "Shrink Cached");
    // Next dev compiles the route on its first request: take that hit before timing anything (same warm-up
    // used by the other race tests in this file).
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    await page.keyboard.type("octo");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.type("p");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.press("ArrowDown"); // highlights "octopus", index 0 of "octop"'s list

    await Promise.all([page.keyboard.press("Backspace"), page.keyboard.press("Enter")]);

    await expect.poll(() => adds.seen.length, { timeout: budgetMs(3000) }).toBe(1);
    expect(adds.seen[0]!.login, "POST /collaborators login").toBe("octo");
    expect(adds.seen.map((a) => a.login)).not.toContain("octocat");
    await expect(input).toHaveValue(""); // the field resets after a successful add
    adds.stop();
    await owner.context.close();
  });

  test("scenario B - growing back into an already-cached longer query with an option active on the shorter query's list: Enter adds exactly the typed handle, never a stale option (#2244 review)", async ({ browser }) => {
    // Mirror of scenario A: "octo" and "octop" are both cached (type, wait; type, wait), then Backspace back to
    // "octo", ArrowDown highlights "octo"'s first option ("octocat"), then typing "p" and Enter land in the same
    // tick, growing the query back to "octop" (already cached). Pre-fix, the stale index (0, still in-bounds
    // for "octop"'s own 3-item list too) reads as valid for "octop" and Enter picks "octopus" instead of
    // submitting "octop".
    const owner = await signIn(browser, "autocomplete-grow-cached-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Grow Cached\n", "Grow Cached");
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    await page.keyboard.type("octo");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.type("p");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("octo");
    await page.keyboard.press("ArrowDown"); // highlights "octocat", index 0 of "octo"'s list

    await Promise.all([page.keyboard.press("p"), page.keyboard.press("Enter")]);

    await expect.poll(() => adds.seen.length, { timeout: budgetMs(3000) }).toBe(1);
    expect(adds.seen[0]!.login, "POST /collaborators login").toBe("octop");
    expect(adds.seen.map((a) => a.login)).not.toContain("octopus");
    await expect(input).toHaveValue("");
    adds.stop();
    await owner.context.close();
  });

  test("scenario C - same as scenario B with a later option active, not just the first: Enter still adds exactly the typed handle (#2244 review)", async ({ browser }) => {
    // Same shape as scenario B, but ArrowDown three times highlights "octo"'s third option ("octofox", index 2)
    // before growing back to "octop". Pre-fix, index 2 is also in-bounds for "octop"'s 3-item list, so Enter
    // picks "octop"'s third option ("octoprint") instead of submitting "octop" - proving the bug is not specific
    // to index 0 lining up by coincidence.
    const owner = await signIn(browser, "autocomplete-grow-cached-index2-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Grow Cached Index Two\n", "Grow Cached Index Two");
    expect((await page.request.get(`${USERS}?q=octo`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);
    const adds = countCollaboratorPosts(page, id);

    await page.keyboard.type("octo");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.type("p");
    await expect(options.first()).toBeVisible({ timeout: budgetMs(2000) });
    await page.keyboard.press("Backspace");
    await expect(input).toHaveValue("octo");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown"); // highlights "octo"'s third option (index 2, "octofox")

    await Promise.all([page.keyboard.press("p"), page.keyboard.press("Enter")]);

    await expect.poll(() => adds.seen.length, { timeout: budgetMs(3000) }).toBe(1);
    expect(adds.seen[0]!.login, "POST /collaborators login").toBe("octop");
    expect(adds.seen.map((a) => a.login)).not.toContain("octoprint");
    await expect(input).toHaveValue("");
    adds.stop();
    await owner.context.close();
  });
});
