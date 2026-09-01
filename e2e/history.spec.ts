import { test, expect } from "./fixtures";
import { signIn, createDocument, openDocument, codeText, focusCodeEnd } from "./helpers";

test.describe("version history", () => {
  test("named versions, diff view and restore", async ({ browser }) => {
    const user = await signIn(browser, "vera");
    const { page } = user;
    const id = await createDocument(page, "# Versions\n\nOriginal text.\n");
    await openDocument(page, id);

    // Name the current state.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Name current version" }).click();
    await page.getByTestId("version-name").fill("Draft one");
    await page.getByTestId("version-name-submit").click();
    await expect(page.getByTestId("toast")).toContainText("Saved version");

    // Change the document.
    await focusCodeEnd(page);
    await page.keyboard.type("\n\nAdded later.");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

    // Open history, pick the named version, see a diff, restore it.
    await page.getByTestId("more-menu").click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    const named = page.getByTestId("version-item").filter({ hasText: "Draft one" });
    await expect(named).toBeVisible();
    await named.click();
    await expect(page.getByTestId("version-diff")).toBeVisible();
    await expect(page.locator(".md-diff ins")).toContainText("Added later.");

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("version-restore").click();
    await expect(page.getByTestId("version-diff")).toBeHidden();
    await expect.poll(() => codeText(page)).not.toContain("Added later.");
    await expect.poll(() => codeText(page)).toContain("Original text.");

    // The restore itself is recorded, and the pre-restore state was kept.
    await expect(page.getByTestId("version-item").filter({ hasText: "Restored version" })).toBeVisible();
    await expect(page.getByTestId("version-item").filter({ hasText: "Before restore" })).toBeVisible();
    await user.context.close();
  });
});

test.describe("sharing dialog", () => {
  test("owner adds a collaborator and changes link access", async ({ browser }) => {
    const user = await signIn(browser, "owner");
    const { page } = user;
    const id = await createDocument(page, "# Share me\n");
    await openDocument(page, id);
    await page.getByTestId("share-button").click();
    await page.getByTestId("share-login").fill("@friend");
    await page.getByTestId("share-role").selectOption("commenter");
    await page.getByTestId("share-add").click();
    await expect(page.getByTestId("collaborator-row")).toContainText("@friend");
    await page.getByTestId("link-access").selectOption("view");
    await expect.poll(async () => (await (await page.request.get(`/api/documents/${id}`)).json()).document.linkAccess).toBe("view");

    // Anyone with the link can now view; signed-out visitors are sent to the reader view.
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`/d/${id}`);
    await expect(anonPage).toHaveURL(new RegExp(`/p/${id}$`));
    await expect(anonPage.getByTestId("reader-body").locator("h1")).toHaveText("Share me");
    await anon.close();
    await user.context.close();
  });
});
