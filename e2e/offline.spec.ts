import { test, expect } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, richText, focusCodeEnd, reloadHydrated, type User } from "./helpers";

/**
 * Offline resilience. `context.setOffline(true)` is used while typing (real offline
 * emulation), but a reload needs the Next dev server, which offline emulation also
 * blocks. For the reload step the collaboration WebSocket alone is blocked via
 * `page.routeWebSocket`, which is what the spec asks for in that case.
 */

/**
 * Chromium's offline emulation only affects new connections; an established WebSocket
 * stays open until the server's ping times out. Drop the live socket first so the
 * provider notices immediately, the way a real network drop would surface.
 */
async function goOffline(page: Page, context: BrowserContext) {
  await page.evaluate(() => {
    type Win = { __markdocSession: { provider: { configuration: { websocketProvider: { webSocket: WebSocket | null } } } } };
    (window as unknown as Win).__markdocSession.provider.configuration.websocketProvider.webSocket?.close();
  });
  await context.setOffline(true);
}

test.describe("offline resilience", () => {
  let alice: User;
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
    docId = await createDocument(alice.page, "# Offline doc\n\nStart.\n");
  });

  test.afterAll(async () => {
    await alice.context.close();
  });

  test("edits made offline survive a reload and sync once the connection is back", async ({ browser }) => {
    const { page, context } = alice;
    const saveState = page.getByTestId("save-state");

    // Installed before going offline so it also applies to sockets opened after the reload.
    let blockCollab = false;
    await page.routeWebSocket(/\/collab/, (ws) => {
      if (blockCollab) {
        ws.close({ code: 1006, reason: "offline (e2e)" });
        return;
      }
      ws.connectToServer();
    });

    await openDocument(page, docId);
    await focusCodeEnd(page);
    await page.keyboard.type("First sentence typed online.");
    await expect.poll(() => codeText(page)).toContain("First sentence typed online.");
    await expect(saveState).toHaveAttribute("data-state", "saved");

    // Go offline; the live socket drops and reconnect attempts fail.
    blockCollab = true;
    await goOffline(page, context);
    await expect(saveState).toHaveAttribute("data-state", /offline|reconnecting/);

    await page.keyboard.type(" Second sentence typed offline.");
    await expect.poll(() => codeText(page)).toContain("Second sentence typed offline.");
    await expect(saveState).toHaveText(/Offline — \d+ unsaved change/);
    const unsynced = Number(await saveState.getAttribute("data-unsynced"));
    expect(unsynced).toBeGreaterThan(0);

    // Reload while still cut off from the collaboration server. The page shell needs the
    // dev server, so network comes back but /collab stays blocked by the route above; the
    // shell itself loads and hydrates normally, so the reload waits for React like any other.
    await context.setOffline(false);
    await reloadHydrated(page);
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.getByTestId("doc-loading")).toHaveCount(0);

    // The key assertion: both sentences came back from IndexedDB, not from the server.
    await expect.poll(() => codeText(page)).toContain("First sentence typed online. Second sentence typed offline.");
    await expect.poll(() => richText(page)).toContain("Second sentence typed offline.");
    await expect(saveState).toHaveAttribute("data-state", /offline|reconnecting|connecting/);
    await expect(saveState).toHaveText(/Offline — \d+ unsaved change/);

    // Reconnect: the provider's own backoff brings the socket back; the header confirms it.
    blockCollab = false;
    await expect(saveState).toHaveAttribute("data-recovered", "true", { timeout: 10_000 });
    await expect(saveState).toHaveText("All changes saved");
    await expect(saveState).toHaveAttribute("data-state", "saved");
    await expect(saveState).toHaveText("Saved", { timeout: 5_000 });

    // Another browser sees the merged document from the server.
    const other = await signIn(browser, "alice");
    try {
      await openDocument(other.page, docId);
      await expect.poll(() => codeText(other.page)).toContain("First sentence typed online. Second sentence typed offline.");
    } finally {
      await other.context.close();
    }
  });

  test("editing stays enabled while offline for editors", async () => {
    const { page, context } = alice;
    await openDocument(page, docId);
    await goOffline(page, context);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", /offline|reconnecting/);
    await expect(page.locator(".md-rich")).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
    await context.setOffline(false);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  });
});
