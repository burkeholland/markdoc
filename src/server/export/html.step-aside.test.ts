import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssetContent } from "../assets";
import { PNG } from "../assets.fixtures";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { setAssetStore } = await import("../assets");
const { renderDocumentHtml, MAX_UNBROKEN_WORK_MS, STEP_ASIDE_MS } = await import("./html");

/**
 * While pictures are embedded, other requests get their turn (#2290). The embedded database reads in the
 * server's thread and hands the bytes back before the event loop can turn; the store here does the same
 * (it keeps the thread busy, then resolves), or answers like a database on a socket (after a real wait).
 */

const BASE = "https://docs.example.com";
const DOC = "aside-doc";

/** What the store does for the next reads, and everything that happened, in order. */
let read: (id: string) => Promise<void> | void = () => {};
const order: string[] = [];

/** Keep this thread busy, the way a read inside the server's own process does. */
const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

/**
 * A request that arrives now: it needs several turns of the event loop before it is answered (accept, read,
 * handler, a timer), as a real one does. One turn between two pictures would move it one step.
 */
const request = (name: string) => {
  setImmediate(() => setImmediate(() => setTimeout(() => setImmediate(() => order.push(`${name} answered`)), 0)));
};

beforeAll(() => {
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
      return documentId === DOC ? { mime: "image/png", bytes: PNG, size: PNG.byteLength, documentId, name: id } : null;
    },
  });
});

const page = (ids: string[], inline: { verifyBytes?: boolean } = {}) =>
  renderDocumentHtml({ title: "Aside", markdown: ids.map((id) => `![${id}](/api/assets/${id})`).join("\n\n"), assetBaseUrl: BASE, inlineAssets: { documentId: DOC, ...inline } });

/** How many times the page builder stepped aside: its wait is the only timer of exactly that length. */
const stepsAside = (timeouts: ReturnType<typeof vi.spyOn>) => timeouts.mock.calls.filter(([, ms]: unknown[]) => ms === STEP_ASIDE_MS).length;

describe("embedding pictures leaves room for other requests (#2290)", () => {
  afterEach(() => {
    read = () => {};
    order.length = 0;
    vi.restoreAllMocks();
  });

  it("answers a request that arrived during a slow read before the next picture is read", async () => {
    const ids = ["pica", "picb", "picc"];
    read = (id) => {
      request(`request during ${id}`);
      busy(MAX_UNBROKEN_WORK_MS + 10);
    };

    const html = await page(ids, { verifyBytes: true });

    expect(order.slice(0, 5)).toEqual(["read pica", "request during pica answered", "read picb", "request during picb answered", "read picc"]);
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
  });

  it("does the same for the HTML download", async () => {
    read = (id) => {
      request(`request during ${id}`);
      busy(MAX_UNBROKEN_WORK_MS + 10);
    };

    await page(["pica", "picb"]);

    expect(order.slice(0, 3)).toEqual(["read pica", "request during pica answered", "read picb"]);
  });

  it("adds up short reads and steps aside once they reach the limit, not after each", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const each = MAX_UNBROKEN_WORK_MS / 2 + 5;
    read = () => busy(each);

    await page(["pic1", "pic2", "pic3", "pic4"]);

    // 30 + 30 reaches the limit after the second read and again after the fourth.
    expect(stepsAside(timeouts)).toBe(2);
  });

  it("never waits when the reads are quick", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");

    const html = await page(["pic1", "pic2", "pic3"]);

    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
    expect(stepsAside(timeouts), "a small export pays nothing").toBe(0);
  });

  it("never waits after a read that let the event loop turn by itself, however long it took", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    // A database on a socket: the answer arrives in a later turn of the loop.
    read = () => new Promise<void>((resolve) => setTimeout(resolve, MAX_UNBROKEN_WORK_MS + 20));

    await page(["pic1", "pic2", "pic3"]);

    expect(stepsAside(timeouts)).toBe(0);
  });

  it("builds the same page whether or not it stepped aside", async () => {
    const quick = await page(["pica", "picb", "picc"], { verifyBytes: true });
    read = () => busy(MAX_UNBROKEN_WORK_MS + 10);

    expect(await page(["pica", "picb", "picc"], { verifyBytes: true })).toBe(quick);
  });
});
