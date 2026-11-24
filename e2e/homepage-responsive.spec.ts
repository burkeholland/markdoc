import { test, expect } from "./fixtures";
import { cssPx, waitForHydration } from "./helpers";
import AxeBuilder from "@axe-core/playwright";

test("homepage exposes its header as a banner landmark separate from main", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("banner").locator('a[href="/login"]')).toBeVisible();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
]) {
  test(`homepage header sign-in target is at least 44px tall at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const signIn = page.locator('header.app-header a[href="/login"]');
    await expect(signIn).toBeVisible();
    const box = await signIn.boundingBox();
    expect(box).not.toBeNull();
    expect(cssPx(box!.height)).toBeGreaterThanOrEqual(44);
  });
}

for (const viewport of [
  { width: 720, height: 430 },
  { width: 600, height: 400 },
  { width: 844, height: 390 },
]) {
  test(`homepage primary CTA fits in the ${viewport.width}x${viewport.height} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const getStarted = page.locator('main a[href="/login"]').first();
    await expect(getStarted).toBeVisible();
    const box = await getStarted.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height, "primary CTA bottom stays within the viewport").toBeLessThanOrEqual(viewport.height);
  });
}

test("homepage sign-in action stays on one line beside the wordmark at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");

  const header = page.locator("header.app-header");
  const signIn = header.locator('a[href="/login"]');
  await expect(signIn).toBeVisible();

  const label = await signIn.evaluate((link) => {
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    const lines = new Set<number>();
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.textContent?.trim() || !node.parentElement || getComputedStyle(node.parentElement).display === "none") continue;
      text += node.textContent;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
    }
    return { text: text.replace(/\s+/g, " ").trim(), lines: lines.size };
  });
  expect(label.lines, "sign-in label renders on one line").toBe(1);
  expect(label.text, "phone label is compact").toBe("Sign in");

  const brandBox = await header.locator(".wordmark").boundingBox();
  const signInBox = await signIn.boundingBox();
  expect(brandBox).not.toBeNull();
  expect(signInBox).not.toBeNull();
  expect(signInBox!.x - brandBox!.x - brandBox!.width, "wordmark and sign-in action have separation").toBeGreaterThanOrEqual(8);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopLabel = await signIn.evaluate((link) => (link as HTMLElement).innerText.replace(/\s+/g, " ").trim());
  expect(desktopLabel, "desktop label keeps the GitHub detail").toBe("Sign in with GitHub");
});

test("homepage ends with a minimal footer after the product preview", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.locator("main > section")).toHaveCount(2);
  await expect(page.locator("main > :last-child")).toHaveAttribute("aria-label", /^Markdoc split editor/);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "GitHub" })).toBeInViewport();
});

for (const action of [
  { name: "primary CTA", width: 768, height: 1024, selector: 'main a[href="/login"]', index: 0, keyboard: false },
  { name: "phone header", width: 390, height: 844, selector: 'header a[href="/login"]', index: 0, keyboard: true },
]) {
  test(`${action.name} shows pending feedback until sign-in opens`, async ({ page }) => {
    await page.setViewportSize({ width: action.width, height: action.height });
    await page.goto("/");
    // A click before hydration is a plain link, with no pending state to show.
    await waitForHydration(page);
    const link = page.locator(action.selector).nth(action.index);
    const status = link.getByRole("status");
    await expect(status).toBeEmpty();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/login**", async (route) => {
      await blocked;
      await route.continue();
    });

    try {
      if (action.keyboard) {
        await link.focus();
        await page.keyboard.press("Enter");
      } else {
        await link.click();
      }

      await expect(status).toHaveText("Opening sign-in…");
      await expect(link.locator('[aria-hidden="true"]', { hasText: "Opening sign-in…" })).toBeVisible();
      await expect(page).toHaveURL("/");
    } finally {
      release();
    }

    await expect(page).toHaveURL(/\/login/);
    await page.goBack();
    await expect(status).toBeEmpty();
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 390, 844, 1600]) {
    test(`product-first homepage fits ${width}px in ${theme} mode`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Markdown,together.");
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        shot: document.querySelector('section[aria-label^="Markdoc split editor"]')!.getBoundingClientRect().width,
      }));
      expect(dimensions.content, "page has no horizontal scrolling").toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.shot, "product preview uses the full window width").toBe(dimensions.viewport);
      if (width === 390 || width === 1600) {
        const accessibility = await new AxeBuilder({ page }).analyze();
        expect(accessibility.violations).toEqual([]);
      }
    });
  }
}

for (const dpr of [1, 2]) {
  test.describe(`display type at ${dpr}x DPR`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const width of [390, 1600]) {
      test(`uses upright letterforms at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto("/");
        await page.evaluate(() => document.fonts.ready);
        for (const selector of [".wordmark", "h1", '[class*="editorTitle"]', '[class*="documentTitle"]', '[class*="documentHeading"]']) {
          for (const heading of await page.locator(selector).all()) {
            await expect(heading).toHaveCSS("font-variation-settings", /"WONK" 0/);
          }
        }
        const title = page.locator('[class*="documentTitle"]');
        const upright = await title.screenshot();
        await title.evaluate(el => { el.style.fontVariationSettings = '"WONK" 1'; });
        const leaning = await title.screenshot();
        expect(upright.equals(leaning), "the loaded font must support disabling its leaning glyph substitutions").toBe(false);
      });
    }
  });
}
