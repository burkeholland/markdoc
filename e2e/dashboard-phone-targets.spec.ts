import { test, expect } from "./fixtures";
import { devices, type Browser, type BrowserContext } from "@playwright/test";
import { createDocument, devLogin, expectExpandedTouchTarget, uniqueLogin, waitForHydration } from "./helpers";

const PHONE = { ...devices["iPhone 13"], viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 };

async function signInOnPhone(browser: Browser, base: string) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await devLogin(page, uniqueLogin(base));
  await page.waitForLoadState("networkidle");
  return { context, page };
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

test("dashboard card and document filters have 44px targets at 375px", async ({ browser }) => {
  const { context, page } = await signInOnPhone(browser, "dashboard-phone-targets");
  try {
    await createDocument(page, "# Phone target card\n\nA card for the mobile dashboard.", "Phone target card");
    await page.goto("/");
    await waitForHydration(page);

    const card = page.getByTestId("document-card").filter({ hasText: "Phone target card" });
    const cardItem = card.locator("..");
    await expect(card).toBeVisible();
    await expectExpandedTouchTarget(cardItem.getByTestId("star-toggle"), "Star document");
    await expectExpandedTouchTarget(cardItem.getByTestId("document-menu"), "Document actions");

    for (const [filter, label] of [
      ["all", "All"],
      ["mine", "Owned by me"],
      ["shared", "Shared with me"],
      ["starred", "Starred"],
      ["trash", "Trash"],
    ] as const) {
      await expectExpandedTouchTarget(page.getByTestId(`filter-${filter}`), `${label} filter`);
    }
    await expectNoHorizontalOverflow(page);

    if (process.env.SHOT_DIR) {
      await cardItem.hover();
      await page.screenshot({ path: `${process.env.SHOT_DIR}/dashboard-phone.png`, scale: "css" });
    }
  } finally {
    await context.close();
  }
});

test("folder-sharing controls remain readable and tappable at 375px", async ({ browser }) => {
  const { context, page } = await signInOnPhone(browser, "folder-share-phone-targets");
  let recipientContext: BrowserContext | undefined;
  try {
    const recipientLogin = uniqueLogin("phone-recipient");
    recipientContext = await browser.newContext();
    const recipientPage = await recipientContext.newPage();
    await devLogin(recipientPage, recipientLogin);
    await recipientPage.waitForLoadState("networkidle");

    await page.goto("/");
    await waitForHydration(page);
    await page.getByTestId("new-folder").click();
    await page.getByTestId("folder-name-input").fill("Phone share");
    await page.getByTestId("folder-name-submit").click();
    const folderChip = page.getByTestId("folder-chip").filter({ hasText: "Phone share" });
    await expect(folderChip).toBeVisible();

    await page.getByTestId("folder-menu").click();
    await page.getByRole("menuitem", { name: "Share…" }).click();
    const dialog = page.getByTestId("folder-share-dialog");
    await expect(dialog).toBeVisible();

    const login = dialog.getByTestId("share-login");
    await login.fill(recipientLogin);
    const role = dialog.getByLabel("Role for new folder collaborator");
    await role.selectOption("commenter");
    const loginBox = await login.boundingBox();
    const roleBox = await role.boundingBox();
    const addBox = await dialog.getByTestId("folder-share-add").boundingBox();
    expect(loginBox).not.toBeNull();
    expect(roleBox).not.toBeNull();
    expect(addBox).not.toBeNull();
    expect(loginBox!.width).toBeGreaterThanOrEqual(200);
    expect(loginBox!.height).toBeGreaterThanOrEqual(44);
    expect(roleBox!.height).toBeGreaterThanOrEqual(44);
    expect(addBox!.height).toBeGreaterThanOrEqual(44);

    await dialog.getByTestId("folder-share-add").click();
    await expect(dialog.getByText(`@${recipientLogin}`)).toBeVisible();
    const savedRole = dialog.getByLabel(`Role for ${recipientLogin}`);
    const remove = dialog.getByRole("button", { name: `Remove ${recipientLogin}` });
    const savedRoleBox = await savedRole.boundingBox();
    expect(savedRoleBox).not.toBeNull();
    expect(savedRoleBox!.height).toBeGreaterThanOrEqual(44);
    await expectExpandedTouchTarget(remove, "Remove collaborator");
    await expectExpandedTouchTarget(page.getByRole("dialog").getByRole("button", { name: "Close" }), "Close share dialog");

    const doneBox = await dialog.getByRole("button", { name: "Done" }).boundingBox();
    expect(doneBox).not.toBeNull();
    expect(doneBox!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page);

    if (process.env.SHOT_DIR) {
      await page.getByRole("dialog").screenshot({ path: `${process.env.SHOT_DIR}/folder-share-phone.png`, scale: "css" });
    }
  } finally {
    await recipientContext?.close();
    await context.close();
  }
});
