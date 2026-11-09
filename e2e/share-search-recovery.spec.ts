import { test, expect } from "./fixtures";
import { createDocument, openDocument, signIn, uniqueLogin, waitForHydration } from "./helpers";

// Provider-level incomplete_results and response caching are covered by the route tests.
// These isolated browser fixtures exercise the resulting failure/recovery UX at both entry points.
for (const target of ["document", "folder"] as const) {
  test(`${target} Share search: pending, incomplete failure, Retry, reopen, and exact-handle Add`, async ({ browser }) => {
    const { page } = await signIn(browser, uniqueLogin(`search-${target}`));
    let collaboratorsPath: string;
    if (target === "document") {
      const id = await createDocument(page, "# Search recovery\n", "Search recovery");
      collaboratorsPath = `/api/documents/${id}/collaborators`;
      await openDocument(page, id);
      await page.setViewportSize({ width: 720, height: 1000 });
    } else {
      const res = await page.request.post("/api/folders", { data: { name: "Search recovery" } });
      expect(res.ok()).toBeTruthy();
      const { folder } = await res.json() as { folder: { id: string } };
      collaboratorsPath = `/api/folders/${folder.id}/collaborators`;
      await page.reload();
      await waitForHydration(page);
      await expect(page.getByTestId("folder-chip")).toBeVisible();
    }

    const openShare = async () => {
      if (target === "document") {
        await page.getByTestId("more-menu").click();
        await page.getByTestId("menu-share").click();
      } else {
        await page.getByTestId("folder-menu").click();
        await page.getByRole("menuitem", { name: "Share…" }).click();
      }
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByTestId("share-login")).toBeVisible();
    };

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const queries: string[] = [];
    await page.route("**/api/github/users?*", async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q")!;
      queries.push(q);
      if (queries.length === 1) {
        await pending;
        await route.fulfill({
          status: 503,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({ error: "GitHub account search did not finish. Please try again." }),
        });
      } else if (q === "octocat") {
        await route.fulfill({
          status: 200,
          headers: { "Cache-Control": "no-store" },
          contentType: "application/json",
          body: JSON.stringify({ users: [], limited: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ users: [{ login: "octocat", name: null, avatarUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }], limited: false }),
        });
      }
    });

    await openShare();
    const input = page.getByTestId("share-login");
    await input.pressSequentially("octo", { delay: 50 });
    await expect.poll(() => queries.length).toBe(1);
    await expect(page.getByTestId("share-login-loading")).toContainText("@octo");
    await expect(page.getByTestId("share-login-suggestions")).toHaveCount(0);
    await expect(page.getByTestId(target === "document" ? "share-add" : "folder-share-add")).toBeEnabled();
    release();
    await expect(page.getByTestId("share-login-error")).toContainText("GitHub account search did not finish");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByTestId("share-login-option")).toHaveText("@octocat");
    expect(queries).toEqual(["octo", "octo"]);

    await input.fill("octoc");
    await expect.poll(() => queries.length).toBe(3);
    await expect(page.getByTestId("share-login-option")).toHaveText("@octocat");
    await input.fill("");
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openShare();
    await input.fill("octo");
    await expect(input).toBeFocused();
    await expect.poll(() => queries.length).toBe(4);
    await expect(page.getByTestId("share-login-option")).toHaveText("@octocat");

    // Even when suggestions are unavailable, exact Add still uses the real local demo API.
    await input.fill("octocat");
    await expect(page.getByTestId("share-login-error")).toContainText("temporarily unavailable");
    const added = page.waitForResponse((response) =>
      new URL(response.url()).pathname === collaboratorsPath && response.request().method() === "POST",
    );
    await page.getByTestId(target === "document" ? "share-add" : "folder-share-add").click();
    expect((await added).status()).toBe(202);
    await expect(input).toHaveValue("");
    const people = await page.request.get(collaboratorsPath);
    expect((await people.json() as { collaborators: { login: string }[] }).collaborators.map((person) => person.login)).toEqual(["octocat"]);
  });
}
