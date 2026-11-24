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

test("homepage offers a next step after the features on phones", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const nextStep = page.locator('main a[href="/login"]').last();
  await expect(nextStep).toHaveText("Sign in with GitHub");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(nextStep).toBeInViewport();
});

for (const width of [761, 768, 1024, 1200, 1600]) {
  test(`homepage source illustration is readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1024 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const source = page.locator('section[aria-label^="Markdoc split editor"] [class*="__source"]');
    await expect(source).toBeVisible();
    await expect(source.locator(":scope > div")).toHaveCount(20);
    const dimensions = await source.evaluate((pane) => ({
      clientWidth: pane.clientWidth,
      scrollWidth: pane.scrollWidth,
    }));
    expect(dimensions.scrollWidth, "source lines fit inside the pane").toBeLessThanOrEqual(dimensions.clientWidth);
  });
}

for (const action of [
  { name: "primary CTA", width: 768, height: 1024, selector: 'main a[href="/login"]', index: 0, keyboard: false },
  { name: "phone header", width: 390, height: 844, selector: 'header a[href="/login"]', index: 0, keyboard: true },
  { name: "bottom CTA", width: 390, height: 844, selector: 'main a[href="/login"]', index: 1, keyboard: false },
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
      await page.getByRole("navigation", { name: "Explore Markdoc" }).getByRole("link", { name: "History" }).click();
      await expect(page).toHaveURL(/#history$/);
      await expect(page.getByRole("heading", { name: "Every version, kept." })).toBeInViewport();
    });
  }
}
