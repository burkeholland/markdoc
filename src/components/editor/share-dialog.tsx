"use client";

import { memo, useEffect, useId, useRef, useState, type RefObject } from "react";
import { BookOpen, Bot, Check, ChevronDown, Copy, Globe, KeyRound, Link2, Loader2, Lock, Trash2 } from "lucide-react";
import type { DocumentDto } from "@/server/dto";
import type { Role } from "@/server/db/schema";
import { api, apiErrorText, type ApiTokenDto, type CollaboratorDto } from "@/lib/api";
import { useCopy } from "@/lib/hooks";
import { Avatar, Dialog, DialogContent } from "@/components/ui/primitives";
import { CollaboratorLoginInput } from "@/components/editor/collaborator-login-input";
import { CopyBlock, mcpConfigFor, mcpHttpConfigFor, TOKEN_PLACEHOLDER } from "@/components/settings/agent-connect-card";
import { CopilotPermissionsHint } from "@/components/settings/copilot-permissions-hint";
import { SCOPES, TOKEN_SCOPE_LABEL, TOKEN_SCOPE_SUMMARY, type TokenScopeName } from "@/lib/mcp";
import { cn } from "@/lib/utils";

const LINK_OPTIONS: { value: DocumentDto["linkAccess"]; label: string; description: string }[] = [
  { value: "private", label: "Restricted", description: "Only people added above can open this document." },
  { value: "view", label: "Anyone with the link can view", description: "Signed-out visitors can read the document." },
  { value: "comment", label: "Anyone with the link can comment", description: "Signed-in visitors can comment; others can read." },
  { value: "edit", label: "Anyone with the link can edit", description: "Signed-in visitors can edit; others can read." },
];

/** What a token minted in the Share dialog can do, per scope; rendered as "It is <scope>-<note>." under the config. */
const SCOPE_NOTE: Record<TokenScopeName, string> = {
  read: "only: it can read and follow the document but not comment or edit",
  comment: "scoped: it can read, comment and propose suggestions you accept here, not rewrite, publish or delete",
  full: "access: it can do anything you can in this document",
};

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
          <AgentCollaborateCard origin={origin} open={open} docId={doc.id} />
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

/**
 * "Collaborate with an agent": a collapsed row that opens into three steps — pick the token's scope
 * and mint it, copy the ready-to-paste Copilot CLI config for this server's remote MCP endpoint,
 * paste it. Token secrets are never shown again after creation, so the newest token is named but
 * the config only inlines one minted right here; otherwise it carries the MARKDOC_TOKEN placeholder.
 * A token minted here is restricted to this document unless "Only this document" is unticked.
 */
export function AgentCollaborateCard({ origin, open, docId }: { origin: string; open: boolean; docId: string }) {
  const [tokens, setTokens] = useState<ApiTokenDto[] | null>(null);
  const [minted, setMinted] = useState<{ name: string; token: string; scope: TokenScopeName; documentIds: string[] | null } | null>(null);
  const [scope, setScope] = useState<TokenScopeName>("comment");
  const [restrict, setRestrict] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showStdio, setShowStdio] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;
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
      // The credential that leaves the browser gets the scope picked above (comment & suggest by default: the
      // humans accept the result here) and, unless unticked, only this document.
      const res = await api.tokens.create("GitHub Copilot CLI", 90, { scope, documentIds: restrict ? [docId] : null });
      setMinted({ name: res.token.name, token: res.token.token, scope: res.token.scope, documentIds: res.token.documentIds });
      setTokens((list) => [{ id: res.token.id, name: res.token.name, prefix: res.token.prefix, scope: res.token.scope, documentIds: res.token.documentIds, collaboratorsMayAsk: false, createdAt: new Date().toISOString(), lastUsedAt: null, lastMcpSeenAt: null, lastMcpCallAt: null, expiresAt: null }, ...(list ?? [])]);
      setExpanded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a token");
    } finally {
      setBusy(false);
    }
  };

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
        {expanded && (
          <>
            <ol className="flex flex-col gap-3">
              <li className="flex gap-3">
                <StepBadge n={1} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-ink">Token</div>
                  <p className="mt-0.5 text-xs leading-5 text-ink-3">
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
                  <div role="radiogroup" aria-label="Token scope" className="mt-2 flex flex-col gap-1" data-testid="share-agent-scope-picker">
                    {SCOPES.map((s) => (
                      <label key={s} className={cn("flex items-start gap-2 text-xs text-ink-2", minted ? "opacity-60" : "cursor-pointer")}>
                        <input
                          type="radio"
                          name={`${id}-scope`}
                          value={s}
                          checked={scope === s}
                          onChange={() => setScope(s)}
                          disabled={Boolean(minted)}
                          className="mt-0.5"
                          data-testid={`share-agent-scope-${s}`}
                        />
                        <span>
                          <span className="font-medium text-ink">{TOKEN_SCOPE_LABEL[s]}</span>
                          <span className="text-ink-3"> — {TOKEN_SCOPE_SUMMARY[s]}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <label className={cn("flex items-center gap-2 text-xs text-ink-2", minted ? "opacity-60" : "cursor-pointer")}>
                      <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} disabled={Boolean(minted)} data-testid="share-agent-restrict" />
                      <span className="font-medium text-ink">Only this document</span>
                      <span className="text-ink-3">— {restrict ? "every other document answers 404 to it" : "it can reach all your documents"}</span>
                    </label>
                    {minted ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success" data-testid="share-agent-minted">
                        <Check size={14} /> Token created
                      </span>
                    ) : (
                      <button type="button" className="btn btn-outline btn-sm gap-1.5" onClick={() => void createToken()} disabled={busy} data-testid="share-agent-create-token">
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create a token
                      </button>
                    )}
                  </div>
                  {error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger dark:bg-red-950/40">{error}</div>}
                </div>
              </li>
              <li className="flex gap-3">
                <StepBadge n={2} />
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 text-xs font-semibold text-ink">Config</div>
                  <CopyBlock value={config} label="Copilot CLI MCP configuration" testId="share-agent-config" copyTestId="share-agent-copy" />
                  {minted && (
                    <p className="mt-1.5 text-[11px] text-ink-3" data-testid="share-agent-minted-note">
                      Copy it now — the token is not shown again. It is <strong className="font-mono text-ink-2">{minted.scope}</strong>-{SCOPE_NOTE[minted.scope]}.
                      {minted.documentIds ? "" : " It also works in your other documents."} Revoke it any time in Settings.
                    </p>
                  )}
                  <button type="button" className="mt-1.5 text-xs text-ink-3 hover:underline" onClick={() => setShowStdio((v) => !v)} data-testid="share-agent-stdio-toggle">
                    {showStdio ? "Hide" : "Show"} the stdio config (run from a checkout)
                  </button>
                  {showStdio && (
                    <div className="mt-1.5">
                      <CopyBlock value={stdioConfig} label="stdio MCP configuration" testId="share-agent-config-stdio" />
                    </div>
                  )}
                </div>
              </li>
              <li className="flex gap-3">
                <StepBadge n={3} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-ink">Paste</div>
                  <p className="mt-0.5 text-xs leading-5 text-ink-3">
                    Paste into <code className="rounded bg-surface px-1 py-0.5 font-mono">~/.copilot/mcp-config.json</code>, or in Copilot CLI run{" "}
                    <code className="rounded bg-surface px-1 py-0.5 font-mono">/mcp add</code> and enter the same URL and header.
                  </p>
                  <a className="mt-1 inline-flex text-xs font-medium text-accent hover:underline" href="/settings#tokens" data-testid="share-agent-setup-link">
                    Step-by-step setup and tokens
                  </a>
                </div>
              </li>
            </ol>
            <CopilotPermissionsHint testIdPrefix="share-agent" className="mt-3" scope={minted?.scope ?? newest?.scope ?? null} />
          </>
        )}
      </div>
    </section>
  );
}

function StepBadge({ n }: { n: number }) {
  return <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">{n}</span>;
}
