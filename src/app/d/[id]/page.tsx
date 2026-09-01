import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { EditorClient } from "./editor-client";
import { currentUser, getEffectiveDocumentAccess } from "@/server/http";
import { githubConfigured } from "@/auth";
import { getGitHubToken } from "@/server/documents";
import { publicDocument } from "@/server/dto";
import { documentMetadata, liveTextForRequest } from "@/server/document-metadata";
import { renderMarkdownBody } from "@/server/export/html";

export const dynamic = "force-dynamic";

// The social card (og:title/description; og:image comes from ./opengraph-image.tsx) for whoever may read
// the document; anyone else gets the bare title and the root layout's generic card.
export async function generateMetadata({ params }: PageProps<"/d/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await currentUser();
  const access = await getEffectiveDocumentAccess(id, user);
  const live = access ? await liveTextForRequest(id).catch(() => null) : null;
  return documentMetadata(access, live, "/d");
}

export default async function DocumentPage({ params }: PageProps<"/d/[id]">) {
  const { id } = await params;
  const user = await currentUser();
  const embed = user?.embedDocumentId === id;
  const access = await getEffectiveDocumentAccess(id, user);
  if (!access) {
    if (!user) redirect(`/login?next=${encodeURIComponent(`/d/${id}`)}`);
    notFound();
  }
  // A signed-out visitor on a view-only link cannot edit or comment: the reader page serves them better.
  if (!user && access.doc.linkAccess === "view") redirect(`/p/${id}`);
  const [githubAvailable, initialHtml] = await Promise.all([user ? getGitHubToken(user.id).then((t) => !!t) : false, renderInitialHtml(id)]);
  return (
    <EditorClient
      doc={publicDocument(access.doc)}
      role={access.role}
      user={{
        id: user?.id ?? "anonymous",
        name: user?.name ?? user?.login ?? "Anonymous",
        login: user?.login ?? null,
        image: user?.image ?? null,
      }}
      githubAvailable={githubAvailable}
      githubConfigured={githubConfigured}
      initialHtml={initialHtml}
      embed={embed}
      embedParentOrigin={user?.embedParentOrigin}
      embedSessionExpiresAt={user?.embedSessionExpiresAt}
    />
  );
}

/**
 * Server-rendered preview of the document the editor shows until the rich pane has the live
 * state (issue #118): on a 12k-word document the client otherwise paints nothing useful for
 * 2–4 s after the HTML loaded (hydration, Yjs sync, a full parse and a ProseMirror render of
 * the whole text). Rendered off-thread with the reader's pipeline; an empty or unrenderable
 * document (or a render error) yields null and the editor loads as before. The live text is the
 * read `generateMetadata` already made for this request.
 */
async function renderInitialHtml(id: string): Promise<string | null> {
  try {
    const live = await liveTextForRequest(id);
    if (live.clean.trim() === "") return null;
    const { html } = await renderMarkdownBody(live.clean, { assetBaseUrl: "" });
    return html;
  } catch {
    return null;
  }
}
