import { test, expect } from "./fixtures";
import { createDocument, signIn, uniqueLogin, waitForHydration } from "./helpers";

test("dashboard background reaches the last card when documents overflow the viewport", async ({ browser }) => {
  const { page, context } = await signIn(browser, uniqueLogin("dashboard-background"));
  try {
    await page.setViewportSize({ width: 800, height: 420 });
    for (let i = 0; i < 6; i++) {
      await createDocument(
        page,
        "# Overflow " + i + "\n\nThis card is below the fold so the dashboard background must grow with the document list.\n",
        "Overflow " + i,
      );
    }

    await page.goto("/");
    await waitForHydration(page);
    await expect(page.getByTestId("document-list")).toBeVisible();

    const geometry = await page.evaluate(() => {
      const main = document.querySelector("main");
      const cards = [...document.querySelectorAll<HTMLElement>("[data-testid=document-card]")];
      const lastCard = cards.at(-1);
      if (!main || !lastCard) throw new Error("dashboard main or document card is missing");
      const mainBox = main.getBoundingClientRect();
      const lastCardBox = lastCard.getBoundingClientRect();
      return {
        mainBottom: mainBox.bottom,
        lastCardBottom: lastCardBox.bottom,
        viewportHeight: window.innerHeight,
      };
    });

    expect(geometry.lastCardBottom).toBeGreaterThan(geometry.viewportHeight);
    expect(geometry.mainBottom).toBeGreaterThanOrEqual(geometry.lastCardBottom);
  } finally {
    await context.close();
  }
});
