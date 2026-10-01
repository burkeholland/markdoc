import { describe, expect, it, vi } from "vitest";
import type { MetadataDocument } from "./document-metadata";
import { documentDescription, documentMetadata, documentTitle, EMPTY_DOCUMENT_DESCRIPTION, signInPreviewMetadata } from "./document-metadata";
import { CARD_ALT } from "@/server/og/document-card";
import { previewOffThread, RenderTimeoutError } from "@/server/export/render-pool";

const liveTexts = vi.hoisted(() => new Map<string, { title: string; clean: string }>());
const previewDocs = vi.hoisted(() => new Map<string, { id: string; title: string; updatedAt: Date }>());

// The helper's live-text read comes from livedoc, whose registry pulls in the auth module: stand in for it.
vi.mock("@/server/livedoc", () => ({
  readLiveText: async (id: string) => {
    const text = liveTexts.get(id);
    if (!text) throw new Error("not readable in this test");
    return text;
  },
}));
// Which documents have a public preview is src/server/link-preview.test.ts's business (against the database).
vi.mock("@/server/documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/documents")>()),
  getLinkPreviewDocument: vi.fn(async (id: string) => previewDocs.get(id) ?? null),
}));

// The real worker parses the preview text; one test makes it fail.
vi.mock("@/server/export/render-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/export/render-pool")>();
  return { ...actual, previewOffThread: vi.fn(actual.previewOffThread) };
});

const UPDATED_AT = new Date("2026-08-30T15:04:05.000Z");

function doc(over: Partial<MetadataDocument> = {}): MetadataDocument {
  return { id: "doc-1287", title: "Row title", updatedAt: UPDATED_AT, ...over };
}

const live = (title: string, clean: string) => ({ title, clean });

describe("documentMetadata", () => {
  // Unfurlers fetch anonymously: a private document must never show its title to them.
  it("says nothing about a document the visitor may not read", async () => {
    const meta = await documentMetadata(null, null, "/d");
    expect(meta).toEqual({ title: "Document" });
    expect(meta).not.toHaveProperty("description");
    expect(meta).not.toHaveProperty("openGraph");
    expect(meta).not.toHaveProperty("twitter");
  });

  it("builds title, description and both card blocks from the live text", async () => {
    const meta = await documentMetadata(doc(), live("Quarterly plan", "# Quarterly plan\n\nWe **ship** the [reader](x) first.\n\nThen the rest."), "/p");
    expect(meta.title).toBe("Quarterly plan");
    expect(meta.description).toBe("We ship the reader first. Then the rest.");
    expect(meta.openGraph).toEqual({
      type: "article",
      title: "Quarterly plan",
      description: "We ship the reader first. Then the rest.",
      siteName: "Markdoc",
      url: "/p/doc-1287",
      modifiedTime: "2026-08-30T15:04:05.000Z",
    });
    expect(meta.twitter).toEqual({ card: "summary_large_image", title: "Quarterly plan", description: "We ship the reader first. Then the rest." });
    // No image here: the opengraph-image route next to the page owns og:image, with its own access check.
    expect(meta.openGraph).not.toHaveProperty("images");
    expect(meta.twitter).not.toHaveProperty("images");
  });

  it("points the canonical URL at the page that was asked for", async () => {
    expect((await documentMetadata(doc(), live("T", "x"), "/d")).openGraph).toMatchObject({ url: "/d/doc-1287" });
    expect((await documentMetadata(doc(), live("T", "x"), "/p")).openGraph).toMatchObject({ url: "/p/doc-1287" });
  });

  it("cuts the description at 160 characters of prose", async () => {
    const word = "prose ";
    const meta = await documentMetadata(doc(), live("Long", word.repeat(100)), "/p");
    expect(meta.description).toHaveLength(160);
    expect(meta.description).toBe(word.repeat(100).slice(0, 160).trim());
    expect(meta.openGraph?.description).toBe(meta.description);
  });

  it("gives an empty document the generic description", async () => {
    const meta = await documentMetadata(doc(), live("", ""), "/d");
    expect(meta.title).toBe("Row title");
    expect(meta.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.openGraph?.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.twitter).toMatchObject({ description: EMPTY_DOCUMENT_DESCRIPTION });
  });

  it("falls back to the row when the live text could not be read", async () => {
    const meta = await documentMetadata(doc(), null, "/d");
    expect(meta.title).toBe("Row title");
    expect(meta.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.openGraph).toMatchObject({ title: "Row title", url: "/d/doc-1287" });
  });

  // The sign-in page has no opengraph-image file of its own, so it names the document's.
  it("points og:image and twitter:image at the document's card when asked to", async () => {
    const meta = await documentMetadata(doc(), live("T", "x"), "/p", { cardImage: true });
    expect(meta.openGraph).toMatchObject({
      url: "/p/doc-1287",
      images: [{ url: "/p/doc-1287/opengraph-image", width: 1200, height: 630, alt: CARD_ALT, type: "image/png" }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [{ url: "/p/doc-1287/opengraph-image", alt: CARD_ALT }] });
    expect((await documentMetadata(doc(), live("T", "x"), "/d", { cardImage: true })).openGraph).toMatchObject({ images: [{ url: "/d/doc-1287/opengraph-image" }] });
  });
});

describe("signInPreviewMetadata", () => {
  const PREVIEW = doc({ id: "abc123def456", title: "Launch plan" });
  previewDocs.set(PREVIEW.id, PREVIEW);
  liveTexts.set(PREVIEW.id, live("Launch plan", "# Launch plan\n\nWe ship on Monday."));

  it("is the document's card, image included, for the page a sign-in returns to", async () => {
    const meta = await signInPreviewMetadata(`/d/${PREVIEW.id}`);
    expect(meta).toMatchObject({
      title: "Launch plan",
      description: "We ship on Monday.",
      robots: { index: false },
      openGraph: { title: "Launch plan", description: "We ship on Monday.", url: `/d/${PREVIEW.id}`, images: [{ url: `/d/${PREVIEW.id}/opengraph-image` }] },
      twitter: { title: "Launch plan", description: "We ship on Monday.", images: [{ url: `/d/${PREVIEW.id}/opengraph-image` }] },
    });
  });

  it.each([
    [`/p/${PREVIEW.id}`, "/p"],
    [`/d/${PREVIEW.id}/`, "/d"],
    [`/d/${PREVIEW.id}?mode=focus#comments`, "/d"],
    [`/p/${PREVIEW.id}#intro`, "/p"],
  ])("keeps the page of %j", async (next, path) => {
    expect((await signInPreviewMetadata(next))?.openGraph).toMatchObject({ url: `${path}/${PREVIEW.id}`, images: [{ url: `${path}/${PREVIEW.id}/opengraph-image` }] });
  });

  it.each(["/", "/settings", "/d/", "/x/abc123def456", `/d/${PREVIEW.id}/history`, `/d/${PREVIEW.id}x`, "/d/../settings", `/d/${PREVIEW.id}%2Fx`])(
    "is null for %j, which is not a document page with a public preview",
    async (next) => {
      expect(await signInPreviewMetadata(next)).toBeNull();
    },
  );

  it("is null when the document has no public preview (restricted, trashed or unknown)", async () => {
    expect(await signInPreviewMetadata("/d/zzzzzzzzzzzz")).toBeNull();
  });

  it("falls back to the row's title and the generic line when the live text cannot be read", async () => {
    previewDocs.set("unreadable01", doc({ id: "unreadable01", title: "Stored title" }));
    expect(await signInPreviewMetadata("/p/unreadable01")).toMatchObject({
      title: "Stored title",
      description: EMPTY_DOCUMENT_DESCRIPTION,
      openGraph: { title: "Stored title", url: "/p/unreadable01" },
    });
  });
});

describe("documentTitle", () => {
  it("prefers the live title, then the row, then Untitled (the reader's rule)", () => {
    expect(documentTitle(doc(), live("Live title", ""))).toBe("Live title");
    expect(documentTitle(doc(), live("", ""))).toBe("Row title");
    expect(documentTitle(doc({ title: "" }), live("", ""))).toBe("Untitled");
    expect(documentTitle(doc({ title: "" }), null)).toBe("Untitled");
  });
});

describe("documentDescription", () => {
  it("is the preview text with Markdown removed, skipping headings, code and front matter", async () => {
    expect(await documentDescription(live("H", "---\ntitle: H\n---\n\n# Heading\n\n```js\nlet x = 1;\n```\n\nSome *emphasis* and `code`.\n"))).toBe("Some emphasis and code.");
  });

  it("uses the heading text when a document has headings but no prose", async () => {
    expect(await documentDescription(live("H", "# Only a heading\n\n## And another\n"))).toBe("Only a heading And another");
  });

  it("is the generic line for no text at all", async () => {
    expect(await documentDescription(live("", "   \n\n"))).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(await documentDescription(null)).toBe(EMPTY_DOCUMENT_DESCRIPTION);
  });

  // The rules themselves are tested in preview-text.test.ts; this is the wiring for every page that unfurls.
  it("never carries what the reader page hides, and is the generic line when nothing else is left", async () => {
    expect(await documentDescription(live("H", "<!--\nSECRET do not share\n-->\n\nVisible opening line."))).toBe("Visible opening line.");
    expect(await documentDescription(live("H", '<div data-token="SECRET"\n  class="x">Visible opening line.</div>'))).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(await documentDescription(live("H", "| Header |\n| --- |\n| Visible | SECRET_TABLE_2194 |"))).toBe("Header Visible");
  });

  // Turning thousands of nested blocks into HTML recurses deeper than the main thread's call stack allows;
  // the worker's stack takes the deepest nesting that fits in what a preview reads.
  it("reads blocks nested as deep as the text it reads allows", async () => {
    expect(await documentDescription(live("H", `${">".repeat(4000)} Deep quote.`))).toBe("Deep quote.");
    expect(await documentDescription(live("H", `${"- ".repeat(2000)}Deep item.`))).toBe("Deep item.");
    expect(await documentDescription(live("H", `${"> - ".repeat(1000)}Deep mix.`))).toBe("Deep mix.");
  }, 60_000);

  it("is the generic line when the worker fails or runs out of time", async () => {
    vi.mocked(previewOffThread).mockRejectedValueOnce(new RenderTimeoutError(15_000));
    expect(await documentDescription(live("H", "Visible opening line."))).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(await documentDescription(live("H", "Visible opening line."))).toBe("Visible opening line.");
  });
});
