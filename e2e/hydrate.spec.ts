import { test, expect } from "@playwright/test";
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
});
