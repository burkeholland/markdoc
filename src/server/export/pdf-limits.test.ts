import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The limits around the PDF renderer (#2290): JavaScript off, a short environment for Chromium, one render
 * at a time with a bounded queue, a time limit per render, and callers that go away. `playwright-core` is
 * replaced by fake browsers so that "a print that never finishes" and "a close that never finishes" are
 * plain awaits; `pdf.test.ts` keeps rendering with a real Chromium. Each test starts with a fresh module.
 */

type PdfModule = typeof import("./pdf");

const { launch } = vi.hoisted(() => ({ launch: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>() }));

vi.mock("playwright-core", () => ({ chromium: { launch } }));

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

interface FakeContext {
  options: Record<string, unknown>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface FakeBrowser {
  readonly name: string;
  /** While true, `page.pdf()` waits until `finishPrint()` (or until its context is closed, which rejects it). */
  hold: boolean;
  contexts: FakeContext[];
  on: (event: string, listener: () => void) => FakeBrowser;
  version: () => string;
  newBrowserCDPSession?: () => Promise<unknown>;
  newContext: ReturnType<typeof vi.fn<(options: Record<string, unknown>) => Promise<unknown>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** Let the oldest waiting print finish. */
  finishPrint: () => void;
  /** Prints that are waiting right now. */
  printing: () => number;
  /** How many times `page.pdf()` was called on this browser. */
  prints: number;
  /** The pages handed to this browser, in the order they came. */
  pages: string[];
}

/** Just enough of Playwright's `Browser`. `pid` makes it answer the process question the way Chromium does. */
function fakeBrowser(name: string, options: { pid?: number; closeGate?: Promise<void> } = {}): FakeBrowser {
  const disconnected: Array<() => void> = [];
  const gates: Array<ReturnType<typeof deferred<Uint8Array>>> = [];
  const browser: FakeBrowser = {
    name,
    hold: false,
    contexts: [],
    on: (event, listener) => {
      if (event === "disconnected") disconnected.push(listener);
      return browser;
    },
    version: () => `1.2.3.${name}`,
    newContext: vi.fn(async (contextOptions: Record<string, unknown>) => {
      const closed = deferred<never>();
      closed.promise.catch(() => {});
      const context: FakeContext = {
        options: contextOptions,
        close: vi.fn(async () => closed.reject(new Error("Target page, context or browser has been closed"))),
      };
      browser.contexts.push(context);
      return {
        route: async () => {},
        newPage: async () => ({
          setContent: async (html: string) => {
            browser.pages.push(html);
          },
          emulateMedia: async () => {},
          pdf: () => {
            browser.prints++;
            if (!browser.hold) return Promise.resolve(new Uint8Array(PDF_MAGIC));
            const gate = deferred<Uint8Array>();
            gates.push(gate);
            return Promise.race([gate.promise, closed.promise]);
          },
        }),
        close: context.close,
      };
    }),
    close: vi.fn(async () => {
      await options.closeGate;
      for (const listener of disconnected) listener();
    }),
    finishPrint: () => gates.shift()?.resolve(new Uint8Array(PDF_MAGIC)),
    printing: () => gates.length,
    prints: 0,
    pages: [],
  };
  if (options.pid !== undefined) {
    browser.newBrowserCDPSession = async () => ({
      send: async (method: string) => {
        if (method !== "SystemInfo.getProcessInfo") throw new Error(`unexpected ${method}`);
        return { processInfo: [{ type: "GPU", id: 4242, cpuTime: 0 }, { type: "browser", id: options.pid, cpuTime: 0 }] };
      },
      detach: async () => {},
    });
  }
  return browser;
}

/** Let everything that is ready run (real timers). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** What a rejected promise rejected with (`undefined` when it resolved). */
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("PDF renderer limits (#2290)", () => {
  let pdf: PdfModule;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    launch.mockReset();
    vi.resetModules();
    pdf = await import("./pdf");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pdf.closePdfBrowser();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("the rendering context", () => {
    it("prints with JavaScript off, offline, and service workers blocked", async () => {
      const A = fakeBrowser("A");
      launch.mockResolvedValueOnce(A);

      await pdf.renderPdf("<p>a</p>");

      expect(A.contexts).toHaveLength(1);
      expect(A.contexts[0].options).toEqual({ offline: true, serviceWorkers: "block", javaScriptEnabled: false });
    });
  });

  describe("the environment Chromium starts with", () => {
    // The test's own copy of the rule, so that a name added to the list in pdf.ts by mistake fails here.
    const ALLOWED = new Set([
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TMP", "TEMP", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
      "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
    ]);
    const allowed = (name: string) => {
      const upper = name.toUpperCase();
      return ALLOWED.has(upper) || upper.startsWith("LC_") || upper.startsWith("XDG_") || upper.startsWith("PROGRAMFILES");
    };
    const SECRET_LOOKING = [
      "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_URL", "AUTH_DEV_LOGIN", "DATABASE_URL", "PGPASSWORD", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_APP_PRIVATE_KEY",
      "MARKDOC_API_TOKEN", "WEBHOOK_SIGNING_KEY", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET", "NODE_OPTIONS", "npm_config_registry", "npm_package_name", "CHROMIUM_PATH",
      "PGLITE_DATA_DIR", "MARKDOC_URL", "TRUST_PROXY", "PORT", "HOST", "NODE_ENV", "APP_VERSION", "SOME_PASSWORD", "MY_API_KEY",
      // An allowed family's letters in the middle of a name: the families are matched at the start only.
      "MY_LC_TOKEN", "APP_XDG_SECRET", "OLD_PROGRAMFILES_KEY",
    ];

    it("hands over allow-listed names only, whatever the server's environment holds", async () => {
      for (const name of SECRET_LOOKING) vi.stubEnv(name, `value-of-${name}`);
      vi.stubEnv("HOME", "/home/node");
      vi.stubEnv("LC_ALL", "C.UTF-8");
      vi.stubEnv("XDG_CACHE_HOME", "/tmp/cache");
      vi.stubEnv("FONTCONFIG_FILE", "/etc/fonts/fonts.conf");
      launch.mockResolvedValueOnce(fakeBrowser("A"));

      await pdf.renderPdf("<p>a</p>");

      expect(launch).toHaveBeenCalledTimes(1);
      const options = launch.mock.calls[0][0] as { env: Record<string, string>; executablePath?: string; headless: boolean };
      expect(options.headless).toBe(true);
      // The executable still reaches Playwright, as an option rather than through the child's environment.
      expect(options.executablePath).toBe("value-of-CHROMIUM_PATH");
      const names = Object.keys(options.env);
      expect(names.filter((name) => !allowed(name)), "names outside the allow-list that reached Chromium").toEqual([]);
      for (const name of SECRET_LOOKING) expect(names, name).not.toContain(name);
      expect(JSON.stringify(options.env)).not.toContain("value-of-");
      expect(options.env).toMatchObject({ HOME: "/home/node", LC_ALL: "C.UTF-8", XDG_CACHE_HOME: "/tmp/cache", FONTCONFIG_FILE: "/etc/fonts/fonts.conf" });
      // Every allowed name the server has is passed on unchanged.
      for (const [name, value] of Object.entries(process.env)) if (allowed(name)) expect(options.env[name], name).toBe(value);
    });

    it("keeps system names in any spelling and drops every other name", () => {
      const env = pdf.chromiumEnvironment({
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LC_CTYPE: "en_US.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1000",
        TZ: "UTC",
        AUTH_SECRET: "s",
        DATABASE_URL: "postgres://",
        PATH_TO_KEY: "/k",
        HOMEPAGE_TOKEN: "t",
        MY_LC_TOKEN: "t",
        APP_XDG_SECRET: "s",
        NODE_OPTIONS: "--inspect",
        npm_config_token: "t",
        CHROMIUM_PATH: "/usr/bin/chromium-browser",
        UNSET: undefined,
      });
      expect(env).toEqual({
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LC_CTYPE: "en_US.UTF-8",
        XDG_RUNTIME_DIR: "/run/user/1000",
        TZ: "UTC",
      });
    });
  });

  describe("the launch log line", () => {
    it("logs the version Chromium reports, once per launch and nothing else", async () => {
      vi.stubEnv("AUTH_SECRET", "value-of-AUTH_SECRET");
      launch.mockResolvedValueOnce(fakeBrowser("A"));

      await pdf.renderPdf("<p>a</p>");
      await pdf.renderPdf("<p>b</p>");

      expect(log.mock.calls).toEqual([["[pdf] launched Chromium 1.2.3.A"]]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("one render at a time", () => {
    it("starts the next render only when the one before it has finished, in arrival order", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const order: string[] = [];

      const renders = ["one", "two", "three"].map((name) => pdf.renderPdf(`<p>${name}</p>`).then(() => order.push(name)));
      await settle();
      expect(A.newContext, "only the first render may have a context").toHaveBeenCalledTimes(1);
      expect(A.printing()).toBe(1);

      A.finishPrint();
      await settle();
      expect(order).toEqual(["one"]);
      expect(A.newContext).toHaveBeenCalledTimes(2);
      expect(A.printing()).toBe(1);

      A.finishPrint();
      await settle();
      A.finishPrint();
      await Promise.all(renders);
      expect(order).toEqual(["one", "two", "three"]);
      expect(launch, "all three share one browser").toHaveBeenCalledTimes(1);
    });

    it("builds the page only once the caller has the renderer, and frees the renderer when building fails", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const built: string[] = [];
      const refused = new Error("Document is not renderable");

      const first = pdf.renderPdf(async () => (built.push("first"), "<p>first</p>"));
      const second = failure(pdf.renderPdf(async () => {
        built.push("second");
        throw refused;
      }));
      const third = pdf.renderPdf(async () => (built.push("third"), "<p>third</p>"));
      await settle();
      expect(built, "waiting callers hold no page").toEqual(["first"]);

      A.finishPrint();
      await first;
      expect(await second, "the builder's own error reaches the caller unchanged").toBe(refused);
      await settle();
      expect(built).toEqual(["first", "second", "third"]);
      A.finishPrint();
      expect(Array.from(await third)).toEqual(PDF_MAGIC);
    });
  });

  describe("the queue", () => {
    it("lets PDF_MAX_WAITING callers wait and refuses one more at once with a retry hint", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      const admitted = Array.from({ length: pdf.PDF_MAX_RUNNING + pdf.PDF_MAX_WAITING }, (_, n) => pdf.renderPdf(`<p>${n}</p>`));
      await settle();
      const started = performance.now();
      const refused = await failure(pdf.renderPdf("<p>one too many</p>"));

      expect(refused).toBeInstanceOf(pdf.PdfBusyError);
      expect((refused as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("queue-full");
      expect((refused as InstanceType<PdfModule["PdfBusyError"]>).retryAfter).toBe(pdf.PDF_RETRY_AFTER_SECONDS);
      expect((refused as Error).message).toBe("PDF export is busy. Try again in a few seconds");
      expect(performance.now() - started, "refused without waiting").toBeLessThan(1_000);
      expect(A.newContext, "the refused caller never rendered").toHaveBeenCalledTimes(1);

      // Everyone who was admitted gets a PDF, one after the other.
      for (let n = 0; n < admitted.length; n++) {
        await settle();
        A.finishPrint();
      }
      for (const render of admitted) expect(Array.from(await render)).toEqual(PDF_MAGIC);
      expect(A.newContext).toHaveBeenCalledTimes(admitted.length);
      expect({ running: pdf.PDF_MAX_RUNNING, waiting: pdf.PDF_MAX_WAITING }).toEqual({ running: 1, waiting: 8 });
    });

    it("refuses a caller that has waited PDF_QUEUE_WAIT_MS, and that caller never renders", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      const first = pdf.renderPdf("<p>first</p>");
      await vi.advanceTimersByTimeAsync(0);
      const waiting = failure(pdf.renderPdf("<p>waiting</p>"));
      await vi.advanceTimersByTimeAsync(pdf.PDF_QUEUE_WAIT_MS - 1);
      let settled = false;
      void waiting.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled, "still waiting just before the limit").toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const refused = await waiting;
      expect(refused).toBeInstanceOf(pdf.PdfBusyError);
      expect((refused as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("queue-wait");
      expect((refused as InstanceType<PdfModule["PdfBusyError"]>).retryAfter).toBe(pdf.PDF_RETRY_AFTER_SECONDS);
      expect(pdf.PDF_QUEUE_WAIT_MS).toBe(30_000);

      A.finishPrint();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(A.newContext, "the caller that gave up waiting was never rendered").toHaveBeenCalledTimes(1);
    });
  });

  describe("sharing between callers", () => {
    /** The pages in the order they were handed to the browser: the order of turns. */
    const printed = (browser: FakeBrowser) => browser.pages;

    it("gives the turn to the caller that has used the renderer least, not to the one that asked first", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      // The heavy user holds the renderer for 12 s and has two more requests waiting when the small one asks twice.
      const renders = [
        pdf.renderPdf("<p>heavy 1</p>", { userId: "heavy" }),
        pdf.renderPdf("<p>heavy 2</p>", { userId: "heavy" }),
        pdf.renderPdf("<p>heavy 3</p>", { userId: "heavy" }),
      ];
      await vi.advanceTimersByTimeAsync(12_000);
      renders.push(pdf.renderPdf("<p>small 1</p>", { userId: "small" }), pdf.renderPdf("<p>small 2</p>", { userId: "small" }));
      await vi.advanceTimersByTimeAsync(0);

      for (let n = 0; n < renders.length; n++) {
        A.finishPrint();
        await vi.advanceTimersByTimeAsync(100);
      }
      await Promise.all(renders);

      expect(printed(A)).toEqual(["<p>heavy 1</p>", "<p>small 1</p>", "<p>small 2</p>", "<p>heavy 2</p>", "<p>heavy 3</p>"]);
    });

    it("counts everybody without a user id as one caller, and puts a signed-in user ahead of them once they have used the renderer more", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      const renders = [pdf.renderPdf("<p>visitor 1</p>")];
      await vi.advanceTimersByTimeAsync(12_000);
      // Three more requests without a session, then the user.
      for (const n of [2, 3, 4]) renders.push(pdf.renderPdf(`<p>visitor ${n}</p>`));
      renders.push(pdf.renderPdf("<p>user</p>", { userId: "u1" }));
      await vi.advanceTimersByTimeAsync(0);

      for (let n = 0; n < renders.length; n++) {
        A.finishPrint();
        await vi.advanceTimersByTimeAsync(100);
      }
      await Promise.all(renders);

      expect(printed(A)).toEqual(["<p>visitor 1</p>", "<p>user</p>", "<p>visitor 2</p>", "<p>visitor 3</p>", "<p>visitor 4</p>"]);
    });

    it("keeps two users apart, and a user apart from a caller without a session whatever its id spells", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      // "anonymous" as a user id is still a user: it does not share the use of the callers without a session.
      const renders = [pdf.renderPdf("<p>visitor 1</p>")];
      await vi.advanceTimersByTimeAsync(12_000);
      renders.push(pdf.renderPdf("<p>visitor 2</p>"), pdf.renderPdf("<p>user named anonymous</p>", { userId: "anonymous" }), pdf.renderPdf("<p>another user</p>", { userId: "u2" }));
      await vi.advanceTimersByTimeAsync(0);

      for (let n = 0; n < renders.length; n++) {
        A.finishPrint();
        await vi.advanceTimersByTimeAsync(100);
      }
      await Promise.all(renders);

      expect(printed(A)).toEqual(["<p>visitor 1</p>", "<p>user named anonymous</p>", "<p>another user</p>", "<p>visitor 2</p>"]);
    });

    it("gives a newcomer a place when one caller holds the whole queue, and tells the caller that lost it to try again", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);

      const running = pdf.renderPdf("<p>running</p>");
      const waiting = Array.from({ length: pdf.PDF_MAX_WAITING }, (_, n) => failure(pdf.renderPdf(`<p>waiting ${n}</p>`)));
      await settle();
      const newcomer = pdf.renderPdf("<p>newcomer</p>", { userId: "u1" });
      await settle();

      const lost = await Promise.race([waiting.at(-1)!, settle().then(() => "still waiting")]);
      expect(lost, "the newest request of the caller that held every place made room").toBeInstanceOf(pdf.PdfBusyError);
      expect((lost as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("place-given");
      expect((lost as InstanceType<PdfModule["PdfBusyError"]>).retryAfter).toBe(pdf.PDF_RETRY_AFTER_SECONDS);
      expect((lost as Error).message).toBe("PDF export is busy. Try again in a few seconds");
      expect(warn.mock.calls, "why, and of the caller only whether it is signed in").toEqual([["[pdf] export refused: place-given, anonymous caller, 8 waiting"]]);

      // The same caller's own next request finds no room and takes nobody's place.
      const again = await failure(pdf.renderPdf("<p>again</p>"));
      expect((again as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("queue-full");
      expect(warn.mock.calls.at(-1)).toEqual(["[pdf] export refused: queue-full, anonymous caller, 8 waiting"]);

      // The newcomer has used nothing: it prints right after the running render.
      A.finishPrint();
      await running;
      await settle();
      A.finishPrint();
      expect(Array.from(await newcomer)).toEqual(PDF_MAGIC);
      expect(printed(A)).toEqual(["<p>running</p>", "<p>newcomer</p>"]);
      for (let n = 0; n < pdf.PDF_MAX_WAITING; n++) {
        await settle();
        A.finishPrint();
      }
      expect((await Promise.all(waiting.slice(0, -1))).every((error) => error === undefined), "the seven older requests all got their PDF").toBe(true);
    });

    it("says in the log that a signed-in caller was refused, and nothing that names it", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const userId = "user-id-that-must-not-be-logged";

      const first = pdf.renderPdf("<p>first</p>", { userId });
      await vi.advanceTimersByTimeAsync(0);
      const waited = failure(pdf.renderPdf("<p>waiting</p>", { userId }));
      await vi.advanceTimersByTimeAsync(pdf.PDF_QUEUE_WAIT_MS);

      expect(((await waited) as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("queue-wait");
      expect(warn.mock.calls).toEqual([["[pdf] export refused: queue-wait, signed in caller, 0 waiting"]]);
      A.finishPrint();
      await first;
    });

    it("logs nothing for a caller that went away while it waited", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const gone = new AbortController();

      const first = pdf.renderPdf("<p>first</p>");
      await settle();
      const leaving = failure(pdf.renderPdf("<p>leaving</p>", { signal: gone.signal, userId: "u1" }));
      await settle();
      gone.abort();

      expect(await leaving).toBeInstanceOf(pdf.PdfCancelledError);
      expect(warn).not.toHaveBeenCalled();
      A.finishPrint();
      await first;
    });

    it("forgets use by half every minute", () => {
      expect(pdf.PDF_USAGE_HALF_LIFE_MS).toBe(60_000);
    });
  });

  describe("a caller that goes away", () => {
    it("does not launch or render for a request that is already aborted", async () => {
      const gone = new AbortController();
      gone.abort();

      const error = await failure(pdf.renderPdf("<p>a</p>", { signal: gone.signal }));

      expect(error).toBeInstanceOf(pdf.PdfCancelledError);
      expect(launch).not.toHaveBeenCalled();
    });

    it("takes no place in the queue and builds no page when the request is already aborted", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const built: string[] = [];
      const gone = new AbortController();
      gone.abort();

      const first = pdf.renderPdf("<p>first</p>");
      await settle();
      let answer: unknown = "still waiting";
      void failure(pdf.renderPdf(async () => (built.push("gone"), "<p>gone</p>"), { signal: gone.signal })).then((error) => (answer = error));
      await settle();
      expect(answer, "refused at once, not left waiting for the renderer").toBeInstanceOf(pdf.PdfCancelledError);

      A.finishPrint();
      await first;
      await settle();
      expect(built, "no page is built for a caller that is already gone").toEqual([]);
      expect(A.newContext).toHaveBeenCalledTimes(1);
    });

    it("leaves the queue, never renders, and makes room for another caller", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const built: string[] = [];
      const gone = new AbortController();

      const first = pdf.renderPdf("<p>first</p>");
      const others = Array.from({ length: pdf.PDF_MAX_WAITING - 1 }, (_, n) => pdf.renderPdf(`<p>${n}</p>`));
      const leaving = failure(pdf.renderPdf(async () => (built.push("leaving"), "<p>leaving</p>"), { signal: gone.signal }));
      await settle();
      expect(await failure(pdf.renderPdf("<p>no room</p>")), "the queue is full").toBeInstanceOf(pdf.PdfBusyError);

      gone.abort();
      expect(await leaving).toBeInstanceOf(pdf.PdfCancelledError);
      // Its place is free again: this caller is admitted instead of refused.
      const late = pdf.renderPdf(async () => (built.push("late"), "<p>late</p>"));

      for (let n = 0; n < pdf.PDF_MAX_WAITING + 1; n++) {
        await settle();
        A.finishPrint();
      }
      await Promise.all([first, ...others, late]);
      expect(built, "the caller that went away never built or rendered a page").toEqual(["late"]);
      expect(A.newContext).toHaveBeenCalledTimes(pdf.PDF_MAX_WAITING + 1);
    });

    it("stops its running print by closing the context, and the next caller renders", async () => {
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValueOnce(A);
      const gone = new AbortController();

      const running = failure(pdf.renderPdf("<p>running</p>", { signal: gone.signal }));
      const next = pdf.renderPdf("<p>next</p>");
      await settle();
      expect(A.printing()).toBe(1);

      gone.abort();
      expect(await running).toBeInstanceOf(pdf.PdfCancelledError);
      expect(A.contexts[0].close).toHaveBeenCalled();
      expect(A.close, "the browser is healthy and stays").not.toHaveBeenCalled();

      await settle();
      A.finishPrint();
      A.finishPrint();
      expect(Array.from(await next)).toEqual(PDF_MAGIC);
      expect(launch).toHaveBeenCalledTimes(1);
    });

    it("gets no Chromium when it goes away while its page is being built", async () => {
      launch.mockResolvedValue(fakeBrowser("A"));
      const page = deferred<string>();
      const gone = new AbortController();

      const leaving = failure(pdf.renderPdf(() => page.promise, { signal: gone.signal }));
      await settle();
      gone.abort();
      page.resolve("<p>built for nobody</p>");

      expect(await leaving).toBeInstanceOf(pdf.PdfCancelledError);
      expect(launch, "no Chromium is started for a caller that is gone").not.toHaveBeenCalled();
      // The renderer is free: the next caller renders.
      expect(Array.from(await pdf.renderPdf("<p>next</p>"))).toEqual(PDF_MAGIC);
    });

    it("hands the renderer on at once when its page builder stops for it, still charges it for the time it held the renderer, and logs nothing", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      launch.mockResolvedValue(A);
      const gone = new AbortController();
      // A page builder that follows the caller's signal, as the export route's does: it stops with the signal's reason.
      const stopsWhenTheCallerLeaves = () => new Promise<string>((_, reject) => gone.signal.addEventListener("abort", () => reject(gone.signal.reason), { once: true }));

      const leaving = failure(pdf.renderPdf(stopsWhenTheCallerLeaves, { signal: gone.signal, userId: "heavy" }));
      // The same user asks again, and only then somebody else: by arrival the user's second request would be next.
      const again = pdf.renderPdf("<p>heavy again</p>", { userId: "heavy" });
      const small = pdf.renderPdf("<p>small</p>", { userId: "small" });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(A.pages, "the page is still being built: nobody else has the renderer").toEqual([]);

      gone.abort();
      const leftAt = Date.now();
      expect(await leaving).toBeInstanceOf(pdf.PdfCancelledError);
      await Promise.all([again, small]);

      // Both pages are printed without the clock having moved since the caller left: the renderer was handed on at once.
      // The other user's page went first: the 12 s count against the user whose caller left.
      expect(Date.now()).toBe(leftAt);
      expect(A.pages).toEqual(["<p>small</p>", "<p>heavy again</p>"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("is not printed when it goes away while Chromium is starting", async () => {
      const A = fakeBrowser("A");
      const starting = deferred<FakeBrowser>();
      launch.mockReturnValueOnce(starting.promise);
      const gone = new AbortController();

      const leaving = failure(pdf.renderPdf("<p>leaving</p>", { signal: gone.signal }));
      await settle();
      expect(launch).toHaveBeenCalledTimes(1);
      gone.abort();
      starting.resolve(A);

      expect(await leaving).toBeInstanceOf(pdf.PdfCancelledError);
      expect(A.prints, "nothing is printed for a caller that is gone").toBe(0);
      expect(A.contexts[0].close, "the context made for it is closed").toHaveBeenCalled();
      expect(A.close, "the browser is healthy and stays").not.toHaveBeenCalled();
      expect(Array.from(await pdf.renderPdf("<p>next</p>"))).toEqual(PDF_MAGIC);
      expect(launch, "the next caller uses the same browser").toHaveBeenCalledTimes(1);
    });
  });

  describe("a render that runs too long", () => {
    it("fails at PDF_RENDER_TIMEOUT_MS, closes the browser, and a waiting caller gets a PDF from a new one", async () => {
      vi.useFakeTimers();
      const kill = vi.spyOn(pdf.osProcess, "kill").mockReturnValue(true);
      vi.spyOn(pdf.osProcess, "startToken").mockResolvedValue("started-1");
      const A = fakeBrowser("A", { pid: 31337 });
      A.hold = true;
      const B = fakeBrowser("B");
      launch.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

      const hung = failure(pdf.renderPdf("<p>hung</p>"));
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS - 20_000);
      const waiting = pdf.renderPdf("<p>waiting</p>");
      await vi.advanceTimersByTimeAsync(20_000 - 1);
      expect(A.close, "not before the limit").not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const error = await hung;
      expect(error).toBeInstanceOf(pdf.PdfBusyError);
      expect((error as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("render-timeout");
      expect((error as InstanceType<PdfModule["PdfBusyError"]>).retryAfter).toBeUndefined();
      expect((error as Error).message).toBe("This PDF took longer than 60 seconds to make and was stopped");
      expect(pdf.PDF_RENDER_TIMEOUT_MS).toBe(60_000);
      expect(A.close).toHaveBeenCalledTimes(1);

      expect(Array.from(await waiting)).toEqual(PDF_MAGIC);
      expect(launch, "the next render starts a new browser").toHaveBeenCalledTimes(2);
      expect(B.newContext).toHaveBeenCalledTimes(1);
      expect(A.newContext, "the old browser gets no further render").toHaveBeenCalledTimes(1);
      // The close finished in time: nothing is killed.
      expect(kill).not.toHaveBeenCalled();
      expect(warn.mock.calls).toEqual([["[pdf] render stopped after 60000 ms; closing Chromium"]]);
    });

    it("kills a Chromium that has not closed within the close bound, by the id it reported at launch, and only then hands the renderer on", async () => {
      vi.useFakeTimers();
      const kill = vi.spyOn(pdf.osProcess, "kill").mockReturnValue(true);
      const startToken = vi.spyOn(pdf.osProcess, "startToken").mockResolvedValue("started-1");
      const A = fakeBrowser("A", { pid: 31337, closeGate: new Promise<void>(() => {}) });
      A.hold = true;
      const B = fakeBrowser("B");
      launch.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

      const hung = failure(pdf.renderPdf("<p>hung</p>"));
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS - 10_000);
      const waiting = pdf.renderPdf("<p>waiting</p>");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await hung).toBeInstanceOf(pdf.PdfBusyError);

      await vi.advanceTimersByTimeAsync(pdf.BROWSER_CLOSE_TIMEOUT_MS - 1);
      expect(kill, "not before the close bound").not.toHaveBeenCalled();
      expect(launch, "the renderer is not handed on while the old Chromium is still there").toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(kill.mock.calls).toEqual([[31337]]);
      expect(startToken.mock.calls, "read at launch, and again right before the kill").toEqual([[31337], [31337]]);
      expect(Array.from(await waiting)).toEqual(PDF_MAGIC);
      expect(launch).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([
        ["[pdf] render stopped after 60000 ms; closing Chromium"],
        ["[pdf] Chromium did not close within 10000 ms and was killed"],
      ]);
    });

    it("kills nothing when the browser's process id is unknown, and still moves on after the close bound", async () => {
      vi.useFakeTimers();
      const kill = vi.spyOn(pdf.osProcess, "kill").mockReturnValue(true);
      const startToken = vi.spyOn(pdf.osProcess, "startToken").mockResolvedValue("started-1");
      // No `pid`: this browser cannot say which process it is.
      const A = fakeBrowser("A", { closeGate: new Promise<void>(() => {}) });
      A.hold = true;
      const B = fakeBrowser("B");
      launch.mockResolvedValueOnce(A).mockResolvedValueOnce(B);

      const hung = failure(pdf.renderPdf("<p>hung</p>"));
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS - 10_000);
      const waiting = pdf.renderPdf("<p>waiting</p>");
      await vi.advanceTimersByTimeAsync(10_000 + pdf.BROWSER_CLOSE_TIMEOUT_MS);

      expect(await hung).toBeInstanceOf(pdf.PdfBusyError);
      expect(Array.from(await waiting)).toEqual(PDF_MAGIC);
      expect(kill).not.toHaveBeenCalled();
      expect(startToken).not.toHaveBeenCalled();
      expect(warn.mock.calls.at(-1)).toEqual(["[pdf] Chromium did not close within 10000 ms; its process could not be identified, leaving it to Playwright"]);
    });

    it("kills nothing when the process with that id is no longer the one that was launched", async () => {
      vi.useFakeTimers();
      const kill = vi.spyOn(pdf.osProcess, "kill").mockReturnValue(true);
      // The id now belongs to a process that started later.
      vi.spyOn(pdf.osProcess, "startToken").mockResolvedValueOnce("started-1").mockResolvedValue("started-2");
      const A = fakeBrowser("A", { pid: 31337, closeGate: new Promise<void>(() => {}) });
      A.hold = true;
      launch.mockResolvedValueOnce(A).mockResolvedValueOnce(fakeBrowser("B"));

      const hung = failure(pdf.renderPdf("<p>hung</p>"));
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS + pdf.BROWSER_CLOSE_TIMEOUT_MS);

      expect(await hung).toBeInstanceOf(pdf.PdfBusyError);
      expect(kill).not.toHaveBeenCalled();
      expect(Array.from(await pdf.renderPdf("<p>next</p>"))).toEqual(PDF_MAGIC);
    });

    it("never takes a process id that is this server's own or a system one", async () => {
      vi.useFakeTimers();
      const kill = vi.spyOn(pdf.osProcess, "kill").mockReturnValue(true);
      const startToken = vi.spyOn(pdf.osProcess, "startToken").mockResolvedValue("started-1");
      for (const pid of [process.pid, 1, 0, -5, 2.5]) {
        vi.resetModules();
        launch.mockReset();
        const fresh = await import("./pdf");
        const freshKill = vi.spyOn(fresh.osProcess, "kill").mockReturnValue(true);
        const freshToken = vi.spyOn(fresh.osProcess, "startToken").mockResolvedValue("started-1");
        const A = fakeBrowser("A", { pid, closeGate: new Promise<void>(() => {}) });
        A.hold = true;
        launch.mockResolvedValueOnce(A);

        const hung = failure(fresh.renderPdf("<p>hung</p>"));
        await vi.advanceTimersByTimeAsync(fresh.PDF_RENDER_TIMEOUT_MS + fresh.BROWSER_CLOSE_TIMEOUT_MS);

        expect(await hung, String(pid)).toBeInstanceOf(fresh.PdfBusyError);
        expect(freshKill, String(pid)).not.toHaveBeenCalled();
        expect(freshToken, String(pid)).not.toHaveBeenCalled();
        await fresh.closePdfBrowser(1);
      }
      expect(kill).not.toHaveBeenCalled();
      expect(startToken).not.toHaveBeenCalled();
    });

    it("gives a launch the render limit, so a Chromium that hangs while it starts holds the renderer no longer than that", async () => {
      vi.useFakeTimers();
      // Like Playwright: a launch that gets no answer rejects when its `timeout` option runs out, and never without one.
      launch.mockImplementationOnce(
        (options) =>
          new Promise((_, reject) => {
            const limit = options.timeout;
            if (typeof limit === "number") setTimeout(() => reject(new Error(`browserType.launch: Timeout ${limit}ms exceeded.`)), limit);
          }),
      );
      const B = fakeBrowser("B");
      launch.mockResolvedValueOnce(B);

      const hung = failure(pdf.renderPdf("<p>hung</p>"));
      await vi.advanceTimersByTimeAsync(0);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][0]).toMatchObject({ timeout: pdf.PDF_RENDER_TIMEOUT_MS });
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS - 5_000);
      let served: number[] | undefined;
      void pdf.renderPdf("<p>waiting</p>").then((bytes) => (served = Array.from(bytes)), () => {});
      await vi.advanceTimersByTimeAsync(5_000);

      const error = await hung;
      expect(error).toBeInstanceOf(pdf.PdfBusyError);
      expect((error as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("render-timeout");
      await vi.advanceTimersByTimeAsync(pdf.BROWSER_CLOSE_TIMEOUT_MS);
      expect(served, "the waiting caller is served within the close bound after the limit, not when Playwright's own 180 s are over").toEqual(PDF_MAGIC);
      expect(launch, "from a new browser").toHaveBeenCalledTimes(2);
      expect(B.newContext).toHaveBeenCalledTimes(1);

      // Nothing is left running or waiting: the next caller renders at once, and only the new browser's idle timer remains.
      expect(Array.from(await pdf.renderPdf("<p>next</p>"))).toEqual(PDF_MAGIC);
      expect(vi.getTimerCount()).toBe(1);
      expect(warn.mock.calls).toEqual([["[pdf] render stopped after 60000 ms; closing Chromium"]]);
    });

    it("never launches or prints a page that took longer than the limit to build, and hands the renderer on at the limit", async () => {
      vi.useFakeTimers();
      const A = fakeBrowser("A");
      A.hold = true;
      launch.mockResolvedValue(A);
      const page = deferred<string>();

      const late = failure(pdf.renderPdf(() => page.promise));
      await vi.advanceTimersByTimeAsync(pdf.PDF_RENDER_TIMEOUT_MS);
      const error = await late;
      expect(error).toBeInstanceOf(pdf.PdfBusyError);
      expect((error as InstanceType<PdfModule["PdfBusyError"]>).reason).toBe("render-timeout");
      expect(launch, "no browser was started for it").not.toHaveBeenCalled();

      // The renderer went to the next caller at the limit: there was no browser to close first.
      const next = pdf.renderPdf("<p>next</p>");
      await vi.advanceTimersByTimeAsync(0);
      expect(A.printing()).toBe(1);

      // Its page arrives now, while the next caller prints: it must not be printed beside it.
      page.resolve("<p>too late</p>");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(A.newContext, "the late page gets no context").toHaveBeenCalledTimes(1);
      expect(A.prints).toBe(1);
      expect(launch).toHaveBeenCalledTimes(1);

      A.finishPrint();
      expect(Array.from(await next)).toEqual(PDF_MAGIC);
      expect(A.close, "no browser is closed: none was in use when the limit passed").not.toHaveBeenCalled();
      expect(warn.mock.calls, "and the log does not say one was").toEqual([["[pdf] render stopped after 60000 ms; its page was still being built, no Chromium was in use"]]);
    });

    it("leaves no timer behind after an ordinary render", async () => {
      vi.useFakeTimers();
      launch.mockResolvedValueOnce(fakeBrowser("A"));

      await pdf.renderPdf("<p>a</p>");
      // Only the idle-close timer of the shared browser remains; closing the browser clears it.
      expect(vi.getTimerCount()).toBe(1);
      await pdf.closePdfBrowser();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
