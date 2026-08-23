"use client";

import { useEffect, useState } from "react";
import { BookOpen, Check, Copy, Globe, Link2, Loader2, Lock, Trash2, UserPlus } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, type CollaboratorDto } from "@/lib/api";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const LINK_OPTIONS: { value: DocumentDto["linkAccess"]; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added below can open this document." },
  { value: "view", label: "Anyone with the link can view", description: "Signed-out visitors can read the document." },
  { value: "comment", label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." },
  { value: "edit", label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." },
];

export function ShareDialog({
  open,
  onOpenChange,
  doc,
  isOwner,
  onDocChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDto;
  isOwner: boolean;
  onDocChange: (doc: DocumentDto) => void;
}) {
  const [collabs, setCollabs] = useState<CollaboratorDto[] | null>(null);
  const [owner, setOwner] = useState<{ login: string | null; name: string | null; image: string | null } | null>(null);
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const readerLink = `${origin}/p/${doc.id}`;

  useEffect(() => {
    if (!open) return;
    api.documents
      .collaborators(doc.id)
      .then((res) => {
        setCollabs(res.collaborators);
        setOwner(res.owner);
      })
      .catch((e) => setError(e.message));
  }, [open, doc.id]);

  const add = async () => {
    if (!login.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.documents.addCollaborator(doc.id, login.trim(), role);
      const res = await api.documents.collaborators(doc.id);
      setCollabs(res.collaborators);
      setLogin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add collaborator");
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (c: CollaboratorDto, next: Exclude<Role, "owner">) => {
    await api.documents.addCollaborator(doc.id, c.login, next);
    setCollabs((list) => list?.map((x) => (x.login === c.login ? { ...x, role: next } : x)) ?? null);
  };

  const remove = async (c: CollaboratorDto) => {
    await api.documents.removeCollaborator(doc.id, c.login);
    setCollabs((list) => list?.filter((x) => x.login !== c.login) ?? null);
  };

  const setLink = async (value: DocumentDto["linkAccess"]) => {
    const res = await api.documents.patch(doc.id, { linkAccess: value });
    onDocChange(res.document);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.origin + `/d/${doc.id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share “${doc.title}”`} description="Collaborators sign in with GitHub. Add people by their GitHub handle.">
        {isOwner && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="relative flex-1">
              <UserPlus size={16} className="pointer-events-none absolute left-3 top-2.5 text-ink-4" />
              <input
                className="input pl-9"
                placeholder="GitHub handle, e.g. octocat"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                data-testid="share-login"
              />
            </div>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)} aria-label="Role for new collaborator" data-testid="share-role">
              <option value="editor">Editor</option>
              <option value="commenter">Commenter</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={busy || !login.trim()} data-testid="share-add">
              {busy ? <Loader2 size={16} className="animate-spin" /> : "Add"}
            </button>
          </form>
        )}
        {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger dark:bg-red-950/40">{error}</div>}

        <div className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">People with access</div>
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {owner && (
              <li className="flex items-center gap-3 px-3 py-2.5">
                <Avatar name={owner.name ?? owner.login ?? "Owner"} src={owner.image} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{owner.name ?? owner.login}</div>
                  {owner.login && <div className="truncate text-xs text-ink-3">@{owner.login}</div>}
                </div>
                <span className="text-xs font-medium text-ink-3">Owner</span>
              </li>
            )}
            {collabs?.map((c) => (
              <li key={c.login} className="flex items-center gap-3 px-3 py-2.5" data-testid="collaborator-row">
                <Avatar name={c.name ?? c.login} src={c.image ?? `https://avatars.githubusercontent.com/${c.login}?s=64`} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{c.name ?? c.login}</div>
                  <div className="truncate text-xs text-ink-3">@{c.login}</div>
                </div>
                {isOwner ? (
                  <>
                    <select className="select h-8 text-xs" value={c.role} onChange={(e) => void changeRole(c, e.target.value as Exclude<Role, "owner">)} aria-label={`Role for ${c.login}`}>
                      <option value="editor">Editor</option>
                      <option value="commenter">Commenter</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button type="button" className="icon-btn h-8 w-8 text-ink-3 hover:text-danger" onClick={() => void remove(c)} aria-label={`Remove ${c.login}`}>
                      <Trash2 size={15} />
                    </button>
                  </>
                ) : (
                  <span className="text-xs font-medium capitalize text-ink-3">{c.role}</span>
                )}
              </li>
            ))}
            {collabs && collabs.length === 0 && <li className="px-3 py-3 text-sm text-ink-3">Nobody else has been added yet.</li>}
          </ul>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">General access</div>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3">
            <span className={cn("mt-0.5 flex h-8 w-8 items-center justify-center rounded-full", doc.linkAccess === "private" ? "bg-surface-3 text-ink-2" : "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300")}>
              {doc.linkAccess === "private" ? <Lock size={15} /> : <Globe size={15} />}
            </span>
            <div className="min-w-0 flex-1">
              {isOwner ? (
                <select className="select w-full" value={doc.linkAccess} onChange={(e) => void setLink(e.target.value as DocumentDto["linkAccess"])} aria-label="Link access" data-testid="link-access">
                  {LINK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="text-sm font-medium text-ink">{LINK_OPTIONS.find((o) => o.value === doc.linkAccess)?.label}</div>
              )}
              <p className="mt-1 text-xs text-ink-3">{LINK_OPTIONS.find((o) => o.value === doc.linkAccess)?.description}</p>
              {doc.linkAccess !== "private" && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="reader-link">
                  <BookOpen size={13} className="shrink-0 text-ink-3" />
                  <span className="shrink-0 text-ink-3">Reader link:</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{readerLink}</code>
                  <CopyButton text={readerLink} label="Copy" testId="copy-reader-link" />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button type="button" className="btn btn-outline gap-2" onClick={() => void copyLink()} data-testid="copy-link">
            {copied ? <Check size={16} className="text-success" /> : <Link2 size={16} />}
            {copied ? "Copied" : "Copy link"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onOpenChange(false)}>
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CopyButton({ text, label = "Copy", testId }: { text: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost gap-1.5"
      data-testid={testId}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}
