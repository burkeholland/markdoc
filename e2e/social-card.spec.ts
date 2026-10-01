import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { createDocument, openDocument, signIn } from "./helpers";

/**
 * The per-document social card (task #1287): link unfurlers (Slack, Teams, iMessage) fetch a document
 * URL anonymously, so what they see is what an anonymous visitor may know. A link-shared document
 * answers with its own title, excerpt and a rendered 1200×630 image (`src/server/document-metadata.ts`,
 * `src/app/{d,p}/[id]/opengraph-image.tsx`); a private one keeps the root layout's generic card and its
 * image route is a 404 for everyone without access, unless its owner turned on link previews in the
 * Share dialog: then the sign-in page the unfurler is sent to carries the document's card.
 */

const TITLE = "Quarterly reading plan";
const CONTENT = `# ${TITLE}\n\nA **short** plan for what the [team](https://example.test) reads this quarter.\n\nOne book a month, notes in here, discussion on the last Friday.\n`;
const EXCERPT = "A short plan for what the team reads this quarter. One book a month, notes in here, discussion on the last Friday.";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Text past the first 160 characters of prose: no link preview carries it. */
const TAIL_MARKER = "members-only-tail-1287";
/** Text the reader page hides (a comment spread over lines, row 1 of the #2194 review): no link preview carries it either. */
const HIDDEN_MARKER = "hidden-note-1287";
/** A cell past a table's header columns (the #2194 re-review): the reader page drops it, and so does every link preview. */
const EXTRA_CELL_MARKER = "extra-cell-1287";
const TABLE = `| Host |\n| --- |\n| Rotating | ${EXTRA_CELL_MARKER} |`;
const NEXT_PARAGRAPH = `Hosts rotate every month, and the shortlist for next quarter is at the bottom of this plan: ${TAIL_MARKER}.`;
const LONG_CONTENT = `${CONTENT}\n<!--\n${HIDDEN_MARKER}\n-->\n\n${TABLE}\n\n${NEXT_PARAGRAPH}\n`;
/** The long document's excerpt: the short plan, the table's cells the reader page shows, then as much of the next paragraph as fits in 160 characters. */
const LONG_EXCERPT = `${EXCERPT} Host Rotating ${NEXT_PARAGRAPH}`.slice(0, 160).trim();

/**
 * Link unfurlers by user agent. Next.js holds `<head>` back until the metadata is ready only for the bots on
 * its list (Slackbot, facebookexternalhit, Twitterbot); Teams is not on it, so its card must not depend on that.
 */
const UNFURLERS = [
  { name: "Slack", userAgent: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
  { name: "Facebook", userAgent: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
  { name: "X", userAgent: "Twitterbot/1.0" },
  {
    name: "Teams",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 MicrosoftPreview/2.0 +https://aka.ms/MicrosoftPreview",
  },
];

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

/** The `<head>` of a page, where unfurlers read the card: most of them miss tags that arrive later in `<body>`. */
function headOf(html: string): string {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/.exec(html)?.[1];
  expect(head, "<head>").toBeDefined();
  return head!;
}

/** The page's `<title>` and the excerpt (exactly, or a pattern for a long document) a card is expected to carry. */
type CardText = { titleTag?: string; excerpt?: string | RegExp };

/** The document's card tags, as an unfurler reads them, pointing at the image route next to `pagePath`. */
function expectDocumentCard(html: string, baseURL: string, pagePath: string, { titleTag = `${TITLE} · Markdoc`, excerpt = EXCERPT }: CardText = {}) {
  const tags = metaTags(html);
  const expectExcerpt = (key: string) =>
    typeof excerpt === "string" ? expect(first(tags, key), key).toBe(excerpt) : expect(first(tags, key), key).toMatch(excerpt);
  expect(pageTitle(html), "<title>").toBe(titleTag);
  expect(first(tags, "og:title"), "og:title").toBe(TITLE);
  expectExcerpt("og:description");
  expectExcerpt("description");
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

/** Cache-Control of a link-shared document's card, and of a restricted one's: never stored, so turning previews off takes effect at once. */
const SHARED_CARD_CACHE = "public, max-age=300";
const RESTRICTED_CARD_CACHE = "private, no-store";

/** A rendered card: 200, PNG, at least 10 kB, IHDR 1200×630, with the cache header for its kind of document. */
async function expectCardImage(res: APIResponse, label: string, cacheControl = SHARED_CARD_CACHE): Promise<Buffer> {
  expect(res.status(), `${label}: status`).toBe(200);
  expect(res.headers()["content-type"], `${label}: content-type`).toBe("image/png");
  expect(res.headers()["cache-control"], `${label}: cache-control`).toBe(cacheControl);
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
      // Access, not secrecy, gates the card: the owner sees it on both routes. A restricted document's card is never stored.
      await expectCardImage(await alice.page.request.get(`/d/${id}/opengraph-image`), "owner /d image", RESTRICTED_CARD_CACHE);
      await expectCardImage(await alice.page.request.get(`/p/${id}/opengraph-image`), "owner /p image", RESTRICTED_CARD_CACHE);
    } finally {
      await anonymous.dispose();
      await alice.context.close();
    }
  });

  test("a restricted document with link previews on unfurls with its card on the sign-in page, and off again without it", async ({ browser, playwright, baseURL }) => {
    test.slow();
    const alice = await signIn(browser, "alice");
    const bob = await signIn(browser, "bob");
    try {
      const id = await createDocument(alice.page, LONG_CONTENT, TITLE);

      // The owner turns previews on in the Share dialog, from the keyboard; the link itself stays restricted.
      await openDocument(alice.page, id);
      await alice.page.getByTestId("share-button").click();
      const dialog = alice.page.getByRole("dialog", { name: /share/i });
      await expect(dialog).toBeVisible();
      const previews = dialog.getByRole("switch", { name: "Show title and first lines in link previews" });
      await expect(previews).toHaveAttribute("aria-checked", "false");
      await expect(previews).toHaveAccessibleDescription("Slack, Teams and other apps show the title, first lines, your name and when it was last updated.");
      await previews.focus();
      await alice.page.keyboard.press("Space");
      await expect(previews).toHaveAttribute("aria-checked", "true");
      // Saving must not drop focus to the page: the switch stays focused, so Space can turn it off again.
      await expect(previews).not.toHaveAttribute("aria-disabled");
      await expect(previews).toBeFocused();
      await expect(dialog.getByTestId("link-access")).toHaveValue("private");

      for (const pagePath of [`/d/${id}`, `/p/${id}`]) {
        for (const { name, userAgent } of UNFURLERS) {
          const unfurler = await playwright.request.newContext({ baseURL, userAgent });
          try {
            // Still sent to sign in, and the card is in that page's <head>: title, first lines, image.
            const res = await unfurler.get(pagePath);
            expect(res.status(), `${name} ${pagePath}`).toBe(200);
            const landed = new URL(res.url());
            expect([landed.pathname, landed.searchParams.get("next")], `${name} ${pagePath}: where it lands`).toEqual(["/login", pagePath]);
            const html = await res.text();
            const image = expectDocumentCard(headOf(html), baseURL!, pagePath, { titleTag: "Sign in · Markdoc", excerpt: LONG_EXCERPT });
            expect(html, `${name} ${pagePath}: nothing past the first lines`).not.toContain(TAIL_MARKER);
            expect(html, `${name} ${pagePath}: nothing the reader page hides`).not.toContain(HIDDEN_MARKER);
            expect(html, `${name} ${pagePath}: no table cell the reader page drops`).not.toContain(EXTRA_CELL_MARKER);
            if (name === UNFURLERS[0].name) await expectCardImage(await unfurler.get(image), `${pagePath} og:image`, RESTRICTED_CARD_CACHE);
          } finally {
            await unfurler.dispose();
          }
        }
      }

      // A preview is not access: a signed-in stranger still gets a 404 that names nothing. The image is as public as the preview.
      const stranger = await bob.page.request.get(`/d/${id}`);
      expect(stranger.status(), "signed-in stranger").toBe(404);
      const strangerHtml = await stranger.text();
      expect(strangerHtml, "signed-in stranger").not.toContain(TITLE);
      expect(strangerHtml, "signed-in stranger").not.toContain(TAIL_MARKER);
      expect(strangerHtml, "signed-in stranger").not.toContain(HIDDEN_MARKER);
      expect(strangerHtml, "signed-in stranger").not.toContain(EXTRA_CELL_MARKER);
      await expectCardImage(await bob.page.request.get(`/d/${id}/opengraph-image`), "signed-in stranger image", RESTRICTED_CARD_CACHE);

      // Off again, from the keyboard: the generic card, and no image for anyone without access.
      await expect(previews).toBeFocused();
      await alice.page.keyboard.press("Space");
      await expect(previews).toHaveAttribute("aria-checked", "false");
      await expect(previews).not.toHaveAttribute("aria-disabled");
      await expect(previews).toBeFocused();
      for (const { name, userAgent } of UNFURLERS) {
        const unfurler = await playwright.request.newContext({ baseURL, userAgent });
        try {
          for (const pagePath of [`/d/${id}`, `/p/${id}`]) {
            const res = await unfurler.get(pagePath);
            expect(new URL(res.url()).pathname, `${name} ${pagePath}`).toBe("/login");
            expectGenericCard(await res.text(), baseURL!, id);
            const card = await unfurler.get(`${pagePath}/opengraph-image`);
            expect(card.status(), `${name} ${pagePath}/opengraph-image`).toBe(404);
          }
        } finally {
          await unfurler.dispose();
        }
      }
    } finally {
      await bob.context.close();
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
