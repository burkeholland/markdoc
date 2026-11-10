import { test, expect } from "./fixtures";
import { createDocument, signIn, uniqueLogin, waitForHydration } from "./helpers";

test("folder links disclose stronger document grants before saving, preserve them afterward, and revoke only inherited access", async ({ browser }, testInfo) => {
  const owner = await signIn(browser, uniqueLogin("folder-owner"));
  const reader = await signIn(browser, uniqueLogin("folder-reader"));
  const page = owner.page;
  const documentId = await createDocument(page, "# Budget\n", "Budget");
  const created = await page.request.post("/api/folders", { data: { name: "Shared planning" } });
  expect(created.ok()).toBeTruthy();
  const { folder } = await created.json() as { folder: { id: string } };
  expect((await page.request.post("/api/documents/move", { data: { documentIds: [documentId], folderId: folder.id } })).ok()).toBeTruthy();
  expect((await page.request.post(`/api/documents/${documentId}/collaborators`, { data: { login: reader.login, role: "editor" } })).ok()).toBeTruthy();
  await page.goto(`/f/${folder.id}?share=1`);
  const dialog = page.getByRole("dialog", { name: "Share folder “Shared planning”" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("folder-share-warning")).toContainText("added or moved into it later");
  await dialog.getByRole("combobox", { name: "Role for new folder collaborator" }).selectOption("viewer");
  await dialog.getByTestId("share-login").fill(reader.login);
  await expect(dialog.getByTestId("folder-access-exceptions")).toContainText("Edit on Budget via direct document grant");
  await dialog.getByTestId("folder-share-add").click();
  await expect(dialog.getByTestId("share-login")).toHaveValue("");
  await expect(dialog.getByTestId("folder-access-exceptions")).toContainText(`Folder grant: View for @${reader.login}`);
  await dialog.getByTestId("folder-link-access").selectOption("comment");
  await expect.poll(async () => (await (await page.request.get(`/api/folders/${folder.id}`)).json()).folder.linkAccess).toBe("comment");
  await dialog.screenshot({ path: testInfo.outputPath("folder-share-exceptions.png") });

  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto(`/f/${folder.id}`);
  await expect(visitor.getByRole("heading", { name: "Shared planning" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Budget", exact: true })).toBeVisible();
  expect((await (await visitor.request.get(`/api/documents/${documentId}`)).json()).role).toBe("viewer");
  expect((await (await reader.page.request.get(`/api/documents/${documentId}`)).json()).role).toBe("editor");

  await dialog.getByTestId("folder-link-access").selectOption("private");
  await expect.poll(async () => (await (await page.request.get(`/api/folders/${folder.id}`)).json()).folder.linkAccess).toBe("private");
  expect((await visitor.request.get(`/api/documents/${documentId}`)).status()).toBe(401);
  expect((await (await reader.page.request.get(`/api/documents/${documentId}`)).json()).role).toBe("editor");
  expect((await page.request.post("/api/documents/move", { data: { documentIds: [documentId], folderId: null } })).ok()).toBeTruthy();
  expect((await (await reader.page.request.get(`/api/documents/${documentId}`)).json()).role).toBe("editor");
});

for (const resource of ["document", "folder"] as const) {
  test(`${resource} access-request notification opens the named Share pane and survives sign-in without granting access`, async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin(`request-${resource}`));
    const requester = await signIn(browser, uniqueLogin(`ask-${resource}`));
    const title = resource === "document" ? "Requested document" : "Requested folder";
    let id: string;
    if (resource === "document") {
      id = await createDocument(owner.page, "# Requested\n", title);
    } else {
      const response = await owner.page.request.post("/api/folders", { data: { name: title } });
      expect(response.ok()).toBeTruthy();
      id = ((await response.json()) as { folder: { id: string } }).folder.id;
    }
    const apiPath = `/api/${resource === "document" ? "documents" : "folders"}/${id}`;
    expect((await requester.page.request.post(`${apiPath}/access-request`)).status()).toBe(202);
    await owner.page.goto("/");
    await waitForHydration(owner.page);
    const row = owner.page.getByTestId("notifications-strip").getByTestId("notification-item").filter({ hasText: title });
    await expect(row).toContainText(`requested access to ${resource}`);
    await row.getByTestId("notification-open").click();
    const dialogName = `Share ${resource} “${title}”`;
    await expect(owner.page.getByRole("dialog", { name: dialogName })).toBeVisible();
    expect(new URL(owner.page.url()).pathname).toBe(`/${resource === "document" ? "d" : "f"}/${id}`);
    expect((await requester.page.request.get(apiPath)).status()).toBe(404);
    if (resource === "folder") await expect(owner.page.getByTestId("folder-share-warning")).toContainText("every document");

    const notifications = await owner.page.request.get("/api/notifications?kind=access.request");
    const request = ((await notifications.json()) as { items: { id: string }[] }).items[0];
    const path = `/${resource === "document" ? "d" : "f"}/${id}?accessRequest=${requester.login}&notification=${request.id}`;
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto(path);
    await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === path);
    await waitForHydration(page);
    await page.getByTestId("dev-login").fill(owner.login);
    await page.getByTestId("dev-login-submit").click();
    await expect(page.getByRole("dialog", { name: dialogName })).toBeVisible();
    expect((await requester.page.request.get(apiPath)).status()).toBe(404);
    if (resource === "document") {
      await page.getByTestId("access-request-grant").click();
    } else {
      await expect(page.getByTestId("folder-access-request")).toContainText(requester.login);
      await page.getByTestId("folder-share-add").click();
    }
    await expect.poll(async () => (await requester.page.request.get(apiPath)).status()).toBe(200);
  });
}

test("public folder sign-in preserves the exact Share request without granting access", async ({ browser }) => {
  const owner = await signIn(browser, uniqueLogin("public-request-owner"));
  const requester = await signIn(browser, uniqueLogin("public-request-reader"));
  const created = await owner.page.request.post("/api/folders", { data: { name: "Public requested folder" } });
  expect(created.ok()).toBeTruthy();
  const { folder } = await created.json() as { folder: { id: string } };
  const documentId = await createDocument(owner.page, "# Public request fixture\n", "Request budget");
  expect((await owner.page.request.post("/api/documents/move", { data: { documentIds: [documentId], folderId: folder.id } })).ok()).toBeTruthy();
  const apiPath = `/api/folders/${folder.id}`;
  expect((await requester.page.request.post(`${apiPath}/access-request`)).status()).toBe(202);
  const notifications = await owner.page.request.get("/api/notifications?kind=access.request");
  const request = ((await notifications.json()) as { items: { id: string; folderId: string }[] }).items.find((item) => item.folderId === folder.id)!;
  expect(request).toBeTruthy();
  expect((await owner.page.request.patch(apiPath, { data: { linkAccess: "view" } })).ok()).toBeTruthy();

  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  const path = `/f/${folder.id}?share=1&accessRequest=${requester.login}&notification=${request.id}`;
  const response = await page.goto(`${path}&redirect=https%3A%2F%2Funtrusted.example`);
  expect(response?.status()).toBe(200);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: "Public requested folder" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("folder-page-share")).toHaveCount(0);
  expect((await (await page.request.get(`/api/documents/${documentId}`)).json()).role).toBe("viewer");
  const signInLink = page.getByRole("link", { name: "Sign in to comment or edit when allowed" });
  await expect(signInLink).toHaveAttribute("href", `/login?next=${encodeURIComponent(path)}`);
  const permissionWrites: string[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url()).pathname;
    if (request.method() !== "GET" && (target === apiPath || target === `${apiPath}/collaborators`)) permissionWrites.push(`${request.method()} ${target}`);
  });
  await signInLink.click();
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("next") === path);
  await waitForHydration(page);
  await page.getByTestId("dev-login").fill(owner.login);
  await page.getByTestId("dev-login-submit").click();
  const dialog = page.getByRole("dialog", { name: "Share folder “Public requested folder”" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === path);
  await expect(dialog.getByTestId("folder-access-request")).toContainText(`@${requester.login} requested access to this folder`);
  await expect(dialog.getByTestId("share-login")).toHaveValue(requester.login);
  await expect(dialog.getByRole("combobox", { name: "Role for new folder collaborator" })).toHaveValue("viewer");
  await expect(dialog.getByTestId("folder-share-warning")).toContainText("added or moved into it later");
  await expect(dialog.getByTestId("folder-share-add")).toBeEnabled();
  expect(permissionWrites).toEqual([]);
  expect((await (await owner.page.request.get(`${apiPath}/collaborators`)).json()).collaborators).toEqual([]);
  const unchanged = await owner.page.request.get("/api/notifications?kind=access.request");
  expect(((await unchanged.json()) as { items: { id: string; readAt: string | null }[] }).items.find((item) => item.id === request.id)?.readAt).toBeNull();
});

test("direct folder request dismissal retains a retryable banner until the notification write succeeds", async ({ browser }, testInfo) => {
  const owner = await signIn(browser, uniqueLogin("dismiss-owner"));
  const requester = await signIn(browser, uniqueLogin("dismiss-reader"));
  const page = owner.page;
  const response = await page.request.post("/api/folders", { data: { name: "Requested planning" } });
  expect(response.ok()).toBeTruthy();
  const { folder } = await response.json() as { folder: { id: string } };
  const apiPath = `/api/folders/${folder.id}`;
  expect((await requester.page.request.post(`${apiPath}/access-request`)).status()).toBe(202);
  const notifications = await page.request.get("/api/notifications?kind=access.request");
  const request = ((await notifications.json()) as { items: { id: string; folderId: string }[] }).items.find((item) => item.folderId === folder.id)!;
  expect(request).toBeTruthy();
  let attempts = 0;
  await page.route(`**/api/notifications/${request.id}/read`, async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Write unavailable" }) });
    else await route.continue();
  });
  const permissionWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && new URL(request.url()).pathname === `${apiPath}/collaborators`) permissionWrites.push(request.method());
  });
  await page.goto(`/f/${folder.id}?accessRequest=${requester.login}&notification=${request.id}`);
  const dialog = page.getByRole("dialog", { name: "Share folder “Requested planning”" });
  const banner = dialog.getByTestId("folder-access-request");
  await banner.getByRole("button", { name: "Dismiss request" }).click();
  await expect(banner.getByRole("alert")).toHaveText("Could not dismiss this request. Try again.");
  await expect(banner).toContainText(requester.login);
  await expect(dialog.getByTestId("folder-share-warning")).toContainText("every document");
  const unread = await page.request.get("/api/notifications?kind=access.request");
  expect(((await unread.json()) as { items: { id: string; readAt: string | null }[] }).items.find((item) => item.id === request.id)?.readAt).toBeNull();
  await dialog.screenshot({ path: testInfo.outputPath("folder-request-retry.png") });
  await banner.getByRole("button", { name: "Retry dismissal" }).click();
  await expect(banner).toHaveCount(0);
  expect(attempts).toBe(2);
  const read = await page.request.get("/api/notifications?kind=access.request");
  expect(((await read.json()) as { items: { id: string; readAt: string | null }[] }).items.find((item) => item.id === request.id)?.readAt).toBeTruthy();
  expect((await requester.page.request.get(apiPath)).status()).toBe(404);
  expect((await (await page.request.get(`${apiPath}/collaborators`)).json()).collaborators).toEqual([]);
  expect(permissionWrites).toEqual([]);
});
