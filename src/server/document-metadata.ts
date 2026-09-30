import { cache } from "react";
import type { Metadata } from "next";
import { excerpt, getLinkPreviewDocument, type DocumentMeta } from "@/server/documents";
import { readLiveText, type LiveText } from "@/server/livedoc";
import { CARD_ALT, CARD_CONTENT_TYPE, CARD_SIZE } from "@/server/og/document-card";

/** What a link preview says about a document whose text has no prose yet. */
export const EMPTY_DOCUMENT_DESCRIPTION = "A document on Markdoc";

/** The title, text and time the social card and the metadata are built from. */
export type DocumentCardText = Pick<LiveText, "title" | "clean">;

/** The columns of a document row its metadata is built from. */
export type MetadataDocument = Pick<DocumentMeta, "id" | "title" | "updatedAt">;

/**
 * The live text of a document, read once per server request: `generateMetadata` and the page body of
 * `/d/[id]` and `/p/[id]` both go through here, so a page render loads the document a single time.
 * React's `cache` is scoped to the request; outside one (tests, scripts) it is a plain call.
 */
export const liveTextForRequest = cache((id: string): Promise<LiveText> => readLiveText(id));

/** The title a reader sees: the live document's, else the row's, else "Untitled" (the rule `/p` renders with). */
export function documentTitle(doc: Pick<DocumentMeta, "title">, live: Pick<LiveText, "title"> | null): string {
  return live?.title || doc.title || "Untitled";
}

/** The first 160 characters of the document's prose, Markdown removed, or the generic line for an empty document. */
export function documentDescription(live: Pick<LiveText, "clean"> | null): string {
  return (live ? excerpt(live.clean) : "") || EMPTY_DOCUMENT_DESCRIPTION;
}

/**
 * Metadata for a document page, shared by `/d/[id]` and `/p/[id]`. Link unfurlers (Slack, Teams, X,
 * iMessage) fetch anonymously, so what they show is exactly what an anonymous visitor may know:
 * without access (`doc` null) the result is the bare `{ title: "Document" }` it always was (the page
 * then redirects or 404s) and the root layout's generic card stands; with access the card carries the
 * document's title and first lines. `og:image` is only set with `cardImage`: on the document pages the
 * `opengraph-image.tsx` next to each page supplies it (and `og:image:width/height`, `twitter:image`)
 * with the same access check; the sign-in page has no such file and points at the document's.
 */
export function documentMetadata(
  doc: MetadataDocument | null,
  live: DocumentCardText | null,
  path: "/d" | "/p",
  { cardImage = false }: { cardImage?: boolean } = {},
): Metadata {
  if (!doc) return { title: "Document" };
  const title = documentTitle(doc, live);
  const description = documentDescription(live);
  const image = `${path}/${doc.id}/opengraph-image`;
  return {
    title,
    description,
    openGraph: {
      type: "article",
      title,
      description,
      siteName: "Markdoc",
      url: `${path}/${doc.id}`,
      modifiedTime: doc.updatedAt.toISOString(),
      ...(cardImage && { images: [{ url: image, ...CARD_SIZE, alt: CARD_ALT, type: CARD_CONTENT_TYPE }] }),
    },
    twitter: { card: "summary_large_image", title, description, ...(cardImage && { images: [{ url: image, alt: CARD_ALT }] }) },
  };
}

/** A document page a sign-in redirect returns to: `/d/<id>` or `/p/<id>`, optionally with a query or hash. */
const DOCUMENT_PAGE = /^\/([dp])\/([\w-]{1,64})\/?(?:[?#]|$)/;

/**
 * The card for `/login?next=/d/<id>` (or `/p/<id>`), or null for the generic one. Both document pages
 * send a signed-out visitor without access there, and link unfurlers follow redirects, so for a
 * restricted document this is the page Slack or Teams read the card from. It is the document's own card
 * (title, first lines and image) only when the preview is public (see `getLinkPreviewDocument`: a
 * link-shared document, or a restricted one with link previews on). Anything else (another path, an
 * unknown id, a restricted document without previews) is null, so the page says nothing about it, not
 * even whether the id exists. `next` must already be the validated return path (`loginReturnPath`).
 * Cached per request: the sign-in page awaits it in its body too, so the tags are resolved before the
 * head is sent, for every crawler and not only the ones Next.js blocks on.
 */
export const signInPreviewMetadata = cache(async (next: string): Promise<Metadata | null> => {
  const page = DOCUMENT_PAGE.exec(next);
  if (!page) return null;
  const doc = await getLinkPreviewDocument(page[2]);
  if (!doc) return null;
  const live = await liveTextForRequest(doc.id).catch(() => null);
  return { ...documentMetadata(doc, live, `/${page[1]}` as "/d" | "/p", { cardImage: true }), robots: { index: false } };
});
