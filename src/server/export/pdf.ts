import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Browser } from "playwright-core";

const IDLE_CLOSE_MS = 60_000;
/** How long a close waits for Chromium to shut down before the caller moves on (task #1310). */
export const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const CONTENT_LOAD_TIMEOUT_MS = 10_000;

/**
 * Renders that run at once. One: a single export with many pictures can want more memory in Chromium than
 * the production container has for Node and Chromium together, so two at once is how that limit is reached (#2290).
 */
export const PDF_MAX_RUNNING = 1;
/** Callers that may wait for the renderer; one more is refused at once. */
export const PDF_MAX_WAITING = 8;
/** Longest a caller waits for the renderer before it is refused. */
export const PDF_QUEUE_WAIT_MS = 30_000;
/** Longest one render may take from the moment it has the renderer: building the page, a launch and the print. */
export const PDF_RENDER_TIMEOUT_MS = 60_000;
/** `Retry-After`, in seconds, for a caller refused because the renderer is busy. */
export const PDF_RETRY_AFTER_SECONDS = 10;

let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

export type PdfBrowserCloseOutcome = "closed" | "timed-out" | "failed" | "idle";

/** Thrown when Chromium cannot be launched (not installed, sandbox denied, ...). */
export class PdfUnavailableError extends Error {
  constructor(cause: unknown) {
    super("PDF export is unavailable on this server");
    this.cause = cause;
  }
}

/** Why a render was refused or stopped: no room to wait, waited too long, or ran too long. */
export type PdfBusyReason = "queue-full" | "queue-wait" | "render-timeout";

/** Thrown when the renderer has no room for this caller, or when its render ran past the time limit (HTTP 503 in the route). */
export class PdfBusyError extends Error {
  constructor(readonly reason: PdfBusyReason) {
    super(
      reason === "render-timeout"
        ? `This PDF took longer than ${PDF_RENDER_TIMEOUT_MS / 1000} seconds to make and was stopped`
        : "PDF export is busy. Try again in a few seconds",
    );
  }

  /** Seconds for a `Retry-After` header. None for a render that ran too long: the same document would take as long again. */
  get retryAfter(): number | undefined {
    return this.reason === "render-timeout" ? undefined : PDF_RETRY_AFTER_SECONDS;
  }
}

/** Thrown when the caller went away (its `signal` aborted) before its PDF was made. */
export class PdfCancelledError extends Error {
  constructor() {
    super("The PDF request was cancelled");
  }
}

/** Names Chromium may inherit: what a process needs to start, find its fonts and temporary folder, and format text. */
const CHROMIUM_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
  // Windows cannot start a process without these.
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);
/** Families of such names: locale categories, XDG folders, the Windows program folders. */
const CHROMIUM_ENV_PREFIXES = ["LC_", "XDG_", "PROGRAMFILES"];

/**
 * The environment Chromium is started with: an allow-list, compared without regard to case (Windows spells
 * `Path`, `SystemRoot`). Everything else stays in the server: the session secret, the database address,
 * tokens and keys, `NODE_OPTIONS`, `npm_*` and `CHROMIUM_PATH` (handed over as a launch option) (#2290).
 */
export function chromiumEnvironment(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (CHROMIUM_ENV_NAMES.has(upper) || CHROMIUM_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) allowed[name] = value;
  }
  return allowed;
}

const execFileAsync = promisify(execFile);

/**
 * A whole number that can name another process: not this server and not 0 or 1. A negative id or 1 handed to
 * `kill` would address a group or every process, so nothing but such a number goes near a command or a signal.
 */
const isOtherProcessId = (pid: number) => Number.isInteger(pid) && pid > 1 && pid !== process.pid;

/** How this module identifies and ends an operating-system process (an object so tests can stand in for it). */
export const osProcess = {
  /**
   * A value that is the same for as long as process `pid` lives and differs for any later process that gets
   * the same id: its start time. `undefined` when the platform offers no way to read it or the process is gone.
   */
  async startToken(pid: number): Promise<string | undefined> {
    if (!isOtherProcessId(pid)) return undefined;
    try {
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        // Field 22, the start time in clock ticks since boot. Counted after the command name, which is in brackets and may hold spaces.
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
      }
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { timeout: 10_000, windowsHide: true });
        return /^\d+$/.test(stdout.trim()) ? stdout.trim() : undefined;
      }
      if (process.platform === "darwin") {
        const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 10_000 });
        return stdout.trim() || undefined;
      }
    } catch {
      // No such process, or the tool is missing: the process cannot be identified.
    }
    return undefined;
  },

  /** End process `pid` at once, with the process group it leads where there is one (Playwright starts Chromium as a group leader). */
  kill(pid: number): boolean {
    if (!isOtherProcessId(pid)) return false;
    try {
      if (process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
          return true;
        } catch {
          // Not a group leader: end the process itself.
        }
      }
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  },
};

interface ProcessIdentity {
  pid: number;
  startToken: string;
}

/** The Chromium process behind each browser this module launched, when it could be read at launch. */
const identities = new WeakMap<Browser, ProcessIdentity>();

/**
 * Ask the browser for its own process id right after launch, and read that process's start time. Nobody
 * waits for the answer: the first render may already be running when it comes. `Browser` exposes no
 * process; the id is only ever used to end a Chromium that will not close (`retire`), and only when the
 * start time read here is still the same right before the kill. Until both are known, a Chromium that will
 * not close is left to Playwright, which ends a browser 30 s after its close was asked.
 */
async function identify(browser: Browser): Promise<void> {
  try {
    const session = await browser.newBrowserCDPSession();
    let pid: number | undefined;
    try {
      const { processInfo } = await session.send("SystemInfo.getProcessInfo");
      pid = processInfo.find((info) => info.type === "browser")?.id;
    } finally {
      await session.detach().catch(() => {});
    }
    if (pid === undefined || !isOtherProcessId(pid)) return;
    const startToken = await osProcess.startToken(pid);
    if (startToken) identities.set(browser, { pid, startToken });
  } catch {
    // Unknown id: a Chromium that will not close is left to Playwright's own close.
  }
}

async function launch(onDisconnected: () => void): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  // CHROMIUM_PATH points at a system Chromium (the Docker image installs Alpine's). Playwright's
  // own download is used when it is unset.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  // A launch gets the time one render gets, not Playwright's own 180 s. A Chromium that hangs while it starts is given
  // up and ended by Playwright then; `retire` waits for that: past the render limit, no longer than the page took to build (#2290).
  const browser = await chromium.launch({ headless: true, executablePath, env: chromiumEnvironment(), timeout: PDF_RENDER_TIMEOUT_MS });
  browser.on("disconnected", onDisconnected);
  console.log(`[pdf] launched Chromium ${browser.version()}`);
  void identify(browser);
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
export async function closeWithin(
  browser: Pick<Browser, "close">,
  timeoutMs: number,
): Promise<Exclude<PdfBrowserCloseOutcome, "idle">> {
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

async function closeBounded(browser: Browser, timeoutMs: number): Promise<Exclude<PdfBrowserCloseOutcome, "idle">> {
  const outcome = await closeWithin(browser, timeoutMs);
  if (outcome === "timed-out") {
    console.warn(`[pdf] browser close still running after ${timeoutMs} ms; leaving it to process exit`);
  }
  return outcome;
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
 * Take the browser of a render that ran past its time limit out of service: the slot is emptied so the next
 * render launches a new one, the browser is closed, and a Chromium that has not closed within
 * `BROWSER_CLOSE_TIMEOUT_MS` is killed. The kill needs the process id read from this very browser at launch
 * and a start time that still matches, so an id the system has given to another process is never hit; without
 * both, the process is left to Playwright, which kills a browser 30 s after its close was asked. Never throws.
 */
async function retire(p: Promise<Browser>): Promise<void> {
  try {
    if (browserPromise === p) browserPromise = null;
    const browser = await p.catch(() => null);
    if (!browser) return;
    if ((await closeWithin(browser, BROWSER_CLOSE_TIMEOUT_MS)) === "closed") return;
    const identity = identities.get(browser);
    const same = identity !== undefined && (await osProcess.startToken(identity.pid)) === identity.startToken;
    if (same && osProcess.kill(identity.pid)) {
      console.warn(`[pdf] Chromium did not close within ${BROWSER_CLOSE_TIMEOUT_MS} ms and was killed`);
    } else {
      console.warn(`[pdf] Chromium did not close within ${BROWSER_CLOSE_TIMEOUT_MS} ms; its process could not be identified, leaving it to Playwright`);
    }
  } catch {
    // Retiring a browser is best effort; the slot is already empty.
  }
}

interface Waiter {
  /** Hand the renderer to this caller. */
  grant: () => void;
}

let running = 0;
const waiting: Waiter[] = [];

/**
 * Wait for the renderer. Resolves when this caller may render; rejects with `PdfBusyError` when
 * `PDF_MAX_WAITING` callers already wait or this one has waited `PDF_QUEUE_WAIT_MS`, and with
 * `PdfCancelledError` when `signal` aborts first: a caller that went away leaves the queue and never renders.
 */
function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PdfCancelledError());
  if (running < PDF_MAX_RUNNING) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= PDF_MAX_WAITING) return Promise.reject(new PdfBusyError("queue-full"));
  return new Promise<void>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const leave = (error: Error) => {
      const at = waiting.indexOf(waiter);
      if (at < 0) return;
      waiting.splice(at, 1);
      settle();
      reject(error);
    };
    const onAbort = () => leave(new PdfCancelledError());
    const timer = setTimeout(() => leave(new PdfBusyError("queue-wait")), PDF_QUEUE_WAIT_MS);
    timer.unref?.();
    const waiter: Waiter = {
      grant: () => {
        settle();
        resolve();
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.push(waiter);
  });
}

/** Give the renderer to the caller that has waited longest, or free it. */
function release() {
  const next = waiting.shift();
  if (next) next.grant();
  else running--;
}

/** Print `html` in an isolated context of `browser`. Closing the context is how an aborted `signal` stops the print. */
async function print(browser: Browser, html: string, signal?: AbortSignal): Promise<Uint8Array> {
  // JavaScript is off: the page is sanitized Markdown, which needs none, and nothing a document carries may run here (#2290).
  const context = await browser.newContext({ offline: true, serviceWorkers: "block", javaScriptEnabled: false });
  const onAbort = () => void context.close().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new PdfCancelledError();
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
    signal?.removeEventListener("abort", onAbort);
    await context.close().catch(() => {});
  }
}

/** The page to print: its HTML, or a function that builds it once this caller has the renderer. */
export type PdfSource = string | (() => Promise<string>);

export interface RenderPdfOptions {
  /** Aborts when the caller goes away: it leaves the queue, or its running print is stopped. */
  signal?: AbortSignal;
}

/**
 * Render a standalone HTML page to a Letter-size PDF with one shared Chromium instance.
 * Each render uses an isolated offline context with JavaScript off and rejects every routed request: PDF
 * input is document-controlled, so all required assets must already be embedded as data URIs.
 *
 * One render runs at a time and at most `PDF_MAX_WAITING` callers wait for it (`PdfBusyError` otherwise).
 * Pass a function as `source` to build the page only once this caller has the renderer, so that waiting
 * callers hold no embedded pictures in memory. A render that takes longer than `PDF_RENDER_TIMEOUT_MS`
 * rejects with `PdfBusyError`, its browser is closed (killed when it will not close) and the next render
 * starts a new one; the renderer is handed on only when that browser is out of the way.
 */
export async function renderPdf(source: PdfSource, { signal }: RenderPdfOptions = {}): Promise<Uint8Array> {
  await acquire(signal);
  inFlight++;
  if (idleTimer) clearTimeout(idleTimer);
  let retiring: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let browser: Promise<Browser> | undefined;
  const timeout = new PdfBusyError("render-timeout");
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout), PDF_RENDER_TIMEOUT_MS);
    timer.unref?.();
  });
  const work = (async () => {
    const html = typeof source === "string" ? source : await source();
    // Past its deadline or without a caller, a render must not go on to use the browser.
    if (stopped) throw timeout;
    if (signal?.aborted) throw new PdfCancelledError();
    browser = getBrowser();
    return print(await browser, html, signal);
  })();
  // A render given up at its deadline settles later, when its browser is closed; nobody awaits it then.
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (err === timeout) {
      stopped = true;
      console.warn(`[pdf] render stopped after ${PDF_RENDER_TIMEOUT_MS} ms; closing Chromium`);
      if (browser) retiring = retire(browser);
    } else if (signal?.aborted && !(err instanceof PdfUnavailableError)) {
      throw new PdfCancelledError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    inFlight--;
    if (inFlight === 0) scheduleIdleClose();
    // The renderer goes to the next caller only once a browser that ran past the limit is out of the way.
    if (retiring) void retiring.then(release);
    else release();
  }
}

/**
 * Close the shared browser (tests and graceful shutdown), waiting at most `timeoutMs`: on a loaded box
 * Chromium's shutdown has outlived a 30 s test hook, so past the bound the close is left running (one warn
 * line) rather than awaited. Reports the browser close outcome directly so callers do not need to infer it
 * from elapsed wall time. A close that fails, or a launch that never succeeded, is silent as before.
 */
export async function closePdfBrowser(timeoutMs = BROWSER_CLOSE_TIMEOUT_MS): Promise<PdfBrowserCloseOutcome> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const p = browserPromise;
  browserPromise = null;
  if (!p) return "idle";

  const launched = await p.then(
    (browser) => ({ status: "launched", browser }) as const,
    () => ({ status: "failed" }) as const,
  );
  if (launched.status === "failed") return "failed";
  return closeBounded(launched.browser, timeoutMs);
}
