import { chromium, type FullConfig } from "@playwright/test";
import { e2eDistDir, removeDistDir } from "./dist-dir";

/**
 * A Next dist dir left behind by a killed run answers 404 on every API route (or EPERM on
 * app-paths-manifest.json) and the suite then fails slowly, test by test. Probe /api/health for up
 * to 60 s before the warm-up; if it never returns 200, delete the dist dir and fail fast.
 */
async function assertHealthy(baseURL: string, distDir: string) {
  const deadline = Date.now() + 60_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  console.error(`[e2e warm-up] GET /api/health did not return 200 within 60 s (last: ${last}); dist dir ${distDir} may be corrupt; deleting and failing fast`);
  removeDistDir(distDir, "health-check");
  process.exit(1);
}

/**
 * Warm up the dev server before any spec runs.
 *
 * Next dev (Turbopack) compiles each route on its first request. On a loaded machine the
 * editor route plus its API routes take longer than the 30 s `openDocument()` allows, so the
 * first test of a cold run used to flake at "saving". Here we take that cold-compile hit once,
 * with a generous timeout, and log how long each step took so the cost stays visible.
 *
 * Skipped when PROD_BASE_URL is set (the suite then targets an already-built server).
 */
export default async function globalSetup(config: FullConfig) {
  if (process.env.PROD_BASE_URL) {
    console.log("[e2e warm-up] PROD_BASE_URL set, skipping");
    return;
  }
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("[e2e warm-up] no baseURL configured");

  const webServer = config.webServer;
  const loadGated = Boolean(webServer?.command.includes("load.mjs"));
  console.log(
    `[e2e warm-up] load gate ${loadGated ? "ON" : "OFF"}: webServer "${webServer?.command ?? "<none>"}" (timeout ${Math.round((webServer?.timeout ?? 0) / 1000)} s)`,
  );

  const startedAt = Date.now();
  const log = (step: string, ms: number) => console.log(`[e2e warm-up] ${step.padEnd(34)} ${String(ms).padStart(6)} ms`);
  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      log(step, Date.now() - t0);
    }
  };

  const distDir = e2eDistDir();
  console.log(`[e2e warm-up] dist dir ${distDir}`);
  await timed("GET /api/health (fast-fail probe)", () => assertHealthy(baseURL, distDir));

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const login = `warmup-${Date.now().toString(36)}`;
  let docId: string | undefined;

  try {
    await timed("login page + dev login", async () => {
      await page.goto("/login");
      await page.getByTestId("dev-login").fill(login);
      await page.getByTestId("dev-login-submit").click();
      await page.waitForURL((url) => url.pathname === "/");
      await page.waitForLoadState("networkidle");
    });

    docId = await timed("POST /api/documents", async () => {
      const res = await page.request.post("/api/documents", {
        data: { title: "e2e warm-up", content: "# Warm-up\n\nCompiles the editor route.\n" },
      });
      if (!res.ok()) throw new Error(`[e2e warm-up] create document failed: ${res.status()} ${await res.text()}`);
      const body = (await res.json()) as { document: { id: string } };
      return body.document.id;
    });

    await timed("/d/<id> until save-state=saved", async () => {
      await page.goto(`/d/${docId}`);
      const saveState = page.getByTestId("save-state");
      try {
        await saveState.waitFor({ state: "attached", timeout: 120_000 });
        await page.waitForFunction(
          () => document.querySelector('[data-testid="save-state"]')?.getAttribute("data-state") === "saved",
          undefined,
          { timeout: 120_000 },
        );
      } catch (err) {
        const state = await saveState.getAttribute("data-state").catch(() => null);
        const text = await saveState.innerText().catch(() => "");
        throw new Error(`[e2e warm-up] editor never reached saved (state=${state ?? "missing"}, header="${text}"): ${String(err)}`);
      }
      await page.locator(".cm-content").waitFor({ timeout: 30_000 });
      await page.locator(".md-rich").waitFor({ timeout: 30_000 });
    });

    const apiRoutes = [
      "/api/documents?q=warm",
      "/api/templates",
      `/api/documents/${docId}/export?format=html`,
    ];
    for (const route of apiRoutes) {
      await timed(`GET ${route.replace(docId!, "<id>")}`, async () => {
        const res = await page.request.get(route, { timeout: 120_000 });
        if (!res.ok()) throw new Error(`[e2e warm-up] ${route} -> ${res.status()}`);
      });
    }

    // First-hit compiles of these write routes also exceeded the 15 s expect timeout in
    // history.spec.ts and images.spec.ts on a loaded box, so take those hits here as well.
    await timed("POST /api/documents/<id>/versions", async () => {
      const res = await page.request.post(`/api/documents/${docId}/versions`, { data: { title: "warm-up" }, timeout: 120_000 });
      if (!res.ok()) throw new Error(`[e2e warm-up] versions -> ${res.status()}`);
    });
    await timed("POST /api/documents/<id>/assets", async () => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const res = await page.request.post(`/api/documents/${docId}/assets?name=warm.png`, {
        headers: { "content-type": "image/png" },
        data: png,
        timeout: 120_000,
      });
      if (!res.ok()) throw new Error(`[e2e warm-up] assets -> ${res.status()}`);
    });
    await timed("GET /api/documents/<id>/comments", async () => {
      const res = await page.request.get(`/api/documents/${docId}/comments`, { timeout: 120_000 });
      if (!res.ok()) throw new Error(`[e2e warm-up] comments -> ${res.status()}`);
    });
  } finally {
    // Drop the collaboration socket before deleting so the server is not mid-save on this doc.
    await page.close().catch(() => undefined);
    if (docId) {
      await timed("DELETE /api/documents/<id>", async () => {
        const res = await context.request.delete(`/api/documents/${docId}`, { timeout: 120_000 }).catch((err: unknown) => {
          console.log(`[e2e warm-up] delete failed (non-fatal): ${String(err)}`);
          return null;
        });
        if (res && !res.ok()) console.log(`[e2e warm-up] delete returned ${res.status()} (non-fatal)`);
      });
    }
    await context.close();
    await browser.close();
    log("total", Date.now() - startedAt);
  }
}
