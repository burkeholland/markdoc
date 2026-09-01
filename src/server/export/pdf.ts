import type { Browser } from "playwright-core";

const IDLE_CLOSE_MS = 60_000;
/** How long a close waits for Chromium to shut down before the caller moves on (task #1310). */
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const CONTENT_LOAD_TIMEOUT_MS = 10_000;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

/** Thrown when Chromium cannot be launched (not installed, sandbox denied, ...). */
export class PdfUnavailableError extends Error {
  constructor(cause: unknown) {
    super("PDF export is unavailable on this server");
    this.cause = cause;
  }
}

async function launch(onDisconnected: () => void): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  // CHROMIUM_PATH points at a system Chromium (the Docker image installs Alpine's). Playwright's
  // own download is used when it is unset.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  browser.on("disconnected", onDisconnected);
  return browser;
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Only the browser that owns the slot may empty it. An idle close or `closePdfBrowser` empties the slot
    // and then closes the old browser, which can take seconds; a render arriving meanwhile launches a new
    // browser into the slot. When the old browser's close then fires `disconnected` (or its still-pending
    // launch fails), an unconditional reset would drop the new browser while it is alive and possibly
    // mid-render — unreachable, never closed, leaked until process exit (task #1409). `p` is assigned before
    // either callback can run: `launch` yields at its first `await` and `.catch` handlers are always deferred.
    const forget = () => {
      if (browserPromise === p) browserPromise = null;
    };
    const p: Promise<Browser> = launch(forget).catch((err) => {
      forget();
      throw new PdfUnavailableError(err);
    });
    browserPromise = p;
  }
  return browserPromise;
}

/**
 * Await `browser.close()` for at most `timeoutMs`. "closed" and "failed" are the close's own outcome;
 * "timed-out" means it is still running and is left to finish on its own — `Browser` exposes no process to
 * kill, and Playwright's launcher kills the child on process exit at the latest. Never throws.
 */
export async function closeWithin(browser: Pick<Browser, "close">, timeoutMs: number): Promise<"closed" | "timed-out" | "failed"> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
    timer.unref?.();
  });
  // The async wrapper also turns a synchronous throw from `close()` into "failed".
  const closing = (async () => {
    await browser.close();
    return "closed" as const;
  })().catch(() => "failed" as const);
  try {
    return await Promise.race([closing, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBounded(browser: Browser, timeoutMs: number): Promise<void> {
  if ((await closeWithin(browser, timeoutMs)) === "timed-out") {
    console.warn(`[pdf] browser close still running after ${timeoutMs} ms; leaving it to process exit`);
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (inFlight > 0) return;
    const p = browserPromise;
    browserPromise = null;
    p?.then((b) => closeBounded(b, BROWSER_CLOSE_TIMEOUT_MS)).catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/**
 * Render a standalone HTML string to a Letter-size PDF with one shared Chromium instance.
 * Each render uses an isolated offline context and rejects every routed request: PDF input is
 * document-controlled, so all required assets must already be embedded as data URIs.
 */
export async function renderPdf(html: string): Promise<Uint8Array> {
  inFlight++;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({ offline: true, serviceWorkers: "block" });
    try {
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: CONTENT_LOAD_TIMEOUT_MS });
      await page.emulateMedia({ media: "print" });
      return await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" },
      });
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    inFlight--;
    if (inFlight === 0) scheduleIdleClose();
  }
}

/**
 * Close the shared browser (tests and graceful shutdown), waiting at most `timeoutMs`: on a loaded box
 * Chromium's shutdown has outlived a 30 s test hook, so past the bound the close is left running (one warn
 * line) rather than awaited. A close that fails, or a launch that never succeeded, is silent as before.
 */
export async function closePdfBrowser(timeoutMs = BROWSER_CLOSE_TIMEOUT_MS): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = browserPromise;
  browserPromise = null;
  if (p) await p.then((b) => closeBounded(b, timeoutMs)).catch(() => {});
}
