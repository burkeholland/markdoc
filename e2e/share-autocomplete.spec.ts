import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, openDocument, budgetMs } from "./helpers";

/**
 * Share dialog · GitHub handle autocomplete (task #920). GitHub is the in-memory fake (GITHUB_MOCK=1),
 * whose user search knows `octocat`, `octodog`, … `monalisa`, `hubot`, so the suite runs offline.
 * `GET /api/github/users` itself is covered by src/app/api/github/users/route.test.ts; here we check
 * the route from a browser session and the combobox as the owner uses it.
 */
const USERS = "/api/github/users";

async function openShare(page: Page) {
  await page.getByTestId("share-button").click();
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
    const minted = await page.request.post("/api/tokens", { data: { name: "autocomplete probe", scope: "full" } });
    expect(minted.status()).toBe(201);
    const { token } = ((await minted.json()) as { token: { token: string } });
    const asToken = await page.request.get(`${USERS}?q=oc`, { headers: { Authorization: ["Bearer", token.token].join(" ") } });
    expect(asToken.status()).toBe(403);
    expect(((await asToken.json()) as { error: string }).error).toContain("browser session");
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
});
