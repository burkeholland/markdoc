import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, type User } from "./helpers";

async function goHome(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("document-list")).toBeVisible();
}

const cardTitles = (page: Page) => page.getByTestId("document-card").getByRole("heading").allInnerTexts();

test.describe("dashboard organisation", () => {
  let user: User;
  let idA: string;
  let idB: string;

  test.beforeAll(async ({ browser }) => {
    // A dedicated user so documents from other specs on the shared server stay out of the way.
    user = await signIn(browser, `organiser-${Date.now().toString(36)}`);
    // Chosen so the sort orders differ: recent = Mike, Zulu, Alpha; title = Alpha, Mike, Zulu; created = Alpha, Zulu, Mike.
    idA = await createDocument(user.page, "# Mike\n\nOpened last.\n", "Mike");
    idB = await createDocument(user.page, "# Zulu\n\nOpened first.\n", "Zulu");
    await createDocument(user.page, "# Alpha\n\nNever opened.\n", "Alpha");
    await goHome(user.page);
  });

  test.afterAll(async () => {
    await user.context.close();
  });

  test("starring a card shows it in the Starred strip and under the Starred chip; unstarring from the editor header removes it", async () => {
    const page = user.page;
    await expect(page.getByTestId("starred-strip")).toHaveCount(0);

    const card = page.getByTestId("document-card").filter({ hasText: "Mike" });
    await card.hover();
    const toggle = card.locator("..").getByTestId("star-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-starred", "true");

    const strip = page.getByTestId("starred-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByTestId("starred-card")).toHaveCount(1);
    await expect(strip.getByTestId("starred-card")).toContainText("Mike");

    await page.getByTestId("filter-starred").click();
    await expect(page.getByTestId("document-card")).toHaveCount(1);
    await expect(page.getByTestId("document-card")).toContainText("Mike");
    await expect(page.getByTestId("starred-strip")).toHaveCount(0);
    await page.getByTestId("filter-all").click();

    // Survives a reload (persisted on the server).
    await goHome(page);
    await expect(page.getByTestId("starred-strip").getByTestId("starred-card")).toContainText("Mike");

    // Unstar from the editor header.
    await openDocument(page, idA);
    const headerStar = page.getByTestId("header-star");
    await expect(headerStar).toHaveAttribute("data-starred", "true");
    await headerStar.click();
    await expect(headerStar).toHaveAttribute("data-starred", "false");

    await goHome(page);
    await expect(page.getByTestId("starred-strip")).toHaveCount(0);
    await page.getByTestId("filter-starred").click();
    await expect(page.getByTestId("document-card")).toHaveCount(0);
    await expect(page.getByTestId("empty-state")).toContainText("No starred documents");
    await page.getByTestId("filter-all").click();
  });

  test("default order is by last opened; sort by title is alphabetical and persists across reload", async () => {
    const page = user.page;
    // Mike was opened by the previous test; opening Zulu then Mike must put Mike first regardless.
    await openDocument(page, idB);
    await openDocument(page, idA);
    await goHome(page);

    await expect(page.getByTestId("sort-select")).toHaveValue("recent");
    await expect.poll(() => cardTitles(page)).toEqual(["Mike", "Zulu", "Alpha"]);

    await page.getByTestId("sort-select").selectOption("title");
    await expect.poll(() => cardTitles(page)).toEqual(["Alpha", "Mike", "Zulu"]);
    expect(await page.evaluate(() => window.localStorage.getItem("markdoc:dashboardSort"))).toBe("title");

    await page.getByTestId("sort-select").selectOption("created");
    await expect.poll(() => cardTitles(page)).toEqual(["Alpha", "Zulu", "Mike"]);

    await page.getByTestId("sort-select").selectOption("title");
    await goHome(page);
    await expect(page.getByTestId("sort-select")).toHaveValue("title");
    await expect.poll(() => cardTitles(page)).toEqual(["Alpha", "Mike", "Zulu"]);

    await page.getByTestId("sort-select").selectOption("recent");
    await expect.poll(() => cardTitles(page)).toEqual(["Mike", "Zulu", "Alpha"]);
  });
});
