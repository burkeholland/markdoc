import type { Browser } from "playwright-core";

const IDLE_CLOSE_MS = 60_000;

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

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  // CHROMIUM_PATH points at a system Chromium (the Docker image installs Alpine's). Playwright's
  // own download is used when it is unset.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw new PdfUnavailableError(err);
    });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (inFlight > 0) return;
    const p = browserPromise;
    browserPromise = null;
    p?.then((b) => b.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/** Render a standalone HTML string to a Letter-size PDF with one shared Chromium instance. */
export async function renderPdf(html: string): Promise<Uint8Array> {
  inFlight++;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      return await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.75in", right: "0.75in", bottom: "0.75in", left: "0.75in" },
      });
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    inFlight--;
    if (inFlight === 0) scheduleIdleClose();
  }
}

/** Close the shared browser (tests and graceful shutdown). */
export async function closePdfBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = browserPromise;
  browserPromise = null;
  if (p) await p.then((b) => b.close()).catch(() => {});
}
