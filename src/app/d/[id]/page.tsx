import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { EditorShell } from "@/components/editor/editor-shell";
import { currentUser } from "@/server/http";
import { getDocumentAccess, getGitHubToken } from "@/server/documents";
import { publicDocument } from "@/server/dto";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/d/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await currentUser();
  const access = await getDocumentAccess(id, user);
  return { title: access?.doc.title ?? "Document" };
}

export default async function DocumentPage({ params }: PageProps<"/d/[id]">) {
  const { id } = await params;
  const user = await currentUser();
  const access = await getDocumentAccess(id, user);
  if (!access) {
    if (!user) redirect(`/login?next=${encodeURIComponent(`/d/${id}`)}`);
    notFound();
  }
  // A signed-out visitor on a view-only link cannot edit or comment: the reader page serves them better.
  if (!user && access.doc.linkAccess === "view") redirect(`/p/${id}`);
  const githubAvailable = user ? !!(await getGitHubToken(user.id)) : false;
  return (
    <EditorShell
      doc={publicDocument(access.doc)}
      role={access.role}
      user={{
        id: user?.id ?? "anonymous",
        name: user?.name ?? user?.login ?? "Anonymous",
        login: user?.login ?? null,
        image: user?.image ?? null,
      }}
      githubAvailable={githubAvailable}
    />
  );
}
