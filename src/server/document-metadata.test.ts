import { describe, expect, it, vi } from "vitest";
import type { DocumentAccess } from "@/server/documents";
import { documentDescription, documentMetadata, documentTitle, EMPTY_DOCUMENT_DESCRIPTION } from "./document-metadata";

// The helper's live-text read (not exercised here) comes from livedoc, whose registry pulls in the auth module.
vi.mock("@/server/livedoc", () => ({ readLiveText: async () => { throw new Error("not read in this test"); } }));

const UPDATED_AT = new Date("2026-08-30T15:04:05.000Z");

function access(over: Partial<DocumentAccess["doc"]> = {}, role: DocumentAccess["role"] = "viewer"): DocumentAccess {
  return {
    role,
    doc: {
      id: "doc-1287",
      title: "Row title",
      ownerId: "user-alice",
      storage: "local",
      linkAccess: "view",
      gistId: null,
      gistFile: null,
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      repoPath: null,
      githubSha: null,
      publishedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: UPDATED_AT,
      lastEditedBy: null,
      deletedAt: null,
      hasUnpublishedChanges: false,
      ...over,
    },
  };
}

const live = (title: string, clean: string) => ({ title, clean });

describe("documentMetadata", () => {
  // Unfurlers fetch anonymously: a private document must never show its title to them.
  it("says nothing about a document the visitor may not read", () => {
    const meta = documentMetadata(null, null, "/d");
    expect(meta).toEqual({ title: "Document" });
    expect(meta).not.toHaveProperty("description");
    expect(meta).not.toHaveProperty("openGraph");
    expect(meta).not.toHaveProperty("twitter");
  });

  it("builds title, description and both card blocks from the live text", () => {
    const meta = documentMetadata(access(), live("Quarterly plan", "# Quarterly plan\n\nWe **ship** the [reader](x) first.\n\nThen the rest."), "/p");
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

  it("points the canonical URL at the page that was asked for", () => {
    expect(documentMetadata(access(), live("T", "x"), "/d").openGraph).toMatchObject({ url: "/d/doc-1287" });
    expect(documentMetadata(access(), live("T", "x"), "/p").openGraph).toMatchObject({ url: "/p/doc-1287" });
  });

  it("cuts the description at 160 characters of prose", () => {
    const word = "prose ";
    const meta = documentMetadata(access(), live("Long", word.repeat(100)), "/p");
    expect(meta.description).toHaveLength(160);
    expect(meta.description).toBe(word.repeat(100).slice(0, 160).trim());
    expect(meta.openGraph?.description).toBe(meta.description);
  });

  it("gives an empty document the generic description", () => {
    const meta = documentMetadata(access(), live("", ""), "/d");
    expect(meta.title).toBe("Row title");
    expect(meta.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.openGraph?.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.twitter).toMatchObject({ description: EMPTY_DOCUMENT_DESCRIPTION });
  });

  it("falls back to the row when the live text could not be read", () => {
    const meta = documentMetadata(access(), null, "/d");
    expect(meta.title).toBe("Row title");
    expect(meta.description).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(meta.openGraph).toMatchObject({ title: "Row title", url: "/d/doc-1287" });
  });
});

describe("documentTitle", () => {
  it("prefers the live title, then the row, then Untitled (the reader's rule)", () => {
    expect(documentTitle(access(), live("Live title", ""))).toBe("Live title");
    expect(documentTitle(access(), live("", ""))).toBe("Row title");
    expect(documentTitle(access({ title: "" }), live("", ""))).toBe("Untitled");
    expect(documentTitle(access({ title: "" }), null)).toBe("Untitled");
  });
});

describe("documentDescription", () => {
  it("is the excerpt with Markdown removed, skipping headings, code and front matter", () => {
    expect(documentDescription(live("H", "---\ntitle: H\n---\n\n# Heading\n\n```js\nlet x = 1;\n```\n\nSome *emphasis* and `code`.\n"))).toBe("Some emphasis and code.");
  });

  it("uses the heading text when a document has headings but no prose", () => {
    expect(documentDescription(live("H", "# Only a heading\n\n## And another\n"))).toBe("Only a heading And another");
  });

  it("is the generic line for no text at all", () => {
    expect(documentDescription(live("", "   \n\n"))).toBe(EMPTY_DOCUMENT_DESCRIPTION);
    expect(documentDescription(null)).toBe(EMPTY_DOCUMENT_DESCRIPTION);
  });
});
