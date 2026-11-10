"use client";

import { useState } from "react";
import Link from "next/link";
import { Folder, MoreVertical, Share2 } from "lucide-react";
import { FolderShareDialog } from "@/components/dashboard/folders";
import { FOLDER_SHARE_WARNING } from "@/components/dashboard/folder-access-preview";
import type { FolderDto } from "@/lib/api";
import type { Role } from "@/server/db/schema";
import { isValidLogin } from "@/components/editor/collaborator-login-input";
import { DocumentShareDialog } from "@/components/dashboard/document-share-dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/primitives";

export function FolderPageClient({ folder, documents, signedIn, signInReturnPath, initialShare, requestLogin, notificationId }: {
  folder: FolderDto;
  documents: { id: string; title: string; role: Role | null; updatedAt: string }[];
  signedIn: boolean; signInReturnPath: string; initialShare: boolean; requestLogin: string | null; notificationId: string | null;
}) {
  const owner = folder.role === "owner";
  const [sharing, setSharing] = useState(initialShare && owner);
  const [sharingDocument, setSharingDocument] = useState<{ id: string; title: string } | null>(null);
  const [request, setRequest] = useState(() => requestLogin && isValidLogin(requestLogin) ? { login: requestLogin, notificationId } : null);
  const changeOpen = (open: boolean) => {
    setSharing(open);
    if (!open) {
      const url = new URL(window.location.href);
      for (const key of ["share", "accessRequest", "notification"]) url.searchParams.delete(key);
      window.history.replaceState(window.history.state, "", url.toString());
    }
  };
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8" data-testid="folder-page">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Folder</p>
          <h1 className="flex items-center gap-2 wrap-anywhere text-2xl font-semibold text-ink"><Folder aria-hidden size={24} />{folder.name}</h1>
          <p className="mt-1 text-sm text-ink-3">{folder.documentCount} documents · {folder.role}</p>
        </div>
        {owner && <button className="btn btn-primary shrink-0 gap-2" onClick={() => changeOpen(true)} data-testid="folder-page-share"><Share2 size={16} />Share folder</button>}
      </header>
      {initialShare && !owner && <p className="mb-4 text-sm text-danger" role="alert">Only the folder owner can open its Share pane or respond to access requests.</p>}
      {requestLogin && !isValidLogin(requestLogin) && <p className="mb-4 text-sm text-danger" role="alert">This access request does not include a valid GitHub handle.</p>}
      {owner && <p className="mb-4 rounded-lg border border-line bg-surface-2 p-3 text-sm text-ink-2">{FOLDER_SHARE_WARNING}</p>}
      <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Documents in this folder">
        {documents.map((document) => (
          <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-3" data-testid="folder-document-row" data-document-id={document.id}>
            <Link href={`/d/${document.id}`} className="min-w-0 flex-1 wrap-anywhere font-medium text-accent hover:underline">{document.title}</Link>
            <span className="shrink-0 text-xs text-ink-3">{document.role}</span>
            {document.role === "owner" && <Menu>
              <MenuTrigger asChild>
                <button type="button" className="icon-btn relative h-11 w-11 shrink-0" aria-label={`Actions for ${document.title}`} data-testid="document-menu">
                  <MoreVertical size={16} aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem icon={<Share2 size={15} />} onSelect={() => setSharingDocument({ id: document.id, title: document.title })} data-testid="document-share">Share…</MenuItem>
              </MenuContent>
            </Menu>}
          </li>
        ))}
        {documents.length === 0 && <li className="px-4 py-6 text-sm text-ink-3">This folder has no documents yet.</li>}
      </ul>
      <nav className="mt-5 text-sm">
        {signedIn ? <Link href="/" className="text-accent hover:underline">Back to Documents</Link>
          : <Link href={`/login?next=${encodeURIComponent(signInReturnPath)}`} className="text-accent hover:underline">Sign in to comment or edit when allowed</Link>}
      </nav>
      <FolderShareDialog folder={sharing ? folder : null} onOpenChange={changeOpen} accessRequest={request} onRequestResolved={() => setRequest(null)} />
      {sharingDocument && <DocumentShareDialog key={sharingDocument.id} target={sharingDocument} onOpenChange={(open) => { if (!open) setSharingDocument(null); }} />}
    </main>
  );
}
