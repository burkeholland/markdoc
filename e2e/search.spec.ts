import { test, expect } from "@playwright/test";
import { signIn, createDocument, uniqueLogin, type User } from "./helpers";

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
