import { test, expect } from "@playwright/test";
import { codeText, richText } from "./helpers";

/**
 * Browser smoke for a production build that is already running (see `npm run start:local`).
 *
 *   PROD_BASE_URL=http://localhost:3900 npx playwright test e2e/prod-smoke.spec.ts
 *
 * Skipped when PROD_BASE_URL is unset so the regular suite (which starts its own dev server on
 * :3100) is unaffected. The production server must have AUTH_DEV_LOGIN=force for the dev login.
 */
const base = process.env.PROD_BASE_URL?.replace(/\/$/, "");

test.describe("production build", () => {
  test.skip(!base, "PROD_BASE_URL not set");
  test.use({ baseURL: base ?? "http://localhost:3900" });

  test("dashboard, template document, typing in both panes over the collaboration socket", async ({ page }) => {
    const login = `prod-smoke-${Date.now().toString(36)}`;

    // Health says the collaboration server is attached to this process.
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, db: true, collab: true });

    // Development login (allowed in production only with AUTH_DEV_LOGIN=force).
    await page.goto("/login");
    await page.getByTestId("dev-login").fill(login);
    await page.getByTestId("dev-login-submit").click();
    await page.waitForURL((url) => url.pathname === "/");
    await page.waitForLoadState("networkidle");

    // Fresh user: the dashboard shows the template gallery; pick Meeting notes.
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.getByTestId("empty-state").getByTestId("template-meeting-notes").click();
    await page.waitForURL(/\/d\/[^/]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.getByTestId("title")).toHaveText("Meeting notes");
    await expect.poll(() => codeText(page)).toContain("## Action items");

    // Type one line in the rich pane; the code pane (Y.Text) must follow.
    await page.locator(".md-rich").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Typed in the rich pane on the production build.");
    await expect.poll(() => codeText(page)).toContain("Typed in the rich pane on the production build.");

    // Type one line in the code pane; the rich pane must follow.
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\nTyped in the code pane on the production build.\n");
    await expect.poll(() => richText(page)).toContain("Typed in the code pane on the production build.");

    // Edits went over the WebSocket and were persisted by the server.
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const id = page.url().match(/\/d\/([^/?#]+)/)![1];
    const content = await page.request.get(`/api/documents/${id}/content`);
    expect(content.status()).toBe(200);
    const text = await content.text();
    expect(text).toContain("Typed in the rich pane on the production build.");
    expect(text).toContain("Typed in the code pane on the production build.");
  });
});
