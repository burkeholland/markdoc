import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { createDocument, signIn } from "./helpers";

/**
 * The per-document social card (task #1287): link unfurlers (Slack, Teams, iMessage) fetch a document
 * URL anonymously, so what they see is what an anonymous visitor may know. A link-shared document
 * answers with its own title, excerpt and a rendered 1200×630 image (`src/server/document-metadata.ts`,
 * `src/app/{d,p}/[id]/opengraph-image.tsx`); a private one keeps the root layout's generic card and its
 * image route is a 404 for everyone without access.
 */

const TITLE = "Quarterly reading plan";
const CONTENT = `# ${TITLE}\n\nA **short** plan for what the [team](https://example.test) reads this quarter.\n\nOne book a month, notes in here, discussion on the last Friday.\n`;
const EXCERPT = "A short plan for what the team reads this quarter. One book a month, notes in here, discussion on the last Friday.";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `<meta property|name="…" content="…">` tags of `html`, by property/name, in document order. */
function metaTags(html: string): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const tag of html.matchAll(/<meta\s([^>]*?)\/?>/g)) {
    const attrs = new Map([...tag[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const key = attrs.get("property") ?? attrs.get("name");
    const content = attrs.get("content");
    if (key === undefined || content === undefined) continue;
    const decoded = content.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" })[e]!);
    tags.set(key, [...(tags.get(key) ?? []), decoded]);
  }
  return tags;
}

const first = (tags: Map<string, string[]>, key: string) => tags.get(key)?.[0];

/** The `<title>` text of a page. */
function pageTitle(html: string): string | undefined {
  return /<title>([^<]*)<\/title>/.exec(html)?.[1];
}

/** The document's card tags, as an unfurler reads them, pointing at the image route next to `pagePath`. */
function expectDocumentCard(html: string, baseURL: string, pagePath: string) {
  const tags = metaTags(html);
  expect(pageTitle(html), "<title>").toBe(`${TITLE} · Markdoc`);
  expect(first(tags, "og:title"), "og:title").toBe(TITLE);
  expect(first(tags, "og:description"), "og:description").toBe(EXCERPT);
  expect(first(tags, "description"), "description").toBe(EXCERPT);
  expect(first(tags, "og:site_name"), "og:site_name").toBe("Markdoc");
  expect(first(tags, "og:type"), "og:type").toBe("article");
  expect(first(tags, "og:url"), "og:url").toBe(`${baseURL}${pagePath}`);
  expect(first(tags, "twitter:card"), "twitter:card").toBe("summary_large_image");
  expect(first(tags, "twitter:title"), "twitter:title").toBe(TITLE);
  const image = first(tags, "og:image");
  expect(image, "og:image").toMatch(new RegExp(`^${escapeRegExp(`${baseURL}${pagePath}/opengraph-image`)}(\\?|$)`));
  expect(tags.get("og:image"), "exactly one og:image").toHaveLength(1);
  expect(first(tags, "og:image:width"), "og:image:width").toBe("1200");
  expect(first(tags, "og:image:height"), "og:image:height").toBe("630");
  expect(first(tags, "twitter:image"), "twitter:image").toBe(image);
  return image!;
}

/** The root layout's generic card: no document title, no document image. */
function expectGenericCard(html: string, baseURL: string, docId: string) {
  const tags = metaTags(html);
  expect(first(tags, "og:title"), "og:title").toBe("Markdoc");
  expect(pageTitle(html), "<title>").not.toContain(TITLE);
  expect(html, "the document's title is nowhere in the HTML").not.toContain(TITLE);
  for (const image of tags.get("og:image") ?? []) expect(image, "og:image").not.toContain(`/${docId}/`);
  expect(first(tags, "og:image"), "og:image").toBe(`${baseURL}/brand/og.png`);
}

/** A rendered card: 200, PNG, at least 10 kB, IHDR 1200×630, cacheable for five minutes. */
async function expectCardImage(res: APIResponse, label: string): Promise<Buffer> {
  expect(res.status(), `${label}: status`).toBe(200);
  expect(res.headers()["content-type"], `${label}: content-type`).toBe("image/png");
  expect(res.headers()["cache-control"], `${label}: cache-control`).toBe("public, max-age=300");
  const body = await res.body();
  expect(body.length, `${label}: size`).toBeGreaterThanOrEqual(10_000);
  expect(body.subarray(0, 8).equals(PNG_SIGNATURE), `${label}: PNG signature`).toBe(true);
  // IHDR: width and height as big-endian uint32 at bytes 16–24.
  expect([body.readUInt32BE(16), body.readUInt32BE(20)], `${label}: IHDR width×height`).toEqual([1200, 630]);
  return body;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function setLinkAccess(request: APIRequestContext, id: string, linkAccess: "private" | "view" | "comment") {
  const res = await request.patch(`/api/documents/${id}`, { data: { linkAccess } });
  expect(res.ok(), `PATCH linkAccess=${linkAccess}: ${res.status()}`).toBeTruthy();
}

test.describe("social card", () => {
  test("a view link unfurls with the document's title, excerpt and a rendered card", async ({ browser, playwright, baseURL }) => {
    const alice = await signIn(browser, "alice");
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const id = await createDocument(alice.page, CONTENT, TITLE);
      await setLinkAccess(alice.page.request, id, "view");

      // An anonymous visitor on a view link is sent to the reader; the unfurler follows and reads the card there.
      const page = await anonymous.get(`/d/${id}`);
      expect(page.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/p/${id}`);
      const image = expectDocumentCard(await page.text(), baseURL!, `/p/${id}`);

      const png = await expectCardImage(await anonymous.get(image), "og:image");
      mkdirSync("test-results", { recursive: true });
      writeFileSync(path.join("test-results", "social-card.png"), png);
    } finally {
      await anonymous.dispose();
      await alice.context.close();
    }
  });

  test("a comment link renders the editor page directly, with its own card", async ({ browser, playwright, baseURL }) => {
    const alice = await signIn(browser, "alice");
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const id = await createDocument(alice.page, CONTENT, TITLE);
      await setLinkAccess(alice.page.request, id, "comment");

      const page = await anonymous.get(`/d/${id}`);
      expect(page.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/d/${id}`);
      const image = expectDocumentCard(await page.text(), baseURL!, `/d/${id}`);
      await expectCardImage(await anonymous.get(image), "og:image on /d");
      // The reader's card is there too (the same document, the same access).
      await expectCardImage(await anonymous.get(`/p/${id}/opengraph-image`), "/p image");
    } finally {
      await anonymous.dispose();
      await alice.context.close();
    }
  });

  test("a private document shows the generic card and no image to anyone without access; its owner gets the card", async ({ browser, playwright, baseURL }) => {
    const alice = await signIn(browser, "alice");
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      const id = await createDocument(alice.page, CONTENT, TITLE);

      const page = await anonymous.get(`/d/${id}`);
      expect(page.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe("/login");
      expectGenericCard(await page.text(), baseURL!, id);

      for (const route of [`/d/${id}/opengraph-image`, `/p/${id}/opengraph-image`]) {
        const res = await anonymous.get(route);
        expect(res.status(), `anonymous ${route}`).toBe(404);
        expect(res.headers()["content-type"], `anonymous ${route}`).not.toBe("image/png");
      }
      // Access, not secrecy, gates the card: the owner sees it on both routes.
      await expectCardImage(await alice.page.request.get(`/d/${id}/opengraph-image`), "owner /d image");
      await expectCardImage(await alice.page.request.get(`/p/${id}/opengraph-image`), "owner /p image");
    } finally {
      await anonymous.dispose();
      await alice.context.close();
    }
  });

  test("an unknown document has no card on either route", async ({ browser, playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    try {
      for (const route of ["/d/no-such-doc-1287/opengraph-image", "/p/no-such-doc-1287/opengraph-image"]) {
        const res = await anonymous.get(route);
        expect(res.status(), `anonymous ${route}`).toBe(404);
      }
    } finally {
      await anonymous.dispose();
    }
    // Signed in changes nothing for a document that does not exist.
    const alice = await signIn(browser, "alice");
    try {
      const res = await alice.page.request.get("/d/no-such-doc-1287/opengraph-image");
      expect(res.status(), "owner, unknown id").toBe(404);
    } finally {
      await alice.context.close();
    }
  });
});
