import { expect, test } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import * as Y from "yjs";
import { codeText, createDocument, devLogin, focusCodeEnd, openDocument, signIn, waitForEditor, waitForHydration } from "./helpers";

const registryKey = "markdoc:idb-docs";

const localDbNames = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name ?? "").filter((name) => name.startsWith("markdoc:")));

async function mirrorText(page: Page, docId: string): Promise<string> {
  const updates = await page.evaluate(
    (name) =>
      new Promise<number[][]>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("updates", "readonly");
          const getAll = transaction.objectStore("updates").getAll();
          getAll.onerror = () => reject(getAll.error);
          getAll.onsuccess = () => {
            const bytes = getAll.result.map((value) => Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)));
            database.close();
            resolve(bytes);
          };
        };
      }),
    `markdoc:${docId}`,
  );
  const document = new Y.Doc();
  for (const update of updates) Y.applyUpdate(document, Uint8Array.from(update));
  const text = document.getText("content").toString();
  document.destroy();
  return text;
}

async function signInWithin(context: BrowserContext, login: string): Promise<Page> {
  const page = await context.newPage();
  await devLogin(page, login);
  return page;
}

test.describe("privacy-safe sign out", () => {
  test("anonymous document visitors can sign in and return to the document", async ({ browser }) => {
    const { context, page } = await signIn(browser, `signout-shared-${Date.now()}`);
    const docId = await createDocument(page, "# Shared document\n");
    expect((await page.request.patch(`/api/documents/${docId}`, { data: { linkAccess: "comment" } })).ok()).toBeTruthy();
    await openDocument(page, docId);
    await page.getByTestId("more-menu").click();
    await expect(page.getByRole("menuitem", { name: "Sign in", exact: true })).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/signout/);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/");

    const path = `/d/${docId}?from=shared#comments`;
    for (let visit = 0; visit < 2; visit++) {
      await page.goto(path);
      await waitForEditor(page);
      await page.getByTestId("more-menu").click();
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
      await expect(page.getByRole("menuitem", { name: "Sign in", exact: true })).toBeVisible();
    }
    await page.getByRole("menuitem", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    expect(new URL(page.url()).searchParams.get("next")).toBe(path);
    await waitForHydration(page);
    await page.getByTestId("dev-login").fill(`signout-return-${Date.now()}`);
    await page.getByTestId("dev-login-submit").click();
    await page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === path);
    await waitForEditor(page);
    await page.getByTestId("more-menu").click();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sign in", exact: true })).toHaveCount(0);
    await context.close();
  });

  test("removes every offline mirror before another user signs in in the same browser", async ({ browser }) => {
    test.setTimeout(180_000);
    const marker = `private-marker-${Date.now()}`;
    const alice = await signIn(browser, `signout-alice-${Date.now()}`);
    const { context, page } = alice;
    const firstId = await createDocument(page, "# First private document\n");
    const markedId = await createDocument(page, `# Marked private document\n\n${marker}\n`);

    await openDocument(page, firstId);
    await openDocument(page, markedId);
    await expect.poll(() => localDbNames(page)).toEqual(expect.arrayContaining([`markdoc:${firstId}`, `markdoc:${markedId}`]));
    await expect.poll(() => mirrorText(page, markedId)).toContain(marker);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("changes that have not finished syncing will be permanently lost");
      await dialog.accept();
    });
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/signout/);

    await expect(page.getByTestId("signout-card")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Are you sure you want to sign out?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveClass(/btn-danger/);

    expect(await localDbNames(page)).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), registryKey)).toBeNull();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL((url) => url.pathname === "/", { waitUntil: "load" });
    expect(await page.evaluate(async () => (await fetch("/api/me")).status)).toBe(401);

    const bob = await signInWithin(context, `signout-bob-${Date.now()}`);
    try {
      const residue = await bob.evaluate(
        async ({ ids, privateMarker, key }) => {
          const databases = (await indexedDB.databases()).map(({ name }) => name ?? "");
          const storageValues = Array.from({ length: localStorage.length }, (_, index) => {
            const storageKey = localStorage.key(index);
            return storageKey ? `${storageKey}:${localStorage.getItem(storageKey)}` : "";
          });
          const serialized = JSON.stringify({ databases, storageValues });
          return {
            databases: databases.filter((name) => name.startsWith("markdoc:")),
            registry: localStorage.getItem(key),
            exposesDocumentId: ids.some((id) => serialized.includes(id)),
            exposesMarker: serialized.includes(privateMarker),
          };
        },
        { ids: [firstId, markedId], privateMarker: marker, key: registryKey },
      );
      expect(residue).toEqual({ databases: [], registry: null, exposesDocumentId: false, exposesMarker: false });
    } finally {
      await bob.close();
      await context.close();
    }
  });

  test("warns about an unsynced offline edit and cancellation keeps the session and mirror", async ({ browser }) => {
    const user = await signIn(browser, `signout-cancel-${Date.now()}`);
    const { context, page } = user;
    const docId = await createDocument(page, "# Offline sign-out warning\n");
    await openDocument(page, docId);

    await page.routeWebSocket(/\/collab/, (socket) => socket.close({ code: 1006, reason: "offline sign-out test" }));
    await page.evaluate(() => {
      type SessionWindow = { __markdocSession: { provider: { configuration: { websocketProvider: { webSocket: WebSocket | null } } } } };
      (window as unknown as SessionWindow).__markdocSession.provider.configuration.websocketProvider.webSocket?.close();
    });
    await context.setOffline(true);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", /offline|reconnecting/);
    await focusCodeEnd(page);
    await page.keyboard.type(" Private unsynced edit.");
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-unsynced", /[1-9]\d*/);

    await page.getByTestId("more-menu").click();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("permanently lost");
      await dialog.dismiss();
    });
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page).toHaveURL(new RegExp(`/d/${docId}$`));
    expect(await codeText(page)).toContain("Private unsynced edit.");
    expect(await localDbNames(page)).toContain(`markdoc:${docId}`);
    await context.setOffline(false);
    expect((await page.request.get("/api/me")).status()).toBe(200);
    await context.close();
  });
});
