import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetContent } from "../assets";
import { PNG } from "../assets.fixtures";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;
// The Markdown worker's 15 s budget is right for production. With every processor of the machine busy, the worker
// thread has taken longer than that to answer its first page, and the page was refused. No test here is about
// that budget, so it is out of the way, as in export.test.ts (task #1190); it is read once, when render-pool loads.
vi.hoisted(() => {
  process.env.MARKDOWN_RENDER_TIMEOUT_MS = "120000";
});

const { setAssetStore } = await import("../assets");
const { renderDocumentHtml, MAX_UNBROKEN_WORK_MS, STEP_ASIDE_MS } = await import("./html");

/**
 * While pictures are embedded, other requests get their turn, and a caller that goes away stops the work
 * (#2290). The embedded database reads in the server's thread and hands the bytes back before the event
 * loop can turn; the store here does the same, or answers like a database on a socket (in a later turn).
 *
 * Nothing in this file depends on how fast the machine is. The page builder's clock (`performance.now`) is
 * a number the store moves: a read "takes 60 ms" by adding 60 to it. The page builder's wait (its
 * `setTimeout` of exactly `WAIT_MS`) is caught: it ends when a test ends it, or, where a test does not
 * care, in the next turn of the event loop. Every other timer is the real one. Before, a real 25 ms timer
 * raced the test's own timers, and on a machine at 100 % CPU the page builder sometimes went first.
 */

const BASE = "https://docs.example.com";
const DOC = "aside-doc";
/** The measured values, as numbers and not as the product's constants, so that changing a constant shows here. */
const LIMIT_MS = 50;
const WAIT_MS = 25;
const NOT_AN_IMAGE = new TextEncoder().encode("plain text, stored under an image type before uploads were checked");

/** What the store does for the next reads, and everything that happened, in order. */
let read: (id: string) => Promise<void> | void = () => {};
const order: string[] = [];

/** The page builder's clock. */
let now = 0;
/** A read that keeps this thread for `ms`, the way a read inside the server's own process does: the clock moves, the event loop does not turn. */
const block = (ms: number) => {
  now += ms;
};
/** A read that is answered in a later turn of the event loop after `ms`, the way a database on a socket answers. */
const overSocket = async (ms: number) => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  now += ms;
};

interface Wait {
  /** Ended by its timer: the test's `end`, or by itself when waits are not held. */
  ended: boolean;
  /** Given up by the page builder (`clearTimeout`) before its timer ran. */
  givenUp: boolean;
  end: () => void;
}
/** Every wait the page builder began. */
let waits: Wait[] = [];
/** Whether a wait stays until the test ends it. */
let holdWaits = false;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/**
 * Let the event loop turn until `condition` holds. There is no time limit of its own in here (a slow machine
 * is not a failure); it fails at once, with what did happen, when `wentWrong` says it can no longer happen.
 */
const until = async (what: string, condition: () => boolean, wentWrong: () => boolean = () => false) => {
  while (!condition()) {
    if (wentWrong()) throw new Error(`did not happen: ${what}. What did: ${order.join(", ") || "nothing"}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
/** Let everything that is ready run: several turns of the event loop and the timers that are due. */
const settle = async () => {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const wasRead = (id: string) => () => order.includes(`read ${id}`);

/**
 * A request that arrives now: it needs several turns of the event loop and a timer before it is answered
 * (accept, read, handler, a timer), as a real one does. One turn between two pictures would move it one step.
 */
const request = (name: string) => {
  setImmediate(() => setImmediate(() => setTimeout(() => setImmediate(() => order.push(`${name} answered`)), 0)));
};

beforeAll(async () => {
  // The first page starts the Markdown worker thread, which can take seconds on a busy machine: not inside a test.
  await renderDocumentHtml({ title: "Warm", markdown: "warm", assetBaseUrl: BASE });
  setAssetStore({
    async put() {
      throw new Error("not used");
    },
    async get() {
      throw new Error("not used");
    },
    async getForDocument(documentId, id): Promise<AssetContent | null> {
      order.push(`read ${id}`);
      await read(id);
      const bytes = id.startsWith("txt") ? NOT_AN_IMAGE : PNG;
      return documentId === DOC ? { mime: "image/png", bytes, size: bytes.byteLength, documentId, name: id } : null;
    },
  });
}, 120_000);

const page = (ids: string[], inline: { verifyBytes?: boolean; signal?: AbortSignal } = {}) =>
  renderDocumentHtml({ title: "Aside", markdown: ids.map((id) => `![${id}](/api/assets/${id})`).join("\n\n"), assetBaseUrl: BASE, inlineAssets: { documentId: DOC, ...inline } });

const embedded = (html: string) => html.match(/src="data:image\/png;base64,/g)?.length ?? 0;
/** How a page ended: its HTML, or what it was given up with. */
const outcome = (building: Promise<string>) => building.then((html) => ({ html }), (error: unknown) => ({ error }));

// Three times the usual time for a test: these wait for nothing but the event loop, which a busy machine turns slowly.
describe("embedding pictures leaves room for other requests (#2290)", { timeout: 60_000 }, () => {
  beforeEach(() => {
    now = 1_000;
    waits = [];
    holdWaits = false;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== WAIT_MS) return realSetTimeout(callback, ms, ...args);
      const wait: Wait = {
        ended: false,
        givenUp: false,
        end: () => {
          if (wait.ended || wait.givenUp) return;
          wait.ended = true;
          callback();
        },
      };
      waits.push(wait);
      order.push("steps aside");
      if (!holdWaits) setImmediate(wait.end);
      return { wait } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: unknown) => {
      const wait = (handle as { wait?: Wait } | undefined)?.wait;
      if (!wait) return realClearTimeout(handle as NodeJS.Timeout);
      if (!wait.ended) wait.givenUp = true;
    }) as typeof clearTimeout);
  });

  afterEach(async () => {
    // A test that failed half-way leaves a page waiting: let it run to its end so that it writes nothing into the next test.
    read = () => {};
    holdWaits = false;
    for (const wait of waits) wait.end();
    await settle();
    order.length = 0;
    vi.restoreAllMocks();
  });

  it("answers a request that arrived during a slow read before the next picture is read", async () => {
    holdWaits = true;
    read = (id) => {
      request(`request during ${id}`);
      block(LIMIT_MS + 10);
    };

    let built = false;
    const building = page(["pica", "picb", "picc"], { verifyBytes: true }).finally(() => (built = true));

    // After each picture the page builder waits. However long the wait is held, no picture is read meanwhile,
    // and the request that came in during the read is answered: it had the turns of the event loop and the timer it needs.
    await until("the wait after the first picture", () => waits.length === 1, wasRead("picb"));
    await until("the first request's answer", () => order.includes("request during pica answered"));
    await settle();
    expect(order).toEqual(["read pica", "steps aside", "request during pica answered"]);
    waits[0].end();
    await until("the wait after the second picture", () => waits.length === 2, wasRead("picc"));
    await until("the second request's answer", () => order.includes("request during picb answered"));
    await settle();
    expect(order.slice(3)).toEqual(["read picb", "steps aside", "request during picb answered"]);
    waits[1].end();
    await until("the wait after the third picture", () => waits.length === 3, () => built);
    waits[2].end();

    expect(embedded(await building)).toBe(3);
    expect(order.filter((entry) => entry.startsWith("read"))).toEqual(["read pica", "read picb", "read picc"]);
    await until("the third request's answer", () => order.includes("request during picc answered"));
  });

  it("does the same for the HTML download", async () => {
    holdWaits = true;
    read = (id) => {
      request(`request during ${id}`);
      block(LIMIT_MS + 10);
    };

    let built = false;
    const building = page(["pica", "picb"]).finally(() => (built = true));

    await until("the wait after the first picture", () => waits.length === 1, wasRead("picb"));
    await until("the request's answer", () => order.includes("request during pica answered"));
    await settle();
    expect(order).toEqual(["read pica", "steps aside", "request during pica answered"]);
    waits[0].end();
    await until("the wait after the second picture", () => waits.length === 2, () => built);
    waits[1].end();
    expect(embedded(await building)).toBe(2);
    await until("the second request's answer", () => order.includes("request during picb answered"));
  });

  it("steps aside when 50 ms of reads have added up and not before, for 25 ms", async () => {
    // Measured on a production build: with these two numbers /api/health waits about as long as one picture
    // takes to read while a ten-picture page is built; with a 10 ms wait it waited for two (#2290).
    expect([MAX_UNBROKEN_WORK_MS, STEP_ASIDE_MS]).toEqual([LIMIT_MS, WAIT_MS]);

    read = () => block(49);
    await page(["pic1"]);
    expect(waits, "49 ms: no wait").toHaveLength(0);

    read = () => block(50);
    await page(["pic2"]);
    expect(waits, "50 ms: one wait").toHaveLength(1);
  });

  it("adds up short reads and steps aside once they reach the limit, not after each", async () => {
    read = () => block(30);

    await page(["pic1", "pic2", "pic3", "pic4"]);

    // 30 + 30 reaches the limit after the second read and again after the fourth.
    expect(order).toEqual(["read pic1", "read pic2", "steps aside", "read pic3", "read pic4", "steps aside"]);
  });

  it("never waits when the reads are quick", async () => {
    read = () => block(4);

    const html = await page(["pic1", "pic2", "pic3"]);

    expect(embedded(html)).toBe(3);
    expect(waits, "a small export pays nothing").toHaveLength(0);
  });

  it("never waits after a read that let the event loop turn by itself, however long it took", async () => {
    // A database on a socket: the answer arrives in a later turn of the loop.
    read = () => overSocket(LIMIT_MS + 20);

    await page(["pic1", "pic2", "pic3"]);

    expect(waits).toHaveLength(0);
  });

  it("builds the same page whether or not it stepped aside", async () => {
    const quick = await page(["pica", "picb", "picc"], { verifyBytes: true });
    expect(waits).toHaveLength(0);
    read = () => block(LIMIT_MS + 10);

    expect(await page(["pica", "picb", "picc"], { verifyBytes: true })).toBe(quick);
    expect(waits).toHaveLength(3);
  });

  it("still checks the bytes of every picture after it has stepped aside", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    read = () => block(LIMIT_MS + 10);

    const html = await page(["pica", "txtb", "picc", "txtd"], { verifyBytes: true });

    // Each read is followed by a wait; the second and the fourth file are not images and must not reach Chromium.
    expect(waits).toHaveLength(4);
    expect(embedded(html)).toBe(2);
    expect(html.match(/<span class="image-left-out">txt[bd]<\/span>/g)).toEqual(['<span class="image-left-out">txtb</span>', '<span class="image-left-out">txtd</span>']);
    expect(html).not.toContain(Buffer.from(NOT_AN_IMAGE).toString("base64"));
    expect(warn.mock.calls).toEqual([["[pdf] 2 image(s) left out: content is not an allowed image type; 0 inlined under the type its bytes are"]]);
  });

  describe("a caller that goes away", () => {
    it("reads nothing more once the caller is gone, for the PDF's page and for the HTML download", async () => {
      for (const inline of [{ verifyBytes: true }, {}]) {
        order.length = 0;
        const gone = new AbortController();
        read = (id) => {
          block(LIMIT_MS + 10);
          if (id === "picb") gone.abort();
        };

        const ended = await outcome(page(["pica", "picb", "picc", "picd"], { ...inline, signal: gone.signal }));

        // Two of four pictures were read. The caller left during the second: no wait is begun for it and the third is never read.
        expect(ended).toEqual({ error: gone.signal.reason });
        expect(order, JSON.stringify(inline)).toEqual(["read pica", "steps aside", "read picb"]);
      }
    });

    it("ends its wait at once when the caller goes away during it", async () => {
      holdWaits = true;
      const gone = new AbortController();
      read = () => block(LIMIT_MS + 10);

      let ended: unknown = "the page is still being built";
      void outcome(page(["pica", "picb", "picc"], { verifyBytes: true, signal: gone.signal })).then((how) => (ended = how));
      await until("the wait after the first picture", () => waits.length === 1, wasRead("picb"));
      gone.abort();
      await settle();

      // Nobody ended the wait here: only the caller's leaving can have ended it, and it did so without a timer running out.
      expect(ended).toEqual({ error: gone.signal.reason });
      expect(waits[0]).toMatchObject({ ended: false, givenUp: true });
      expect(order).toEqual(["read pica", "steps aside"]);
    });

    it("reads nothing at all for a caller that was gone before the first picture", async () => {
      const gone = new AbortController();
      gone.abort();

      expect(await outcome(page(["pica", "picb"], { signal: gone.signal }))).toEqual({ error: gone.signal.reason });

      expect(order).toEqual([]);
    });

    it("changes nothing for a caller that stays, and leaves nothing on its signal", async () => {
      const without = await page(["pica", "txtb", "picc"], { verifyBytes: true });
      const stays = new AbortController();
      const added = vi.spyOn(stays.signal, "addEventListener");
      const removed = vi.spyOn(stays.signal, "removeEventListener");
      read = () => block(LIMIT_MS + 10);

      const html = await page(["pica", "txtb", "picc"], { verifyBytes: true, signal: stays.signal });

      expect(html).toBe(without);
      expect(waits).toHaveLength(3);
      expect(waits.every((wait) => wait.ended && !wait.givenUp)).toBe(true);
      // One listener per wait, taken off again when the wait is over.
      expect(added).toHaveBeenCalledTimes(3);
      expect(removed.mock.calls.map(([type, listener]) => [type, listener])).toEqual(added.mock.calls.map(([type, listener]) => [type, listener]));
    });
  });
});
