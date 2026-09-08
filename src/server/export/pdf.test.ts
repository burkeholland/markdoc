import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("../db");
const { putAsset } = await import("../assets");
const { renderDocumentHtml } = await import("./html");
const { BROWSER_CLOSE_TIMEOUT_MS, closePdfBrowser, closeWithin, renderPdf } = await import("./pdf");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(Buffer.from(PNG_B64, "base64"));

describe("renderPdf", () => {
  let server: Server;
  let origin: string;
  let requests: string[];
  let assetId: string;

  beforeAll(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: `${origin}/private-after-redirect.png` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    const db = await getDb();
    const [user] = await db
      .insert(schema.users)
      .values({ name: "PDF", login: "pdf-export", email: "pdf-export@example.com" })
      .returning();
    await db.insert(schema.documents).values({ id: "pdf-export-doc", title: "PDF export", ownerId: user.id, content: "" });
    const stored = await putAsset({
      documentId: "pdf-export-doc",
      userId: user.id,
      name: "dot.png",
      mime: "image/png",
      bytes: PNG,
    });
    assetId = stored.id;
  });

  afterAll(async () => {
    await closePdfBrowser();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it(
    "renders embedded assets without requesting document-controlled network URLs",
    async () => {
      const port = new URL(origin).port;
      const markdown = [
        `![uploaded](/api/assets/${assetId})`,
        `![loopback](${origin}/loopback.png)`,
        "![private](http://10.0.0.1/private.png)",
        "![link-local](http://169.254.169.254/latest/meta-data)",
        `![ipv6-loopback](http://[::1]:${port}/ipv6-loopback.png)`,
        `![redirect-to-private](http://127.0.0.1.sslip.io:${port}/redirect)`,
        "![external](https://example.com/external.png)",
        "[ordinary link](https://example.com/linked-page)",
      ].join("\n\n");
      const html = await renderDocumentHtml({
        title: "Network policy",
        markdown,
        assetBaseUrl: origin,
        inlineAssets: { documentId: "pdf-export-doc" },
      });

      expect(html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
      expect(html).toContain('<a href="https://example.com/linked-page">ordinary link</a>');

      const pdf = Buffer.from(await renderPdf(html));

      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.toString("latin1")).toContain("/Subtype /Image");
      expect(pdf.toString("latin1")).toContain("https://example.com/linked-page");
      expect(requests).toEqual([]);
    },
    30_000,
  );

  it(
    "closes the live Chromium without the close timing out",
    async () => {
      // Runs after the render above launched the shared browser. A healthy close is a matter of a few hundred
      // ms, but on a loaded box Chromium has taken > 10 s to go away (#1390 measured 10 034 ms under 20 vitest
      // workers), so the production bound `BROWSER_CLOSE_TIMEOUT_MS` — there to keep shutdown from blocking, not
      // a benchmark — is not what this test asserts against. The bound here is generous; the real "gave up
      // waiting" signal is the explicit close outcome (and its corresponding warning), not when this test's
      // continuation happens to be scheduled.
      const warn = vi.spyOn(console, "warn");
      try {
        const started = performance.now();
        const outcome = await closePdfBrowser(60_000);
        const ms = Math.round(performance.now() - started);
        console.log(`[pdf.test] closePdfBrowser() with a live browser took ${ms} ms (production bound ${BROWSER_CLOSE_TIMEOUT_MS} ms)`);
        expect(outcome).toBe("closed");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
    75_000,
  );
});

describe("closeWithin", () => {
  it('resolves "closed" as soon as the browser has closed', async () => {
    const started = performance.now();
    await expect(closeWithin({ close: async () => {} }, 1_000)).resolves.toBe("closed");
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('resolves "timed-out" once the bound passes while the close is still running', async () => {
    const started = performance.now();
    await expect(closeWithin({ close: () => new Promise<void>(() => {}) }, 50)).resolves.toBe("timed-out");
    const elapsed = performance.now() - started;
    // libuv keeps its loop clock in whole milliseconds, so a timer can fire up to 1 ms early by performance.now().
    expect(elapsed).toBeGreaterThanOrEqual(49);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('resolves "failed" instead of throwing when the close rejects', async () => {
    const close = async () => {
      throw new Error("gone");
    };
    await expect(closeWithin({ close }, 1_000)).resolves.toBe("failed");
  });

  it("clears its timer in every outcome", async () => {
    vi.useFakeTimers();
    try {
      await expect(closeWithin({ close: async () => {} }, 1_000)).resolves.toBe("closed");
      expect(vi.getTimerCount()).toBe(0);

      const close = async () => {
        throw new Error("gone");
      };
      await expect(closeWithin({ close }, 1_000)).resolves.toBe("failed");
      expect(vi.getTimerCount()).toBe(0);

      const pending = closeWithin({ close: () => new Promise<void>(() => {}) }, 50);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBe("timed-out");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closePdfBrowser resolves at once when no browser was launched", async () => {
    // The common `afterAll` path when Chromium could not launch (and after a close, as in the describe above).
    const started = performance.now();
    await expect(closePdfBrowser()).resolves.toBe("idle");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
