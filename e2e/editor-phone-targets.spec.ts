import { test, expect } from "./fixtures";
import { devices, type Browser, type Locator, type Page } from "@playwright/test";
import { createDocument, cssPx, devLogin, expectExpandedTouchTarget, uniqueLogin, waitForEditor } from "./helpers";

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

test("mobile editor header controls have 44px touch targets without visible clutter", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await devLogin(page, uniqueLogin("editor-header-targets"));
  await page.waitForLoadState("networkidle");
  const documentId = await createDocument(page, "# Mobile header targets\n\nTouch target regression.", "Mobile");
  await page.goto(`/d/${documentId}`);
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

  const toolbar = page.getByTestId("toolbar");
  for (const [label, locator] of [
    ["Bold", page.getByTestId("tb-bold")],
    ["Bulleted list", page.getByTestId("tb-bullet")],
    ["Table", page.getByTestId("tb-table")],
  ] as const) {
    await expectExpandedTouchTarget(locator, label);
  }
  await toolbar.evaluate((element) => {
    element.scrollLeft = 0;
  });
  if (process.env.SHOT_DIR) {
    await toolbar.screenshot({ path: `${process.env.SHOT_DIR}/editor-toolbar-phone.png`, scale: "css" });
  }

  const header = page.getByTestId("header");
  const navigation = header.locator('[data-testid="outline-button"]:visible, a[aria-label="Back to documents"]:visible').first();
  const controls: { label: string; locator: Locator }[] = [
    { label: "Navigation", locator: navigation },
    { label: "Save document", locator: header.getByTestId("save-state").getByRole("button", { name: "Save document" }) },
    { label: "Preview pane", locator: header.getByTestId("layout-segment-rich") },
    { label: "Markdown pane", locator: header.getByTestId("layout-segment-code") },
    { label: "Notifications", locator: header.getByTestId("notifications-bell") },
    { label: "Comments", locator: header.getByTestId("comments-toggle") },
    { label: "More", locator: header.getByTestId("more-menu") },
  ];
  for (const { label, locator } of controls) await expectExpandedTouchTarget(locator, label);
  const titleBox = (await header.getByTestId("title").boundingBox())!;
  expect(cssPx(titleBox.height)).toBeGreaterThanOrEqual(44);
  const titleTextBox = (await header.getByTestId("title-text").boundingBox())!;
  expect(cssPx(titleTextBox.height)).toBeLessThanOrEqual(20);

  const unchangedSizes = [
    { locator: navigation, width: 36, height: 36 },
    { locator: header.getByTestId("layout-segment-rich"), width: 32, height: 32 },
    { locator: header.getByTestId("layout-segment-code"), width: 32, height: 32 },
    { locator: header.getByTestId("notifications-bell"), width: 36, height: 36 },
    { locator: header.getByTestId("comments-toggle"), width: 36, height: 36 },
    { locator: header.getByTestId("more-menu"), width: 36, height: 36 },
  ];
  for (const { locator, width, height } of unchangedSizes) {
    const box = (await locator.boundingBox())!;
    expect(cssPx(box.width)).toBe(width);
    expect(cssPx(box.height)).toBe(height);
  }
  const headerBox = await header.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(cssPx(headerBox!.height)).toBe(57);

  await header.getByTestId("title").click();
  const titleInput = page.getByTestId("title-input");
  await expect(titleInput).toBeVisible();
  const titleInputBox = (await titleInput.boundingBox())!;
  expect(cssPx(titleInputBox.height)).toBeGreaterThanOrEqual(44);
  await page.keyboard.press("Escape");

  await page.screenshot({
    path: testInfo.outputPath("editor-header-mobile-after.png"),
    scale: "css",
  });
  await header.getByTestId("notifications-bell").click();
  await expect(page.getByTestId("notifications-popover")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await context.close();
});

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
