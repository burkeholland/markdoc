import { test, expect } from "./fixtures";
import { devices, type Browser, type Locator, type Page } from "@playwright/test";
import { createDocument, cssPx, devLogin, uniqueLogin, waitForEditor } from "./helpers";

const viewports = [
  { width: 360, height: 780 },
  { width: 393, height: 851 },
] as const;

async function signInOnPhone(browser: Browser, viewport: (typeof viewports)[number]) {
  const context = await browser.newContext({ ...devices["iPhone 13"], viewport });
  const page = await context.newPage();
  await devLogin(page, uniqueLogin(`editor-targets-${viewport.width}`));
  await page.waitForLoadState("networkidle");
  return { context, page };
}

async function saveNamed(page: Page, documentId: string, content: string, message: string) {
  const response = await page.request.put(`/api/documents/${documentId}/content`, { data: { content, message } });
  expect(response.ok()).toBeTruthy();
}

async function expectMinimumTarget(locator: Locator) {
  const box = (await locator.boundingBox())!;
  expect(cssPx(box.width)).toBeGreaterThanOrEqual(24);
  expect(cssPx(box.height)).toBeGreaterThanOrEqual(24);
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => {
    const root = document.scrollingElement!;
    return { scroll: root.scrollWidth, client: root.clientWidth };
  });
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

for (const viewport of viewports) {
  test(`version compare and comment Reply have phone targets at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { context, page } = await signInOnPhone(browser, viewport);
    const documentId = await createDocument(page, "# Phone targets\n\nInitial body.\n", "Phone targets");
    await saveNamed(page, documentId, "# Phone targets\n\nFirst body.\n", "First");
    await saveNamed(page, documentId, "# Phone targets\n\nSecond body.\n", "Second");
    const comment = await page.request.post(`/api/documents/${documentId}/comments`, {
      data: { action: "add", quote: "Second body.", body: "Please clarify this." },
    });
    expect(comment.ok()).toBeTruthy();
    await page.goto(`/d/${documentId}`);
    await waitForEditor(page);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const versionPanel = page.getByTestId("versions-panel");
    await expect(versionPanel).toBeVisible();
    const firstRow = versionPanel.getByTestId("version-item").filter({ hasText: "First" });
    const secondRow = versionPanel.getByTestId("version-item").filter({ hasText: "Second" });
    const firstTarget = firstRow.getByTestId("version-compare-target");
    const secondTarget = secondRow.getByTestId("version-compare-target");
    await expectMinimumTarget(firstTarget);
    await expectMinimumTarget(secondTarget);
    await firstTarget.click();
    await expect(firstRow.getByTestId("version-compare")).toBeChecked();
    await expect(secondRow.getByTestId("version-compare")).not.toBeChecked();
    await secondTarget.click();
    await expect(firstRow.getByTestId("version-compare")).toBeChecked();
    await expect(secondRow.getByTestId("version-compare")).toBeChecked();
    await expect(page.getByTestId("version-diff")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "Close version history" }).click();
    await page.getByTestId("comments-toggle").click();
    const reply = page.locator('button[data-testid="comment-reply"]');
    await expect(reply).toBeVisible();
    await expectMinimumTarget(reply);
    await reply.click();
    await expect(page.getByPlaceholder("Reply…")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await context.close();
  });
}
