import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { signIn, createDocument, openDocument } from "./helpers";

const BASE = "# Repro\n\nHello.\n";
const REPO = { owner: "mock", repo: "scratch", branch: "main" };
let n = 0;

async function linkToFakeRepo(page: Page, docId: string, content = BASE) {
  const path = `docs/repro-${Date.now()}-${++n}.md`;
  const seed = await page.request.post("/api/github/mock", { data: { kind: "repo", ...REPO, path, content } });
  expect(seed.ok()).toBeTruthy();
  const res = await page.request.post(`/api/documents/${docId}/link`, { data: { storage: "repo", ...REPO, path } });
  expect(res.ok()).toBeTruthy();
  return path;
}

test("repro: commit dialog escape", async ({ browser }) => {
  const { page } = await signIn(browser, "repro1");
  const docId = await createDocument(page, BASE);
  await linkToFakeRepo(page, docId);
  await openDocument(page, docId);
  // Make a local change so the status is "local-ahead" and publish-button opens Commit directly.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nLocal edit.");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await expect(page.getByTestId("publish-status")).toHaveAttribute("data-status", "local-ahead", { timeout: 15_000 });
  await page.getByTestId("publish-button").click();
  const commitDialog = page.getByRole("dialog");
  await expect(commitDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commitDialog).toBeHidden({ timeout: 2000 });
});

test("repro: sync dialog escape", async ({ browser }) => {
  const { page } = await signIn(browser, "repro2");
  const docId = await createDocument(page, BASE);
  const path = await linkToFakeRepo(page, docId);
  await openDocument(page, docId);
  // Force diverged state the same way github-sync.spec.ts does: confirm in-sync, then
  // remote-ahead, then a local edit.
  await expect(page.getByTestId("publish-status")).toHaveAttribute("data-status", "in-sync", { timeout: 15_000 });
  await page.request.post("/api/github/mock", { data: { kind: "repo", ...REPO, path, content: BASE + "\nRemote edit.\n" } });
  await expect(page.getByTestId("publish-status")).toHaveAttribute("data-status", "remote-ahead", { timeout: 65_000 });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nLocal edit.");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  await expect(page.getByTestId("publish-status")).toHaveAttribute("data-status", "diverged", { timeout: 15_000 });
  const syncDialog = page.getByTestId("sync-dialog");
  await expect(async () => {
    await page.getByTestId("publish-button").click();
    await expect(syncDialog).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(syncDialog).toBeHidden({ timeout: 2000 });
});

test("repro: change connection dialog escape focus", async ({ browser }) => {
  const { page } = await signIn(browser, "repro3");
  const docId = await createDocument(page, BASE);
  await linkToFakeRepo(page, docId);
  await openDocument(page, docId);
  await page.getByTestId("publish-menu").click();
  await page.getByRole("menuitem", { name: "Change connection…" }).click();
  const dialog = page.getByRole("dialog", { name: "GitHub connection" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const stillVisible = await dialog.isVisible();
  const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
  console.log("CHANGE CONNECTION: stillVisible=", stillVisible, "active=", active);
});
