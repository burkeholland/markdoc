"use client";

import { useEffect, useState } from "react";
import { api, apiErrorText } from "@/lib/api";
import { isValidLogin } from "@/components/editor/collaborator-login-input";
import type { FolderAccessException } from "@/server/folders";
import type { Role } from "@/server/db/schema";

export const FOLDER_SHARE_WARNING = "Sharing this folder shares every document in it, including documents added or moved into it later. The highest applicable permission wins; lower folder access does not reduce higher document access.";

type Preview =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "loaded"; exceptions: FolderAccessException[] };

export function useFolderAccessPreview(folderId: string | null, login: string, role: Exclude<Role, "owner">, revision = 0) {
  const [retry, setRetry] = useState(0);
  const normalized = login.trim().replace(/^@/, "").toLowerCase();
  const key = `${folderId}:${normalized}:${role}:${revision}:${retry}`;
  const [answer, setAnswer] = useState<Preview | null>(null);
  const valid = !!folderId && isValidLogin(normalized);
  useEffect(() => {
    if (!folderId || !valid || role === "editor") return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.folders.accessPreview(folderId, normalized, role, { signal: controller.signal }).then(
        (result) => { if (!controller.signal.aborted) setAnswer({ key, status: "loaded", exceptions: result.exceptions }); },
        (error: unknown) => { if (!controller.signal.aborted) setAnswer({ key, status: "error", message: apiErrorText(error, "Could not check higher document access.") }); },
      );
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [folderId, normalized, role, key, valid]);
  const preview: Preview | null = !valid ? null : role === "editor"
    ? { key, status: "loaded", exceptions: [] }
    : answer?.key === key ? answer : { key, status: "loading" };
  return { preview, retry: () => setRetry((value) => value + 1) };
}

const SOURCE_LABELS = {
  owner: "owner", collaborator: "direct document grant", folder: "folder grant", link: "document link", "folder-link": "folder link",
};
const ROLE_LABELS = { viewer: "View", commenter: "Comment", editor: "Edit" };

export function FolderAccessExceptions({ login, role, exceptions }: { login: string; role: Exclude<Role, "owner">; exceptions: FolderAccessException[] }) {
  if (exceptions.length === 0) return null;
  return (
    <div className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2" data-testid="folder-access-exceptions">
      <p className="font-medium">Folder grant: {ROLE_LABELS[role]} for @{login.replace(/^@/, "")}. Higher access is kept:</p>
      <ul className="mt-1 flex flex-col gap-1">
        {exceptions.map((exception) => (
          <li key={exception.documentId}>
            {ROLE_LABELS[exception.role]} on{" "}
            <a className="text-accent underline" href={`/d/${exception.documentId}`}>{exception.documentTitle}</a>
            {" "}via {SOURCE_LABELS[exception.source]}.
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FolderPreviewFeedback({ login, role, preview, retry }: {
  login: string; role: Exclude<Role, "owner">;
  preview: Preview | null; retry: () => void;
}) {
  if (!preview) return null;
  if (preview.status === "loading") return <p className="mt-2 text-xs text-ink-3" role="status">Checking higher document access…</p>;
  if (preview.status === "error") return (
    <div className="mt-2 text-xs text-danger" role="alert">
      {preview.message} <button type="button" className="btn btn-outline btn-sm" onClick={retry}>Retry access check</button>
    </div>
  );
  return <FolderAccessExceptions login={login} role={role} exceptions={preview.exceptions} />;
}
