import { notFound } from "next/navigation";
import { currentUser, getEffectiveDocumentAccess } from "@/server/http";
import { getLinkPreviewDocument, getUserById } from "@/server/documents";
import { computeStats } from "@/editor/stats";
import { documentTitle, liveTextForRequest } from "@/server/document-metadata";
import { CARD_CACHE_CONTROL, RESTRICTED_CARD_CACHE_CONTROL, renderDocumentCard } from "@/server/og/document-card";

/**
 * The `opengraph-image` default export shared by `src/app/d/[id]/opengraph-image.tsx` and
 * `src/app/p/[id]/opengraph-image.tsx`. The card is drawn for whoever may read the document, and for
 * anyone at all when its link preview is public (a restricted document whose owner turned on link
 * previews: the sign-in page an unfurler lands on points here, see `signInPreviewMetadata`). Everyone
 * else (an anonymous unfurler on a restricted document, a signed-in stranger, a token outside its
 * document list) gets a bare 404 and learns nothing, not even that the id exists.
 *
 * A restricted document's card, whoever asks for it, shows only what the Share dialog says a link
 * preview shows (the title, the owner's name and when it was last updated: no reading time, which
 * would tell how long it is), and is never stored, so turning its link previews off takes effect at once.
 */
export async function documentCardImage({ params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const access = await getEffectiveDocumentAccess(id, await currentUser());
  const doc = access?.doc ?? (await getLinkPreviewDocument(id));
  if (!doc) notFound();
  const restricted = doc.linkAccess === "private";
  const [live, owner] = await Promise.all([liveTextForRequest(id), getUserById(doc.ownerId)]);
  return renderDocumentCard(
    {
      title: documentTitle(doc, live),
      ownerName: owner ? (owner.name ?? owner.login ?? "Owner") : null,
      readingMinutes: restricted ? 0 : computeStats(live.clean).readingMinutes,
      updatedAt: doc.updatedAt,
    },
    { cacheControl: restricted ? RESTRICTED_CARD_CACHE_CONTROL : CARD_CACHE_CONTROL },
  );
}
