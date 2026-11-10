import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/server/http";
import { getFolderAccess, listDocumentsInFolder } from "@/server/folders";
import { folderDto } from "@/server/dto";
import { shareReturnPath } from "@/lib/share-target";
import { FolderPageClient } from "./folder-client";

export const dynamic = "force-dynamic";

export default async function FolderPage({ params, searchParams }: PageProps<"/f/[id]">) {
  const { id } = await params;
  const search = await searchParams;
  const signInReturnPath = shareReturnPath(`/f/${id}`, search);
  const user = await currentUser();
  if (user?.documentIds?.length) notFound();
  const access = await getFolderAccess(id, user);
  if (!access) {
    if (!user) redirect(`/login?next=${encodeURIComponent(signInReturnPath)}`);
    notFound();
  }
  const documents = await listDocumentsInFolder(id, user);
  return <FolderPageClient
    folder={folderDto(access.folder)}
    documents={documents.map((document) => ({ ...document, updatedAt: document.updatedAt.toISOString() }))}
    signedIn={!!user}
    signInReturnPath={signInReturnPath}
    initialShare={search.share === "1" || typeof search.accessRequest === "string"}
    requestLogin={typeof search.accessRequest === "string" ? search.accessRequest : null}
    notificationId={typeof search.notification === "string" ? search.notification : null}
  />;
}
