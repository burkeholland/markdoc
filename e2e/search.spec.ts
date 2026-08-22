import { test, expect } from "@playwright/test";
import { signIn, createDocument, type User } from "./helpers";

test.describe("dashboard search", () => {
  let searcher: User;

  test.beforeAll(async ({ browser }) => {
    // A dedicated user so documents created by other specs on the shared server don't show up here.
    searcher = await signIn(browser, "searcher");
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
