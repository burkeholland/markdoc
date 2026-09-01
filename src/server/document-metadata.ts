import { cache } from "react";
import type { Metadata } from "next";
import { excerpt, type DocumentAccess } from "@/server/documents";
import { readLiveText, type LiveText } from "@/server/livedoc";

/** What a link preview says about a document whose text has no prose yet. */
export const EMPTY_DOCUMENT_DESCRIPTION = "A document on Markdoc";

/** The title, text and time the social card and the metadata are built from. */
export type DocumentCardText = Pick<LiveText, "title" | "clean">;

/**
 * The live text of a document, read once per server request: `generateMetadata` and the page body of
 * `/d/[id]` and `/p/[id]` both go through here, so a page render loads the document a single time.
 * React's `cache` is scoped to the request; outside one (tests, scripts) it is a plain call.
 */
export const liveTextForRequest = cache((id: string): Promise<LiveText> => readLiveText(id));

/** The title a reader sees: the live document's, else the row's, else "Untitled" (the rule `/p` renders with). */
export function documentTitle(access: DocumentAccess, live: Pick<LiveText, "title"> | null): string {
  return live?.title || access.doc.title || "Untitled";
}

/** The first 160 characters of the document's prose, Markdown removed, or the generic line for an empty document. */
export function documentDescription(live: Pick<LiveText, "clean"> | null): string {
  return (live ? excerpt(live.clean) : "") || EMPTY_DOCUMENT_DESCRIPTION;
}

/**
 * Metadata for a document page, shared by `/d/[id]` and `/p/[id]`. Link unfurlers (Slack, Teams, X,
 * iMessage) fetch anonymously, so what they show is exactly what an anonymous visitor may know:
 * without access the result is the bare `{ title: "Document" }` it always was (the page then redirects
 * or 404s) and the root layout's generic card stands; with access the card carries the document's
 * title and first lines. `og:image` is not set here: the `opengraph-image.tsx` next to each page
 * supplies it (and `og:image:width/height`, `twitter:image`) with the same access check.
 */
export function documentMetadata(access: DocumentAccess | null, live: DocumentCardText | null, path: "/d" | "/p"): Metadata {
  if (!access) return { title: "Document" };
  const title = documentTitle(access, live);
  const description = documentDescription(live);
  return {
    title,
    description,
    openGraph: {
      type: "article",
      title,
      description,
      siteName: "Markdoc",
      url: `${path}/${access.doc.id}`,
      modifiedTime: access.doc.updatedAt.toISOString(),
    },
    twitter: { card: "summary_large_image", title, description },
  };
}
