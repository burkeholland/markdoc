import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, uniqueLogin, waitForHydration, type User } from "./helpers";

test.describe("dashboard search", () => {
  let searcher: User;

  test.beforeAll(async ({ browser }) => {
    // A user of its own per run: every count below is over the whole account (2 cards, 1 result), so documents
    // created by other specs — or by a previous run of this one (--repeat-each, a CI retry) — must stay out.
    searcher = await signIn(browser, uniqueLogin("searcher"));
    await createDocument(searcher.page, "# Grocery list\n\nEggs, milk, bread.\n\nAlso remember the quokka treats for the weekend.\n", "Grocery list");
    await createDocument(searcher.page, "# Travel plans\n\nFly to Lisbon in May, then the train north.\n", "Travel plans");
    await searcher.page.goto("/");
    await searcher.page.waitForLoadState("networkidle");
  });

  test.afterAll(async () => {
    await searcher.context.close();
  });

  test("centers the slash shortcut hint vertically in the search field", async () => {
    const centerOffset = await searcher.page.getByTestId("search").evaluate((input) => {
      const keycap = input.parentElement?.querySelector("kbd");
      if (!keycap) throw new Error("The search shortcut hint was not rendered");
      const inputRect = input.getBoundingClientRect();
      const keycapRect = keycap.getBoundingClientRect();
      return Math.abs(inputRect.top + inputRect.height / 2 - keycapRect.top - keycapRect.height / 2);
    });

    expect(centerOffset).toBeLessThanOrEqual(1);
  });

  test("finds a document by body text and shows a highlighted snippet", async () => {
    const page = searcher.page;
    await expect(page.getByTestId("document-card")).toHaveCount(2);

    await page.getByTestId("search").fill("quokka");
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    const result = page.getByTestId("search-result").first();
    await expect(result.getByRole("heading")).toHaveText("Grocery list");
    const snippet = result.getByTestId("search-snippet");
    await expect(snippet).toContainText("quokka treats");
    await expect(snippet.locator("mark")).toHaveText("quokka");
    await expect(page.getByTestId("search-loading")).toHaveCount(0);
  });

  test("matches titles too and highlights them", async () => {
    const page = searcher.page;
    await page.getByTestId("search").fill("travel");
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    await expect(page.getByTestId("search-result").getByRole("heading").locator("mark")).toHaveText("Travel");
  });

  test("shows an empty state for a query nothing matches", async () => {
    const page = searcher.page;
    await page.getByTestId("search").fill("zxqvbnmplk");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zxqvbnmplk"');
    await expect(page.getByTestId("search-result")).toHaveCount(0);

    await page.getByTestId("search").fill("");
    await expect(page.getByTestId("document-card")).toHaveCount(2);
  });

  test("Escape clears the query, then blurs; the clear button and empty-state link clear it too", async () => {
    const page = searcher.page;
    const search = page.getByTestId("search");

    // Empty field: no clear button.
    await expect(page.getByTestId("search-clear")).toHaveCount(0);

    await search.fill("zzzzqqq");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zzzzqqq"');
    await expect(page.getByTestId("search-clear")).toBeVisible();

    // First Esc clears the query but keeps focus in the field.
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(page.getByTestId("document-card")).toHaveCount(2);
    await expect(page.getByTestId("search-clear")).toHaveCount(0);

    // Second Esc leaves the field.
    await search.press("Escape");
    await expect(search).not.toBeFocused();

    // The ✕ button clears and refocuses the field.
    await search.fill("zzzzqqq");
    await expect(page.getByTestId("search-result")).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search" }).first().click();
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await expect(page.getByTestId("document-card")).toHaveCount(2);

    // The empty state offers a "Clear search" action.
    await search.fill("zzzzqqq");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zzzzqqq"');
    await page.getByTestId("empty-state-clear-search").click();
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("document-card")).toHaveCount(2);
  });

  test("filter chips apply to search results", async () => {
    const page = searcher.page;
    await page.getByTestId("search").fill("quokka");
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    await page.getByRole("button", { name: "Shared with me" }).click();
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "quokka"');
    await page.getByRole("button", { name: "Owned by me" }).click();
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    await page.getByRole("button", { name: "All" }).click();
  });
});

// #2226: every way a person can put text in the box must filter the list, starting from a freshly
// loaded dashboard (the first input after mount is the one an event gate is most likely to drop).
test.describe("dashboard search: real input", () => {
  let searcher: User;

  test.beforeAll(async ({ browser }) => {
    searcher = await signIn(browser, uniqueLogin("search-input"));
    await createDocument(searcher.page, "# Grocery list\n\nAlso remember the quokka treats.\n", "Grocery list");
    await createDocument(searcher.page, "# Travel plans\n\nFly to Lisbon in May.\n", "Travel plans");
  });

  test.afterAll(async () => {
    await searcher.context.close();
  });

  async function freshDashboard(): Promise<Page> {
    const page = searcher.page;
    await page.goto("/");
    await waitForHydration(page);
    await expect(page.getByTestId("document-card")).toHaveCount(2);
    await expect(page.getByTestId("search")).toHaveValue("");
    return page;
  }

  async function expectOneQuokkaResult(page: Page) {
    await expect(page.getByTestId("search")).toHaveValue("quokka");
    await expect(page.getByTestId("search-result")).toHaveCount(1);
    await expect(page.getByTestId("search-result").getByRole("heading")).toHaveText("Grocery list");
  }

  test("typing key by key filters the list", async () => {
    const page = await freshDashboard();
    const search = page.getByTestId("search");
    await search.click();
    await search.pressSequentially("quokka", { delay: 40 });
    await expectOneQuokkaResult(page);
  });

  test("Ctrl+V paste filters the list", async () => {
    const page = await freshDashboard();
    await searcher.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
    await page.evaluate(() => navigator.clipboard.writeText("quokka"));
    const search = page.getByTestId("search");
    await search.click();
    await page.keyboard.press("ControlOrMeta+V");
    await expectOneQuokkaResult(page);
  });

  test("an IME composition commit filters the list", async () => {
    const page = await freshDashboard();
    const search = page.getByTestId("search");
    await search.click();
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", { text: "quo", selectionStart: 3, selectionEnd: 3 });
      await cdp.send("Input.imeSetComposition", { text: "quokka", selectionStart: 6, selectionEnd: 6 });
      await cdp.send("Input.insertText", { text: "quokka" });
    } finally {
      await cdp.detach();
    }
    await expectOneQuokkaResult(page);
  });

  test("fill() filters the list, a no-match query shows the empty state, and clearing restores the list", async () => {
    const page = await freshDashboard();
    const search = page.getByTestId("search");
    await search.fill("quokka");
    await expectOneQuokkaResult(page);

    await search.fill("zxqvbnmplk");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zxqvbnmplk"');
    await expect(page.getByTestId("search-result")).toHaveCount(0);

    await search.press("ControlOrMeta+A");
    await search.press("Backspace");
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("document-card")).toHaveCount(2);
  });

  test("a no-match query typed into a fresh dashboard shows the empty state", async () => {
    const page = await freshDashboard();
    await page.getByTestId("search").fill("zxqvbnmplk");
    await expect(page.getByTestId("empty-state")).toContainText('No matches for "zxqvbnmplk"');
    await expect(page.getByTestId("search-result")).toHaveCount(0);
  });
});
