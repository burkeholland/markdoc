import { test, expect } from "./fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { codeText, createDocument, devLogin, openDocument, uniqueLogin } from "./helpers";
import type { GistAutoUpdateDestination, GistAutoUpdateSettings, GistAutoUpdateStatus } from "../src/lib/gist-auto-update";

// Requires the existing GITHUB_MOCK=1 server. The browser control's API is mocked independently
// of the worker; manual publishing still uses the in-memory GitHub provider. Never start OAuth.
const BASE = "# Gist auto-update\n\nSaved in Markdoc.\n";
const OFF: GistAutoUpdateStatus = { enabled: false, status: "off", syncedAt: null, message: null, pending: false, destination: null };

async function linkedGist(page: Page) {
  const docId = await createDocument(page, BASE, "Gist auto-update");
  const gistId = `auto${docId.replace(/[^a-z0-9]/gi, "")}`;
  const filename = "auto-update.md";
  const seeded = await page.request.post("/api/github/mock", { data: { kind: "gist", gistId, filename, content: BASE } });
  expect(seeded.ok()).toBeTruthy();
  const linked = await page.request.post(`/api/documents/${docId}/link`, { data: { storage: "gist", gistId, filename } });
  expect(linked.ok()).toBeTruthy();
  return {
    docId,
    destination: { gistId, filename, url: `https://gist.github.com/${gistId}`, visibility: "secret", owner: "mock-gist-owner" } satisfies GistAutoUpdateDestination,
  };
}

async function mockControl(context: BrowserContext, docId: string, destination: GistAutoUpdateDestination) {
  const fake = {
    status: { ...OFF } as GistAutoUpdateStatus,
    counts: { status: 0, preview: 0 },
    mutations: [] as { method: string; body: unknown; search: string }[],
    failEnable: false,
    failEnableStatus: 503,
  };
  const pending: GistAutoUpdateStatus = { ...OFF, enabled: true, status: "pending", destination };
  await context.route(`**/api/documents/${docId}/gist-auto-update*`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      if (url.searchParams.get("preview") === "1") {
        fake.counts.preview++;
        await route.fulfill({ json: { destination } });
      } else {
        fake.counts.status++;
        await route.fulfill({ json: fake.status });
      }
      return;
    }
    fake.mutations.push({ method: request.method(), body: request.postDataJSON(), search: url.search });
    if (request.method() === "PATCH") {
      const settings = request.postDataJSON() as GistAutoUpdateSettings;
      if (settings.enabled && fake.failEnable) {
        await route.fulfill({ status: fake.failEnableStatus, json: {
          error: fake.failEnableStatus === 409
            ? "The linked gist changed. Check the linked gist again before enabling."
            : "The gist could not be checked. Auto-update was not enabled.",
        } });
        return;
      }
      fake.status = settings.enabled ? { ...pending } : { ...OFF };
    } else if (request.method() === "POST") {
      fake.status = { ...pending };
    } else {
      await route.fulfill({ status: 405, json: { error: "Unsupported method" } });
      return;
    }
    await route.fulfill({ json: fake.status });
  });
  return fake;
}

async function openConnection(page: Page) {
  await page.getByTestId("more-menu").click();
  await page.getByTestId("menu-github").click();
  await expect(page.getByRole("dialog", { name: "GitHub connection", exact: true })).toBeVisible();
}

async function manualUpdate(page: Page) {
  if (await page.getByTestId("publish-menu").isVisible()) {
    await page.getByTestId("publish-menu").click();
    await page.getByRole("menuitem", { name: "Update gist", exact: true }).click();
  } else {
    await page.getByTestId("more-menu").click();
    await page.getByTestId("menu-publish").click();
  }
}

test.beforeEach(async ({ context, page }) => {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) await route.fallback();
    else await route.abort("blockedbyclient");
  });
  await devLogin(page, uniqueLogin("gist-auto-ui"));
});

test("owner previews and opts in, sees saved-version progress, disables, and can still manually update", async ({ context, page }) => {
  const { docId, destination } = await linkedGist(page);
  const fake = await mockControl(context, docId, destination);
  let manualPublishes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/documents/${docId}/publish` && request.method() === "POST") manualPublishes++;
  });
  await openDocument(page, docId);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nA saved edit while auto-update is off.\n");
  await expect.poll(() => codeText(page)).toContain("A saved edit while auto-update is off.");
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved");

  await openConnection(page);
  const control = page.getByTestId("gist-auto-update");
  const state = page.getByTestId("gist-auto-update-state");
  await expect(state).toHaveAttribute("data-status", "off");
  await expect.poll(() => fake.counts.status).toBeGreaterThanOrEqual(2);
  expect(fake.counts.preview).toBe(0);
  expect(fake.mutations).toEqual([]);
  expect(manualPublishes).toBe(0);
  const before = await page.request.get(`/api/github/mock?gistId=${destination.gistId}&filename=${destination.filename}`);
  expect((await before.json()).content).toBe(BASE);

  await expect(control.getByRole("button", { name: "Enable auto-update", exact: true })).toBeDisabled();
  await control.getByRole("button", { name: "Check linked gist", exact: true }).click();
  const reviewed = control.getByTestId("gist-auto-update-destination");
  await expect(reviewed.getByRole("link")).toHaveAttribute("href", destination.url);
  await expect(reviewed).toContainText(destination.filename);
  await expect(reviewed).toContainText("Secret (unlisted, not private)");
  await expect(reviewed).toContainText(`GitHub account: @${destination.owner}`);
  await expect(control).toContainText("including collaborator edits");
  await expect(control).toContainText("during an upload can still be overwritten");
  await expect(control).toContainText("not one atomic operation");
  expect(fake.counts.preview).toBe(1);
  expect(fake.mutations).toEqual([]);
  await expect(control.getByRole("button", { name: "Enable auto-update", exact: true })).toBeDisabled();
  await control.getByRole("checkbox", { name: "I acknowledge the sharing and overwrite risks." }).check();
  expect(fake.mutations).toEqual([]);
  await control.getByRole("button", { name: "Enable auto-update", exact: true }).click();
  await expect(state).toHaveAttribute("data-status", "pending");
  expect(fake.mutations).toEqual([{ method: "PATCH", body: { enabled: true, acknowledgeRisk: true, destination }, search: "" }]);

  fake.status = { ...fake.status, status: "syncing", pending: true };
  await expect(state).toHaveAttribute("data-status", "syncing");
  await expect(control.getByTestId("gist-auto-update-pending")).toContainText("newest saved version is pending behind the current upload");
  const syncedAt = "2026-09-05T10:20:00.000Z";
  fake.status = { ...fake.status, status: "synced", pending: false, syncedAt };
  await expect(state).toHaveAttribute("data-status", "synced");
  await expect(control.locator("time")).toHaveAttribute("datetime", syncedAt);
  await expect(control.getByTestId("gist-auto-update-pending")).toHaveCount(0);
  expect(fake.mutations).toHaveLength(1);
  await control.getByRole("button", { name: "Disable auto-update", exact: true }).click();
  await expect(state).toHaveAttribute("data-status", "off");
  await expect(control).toContainText("An update already in progress may still finish");
  expect(fake.mutations[1]).toEqual({ method: "PATCH", body: { enabled: false }, search: "" });
  await expect(control.getByRole("button", { name: "Enable auto-update", exact: true })).toBeDisabled();
  expect(manualPublishes).toBe(0);

  await page.keyboard.press("Escape");
  await expect(control).toHaveCount(0);
  const closedReads = fake.counts.status;
  await page.waitForTimeout(2_300);
  expect(fake.counts.status).toBe(closedReads);
  const published = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/documents/${docId}/publish` && response.request().method() === "POST");
  await manualUpdate(page);
  expect((await published).ok()).toBeTruthy();
  expect(manualPublishes).toBe(1);
  expect(fake.mutations).toHaveLength(2);
  const after = await page.request.get(`/api/github/mock?gistId=${destination.gistId}&filename=${destination.filename}`);
  expect((await after.json()).content).toContain("A saved edit while auto-update is off.");
});

test("failed or stale opt-in preserves local text; known conflicts need explicit non-force retries", async ({ context, page }) => {
  const { docId, destination } = await linkedGist(page);
  const fake = await mockControl(context, docId, { ...destination, visibility: "public" });
  fake.failEnable = true;
  let manualPublishes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/documents/${docId}/publish` && request.method() === "POST") manualPublishes++;
  });
  await openDocument(page, docId);
  await openConnection(page);
  const control = page.getByTestId("gist-auto-update");
  const state = page.getByTestId("gist-auto-update-state");
  await expect(state).toHaveAttribute("data-status", "off");
  await control.getByRole("button", { name: "Check linked gist", exact: true }).click();
  await expect(control.getByTestId("gist-auto-update-destination")).toContainText("Visibility: Public");
  await control.getByRole("checkbox").check();
  for (const button of await control.getByRole("button").all()) await expect(button).toHaveAttribute("type", "button");
  expect(manualPublishes).toBe(0);
  await control.getByRole("button", { name: "Enable auto-update", exact: true }).click();
  await expect(state).toHaveAttribute("data-status", "failed");
  await expect(control.getByRole("alert")).toContainText("Auto-update was not enabled");
  expect(await codeText(page)).toBe(BASE);
  expect(manualPublishes).toBe(0);
  await page.waitForTimeout(2_300);
  expect(fake.mutations).toHaveLength(1);
  await expect(control.getByRole("button", { name: "Enable auto-update", exact: true })).toBeDisabled();
  fake.failEnableStatus = 409;
  await control.getByRole("button", { name: "Check linked gist", exact: true }).click();
  await control.getByRole("checkbox").check();
  await control.getByRole("button", { name: "Enable auto-update", exact: true }).click();
  await expect(control.getByRole("alert")).toContainText("linked gist changed");
  await expect(control.getByRole("button", { name: "Enable auto-update", exact: true })).toBeDisabled();
  expect(await codeText(page)).toBe(BASE);
  expect(manualPublishes).toBe(0);
  expect(fake.mutations).toHaveLength(2);
  await page.keyboard.press("Escape");

  const conflict: GistAutoUpdateStatus = { ...OFF, enabled: true, status: "conflict", destination: { ...destination, visibility: "public" }, message: "Outside edits detected. Publishing paused." };
  fake.status = conflict;
  await openConnection(page);
  await expect(state).toHaveAttribute("data-status", "conflict");
  await expect(control).toContainText("Manually reconcile");
  await expect(control).toContainText("Retry does not force an overwrite or resolve a known conflict");
  await control.getByRole("button", { name: "Retry latest saved version", exact: true }).click();
  await expect(state).toHaveAttribute("data-status", "pending");
  fake.status = conflict;
  await expect(state).toHaveAttribute("data-status", "conflict");
  await expect(control.getByRole("button", { name: "Retry latest saved version", exact: true })).toBeEnabled();
  expect(fake.mutations[2]).toEqual({ method: "POST", body: null, search: "" });
  await page.waitForTimeout(2_300);
  expect(fake.mutations).toHaveLength(3);
  expect(await codeText(page)).toBe(BASE);
  expect(manualPublishes).toBe(0);
});
