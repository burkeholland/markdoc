import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { currentUser, getEffectiveDocumentAccess } from "@/server/http";
import { canComment, getUserById } from "@/server/documents";
import { documentMetadata, documentTitle, liveTextForRequest } from "@/server/document-metadata";
import { contentHash } from "@/server/export/html";
import { renderReaderBody } from "@/server/export/reader-body-cache";
import { ReaderPage } from "@/components/reader/reader-page";
import { computeStats } from "@/editor/stats";
import { UnrenderableDocumentError, UNRENDERABLE_MESSAGE } from "@/editor/markdown/renderable";

// Always render the latest text: the reader has no live connection, a refresh is the update.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Unfurlers fetch anonymously and `/d/<id>` sends them here for a view link, so this is the social card
// Slack shows for a shared document (og:image comes from ./opengraph-image.tsx). Reader pages stay out
// of search indexes as before.
export async function generateMetadata({ params }: PageProps<"/p/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await currentUser();
  const access = await getEffectiveDocumentAccess(id, user);
  const live = access ? await liveTextForRequest(id).catch(() => null) : null;
  return { ...(await documentMetadata(access?.doc ?? null, live, "/p")), robots: { index: false } };
}

export default async function PublicReaderPage({ params }: PageProps<"/p/[id]">) {
  const { id } = await params;
  const user = await currentUser();
  const access = await getEffectiveDocumentAccess(id, user);
  if (!access) {
    // Same behaviour as /d: signed-out visitors are sent to sign in, signed-in strangers see 404.
    if (!user) redirect(`/login?next=${encodeURIComponent(`/p/${id}`)}`);
    notFound();
  }
  const { doc, role } = access;
  const [live, owner] = await Promise.all([liveTextForRequest(id), getUserById(doc.ownerId)]);
  // Pending suggestions are editor business; the audience reads the clean text.
  const hash = contentHash(live.clean);
  const body = await renderReaderBody(live.clean, hash).catch((err: unknown) => {
    if (!(err instanceof UnrenderableDocumentError)) throw err;
    return { html: `<p><em>${UNRENDERABLE_MESSAGE}: it contains more unmatched brackets or emphasis markers than the renderer accepts. Open it in the editor to fix the source.</em></p>`, headings: [] };
  });
  const title = documentTitle(doc, live);

  return (
    <ReaderPage
      docId={id}
      title={title}
      html={body.html}
      headings={body.headings}
      initialHash={hash}
      updatedAt={doc.updatedAt.toISOString()}
      readingMinutes={computeStats(live.clean).readingMinutes}
      owner={owner ? { name: owner.name ?? owner.login ?? "Owner", image: owner.image ?? null } : null}
      signedIn={!!user}
      canOpenEditor={canComment(role)}
      pollMs={Number(process.env.READER_POLL_MS) || 30_000}
    />
  );
}
