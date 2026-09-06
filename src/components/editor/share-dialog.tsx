"use client";

import { memo, useEffect, useId, useRef, useState, type RefObject } from "react";
import { BookOpen, Bot, Check, ChevronDown, Copy, Globe, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput } from "@/components/editor/collaborator-login-input";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { cn } from "@/lib/utils";

const LINK_OPTIONS: { value: DocumentDto["linkAccess"]; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added above can open this document." },
  { value: "view", label: "Anyone with the link can view", description: "Signed-out visitors can read the document." },
  { value: "comment", label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." },
  { value: "edit", label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." },
];

export const ShareDialog = memo(function ShareDialog({
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
  const roleSelect = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const readerLink = `${origin}/p/${doc.id}`;
  const editorLink = `${origin}/d/${doc.id}`;
  const readerLinkEl = useRef<HTMLElement>(null);
  // Copy link has no visible text of its own; when both copy paths fail the URL is shown selected instead
  // and stays until it is copied or the dialog closes.
  const linkFallback = useRef<HTMLInputElement>(null);
  const link = useCopy(editorLink, linkFallback, "Copy link");
  const [showLinkFallback, setShowLinkFallback] = useState(false);
  useEffect(() => {
    if (link.status === "fallback") setShowLinkFallback(true);
    else if (link.status === "copied") setShowLinkFallback(false);
  }, [link.status]);
  useEffect(() => {
    if (!open) setShowLinkFallback(false);
  }, [open]);
  useEffect(() => {
    if (showLinkFallback) {
      linkFallback.current?.focus({ preventScroll: true });
      linkFallback.current?.select();
    }
  }, [showLinkFallback]);

  useEffect(() => {
    if (!open) return;
    api.documents
      .collaborators(doc.id)
      .then((res) => {
        setCollabs(res.collaborators);
        setOwner(res.owner);
      })
      .catch((e) => setError(apiErrorText(e, "Could not add collaborator")));
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
      setError(apiErrorText(e, "Could not add collaborator"));
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

  const linkOption = LINK_OPTIONS.find((o) => o.value === doc.linkAccess);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Share “${doc.title}”`} description="Collaborators sign in with GitHub. Add people by their GitHub handle." className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {isOwner && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <CollaboratorLoginInput
              value={login}
              onChange={setLogin}
              exclude={[...(owner?.login ? [owner.login] : []), ...(collabs?.map((c) => c.login) ?? [])]}
              onPick={() => roleSelect.current?.focus()}
            />
            <select ref={roleSelect} className="select" value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)} aria-label="Role for new collaborator" data-testid="share-role">
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
          {/* The link the people above open, in the same shape as the Reader link row under General access. */}
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="editor-link">
            <Link2 size={13} className="shrink-0 text-ink-3" />
            <span className="shrink-0 text-ink-3">Link:</span>
            {showLinkFallback ? (
              <input
                ref={linkFallback}
                className="input h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
                value={editorLink}
                readOnly
                aria-label="Document link"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="copy-link-fallback"
              />
            ) : (
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">{editorLink}</code>
            )}
            <button type="button" className="btn btn-sm btn-ghost shrink-0 gap-1.5" onClick={link.copy} data-testid="copy-link">
              {link.copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              {link.label}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink-3" data-testid="copy-link-hint">
            {doc.linkAccess === "private" ? "Anyone listed above can open this link." : linkOption?.description}
          </p>
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
                <div className="text-sm font-medium text-ink">{linkOption?.label}</div>
              )}
              <p className="mt-1 text-xs text-ink-3">{linkOption?.description}</p>
              {doc.linkAccess !== "private" && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs" data-testid="reader-link">
                  <BookOpen size={13} className="shrink-0 text-ink-3" />
                  <span className="shrink-0 text-ink-3">Reader link:</span>
                  <code ref={readerLinkEl} className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
                    {readerLink}
                  </code>
                  <CopyButton text={readerLink} label="Copy" testId="copy-reader-link" target={readerLinkEl} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5">
          <AgentCollaborateCard origin={origin} open={open} docId={doc.id} onClose={() => onOpenChange(false)} />
        </div>

        <div className="mt-5 flex justify-end" data-testid="share-footer">
          <button type="button" className="btn btn-primary shrink-0" onClick={() => onOpenChange(false)}>
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export function CopyButton({ text, label = "Copy", testId, target }: { text: string; label?: string; testId?: string; target?: RefObject<HTMLElement | null> }) {
  const { copy, label: buttonLabel, copied } = useCopy(text, target, label);
  return (
    <button type="button" className="btn btn-sm btn-ghost gap-1.5" data-testid={testId} onClick={copy}>
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      {buttonLabel}
    </button>
  );
}

/** The editor and Settings share one manager; closing this card discards its one-time secret. */
export function AgentCollaborateCard({ origin, open, docId, onClose }: { origin: string; open: boolean; docId: string; onClose?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/30" aria-label="Collaborate with an agent" data-testid="share-agent-card">
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-violet-100/60 dark:hover:bg-violet-900/30"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((v) => !v)}
        data-testid="share-agent-toggle"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/60 dark:text-violet-300">
          <Bot size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">Collaborate with an agent</span>
          <span className="block truncate text-xs text-ink-3">Connect Copilot CLI or any MCP client as a collaborator</span>
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-3 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!expanded} className="px-3 pb-3">
        <TokensPanel origin={origin} userLogin="you" documentId={docId} embedded open={open && expanded} onClose={onClose} />
      </div>
    </section>
  );
}
