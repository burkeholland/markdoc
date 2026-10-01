import { chromium, type FullConfig } from "@playwright/test";
import { e2eDistDir, removeDistDir } from "./dist-dir";
import { budgetScale, devLogin, waitForHydration } from "./helpers";

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
  console.log(`[e2e] timing budgets ×${budgetScale()}${process.env.E2E_BUDGET_SCALE ? " (E2E_BUDGET_SCALE)" : process.env.CI ? " (CI)" : ""}`);
  if (process.env.PROD_BASE_URL) {
    console.log("[e2e warm-up] PROD_BASE_URL set, skipping");
    return;
  }
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("[e2e warm-up] no baseURL configured");

  const webServer = config.webServer;
  const loadGated = Boolean(webServer?.command.includes("load.mjs"));
  // Cap for each first-hit compile below (editor route, API routes). The webServer timeout already
  // adapts to the load gate (480 s vs 180 s); on a saturated box the flat 120 s cap failed the warm-up,
  // so it follows the gate too. E2E_WARMUP_TIMEOUT_MS overrides both (unset, empty or non-numeric
  // values fall through to the default).
  const envTimeout = Number(process.env.E2E_WARMUP_TIMEOUT_MS);
  const envTimeoutSet = Number.isFinite(envTimeout) && envTimeout > 0;
  const WARMUP_STEP_TIMEOUT_MS = envTimeoutSet ? envTimeout : loadGated ? 300_000 : 120_000;
  console.log(
    `[e2e warm-up] load gate ${loadGated ? "ON" : "OFF"}: webServer "${webServer?.command ?? "<none>"}" (timeout ${Math.round((webServer?.timeout ?? 0) / 1000)} s); warm-up step timeout ${WARMUP_STEP_TIMEOUT_MS} ms (${envTimeoutSet ? "E2E_WARMUP_TIMEOUT_MS" : "default"})`,
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
  const sockets: { path: string; frames: number; closed: boolean; error: string | null }[] = [];
  page.on("websocket", (ws) => {
    const socket: (typeof sockets)[number] = { path: new URL(ws.url()).pathname, frames: 0, closed: false, error: null };
    sockets.push(socket);
    ws.on("framereceived", () => socket.frames++);
    ws.on("close", () => (socket.closed = true));
    ws.on("socketerror", (error) => (socket.error = error));
  });
  const login = `warmup-${Date.now().toString(36)}`;
  let docId: string | undefined;

  try {
    await timed("login page + dev login", async () => {
      await devLogin(page, login);
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

    await timed(`/d/<id> until save-state=saved (cap ${WARMUP_STEP_TIMEOUT_MS} ms)`, async () => {
      // The editor route's first compile is the slowest step of the run; Playwright's default 30 s
      // navigation timeout used to cut it off before any spec started.
      await page.goto(`/d/${docId}`, { timeout: WARMUP_STEP_TIMEOUT_MS });
      await waitForHydration(page, WARMUP_STEP_TIMEOUT_MS);
      const saveState = page.getByTestId("save-state");
      try {
        await saveState.waitFor({ state: "attached", timeout: WARMUP_STEP_TIMEOUT_MS });
        await page.waitForFunction(
          () => document.querySelector('[data-testid="save-state"]')?.getAttribute("data-state") === "saved",
          undefined,
          { timeout: WARMUP_STEP_TIMEOUT_MS },
        );
      } catch (err) {
        const state = await saveState.getAttribute("data-state").catch(() => null);
        const text = await saveState.innerText().catch(() => "");
        throw new Error(
          `[e2e warm-up] editor never reached saved (state=${state ?? "missing"}, header="${text}", sockets=${JSON.stringify(sockets)}): ${String(err)}`,
        );
      }
      await page.locator(".cm-content").waitFor({ timeout: 30_000 });
      await page.locator(".md-rich").waitFor({ timeout: 30_000 });
    });

    const apiRoutes = [
      "/api/documents?q=warm",
      "/api/templates",
      `/api/documents/${docId}/export?format=html`,
      // A plain GET answers the liveness card (200) and compiles the route: scale.spec.ts test 8 measured
      // 14,504 ms for its first timed `markdoc_suggest` on CI (Turbopack's cold compile) vs 1,204 ms on retry.
      "/api/mcp",
      // Agent requests from comments (#1024/#1025): the first hit compiles the route the comment composer posts to.
      `/api/documents/${docId}/requests`,
      // agent-presence.spec.ts l.138/l.182 give the picker/caret 1 s from `bot.presence` (POST, same module): the
      // first hit compiled in 1,554 ms on the unmodified tree (#1539).
      `/api/agent/documents/${docId}/presence`,
      // The comments panel's `useReviews` fires on mount inside agent-presence.spec.ts l.129–163 (first hit 1,524 ms).
      `/api/documents/${docId}/reviews`,
      // lan.spec.ts l.153–157 polls it under a 10 s budget.
      `/api/documents/${docId}/content`,
      // agent-presence.spec.ts l.129–138: the comments panel's mention picker reads it on mount, 1 s from `bot.presence`; warm only via the hint bar before (#1566).
      `/api/documents/${docId}/collaborators`,
      // header.tsx reads the star state on every editor page (dashboard/star flows); warm only by the /d/<id> step before (#1566).
      `/api/documents/${docId}/star`,
      // agent-requests.spec.ts l.413 (picker within 2 s) and agent-presence.spec.ts l.138 list the session's tokens; warm only via the hint bar before (#1566).
      "/api/tokens",
      // review-suggestions.spec.ts l.290 reads it between Accept and the toast's Undo (4.5 s): the cold first hit took
      // 13.5 s, so the toast had dismissed before the click (#2212).
      `/api/documents/${docId}/activity?limit=200`,
    ];
    for (const route of apiRoutes) {
      await timed(`GET ${route.replace(docId!, "<id>")}`, async () => {
        const res = await page.request.get(route, { timeout: WARMUP_STEP_TIMEOUT_MS });
        if (!res.ok()) throw new Error(`[e2e warm-up] ${route} -> ${res.status()}`);
      });
    }

    // First-hit compiles of these write routes also exceeded the 15 s expect timeout in
    // history.spec.ts, images.spec.ts and mentions.spec.ts on a loaded box, so take those hits here as well.
    await timed("POST /api/documents/<id>/versions", async () => {
      const res = await page.request.post(`/api/documents/${docId}/versions`, { data: { title: "warm-up" }, timeout: WARMUP_STEP_TIMEOUT_MS });
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
        timeout: WARMUP_STEP_TIMEOUT_MS,
      });
      if (!res.ok()) throw new Error(`[e2e warm-up] assets -> ${res.status()}`);
    });
    // agent-presence.spec.ts l.191–194 gives `bot.suggest` 3 s and #1491 measured a 4,341 ms cold compile there
    // (1,568 ms in the #1539 evidence run); scale.spec.ts test 8 reaches the same route through `markdoc_suggest`.
    await timed("POST /api/documents/<id>/suggest", async () => {
      const res = await page.request.post(`/api/documents/${docId}/suggest`, {
        data: { edits: [{ find: "Compiles the editor route.", replace: "Compiles the editor and suggest routes." }] },
        timeout: WARMUP_STEP_TIMEOUT_MS,
      });
      if (!res.ok()) throw new Error(`[e2e warm-up] suggest -> ${res.status()} ${await res.text()}`);
    });
    await timed("GET /api/documents/<id>/comments", async () => {
      const res = await page.request.get(`/api/documents/${docId}/comments`, { timeout: WARMUP_STEP_TIMEOUT_MS });
      if (!res.ok()) throw new Error(`[e2e warm-up] comments -> ${res.status()}`);
    });
    await timed("GET /api/notifications?unread=1", async () => {
      const res = await page.request.get("/api/notifications?unread=1", { timeout: WARMUP_STEP_TIMEOUT_MS });
      if (!res.ok()) throw new Error(`[e2e warm-up] notifications -> ${res.status()}`);
    });
    // The dashboard strip fires this fire-and-forget on click; once compiled the route answers 404 for an unknown id.
    await timed("POST /api/notifications/<id>/read", async () => {
      const res = await page.request.post("/api/notifications/warmup/read", { data: {}, timeout: WARMUP_STEP_TIMEOUT_MS });
      if (res.status() !== 200 && res.status() !== 404) throw new Error(`[e2e warm-up] notification read -> ${res.status()}`);
    });
  } finally {
    // Drop the collaboration socket before deleting so the server is not mid-save on this doc.
    await page.close().catch(() => undefined);
    if (docId) {
      await timed("DELETE /api/documents/<id>", async () => {
        const res = await context.request.delete(`/api/documents/${docId}`, { timeout: WARMUP_STEP_TIMEOUT_MS }).catch((err: unknown) => {
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
