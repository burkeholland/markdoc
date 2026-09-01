import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument, shareWith, codeText, uniqueLogin, type User } from "./helpers";

async function goHome(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("filter-all")).toBeVisible();
}

test.describe("make a copy and trash", () => {
  let owner: User;
  let other: User;

  test.beforeAll(async ({ browser }) => {
    owner = await signIn(browser, uniqueLogin("trash-owner"));
    other = await signIn(browser, uniqueLogin("trash-other"));
  });

  test.afterAll(async () => {
    await owner.context.close();
    await other.context.close();
  });

  test("Make a copy from the header opens a new document titled 'Copy of …' with the same text", async () => {
    const page = owner.page;
    const docId = await createDocument(page, "# Recipe\n\nTwo eggs and a pinch of salt.\n", "Recipe");
    await openDocument(page, docId);

    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-duplicate").click();

    await page.waitForURL((url) => /^\/d\/[0-9a-z]+$/.test(url.pathname) && !url.pathname.endsWith(docId));
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("title")).toHaveText("Copy of Recipe");
    await expect(page.getByTestId("toast")).toContainText("Copy of Recipe");
    await expect.poll(() => codeText(page)).toContain("Two eggs and a pinch of salt.");

    await goHome(page);
    const titles = await page.getByTestId("document-card").getByRole("heading").allInnerTexts();
    expect(titles).toContain("Recipe");
    expect(titles).toContain("Copy of Recipe");
  });

  test("Move to trash → dashboard toast, gone from the list, visible under Trash; Restore; Delete forever", async () => {
    const page = owner.page;
    const docId = await createDocument(page, "# Disposable\n\nThrow me away.\n", "Disposable");
    await openDocument(page, docId);

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-delete").click();

    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByTestId("toast")).toContainText("moved to the trash");
    await expect(page.getByTestId("document-card").filter({ hasText: "Disposable" })).toHaveCount(0);

    // Trash view: the card is not a link into the editor, and explains the retention period.
    await page.getByTestId("filter-trash").click();
    await expect(page.getByTestId("trash-note")).toContainText("deleted forever after 30 days");
    const card = page.getByTestId("trash-card").filter({ hasText: "Disposable" });
    await expect(card).toHaveCount(1);
    await expect(card.locator("a")).toHaveCount(0);
    // The document cannot be opened while in the trash.
    const res = await page.request.get(`/api/documents/${docId}`);
    expect(res.status()).toBe(404);

    // Restore: back in the list.
    await card.getByTestId("restore-button").click();
    await expect(card).toHaveCount(0);
    await page.getByTestId("filter-all").click();
    await expect(page.getByTestId("document-card").filter({ hasText: "Disposable" })).toHaveCount(1);
    expect((await page.request.get(`/api/documents/${docId}`)).status()).toBe(200);

    // Trash again through the API, then Delete forever (confirm dialog).
    expect((await page.request.delete(`/api/documents/${docId}`)).ok()).toBeTruthy();
    await goHome(page);
    await page.getByTestId("filter-trash").click();
    const again = page.getByTestId("trash-card").filter({ hasText: "Disposable" });
    await expect(again).toHaveCount(1);
    page.once("dialog", (d) => d.accept());
    await again.getByTestId("purge-button").click();
    await expect(again).toHaveCount(0);
    expect((await page.request.get(`/api/documents/${docId}`)).status()).toBe(404);
    const trash = (await (await page.request.get("/api/documents?trash=1")).json()) as { documents: { id: string }[] };
    expect(trash.documents.map((d) => d.id)).not.toContain(docId);
  });

  test("a second browser with the document open is kicked to the dashboard when it is trashed", async () => {
    const docId = await createDocument(owner.page, "# Shared then trashed\n\nStill here.\n", "Shared then trashed");
    await shareWith(owner.page, docId, other.login, "editor");
    await openDocument(other.page, docId);
    await openDocument(owner.page, docId);
    await expect(other.page.getByTestId("presence").locator(".avatar")).toHaveCount(2);

    owner.page.once("dialog", (d) => d.accept());
    await owner.page.getByTestId("more-menu").click();
    await owner.page.getByTestId("menu-delete").click();

    await other.page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await expect(other.page.getByTestId("toast")).toContainText("This document was moved to the trash");
    await owner.page.waitForURL((url) => url.pathname === "/");
    await expect(owner.page.getByTestId("toast")).toContainText("moved to the trash");
  });
});
