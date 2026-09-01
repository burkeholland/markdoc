import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared-browser slot in `pdf.ts` (`let browserPromise`) may only be emptied by the browser it holds
 * (task #1409). `pdf.test.ts` launches a real Chromium and keeps doing so; this file swaps `playwright-core`
 * for fake browsers so the overlap of "old browser still closing" and "new browser launched" — which takes
 * seconds with a real Chromium — is a plain, deterministic sequence of awaits. Everything goes through the
 * public `renderPdf` / `closePdfBrowser`, and each test starts with a fresh module slot.
 */

type PdfModule = typeof import("./pdf");

const { launch } = vi.hoisted(() => ({ launch: vi.fn<() => Promise<unknown>>() }));

vi.mock("playwright-core", () => ({ chromium: { launch } }));

/** The four bytes a PDF starts with (`%PDF`), so a render's result can be told apart from anything else. */
const PDF_MAGIC = [37, 80, 68, 70];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeBrowser {
  readonly name: string;
  on: ReturnType<typeof vi.fn<(event: string, listener: () => void) => FakeBrowser>>;
  newContext: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** Fires this browser's own `disconnected` listeners, as Playwright does when the Chromium process ends. */
  disconnect: () => void;
}

/**
 * Just enough of Playwright's `Browser` for `renderPdf`. `close()` waits for `closeGate` (when given) and then
 * fires `disconnected` before resolving — the order Playwright's `Browser.close()` follows.
 */
function fakeBrowser(name: string, options: { closeGate?: Promise<void> } = {}): FakeBrowser {
  const disconnectedListeners: Array<() => void> = [];
  const browser: FakeBrowser = {
    name,
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "disconnected") disconnectedListeners.push(listener);
      return browser;
    }),
    newContext: vi.fn(async () => ({
      route: async () => {},
      newPage: async () => ({
        setContent: async () => {},
        emulateMedia: async () => {},
        pdf: async () => new Uint8Array(PDF_MAGIC),
      }),
      close: async () => {},
    })),
    close: vi.fn(async () => {
      await options.closeGate;
      browser.disconnect();
    }),
    disconnect: () => {
      for (const listener of disconnectedListeners) listener();
    },
  };
  return browser;
}

describe("shared browser handle", () => {
  let pdf: PdfModule;

  beforeEach(async () => {
    launch.mockReset();
    vi.resetModules();
    pdf = await import("./pdf");
  });

  afterEach(async () => {
    // Clears the idle timer and closes whatever the slot still holds when a test failed midway.
    await pdf.closePdfBrowser();
  });

  it("keeps the replacement browser when the superseded browser's close finishes (regression)", async () => {
    const closeA = deferred();
    const A = fakeBrowser("A", { closeGate: closeA.promise });
    const B = fakeBrowser("B");
    const C = fakeBrowser("C");
    launch.mockResolvedValueOnce(A).mockResolvedValueOnce(B).mockResolvedValueOnce(C);

    await pdf.renderPdf("<p>a</p>");
    expect(launch).toHaveBeenCalledTimes(1);

    // Empties the slot and starts closing A; A's Chromium is held mid-shutdown.
    const closing = pdf.closePdfBrowser();

    await pdf.renderPdf("<p>b</p>");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(A.close).toHaveBeenCalledTimes(1);

    // A's process ends now: its `disconnected` fires while B owns the slot.
    closeA.resolve();
    await closing;

    await pdf.renderPdf("<p>c</p>");
    expect(launch, "the render after A's close must reuse B, not launch a third browser").toHaveBeenCalledTimes(2);

    await pdf.closePdfBrowser();
    expect(B.close, "B was still the shared browser, so closing the shared browser closes B").toHaveBeenCalledTimes(1);
  });

  it("recovers from a failed launch: the render rejects with PdfUnavailableError and the next one launches again", async () => {
    const boom = new Error("chromium missing");
    const B = fakeBrowser("B");
    launch.mockRejectedValueOnce(boom).mockResolvedValueOnce(B);

    const failure = await pdf.renderPdf("<p>a</p>").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(pdf.PdfUnavailableError);
    expect((failure as Error).cause).toBe(boom);
    expect(launch).toHaveBeenCalledTimes(1);

    const bytes = await pdf.renderPdf("<p>b</p>");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(Array.from(bytes)).toEqual(PDF_MAGIC);

    await pdf.closePdfBrowser();
    expect(B.close).toHaveBeenCalledTimes(1);
  });

  it("a superseded launch that fails afterwards leaves the replacement browser in place", async () => {
    const launchA = deferred<FakeBrowser>();
    const launchAStarted = deferred();
    const B = fakeBrowser("B");
    const C = fakeBrowser("C");
    launch
      .mockImplementationOnce(() => {
        launchAStarted.resolve();
        return launchA.promise;
      })
      .mockResolvedValueOnce(B)
      .mockResolvedValueOnce(C);

    const first = pdf.renderPdf("<p>a</p>").catch((error: unknown) => error);
    await launchAStarted.promise;
    expect(launch).toHaveBeenCalledTimes(1);

    // Drops A's pending launch from the slot and waits for it to settle before closing it.
    const closing = pdf.closePdfBrowser();

    await pdf.renderPdf("<p>b</p>");
    expect(launch).toHaveBeenCalledTimes(2);

    // A's launch fails now, while B owns the slot.
    launchA.reject(new Error("chromium missing"));
    expect(await first).toBeInstanceOf(pdf.PdfUnavailableError);
    await closing;

    await pdf.renderPdf("<p>c</p>");
    expect(launch, "the render after A's failed launch must reuse B, not launch a third browser").toHaveBeenCalledTimes(2);

    await pdf.closePdfBrowser();
    expect(B.close, "B was still the shared browser, so closing the shared browser closes B").toHaveBeenCalledTimes(1);
  });

  it("still drops a browser that disconnects on its own, so the next render launches a new one", async () => {
    const A = fakeBrowser("A");
    const B = fakeBrowser("B");
    launch.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

    await pdf.renderPdf("<p>a</p>");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(A.on).toHaveBeenCalledWith("disconnected", expect.any(Function));

    // The Chromium process died; nobody called close.
    A.disconnect();

    const bytes = await pdf.renderPdf("<p>b</p>");
    expect(launch).toHaveBeenCalledTimes(2);
    expect(Array.from(bytes)).toEqual(PDF_MAGIC);

    await pdf.closePdfBrowser();
    expect(A.close).not.toHaveBeenCalled();
    expect(B.close).toHaveBeenCalledTimes(1);
  });
});
