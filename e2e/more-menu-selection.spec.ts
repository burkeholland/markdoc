import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";

test.use({ trace: "off", screenshot: "off", video: "off" });

function isLoopbackUrl(url: string | URL) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

async function blockNonLoopbackTraffic(context: BrowserContext) {
  await context.route(/^https?:\/\//, async (route) => {
    if (isLoopbackUrl(route.request().url())) await route.continue();
    else await route.abort();
  });
  await context.routeWebSocket((url) => !isLoopbackUrl(url), (webSocket) => webSocket.close());
}

test("a trusted More-menu selection closes the menu and opens Version history", async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  await blockNonLoopbackTraffic(context);
  const page = await context.newPage();
  try {
    await devLogin(page, uniqueLogin("more-menu-selection"));
    await page.waitForLoadState("networkidle");
    const id = await createDocument(page, "# Browser selection\n");
    await openDocument(page, id);

    await page.getByTestId("more-menu").click();
    const menu = page.getByRole("menu");
    const history = page.getByRole("menuitem", { name: "Version history" });
    await expect(history).toBeVisible();
    await expect(history).toBeEnabled();
    await history.click();

    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("versions-panel")).toBeVisible();
    await expect(page.getByTestId("versions-panel")).toHaveCount(1);
  } finally {
    await context.close();
  }
});
