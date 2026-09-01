import { notFound } from "next/navigation";
import { currentUser, getEffectiveDocumentAccess } from "@/server/http";
import { getUserById } from "@/server/documents";
import { computeStats } from "@/editor/stats";
import { documentTitle, liveTextForRequest } from "@/server/document-metadata";
import { renderDocumentCard } from "@/server/og/document-card";

/**
 * The `opengraph-image` default export shared by `src/app/d/[id]/opengraph-image.tsx` and
 * `src/app/p/[id]/opengraph-image.tsx`. The access check is the page's own: whoever may not read the
 * document (an anonymous unfurler on a private document, a signed-in stranger, a token outside its
 * document list) gets a bare 404 and learns nothing, not even that the id exists.
 */
export async function documentCardImage({ params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const access = await getEffectiveDocumentAccess(id, await currentUser());
  if (!access) notFound();
  const [live, owner] = await Promise.all([liveTextForRequest(id), getUserById(access.doc.ownerId)]);
  return renderDocumentCard({
    title: documentTitle(access, live),
    ownerName: owner ? (owner.name ?? owner.login ?? "Owner") : null,
    readingMinutes: computeStats(live.clean).readingMinutes,
    updatedAt: access.doc.updatedAt,
  });
}
