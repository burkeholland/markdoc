import { notFound } from "next/navigation";
import { currentUser, getEffectiveDocumentAccess } from "@/server/http";
import { getLinkPreviewDocument, getUserById } from "@/server/documents";
import { computeStats } from "@/editor/stats";
import { documentTitle, liveTextForRequest } from "@/server/document-metadata";
import { renderDocumentCard } from "@/server/og/document-card";

/**
 * The `opengraph-image` default export shared by `src/app/d/[id]/opengraph-image.tsx` and
 * `src/app/p/[id]/opengraph-image.tsx`. The card is drawn for whoever may read the document, and for
 * anyone at all when its link preview is public (a restricted document whose owner turned on link
 * previews: the sign-in page an unfurler lands on points here, see `signInPreviewMetadata`). Everyone
 * else (an anonymous unfurler on a restricted document, a signed-in stranger, a token outside its
 * document list) gets a bare 404 and learns nothing, not even that the id exists.
 */
export async function documentCardImage({ params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const access = await getEffectiveDocumentAccess(id, await currentUser());
  const doc = access?.doc ?? (await getLinkPreviewDocument(id));
  if (!doc) notFound();
  const [live, owner] = await Promise.all([liveTextForRequest(id), getUserById(doc.ownerId)]);
  return renderDocumentCard({
    title: documentTitle(doc, live),
    ownerName: owner ? (owner.name ?? owner.login ?? "Owner") : null,
    readingMinutes: computeStats(live.clean).readingMinutes,
    updatedAt: doc.updatedAt,
  });
}
