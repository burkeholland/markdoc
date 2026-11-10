import { test, expect } from "./fixtures";
import { createDocument, devLogin, expectExpandedTouchTarget, uniqueLogin, waitForHydration } from "./helpers";

for (const width of [1440, 390]) {
  for (const entry of ["main dashboard", "dashboard folder", "folder page"] as const) {
    test(`${entry} opens document Share in place at ${width}px without changing access`, async ({ browser }) => {
      const mobile = width === 390;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: mobile, isMobile: mobile });
      const page = await context.newPage();
      await devLogin(page, uniqueLogin(`entry-share-${width}`));
      const title = "Selected budget";
      await createDocument(page, "# Other document\n", "Other document");
      const id = await createDocument(page, "# Budget\n", title);
      const created = await page.request.post("/api/folders", { data: { name: "Planning" } });
      expect(created.ok()).toBeTruthy();
      const { folder } = await created.json() as { folder: { id: string } };
      expect((await page.request.post("/api/documents/move", { data: { documentIds: [id], folderId: folder.id } })).ok()).toBeTruthy();
      await page.goto(entry === "folder page" ? `/f/${folder.id}` : "/");
      await waitForHydration(page);
      if (entry === "dashboard folder") await page.locator(`[data-testid="folder-chip"][data-folder-id="${folder.id}"]`).click();
      if (entry !== "folder page") {
        if (entry === "main dashboard") await page.getByPlaceholder("Search documents", { exact: true }).fill("budget");
        await page.getByTestId("sort-select").selectOption("title");
      }
      const row = entry === "folder page"
        ? page.locator(`[data-testid="folder-document-row"][data-document-id="${id}"]`)
        : page.getByTestId("document-card").filter({ hasText: title }).locator("..");
      if (entry !== "folder page") await row.getByTestId("select-document").locator("..").click();
      const menu = row.getByTestId("document-menu");
      if (mobile) {
        await expect(menu).toHaveCSS("opacity", "1");
        if (entry === "folder page") {
          const box = await menu.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(44);
          expect(box!.height).toBeGreaterThanOrEqual(44);
        } else {
          await expectExpandedTouchTarget(menu, "document actions");
        }
      }
      const location = page.url();
      const permissionWrites: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET" && (path === `/api/documents/${id}` || path === `/api/documents/${id}/collaborators`)) permissionWrites.push(`${request.method()} ${path}`);
      });
      await page.route("**/api/github/users?*", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ users: [{ login: "octocat", name: null, avatarUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }], limited: false }),
      }));
      const openShare = async () => {
        await menu.click();
        await page.getByTestId("document-share").click();
        await expect(page.getByRole("dialog", { name: `Share “${title}”` })).toBeVisible();
        await expect(page.getByTestId("share-login")).toBeVisible();
      };
      await openShare();
      await page.getByTestId("share-login").fill("octo");
      await expect(page.getByTestId("share-login-option")).toHaveText("@octocat");
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(page.url()).toBe(location);
      await expect(page.getByTestId("editor-shell")).toHaveCount(0);
      if (entry !== "folder page") {
        await expect(page.getByPlaceholder("Search documents", { exact: true })).toHaveValue(entry === "main dashboard" ? "budget" : "");
        await expect(page.getByTestId("sort-select")).toHaveValue("title");
        await expect(row.getByTestId("select-document")).toBeChecked();
        if (entry === "dashboard folder") await expect(page.locator(`[data-testid="folder-chip"][data-folder-id="${folder.id}"]`)).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByTestId("filter-all")).toHaveAttribute("aria-pressed", "true");
      }
      await openShare();
      await expect(page.getByTestId("share-login")).toHaveValue("");
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      expect(permissionWrites).toEqual([]);
      const people = await page.request.get(`/api/documents/${id}/collaborators`);
      expect((await people.json()).collaborators).toEqual([]);
      await context.close();
    });
  }
}

test("a folder-link visitor cannot open document or folder sharing management", async ({ browser }) => {
  const owner = await browser.newContext();
  const page = await owner.newPage();
  await devLogin(page, uniqueLogin("entry-owner"));
  const id = await createDocument(page, "# Public folder fixture\n", "Public budget");
  const created = await page.request.post("/api/folders", { data: { name: "Visitor planning" } });
  const { folder } = await created.json() as { folder: { id: string } };
  expect((await page.request.post("/api/documents/move", { data: { documentIds: [id], folderId: folder.id } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/folders/${folder.id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto(`/f/${folder.id}`);
  await waitForHydration(visitor);
  await expect(visitor.getByRole("link", { name: "Public budget", exact: true })).toBeVisible();
  await expect(visitor.getByTestId("document-menu")).toHaveCount(0);
  await expect(visitor.getByTestId("folder-page-share")).toHaveCount(0);
  await anonymous.close();
  await owner.close();
});

for (const entry of ["main dashboard", "folder page"] as const) {
  test(`${entry} returns keyboard focus to the document actions trigger after metadata loads`, async ({ browser }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await devLogin(page, uniqueLogin("share-focus"));
    const id = await createDocument(page, "# Focus fixture\n", "Keyboard budget");
    const created = await page.request.post("/api/folders", { data: { name: "Keyboard planning" } });
    const { folder } = await created.json() as { folder: { id: string } };
    expect((await page.request.post("/api/documents/move", { data: { documentIds: [id], folderId: folder.id } })).ok()).toBeTruthy();
    await page.goto(entry === "folder page" ? `/f/${folder.id}` : "/");
    await waitForHydration(page);
    const row = entry === "folder page"
      ? page.locator(`[data-testid="folder-document-row"][data-document-id="${id}"]`)
      : page.getByTestId("document-card").filter({ hasText: "Keyboard budget" }).locator("..");
    const trigger = row.getByTestId("document-menu");
    let release!: () => void;
    const metadata = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/documents/${id}`, async (route) => {
      await metadata;
      await route.continue();
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("document-share").focus();
    await page.keyboard.press("Enter");
    const loading = page.getByRole("dialog", { name: "Share document “Keyboard budget”" });
    await expect(loading.getByRole("status")).toContainText("Loading document sharing");
    await loading.getByRole("button", { name: "Close", exact: true }).focus();
    release();
    const dialog = page.getByRole("dialog", { name: "Share “Keyboard budget”" });
    await expect(dialog.getByTestId("share-login")).toBeVisible();
    if (entry === "main dashboard") await dialog.screenshot({ path: testInfo.outputPath("document-share.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("editor-shell")).toHaveCount(0);
    await context.close();
  });
}
