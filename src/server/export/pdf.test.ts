import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

const { getDb, schema } = await import("../db");
const { putAsset } = await import("../assets");
const { renderDocumentHtml } = await import("./html");
const { closePdfBrowser, renderPdf } = await import("./pdf");

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
});
