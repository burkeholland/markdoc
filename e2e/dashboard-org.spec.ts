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

    // Unstar from the editor header. The star state is fetched after the first sync (#118), so it must
    // show within 3 s of "saved" (openDocument waited for it).
    await openDocument(page, idA);
    const headerStar = page.getByTestId("header-star");
    await expect(headerStar).toHaveAttribute("data-starred", "true", { timeout: 3_000 });
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

  test("a saved sort is in the server markup and the cards never reorder while the page hydrates (#165)", async ({ browser }) => {
    // A fresh context on the same account: a cookie holds the sort, so no localStorage is needed for it.
    const context = await browser.newContext({ storageState: await user.context.storageState() });
    const page = await context.newPage();
    try {
      await goHome(page);
      await page.getByTestId("sort-select").selectOption("title");
      await expect.poll(() => cardTitles(page)).toEqual(["Alpha", "Mike", "Zulu"]);
      const cookie = (await context.cookies()).find((c) => c.name === "markdoc.dashboardSort");
      expect(cookie?.value).toBe("title");
      expect(cookie?.sameSite).toBe("Lax");

      // Sample the select value and the card order on every frame from the first paint for 3 s. The script
      // runs before any of the page's own scripts, so the first sample is the server markup, before hydration.
      await page.addInitScript(() => {
        const samples: string[] = [];
        const started = performance.now();
        let firstSeen = 0;
        const tick = () => {
          const select = document.querySelector<HTMLSelectElement>('[data-testid="sort-select"]');
          const titles = Array.from(document.querySelectorAll('[data-testid="document-card"] h3'), (h) => h.textContent?.trim() ?? "");
          if (select && titles.length) {
            firstSeen ||= performance.now();
            const snapshot = `${select.value}:${titles.join("|")}`;
            if (samples[samples.length - 1] !== snapshot) samples.push(snapshot);
          }
          if (!firstSeen || performance.now() - firstSeen < 3000) requestAnimationFrame(tick);
          else (window as unknown as { __sortSamples: { samples: string[]; firstSeen: number; started: number } }).__sortSamples = { samples, firstSeen, started };
        };
        requestAnimationFrame(tick);
      });
      const response = await page.goto("/");
      const html = await response!.text();
      // The HTML the server sent already has "Title A–Z" selected and Alpha as the first card.
      const selectHtml = html.slice(html.indexOf('data-testid="sort-select"'), html.indexOf("</select>"));
      expect(selectHtml).toMatch(/<option[^>]*\bselected\b[^>]*value="title"|<option[^>]*value="title"[^>]*\bselected\b/);
      const firstCard = html.slice(html.indexOf('data-testid="document-card"'));
      expect(firstCard.match(/<h3[^>]*>(.*?)<\/h3>/)?.[1]).toBe("Alpha");

      const result = await page.waitForFunction(() => (window as unknown as { __sortSamples?: unknown }).__sortSamples, null, { timeout: 30_000 });
      const { samples } = (await result.jsonValue()) as { samples: string[] };
      expect(samples).toEqual(["title:Alpha|Mike|Zulu"]);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("sort-select")).toHaveValue("title");
    } finally {
      await context.close();
    }
  });

  test("a sort stored only in localStorage (before the cookie existed) is adopted and written to the cookie", async ({ browser }) => {
    const context = await browser.newContext({ storageState: await user.context.storageState() });
    const page = await context.newPage();
    try {
      await goHome(page);
      await page.evaluate(() => window.localStorage.setItem("markdoc:dashboardSort", "created"));
      await context.clearCookies({ name: "markdoc.dashboardSort" });
      await goHome(page);
      await expect(page.getByTestId("sort-select")).toHaveValue("created");
      await expect.poll(() => cardTitles(page)).toEqual(["Alpha", "Zulu", "Mike"]);
      await expect.poll(async () => (await context.cookies()).find((c) => c.name === "markdoc.dashboardSort")?.value).toBe("created");
    } finally {
      await context.close();
    }
  });

  test("storage badge only on GitHub-linked cards: none for local documents in the grid or the trash (#114)", async () => {
    const page = user.page;
    // Three local documents, no chips at all.
    await goHome(page);
    await expect(page.getByTestId("document-card")).toHaveCount(3);
    await expect(page.getByTestId("storage-badge")).toHaveCount(0);

    // Link Zulu to a fake repo (GITHUB_MOCK=1 in the e2e server): exactly one chip, reading "GitHub",
    // with the repo detail in its tooltip.
    const path = `docs/badge-${Date.now()}.md`;
    const seed = await page.request.post("/api/github/mock", { data: { kind: "repo", owner: "mock", repo: "scratch", branch: "main", path, content: "# Zulu\n\nOpened first.\n" } });
    expect(seed.ok()).toBeTruthy();
    const link = await page.request.post(`/api/documents/${idB}/link`, { data: { storage: "repo", owner: "mock", repo: "scratch", branch: "main", path } });
    expect(link.ok()).toBeTruthy();

    await goHome(page);
    const badges = page.getByTestId("storage-badge");
    await expect(badges).toHaveCount(1);
    await expect(badges).toHaveText("GitHub");
    await expect(badges).toHaveAttribute("data-storage", "repo");
    await expect(badges).toHaveAttribute("title", `mock/scratch: ${path}`);
    await expect(page.getByTestId("document-card").filter({ hasText: "Zulu" }).getByTestId("storage-badge")).toHaveCount(1);
    await expect(page.getByTestId("document-card").filter({ hasText: "Mike" }).getByTestId("storage-badge")).toHaveCount(0);

    // Phone width: the local card's title row has nothing next to the heading.
    await page.setViewportSize({ width: 390, height: 844 });
    const mikeRow = page.getByTestId("document-card").filter({ hasText: "Mike" }).getByRole("heading").locator("..");
    await expect(mikeRow.locator(":scope > *")).toHaveCount(1);
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Trash: a local document carries no chip there either.
    expect((await page.request.delete(`/api/documents/${idA}`)).ok()).toBeTruthy();
    await goHome(page);
    await page.getByTestId("filter-trash").click();
    await expect(page.getByTestId("trash-card")).toHaveCount(1);
    await expect(page.getByTestId("trash-card")).toContainText("Mike");
    await expect(page.getByTestId("trash-view").getByTestId("storage-badge")).toHaveCount(0);
    expect((await page.request.post(`/api/documents/${idA}/restore`)).ok()).toBeTruthy();
    await goHome(page);
    await expect(page.getByTestId("document-card")).toHaveCount(3);
  });
});

test.describe("card excerpt (#158)", () => {
  test("reads like the rendered text: image alt without the asset URL, link text without the href, table cells without pipes — cards and trash", async ({ browser }) => {
    const user = await signIn(browser, `excerpt-${Date.now().toString(36)}`);
    const { page } = user;
    const imageId = await createDocument(page, "# Dropped doc\n\nHello ![pixel](/api/assets/y7j816vpf1wvljmy) world.\n", "Dropped doc");
    await createDocument(
      page,
      "---\ntitle: HTML Title\n---\n\n# HTML Title\n\nPara **bold** [link](https://x.y)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
      "HTML Title",
    );
    await goHome(page);

    const cards = page.getByTestId("document-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Dropped doc" })).toContainText("Hello pixel world.");
    await expect(cards.filter({ hasText: "HTML Title" })).toContainText("Para bold link a b 1 2");
    for (const text of await cards.allTextContents()) {
      expect(text).not.toContain("(/api/assets/");
      expect(text).not.toContain("https://x.y");
      expect(text).not.toContain("|");
    }

    // The Trash card carries the same excerpt.
    expect((await page.request.delete(`/api/documents/${imageId}`)).ok()).toBeTruthy();
    await goHome(page);
    await page.getByTestId("filter-trash").click();
    const trashCard = page.getByTestId("trash-card");
    await expect(trashCard).toHaveCount(1);
    await expect(trashCard).toContainText("Hello pixel world.");
    expect(await trashCard.textContent()).not.toContain("(/api/assets/");
    await user.context.close();
  });
});
