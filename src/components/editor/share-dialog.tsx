"use client";

import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { BookOpen, Bot, Check, Copy, Globe, KeyRound, Link2, Loader2, Lock, Trash2, UserPlus } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, type ApiTokenDto, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CopyBlock, mcpConfigFor, mcpHttpConfigFor, TOKEN_PLACEHOLDER } from "@/components/settings/agent-connect-card";
import { CopilotPermissionsHint } from "@/components/settings/copilot-permissions-hint";
import { cn } from "@/lib/utils";

const LINK_OPTIONS: { value: DocumentDto["linkAccess"]; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added below can open this document." },
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
          <AgentCollaborateCard origin={origin} open={open} />
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button type="button" className="btn btn-outline shrink-0 gap-2" onClick={link.copy} data-testid="copy-link">
              {link.copied ? <Check size={16} className="text-success" /> : <Link2 size={16} />}
              {link.label}
            </button>
            {showLinkFallback && (
              <input
                ref={linkFallback}
                className="input h-9 min-w-0 flex-1 font-mono text-xs"
                value={editorLink}
                readOnly
                aria-label="Document link"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="copy-link-fallback"
              />
            )}
          </div>
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

/**
 * "Collaborate with an agent": the ready-to-paste Copilot CLI config for this server's remote MCP
 * endpoint. Token secrets are never shown again after creation, so the newest token is named but the
 * config only inlines one minted right here; otherwise it carries the MARKDOC_TOKEN placeholder.
 */
export function AgentCollaborateCard({ origin, open }: { origin: string; open: boolean }) {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(null);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStdio, setShowStdio] = useState(false);
  const base = origin || "http://localhost:3000";
  const config = mcpHttpConfigFor(base, minted?.token ?? TOKEN_PLACEHOLDER);
  const stdioConfig = mcpConfigFor(base, minted?.token ?? TOKEN_PLACEHOLDER);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.tokens
      .list()
      .then((res) => {
        if (!cancelled) setTokens(res.tokens);
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const newest = tokens?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

  const createToken = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.tokens.create("GitHub Copilot CLI", 90);
      setMinted({ name: res.token.name, token: res.token.token });
      setTokens((list) => [{ id: res.token.id, name: res.token.name, prefix: res.token.prefix, createdAt: new Date().toISOString(), lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null }, ...(list ?? [])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a token");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30" aria-label="Collaborate with an agent" data-testid="share-agent-card">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
        <Bot size={14} className="text-violet-600" /> Collaborate with an agent
      </div>
      <p className="text-xs leading-5 text-ink-3">
        Connect GitHub Copilot CLI, VS Code or any MCP client to this document; the agent joins as a collaborator, acting as you via{" "}
        {minted ? (
          <>
            the token <strong className="text-ink-2">{minted.name}</strong>
          </>
        ) : newest ? (
          <>
            your token <strong className="text-ink-2">{newest.name}</strong> (<code className="font-mono">{newest.prefix}…</code>) — paste it where it says{" "}
            <code className="font-mono">{TOKEN_PLACEHOLDER}</code>, or mint a new one
          </>
        ) : (
          "a token"
        )}
        .
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <span>
          Paste into <code className="rounded bg-surface px-1 py-0.5 font-mono">~/.copilot/mcp-config.json</code>, or in Copilot CLI run{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono">/mcp add</code> and enter the same URL and header.
        </span>
        {!minted && (
          <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={() => void createToken()} disabled={busy} data-testid="share-agent-create-token">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create a token
          </button>
        )}
      </div>
      {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40">{error}</div>}
      <div className="mt-2">
        <CopyBlock value={config} label="Copilot CLI MCP configuration" testId="share-agent-config" copyTestId="share-agent-copy" />
      </div>
      {minted && <p className="mt-1.5 text-[11px] text-ink-3">Copy it now — the token is not shown again. Revoke it any time in Settings.</p>}
      <CopilotPermissionsHint testIdPrefix="share-agent" className="mt-2" />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <a className="text-accent hover:underline" href="/settings#tokens" data-testid="share-agent-setup-link">
          Step-by-step setup and tokens
        </a>
        <button type="button" className="text-ink-3 hover:underline" onClick={() => setShowStdio((v) => !v)} data-testid="share-agent-stdio-toggle">
          {showStdio ? "Hide" : "Show"} the stdio config (run from a checkout)
        </button>
      </div>
      {showStdio && (
        <div className="mt-2">
          <CopyBlock value={stdioConfig} label="stdio MCP configuration" testId="share-agent-config-stdio" />
        </div>
      )}
    </section>
  );
}
