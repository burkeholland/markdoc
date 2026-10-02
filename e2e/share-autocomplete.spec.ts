import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
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

  test("a held Enter after picking a suggestion does not add the collaborator a second time", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-held-enter-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Held Enter\n", "Held Enter");
    expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await page.keyboard.type("octop"); // exactly three matches: octopus, octopod, octoprint
    await expect(options).toHaveCount(3, { timeout: budgetMs(600) });
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
    adds.stop();
    await owner.context.close();
  });

  test("picking with Enter, releasing, then pressing Enter once more adds exactly one person with one POST", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-enter-add-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Enter Add\n", "Enter Add");
    expect((await page.request.get(`${USERS}?q=octop`, { timeout: 120_000 })).status()).toBe(200);
    await openDocument(page, id);
    const { input, options } = await openShare(page);

    await page.keyboard.type("octop"); // exactly three matches: octopus, octopod, octoprint
    await expect(options).toHaveCount(3, { timeout: budgetMs(600) });
    await page.keyboard.press("ArrowDown");

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.keyboard.press("Enter"); // picks: fills the field, moves focus to the role select
    await expect(input).toHaveValue("octopus");
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId("share-role")).toBeFocused();

    // Not held this time: key fully released, then pressed once more. This single Enter on the role
    // select must still submit, same as any other control the form's Enter would otherwise reach.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByTestId("collaborator-row")).toContainText("@octopus");
    adds.stop();
    expect(adds.seen, "POST /collaborators requests").toHaveLength(1);
    await owner.context.close();
  });

  test("typing a handle, tabbing to the role, and pressing Enter adds exactly one person (main's flow)", async ({ browser }) => {
    const owner = await signIn(browser, "autocomplete-tab-enter-owner");
    const { page } = owner;
    const id = await createDocument(page, "# Tab Enter\n", "Tab Enter");
    await openDocument(page, id);
    const { input } = await openShare(page);

    await page.keyboard.type("zz-nobody");
    // Long enough for the debounce and the (empty) answer, so no suggestion is left pending to pick.
    await page.waitForTimeout(budgetMs(700));
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);

    const adds = countRequests(page, `/api/documents/${id}/collaborators`, "POST");
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("share-role")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("collaborator-row")).toHaveCount(1);
    await expect(page.getByTestId("collaborator-row")).toContainText("@zz-nobody");
    await expect(input).toHaveValue(""); // the field resets after a successful add, just like clicking Add
    adds.stop();
    expect(adds.seen, "POST /collaborators requests").toHaveLength(1);
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
    await expect(options).toHaveCount(3, { timeout: budgetMs(600) });
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
    await expect(options).toHaveCount(8, { timeout: budgetMs(600) });
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
    await expect(options).toHaveCount(1, { timeout: budgetMs(600) });
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
    await expect(options).toHaveCount(1, { timeout: budgetMs(600) });
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
});
