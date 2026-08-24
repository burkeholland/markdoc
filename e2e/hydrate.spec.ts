import { test, expect, type Page } from "@playwright/test";
import * as Y from "yjs";
import { signIn, createDocument, openDocument, codeText, type User } from "./helpers";

/**
 * Regression for doubled content on reload. A document created with content through the API
 * (templates, imports, agents) and opened but never edited used to come back with every line
 * twice after `page.reload()`: the server re-seeded the Yjs text from plain Markdown with fresh
 * CRDT ids on each load and the browser merged its IndexedDB copy of the first seed with the
 * second one. The seed is now minted once and persisted (see src/server/collab/seed.ts).
 */

const CONTENT = "# Launch checklist\n\n## Before\n\n- Charge batteries\n- Pack the kit\n\n## After\n\n- Write the report\n";
const headingCount = (md: string) => md.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length;

const EPOCH_KEY = "markdoc:idb-epoch";

/**
 * Plant the IndexedDB mirror a pre-fix browser holds: the same Markdown seeded with CRDT ids the
 * server never persisted (y-indexeddb layout: database `markdoc:<id>`, stores `updates` + `custom`).
 * Merged with the server's persisted seed this reads as the text twice — unless it is wiped first.
 */
async function plantStaleMirror(page: Page, docId: string, content: string, title: string) {
  const stale = new Y.Doc();
  stale.getText("content").insert(0, content);
  stale.getMap("meta").set("title", title);
  const update = Array.from(Y.encodeStateAsUpdate(stale));
  stale.destroy();
  await page.evaluate(
    ([name, bytes]) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(name as string, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("updates", { autoIncrement: true });
          req.result.createObjectStore("custom");
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("updates", "readwrite");
          tx.objectStore("updates").add(new Uint8Array(bytes as number[]));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [`markdoc:${docId}`, update] as const,
  );
}

const localDbNames = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));

test.describe("hydration happens once", () => {
  let alice: User;

  test.beforeAll(async ({ browser }) => {
    alice = await signIn(browser, "alice");
  });

  test.afterAll(async () => {
    await alice.context.close();
  });

  test("an API-created document is unchanged after a reload without edits", async () => {
    const { page } = alice;
    const docId = await createDocument(page, CONTENT);
    await openDocument(page, docId);
    const outline = page.getByTestId("outline").locator("[data-outline-item]");
    expect(await codeText(page)).toBe(CONTENT);
    await expect(outline).toHaveCount(headingCount(CONTENT));

    await page.reload();
    await openDocument(page, docId);
    expect(await codeText(page)).toBe(CONTENT);
    await expect(outline).toHaveCount(headingCount(CONTENT));

    // Once more: the second load must not have minted a new seed either.
    await page.reload();
    await openDocument(page, docId);
    expect(await codeText(page)).toBe(CONTENT);
    await expect(outline).toHaveCount(headingCount(CONTENT));
  });

  test("a template document opened from the dashboard survives a refresh", async () => {
    const { page } = alice;
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTestId("new-from-template").click();
    const dialog = page.getByTestId("template-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("template-meeting-notes").click();
    await page.waitForURL(/\/d\//);
    const saveState = page.getByTestId("save-state");
    await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const before = await codeText(page);
    expect(before.length).toBeGreaterThan(0);

    await page.reload();
    await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    await expect(page.locator(".cm-content")).toBeVisible();
    expect(await codeText(page)).toBe(before);
    await expect(page.getByTestId("outline").locator("[data-outline-item]")).toHaveCount(headingCount(before));
  });

  test("a second browser opening the document after the first closed sees it once", async ({ browser }) => {
    const docId = await createDocument(alice.page, CONTENT);
    const first = await signIn(browser, "alice");
    await openDocument(first.page, docId);
    expect(await codeText(first.page)).toBe(CONTENT);
    await first.context.close();
    // Let the server unload the document (no edits, so nothing keeps it loaded).
    await alice.page.waitForTimeout(2_000);

    const second = await signIn(browser, "alice");
    try {
      await openDocument(second.page, docId);
      expect(await codeText(second.page)).toBe(CONTENT);
      await second.page.reload();
      await openDocument(second.page, docId);
      expect(await codeText(second.page)).toBe(CONTENT);
    } finally {
      await second.context.close();
    }
  });

  test("pre-fix mirror: a stale IndexedDB copy of a never-persisted seed is wiped by the epoch reset, not merged", async ({ browser }) => {
    const docId = await createDocument(alice.page, CONTENT, "Launch checklist");
    // A browser that never ran the fixed client: no epoch key, one stale mirror (plus a bystander mirror).
    const old = await signIn(browser, "alice");
    try {
      await old.page.evaluate((key) => localStorage.removeItem(key), EPOCH_KEY);
      await plantStaleMirror(old.page, docId, CONTENT, "Launch checklist");
      await plantStaleMirror(old.page, "bystander", "# Other\n", "Other");
      expect(await localDbNames(old.page)).toEqual(expect.arrayContaining([`markdoc:${docId}`, "markdoc:bystander"]));

      await openDocument(old.page, docId);
      expect(await codeText(old.page)).toBe(CONTENT);
      await expect(old.page.getByTestId("outline").locator("[data-outline-item]")).toHaveCount(headingCount(CONTENT));
      expect(await old.page.evaluate((key) => localStorage.getItem(key), EPOCH_KEY)).toBe("2");
      // Every markdoc:* database went; the one for this document was then recreated from the server's state.
      const names = await localDbNames(old.page);
      expect(names).not.toContain("markdoc:bystander");

      // Still single after a reload (the fresh mirror matches the server), and nothing doubled was pushed.
      await old.page.reload();
      await openDocument(old.page, docId);
      expect(await codeText(old.page)).toBe(CONTENT);
    } finally {
      await old.context.close();
    }
    const cold = await signIn(browser, "alice");
    try {
      await openDocument(cold.page, docId);
      expect(await codeText(cold.page)).toBe(CONTENT);
    } finally {
      await cold.context.close();
    }
  });

  test("a matching epoch keeps the local mirror", async ({ browser }) => {
    const docId = await createDocument(alice.page, CONTENT, "Launch checklist");
    const user = await signIn(browser, "alice");
    try {
      await openDocument(user.page, docId);
      expect(await user.page.evaluate((key) => localStorage.getItem(key), EPOCH_KEY)).toBe("2");
      await expect.poll(() => localDbNames(user.page)).toContain(`markdoc:${docId}`);
      await user.page.reload();
      await openDocument(user.page, docId);
      expect(await localDbNames(user.page)).toContain(`markdoc:${docId}`);
      expect(await codeText(user.page)).toBe(CONTENT);
    } finally {
      await user.context.close();
    }
  });
});
